// Live voice UI (spec 8.6, WP4). Exports the components `features/registry.ts` lazy-loads, plus `useIsOnCall` and
// `HandoffChips` for the shell.
import { VOICE_CHOICES } from '@talos-app/protocol'
import { type ReactNode, useEffect, useId, useMemo, useRef, useState } from 'react'
import { useTalos, useTalosClient } from '../../lib/client.ts'
import { Button, Textarea } from '../../ui/index.ts'
import { Mascot } from '../../ui/Mascot.tsx'
import type { CallBarProps, CallScreenProps, LiveCallButtonProps, SettingsSectionProps } from '../contracts.ts'
import { DrivingRow } from '../drive/DrivingRow.tsx'
import { friendlyPatchError } from '../threads/manage/useThreadPatch.ts'
import type { CallController } from './callController.ts'
import { type Handoff, useCallStore } from './callStore.ts'
import { getCallController, setCallController, useIsOnCall } from './controller.ts'
import { loadTalkMode, saveTalkMode, type TalkMode } from './prefs.ts'
import { useVoiceAvailability, VOICE_OFF_TITLE, VoiceOffNotice } from './status.tsx'
import { Waveform } from './Waveform.tsx'

export { getCallController, setCallController, useIsOnCall }

const iconProps = {
  width: 20,
  height: 20,
  viewBox: '0 0 24 24',
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 2,
  strokeLinecap: 'round',
  strokeLinejoin: 'round',
  'aria-hidden': true,
} as const

function WaveIcon() {
  return (
    <svg {...iconProps}>
      <title>Waveform</title>
      <path d="M4 10v4M8 6v12M12 3v18M16 7v10M20 10v4" />
    </svg>
  )
}
function MicIcon({ off }: { off?: boolean }) {
  return (
    <svg {...iconProps}>
      <title>Microphone</title>
      <rect x="9" y="3" width="6" height="11" rx="3" />
      <path d="M5 11a7 7 0 0 0 14 0M12 18v3" />
      {off && <path d="M3 3l18 18" />}
    </svg>
  )
}
function MicGlyph() {
  return (
    <svg {...iconProps} width={12} height={12}>
      <title>Microphone</title>
      <rect x="9" y="3" width="6" height="11" rx="3" />
      <path d="M5 11a7 7 0 0 0 14 0M12 18v3" />
    </svg>
  )
}

export function LiveCallButton({ threadId, disabled }: LiveCallButtonProps) {
  const client = useTalosClient()
  const c = getCallController()
  const phase = useCallStore(c.store, (s) => s.phase)
  const voice = useVoiceAvailability()
  const [help, setHelp] = useState(false)
  const off = !voice.available
  return (
    <span className="relative inline-flex">
      <Button
        variant="ghost"
        aria-label="Start a live call"
        aria-expanded={off ? help : undefined}
        title={off ? VOICE_OFF_TITLE : undefined}
        disabled={disabled || phase !== 'idle'}
        className={off ? 'size-[min(2.75rem,52px)] !px-0 opacity-50' : 'size-[min(2.75rem,52px)] !px-0'}
        onClick={() => (off ? setHelp((v) => !v) : void c.start(client, threadId))}
      >
        <WaveIcon />
      </Button>
      {off && help && (
        <span
          role="status"
          className="absolute bottom-full right-0 z-10 mb-2 block w-72 max-w-[calc(100vw-2rem)] rounded-card border border-line bg-surface px-3 py-2"
        >
          <VoiceOffNotice reason={voice.reason} />
        </span>
      )}
    </span>
  )
}

export function HandoffChip({ handoff, agentName }: { handoff: Handoff; agentName: string }) {
  const label =
    handoff.state === 'working'
      ? `Handed to ${agentName}: ${handoff.question} · working`
      : handoff.state === 'failed'
        ? `Couldn't hand to ${agentName}: ${handoff.question}`
        : `${agentName} answered: ${handoff.answer || handoff.question}`
  return (
    <li data-state={handoff.state} className="rounded-pill border border-line bg-surface-2 px-3 py-1 text-sm text-text">
      {label}
    </li>
  )
}

/** The hand-off chips of the current (or last) call. Rendered inside the bar; exported for the shell's timeline. */
export function HandoffChips() {
  const c = getCallController()
  const handoffs = useCallStore(c.store, (s) => s.handoffs)
  const agentName = useTalos((s) => s.config?.agent.name ?? 'Talos')
  if (handoffs.length === 0) return null
  return (
    <ul aria-label="Hand-offs" className="m-0 flex list-none flex-col gap-1 p-0">
      {handoffs.map((h) => (
        <HandoffChip key={h.delegationId} handoff={h} agentName={agentName} />
      ))}
    </ul>
  )
}

