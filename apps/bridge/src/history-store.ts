// history.sqlite (bun:sqlite, WAL): the Mac's message history, seen ids (survive restarts), the card ledger (4.5), the
// durable outbox and a small kv table. Shared by the live bridge, headless processes and the CLI.
import { Database } from 'bun:sqlite'
import type { MessageT } from '@talos-app/protocol'
import { installSearchIndex } from './search/install.ts'
import { isShareOnly } from './share-only.ts'

// Must outlast the inbound ts window (8 d back, 2 min future skew, see inbound.ts) or a pruned id can be replayed.
/** Bounded growth: delivered history and finished cards age out; pending cards and the unsent outbox are never cut early. */
export const MESSAGE_RETENTION_MS = 90 * 24 * 3600_000
export const CARD_RETENTION_MS = 30 * 24 * 3600_000

/** How far ahead of the Mac's clock a signed frame's own time may be (the phone's clock runs a little fast). */
export const MAX_FUTURE_MS = 2 * 60_000

export const SEEN_RETENTION_MS = 8 * 24 * 3600_000 + 2 * 60_000 + 3600_000

const SCHEMA = `
CREATE TABLE IF NOT EXISTS messages (
  ord INTEGER PRIMARY KEY AUTOINCREMENT,
  id TEXT NOT NULL UNIQUE,
  thread_id TEXT NOT NULL,
  seq INTEGER,
  created_at TEXT NOT NULL,
  author TEXT NOT NULL,
  json TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS messages_thread ON messages(thread_id, ord);
CREATE INDEX IF NOT EXISTS messages_seq ON messages(thread_id, seq);
-- previousOwnerAt: the owner's last row in a thread before a time
CREATE INDEX IF NOT EXISTS messages_author_time ON messages(thread_id, author, created_at);
CREATE TABLE IF NOT EXISTS seen_ids (id TEXT PRIMARY KEY, at INTEGER NOT NULL, outcome TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS cards (
  id TEXT PRIMARY KEY,
  thread_id TEXT NOT NULL,
  binding_json TEXT NOT NULL,
  payload_hash TEXT NOT NULL,
  state TEXT NOT NULL,
  origin TEXT NOT NULL,
  risk TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  resolved_at TEXT,
  resolution_json TEXT,
  actor TEXT NOT NULL DEFAULT 'agent'
);
CREATE TABLE IF NOT EXISTS outbox (
  ord INTEGER PRIMARY KEY AUTOINCREMENT,
  id TEXT NOT NULL UNIQUE,
  type TEXT NOT NULL,
  json TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT NOT NULL);
-- MCP apps (MCP-APPS-SPEC M5.5). No arguments column: they live in the pending file and, when carded, the card ledger.
CREATE TABLE IF NOT EXISTS app_views (
  view_id TEXT PRIMARY KEY,
  thread_id TEXT NOT NULL,
  server TEXT NOT NULL,
  source TEXT NOT NULL,
  tool TEXT NOT NULL,
  resource_uri TEXT NOT NULL,
  approval_key TEXT NOT NULL,
  shown_at TEXT NOT NULL,
  calls_until TEXT NOT NULL,
  state TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS app_views_thread ON app_views(thread_id, state);
CREATE TABLE IF NOT EXISTS app_requests (
  request_id TEXT PRIMARY KEY,
  view_id TEXT NOT NULL,
  method TEXT NOT NULL,
  created_at TEXT NOT NULL,
  state TEXT NOT NULL,
  card_id TEXT,
  tool_use_id TEXT,
  resolved_at TEXT
);
CREATE INDEX IF NOT EXISTS app_requests_view ON app_requests(view_id);
`

/**
 * What a message write did, told to `onWrite` listeners AFTER the statement committed (docs/V2-FEATURES.md V3.1). The
 * search index listens; a listener can never fail or roll back the write. `setSeq` is not forwarded: seq isn't indexed.
 */
