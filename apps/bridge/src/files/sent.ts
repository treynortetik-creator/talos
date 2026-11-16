// files.sent (frames-files-sent.ts): the files sent in Talos, by the owner or an agent, newest first, from history.sqlite.
// Every attachment of every message in a thread the Mac lists (archived and sub-threads included) counts; a message whose
// thread is no longer listed (deleted, or an id a peer made up) adds nothing. Voice notes and spoken replies are messages,
// not files, as in search's "has a file".
//
// Paging is by position, never offset: (created_at, message id, attachment index), newest first, in an opaque cursor. The
// owner's name filter never reaches SQL: it is matched on each row in code (Unicode-folded), like the type chip (sentFileType,
// by name and MIME type), so % and _ are just characters. Rows are read in batches and a page is cut at a hard cap of rows
// scanned: a page can come back short with a cursor, and the app asks for the next one.
import type { Database } from 'bun:sqlite'
import { AttachmentRef, FILES_SENT_PAGE_MAX, type FrameOf, type SentFileT, sentFileType } from '@talos-app/protocol'
import type { BridgeContext } from '../context.ts'
import type { HistoryStore } from '../history-store.ts'
import { ReadError } from '../v2-seams.ts'

const DAY_MS = 86_400_000

/** The most messages with files one page may read before it answers (with a cursor to go on). */
export const FILES_SENT_SCAN_MAX = 5000

type Body = Omit<FrameOf<'files.sent_list'>, 'v' | 'id' | 'ts' | 'type' | 'relay' | 'request_id'>
type Pos = { at: string; id: string; i: number }
type Row = { id: string; thread_id: string; author: string; created_at: string; json: string }

export type FilesSentDeps = {
  db: Database
  /** Every thread the Mac lists now, archived and sub-threads included. */
  threads: () => string[]
  /** The Mac removed this file's bytes (Settings, Storage). */
  removed: (mediaId: string) => boolean
  /** How many days the Mac keeps message history (0 = for good). */
  historyDays: () => number
}

/** A name as the filter compares it: one Unicode form, any letter case. */
const fold = (s: string) => s.normalize('NFKC').toLowerCase()

const encode = (p: Pos) => Buffer.from(JSON.stringify(p)).toString('base64url')

/** A cursor this service made: anything else is refused, never guessed at. */
export function decodeCursor(c: string): Pos {
  try {
    const v = JSON.parse(Buffer.from(c, 'base64url').toString('utf8')) as Record<string, unknown>
    if (
      v &&
      typeof v.at === 'string' &&
      v.at.length <= 40 &&
      typeof v.id === 'string' &&
      v.id.length <= 64 &&
      Number.isInteger(v.i) &&
      (v.i as number) >= 0 &&
      (v.i as number) < 64 &&
      Object.keys(v).length === 3
    )
      return { at: v.at, id: v.id, i: v.i as number }
  } catch {}
  throw new ReadError('bad_frame', 'That page of files is no longer valid. Open Files again.')
}

export class FilesSentService {
  readonly available = true
  constructor(private readonly d: FilesSentDeps) {}

