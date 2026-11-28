// A session that dies after its pointer was typed and before `read_inbound` ends as `parked` and nobody starts it again: an
// unclaimed owner message would wait the whole claim deadline in silence. Once per message the hub writes its wake again, so the
// supervisor resumes the session and types the pointer; a second death, or a session the owner stopped, goes to main at once.
import { type ErrorCodeT, supervisorFresh, type WorkersFileT } from '@talos-app/protocol'
import type { BridgeContext } from '../context.ts'
import { isKeptWake } from '../wake-me/drop.ts'
import { ownersOwn } from '../worker/busy-line.ts'
import type { RouteRow, WorkerStore } from '../worker/store.ts'
import { goneRows } from './reasons.ts'

/** Why a session ended that is no deliberate stop: a crash, a cut turn, or a reason nobody recorded. Only these are woken again. */
const UNASKED = new Set(['crash', 'interrupted', 'unknown'])

/**
 * One look at the unclaimed owner messages. Marks the ones whose session is live or busy now; writes the wake again (`wake`, once
 * per thread per look) for a message whose session was seen live and is now parked or off; and returns the messages main takes at
 * once (the owner stopped the session, or it died a second time), which the caller hands over as any late route.
 * Only on a fresh supervisor file: an old one proves nothing about the session. The re-wake is taken in SQL (`rewakeOnce`), so two
 * ticks, two hubs and a restart in between add no second wake.
 */
export function rewakeDead(
  ctx: BridgeContext,
  store: WorkerStore,
  file: WorkersFileT | null,
  rows: RouteRow[],
  wake: (thread: string) => void,
  reach: (thread: string) => { to: string; reason?: ErrorCodeT },
): [RouteRow, ErrorCodeT][] {
  const toMain: [RouteRow, ErrorCodeT][] = []
  if (!file || !supervisorFresh(file, ctx.clock.now())) return toMain
  const woken = new Set<string>()
  for (const row of rows) {
    if (!ownersOwn(row.notification) || row.notification.meta.kind === 'card_action') continue
    const e = file.threads[row.thread_id]
    if (!e) continue
    const now = ctx.clock.now()
    if (e.state === 'live' || e.state === 'busy') {
      store.noteSeenLive(row.message_id, now)
      continue
    }
    if (e.state !== 'parked' && e.state !== 'off') continue
    // a session the hub would not start now (unavailable, the supervisor's entry set aside): main answers with that reason, no re-wake.
    // A paused governor is not a dead session: the message waits for its deadline, as in goneRows.
    const d = reach(row.thread_id)
    if (d.to === 'fallback') {
      if (d.reason && d.reason !== 'usage_governor') toMain.push([row, d.reason])
      continue
    }
    // stopped by the owner after it was live for this message: not started again, main answers now (a thread the owner stopped
    // BEFORE the message is the ordinary cold start, which is not this)
    if (e.stopped_why === 'owner') {
      if (store.wasSeenLive(row.message_id)) toMain.push([row, 'worker_unavailable'])
      continue
    }
    if (store.diedAgain(row.message_id)) toMain.push([row, 'worker_unavailable'])
    else if ((!e.stopped_why || UNASKED.has(e.stopped_why)) && store.rewakeOnce(row.message_id, now))
      woken.add(row.thread_id)
  }
  for (const t of woken) wake(t)
  return toMain
}

/**
 * What the router's tick asks about waiting messages whose session is gone: the dead-session list (`goneRows`, acting on a stale
 * supervisor heartbeat only when the same one was stale at the poll before) and the re-wake (`rewakeDead`), as one list for main.
 */
export class GoneWatch {
  private staleBeat: string | null = null

  constructor(
    private readonly reach: (thread: string) => { to: string; reason?: ErrorCodeT },
    private readonly wake: (thread: string, reason: 'message') => void,
  ) {}

  rows(ctx: BridgeContext, store: WorkerStore, file: WorkersFileT | null): [RouteRow, ErrorCodeT][] {
    const now = ctx.clock.now()
    const stale = !!file && !supervisorFresh(file, now)
    const seenBefore = stale && this.staleBeat === file?.supervisor.heartbeat_at
    this.staleBeat = stale ? (file?.supervisor.heartbeat_at ?? null) : null
    const waiting = store.allUnclaimed()
    // a wake held for its own session is not a dead session's message: it is kept until the session can read it (wake-me/drop.ts)
    const heldWakes = new Set(waiting.filter((r) => isKeptWake(ctx, r)).map((r) => r.message_id))
    return [
      ...goneRows(file, now, waiting, this.reach, seenBefore),
      ...rewakeDead(ctx, store, file, waiting, (t) => this.wake(t, 'message'), this.reach),
    ].filter(([row]) => !heldWakes.has(row.message_id))
  }
}
