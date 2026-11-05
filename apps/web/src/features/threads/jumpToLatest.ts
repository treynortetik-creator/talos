// Jump-to-latest bookkeeping for the thread timeline (pure, unit-tested).

/** Same threshold the scroll anchor uses: within this many px of the end counts as "at the bottom". */
export const NEAR_BOTTOM_PX = 80

export const isNearBottom = (el: { scrollHeight: number; scrollTop: number; clientHeight: number }): boolean =>
  el.scrollHeight - el.scrollTop - el.clientHeight < NEAR_BOTTOM_PX

type R = {
  key: string
  author?: string | undefined
  via?: string | undefined
  seq?: number | undefined
  at?: number | undefined
}

/** What the timeline had last time it looked: every row key and the highest relay seq among them. */
export type Seen = { keys: ReadonlySet<string>; maxSeq: number; latestAt: number }

export const seenOf = (rows: readonly R[]): Seen => ({
  keys: new Set(rows.map((r) => r.key)),
  maxSeq: rows.reduce((n, r) => Math.max(n, r.seq ?? 0), 0),
  latestAt: rows.reduce((n, r) => Math.max(n, Number.isFinite(r.at) ? (r.at as number) : 0), 0),
})

/**
 * How many rows arrived since `seen`. A row counts when its key is new AND it is not older history (a stored row with a
 * seq at or below what was already known is a prepend from "Load earlier", not news). Rows without a seq yet (a card, a
 * queued local row) count when new. The owner's own sends do not count. `seen` null: nothing known yet, nothing counts.
 */
export function newArrivals(seen: Seen | null, rows: readonly R[]): number {
  if (seen === null) return 0
  let n = 0
  for (const r of rows) {
    if (seen.keys.has(r.key) || r.author === 'owner') continue
    // Older than what is already shown (history): never news, with or without a seq.
    if (r.seq === undefined && Number.isFinite(r.at) && seen.latestAt > 0 && (r.at as number) <= seen.latestAt) continue
    if (r.seq !== undefined) {
      if (seen.maxSeq > 0) {
        if (r.seq <= seen.maxSeq) continue
      } else if (!(Number.isFinite(r.at) && (r.at as number) > seen.latestAt)) {
        // Nothing stored was known (a thread of cards): a seq alone cannot tell history from news, its time can.
        continue
      }
    }
    n++
  }
  return n
}

export const jumpLabel = (count: number): string =>
  count > 0 ? `Jump to latest, ${count} new ${count === 1 ? 'message' : 'messages'}` : 'Jump to latest message'

/** Within this many px of the top, the next page of history loads by itself. */
export const NEAR_TOP_PX = 120

/** A thread with fewer stored rows than this opens by fetching history: a full page means the cache is warm. */
export const SHORT_THREAD_ROWS = 50

/**
 * Where to put scrollTop after older rows were prepended, so the owner stays on the message they were reading.
 * `before` is the scroll geometry from just before the load; `height` is the scroller's scrollHeight now.
 */
export const keepPlace = (before: { height: number; top: number }, height: number): number =>
  before.top + Math.max(0, height - before.height)

/**
 * The row the "New messages" line goes above: the oldest of the `unread` newest rows that did not come from the owner.
 * Stored rows only (a queued local row is not news). Null when nothing is unread or fewer unread rows are loaded than
 * the count says: the line must not point at a message that is not the first unread one.
 */
export function firstUnreadKey(rows: readonly R[], unread: number): string | null {
  if (unread <= 0) return null
  const incoming = rows.filter((r) => r.seq !== undefined && r.author !== 'owner')
  if (incoming.length < unread) return null
  return (incoming[incoming.length - unread] as R).key
}

/**
 * Where the "New messages" line goes, and whether the rows needed to say are all loaded.
 *
 * With the relay's read mark (`readUpto`) the line sits above the first stored row past it that the relay counts as
 * unread (not the owner's own send; a share counts). A count taken from the end is wrong whenever the relay counted a
 * different set than the app shows (a silent reply is stored and shown but never counted). The answer is only certain
 * once a row at or below the mark is loaded, or the history has no more: before that, an earlier counted row may still
 * be on the Mac, so `key` stays null and `needMore` says to keep paging.
 * With no read mark (an older relay) it falls back to counting back `unread` non-owner rows from the end.
 */
export function unreadMarker(
  rows: readonly R[],
  unread: number,
  readUpto: number | undefined,
  hasMore: boolean,
): { key: string | null; needMore: boolean } {
  if (unread <= 0) return { key: null, needMore: false }
  if (readUpto === undefined) {
    const key = firstUnreadKey(rows, unread)
    return { key, needMore: key === null && hasMore }
  }
  const stored = rows.filter((r) => r.seq !== undefined)
  const oldest = stored.reduce((n, r) => Math.min(n, r.seq as number), Number.POSITIVE_INFINITY)
  const certain = !hasMore || oldest <= readUpto
  if (!certain) return { key: null, needMore: true }
  const first = stored.find((r) => (r.seq as number) > readUpto && (r.author !== 'owner' || r.via === 'share'))
  return { key: first?.key ?? null, needMore: false }
}
