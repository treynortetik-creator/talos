// Driving mode screen (docs/V2-FEATURES.md V4.2, route /drive). Dark always, 22 px minimum text, no scroll, 96 px and
// 140 px targets. Replies arrive as text at once and the voice follows; this screen plays it (see queue.ts). Cards and
// permission requests are counted and announced once, never approved here.
import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useNavigate } from 'react-router'
import { useStore } from 'zustand'
import { useTalos, useTalosClient } from '../../lib/client.ts'
import { getPlatform } from '../../lib/platform.ts'
import type { DriveScreenProps } from '../contracts.ts'
import { audioDock } from '../threads/audioDock.ts'
import { loadSpeed, nextSpeed, type Speed } from '../threads/speed.ts'
import { useCallStore } from '../voice/callStore.ts'
import { getCallController } from '../voice/index.tsx'
import { useVoiceAvailability } from '../voice/status.tsx'
import { IDLE_END_MS } from './controller.ts'
import { DRIVING_FAILED, setDriving, useDrivingState } from './driving.ts'
import { getDrive } from './instance.ts'
import { loadTapToTalk } from './prefs.ts'

const mmss = (s: number) => {
  const t = Math.max(0, Math.floor(Number.isFinite(s) ? s : 0))
  return `${Math.floor(t / 60)}:${String(t % 60).padStart(2, '0')}`
}

const BTN =
  'grid place-items-center rounded-full border border-[var(--talos-cream)] bg-transparent text-[var(--talos-cream)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--talos-cream)] disabled:opacity-60'
const PILL =
  'inline-flex min-h-14 items-center justify-center rounded-full border border-[var(--talos-cream)] bg-transparent px-6 text-[22px] font-medium text-[var(--talos-cream)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--talos-cream)]'

const icon = { width: 40, height: 40, viewBox: '0 0 24 24', fill: 'currentColor', 'aria-hidden': true } as const

