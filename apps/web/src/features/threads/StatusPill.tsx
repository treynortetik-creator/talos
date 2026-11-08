import type { ThreadStatusT } from '@talos-app/protocol'
import { cn } from '../../ui/cn.ts'
import { type DotShape, StatusDot } from '../../ui/StatusDot.tsx'

const WORDS: Record<ThreadStatusT['state'], { word: string; shape: DotShape; tone: string }> = {
  idle: { word: 'Idle', shape: 'ring', tone: 'text-text-2' },
  working: { word: 'Working…', shape: 'half', tone: 'text-accent-text' },
  needs_you: { word: 'Needs you', shape: 'solid', tone: 'text-warn' },
  on_call: { word: 'On a call', shape: 'live', tone: 'text-ok' },
  queued: { word: 'Queued', shape: 'quarter', tone: 'text-text-2' },
}

/** The mark, word and tone for a status, for places that show only the dot. */
export const statusMark = (s?: ThreadStatusT['state']) => WORDS[s ?? 'idle']

/** Status word paired with a drawn mark and a color (never color alone, 8.1). */
export function StatusWord({
  state,
  className,
  pill,
}: {
  state?: ThreadStatusT['state']
  className?: string
  /** Drawn as a small outlined pill: the chat header's status, beside the title. */
  pill?: boolean
}) {
  const w = WORDS[state ?? 'idle']
  return (
    <span
      data-testid="status-word"
      className={cn(
        'inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap text-xs font-semibold uppercase tracking-[var(--tracking-caps)]',
        w.tone,
        pill && 'rounded-pill border border-line px-2.5 py-0.5',
        className,
      )}
    >
      <StatusDot shape={w.shape} />
      {w.word}
    </span>
  )
}