export type HistoryWrite =
  | { op: 'upsert'; ord: number; msg: MessageT }
  | { op: 'transcript'; ord: number; msg: MessageT }
  | { op: 'prune'; before_iso: string }
export type HistoryListener = (ev: HistoryWrite) => void

export type HistoryQuery = {
  thread_id: string
  limit: number
  beforeSeq?: number
  beforeTs?: string
  beforeId?: string
}

export class HistoryStore {
  readonly db: Database
  private listeners: HistoryListener[] = []

  constructor(path: string) {
    this.db = new Database(path, { create: true })
    this.db.exec('PRAGMA journal_mode = WAL')
    this.db.exec('PRAGMA busy_timeout = 5000')
    this.db.exec(SCHEMA)
    // outbox rows from before the attempt counter existed
    const cols = this.db.query('PRAGMA table_info(outbox)').all() as Array<{ name: string }>
    if (!cols.some((c) => c.name === 'attempts'))
      this.db.exec('ALTER TABLE outbox ADD COLUMN attempts INTEGER NOT NULL DEFAULT 0')
    // cards from before Schedules: every old row was minted by the agent (docs/SCHEDULES.md S3.4)
    const cardCols = this.db.query('PRAGMA table_info(cards)').all() as Array<{ name: string }>
    if (!cardCols.some((c) => c.name === 'actor'))
      this.db.exec("ALTER TABLE cards ADD COLUMN actor TEXT NOT NULL DEFAULT 'agent'")
  }

  close() {
    this.db.close()
  }

  // ---- post-commit listeners (docs/V2-FEATURES.md V3.1) -------------------------------------------------------

  /** Registers a post-commit listener; returns its remover. Use `openHistory()` to get the search index installed. */
  onWrite(fn: HistoryListener): () => void {
    this.listeners.push(fn)
    return () => {
      this.listeners = this.listeners.filter((x) => x !== fn)
    }
  }

  /** Listener count (tests). */
  writeListeners(): number {
    return this.listeners.length
  }

  /** Called after a write's statement committed. A throwing listener is swallowed: the write already happened. */
  private told(ev: HistoryWrite) {
    for (const fn of this.listeners) {
      try {
        fn(ev)
      } catch {
        // The index keeps its own dirty flag; nothing here may surface to the writer (V3.1 isolation rule).
      }
    }
  }

  private ordOf(id: string): number | undefined {
    const r = this.db.query('SELECT ord FROM messages WHERE id = ?').get(id) as { ord: number } | null
    return r?.ord
  }

  // ---- seen ids ----------------------------------------------------------------------------------------------

  hasSeen(id: string): boolean {
    return this.db.query('SELECT 1 FROM seen_ids WHERE id = ?').get(id) !== null
  }

  /** What was decided about a frame id ('ok', 'rejected:<code>', ...), or null when it was never marked. */
  seenOutcome(id: string): string | null {
    const r = this.db.query('SELECT outcome FROM seen_ids WHERE id = ?').get(id) as { outcome: string } | null
    return r ? r.outcome : null
  }

  markSeen(id: string, at: number, outcome = 'ok') {
    this.db.query('INSERT OR IGNORE INTO seen_ids (id, at, outcome) VALUES (?, ?, ?)').run(id, at, outcome)
  }

  pruneSeen(now: number) {
    this.db.query('DELETE FROM seen_ids WHERE at < ?').run(now - SEEN_RETENTION_MS)
  }

