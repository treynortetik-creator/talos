// Linked agents: what this bridge itself recorded about peer messages, in history.sqlite. The loop guard and the chain are read
// from here and nowhere else: a peer's own claims about a conversation count for nothing.
//   peer_messages  every message received (dir 'in') or accepted for sending (dir 'out'): id, peer, label, chain, in_reply_to
//   peer_outbox    the messages still to be delivered, or finished, with the exact body that is signed on every try
import type { Database } from 'bun:sqlite'
import type { PeerLabelT } from '@talos-app/protocol'

const SCHEMA = `
CREATE TABLE IF NOT EXISTS peer_messages (
  id TEXT PRIMARY KEY,
  peer TEXT NOT NULL,
  dir TEXT NOT NULL,
  label TEXT,
  chain INTEGER NOT NULL,
  in_reply_to TEXT,
  at INTEGER NOT NULL,
  emitted INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS peer_messages_day ON peer_messages(peer, dir, at);
CREATE TABLE IF NOT EXISTS peer_outbox (
  id TEXT PRIMARY KEY,
  peer TEXT NOT NULL,
  body TEXT NOT NULL,
  label TEXT,
  created_at INTEGER NOT NULL,
  next_at INTEGER NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  state TEXT NOT NULL DEFAULT 'pending',
  detail TEXT
);
CREATE TABLE IF NOT EXISTS peer_state (
  peer TEXT PRIMARY KEY,
  revoked_at INTEGER
);
CREATE INDEX IF NOT EXISTS peer_outbox_due ON peer_outbox(state, next_at);
`

/** How long a record is kept: a reply to a message older than this is refused as one that was never received. */
export const PEER_RECORD_KEEP_MS = 30 * 24 * 3600_000

export type PeerRecord = {
  id: string
  peer: string
  dir: 'in' | 'out'
  label: PeerLabelT | null
  chain: number
  in_reply_to: string | null
  at: number
  emitted: number
}
export type OutboxState = 'pending' | 'sent' | 'revoked' | 'refused' | 'gave_up'
export type OutboxRow = {
  id: string
  peer: string
  body: string
  label: PeerLabelT | null
  created_at: number
  next_at: number
  attempts: number
  state: OutboxState
  detail: string | null
}

export class PeerLedger {
  constructor(private readonly db: Database) {
    db.exec(SCHEMA)
  }

  get(id: string): PeerRecord | undefined {
    return (this.db.query('SELECT * FROM peer_messages WHERE id = ?').get(id) as PeerRecord | null) ?? undefined
  }

  /** The record of message `id` when it has this direction and peer (a reply may only name a message of that exchange). */
  find(id: string, dir: 'in' | 'out', peer: string): PeerRecord | undefined {
    const r = this.get(id)
    return r && r.dir === dir && r.peer === peer ? r : undefined
  }

  /** Records a message; false when its id is already recorded. */
  record(r: Omit<PeerRecord, 'emitted'>): boolean {
    const res = this.db
      .query(
        'INSERT OR IGNORE INTO peer_messages (id, peer, dir, label, chain, in_reply_to, at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      )
      .run(r.id, r.peer, r.dir, r.label, r.chain, r.in_reply_to, r.at)
    return res.changes > 0
  }

  markEmitted(id: string): void {
    this.db.query('UPDATE peer_messages SET emitted = 1 WHERE id = ?').run(id)
  }

  /** Messages accepted for sending to `peer` since `since` (the start of the UTC day). */
  sentSince(peer: string, since: number): number {
    return (
      this.db
        .query("SELECT COUNT(*) AS n FROM peer_messages WHERE peer = ? AND dir = 'out' AND at >= ?")
        .get(peer, since) as {
        n: number
      }
    ).n
  }

  /** Records the message and queues it in one write. */
  queue(rec: Omit<PeerRecord, 'emitted'>, body: string): void {
    this.db.transaction(() => {
      this.record(rec)
      this.db
        .query('INSERT INTO peer_outbox (id, peer, body, label, created_at, next_at) VALUES (?, ?, ?, ?, ?, ?)')
        .run(rec.id, rec.peer, body, rec.label, rec.at, rec.at)
    })()
  }

  due(now: number): OutboxRow[] {
    return this.db
      .query("SELECT * FROM peer_outbox WHERE state = 'pending' AND next_at <= ? ORDER BY created_at, id")
      .all(now) as OutboxRow[]
  }

  nextDueAt(): number | undefined {
    const r = this.db.query("SELECT MIN(next_at) AS t FROM peer_outbox WHERE state = 'pending'").get() as {
      t: number | null
    }
    return r.t ?? undefined
  }

  pendingFor(peer: string): OutboxRow[] {
    return this.db.query("SELECT * FROM peer_outbox WHERE state = 'pending' AND peer = ?").all(peer) as OutboxRow[]
  }

  outbox(id: string): OutboxRow | undefined {
    return (this.db.query('SELECT * FROM peer_outbox WHERE id = ?').get(id) as OutboxRow | null) ?? undefined
  }

  retryAt(id: string, at: number): void {
    this.db.query('UPDATE peer_outbox SET attempts = attempts + 1, next_at = ? WHERE id = ?').run(at, id)
  }

  finish(id: string, state: Exclude<OutboxState, 'pending'>, detail?: string): void {
    this.db
      .query('UPDATE peer_outbox SET state = ?, detail = ?, attempts = attempts + 1 WHERE id = ?')
      .run(state, detail ?? null, id)
  }

  /** The other install said its inbox is gone: nothing is sent to `peer` until `peer add` links it again. */
  setRevoked(peer: string, at: number): void {
    this.db.query('INSERT OR REPLACE INTO peer_state (peer, revoked_at) VALUES (?, ?)').run(peer, at)
  }

  clearRevoked(peer: string): void {
    this.db.query('DELETE FROM peer_state WHERE peer = ?').run(peer)
  }

  isRevoked(peer: string): boolean {
    return this.db.query('SELECT 1 FROM peer_state WHERE peer = ? AND revoked_at IS NOT NULL').get(peer) !== null
  }

  prune(now: number): void {
    const old = now - PEER_RECORD_KEEP_MS
    this.db.query('DELETE FROM peer_messages WHERE at < ?').run(old)
    this.db.query("DELETE FROM peer_outbox WHERE state != 'pending' AND created_at < ?").run(old)
  }
}
