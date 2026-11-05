// Quiet-window digest (spec 7.4): events collected during the window go to the Mac as one `hook.digest` (one
// notification) and the phone gets one "Overnight: n items" push. `GET /bridge/digest` serves the same list on demand.
import type { IntegrationIdT, NormalizedEventT } from '@talos-app/protocol'
import { newId } from '@talos-app/protocol'
import { frame, quietNow } from './route.ts'
import { DAY_MS, type EventRow, eventOf, HOUR_MS, type HooksRuntime } from './types.ts'

const MAX_DIGEST_EVENTS = 200
/** Serialized bytes of events in one digest: well under the 256 KiB frame limit, leaving room for the thread counts. */
const DIGEST_EVENT_BYTES = 180 * 1024

const BAND: Record<string, number> = { high: 0, normal: 1, low: 2 }

/**
 * Priority first, never dropping a high-priority item: high, then normal, then low, newest first within a band, up to
 * the frame's 200 cap (one slot is kept for the "+N more" line when anything is left out). Output is chronological.
 */
function pickDigestEvents(rt: HooksRuntime, rows: EventRow[], max: number): NormalizedEventT[] {
  const sizes = rows.map((r) => Buffer.byteLength(JSON.stringify(eventOf(rt, r))) + 1)
  if (rows.length <= max && sizes.reduce((a, b) => a + b, 0) <= DIGEST_EVENT_BYTES)
    return rows.map((r) => eventOf(rt, r))
  const ranked = rows
    .map((r, i) => ({ r, i }))
    .sort((a, b) => (BAND[a.r.priority] ?? 2) - (BAND[b.r.priority] ?? 2) || b.i - a.i)
  // Fill by priority until the count or the byte budget is reached. The budget keeps the whole frame under the Mac's
  // 256 KiB limit; a frame over it is refused unparseable (no id to ack) and would be resent forever.
  let used = 0
  let n = 0
  while (n < ranked.length && n < max - 1) {
    const size = sizes[(ranked[n] as { i: number }).i] as number
    if (used + size > DIGEST_EVENT_BYTES) break
    used += size
    n++
  }
  const take = ranked.slice(0, n)
  const left = ranked.slice(n)
  const chosen = take.sort((a, b) => a.i - b.i).map((x) => eventOf(rt, x.r))
  const first = eventOf(rt, left[0]?.r as EventRow)
  const count = left.length
  const more: NormalizedEventT = {
    id: newId('e'),
    source: first.source,
    connection: first.connection,
    kind: 'generic.event',
    title: `+${count} more low-priority items`,
    summary: `${count} more items arrived during the quiet window and are not listed here. They are in the Inbox.`,
    actor: { name: 'Talos' },
    ts: rt.iso(rt.now()),
    thread: first.thread,
    work: left.some((x) => x.r.work === 1),
    priority: 'low',
    dedup_key: `system:digest_more:${rt.now()}`,
  }
  return [...chosen, more]
}

function unreadableNote(rt: HooksRuntime, bad: EventRow, count: number): NormalizedEventT {
  const items = count === 1 ? '1 item' : `${count} items`
  return {
    id: newId('e'),
    source: bad.integration,
    connection: bad.conn_id,
    kind: 'generic.event',
    title: `${items} could not be read`,
    summary: `${items} from the quiet window could not be read and ${count === 1 ? 'is' : 'are'} not listed here.`,
    actor: { name: 'Talos' },
    ts: rt.iso(rt.now()),
    thread: bad.thread,
    work: false,
    priority: 'low',
    dedup_key: `system:digest_unreadable:${rt.now()}`,
  }
}

