// search.query and the context-view paging (docs/V2-FEATURES.md V3.1 queries, V3.2). Raw owner input never reaches MATCH:
// `buildFtsQuery` makes every term a quoted literal and the expression is a bound parameter.

import type { Database } from 'bun:sqlite'
import { createHash } from 'node:crypto'
import {
  buildFtsQuery,
  type FrameOf,
  foldForSearch,
  type MessageT,
  SEARCH_LIMITS,
  type SearchHitT,
  type SearchMatchInT,
} from '@talos-app/protocol'
import type { HistoryStore } from '../history-store.ts'
import { ReadError, type SearchService } from '../v2-seams.ts'
import { SENTINEL_CLOSE, SENTINEL_OPEN } from './columns.ts'
import type { SearchIndexer } from './indexer.ts'
import { BM25_WEIGHTS, FTS_COLUMNS } from './schema.ts'

const DAY = 24 * 3600_000
const SNIPPET_MAX = 300
const MATCH_IN: Record<(typeof FTS_COLUMNS)[number], SearchMatchInT> = {
  text: 'text',
  transcript: 'transcript',
  names: 'attachment_name',
  files: 'attachment_text',
  card: 'card',
}

type Body = Awaited<ReturnType<SearchService['query']>>
type Cand = { ord: number; bm: number; created_at: string }
type Filters = FrameOf<'search.query'>['filters']

const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url')
const unb64 = (s: string): Record<string, unknown> | null => {
  try {
    const v = JSON.parse(Buffer.from(s, 'base64url').toString('utf8'))
    return v && typeof v === 'object' ? (v as Record<string, unknown>) : null
  } catch {
    return null
  }
}
const qhash = (match: string, filters: Filters, sort: string) =>
  createHash('sha1')
    .update(JSON.stringify([match, filters, sort]))
    .digest('base64url')
    .slice(0, 12)

/** WHERE parts for the filters, joined to `messages m`. */
function filterSql(f: Filters): { sql: string; args: Array<string | number> } {
  const parts: string[] = []
  const args: Array<string | number> = []
  if (f.thread_ids.length) {
    parts.push(`m.thread_id IN (${f.thread_ids.map(() => '?').join(',')})`)
    args.push(...f.thread_ids)
  }
  if (f.from === 'owner') parts.push("m.author = 'owner' AND COALESCE(json_extract(m.json,'$.via'),'app') != 'share'")
  else if (f.from === 'agent') parts.push("m.author IN ('agent','system')")
  if (f.has_file === true)
    parts.push(
      "EXISTS (SELECT 1 FROM json_each(m.json,'$.attachments') a WHERE json_extract(a.value,'$.role')='attachment' AND json_extract(a.value,'$.kind')!='voice_note')",
    )
  else if (f.has_file === false)
    parts.push(
      "NOT EXISTS (SELECT 1 FROM json_each(m.json,'$.attachments') a WHERE json_extract(a.value,'$.role')='attachment' AND json_extract(a.value,'$.kind')!='voice_note')",
    )
  if (f.after) {
    parts.push('m.created_at >= ?')
    args.push(f.after)
  }
  if (f.before) {
    parts.push('m.created_at <= ?')
    args.push(f.before)
  }
  return { sql: parts.length ? ` AND ${parts.join(' AND ')}` : '', args }
}

/** Plain text window around the first sentinel, and the [start,end) marks inside it (UTF-16 offsets, after stripping). */
export function windowOf(highlighted: string): { snippet: string; marks: Array<[number, number]> } {
  const flat = highlighted.replace(/\s/g, ' ')
  const first = flat.indexOf(SENTINEL_OPEN)
  let start = Math.max(0, first - 60)
  if (start > 0) {
    // start on a word boundary when one is close
    const sp = flat.indexOf(' ', start)
    if (sp >= 0 && sp < first) start = sp + 1
  }
  // sentinels do not count toward the length
  let out = ''
  let plain = 0
  const marks: Array<[number, number]> = []
  let open = -1
  let i = start
  for (; i < flat.length && plain < SNIPPET_MAX; i++) {
    const ch = flat[i] as string
    if (ch === SENTINEL_OPEN) open = plain + (start > 0 ? 1 : 0)
    else if (ch === SENTINEL_CLOSE) {
      if (open >= 0 && marks.length < 20) marks.push([open, plain + (start > 0 ? 1 : 0)])
      open = -1
    } else {
      out += ch
      plain++
    }
  }
  if (open >= 0 && marks.length < 20) marks.push([open, plain + (start > 0 ? 1 : 0)])
  const lead = start > 0 ? '…' : ''
  const trail = i < flat.length && flat.slice(i).replace(/[]/g, '').trim() ? '…' : ''
  return { snippet: `${lead}${out}${trail}`, marks }
}

