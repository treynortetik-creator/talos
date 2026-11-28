// A thread that says "working" while its session is parked (owner's report 54fcdc740fd6). The bridge says "Starting a session for
// this thread..." when a message goes to a cold thread, and a thread's own session says working and idle through `set_status`. Nothing
// took the start row down when the session never started, or parked again before it said idle, so the app (which trusts a `working`
// row for six hours) went on saying the session was working while its terminal was parked.
//
// This remembers which threads were last told `working` by us or by their session, and on every router tick sends one `idle` for
// each whose session is not running and which has no message waiting for it. A running session ('starting', 'live', 'busy') is left
// alone: it speaks for itself. When the supervisor is not heard from, nothing is known and nothing is changed. In memory only: a status
// frame is ephemeral, and the relay already clears every `working` row when the bridge reconnects (relay hub-status.ts).
import {
  leadThreadFor,
  supervisorFresh,
  type ThreadStatusT,
  WORKER_LIVE_STATES,
  type WorkersReadT,
} from '@talos-app/protocol'
import type { BridgeContext } from '../context.ts'
import { statusFrame } from '../frames-out.ts'

const rows = new WeakMap<BridgeContext, Set<string>>() // thread -> its last status that went out was `working`

/** A status frame for `thread` was sent: remember `working`, forget anything else. */
export function noteStatusSent(ctx: BridgeContext, thread: string, state: ThreadStatusT['state']): void {
  let s = rows.get(ctx)
  if (!s) {
    s = new Set()
    rows.set(ctx, s)
  }
  if (state === 'working') s.add(thread)
  else s.delete(thread)
}

/** Sends `idle` for each remembered thread whose session is not running and which nothing waits on. Returns how many. */
export function settleWorkingRows(
  ctx: BridgeContext,
  file: WorkersReadT | null,
  now: number,
  waiting: (thread: string) => boolean,
): number {
  const s = rows.get(ctx)
  if (!s || s.size === 0) return 0
  if (!file || !supervisorFresh(file, now)) return 0
  let sent = 0
  for (const thread of [...s]) {
    // the session that answers this thread: itself, or its parent's lead for a sub-thread; none means Main speaks for it
    const lead = leadThreadFor(ctx.config.config, thread)
    if (!lead) {
      s.delete(thread)
      continue
    }
    if (file.unavailable.includes(lead)) continue
    const e = file.threads[lead]
    if (e && WORKER_LIVE_STATES.includes(e.state)) continue
    if (waiting(lead)) continue
    // a frame the socket could not take is tried again on the next tick
    if (ctx.transport.sendEphemeral(statusFrame(now, thread, 'idle'))) {
      s.delete(thread)
      sent++
    }
  }
  return sent
}

/** The row the owner sees while a message waits for a thread whose session is being started. */
export function startRow(ctx: BridgeContext, thread: string, now: number): void {
  if (ctx.transport.sendEphemeral(statusFrame(now, thread, 'working', 'Starting a session for this thread…')))
    noteStatusSent(ctx, thread, 'working')
}

/** Main spoke for `thread` itself (`set_status`): whatever it said stands, so the sweep above forgets the thread. */
export function forgetWorking(ctx: BridgeContext, thread: string): void {
  rows.get(ctx)?.delete(thread)
}
