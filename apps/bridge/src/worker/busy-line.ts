// What the owner is told while a message waits for a thread session that is alive, and when Main takes it: the thread's own
// session gets CLAIM_DEADLINE_MS before Main answers for it, so the phone says why it waits meanwhile. Busy wording only for a
// live busy session; a hold the supervisor wrote (`pointer_hold` in workers.json) shows its own reason; `needs_you`, when set,
// wins over a hold (the phone already says what the session waits on). The line is a `status` frame in the thread, picked again
// on every hub tick and taken down with `idle` once nothing waits there. In memory only (a status frame is ephemeral).
import type { WorkerEntryT } from '@talos-app/protocol'
import type { BridgeContext } from '../context.ts'
import { threadRef } from '../context.ts'
import { statusFrame } from '../frames-out.ts'
import type { Notification } from '../notify.ts'
import type { RouteRow } from './store.ts'

const shown = new WeakMap<BridgeContext, Map<string, string>>() // thread -> the line now shown there

/** The owner's own messages (and card taps): not a scheduled run, a session's own wake timer or a hand-off. */
export const ownersOwn = (n: Notification): boolean =>
  n.meta.kind !== 'schedule_run' && n.meta.kind !== 'wake' && n.meta.kind !== 'handoff'

/** A status label is at most 80 UTF-16 units (ThreadStatus.label): a longer one drops the whole frame at the relay. */
const LABEL_MAX = 80

/** `name` + `rest`, the name cut on a whole character (with an ellipsis) so the label is never over LABEL_MAX units. */
export function clippedLabel(name: string, rest: string): string {
  const room = LABEL_MAX - rest.length
  if (name.length <= room) return name + rest
  let out = ''
  for (const ch of name) {
    if (out.length + ch.length > room - 1) break
    out += ch
  }
  return `${out.trimEnd()}…${rest}`
}

/** While a message waits. Null: nothing to say (an idle session, or one that already tells the owner what it waits on). */
export function waitingLine(name: string, e: WorkerEntryT): string | null {
  if (e.needs_you) return null
  const h = e.pointer_hold
  if (h) {
    if (h.reason === 'refused') return clippedLabel(name, " can't take messages right now.")
    if (h.reason === 'typed_unseen') return clippedLabel(name, ' is waiting for you: not picked up')
    if (h.reason === 'draft') return clippedLabel(name, ' is waiting for you: unsent text')
    if (h.reason === 'scrolled') return clippedLabel(name, ' is waiting for you: scrolled back')
    return clippedLabel(name, ' is waiting for you.') // a reason a newer writer knows
  }
  return e.state === 'busy' ? clippedLabel(name, " is busy; it'll see this when it's free.") : null
}

/** The system row when Main takes the message at the deadline. Null: the session is not alive-and-held, so the usual row. */
export function deadlineLine(name: string, e: WorkerEntryT): string | null {
  if (e.pointer_hold?.reason === 'refused') return `${name} couldn't take messages, so the main agent answered.`
  if (e.pointer_hold || e.needs_you) return `${name} was waiting for you, so the main agent answered.`
  return e.state === 'busy' ? `${name} was busy, so the main agent answered.` : null
}

/**
 * A status frame of the thread's own session passed through the hub: the session speaks for the thread now, so no line of ours is
 * kept there and no `idle` follows later to wipe what it said (it may have claimed the message and set its status before the poll).
 */
export function sessionSpoke(ctx: BridgeContext, thread: string): void {
  shown.get(ctx)?.delete(thread)
}

/** Shows, changes or takes down the lines to match the messages that wait now (`rows`: every unclaimed route). */
export function syncWaitLines(
  ctx: BridgeContext,
  rows: RouteRow[],
  threads: Record<string, WorkerEntryT> | undefined,
  shownIn: (n: Notification, lead: string) => string,
): void {
  const want = new Map<string, string>()
  for (const row of rows) {
    const e = threads?.[row.thread_id]
    if (!e || !ownersOwn(row.notification)) continue
    const thread = shownIn(row.notification, row.thread_id)
    const line = waitingLine(threadRef(ctx, thread).name, e)
    if (line) want.set(thread, line)
  }
  const now = shown.get(ctx) ?? new Map<string, string>()
  shown.set(ctx, now)
  // a frame the socket could not take (not ready, reconnecting) is tried again on the next tick: only a sent one counts as shown
  for (const [thread, text] of want)
    if (now.get(thread) !== text && ctx.transport.sendEphemeral(statusFrame(ctx.clock.now(), thread, 'working', text)))
      now.set(thread, text)
  // 'idle', not 'working': nothing would ever clear a working row left behind
  for (const thread of [...now.keys()])
    if (!want.has(thread) && ctx.transport.sendEphemeral(statusFrame(ctx.clock.now(), thread, 'idle')))
      now.delete(thread)
}