function useCallEnded(c: CallController, onEnd: () => void) {
  const phase = useCallStore(c.store, (s) => s.phase)
  const was = useRef(false)
  const cb = useRef(onEnd)
  cb.current = onEnd
  useEffect(() => {
    if (phase !== 'idle') was.current = true
    else if (was.current) {
      was.current = false
      cb.current()
    }
  }, [phase])
}

function Captions({ c }: { c: CallController }) {
  const captions = useCallStore(c.store, (s) => s.captions)
  const lines = useMemo(() => captions.slice(-2), [captions])
  return (
    <div aria-live="polite" aria-atomic="false" className="text-sm text-text-2">
      {lines.map((l, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: captions are append-only
        <p key={i} className="m-0 flex items-center gap-1">
          <MicGlyph />
          <span className="sr-only">{l.who === 'owner' ? 'You: ' : 'Agent: '}</span>
          {l.text}
        </p>
      ))}
    </div>
  )
}

function Controls({ c, compact }: { c: CallController; compact?: boolean }) {
  const phase = useCallStore(c.store, (s) => s.phase)
  const muted = useCallStore(c.store, (s) => s.muted)
  const mode = useCallStore(c.store, (s) => s.mode)
  const talking = useCallStore(c.store, (s) => s.talking)
  const live = phase === 'live'
  const agentName = useTalos((s) => s.config?.agent.name ?? 'Talos')
  const pressTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const onDown = () => {
    if (mode === 'hold') return c.pressToTalk()
    pressTimer.current = setTimeout(() => {
      pressTimer.current = null
      c.setMode('hold')
    }, 600)
  }
  const onUp = () => {
    if (pressTimer.current) clearTimeout(pressTimer.current)
    pressTimer.current = null
    if (mode === 'hold') c.releaseToTalk()
  }

  return (
    <div
      role="toolbar"
      aria-label="Call controls"
      className={`flex h-[72px] items-center gap-2 ${compact ? '' : 'px-3'}`}
    >
      <Mascot
        state={phase === 'live' ? (mode === 'hold' && !talking ? 'listening' : 'speaking') : 'working'}
        size={44}
        name={agentName}
        decorative
      />
      {mode === 'hold' ? (
        <Button variant="outline" disabled={!live} onClick={() => c.setMode('hands_free')}>
          Hands-free
        </Button>
      ) : (
        <Button
          variant="outline"
          aria-label={muted ? 'Unmute' : 'Mute'}
          aria-pressed={muted}
          disabled={!live}
          onClick={() => c.setMuted(!muted)}
        >
          <MicIcon off={muted} />
          <span className="hidden sm:inline">{muted ? 'Unmute' : 'Mute'}</span>
        </Button>
      )}
      <button
        type="button"
        data-testid="talk-area"
        aria-label={mode === 'hold' ? 'Hold to talk' : 'Waveform. Press and hold to switch to hold-to-talk'}
        aria-pressed={mode === 'hold' ? talking : undefined}
        disabled={!live}
        onPointerDown={onDown}
        onPointerUp={onUp}
        onPointerCancel={onUp}
        onPointerLeave={onUp}
        onKeyDown={(e) => {
          if (mode === 'hold' && (e.key === ' ' || e.key === 'Enter') && !e.repeat) c.pressToTalk()
        }}
        onKeyUp={(e) => {
          if (mode === 'hold' && (e.key === ' ' || e.key === 'Enter')) c.releaseToTalk()
        }}
        className="flex h-11 min-w-0 flex-1 touch-none select-none items-center justify-center rounded-button bg-transparent text-text focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus disabled:opacity-70"
      >
        {phase === 'connecting' ? (
          <span className="text-sm text-text-2">Connecting…</span>
        ) : mode === 'hold' ? (
          <span className={`text-sm font-medium ${talking ? 'text-accent-text' : 'text-text-2'}`}>
            {talking ? 'Listening…' : 'Hold to talk'}
          </span>
        ) : (
          <Waveform controller={c} active={live && !muted} />
        )}
      </button>
      <Button
        variant="danger"
        aria-label="End call"
        onClick={() => void c.end()}
        className="rounded-pill bg-danger px-5 text-[var(--bg)] hover:bg-danger hover:brightness-110"
      >
        End
      </Button>
    </div>
  )
}

function TapToHear({ c }: { c: CallController }) {
  const needs = useCallStore(c.store, (s) => s.needsTapToHear)
  if (!needs) return null
  return (
    <Button variant="primary" onClick={() => void c.playAudio()}>
      Tap to hear
    </Button>
  )
}