  list(f: FrameOf<'files.sent'>): Body {
    const { filters } = f
    const limit = Math.min(f.limit, FILES_SENT_PAGE_MAX)
    const listed = new Set(this.d.threads())
    // narrowed like search: only threads the Mac lists, then only the asked ones
    const threads = filters.thread_ids.length ? filters.thread_ids.filter((t) => listed.has(t)) : [...listed]
    const days = this.d.historyDays()
    if (threads.length === 0) return { files: [], next_cursor: null, days }

    const where: string[] = [
      `m.thread_id IN (${threads.map(() => '?').join(',')})`,
      // a cheap look at the text before any parse: a message with no file is passed over in SQLite
      `instr(m.json, '"media_id"') > 0`,
    ]
    const args: (string | number)[] = [...threads]
    if (filters.from === 'owner') where.push(`m.author = 'owner'`)
    if (filters.from === 'agent') where.push(`m.author != 'owner'`)
    // as times, not text: a filter may carry an offset or no milliseconds
    if (filters.after) {
      // a text bound a day wider than the exact one lets the index stop the walk; the exact test is on the time
      where.push('m.created_at >= ?', 'julianday(m.created_at) >= julianday(?)')
      args.push(new Date(Date.parse(filters.after) - DAY_MS).toISOString(), filters.after)
    }
    if (filters.before) {
      where.push('julianday(m.created_at) < julianday(?)')
      args.push(filters.before)
    }
    const pos0: Pos | null = f.cursor ? decodeCursor(f.cursor) : null
    if (pos0) {
      // the cursor's own message stays in: its files before the cursor's index are still to come
      where.push('(m.created_at < ? OR (m.created_at = ? AND m.id <= ?))')
      args.push(pos0.at, pos0.at, pos0.id)
    }
    // matched here, not in SQL: SQLite's lower() folds ASCII only, so "émile" would miss "Émile.pdf"
    const name = fold(filters.name.trim())
    // one statement per page, read in the index's order (messages_time), stopped as soon as the page is full
    // a statement of its own, finalized below: Bun's cached query() left mid-step by the early stop answers the next page
    // with "bad parameter or other API misuse" (macOS system SQLite, Bun 1.3.11)
    const stmt = this.d.db.prepare<Row, (string | number)[]>(
      `SELECT m.id AS id, m.thread_id AS thread_id, m.author AS author, m.created_at AS created_at, m.json AS json
         FROM messages m INDEXED BY messages_time
        WHERE ${where.join(' AND ')}
        ORDER BY m.created_at DESC, m.id DESC`,
    )
    const rows = stmt.iterate(...args)

    const files: SentFileT[] = []
    let pos: Pos | null = pos0
    let scanned = 0
    let more = false
    try {
      outer: for (const r of rows) {
        if (++scanned > FILES_SENT_SCAN_MAX) {
          more = true
          break
        }
        const atts = attachmentsOf(r.json)
        // newest first within a message too: its last file first
        for (let i = atts.length - 1; i >= 0; i--) {
          if (pos0 && r.created_at === pos0.at && r.id === pos0.id && i >= pos0.i) continue
          pos = { at: r.created_at, id: r.id, i }
          const file = fileOf(atts[i])
          if (!file) continue
          if (filters.type !== 'all' && sentFileType(file) !== filters.type) continue
          if (name && !fold(file.name).includes(name)) continue
          files.push({
            message_id: r.id,
            thread_id: r.thread_id,
            author: r.author as SentFileT['author'],
            created_at: r.created_at,
            index: i,
            file,
            removed: this.d.removed(file.media_id),
          })
          if (files.length === limit) {
            more = true
            break outer
          }
        }
        pos = { at: r.created_at, id: r.id, i: 0 } // the whole message is behind us
      }
    } finally {
      stmt.finalize() // never left mid-step for the next page
    }
    // a full page, or the scan cap: there may be more after the last row read
    const next = more && pos ? encode(pos) : null
    return { files, next_cursor: next, days }
  }
}

/** A message's files as stored; a damaged row has none (never a failed read). */
function attachmentsOf(json: string): unknown[] {
  try {
    const m = JSON.parse(json) as { attachments?: unknown }
    return Array.isArray(m?.attachments) ? m.attachments : []
  } catch {
    return []
  }
}

/** One stored attachment as a file: not a voice note or a spoken reply (messages, not files), and well formed. */
function fileOf(raw: unknown): SentFileT['file'] | null {
  if (!raw || typeof raw !== 'object') return null
  const r = AttachmentRef.safeParse(raw)
  if (!r.success || r.data.role === 'voice_reply' || r.data.kind === 'voice_note') return null
  return r.data
}

/** The service on a bridge: its history, the Mac's thread list now, its media's removed marks, its history setting. */
export function filesSentFor(ctx: BridgeContext, store: HistoryStore): FilesSentService {
  return new FilesSentService({
    db: store.db,
    threads: () => ctx.config.config.threads.map((t) => t.id),
    removed: (id) => ctx.media.removedInfo(id) !== undefined,
    historyDays: () => ctx.env.historyDays,
  })
}