export function DriveScreen(_props: DriveScreenProps) {
  const client = useTalosClient()
  const nav = useNavigate()
  const { controller, queue } = getDrive(client)
  const { active } = useDrivingState()
  const agent = useTalos((s) => s.config?.agent.name ?? 'Talos')
  const threads = useTalos((s) => s.config?.threads)
  const d = useStore(controller.store, (s) => s)
  const q = useStore(queue.store, (s) => s)
  const voice = useVoiceAvailability()
  const call = getCallController()
  const callPhase = useCallStore(call.store, (s) => s.phase)
  // /drive mounts no composer, so the thread screen's call error line does not exist here: show the call's own error.
  const callError = useCallStore(call.store, (s) => s.error)
  const onCall = callPhase !== 'idle'
  const [speed, setSpeed] = useState<Speed>(loadSpeed)
  const [error, setError] = useState<string | null>(null)
  const [talking, setTalking] = useState(false)
  const tapMode = useRef(loadTapToTalk())

  const threadName = threads?.find((t) => t.id === d.thread)?.name ?? 'General'

  // Foreground plumbing while the screen is up: audio session, wake lock, lock-screen controls, re-extend the 2 h.
  useEffect(() => {
    if (!active) return
    const p = getPlatform()
    audioDock.pause({ handOver: true }) // Drive takes the audio route: a clip playing in the dock waits (the pill stays, paused)
    p.audioSession.set('playback')
    let release: () => void = () => {}
    let gone = false
    const hold = () =>
      void p.wakeLock.acquire().then((r) => {
        if (gone) r()
        else {
          release()
          release = r
        }
      })
    hold()
    const onVis = () => document.visibilityState === 'visible' && hold()
    document.addEventListener('visibilitychange', onVis)
    return () => {
      gone = true
      document.removeEventListener('visibilitychange', onVis)
      release()
      // Driving ended or the screen closed: let go of the audio route (the iPhone shell releases AVAudioSession so the
      // user's music can resume; the browser adapter just sets the type back to auto).
      p.audioSession.set('auto')
      audioDock.reclaimSession() // a clip still loaded in the dock keeps its lock-screen controls
    }
  }, [active])

  useEffect(() => {
    if (!active) return
    const p = getPlatform()
    p.mediaSession.set(
      { title: q.current?.label ?? `${agent} is talking`, artist: agent },
      {
        play: () => queue.play(),
        pause: () => queue.pause(),
        nexttrack: () => queue.skip(),
        seekbackward: () => queue.back(10),
      },
    )
    return () => {
      p.mediaSession.clear()
      audioDock.reclaimSession()
    }
  }, [active, agent, queue, q.current?.label])

  // /drive open on this device makes it the one that reads replies aloud (other open devices stay silent).
  useEffect(() => {
    controller.setScreenOpen(true)
    return () => controller.setScreenOpen(false)
  }, [controller])

  // Everything behind this screen is unreachable (Tab, VoiceOver swipe) while it is up.
  useEffect(() => {
    const root = document.getElementById('root')
    root?.setAttribute('inert', '')
    return () => root?.removeAttribute('inert')
  }, [])

  // Every 30 s: with under 30 min left, extend only for an owner who talked or tapped in the last 2 h. Otherwise say
  // so out loud and turn driving off, which also lets the wake lock go.
  useEffect(() => {
    if (!active) return
    const t = setInterval(() => {
      const until = client.store.getState().config?.voice_notes.driving_until
      if (!until || Date.parse(until) - Date.now() >= 30 * 60_000) return
      if (Date.now() - controller.lastTouch() < IDLE_END_MS) void setDriving(client, true, { onlyIfActive: true })
      else {
        controller.say('Driving mode is ending')
        void setDriving(client, false)
      }
    }, 30_000)
    return () => clearInterval(t)
  }, [active, client, controller])

  const start = async () => {
    setError(null)
    void queue.unlock() // this tap unlocks the audio element, before any await
    controller.touch()
    controller.claim()
    const r = await setDriving(client, true)
    if (!r.ok) {
      controller.unclaim()
      setError(r.message)
    }
  }
  const exit = async () => {
    // Leaving driving mode hangs up a live call started here: nothing behind /drive could end it.
    if (call.store.getState().phase !== 'idle') void call.end()
    queue.clear()
    const r = await setDriving(client, false)
    if (!r.ok) setError(DRIVING_FAILED)
    else nav('/')
  }
  const cycleSpeed = () => {
    const next = nextSpeed(speed)
    setSpeed(next)
    audioDock.setSpeed(next) // saves it and moves the dock's rows and element to the same speed
    queue.applySpeed()
  }

  const down = () => {
    setTalking(true)
    void controller.beginTalk()
  }
  const up = () => {
    if (!talking) return
    setTalking(false)
    void controller.endTalk(true)
  }

  const needsTap = !q.armed && q.current !== null
  const statusText =
    d.status === 'listening'
      ? 'Listening…'
      : d.status === 'sending'
        ? 'Sending…'
        : d.status === 'thinking'
          ? 'Thinking…'
          : d.status === 'speaking'
            ? `Speaking… ${mmss(q.position)} / ${mmss(q.duration)}`
            : needsTap || q.blocked
              ? 'Tap Play to hear it'
              : 'Ready'

  return createPortal(
    <section
      data-testid="drive-screen"
      data-no-edge-swipe=""
      aria-label="Driving mode"
      onPointerDownCapture={() => controller.touch()}
      onKeyDownCapture={() => controller.touch()}
      className="fixed inset-0 z-50 flex flex-col gap-3 overflow-hidden landscape:grid landscape:grid-cols-2 landscape:gap-x-6 landscape:gap-y-2 landscape:py-2 bg-[var(--talos-black)] px-5 pt-[max(1rem,env(safe-area-inset-top))] pb-[max(1rem,env(safe-area-inset-bottom))] text-[22px] text-[var(--talos-cream)]"
    >
      {!active ? (
        <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-6 text-center landscape:col-span-2 landscape:gap-3">
          <h1 className="m-0 font-display text-[28px] font-semibold">Driving mode</h1>
          <p className="m-0 max-w-sm">
            Replies come as text, then {agent} reads them to you. Keep Talos open on screen.
          </p>
          <button type="button" onClick={() => void start()} className={`${PILL} min-h-24 px-10 text-[28px]`}>
            Start driving
          </button>
          {error && (
            <p role="alert" className="m-0">
              {error}
            </p>
          )}
          <button
            type="button"
            onClick={() => {
              if (call.store.getState().phase !== 'idle') void call.end()
              nav('/')
            }}
            className={PILL}
          >
            Exit
          </button>
        </div>
      ) : (
        <>
          <div className="contents landscape:flex landscape:min-h-0 landscape:flex-col landscape:gap-2">
            <button
              type="button"
              onClick={() => controller.cycleThread()}
              aria-label={`Driving · ${threadName}. Tap to switch thread`}
              className={`${PILL} self-start`}
            >
              <span aria-hidden="true">● Driving · {threadName} ▾</span>
            </button>
            <p data-testid="drive-status" role="status" className="m-0 text-center">
              {statusText}
            </p>
            <p
              data-testid="drive-line"
              className="m-0 line-clamp-2 min-h-[2.5em] text-center font-display text-[28px] leading-tight"
            >
              {d.line}
            </p>
            <div className="flex items-center justify-center gap-4">
              <button
                type="button"
                aria-label="Back 10 seconds"
                onClick={() => queue.back(10)}
                className={`${BTN} size-24`}
              >
                <svg {...icon}>
                  <title>Back 10 seconds</title>
                  <path d="M12 5V2L7 6l5 4V7a6 6 0 1 1-6 6H4a8 8 0 1 0 8-8z" />
                </svg>
              </button>
              <button
                type="button"
                aria-label={q.playing ? 'Pause' : 'Play'}
                onClick={() => queue.toggle()}
                className={`${BTN} size-24 bg-[var(--talos-cream)] text-[var(--talos-black)]`}
              >
                <svg {...icon}>
                  <title>{q.playing ? 'Pause' : 'Play'}</title>
                  {q.playing ? <path d="M7 5h4v14H7zM13 5h4v14h-4z" /> : <path d="M8 5v14l11-7z" />}
                </svg>
              </button>
              <button
                type="button"
                aria-label="Next reply"
                onClick={() => queue.skip()}
                disabled={!q.current}
                className={`${BTN} size-24`}
              >
                <svg {...icon}>
                  <title>Next reply</title>
                  <path d="M6 5v14l9-7zM16 5h3v14h-3z" />
                </svg>
              </button>
            </div>
            <button
              type="button"
              aria-label={`Playback speed ${speed}×`}
              onClick={cycleSpeed}
              className={`${PILL} self-center`}
            >
              {speed}×
            </button>
          </div>
          <div className="contents landscape:flex landscape:min-h-0 landscape:flex-col landscape:gap-2">
            <button
              type="button"
              data-testid="drive-talk"
              aria-pressed={talking}
              disabled={onCall}
              onPointerDown={(e) => {
                if (tapMode.current) return
                e.currentTarget.setPointerCapture?.(e.pointerId)
                down()
              }}
              onPointerUp={() => !tapMode.current && up()}
              onPointerCancel={() => !tapMode.current && up()}
              onClick={() => {
                if (!tapMode.current) return
                if (talking) up()
                else down()
              }}
              onKeyDown={(e) => {
                if (!tapMode.current && (e.key === ' ' || e.key === 'Enter') && !e.repeat) down()
              }}
              onKeyUp={(e) => {
                if (!tapMode.current && (e.key === ' ' || e.key === 'Enter')) up()
              }}
              className={`${BTN} h-[140px] w-full touch-none select-none text-[28px] font-semibold ${talking ? 'bg-[var(--talos-cream)] text-[var(--talos-black)]' : ''}`}
            >
              {talking
                ? tapMode.current
                  ? 'Tap to send'
                  : 'Release to send'
                : tapMode.current
                  ? 'Tap to talk'
                  : 'Hold to talk'}
            </button>
            {(d.error || error || (callError && !onCall)) && (
              <p role="alert" data-testid="drive-error" className="m-0 text-center">
                {d.error ?? error ?? callError}
              </p>
            )}
            <div className="mt-auto flex flex-col gap-2">
              {d.cardsWaiting > 0 && (
                <p data-testid="drive-cards" className="m-0">
                  {d.cardsWaiting} {d.cardsWaiting === 1 ? 'card' : 'cards'} waiting · approve later
                </p>
              )}
              <div className="flex items-center justify-between gap-3">
                {onCall ? (
                  <button
                    type="button"
                    data-testid="drive-end-call"
                    onClick={() => void call.end()}
                    className={`${PILL} min-h-24 px-8 text-[28px] font-semibold`}
                  >
                    End call
                  </button>
                ) : voice.available ? (
                  <button type="button" onClick={() => void call.start(client, d.thread)} className={PILL}>
                    Talk live
                  </button>
                ) : (
                  <span />
                )}
                <button type="button" onClick={() => void exit()} className={PILL}>
                  Exit
                </button>
              </div>
            </div>
          </div>
        </>
      )}
    </section>,
    document.body,
  )
}
