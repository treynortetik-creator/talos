// Voice notes: record (hold, slide up to lock, slide left to cancel, tap to lock), pause with a preview, and send the
// finished recording (queued on the phone when offline).
import { type Dispatch, type MutableRefObject, type SetStateAction, useEffect, useRef, useState } from 'react'
import type { TalosClient } from '../../lib/client.ts'
import { micOffText } from '../../lib/micOff.ts'
import { getPlatform } from '../../lib/platform.ts'
import type { SocketClient } from '../../lib/socketClient.ts'
import {
  extFor,
  isStrayTap,
  MAX_RECORD_MS,
  MIN_RECORD_MS,
  type RecorderHandle,
  type Recording,
  startRecorder,
} from './recorder.ts'

const LOCK_DY = 60
const CANCEL_DX = 100
const TAP_MS = 350

export type Mode = 'idle' | 'holding' | 'locked'

export const canQueue = (c: TalosClient): c is SocketClient => 'queueVoiceNote' in c

/** What the recorder row shows. Declared before the box's own effects, which depend on `mode`. */
export function useRecorderState() {
  const [mode, setMode] = useState<Mode>('idle')
  const [hint, setHint] = useState<'slide' | 'cancel' | 'lock' | null>(null)
  const [elapsed, setElapsed] = useState(0)
  const [paused, setPaused] = useState(false)
  const [preview, setPreview] = useState<string | null>(null)
  const modeRef = useRef<Mode>('idle')
  modeRef.current = mode
  const setBoth = (m: Mode) => {
    modeRef.current = m
    setMode(m)
  }
  return { mode, hint, setHint, elapsed, setElapsed, paused, setPaused, preview, setPreview, modeRef, setBoth }
}
export type RecorderState = ReturnType<typeof useRecorderState>

export function useComposerVoice(o: {
  client: TalosClient
  threadId: string
  setError: Dispatch<SetStateAction<string | null>>
  rec: RecorderState
}) {
  const { client, threadId, setError, rec } = o
  const { mode, setHint, setElapsed, paused, setPaused, setPreview, setBoth } = rec
  const recRef = useRef<Promise<RecorderHandle> | null>(null)
  const finishRef = useRef<(send: boolean) => Promise<void>>(async () => {})
  // biome-ignore lint/correctness/useExhaustiveDependencies: setElapsed is a state setter; the list is kept as it was
  useEffect(() => {
    if (mode === 'idle') return
    const t = setInterval(async () => {
      const h = await recRef.current?.catch(() => null)
      if (!h) return
      const ms = h.elapsedMs()
      setElapsed(ms)
      if (ms >= MAX_RECORD_MS) void finishRef.current(true)
    }, 250)
    return () => clearInterval(t)
  }, [mode])

  const begin = () => {
    setError(null)
    const p = startRecorder()
    recRef.current = p
    p.catch((e: unknown) => {
      recRef.current = null
      setBoth('idle')
      setHint(null)
      setError(
        e instanceof DOMException && (e.name === 'NotAllowedError' || e.name === 'SecurityError')
          ? micOffText()
          : 'Voice notes are not supported here.',
      )
    })
  }

  const discard = async () => {
    const p = recRef.current
    recRef.current = null
    setBoth('idle')
    setHint(null)
    setPaused(false)
    setPreview(null)
    setElapsed(0)
    ;(await p?.catch(() => null))?.cancel()
  }

  const finish = async (send_ = true) => {
    const p = recRef.current
    recRef.current = null
    setBoth('idle')
    setHint(null)
    setPaused(false)
    setPreview(null)
    setElapsed(0)
    const handle = await p?.catch(() => null)
    if (!handle) return
    if (!send_) return handle.cancel()
    const r = await handle.stop()
    if (isStrayTap(r)) {
      // A short touch is nothing. A long recording with no bytes in it is a failure the owner should hear about.
      if (r.durationMs >= MIN_RECORD_MS) setError('Nothing was recorded, so no voice note was sent. Record it again.')
      return
    }
    await sendRecording(r)
  }

  /** Sends a finished recording as a voice note (queued on the phone when offline). Also the way out of a failed dictation. */
  const sendRecording = async (r: Recording) => {
    const name = `voice-note-${Date.now()}.${extFor(r.mime)}`
    const meta = { name, durationMs: r.durationMs, waveform: r.waveform }
    const offline = !navigator.onLine || client.store.getState().connection !== 'online'
    // Saving the recording to this device is the one thing that can fail without the note going anywhere: say so, and never
    // leave a second copy behind. `queueVoiceNote` saves before it queues, so a throw means nothing was kept.
    const keep = async (c: SocketClient) => {
      try {
        await c.queueVoiceNote({ threadId, blob: r.blob, ...meta })
      } catch {
        setError("Couldn't save the voice note on this device, so it was not sent. Record it again.")
      }
    }
    if (offline && canQueue(client)) return keep(client)
    try {
      const att = await client.uploadMedia(r.blob, meta)
      await client.sendVoiceNote({ threadId, attachment: { ...att, kind: 'voice_note' } })
      getPlatform().haptic('light')
    } catch {
      // The upload or the send failed before anything was queued (sendVoiceNote throws only before it queues).
      if (canQueue(client)) await keep(client)
      else setError("Couldn't send the voice note.")
    }
  }

  finishRef.current = finish

  const togglePause = async () => {
    const h = await recRef.current?.catch(() => null)
    if (!h) return
    if (paused) {
      h.resume()
      setPaused(false)
      setPreview((u) => {
        if (u) URL.revokeObjectURL(u)
        return null
      })
    } else {
      h.pause()
      setPaused(true)
      const blob = await h.snapshot()
      setPreview(URL.createObjectURL(blob))
    }
  }

  return { begin, discard, finish, sendRecording, togglePause }
}