/** The 72 px call bar that replaces the composer during a call (spec 8.6). */
export function CallBar({ onEnd }: CallBarProps) {
  const c = getCallController()
  useCallEnded(c, onEnd)
  return (
    <section
      aria-label="Call in progress"
      className="incised flex flex-col gap-1 rounded-t-card border-b-0 bg-surface px-3 pt-2 pb-[env(safe-area-inset-bottom)]"
    >
      <HandoffChips />
      <Captions c={c} />
      <TapToHear c={c} />
      <Controls c={c} compact />
    </section>
  )
}

/** Full-screen call (setting; P1). Dark field, thread name on top, captions in the lower third. */
export function CallScreen({ threadId, onEnd }: CallScreenProps) {
  const c = getCallController()
  useCallEnded(c, onEnd)
  const name = useTalos((s) => s.threads.find((t) => t.id === threadId)?.name ?? '')
  const phase = useCallStore(c.store, (s) => s.phase)
  return (
    <section
      aria-label="Call in progress"
      className="fixed inset-0 z-50 flex flex-col justify-between bg-[var(--talos-black)] p-6 text-[var(--talos-cream)] md:inset-auto md:bottom-6 md:right-6 md:h-[560px] md:w-[480px] md:rounded-card"
    >
      <h2 className="m-0 text-center font-display text-lg">{name}</h2>
      <p className="m-0 text-center text-sm opacity-80">{phase === 'connecting' ? 'Connecting…' : 'On a call'}</p>
      <div className="flex flex-col gap-3 pb-2">
        <HandoffChips />
        <Captions c={c} />
        <TapToHear c={c} />
        <Controls c={c} compact />
      </div>
    </section>
  )
}

// ---- Settings -> Voice ---------------------------------------------------------------------------------------------

// The voice list lives in the protocol (config-propose.ts) so the bridge checks the same ids the Settings select offers.
export { VOICE_CHOICES }

const MODES: Array<{ id: TalkMode; label: string; hint: string }> = [
  { id: 'hands_free', label: 'Hands-free', hint: 'The mic stays open; mute when you need to.' },
  { id: 'hold', label: 'Hold to talk', hint: 'The mic opens only while you press and hold.' },
]

export function VoiceSettingsSection({ readOnly }: SettingsSectionProps) {
  const client = useTalosClient()
  const voice = useTalos((s) => s.config?.agent.voice ?? 'meridian')
  const [mode, setMode] = useState<TalkMode>(() => loadTalkMode())
  const [error, setError] = useState<string | null>(null)
  const [saved, setSaved] = useState(false)

  const pickVoice = async (next: string) => {
    setError(null)
    setSaved(false)
    try {
      await client.patchConfig({ agent: { voice: next } })
      setSaved(true)
    } catch (e) {
      setError(`Couldn't change the voice. ${friendlyPatchError(e)}`)
    }
  }
  const pickMode = (next: TalkMode) => {
    setMode(next)
    saveTalkMode(next)
    const c = getCallController()
    if (c.store.getState().phase === 'idle') c.store.setState({ mode: next })
  }

  const availability = useVoiceAvailability()
  return (
    <section aria-label="Voice settings" className="flex flex-col gap-4">
      <h2 className="m-0 font-display text-xl font-semibold">Voice</h2>
      {!availability.available && (
        <div role="note" className="rounded-card border border-line bg-surface-2 px-3 py-2">
          <VoiceOffNotice reason={availability.reason} className="m-0 text-sm text-text" />
        </div>
      )}
      <div className="flex flex-col gap-1">
        <label htmlFor="voice-pick" className="text-sm font-medium">
          Live-call voice
        </label>
        <select
          id="voice-pick"
          value={voice}
          disabled={readOnly}
          onChange={(e) => void pickVoice(e.target.value)}
          className="min-h-11 rounded-button border border-line bg-surface px-3 text-text"
        >
          {VOICE_CHOICES.map((v) => (
            <option key={v} value={v}>
              {v === 'meridian' ? 'meridian (default)' : v}
            </option>
          ))}
        </select>
        <p className="m-0 text-sm text-text-2">
          {readOnly ? 'Your Mac is offline, so this can’t be changed right now. ' : ''}Applies to your next call.
        </p>
        {saved && (
          <p role="status" className="m-0 text-sm text-ok">
            Saved. It applies to your next call.
          </p>
        )}
        {error && (
          <p role="alert" className="m-0 text-sm text-danger">
            {error}
          </p>
        )}
      </div>
      <fieldset className="m-0 flex flex-col gap-2 border-0 p-0">
        <legend className="mb-1 text-sm font-medium">Microphone</legend>
        {MODES.map((m) => (
          <label key={m.id} className="flex min-h-11 items-start gap-3">
            <input
              type="radio"
              name="voice-mode"
              value={m.id}
              checked={mode === m.id}
              onChange={() => pickMode(m.id)}
              className="mt-1 size-4 accent-[var(--accent)]"
            />
            <span className="flex flex-col">
              <span className="text-sm font-medium">{m.label}</span>
              <span className="text-sm text-text-2">{m.hint}</span>
            </span>
          </label>
        ))}
      </fieldset>
      <SpokenReplies readOnly={readOnly} />
      <Persona readOnly={readOnly} />
      <DrivingRow readOnly={readOnly} />
    </section>
  )
}

