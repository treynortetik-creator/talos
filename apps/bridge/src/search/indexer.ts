// The post-commit indexer (docs/V2-FEATURES.md V3.1 isolation rules). It listens to HistoryStore.onWrite, so every write
// has ALREADY committed when it runs. It applies each change in its own transaction inside try/catch; on any error that
// transaction rolls back alone and `search_dirty=1` is set (in its own try), so a message write can never fail because
// of search. A reconcile pass (live bridge, 30 s) catches whatever the listener missed.
import type { Database } from 'bun:sqlite'
import type { MessageT } from '@talos-app/protocol'
import type { HistoryStore, HistoryWrite } from '../history-store.ts'
import { columnsOf } from './columns.ts'
import { isTextAttachment } from './files.ts'
import { ensureSchema, KV_DIRTY, KV_HWM, KV_WEEK } from './schema.ts'

const KV_FILES_HWM = 'search_files_hwm'

export const RECONCILE_BATCH = 500

export type IndexLog = { warn(msg: string, f?: Record<string, unknown>): void }
const noLog: IndexLog = { warn() {} }

export class SearchIndexer {
  readonly db: Database
  constructor(
    private readonly store: HistoryStore,
    private readonly log: IndexLog = noLog,
  ) {
    this.db = store.db
  }

  /** The `onWrite` listener. Never throws. */
  readonly listen = (ev: HistoryWrite): void => {
    try {
      if (ev.op === 'prune') {
        this.afterPrune()
        return
      }
      try {
        this.checkShape(ev.msg)
      } catch {
        this.skipped(ev.ord)
        return
      }
      this.upsert(ev.ord, ev.msg, true)
    } catch (e) {
      this.markDirty(e)
    }
  }

  // ---- state in the kv table (each call guarded: the kv write must not be the thing that throws) --------------------

  hwm(): number {
    return Number(this.store.kvGet(KV_HWM) ?? 0) || 0
  }
  dirty(): '' | '1' | '2' {
    const v = this.store.kvGet(KV_DIRTY)
    return v === '1' || v === '2' ? v : ''
  }
  markDirty(cause?: unknown) {
    try {
      this.store.kvSet(KV_DIRTY, '1')
    } catch {
      // the store is the thing that is broken; the weekly rebuild and the high-water mark still cover it
    }
    try {
      this.log.warn('search index write failed; rebuild queued', {
        error: cause ? (cause as Error).message : undefined,
      })
    } catch {
      // logging must not throw either
    }
  }

  /** Rows in `messages` the index has not reached (the "indexing" state of the results). */
  behind(): number {
    const r = this.db.query('SELECT COUNT(*) AS n FROM messages WHERE ord > ?').get(this.hwm()) as { n: number }
    return r.n
  }

  // ---- writes ----------------------------------------------------------------------------------------------------

  /** Delete the rowid, then insert, in one transaction. Keeps the `files` column the file indexer filled. */
  upsert(ord: number, msg: MessageT, advance: boolean) {
    const c = columnsOf(msg)
    this.db.transaction(() => {
      const old = this.db.query('SELECT files FROM msg_fts WHERE rowid = ?').get(ord) as { files: string } | null
      const files = old?.files ? this.keptFiles(ord, msg, old.files) : ''
      this.db.query('DELETE FROM msg_fts WHERE rowid = ?').run(ord)
      if (c.text || c.transcript || c.names || c.card || files)
        this.db
          .query('INSERT INTO msg_fts (rowid, text, transcript, names, files, card) VALUES (?, ?, ?, ?, ?, ?)')
          .run(ord, c.text, c.transcript, c.names, files, c.card)
    })()
    if (advance) this.advanceTo(ord)
  }

  /**
   * The `files` column carried across an edit. When the edit dropped a text attachment whose contents are in it, the old
   * text cannot be told apart per file, so it is cleared and the surviving files are queued to be read again.
   */
  private keptFiles(ord: number, msg: MessageT, files: string): string {
    const cur = new Set((msg.attachments ?? []).filter(isTextAttachment).map((a) => a.media_id))
    const known = this.db.query('SELECT media_id FROM fts_files WHERE ord = ?').all(ord) as Array<{ media_id: string }>
    if (known.every((k) => cur.has(k.media_id))) return files
    for (const k of known) {
      if (cur.has(k.media_id))
        this.db.query("UPDATE fts_files SET state = 'pending' WHERE media_id = ?").run(k.media_id)
      else this.db.query('DELETE FROM fts_files WHERE media_id = ?').run(k.media_id)
    }
    return ''
  }

  /**
   * Parses a stored row. One that is unreadable JSON, or parses into a shape the indexer cannot use (`attachments: [null]`),
   * is skipped and logged by row number (never text), so one bad row cannot keep the index dropping itself.
   */
  private parse(r: { ord: number; json: string }): MessageT | null {
    try {
      const m = JSON.parse(r.json) as MessageT
      this.checkShape(m)
      return m
    } catch {
      this.skipped(r.ord)
      return null
    }
  }

  /** Throws when `columnsOf` / the file bookkeeping would. */
  private checkShape(m: MessageT) {
    if (!m || typeof m !== 'object' || typeof m.id !== 'string') throw new TypeError('not a message')
    columnsOf(m)
    for (const a of m.attachments ?? []) isTextAttachment(a)
  }

