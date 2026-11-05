// The state of one dictation in the composer: record, stop, transcribe, and keep the recording when that fails so no
// words are lost. The audio lives in this hook's refs only; leaving the thread or ending the session drops it.
import { useCallback, useEffect, useRef, useState } from 'react'
import { micOffText } from '../../lib/micOff.ts'
import { useSession } from '../auth/session.ts'
import { DictateError, type DictateFailure, transcribe } from './dictate.ts'
import {
  isStrayTap,
  MAX_RECORD_MS,
  MIN_RECORD_MS,
  pickMime,
  type RecorderHandle,
  type Recording,
  startRecorder,
} from './recorder.ts'

/** The warning appears this long before the recording is cut off. */
export const WARN_BEFORE_MS = 60_000
export type DictatePhase =
  | { kind: 'idle' }
  | { kind: 'recording'; elapsed: number }
  | { kind: 'transcribing' }
  /** `kept`: the recording is still held, and the choices are Try again, Send as voice note or Discard. */
  | { kind: 'failed'; failure: DictateFailure; empty?: boolean; kept: boolean; leftBytes?: number | null }
  | { kind: 'denied'; message: string }
  /** `cutShort`: the recorder stopped by itself, so the words cover only what it captured. */
  | { kind: 'done'; cutShort: boolean }

/** True where the recorder works and the relay says dictation is on. An older relay (no field) counts as off. */
export function useDictateAvailable(): boolean {
  const on = useSession((s) => s.me?.dictate?.available === true)
  return on && pickMime() !== null && typeof navigator !== 'undefined' && Boolean(navigator.mediaDevices?.getUserMedia)
}

export function useDictation(opts: {
  threadId: string
  /** The words arrived. They go at the end of whatever is in the box now. */
  onWords(words: string): void
  /** The relay said the session is over (a 401); `reason` is what it gave. */
  onSignedOut(reason: string | null): void
  /** "Send as voice note" on a failed transcription. */
  sendAsVoiceNote(r: Recording): Promise<void>
}) {
  const [phase, setPhase] = useState<DictatePhase>({ kind: 'idle' })
  const handle = useRef<Promise<RecorderHandle> | null>(null)
  const held = useRef<Recording | null>(null)
  const abort = useRef<AbortController | null>(null)
  // Bumped when the thread changes or the session ends: an answer that comes back for an older run is ignored.
  const run = useRef(0)
  const o = useRef(opts)
  o.current = opts
  const authed = useSession((s) => s.status === 'authed')

  const drop = useCallback(() => {
    run.current++
    abort.current?.abort()
    abort.current = null
    const h = handle.current
    handle.current = null
    void h?.then((x) => x.cancel()).catch(() => {})
    held.current = null
  }, [])

  // biome-ignore lint/correctness/useExhaustiveDependencies: leaving the thread drops the recording
  useEffect(() => {
    return () => {
      drop()
      setPhase({ kind: 'idle' })
    }
  }, [opts.threadId, drop])
  useEffect(() => {
    if (authed) return
    drop()
    setPhase({ kind: 'idle' })
  }, [authed, drop])

  const send = useCallback(async (r: Recording) => {
    const mine = run.current
    setPhase({ kind: 'transcribing' })
    const ctl = new AbortController()
    abort.current = ctl
    try {
      const words = await transcribe(r.blob, ctl.signal)
      if (mine !== run.current) return
      if (words.trim() === '') return setPhase({ kind: 'failed', failure: 'other', empty: true, kept: true })
      held.current = null
      o.current.onWords(words)
      setPhase({ kind: 'done', cutShort: r.endedByItself })
    } catch (e) {
      if (mine !== run.current) return
      const failure = e instanceof DictateError ? e.kind : 'other'
      if (failure === 'signed_out') {
        held.current = null // the session ended: the recording goes with it
        o.current.onSignedOut(e instanceof DictateError ? e.reason : null)
      }
      setPhase({
        kind: 'failed',
        failure,
        kept: held.current !== null,
        leftBytes: e instanceof DictateError ? e.leftBytes : null,
      })
    } finally {
      if (abort.current === ctl) abort.current = null
    }
  }, [])

  const stop = useCallback(async () => {
    const p = handle.current
    if (!p) return
    handle.current = null
    const mine = run.current
    setPhase({ kind: 'transcribing' })
    try {
      const r = await (await p).stop()
      if (mine !== run.current) return
      if (isStrayTap(r)) {
        // A short tap is nothing. A long one with no sound in it is not: say so.
        if (r.durationMs < MIN_RECORD_MS) return setPhase({ kind: 'idle' })
        return setPhase({ kind: 'denied', message: 'Nothing was recorded, so there are no words to add.' })
      }
      held.current = r
      await send(r)
    } catch {
      // The recorder itself failed: nothing is held, so no recording is kept and there is nothing to try again.
      if (mine === run.current)
        setPhase({
          kind: 'denied',
          message: 'The recording failed and nothing was saved. Tap Dictate to record again.',
        })
    }
  }, [send])

  const start = useCallback(() => {
    // A kept recording is never replaced by a new one: the owner picks Try again, Send as voice note or Discard first.
    if (handle.current || phase.kind === 'transcribing' || held.current) return
    const p = startRecorder(undefined, { analyse: false })
    handle.current = p
    setPhase({ kind: 'recording', elapsed: 0 })
    p.catch((e: unknown) => {
      if (handle.current === p) handle.current = null
      setPhase({
        kind: 'denied',
        message:
          e instanceof DOMException && (e.name === 'NotAllowedError' || e.name === 'SecurityError')
            ? micOffText()
            : 'Recording is not supported here.',
      })
    })
  }, [phase.kind])

  const recording = phase.kind === 'recording'
  useEffect(() => {
    if (!recording) return
    const t = setInterval(async () => {
      const h = await handle.current?.catch(() => null)
      if (!h) return
      const ms = h.elapsedMs()
      setPhase((cur) => (cur.kind === 'recording' ? { kind: 'recording', elapsed: ms } : cur))
      // Time up, or the recorder ended on its own: either way keep what it has.
      if (ms >= MAX_RECORD_MS || h.endedByItself()) void stop()
    }, 250)
    return () => clearInterval(t)
  }, [recording, stop])

  return {
    phase,
    start,
    stop,
    cancel() {
      drop()
      setPhase({ kind: 'idle' })
    },
    retry() {
      if (held.current) void send(held.current)
    },
    async asVoiceNote() {
      const r = held.current
      if (!r) return
      held.current = null
      setPhase({ kind: 'idle' })
      await o.current.sendAsVoiceNote(r)
    },
    dismiss() {
      if (phase.kind === 'failed') held.current = null
      setPhase({ kind: 'idle' })
    },
  }
}
