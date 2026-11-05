// Option C tables in history.sqlite (docs/OPTION-C.md). The live bridge (the hub) and every worker-mode process share
// the file, so the exactly-once rules live in SQL: a message is claimed by whoever inserts its `inbound_claims` row
// first, the worker (`read_inbound`) or main (the hub's deadline). Nothing here is ever copied to the relay.
import type { Database } from 'bun:sqlite'
import type { Notification } from '../notify.ts'
import { leadAnsweredSince } from './handoff.ts'

// Tables the Telegram mirror used; databases written before its removal still hold them.
const MIGRATIONS = `
DROP TABLE IF EXISTS mirror_pending;
DROP TABLE IF EXISTS mirror_sent;
`

const SCHEMA = `
CREATE TABLE IF NOT EXISTS worker_routes (
  message_id TEXT PRIMARY KEY,
  thread_id TEXT NOT NULL,
  notification_json TEXT NOT NULL,
  woke_at INTEGER NOT NULL,
  deadline_at INTEGER NOT NULL,
  cold INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS worker_routes_thread ON worker_routes(thread_id, woke_at);
CREATE TABLE IF NOT EXISTS inbound_claims (
  message_id TEXT PRIMARY KEY,
  claimed_by TEXT NOT NULL,
  at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS claim_settled (
  message_id TEXT PRIMARY KEY,
  at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS card_raisers (
  card_id TEXT PRIMARY KEY,
  thread_id TEXT NOT NULL,
  at INTEGER NOT NULL
);
`

/** `main`, or `worker:<thread_id>`. */
export type Claimer = 'main' | `worker:${string}`

/** A message a worker took with `read_inbound` and nobody has yet seen answered, or reported unanswered. */
export type OpenClaim = { message_id: string; thread_id: string; at: number; kind: string }

export type RouteRow = {
  message_id: string
  thread_id: string
  notification: Notification
  woke_at: number
  deadline_at: number
  cold: boolean
}

/** Rows older than this are pruned (claimed or not: the deadline is minutes, not days). */
const ROUTE_RETENTION_MS = 7 * 24 * 3600_000

export class WorkerStore {
  constructor(private readonly db: Database) {
    db.exec(SCHEMA)
    db.exec(MIGRATIONS)
  }

  // ---- routes and claims -----------------------------------------------------------------------------------------