type ReplyWithVoice = 'when_voice' | 'always' | 'never'
const REPLY_CHOICES: Array<[ReplyWithVoice, string]> = [
  ['when_voice', 'When I send a voice note'],
  ['always', 'Always'],
  ['never', 'Never'],
]

/** Voice-note replies (moved here from Settings -> Agent). Saves at once. The words say what each choice really does (M7). */
function SpokenReplies({ readOnly }: { readOnly: boolean }) {
  const client = useTalosClient()
  const saved = useTalos((s) => s.config?.voice_notes.reply_with_voice ?? 'when_voice')
  const ready = useTalos((s) => s.config !== null)
  const [error, setError] = useState<string | null>(null)
  const id = useId()
  const pick = async (next: string) => {
    setError(null)
    try {
      await client.patchConfig({ voice_notes: { reply_with_voice: next } })
    } catch (e) {
      setError(friendlyPatchError(e)) // the select shows the saved value, so it is back on it
    }
  }
  return (
    <div className="flex flex-col gap-1" data-testid="spoken-replies">
      <label htmlFor={id} className="text-sm font-medium">
        Voice-note replies
      </label>
      <select
        id={id}
        value={saved}
        disabled={readOnly || !ready}
        onChange={(e) => void pick(e.target.value)}
        className="min-h-11 rounded-button border border-line bg-surface px-3 text-text disabled:opacity-50"
      >
        {REPLY_CHOICES.map(([v, label]) => (
          <option key={v} value={v}>
            {label}
          </option>
        ))}
      </select>
      <p className="m-0 text-sm text-text-2">
        When a reply is spoken, your Mac reads it with its speech command, a different voice from the live-call voice
        above. Always still sends text if your Mac has no speech command set. Never is overridden by Driving mode, which
        speaks every reply until it ends.
      </p>
      {error && (
        <p role="alert" className="m-0 text-sm text-danger">
          {error}
        </p>
      )}
    </div>
  )
}

/** The live-call personality prompt (`agent.voice_persona`, up to 4,000 characters). Saved with its own button. */
function Persona({ readOnly }: { readOnly: boolean }) {
  const client = useTalosClient()
  const saved = useTalos((s) => s.config?.agent.voice_persona ?? '')
  const ready = useTalos((s) => s.config !== null)
  const [text, setText] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState<{ tone: 'ok' | 'error'; text: string } | null>(null)
  const id = useId()
  const value = text ?? saved
  const dirty = text !== null && text !== saved
  const save = async () => {
    setBusy(true)
    setMsg(null)
    try {
      await client.patchConfig({ agent: { voice_persona: value } })
      setText(null)
      setMsg({ tone: 'ok', text: 'Saved. It applies to your next call.' })
    } catch (e) {
      setMsg({ tone: 'error', text: `Not saved. ${friendlyPatchError(e)}` }) // the words stay in the box
    } finally {
      setBusy(false)
    }
  }
  return (
    <div className="flex flex-col gap-1" data-testid="voice-persona">
      <label htmlFor={id} className="text-sm font-medium">
        Live-call personality
      </label>
      <Textarea
        id={id}
        value={value}
        rows={4}
        maxLength={4000}
        disabled={readOnly || !ready}
        placeholder="Optional: how the voice should sound and act on a call"
        onChange={(e) => {
          setMsg(null)
          setText(e.target.value)
        }}
      />
      <div className="flex items-center gap-2">
        <Button variant="outline" disabled={readOnly || busy || !dirty} onClick={() => void save()}>
          Save personality
        </Button>
        <span className="text-xs text-text-2">{value.length} / 4000</span>
      </div>
      {msg && (
        <p
          role={msg.tone === 'error' ? 'alert' : 'status'}
          className={msg.tone === 'error' ? 'm-0 text-sm text-danger' : 'm-0 text-sm text-ok'}
        >
          {msg.text}
        </p>
      )}
    </div>
  )
}

export type { ReactNode }
