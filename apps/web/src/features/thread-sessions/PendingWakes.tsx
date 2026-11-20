// The wake_me timers waiting to wake the session that answers this thread (docs/OPTION-C.md "Wake me"): a thread with its own
// session shows that session's, any other thread shows main's. Each row has the time, the agent's note and a Cancel button.
// Nothing is shown while there are none. A cancel the Mac refused says why under the list; one that worked hides the row at
// once (the next `workers.status` drops it too) and moves focus to the list's heading, so it is never lost to the page.
import type { PendingWakeT } from '@talos-app/protocol'
import { useRef, useState } from 'react'
import { placeWords, useHost } from '../../lib/hostWords.ts'
import { Button } from '../../ui/index.ts'
import { useWriteBlock } from '../settings/offline.ts'
import { type ControlOutcome, useThreadSessionsController, useThreadSessionView, useWorkersStatus } from './store.ts'

/** "Mon 8:00 AM" in the viewer's own zone, with the date when it is not within the next six days. */
export function wakeWhen(iso: string, now: number = Date.now()): string {
  const d = new Date(iso)
  const soon = d.getTime() - now < 6 * 24 * 3600_000
  return d.toLocaleString(undefined, {
    weekday: 'short',
    ...(soon ? {} : { month: 'short', day: 'numeric' }),
    hour: 'numeric',
    minute: '2-digit',
  })
}

/** Which wakes this thread's panel lists: its own session's when it has one, else main's. */
export function useThreadWakes(threadId: string): { wakes: PendingWakeT[]; total: number; whose: 'thread' | 'main' } {
  const view = useThreadSessionView(threadId)
  const status = useWorkersStatus()
  if (view.dedicated) {
    const wakes = view.worker?.wakes ?? []
    return { wakes, total: Math.max(view.worker?.wakes_total ?? 0, wakes.length), whose: 'thread' }
  }
  const wakes = status?.main_wakes ?? []
  return { wakes, total: Math.max(status?.main_wakes_total ?? 0, wakes.length), whose: 'main' }
}

export function PendingWakes({ threadId }: { threadId: string }) {
  const host = useHost()
  const ctl = useThreadSessionsController()
  const { wakes, total, whose } = useThreadWakes(threadId)
  const blocked = useWriteBlock()
  const [busy, setBusy] = useState<string | null>(null)
  const [gone, setGone] = useState<ReadonlySet<string>>(new Set())
  const [failed, setFailed] = useState<ControlOutcome | null>(null)
  const heading = useRef<HTMLHeadingElement>(null)
  const shown = wakes.filter((w) => !gone.has(w.id))
  if (shown.length === 0 && !failed) return null
  const more = total - wakes.length

  const cancel = async (w: PendingWakeT) => {
    setBusy(w.id)
    setFailed(null)
    const o = await ctl.control(threadId, 'cancel_wake', w.id)
    setBusy(null)
    if (o.ok) {
      setGone((g) => new Set([...g, w.id]))
      heading.current?.focus()
    } else setFailed(o)
  }
  return (
    <section aria-labelledby={`wakes-${threadId}`} data-testid="pending-wakes" className="flex flex-col gap-2">
      <h3
        id={`wakes-${threadId}`}
        ref={heading}
        tabIndex={-1}
        className="m-0 text-xs font-semibold uppercase tracking-[var(--tracking-caps)] text-text-2 outline-none"
      >
        {whose === 'thread' ? 'Wake-ups for this thread’s agent' : 'Wake-ups for the main agent'}
      </h3>
      {shown.length > 0 && (
        <ul className="m-0 flex list-none flex-col gap-1 p-0">
          {shown.map((w) => (
            <li
              key={w.id}
              data-testid="pending-wake"
              className="flex min-h-11 items-center justify-between gap-3 border-b border-line py-1 text-sm last:border-b-0"
            >
              <div className="flex min-w-0 flex-col">
                <time dateTime={w.at} className="font-medium">
                  {wakeWhen(w.at)}
                </time>
                <span className="break-words text-xs text-text-2">{w.note}</span>
              </div>
              <Button
                variant="outline"
                className="shrink-0"
                disabled={busy !== null || blocked !== null}
                aria-label={`Cancel the wake-up at ${wakeWhen(w.at)}`}
                onClick={() => void cancel(w)}
              >
                {busy === w.id ? 'Cancelling…' : 'Cancel'}
              </Button>
            </li>
          ))}
        </ul>
      )}
      {more > 0 && <p className="m-0 text-xs text-text-2">{`And ${more} more later.`}</p>}
      {blocked !== null && shown.length > 0 && (
        <p className="m-0 text-xs text-text-2">
          {placeWords(
            blocked === 'link'
              ? 'Connecting… You can cancel once connected.'
              : 'Your Mac is offline, so a wake-up can’t be cancelled right now.',
            host,
          )}
        </p>
      )}
      {failed && (
        <p role="alert" className="m-0 text-xs text-danger">
          {placeWords(failed.text, host)}
        </p>
      )}
    </section>
  )
}