/** The mic button's pointer gestures. Off while dictation holds the microphone. */
export function useMicGesture(o: {
  rec: RecorderState
  dictationBusy: boolean
  begin: () => void
  discard: () => Promise<void>
  finish: (send_?: boolean) => Promise<void>
}) {
  const { rec, dictationBusy, begin, discard, finish } = o
  const { modeRef, setBoth, setHint, setElapsed } = rec
  const gesture: MutableRefObject<{ x: number; y: number; t: number } | null> = useRef(null)
  const onPointerDown = (e: React.PointerEvent<HTMLButtonElement>) => {
    if (dictationBusy || modeRef.current !== 'idle' || e.button > 0) return // off while dictation holds the microphone
    e.currentTarget.setPointerCapture(e.pointerId)
    gesture.current = { x: e.clientX, y: e.clientY, t: Date.now() }
    setBoth('holding')
    setHint('slide')
    setElapsed(0)
    begin()
  }
  const onPointerMove = (e: React.PointerEvent<HTMLButtonElement>) => {
    const g = gesture.current
    if (!g || modeRef.current !== 'holding') return
    const dx = e.clientX - g.x
    const dy = e.clientY - g.y
    if (dx <= -CANCEL_DX) {
      gesture.current = null
      void discard()
    } else if (dy <= -LOCK_DY) {
      gesture.current = null
      setBoth('locked')
      setHint(null)
    } else setHint(dx < -30 ? 'cancel' : dy < -20 ? 'lock' : 'slide')
  }
  const onPointerUp = () => {
    const g = gesture.current
    gesture.current = null
    if (!g || modeRef.current !== 'holding') return
    if (Date.now() - g.t < TAP_MS) {
      setBoth('locked') // a tap enters locked mode directly (the accessible path)
      setHint(null)
    } else void finish(true)
  }
  const onPointerCancel = () => {
    if (gesture.current && modeRef.current === 'holding') {
      gesture.current = null
      void discard()
    }
  }
  const onMicClick = (e: React.MouseEvent) => {
    // Keyboard / assistive activation has detail 0 and no pointer events: treat it as a tap.
    if (dictationBusy || e.detail !== 0 || modeRef.current !== 'idle') return
    setBoth('locked')
    setElapsed(0)
    begin()
  }
  return { onPointerDown, onPointerMove, onPointerUp, onPointerCancel, onMicClick }
}