export function buildDigestBody(
  rt: HooksRuntime,
  rows: EventRow[],
  window: { start: number; end: number },
): {
  window: { start: string; end: string }
  threads: Array<{ thread_id: string; counts: Partial<Record<IntegrationIdT, number>> }>
  events: NormalizedEventT[]
} {
  // A row that no longer opens is reported and left out; it must not stop the digest the other rows ride in. The digest
  // says how many were left out, in one more event (a slot is kept for it), so the Mac and the owner can tell.
  const total = rows.length
  let firstBad: EventRow | undefined
  rows = rows.filter((r) => {
    try {
      eventOf(rt, r)
      return true
    } catch (err) {
      firstBad ??= r
      rt.services.log.error(
        { event: r.event_id, err: err instanceof Error ? err.name : 'error' },
        'hook event unreadable; left out of the digest',
      )
      return false
    }
  })
  const byThread = new Map<string, Partial<Record<IntegrationIdT, number>>>()
  for (const r of rows) {
    const counts = byThread.get(r.thread) ?? {}
    counts[r.integration] = (counts[r.integration] ?? 0) + 1
    byThread.set(r.thread, counts)
  }
  const unreadable = total - rows.length
  const events = pickDigestEvents(rt, rows, unreadable > 0 ? MAX_DIGEST_EVENTS - 1 : MAX_DIGEST_EVENTS)
  if (firstBad) events.push(unreadableNote(rt, firstBad, unreadable))
  return {
    window: { start: rt.iso(window.start), end: rt.iso(window.end) },
    threads: [...byThread].map(([thread_id, counts]) => ({ thread_id, counts })),
    events,
  }
}

export function eventsSince(rt: HooksRuntime, sinceMs: number): EventRow[] {
  return rt.services.db
    .prepare('select * from hooks_events where created_at >= ? order by created_at, rowid')
    .all(sinceMs) as EventRow[]
}

/**
 * If the quiet window is over and events were collected, send the digest. Returns the number of items sent.
 * A batch keeps its frame id until it is stamped: rows an earlier attempt already tagged go out again as that same
 * frame (the hub knows it, so it is not stored or sent twice), and rows collected since go out as a new one.
 */
export async function flushDigest(rt: HooksRuntime): Promise<number> {
  if (quietNow(rt)) return 0
  const rows = rt.services.db
    .prepare('select * from hooks_events where collected = 1 and digested_at is null order by created_at, rowid')
    .all() as EventRow[]
  const batches = new Map<string | null, EventRow[]>()
  for (const r of rows) {
    const batch = batches.get(r.bridge_frame_id)
    if (batch) batch.push(r)
    else batches.set(r.bridge_frame_id, [r])
  }
  let sent = 0
  let failure: { err: unknown } | undefined
  for (const [tag, batch] of batches) {
    // A batch that fails stays unstamped for the next tick; the batches behind it still go. The first failure surfaces.
    try {
      sent += await sendDigest(rt, batch, tag)
    } catch (err) {
      failure ??= { err }
    }
  }
  if (failure) throw failure.err
  return sent
}

async function sendDigest(rt: HooksRuntime, rows: EventRow[], tag: string | null): Promise<number> {
  const { db, bus, push, env } = rt.services
  const now = rt.now()
  const start = rows[0]?.created_at ?? now
  // Frame id first (an ack may race us), digested_at only AFTER the send: a failed send leaves the rows for the next tick.
  if (!rows.every((r) => r.delivered_at !== null)) {
    // (If the Mac already acked this frame and only the stamp below was lost, there is nothing to send again.)
    const f = frame(rt, 'hook.digest', buildDigestBody(rt, rows, { start, end: now }))
    if (tag) f.id = tag
    else {
      const set = db.prepare('update hooks_events set bridge_frame_id = ? where event_id = ?')
      db.transaction(() => {
        for (const r of rows) set.run(f.id, r.event_id)
      })()
    }
    const passthrough = rows.every((r) => r.passthrough === 1)
    await bus.toBridge(f, {
      durable: true,
      resume: true,
      ttl_s: (passthrough ? HOUR_MS : env.BUFFER_DAYS * DAY_MS) / 1000,
    })
  }
  const mark = db.prepare('update hooks_events set digested_at = ?, sent_at = ? where event_id = ?')
  db.transaction(() => {
    for (const r of rows) mark.run(now, now, r.event_id)
  })()
  // Delivered is stamped when the Mac acks the frame, not when it was written to a socket (review #22).
  await push.notify({ template: 'overnight', count: rows.length })
  return rows.length
}