  /** Drops old messages and finished cards (never pending ones). The outbox is not cut here: `flushOutbox` gives up on
   * rows after 24 h and tells the agent. Returns the row counts. */
  pruneOld(now: number, opts: { historyDays?: number } = {}): { messages: number; cards: number } {
    const iso = (ms: number) => new Date(now - ms).toISOString()
    const del = (sql: string, ...a: Array<string | number>) => this.db.query(sql).run(...a).changes
    // TALOS_APP_HISTORY_DAYS (docs/V2-FEATURES.md V3.1): default 90 days; 0 keeps message text forever
    const days = opts.historyDays ?? MESSAGE_RETENTION_MS / (24 * 3600_000)
    const before = iso(days * 24 * 3600_000)
    const out = {
      messages: days === 0 ? 0 : del('DELETE FROM messages WHERE created_at < ?', before),
      cards: del("DELETE FROM cards WHERE state != 'pending' AND created_at < ?", iso(CARD_RETENTION_MS)),
    }
    if (out.messages > 0 && this.listeners.length) this.told({ op: 'prune', before_iso: before })
    return out
  }

  // ---- messages ----------------------------------------------------------------------------------------------

  addMessage(m: MessageT) {
    this.db
      .query(
        'INSERT INTO messages (id, thread_id, seq, created_at, author, json) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET seq = COALESCE(excluded.seq, messages.seq), json = excluded.json',
      )
      .run(m.id, m.thread_id, m.seq ?? null, m.created_at, m.author, JSON.stringify(m))
    if (!this.listeners.length) return
    const ord = this.ordOf(m.id)
    if (ord !== undefined) this.told({ op: 'upsert', ord, msg: m })
  }

  /** One stored message by id, or undefined (never stored, or aged out). */
  getMessage(id: string): MessageT | undefined {
    const row = this.db.query('SELECT json FROM messages WHERE id = ?').get(id) as { json: string } | null
    if (!row) return undefined
    try {
      return JSON.parse(row.json) as MessageT
    } catch {
      return undefined
    }
  }

  /** Removes one message (a row whose frame was never accepted). Listeners hear it as a prune: they drop what no longer exists. */
  deleteMessage(id: string) {
    const r = this.db.query('DELETE FROM messages WHERE id = ?').run(id)
    if (r.changes > 0 && this.listeners.length) this.told({ op: 'prune', before_iso: new Date(0).toISOString() })
  }

  setSeq(id: string, seq: number) {
    this.db.query('UPDATE messages SET seq = ? WHERE id = ?').run(seq, id)
  }

  updateTranscript(id: string, transcript: NonNullable<MessageT['transcript']>) {
    const row = this.db.query('SELECT json FROM messages WHERE id = ?').get(id) as { json: string } | null
    if (!row) return
    const msg = { ...JSON.parse(row.json), transcript } as MessageT
    this.db.query('UPDATE messages SET json = ? WHERE id = ?').run(JSON.stringify(msg), id)
    if (!this.listeners.length) return
    const ord = this.ordOf(id)
    if (ord !== undefined) this.told({ op: 'transcript', ord, msg })
  }

  /**
   * When the owner last wrote in a thread before `before` (not counting `exceptId`), or undefined for the first message.
   * A share (via='share', or shared material with no typed words) is not the owner's words and is skipped, the same rule as
   * ownerAskedIn (share-only.ts).
   */
  previousOwnerAt(threadId: string, before: string, exceptId?: string): string | undefined {
    const rows = this.db
      .query(
        "SELECT created_at, json FROM messages WHERE thread_id = ? AND author = 'owner' AND created_at < ? AND id != ? ORDER BY created_at DESC",
      )
      .iterate(threadId, before, exceptId ?? '') as IterableIterator<{ created_at: string; json: string }>
    for (const r of rows) {
      try {
        if (isShareOnly(JSON.parse(r.json) as MessageT)) continue
      } catch {
        continue // a row that does not parse is not evidence of the owner's words
      }
      return r.created_at
    }
    return undefined
  }

  /** The owner's rows (any thread) created at or after `iso`, newest first, at most `limit`. */
  ownerRowsSince(iso: string, limit: number): MessageT[] {
    const rows = this.db
      .query("SELECT json FROM messages WHERE author = 'owner' AND created_at >= ? ORDER BY ord DESC LIMIT ?")
      .all(iso, limit) as Array<{ json: string }>
    return rows.map((r) => JSON.parse(r.json) as MessageT)
  }

