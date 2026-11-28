// What Main has been told, in history.sqlite so it outlives a bridge restart. One row per wake key: the notification as it
// will be sent (so a retry sends the same words) and when it was handed to Main's channel. A row with no `delivered_at` is a
// wake that was decided but not yet delivered. Every move is one conditional statement.
import type { Database } from 'bun:sqlite'
import type { Notification } from '../notify.ts'

export type WakeRow = {
  key: string
  notification: Notification
  created_at: number
  delivered_at: number | null
  tries: number
}

const SCHEMA = `CREATE TABLE IF NOT EXISTS main_wakes (
  key TEXT PRIMARY KEY,
  notification TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  delivered_at INTEGER,
  tries INTEGER NOT NULL DEFAULT 0
);`

type Raw = { key: string; notification: string; created_at: number; delivered_at: number | null; tries: number }
const parse = (r: Raw): WakeRow => ({ ...r, notification: JSON.parse(r.notification) as Notification })

export class MainWakeStore {
  constructor(private readonly db: Database) {
    db.exec(SCHEMA)
  }

  /** True when this key was new (the row is written); false when it already exists. */
  add(key: string, n: Notification, now: number): boolean {
    const r = this.db
      .query('INSERT OR IGNORE INTO main_wakes (key, notification, created_at) VALUES (?, ?, ?)')
      .run(key, JSON.stringify(n), now)
    return r.changes === 1
  }

  get(key: string): WakeRow | undefined {
    const r = this.db.query('SELECT * FROM main_wakes WHERE key = ?').get(key) as Raw | null
    return r ? parse(r) : undefined
  }

  /** Marks delivered; false when it already was (or the row is gone), so only one caller counts the send. */
  markDelivered(key: string, now: number): boolean {
    return (
      this.db.query('UPDATE main_wakes SET delivered_at = ? WHERE key = ? AND delivered_at IS NULL').run(now, key)
        .changes === 1
    )
  }

  bumpTries(key: string): number {
    this.db.query('UPDATE main_wakes SET tries = tries + 1 WHERE key = ? AND delivered_at IS NULL').run(key)
    return (
      (this.db.query('SELECT tries FROM main_wakes WHERE key = ?').get(key) as { tries: number } | null)?.tries ?? 0
    )
  }

  pending(): WakeRow[] {
    return (
      this.db.query('SELECT * FROM main_wakes WHERE delivered_at IS NULL ORDER BY created_at').all() as Raw[]
    ).map(parse)
  }

  remove(key: string): void {
    this.db.query('DELETE FROM main_wakes WHERE key = ?').run(key)
  }

  /** Forgets delivered rows made before `before` (ms). */
  pruneDelivered(before: number): void {
    this.db.query('DELETE FROM main_wakes WHERE delivered_at IS NOT NULL AND created_at < ?').run(before)
  }
}
