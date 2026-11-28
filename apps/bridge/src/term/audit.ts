// The audit row of each terminal view: tier, device, target, open and close times, why it closed, and how many bytes and frames
// went out. NEVER content: nothing of what the pane showed is recorded here or anywhere else on disk (the ring and the
// keyframes live in memory). One row per view, written when it opens and completed when it closes; a row a crash left open is
// closed as 'restart' the next time the Mac's bridge starts, because a restart closes every view.
import type { Database } from 'bun:sqlite'

const RETENTION_MS = 90 * 24 * 3600_000

export type TermAuditRow = {
  term_id: string
  tier: string
  device_id: string
  target: string
  opened_at: number
  closed_at: number | null
  why: string | null
  bytes_out: number
  frames_out: number
}

export class TermAudit {
  constructor(private db: Database) {
    db.exec(`CREATE TABLE IF NOT EXISTS term_audit (
      term_id TEXT PRIMARY KEY,
      tier TEXT NOT NULL,
      device_id TEXT NOT NULL,
      target TEXT NOT NULL,
      opened_at INTEGER NOT NULL,
      closed_at INTEGER,
      why TEXT,
      bytes_out INTEGER NOT NULL DEFAULT 0,
      frames_out INTEGER NOT NULL DEFAULT 0
    )`)
  }

  /** A view that was open when the last bridge stopped hard: closed now, as a restart. Returns how many. */
  closeOrphans(now: number): number {
    return this.db.query("UPDATE term_audit SET closed_at = ?, why = 'restart' WHERE closed_at IS NULL").run(now)
      .changes
  }

  open(row: { term_id: string; tier: string; device_id: string; target: string; opened_at: number }): void {
    this.db.query('DELETE FROM term_audit WHERE opened_at < ?').run(row.opened_at - RETENTION_MS)
    this.db
      .query('INSERT OR IGNORE INTO term_audit (term_id, tier, device_id, target, opened_at) VALUES (?, ?, ?, ?, ?)')
      .run(row.term_id, row.tier, row.device_id, row.target, row.opened_at)
  }

  close(termId: string, at: number, why: string, bytes: number, frames: number): void {
    this.db
      .query(
        'UPDATE term_audit SET closed_at = ?, why = ?, bytes_out = ?, frames_out = ? WHERE term_id = ? AND closed_at IS NULL',
      )
      .run(at, why, bytes, frames, termId)
  }

  /** Every row, oldest first (tests, and a person reading the audit). */
  rows(): TermAuditRow[] {
    return this.db.query('SELECT * FROM term_audit ORDER BY opened_at, term_id').all() as TermAuditRow[]
  }
}