  private skipped(ord: number) {
    try {
      this.log.warn('search index skipped an unreadable row', { ord })
    } catch {
      // logging must not throw
    }
  }

  /**
   * Moves the high-water mark to `ord` only when no row lies between it and `ord`: a row committed but never indexed
   * (a crash between commit and index) must stay above the mark so reconcile finds it. The read, the checks and the write
   * all run in ONE write transaction (BEGIN IMMEDIATE), and the move is skipped while a rebuild is queued or running
   * (`search_dirty` set). A reindex in another process that wiped the table and rewound the mark wins; this listener
   * never writes a stale mark back over it (the rebuild's own passes index this row).
   */
  private advanceTo(ord: number) {
    try {
      this.db
        .transaction(() => {
          if (this.dirty() !== '') return
          const hwm = this.hwm()
          if (ord <= hwm) return
          const gap = this.db.query('SELECT 1 FROM messages WHERE ord > ? AND ord < ? LIMIT 1').get(hwm, ord)
          if (gap) return
          this.store.kvSet(KV_HWM, String(ord))
        })
        .immediate()
    } catch {
      // reconcile will redo it
    }
  }

  private afterPrune() {
    this.db.transaction(() => {
      this.db.exec('DELETE FROM msg_fts WHERE rowid NOT IN (SELECT ord FROM messages)')
      this.db.exec('DELETE FROM fts_files WHERE ord NOT IN (SELECT ord FROM messages)')
    })()
  }

  // ---- reconcile (live bridge tick) ------------------------------------------------------------------------------

  /**
   * One pass: index rows above the high-water mark (500 per pass); rebuild when dirty; a weekly rebuild (Sunday 03:00
   * local). Returns true while there is more to do (the caller ticks again soon).
   */
  reconcile(now: Date = new Date()): boolean {
    try {
      this.maybeWeekly(now)
      // 1. A cheap look with no lock: nothing to do means no write lock taken every 30 s.
      const d0 = this.dirty()
      const h0 = this.hwm()
      const waiting = this.nextRows(h0, 1)
      if (d0 === '' && waiting.length === 0) return false
      // 2. The wipe, the rows and the mark all happen in ONE write transaction (BEGIN IMMEDIATE), with the state read again
      //    inside it. A second process (the CLI's reindex, another bridge) that moved the mark or wiped the table since
      //    step 1 makes this pass back off and run again; nobody can save a stale mark over a newer wipe.
      return this.db
        .transaction((): boolean => {
          if (this.dirty() !== d0 || this.hwm() !== h0) return true // state moved under us: look again
          if (d0 === '1') this.startRebuild()
          const rows = this.nextRows(this.hwm(), RECONCILE_BATCH)
          for (const r of rows) {
            const m = this.parse(r)
            if (m) this.upsert(r.ord, m, false)
          }
          if (rows.length) this.store.kvSet(KV_HWM, String((rows[rows.length - 1] as { ord: number }).ord))
          if (rows.length === RECONCILE_BATCH) return true
          if (this.dirty() === '2') this.store.kvDelete(KV_DIRTY) // the rebuild caught up
          return false
        })
        .immediate()
    } catch (e) {
      this.markDirty(e)
      return false
    }
  }

  private nextRows(after: number, limit: number): Array<{ ord: number; json: string }> {
    return this.db
      .query('SELECT ord, json FROM messages WHERE ord > ? ORDER BY ord LIMIT ?')
      .all(after, limit) as Array<{ ord: number; json: string }>
  }

  private maybeWeekly(now: Date) {
    if (now.getDay() !== 0 || now.getHours() !== 3) return
    const key = `${now.getFullYear()}-${now.getMonth() + 1}-${now.getDate()}`
    if (this.store.kvGet(KV_WEEK) === key) return
    this.store.kvSet(KV_WEEK, key)
    this.store.kvSet(KV_DIRTY, '1')
  }

  /** Drops the table, recreates it and rewinds the mark; the following passes refill it 500 rows at a time. */
  private startRebuild() {
    this.db.transaction(() => {
      this.db.exec('DROP TABLE IF EXISTS msg_fts')
      ensureSchema(this.db)
      this.db.exec('DELETE FROM fts_files')
    })()
    this.store.kvDelete(KV_FILES_HWM)
    this.store.kvSet(KV_HWM, '0')
    this.store.kvSet(KV_DIRTY, '2')
  }

  /**
   * `talos-app search reindex`: marks the index dirty and runs the same 500-row passes the live bridge runs, with a pause
   * between them, so a live write waits at most one short pass (never a long lock, never `database is locked`).
   * Returns the number of messages in the store.
   */
  async rebuildAll(pause: () => Promise<void> = () => new Promise((r) => setTimeout(r, 2))): Promise<number> {
    this.store.kvSet(KV_DIRTY, '1')
    while (this.reconcile()) await pause()
    // a rebuild another process started mid-way is finished by the same passes
    while (this.dirty() !== '' && this.behind() > 0) {
      await pause()
      if (!this.reconcile()) break
    }
    return (this.db.query('SELECT COUNT(*) AS n FROM messages').get() as { n: number }).n
  }
}