export type QueryDeps = {
  db: Database
  store: HistoryStore
  indexer: SearchIndexer
  now: () => number
  /** Test seam: the 1.5 s budget. */
  budgetMs?: number
}

export function createQuery(d: QueryDeps) {
  const { db } = d
  const budget = d.budgetMs ?? SEARCH_LIMITS.budgetMs

  const indexState = (): 'ready' | 'indexing' | 'dirty' =>
    d.indexer.dirty() ? 'dirty' : d.indexer.behind() > 0 ? 'indexing' : 'ready'

  function candidates(match: string, f: Filters, order: 'bm' | 'ord', after: number | null, limit: number): Cand[] {
    const fs = filterSql(f)
    const sql = `SELECT msg_fts.rowid AS ord, bm25(msg_fts, ${BM25_WEIGHTS}) AS bm, m.created_at AS created_at
      FROM msg_fts JOIN messages m ON m.ord = msg_fts.rowid
      WHERE msg_fts MATCH ?${fs.sql}${after !== null ? ' AND m.ord < ?' : ''}
      ORDER BY ${order === 'bm' ? 'bm ASC' : 'm.ord DESC'} LIMIT ?`
    const args: Array<string | number> = [match, ...fs.args, ...(after !== null ? [after] : []), limit]
    return db.query(sql).all(...args) as Cand[]
  }

  function hitFor(c: Cand, match: string, terms: string[]): SearchHitT | null {
    const row = db
      .query(
        `SELECT ${FTS_COLUMNS.map((_, i) => `highlight(msg_fts, ${i}, '${SENTINEL_OPEN}', '${SENTINEL_CLOSE}') AS c${i}`).join(', ')}
         FROM msg_fts WHERE msg_fts MATCH ? AND rowid = ?`,
      )
      .get(match, c.ord) as Record<string, string> | null
    const mrow = db.query('SELECT json, seq FROM messages WHERE ord = ?').get(c.ord) as {
      json: string
      seq: number | null
    } | null
    if (!row || !mrow) return null
    const msg = JSON.parse(mrow.json) as MessageT
    let col = FTS_COLUMNS.findIndex((_, i) => (row[`c${i}`] ?? '').includes(SENTINEL_OPEN))
    if (col < 0) col = 0 // matched only through a NOT-free structure we cannot highlight: show the start of the text
    const colName = FTS_COLUMNS[col] as (typeof FTS_COLUMNS)[number]
    const raw = row[`c${col}`] ?? ''
    const { snippet, marks } = windowOf(raw)
    const hit: SearchHitT = {
      message_id: msg.id,
      thread_id: msg.thread_id,
      seq: mrow.seq ?? msg.seq ?? null,
      author: msg.author,
      kind: msg.kind,
      via: msg.via ?? 'app',
      created_at: msg.created_at,
      match_in: MATCH_IN[colName],
      snippet,
      marks,
    }
    if (colName === 'names') {
      const files = (msg.attachments ?? []).filter((a) => a.role !== 'voice_reply')
      const named = files.find((a) => terms.some((t) => foldForSearch(a.name).includes(foldForSearch(t)))) ?? files[0]
      if (named) hit.attachment = { media_id: named.media_id, name: named.name, mime: named.mime, kind: named.kind }
    }
    return hit
  }

  function countCap(match: string, f: Filters): number {
    const fs = filterSql(f)
    const r = db
      .query(
        `SELECT COUNT(*) AS n FROM (SELECT 1 FROM msg_fts JOIN messages m ON m.ord = msg_fts.rowid WHERE msg_fts MATCH ?${fs.sql} LIMIT ${SEARCH_LIMITS.totalEstimateCap})`,
      )
      .get(match, ...fs.args) as { n: number }
    return r.n
  }

  return {
    indexState,

    async query(f: FrameOf<'search.query'>): Promise<Body> {
      const t0 = Date.now()
      const q = buildFtsQuery(f.q)
      const empty = (): Body => ({
        hits: [],
        next_cursor: null,
        total_estimate: 0,
        took_ms: Date.now() - t0,
        index: indexState(),
      })
      if (!q.match) return empty()
      const hash = qhash(q.match, f.filters, f.sort)
      let cur: Record<string, unknown> | null = null
      if (f.cursor) {
        cur = unb64(f.cursor)
        if (!cur || cur.h !== hash || cur.s !== f.sort)
          throw new ReadError('bad_query', 'That page belongs to another search.')
      }
      try {
        let picked: Cand[]
        let next: string | null
        let total: number
        if (f.sort === 'newest') {
          const after = cur && typeof cur.o === 'number' ? cur.o : null
          const rows = candidates(q.match, f.filters, 'ord', after, f.limit + 1)
          const more = rows.length > f.limit
          picked = rows.slice(0, f.limit)
          const last = picked[picked.length - 1]
          next = more && last ? b64({ o: last.ord, s: 'newest', h: hash }) : null
          total = countCap(q.match, f.filters)
        } else {
          const rows = candidates(q.match, f.filters, 'bm', null, SEARCH_LIMITS.relevanceCap)
          const nowMs = d.now()
          const scored = rows
            .map((r) => ({ r, score: -r.bm / (1 + Math.max(0, nowMs - Date.parse(r.created_at)) / DAY / 30) }))
            .sort(
              (a, b) =>
                b.score - a.score ||
                (a.r.created_at < b.r.created_at ? 1 : a.r.created_at > b.r.created_at ? -1 : b.r.ord - a.r.ord),
            )
          const off = cur && typeof cur.o === 'number' ? cur.o : 0
          picked = scored.slice(off, off + f.limit).map((x) => x.r)
          next = off + f.limit < scored.length ? b64({ o: off + f.limit, s: 'relevance', h: hash }) : null
          total = scored.length
        }
        if (Date.now() - t0 > budget) throw new ReadError('search_unavailable', 'Search took too long. Try again.')
        const hits = picked.map((c) => hitFor(c, q.match as string, q.terms)).filter((h): h is SearchHitT => h !== null)
        if (Date.now() - t0 > budget) throw new ReadError('search_unavailable', 'Search took too long. Try again.')
        return { hits, next_cursor: next, total_estimate: total, took_ms: Date.now() - t0, index: indexState() }
      } catch (e) {
        if (e instanceof ReadError) throw e
        throw new ReadError('search_unavailable', 'Search is not ready on this Mac.')
      }
    },

    /** The context view's three keys, paged on `ord` inside the anchor's thread. */
    history(f: FrameOf<'history.request'>): { messages: MessageT[]; hasMore: boolean; hasNewer: boolean } | null {
      const id = f.around_id ?? f.before_id ?? f.after_id
      if (id === undefined) return null
      const a = db.query('SELECT ord, thread_id FROM messages WHERE id = ?').get(id) as {
        ord: number
        thread_id: string
      } | null
      if (!a || a.thread_id !== f.thread_id) return { messages: [], hasMore: false, hasNewer: false }
      const rowsOf = (sql: string, ...args: Array<number | string>) =>
        (db.query(sql).all(...args) as Array<{ json: string; seq: number | null }>).map((r) => {
          const m = JSON.parse(r.json) as MessageT
          if (r.seq !== null) m.seq = r.seq
          return m
        })
      const older = (limit: number) =>
        rowsOf(
          'SELECT json, seq FROM messages WHERE thread_id = ? AND ord < ? ORDER BY ord DESC LIMIT ?',
          a.thread_id,
          a.ord,
          limit + 1,
        )
      const newer = (from: number, limit: number) =>
        rowsOf(
          'SELECT json, seq FROM messages WHERE thread_id = ? AND ord > ? ORDER BY ord ASC LIMIT ?',
          a.thread_id,
          from,
          limit + 1,
        )
      if (f.before_id !== undefined) {
        const rows = older(f.limit)
        return { messages: rows.slice(0, f.limit).reverse(), hasMore: rows.length > f.limit, hasNewer: true }
      }
      if (f.after_id !== undefined) {
        const rows = newer(a.ord, f.limit)
        return { messages: rows.slice(0, f.limit), hasMore: true, hasNewer: rows.length > f.limit }
      }
      const side = Math.max(1, Math.floor(f.limit / 2))
      const before = older(side)
      const self = rowsOf('SELECT json, seq FROM messages WHERE ord = ?', a.ord)
      const after = newer(a.ord, side)
      return {
        messages: [...before.slice(0, side).reverse(), ...self, ...after.slice(0, side)],
        hasMore: before.length > side,
        hasNewer: after.length > side,
      }
    },
  }
}