  /** Newest `limit` messages matching the filter, oldest first, and whether older ones remain. */
  page(q: HistoryQuery): { messages: MessageT[]; hasMore: boolean } {
    const where = ['thread_id = ?']
    const args: Array<string | number> = [q.thread_id]
    if (q.beforeSeq !== undefined) {
      where.push('seq IS NOT NULL AND seq < ?')
      args.push(q.beforeSeq)
    }
    if (q.beforeTs !== undefined) {
      where.push('created_at < ?')
      args.push(q.beforeTs)
    }
    if (q.beforeId !== undefined) {
      where.push('ord < (SELECT ord FROM messages WHERE id = ?)')
      args.push(q.beforeId)
    }
    const order = q.beforeSeq !== undefined ? 'seq DESC, ord DESC' : 'ord DESC'
    const rows = this.db
      // A seq cursor orders by seq (then ord): messages_seq(thread_id, seq) serves that scan, where ORDER BY ord had to
      // sort every row below the cursor in a temp b-tree.
      .query(`SELECT json, seq FROM messages WHERE ${where.join(' AND ')} ORDER BY ${order} LIMIT ?`)
      .all(...args, q.limit + 1) as Array<{ json: string; seq: number | null }>
    const hasMore = rows.length > q.limit
    const messages = rows
      .slice(0, q.limit)
      .reverse()
      .map((r) => {
        const m = JSON.parse(r.json) as MessageT
        if (r.seq !== null) m.seq = r.seq
        return m
      })
    return { messages, hasMore }
  }

  // ---- outbox ------------------------------------------------------------------------------------------------

  outboxAdd(id: string, type: string, json: string, at: number) {
    this.db
      .query('INSERT OR IGNORE INTO outbox (id, type, json, created_at) VALUES (?, ?, ?, ?)')
      .run(id, type, json, at)
  }
  outboxGet(id: string): { id: string; type: string; json: string } | undefined {
    return (
      (this.db.query('SELECT id, type, json FROM outbox WHERE id = ?').get(id) as {
        id: string
        type: string
        json: string
      } | null) ?? undefined
    )
  }
  outboxDelete(id: string) {
    this.db.query('DELETE FROM outbox WHERE id = ?').run(id)
  }
  outboxAttempt(id: string) {
    this.db.query('UPDATE outbox SET attempts = attempts + 1 WHERE id = ?').run(id)
  }
  outboxList(): Array<{ id: string; type: string; json: string; attempts: number; created_at: number }> {
    return this.db.query('SELECT id, type, json, attempts, created_at FROM outbox ORDER BY ord').all() as Array<{
      id: string
      type: string
      json: string
      attempts: number
      created_at: number
    }>
  }
  outboxCount(): number {
    return (this.db.query('SELECT COUNT(*) AS n FROM outbox').get() as { n: number }).n
  }

  // ---- kv ----------------------------------------------------------------------------------------------------

  kvGet(key: string): string | undefined {
    const r = this.db.query('SELECT value FROM kv WHERE key = ?').get(key) as { value: string } | null
    return r?.value
  }
  kvDelete(key: string) {
    this.db.query('DELETE FROM kv WHERE key = ?').run(key)
  }
  kvSet(key: string, value: string) {
    this.db
      .query('INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
      .run(key, value)
  }
}

/**
 * The ONE way to open history.sqlite (docs/V2-FEATURES.md V3.1): the live bridge, headless processes and the CLI all
 * call it, so no opener can forget the search index. `install` is a test seam.
 */
export function openHistory(path: string, install: (s: HistoryStore) => void = installSearchIndex): HistoryStore {
  const store = new HistoryStore(path)
  try {
    install(store)
  } catch {
    // An index that cannot install leaves history fully working (search answers search_unavailable).
  }
  return store
}
