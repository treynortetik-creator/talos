// Bug reports held for a newer Mac (Delphi 2026-11-15). A `problem.item` waits for a Mac whose hello lists problems/1
// (features.ts problemHeld); a report is never silently lost while the owner's Mac is behind, so one the Mac has not taken
// (outbox delivered = 0) is kept past the relay's buffer, with the media file of its screenshot. The backstop: the newest
// PROBLEM_KEEP_ROWS of them, at most PROBLEM_KEEP_MS old and PROBLEM_KEEP_BYTES in all; past it they go as before, oldest first,
// and the sweep says how many.
import type Database from 'better-sqlite3'
import type { StoredFrame } from './store.ts'

export const PROBLEM_KEEP_MS = 30 * 86_400_000
export const PROBLEM_KEEP_ROWS = 500
/** And at most this many bytes of them, report and screenshot together (a beta relay's volume is small: Delphi 2026-11-15). */
export const PROBLEM_KEEP_BYTES = 250 * 1024 * 1024

/** A bug report's outbox row lives as long as the sweep keeps the report, so a Mac that updates late still gets it. */
export const outboxTtl = (type: string, ttlMs: number): number =>
  type === 'problem.item' ? Math.max(ttlMs, PROBLEM_KEEP_MS) : ttlMs

type Open = (row: { frame_id: string; body: Buffer }) => StoredFrame
type Row = { seq: number; frame_id: string; body: Buffer; created_at: number }

const waitingRows = (db: Database.Database, order: 'e.seq desc' | 'e.created_at'): Row[] =>
  db
    .prepare(
      `select e.seq, e.frame_id, e.body, e.created_at from core_events e join core_outbox o on o.seq = e.seq
       where e.type = 'problem.item' and o.delivered = 0 order by ${order}`,
    )
    .all() as Row[]

/** What the sweep keeps of the held reports, and how many it drops past the backstop. Runs inside the sweep's transaction. */
export function heldProblemsToKeep(
  db: Database.Database,
  open: Open,
  now: number,
  cutoff: number,
): { keepSeqs: number[]; keepMedia: string[]; problemsDropped: number } {
  // a report queued before this rule (its outbox row on the old 7-day life) gets the same 30 days, so its row outlives the
  // buffer with it
  db.prepare(
    "update core_outbox set expires_at = max(expires_at, created_at + ?) where type = 'problem.item' and delivered = 0",
  ).run(PROBLEM_KEEP_MS)
  const waiting = waitingRows(db, 'e.seq desc')
  const keep: Row[] = []
  const keepMedia: string[] = []
  let bytes = 0
  // newest first: the bytes cap drops the oldest
  for (const r of waiting.filter((x) => now - x.created_at < PROBLEM_KEEP_MS).slice(0, PROBLEM_KEEP_ROWS)) {
    let shot: { media_id?: unknown; size?: unknown } | undefined
    try {
      shot = (open(r) as { problem?: { screenshot?: { media_id?: unknown; size?: unknown } } }).problem?.screenshot
    } catch {} // a row that no longer opens keeps its own row, nothing else
    const size = r.body.length + (typeof shot?.size === 'number' ? shot.size : 0)
    if (bytes + size > PROBLEM_KEEP_BYTES) break
    bytes += size
    keep.push(r)
    if (typeof shot?.media_id === 'string') keepMedia.push(shot.media_id)
  }
  const kept = new Set(keep.map((r) => r.seq))
  return {
    keepSeqs: [...kept],
    keepMedia,
    problemsDropped: waiting.filter((r) => r.created_at < cutoff && !kept.has(r.seq)).length,
  }
}

/** Bug reports the Mac has not taken, oldest first, with when each was stored: for the "waiting for a newer Talos" line. */
export function waitingProblems(db: Database.Database, open: Open): Array<{ created_at: number; frame: StoredFrame }> {
  const out: Array<{ created_at: number; frame: StoredFrame }> = []
  for (const r of waitingRows(db, 'e.created_at')) {
    try {
      out.push({ created_at: r.created_at, frame: open(r) })
    } catch {} // a row that no longer opens is not shown to the owner as waiting
  }
  return out
}
