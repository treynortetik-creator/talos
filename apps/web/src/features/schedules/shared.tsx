// Small pieces the Schedules screens share: time formatting in the scheduler's zone, a field wrapper, a notice, and the
// status line. Colours come from tokens; every status is words first (SPEC 8.1).
import type { SchedulerHealthT, ScheduleT } from '@talos-app/protocol'
import { type ReactNode, useId } from 'react'
import { useTalos } from '../../lib/client.ts'
import { cn } from '../../ui/cn.ts'
import { Mascot } from '../../ui/Mascot.tsx'
import { useNow } from '../cards/util.ts'
import { formatTime, type RowStatus, rowStatus, type Tone, whenLabel, zoneSuffix } from './logic.ts'

export const TONE: Record<Tone, string> = {
  ok: 'text-ok',
  danger: 'text-danger',
  accent: 'text-accent-text',
  warn: 'text-warn',
  muted: 'text-text-2',
}

export const FIELD =
  'w-full min-h-11 rounded-button border border-line bg-surface px-3 text-md text-text placeholder:text-text-2 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus disabled:opacity-50'

export const CAPS = 'text-xs font-semibold uppercase tracking-[var(--tracking-caps)]'

/** Times in the scheduler's zone, labelled with the zone when it is not the owner's. */
export function useSchedTime(health: SchedulerHealthT | null) {
  const ownerTz = useTalos((s) => s.config?.timezone)
  const macOnline = useTalos((s) => s.presence.bridge_online)
  const now = useNow(30_000)
  const tz = health?.tz ?? ownerTz ?? 'UTC'
  return {
    now,
    tz,
    macOnline,
    ownerTz,
    time: (iso: string) => `${formatTime(iso, tz)}${zoneSuffix(iso, tz, ownerTz)}`,
    when: (iso: string) => `${whenLabel(iso, now, tz)}${zoneSuffix(iso, tz, ownerTz)}`,
    status: (s: ScheduleT): RowStatus => rowStatus(s, { nowMs: now, tz, macOnline, ownerTz }),
  }
}

export function StatusText({ st, className }: { st: RowStatus; className?: string }) {
  return (
    <span className={cn('inline-flex items-center gap-1.5 text-sm font-medium', TONE[st.tone], className)}>
      {st.running ? (
        <Mascot state="working" size={16} name="Talos" decorative animate={false} />
      ) : (
        <span aria-hidden="true">{st.glyph}</span>
      )}
      <span>{st.word}</span>
      {st.time ? <span className="font-mono text-xs">{st.time}</span> : null}
    </span>
  )
}

export function Field({
  label,
  hint,
  error,
  children,
}: {
  label: string
  hint?: string
  error?: string | undefined
  children: (p: { id: string; 'aria-describedby': string | undefined; 'aria-invalid': boolean }) => ReactNode
}) {
  const id = useId()
  const desc = error ? `${id}-err` : hint ? `${id}-hint` : undefined
  return (
    <div className="space-y-1">
      <label htmlFor={id} className={cn(CAPS, 'block text-text-2')}>
        {label}
      </label>
      {children({ id, 'aria-describedby': desc, 'aria-invalid': Boolean(error) })}
      {error ? (
        <p id={`${id}-err`} role="alert" className="text-sm text-danger">
          {error}
        </p>
      ) : hint ? (
        <p id={`${id}-hint`} className="text-xs text-text-2">
          {hint}
        </p>
      ) : null}
    </div>
  )
}

/** The bridge's refusal in plain words (S5.6 "Run now refused"). */
export function refusalWords(e: unknown): string {
  const code = (e as { code?: string } | null)?.code
  switch (code) {
    case 'already_running':
      return 'Already running'
    case 'headless_blocked':
      return 'Background runs are off'
    case 'held':
      return 'On hold: review the change first'
    case 'mac_offline':
      return 'Your Mac is offline. Try again when it is back.'
    case 'schedule_not_found':
      return 'That job is gone.'
    // the bridge words these well (rate_limited, schedule_read_only, stale, scheduler_unavailable ...): show them as they are
    case 'internal':
      return "Your Mac didn't answer. Try again."
    default:
      return (e as Error | null)?.message || 'Something went wrong.'
  }
}

/** A transient message at the foot of the screen. */
export function Notice({ text, onClose }: { text: string | null; onClose: () => void }) {
  if (!text) return null
  return (
    <div
      role="status"
      data-testid="schedules-notice"
      className="fixed inset-x-4 bottom-24 z-40 mx-auto flex max-w-md items-center gap-3 rounded-card border border-line bg-surface p-3 text-sm text-text shadow-[var(--inset-highlight)] md:bottom-6"
    >
      <span className="flex-1">{text}</span>
      <button type="button" className="min-h-11 px-2 text-text-2 underline" onClick={onClose}>
        Dismiss
      </button>
    </div>
  )
}

/** Splits `code` spans out of plain text so a command shows in the mono face. */
export function Ticks({ text }: { text: string }) {
  const parts = text.split(/(`[^`]+`)/g)
  return (
    <>
      {parts.map((p, i) =>
        p.startsWith('`') && p.endsWith('`') ? (
          // biome-ignore lint/suspicious/noArrayIndexKey: static split of one string
          <code key={i} className="rounded bg-surface-2 px-1 font-mono text-[0.9em]">
            {p.slice(1, -1)}
          </code>
        ) : (
          // biome-ignore lint/suspicious/noArrayIndexKey: static split of one string
          <span key={i}>{p}</span>
        ),
      )}
    </>
  )
}
