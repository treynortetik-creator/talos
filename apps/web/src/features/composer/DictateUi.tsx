// The dictate button and the line above the box that says what dictation is doing.
import { useEffect, useRef } from 'react'
import { formatDuration } from '../../lib/format.ts'
import { cn } from '../../ui/cn.ts'
import { IconAlert, IconDictate, IconStop } from '../../ui/icons.tsx'
import { failureText } from './dictate.ts'
import { MAX_RECORD_MS } from './recorder.ts'
import { type DictatePhase, WARN_BEFORE_MS } from './useDictation.ts'

const BTN = 'grid size-[min(2.75rem,52px)] shrink-0 select-none place-items-center rounded-pill'

export function DictateButton({
  phase,
  disabled,
  onStart,
  onStop,
}: {
  phase: DictatePhase
  disabled: boolean
  onStart(): void
  onStop(): void
}) {
  const recording = phase.kind === 'recording'
  // Off while working, and while a kept recording waits for Try again, Send as voice note or Discard: starting over would drop it.
  const busy = phase.kind === 'transcribing' || (phase.kind === 'failed' && phase.kept)
  return (
    <button
      type="button"
      data-testid="dictate"
      aria-label={recording ? 'Stop dictating' : 'Dictate'}
      aria-pressed={recording}
      disabled={disabled || busy}
      // A tap must not move focus off the box.
      onMouseDown={(e) => e.preventDefault()}
      onClick={recording ? onStop : onStart}
      className={cn(BTN, recording ? 'bg-danger text-on-accent' : 'text-text-2', (disabled || busy) && 'opacity-40')}
    >
      {recording ? <IconStop /> : <IconDictate />}
    </button>
  )
}

/** True when focus has nowhere to be: nothing is focused, or the focused button was just switched off. */
export const focusIsLost = (): boolean => {
  const a = document.activeElement
  return !a || a === document.body || (a instanceof HTMLButtonElement && a.disabled)
}

const LINK = 'min-h-11 rounded-pill border border-line px-3 text-text'

export function DictateStrip({
  phase,
  onStop,
  onCancel,
  onRetry,
  onVoiceNote,
  onDismiss,
}: {
  phase: DictatePhase
  onStop(): void
  onCancel(): void
  onRetry(): void
  onVoiceNote(): void
  onDismiss(): void
}) {
  if (phase.kind === 'idle') return null
  if (phase.kind === 'recording') {
    const warn = phase.elapsed >= MAX_RECORD_MS - WARN_BEFORE_MS
    return (
      <div data-testid="dictate-recording" className="mb-2 flex min-h-11 items-center gap-3 text-sm" role="status">
        <span className="inline-block size-2 rounded-pill bg-danger" aria-hidden="true" />
        <span className="font-mono">{formatDuration(phase.elapsed)}</span>
        <span className={warn ? 'text-danger' : 'text-text-2'}>
          {warn ? 'Under a minute left. It stops by itself at 10:00.' : 'Speak, then tap the stop button.'}
        </span>
        <span className="flex-1" />
        <button type="button" className={LINK} onClick={onStop}>
          Stop
        </button>
        <button type="button" className={LINK} onClick={onCancel}>
          Cancel
        </button>
      </div>
    )
  }
  if (phase.kind === 'transcribing')
    return (
      <p data-testid="dictate-working" role="status" className="m-0 mb-2 text-sm text-text-2">
        Turning your words into text…
      </p>
    )
  if (phase.kind === 'done')
    return (
      <p data-testid="dictate-done" role="status" className="m-0 mb-2 flex items-center gap-2 text-sm text-text-2">
        <span className="flex-1">
          {phase.cutShort
            ? 'The recording stopped by itself. The words cover what it captured, added to your message.'
            : 'Added to your message. Check it, then send.'}
        </span>
        <button type="button" className="min-h-11 px-2 text-text-2 underline" onClick={onDismiss}>
          OK
        </button>
      </p>
    )
  if (phase.kind === 'denied')
    return (
      <p data-testid="dictate-denied" role="alert" className="m-0 mb-2 flex items-center gap-2 text-sm text-danger">
        <IconAlert width={16} height={16} /> <span className="flex-1">{phase.message}</span>
        <button type="button" className="min-h-11 px-2 text-text-2 underline" onClick={onDismiss}>
          OK
        </button>
      </p>
    )
  return <FailedStrip phase={phase} onRetry={onRetry} onVoiceNote={onVoiceNote} onDismiss={onDismiss} />
}

function FailedStrip({
  phase,
  onRetry,
  onVoiceNote,
  onDismiss,
}: {
  phase: Extract<DictatePhase, { kind: 'failed' }>
  onRetry(): void
  onVoiceNote(): void
  onDismiss(): void
}) {
  const row = useRef<HTMLDivElement>(null)
  // The Dictate button went off while this was working, so a keyboard user's focus fell to the page: put it on the first choice.
  useEffect(() => {
    if (focusIsLost()) row.current?.querySelector('button')?.focus()
  }, [])
  return (
    <div
      ref={row}
      data-testid="dictate-failed"
      role="alert"
      className="mb-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-sm"
    >
      <span className="flex items-center gap-2 text-danger">
        <IconAlert width={16} height={16} />
        {phase.empty ? 'No words came through.' : failureText(phase.failure, phase.leftBytes ?? null)}
      </span>
      {!phase.kept ? null : (
        <>
          <span className="text-text-2">Your recording is kept.</span>
          {phase.failure === 'disabled' || phase.failure === 'daily_cap' || phase.failure === 'daily_used_up' ? null : (
            <button type="button" className={LINK} onClick={onRetry}>
              Try again
            </button>
          )}
          <button type="button" className={LINK} onClick={onVoiceNote}>
            Send as voice note
          </button>
        </>
      )}
      <button type="button" className={LINK} onClick={onDismiss}>
        {phase.kept ? 'Discard' : 'OK'}
      </button>
    </div>
  )
}