  /** False when the message was routed before (the row is never replaced). */
  addRoute(r: RouteRow): boolean {
    const res = this.db
      .query(
        `INSERT OR IGNORE INTO worker_routes(message_id, thread_id, notification_json, woke_at, deadline_at, cold)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(r.message_id, r.thread_id, JSON.stringify(r.notification), r.woke_at, r.deadline_at, r.cold ? 1 : 0)
    return res.changes === 1
  }

  /** Atomically claims a message. True only for the first claimer. */
  claim(messageId: string, by: Claimer, now: number): boolean {
    const res = this.db
      .query('INSERT OR IGNORE INTO inbound_claims(message_id, claimed_by, at) VALUES (?, ?, ?)')
      .run(messageId, by, now)
    return res.changes === 1
  }

  claimedBy(messageId: string): Claimer | undefined {
    const r = this.db.query('SELECT claimed_by FROM inbound_claims WHERE message_id = ?').get(messageId) as {
      claimed_by: Claimer
    } | null
    return r?.claimed_by
  }

  /** Routed messages of a thread nobody claimed yet, oldest first. */
  unclaimed(threadId: string): RouteRow[] {
    const rows = this.db
      .query(
        `SELECT r.* FROM worker_routes r LEFT JOIN inbound_claims c ON c.message_id = r.message_id
         WHERE r.thread_id = ? AND c.message_id IS NULL ORDER BY r.woke_at, r.message_id`,
      )
      .all(threadId) as Array<Record<string, unknown>>
    return rows.map(toRoute)
  }

  /** Every unclaimed route (the hub re-arms their deadlines after a restart). */
  allUnclaimed(): RouteRow[] {
    const rows = this.db
      .query(
        `SELECT r.* FROM worker_routes r LEFT JOIN inbound_claims c ON c.message_id = r.message_id
         WHERE c.message_id IS NULL ORDER BY r.woke_at`,
      )
      .all() as Array<Record<string, unknown>>
    return rows.map(toRoute)
  }

  /** Routed messages of a thread that main claimed since `since` (the worker hears "already handled by main"). */
  handledByMainSince(threadId: string, since: number): string[] {
    const rows = this.db
      .query(
        `SELECT r.message_id FROM worker_routes r JOIN inbound_claims c ON c.message_id = r.message_id
         WHERE r.thread_id = ? AND c.claimed_by = 'main' AND c.at > ? ORDER BY c.at`,
      )
      .all(threadId, since) as Array<{ message_id: string }>
    return rows.map((r) => r.message_id)
  }

  /** Worker claims not settled yet, oldest first. */
  openClaims(): OpenClaim[] {
    const rows = this.db
      .query(
        `SELECT c.message_id, c.at, r.thread_id, r.notification_json FROM inbound_claims c
         JOIN worker_routes r ON r.message_id = c.message_id
         LEFT JOIN claim_settled s ON s.message_id = c.message_id
         WHERE c.claimed_by LIKE 'worker:%' AND s.message_id IS NULL ORDER BY c.at`,
      )
      .all() as Array<{ message_id: string; at: number; thread_id: string; notification_json: string }>
    return rows.map((r) => ({
      message_id: r.message_id,
      thread_id: r.thread_id,
      at: r.at,
      kind: (JSON.parse(r.notification_json) as Notification).meta.kind ?? '',
    }))
  }

  /** Did the thread's agent say anything (a message, a card, or a hand-off answer) at or after `at`? */
  answeredSince(threadId: string, at: number): boolean {
    const message = this.db
      .query(`SELECT 1 FROM messages WHERE thread_id = ? AND author = 'agent' AND created_at >= ? LIMIT 1`)
      .get(threadId, new Date(at).toISOString())
    if (message) return true
    if (this.db.query('SELECT 1 FROM card_raisers WHERE thread_id = ? AND at >= ? LIMIT 1').get(threadId, at))
      return true
    // A RESULT or BLOCK to main is the lead's answer to a hand-off TASK, though it is posted as a system row
    return leadAnsweredSince(this.db, threadId, at)
  }

  settleClaims(messageIds: readonly string[], now: number): void {
    const add = this.db.query('INSERT OR IGNORE INTO claim_settled(message_id, at) VALUES (?, ?)')
    for (const id of messageIds) add.run(id, now)
  }

  route(messageId: string): RouteRow | undefined {
    const r = this.db.query('SELECT * FROM worker_routes WHERE message_id = ?').get(messageId) as Record<
      string,
      unknown
    > | null
    return r ? toRoute(r) : undefined
  }

  // ---- card raisers ----------------------------------------------------------------------------------------------

  /** First writer wins: a card id can never change hands. False when the id already has a raiser. */
  setCardRaiser(cardId: string, threadId: string, now: number): boolean {
    const res = this.db
      .query('INSERT OR IGNORE INTO card_raisers(card_id, thread_id, at) VALUES (?, ?, ?)')
      .run(cardId, threadId, now)
    return res.changes === 1
  }

  /** The thread whose worker raised the card, or undefined when main did. */
  cardRaiser(cardId: string): string | undefined {
    const r = this.db.query('SELECT thread_id FROM card_raisers WHERE card_id = ?').get(cardId) as {
      thread_id: string
    } | null
    return r?.thread_id
  }

  prune(now: number): void {
    const cut = now - ROUTE_RETENTION_MS
    this.db.query('DELETE FROM worker_routes WHERE woke_at < ?').run(cut)
    this.db.query('DELETE FROM inbound_claims WHERE at < ?').run(cut)
    this.db.query('DELETE FROM claim_settled WHERE at < ?').run(cut)
    this.db.query('DELETE FROM card_raisers WHERE at < ?').run(cut)
  }
}

function toRoute(r: Record<string, unknown>): RouteRow {
  return {
    message_id: String(r.message_id),
    thread_id: String(r.thread_id),
    notification: JSON.parse(String(r.notification_json)) as Notification,
    woke_at: Number(r.woke_at),
    deadline_at: Number(r.deadline_at),
    cold: Number(r.cold) === 1,
  }
}
