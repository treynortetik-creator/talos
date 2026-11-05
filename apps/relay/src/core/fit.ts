// A frame over MAX_FRAME_BYTES is refused by the Mac as unparseable (it has no readable id to ack), so the relay would
// resend it forever. Digests are the one frame whose size depends on stored sender data, so the hub trims them to fit.
import { MAX_FRAME_BYTES, newId } from '@talos-app/protocol'

/** Headroom under the limit for the relay stamp and envelope. */
export const FRAME_BUDGET = MAX_FRAME_BYTES - 16 * 1024

const BAND: Record<string, number> = { high: 0, normal: 1, low: 2 }

type Ev = { priority?: string; source?: string; connection?: string; thread?: string; work?: boolean }

/** Drops events from a `hook.digest` (lowest priority first, oldest first) until it fits, and says how many were left out. */
export function fitDigest(frame: Record<string, unknown>, now: string): Record<string, unknown> {
  const events = frame.events
  if (frame.type !== 'hook.digest' || !Array.isArray(events)) return frame
  const size = (evs: unknown[]) => Buffer.byteLength(JSON.stringify({ ...frame, events: evs }))
  if (size(events) <= FRAME_BUDGET) return frame
  const order = events
    .map((e, i) => ({ e: e as Ev, i, bytes: Buffer.byteLength(JSON.stringify(e)) + 1 }))
    .sort((a, b) => (BAND[b.e.priority ?? 'low'] ?? 2) - (BAND[a.e.priority ?? 'low'] ?? 2) || a.i - b.i)
  const dropped = new Set<number>()
  let total = size(events) + 700 // room for the "+N more" line
  for (const o of order) {
    if (total <= FRAME_BUDGET) break
    dropped.add(o.i)
    total -= o.bytes
  }
  const kept = events.filter((_, i) => !dropped.has(i))
  const first = events[[...dropped][0] as number] as Ev
  const more = {
    id: newId('e'),
    source: first.source,
    connection: first.connection,
    kind: 'generic.event',
    title: `+${dropped.size} more low-priority items`,
    summary: `${dropped.size} more items arrived during the quiet window and are not listed here. They are in the Inbox.`,
    actor: { name: 'Talos' },
    ts: now,
    thread: first.thread,
    work: Boolean(first.work),
    priority: 'low',
    dedup_key: `system:digest_more:${now}`,
  }
  return { ...frame, events: [...kept, more] }
}
