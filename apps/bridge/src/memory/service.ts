// The memory browser (docs/V2-FEATURES.md V5): read-only tree, chunked notes and FTS5 search over the folders listed in
// memory.json. Nothing here ever writes under the agent dir. Logs carry ids and counts only, never names or text.
import { Database } from 'bun:sqlite'
import { createHash } from 'node:crypto'
import { type FSWatcher, rmSync, watch } from 'node:fs'
import {
  buildFtsQuery,
  type FrameOf,
  MAX_FRAME_BYTES,
  MEMORY_FRAME_SLACK,
  MEMORY_LINKS_MAX_BYTES,
  type MemoryEntryT,
  type MemoryHitT,
  type MemoryLinkT,
  type MemoryRootInfoT,
  type MessageRefT,
} from '@talos-app/protocol'
import type { Clock } from '../clock.ts'
import type { Logger } from '../log.ts'
import { type MemoryService, ReadError } from '../v2-seams.ts'
import { loadMemoryConfig, type MemoryConfig, memoryIndexPath, memoryJsonMtime } from './config.ts'
import { asText, MemoryScope, readCapped } from './scope.ts'
import { capLinks, extractLinks, resolveLinks, titleOf } from './text.ts'

export const MAX_FILES = 20_000
export const MAX_TEXT_BYTES = 200 * 1024 * 1024
export const POLL_MS = 5 * 60_000
export const WATCH_DEBOUNCE_MS = 2000
const FRAME_BUDGET = MAX_FRAME_BYTES - MEMORY_FRAME_SLACK
const LIST_PAGE_MAX = 20_000
const SNIPPET_MAX = 320

type Body<T extends 'memory.listing' | 'memory.file' | 'memory.results'> = Awaited<
  ReturnType<
    T extends 'memory.listing'
      ? MemoryService['tree']
      : T extends 'memory.file'
        ? MemoryService['read']
        : MemoryService['search']
  >
>

type Info = { size: number; mtimeMs: number; title: string }
const jsonBytes = (v: unknown) => Buffer.byteLength(JSON.stringify(v), 'utf8')
const sha256 = (b: Uint8Array) => createHash('sha256').update(b).digest('hex')
const mimeOf = (p: string) =>
  /\.(md|markdown)$/i.test(p) ? 'text/markdown' : /\.html?$/i.test(p) ? 'text/html' : 'text/plain'
const isoOf = (ms: number) => new Date(ms).toISOString()
/** Stands in for the envelope (`v`, `id`, `ts`, `type`, `request_id`) when measuring a frame. */
const ENVELOPE = { v: 1, id: '0'.repeat(26), ts: '2026-01-01T00:00:00.000Z', request_id: '0'.repeat(26) }

export type MemoryServiceOptions = {
  home: string
  clock: Clock
  log: Logger
  /** The live `config.memory_browser` (the phone's off switch). */
  switchOn: () => boolean
  /** `fs.watch` on the roots (default on). Off = only the 5-minute poll. */
  watch?: boolean
  debounceMs?: number
  pollMs?: number
  /** Where the index file is (default: memory-index.sqlite in the app home). `reindex` builds its new copy elsewhere. */
  indexPath?: string
  /** Test seam: called with the running count after each note is indexed; a throw simulates a failure partway. */
  afterNoteIndexed?: (n: number) => void
  /** Test seam: the index text cap (default MAX_TEXT_BYTES). */
  maxTextBytes?: number
}

/** Yield to the event loop after this many indexed bytes as well as every 100 files. */
const YIELD_BYTES = 2 * 1024 * 1024
const MEM_FTS_DDL = `CREATE VIRTUAL TABLE IF NOT EXISTS mem_fts USING fts5(title, body,
  tokenize = 'unicode61 remove_diacritics 2', prefix = '2 3')`
/** Bump to force every install to rebuild its search index once. */
const INDEX_VERSION = 2

/** Replaces the live index's rows with the ones in the finished index file `from`, in one transaction. */
function swapIndex(live: Database, from: string) {
  live.exec('PRAGMA busy_timeout = 5000')
  live.query('ATTACH DATABASE ? AS fresh').run(from)
  try {
    live.transaction(() => {
      live.exec('DROP TABLE IF EXISTS mem_fts; DELETE FROM idx_files;')
      live.exec(MEM_FTS_DDL)
      live.exec('INSERT INTO idx_files SELECT * FROM fresh.idx_files')
      live.exec('INSERT INTO mem_fts (rowid, title, body) SELECT rowid, title, body FROM fresh.mem_fts')
    })()
  } finally {
    live.exec('DETACH DATABASE fresh')
  }
}

export class MemoryBrowser implements MemoryService {
  available = false
  private db: Database | null = null
  private cfg: MemoryConfig | null = null
  private cfgError: string | null = null
  private cfgSeenMtime = -1
  private scope: MemoryScope | null = null
  private files = new Map<string, Map<string, Info>>()
  private truncatedRoots = new Set<string>()
  private watchers: FSWatcher[] = []
  private debounce: unknown = null
  private pollTimer: unknown = null
  private running: Promise<void> | null = null
  private again = false
  private stopped = false
  private indexing = false
  /** Why the last indexing run did not finish, or null when it did. */
  private indexError: string | null = null
  private cache: { key: string; buf: Buffer; sha: string; fullSize: number } | null = null

  constructor(private readonly o: MemoryServiceOptions) {
    this.available = this.openIndex()
    if (!this.available) return
    this.syncConfig(true)
    this.armPoll()
  }

  // ---- lifecycle ---------------------------------------------------------------------------------------------------

  /** Resolves when the walk and the content indexing of the last refresh have finished (tests, `memory reindex`). */
  async idle(): Promise<void> {
    while (this.running) await this.running
  }

  stop() {
    this.stopped = true
    this.closeWatchers()
    if (this.debounce) this.o.clock.clearTimeout(this.debounce)
    if (this.pollTimer) this.o.clock.clearTimeout(this.pollTimer)
    this.debounce = this.pollTimer = null
    try {
      this.db?.close()
    } catch {
      // already closed
    }
    this.db = null
  }

  private openIndex(): boolean {
    try {
      const db = new Database(this.o.indexPath ?? memoryIndexPath(this.o.home), { create: true })
      db.exec('PRAGMA journal_mode = WAL')
      // the FTS5 probe (V3.1): the system SQLite may lack it
      db.exec('CREATE VIRTUAL TABLE IF NOT EXISTS temp.mem_probe USING fts5(x)')
      db.exec('DROP TABLE temp.mem_probe')
      db.exec(`CREATE TABLE IF NOT EXISTS idx_files (
        id INTEGER PRIMARY KEY, root TEXT NOT NULL, path TEXT NOT NULL, size INTEGER NOT NULL,
        mtime_ms REAL NOT NULL, title TEXT NOT NULL, UNIQUE(root, path))`)
      db.exec(MEM_FTS_DDL)
      // v2 (2026-10): an index built before the folder-swap fix may hold text read through a swapped folder, and rows
      // whose size and mtime are unchanged are never re-read; so an older index is emptied once and rebuilt
      const ver = (db.query('PRAGMA user_version').get() as { user_version: number }).user_version
      if (ver < INDEX_VERSION) {
        // DROP and recreate, not row-by-row DELETE (which tokenizes every row, a multi-second stall at boot)
        db.transaction(() => {
          db.exec('DROP TABLE IF EXISTS mem_fts; DELETE FROM idx_files;')
          db.exec(MEM_FTS_DDL)
        })()
        db.exec(`PRAGMA user_version = ${INDEX_VERSION}`)
      }
      this.db = db
      return true
    } catch (e) {
      this.o.log.warn('memory index unavailable', { error: (e as Error).message })
      return false
    }
  }

  /** Re-reads memory.json when it changed; a change rebuilds scope, watchers and index. */
  private syncConfig(force = false) {
    const m = memoryJsonMtime(this.o.home)
    if (!force && m === this.cfgSeenMtime) return
    this.cfgSeenMtime = m
    const r = loadMemoryConfig(this.o.home)
    this.closeWatchers()
    if (!r.ok) {
      this.cfg = null
      this.scope = null
      this.cfgError = 'missing' in r && r.missing ? null : r.message
      this.files.clear()
      if (this.cfgError) this.o.log.warn('memory.json is not usable', { error: this.cfgError })
      return
    }
    this.cfg = r.config
    this.cfgError = null
    this.scope = new MemoryScope(r.config)
    if (r.config.enabled) {
      this.walkNow()
      this.armWatch()
      this.kick()
    } else this.files.clear()
  }

  enabled(): boolean {
    if (!this.available || this.stopped) return false
    this.syncConfig()
    return Boolean(this.cfg?.enabled && this.o.switchOn())
  }

  // ---- index freshness ---------------------------------------------------------------------------------------------

  private armWatch() {
    if (this.o.watch === false || !this.scope) return
    for (const r of this.scope.roots) {
      try {
        const w = watch(r.dir, { recursive: true }, () => this.schedule())
        w.on('error', () => {})
        this.watchers.push(w)
      } catch (e) {
        this.o.log.warn('memory watch failed; the 5-minute poll still runs', { error: (e as Error).message })
      }
    }
  }
  private closeWatchers() {
    for (const w of this.watchers) w.close()
    this.watchers = []
  }
  private schedule() {
    if (this.stopped) return
    if (this.debounce) this.o.clock.clearTimeout(this.debounce)
    this.debounce = this.o.clock.setTimeout(() => {
      this.debounce = null
      this.walkNow()
      this.kick()
    }, this.o.debounceMs ?? WATCH_DEBOUNCE_MS)
  }
  private armPoll() {
    this.pollTimer = this.o.clock.setTimeout(() => {
      if (this.stopped) return
      this.syncConfig()
      if (this.cfg?.enabled) {
        this.walkNow()
        this.kick()
      }
      this.armPoll()
    }, this.o.pollMs ?? POLL_MS)
  }

  /** Walks the roots (stat only) so listings are right at once; the content indexing follows in `kick()`. */
  private walkNow() {
    if (!this.scope) return
    const next = new Map<string, Map<string, Info>>()
    let total = 0
    for (const root of this.scope.roots) {
      const w = this.scope.walk(root, Math.max(0, MAX_FILES - total))
      total += w.files.length
      if (w.truncated) this.truncatedRoots.add(root.id)
      else this.truncatedRoots.delete(root.id)
      const prev = this.files.get(root.id)
      const m = new Map<string, Info>()
      for (const f of w.files) {
        const old = prev?.get(f.path)
        // keep the title we already read while size and mtime are unchanged
        m.set(f.path, {
          size: f.size,
          mtimeMs: f.mtimeMs,
          title: old && old.size === f.size && old.mtimeMs === f.mtimeMs ? old.title : '',
        })
      }
      next.set(root.id, m)
    }
    this.files = next
  }

  private kick() {
    if (this.running) {
      this.again = true
      return
    }
    this.running = this.indexAll()
      .then(() => {
        this.indexError = null
      })
      .catch((e) => {
        this.indexError = (e as Error).message || 'unknown error'
        this.o.log.warn('memory indexing failed', { error: this.indexError })
      })
      .finally(() => {
        this.running = null
        if (this.again && !this.stopped) {
          this.again = false
          this.walkNow()
          this.kick()
        }
      })
  }

  /** Brings `idx_files` / `mem_fts` in line with the walk, in small batches so the event loop stays free. */
  private async indexAll(): Promise<void> {
    const db = this.db
    const scope = this.scope
    if (!db || !scope || this.stopped) return
    this.indexing = true
    try {
      const have = new Map<string, { id: number; size: number; mtime_ms: number; title: string }>()
      for (const r of db.query('SELECT id, root, path, size, mtime_ms, title FROM idx_files').all() as Array<{
        id: number
        root: string
        path: string
        size: number
        mtime_ms: number
        title: string
      }>)
        have.set(`${r.root}\0${r.path}`, r)
      const del = db.prepare('DELETE FROM idx_files WHERE id = ?')
      const delFts = db.prepare('DELETE FROM mem_fts WHERE rowid = ?')
      // gone, or no longer visible (an exclude was added, a .talos-private appeared)
      for (const [key, r] of have) {
        const [root, path] = key.split('\0') as [string, string]
        if (!this.files.get(root)?.has(path)) {
          del.run(r.id)
          delFts.run(r.id)
          have.delete(key)
        }
      }
      const maxBytes = (this.cfg?.max_file_kb ?? 512) * 1024
      let textBytes = 0
      let n = 0
      let sinceYield = 0
      const insFts = db.prepare('INSERT INTO mem_fts (rowid, title, body) VALUES (?, ?, ?)')
      const upIdx = db.prepare(
        'INSERT INTO idx_files (root, path, size, mtime_ms, title) VALUES (?, ?, ?, ?, ?) ON CONFLICT(root, path) DO UPDATE SET size = excluded.size, mtime_ms = excluded.mtime_ms, title = excluded.title RETURNING id',
      )
      for (const [rootId, m] of this.files) {
        for (const [path, info] of m) {
          if (this.stopped) return
          const old = have.get(`${rootId}\0${path}`)
          if (old && old.size === info.size && old.mtime_ms === info.mtimeMs) {
            info.title = old.title
            textBytes += Math.min(old.size, maxBytes)
            continue
          }
          if (textBytes >= (this.o.maxTextBytes ?? MAX_TEXT_BYTES)) {
            // changed but not re-indexable under the cap: its old row must not keep serving old text
            if (old) {
              del.run(old.id)
              delFts.run(old.id)
              have.delete(`${rootId}\0${path}`)
            }
            this.o.log.warn('memory index text cap reached; the rest is not searchable', { root: rootId })
            break
          }
          const loaded = this.loadFile(scope, rootId, path)
          if (!loaded) {
            // not shown after all: drop it from listings too, and from search (an old row would keep serving old text)
            m.delete(path)
            if (old) {
              del.run(old.id)
              delFts.run(old.id)
            }
            continue
          }
          const text = loaded.buf.toString('utf8')
          const title = titleOf(text, path.split('/').pop() as string)
          info.title = title
          textBytes += Buffer.byteLength(text)
          // ONE transaction: a kill between the row and its text would leave a row that claims the note is indexed
          db.transaction(() => {
            const row = upIdx.get(rootId, path, info.size, info.mtimeMs, title) as { id: number }
            delFts.run(row.id)
            insFts.run(row.id, title, text)
          })()
          n++
          this.o.afterNoteIndexed?.(n)
          sinceYield += Buffer.byteLength(text)
          if (n % 100 === 0 || sinceYield >= YIELD_BYTES) {
            sinceYield = 0
            await new Promise((r) => setImmediate(r))
          }
        }
      }
    } finally {
      this.indexing = false
    }
  }

  /**
   * `talos-app memory reindex`: rebuild the index. The new one is built in a file beside the live one, then swapped in
   * one transaction, so a search from the running bridge sees the old index until the new one is complete, never an
   * empty one.
   */
  async reindex(): Promise<number> {
    const live = this.db
    if (live) {
      const scratch = `${this.o.indexPath ?? memoryIndexPath(this.o.home)}.new`
      const clear = () => {
        for (const ext of ['', '-wal', '-shm']) rmSync(scratch + ext, { force: true })
      }
      clear()
      const fresh = new MemoryBrowser({ ...this.o, indexPath: scratch, watch: false, switchOn: () => true })
      try {
        if (!fresh.available) {
          throw new Error('The new index could not be opened, so nothing was rebuilt. The old index was kept.')
        }
        await fresh.idle()
        // swap only a build that finished: it had a folder to read and no run stopped partway
        if (fresh.indexError !== null || !fresh.scope) {
          throw new Error(
            `The rebuild stopped partway (${fresh.indexError ?? 'the notes folder could not be read'}). The old index was kept.`,
          )
        }
        swapIndex(live, scratch)
      } finally {
        fresh.stop()
        clear()
      }
    }
    this.cfgSeenMtime = -1
    this.syncConfig(true)
    this.walkNow()
    this.kick()
    await this.idle()
    return this.count()
  }
  count(): number {
    let n = 0
    for (const m of this.files.values()) n += m.size
    return n
  }
  /** For `memory show`: counts per root, the first 20 paths, and whether a cap cut the walk short. */
  exposure(): { id: string; label: string; files: number; first: string[]; truncated: boolean }[] {
    return (this.cfg?.roots ?? []).map((r) => {
      const m = this.files.get(r.id)
      return {
        id: r.id,
        label: r.label,
        files: m?.size ?? 0,
        first: [...(m?.keys() ?? [])].sort().slice(0, 20),
        truncated: this.truncatedRoots.has(r.id),
      }
    })
  }

  // ---- reads -------------------------------------------------------------------------------------------------------

  private need(): MemoryScope {
    if (!this.available || !this.scope || !this.enabled())
      throw new ReadError('memory_off', 'The memory browser is off.')
    return this.scope
  }
  private notFound(): never {
    throw new ReadError('memory_not_found', 'That note is not available.')
  }

  async tree(f: FrameOf<'memory.tree'>): Promise<Body<'memory.listing'>> {
    const scope = this.need()
    if (f.root_id === null) {
      const roots: MemoryRootInfoT[] = scope.roots.map((r) => ({
        id: r.id,
        label: r.cfg.label,
        files: this.files.get(r.id)?.size ?? 0,
      }))
      return { roots, entries: [], next_cursor: null }
    }
    const m = this.files.get(f.root_id)
    if (!m || !scope.root(f.root_id)) this.notFound()
    const prefix = f.path === '' ? '' : `${f.path.replace(/\/+$/, '')}/`
    const dirs = new Map<string, MemoryEntryT>()
    const filesHere: MemoryEntryT[] = []
    for (const [p, info] of m) {
      if (!p.startsWith(prefix)) continue
      const rest = p.slice(prefix.length)
      const slash = rest.indexOf('/')
      if (slash >= 0) {
        const name = rest.slice(0, slash)
        if (!dirs.has(name)) dirs.set(name, { name, path: `${prefix}${name}`, type: 'dir' })
      } else
        filesHere.push({
          name: rest,
          path: p,
          type: 'file',
          size: info.size,
          mtime: isoOf(info.mtimeMs),
          ...(info.title ? { title: info.title.slice(0, 200) } : {}),
          previewable: true,
        })
    }
    if (prefix !== '' && dirs.size === 0 && filesHere.length === 0) this.notFound()
    const cmp = (a: MemoryEntryT, b: MemoryEntryT) =>
      a.name.toLowerCase() < b.name.toLowerCase()
        ? -1
        : a.name.toLowerCase() > b.name.toLowerCase()
          ? 1
          : a.name < b.name
            ? -1
            : a.name > b.name
              ? 1
              : 0
    const all = [...[...dirs.values()].sort(cmp), ...filesHere.sort(cmp)]
    // the cursor is a position in this order: `i<n>` (opaque to the app)
    const start = f.cursor ? Math.max(0, Number(/^i(\d+)$/.exec(f.cursor)?.[1] ?? 0)) : 0
    const head = {
      root_id: f.root_id,
      path: f.path,
      entries: [] as MemoryEntryT[],
      next_cursor: 'i99999999' as string | null,
    }
    let used = jsonBytes({ ...ENVELOPE, type: 'memory.listing', ...head })
    const out: MemoryEntryT[] = []
    let i = start
    for (; i < all.length && out.length < LIST_PAGE_MAX; i++) {
      const e = all[i] as MemoryEntryT
      // the walk can be a couple of seconds old: what a page shows is checked again right now
      if (e.type === 'file' ? !scope.allowed(f.root_id, e.path) : !scope.dirVisible(f.root_id, e.path)) continue
      const add = jsonBytes(e) + 1
      if (used + add > FRAME_BUDGET && out.length > 0) break
      used += add
      out.push(e)
    }
    if (prefix !== '' && start === 0 && out.length === 0 && i >= all.length) this.notFound()
    return { root_id: f.root_id, path: f.path, entries: out, next_cursor: i < all.length ? `i${i}` : null }
  }

  /**
   * The text of a visible file and its hash, read from the file that was opened and verified (never by name again), at
   * most `max_file_kb` of it. The last file is kept so chunks 2..n do not re-read it; the open and the checks still run
   * for every call. Null = not in scope, or not text (a NUL byte, invalid UTF-8).
   */
  private loadFile(
    scope: MemoryScope,
    rootId: string,
    rel: string,
  ): { buf: Buffer; sha: string; abs: string; mtimeMs: number; fullSize: number } | null {
    const o = scope.open(rootId, rel)
    if (!o) return null
    try {
      const key = `${o.dev}\0${o.ino}\0${o.size}\0${o.mtimeMs}`
      if (this.cache?.key === key) return { ...this.cache, abs: o.abs, mtimeMs: o.mtimeMs }
      const cap = (this.cfg?.max_file_kb ?? 512) * 1024
      const raw = readCapped(o, cap)
      const buf = asText(raw, o.size > cap)
      if (!buf) return null
      this.cache = { key, buf, sha: sha256(buf), fullSize: o.size }
      return { ...this.cache, abs: o.abs, mtimeMs: o.mtimeMs }
    } catch {
      return null
    } finally {
      o.close()
    }
  }

  async read(f: FrameOf<'memory.read'>): Promise<Body<'memory.file'>> {
    const scope = this.need()
    const hit = this.loadFile(scope, f.root_id, f.path)
    if (!hit) return this.notFound()
    const { buf, sha } = hit
    let start = Math.min(f.offset, buf.length)
    while (start < buf.length && ((buf[start] as number) & 0xc0) === 0x80) start++ // never start inside a character
    const head = {
      root_id: f.root_id,
      path: f.path,
      mime: mimeOf(f.path),
      text: '',
      offset: start,
      next_offset: 4294967295 as number | null,
      size: hit.fullSize, // the file's size; the text stops at max_file_kb, and the app says so
      mtime: isoOf(hit.mtimeMs),
      sha256: sha,
    }
    const base = () => jsonBytes({ ...ENVELOPE, type: 'memory.file', ...head })
    // links ride on the first chunk only, are capped at MEMORY_LINKS_MAX_BYTES encoded, and are dropped first when room runs short
    let links: MemoryLinkT[] | undefined
    if (start === 0) {
      const text = buf.toString('utf8')
      const resolved = resolveLinks(
        extractLinks(text),
        { rootId: f.root_id, path: f.path },
        {
          has: (r, p) => this.files.get(r)?.has(p) ?? false,
          paths: (r) => this.files.get(r)?.keys() ?? [],
          rootIds: () => [...this.files.keys()],
        },
        (r, p) => scope.allowed(r, p),
      )
      links = capLinks(resolved, MEMORY_LINKS_MAX_BYTES)
    }
    let room = FRAME_BUDGET - (base() + (links?.length ? jsonBytes({ links }) - 1 : 0)) - 2
    if (links?.length && room < 4096) {
      links = undefined
      room = FRAME_BUDGET - base() - 2
    }
    const remaining = buf.length - start
    let end = start
    if (remaining > 0) {
      // largest code-point-aligned cut whose JSON-encoded text fits `room`
      const fits = (cut: number) =>
        Buffer.byteLength(JSON.stringify(buf.subarray(start, cut).toString('utf8')), 'utf8') - 2 <= room
      let lo = start
      let hi = Math.min(buf.length, start + Math.max(0, room))
      const align = (c: number) => {
        while (c > start && c < buf.length && ((buf[c] as number) & 0xc0) === 0x80) c--
        return c
      }
      hi = align(hi)
      if (fits(hi)) lo = hi
      else {
        let a = start
        let b = hi
        while (a < b) {
          const mid = align(Math.ceil((a + b) / 2))
          if (mid <= a) break
          if (fits(mid)) a = mid
          else b = mid - 1
        }
        lo = align(a)
      }
      end = lo
      if (end === start) throw new ReadError('too_large', 'That note is too large to send.')
    }
    return {
      root_id: f.root_id,
      path: f.path,
      mime: head.mime,
      text: buf.subarray(start, end).toString('utf8'),
      offset: start,
      next_offset: end < buf.length ? end : null,
      size: hit.fullSize,
      mtime: head.mtime,
      sha256: sha,
      ...(links ? { links } : {}),
    }
  }

  async search(f: FrameOf<'memory.search'>): Promise<Body<'memory.results'>> {
    const scope = this.need()
    const db = this.db
    if (!db) throw new ReadError('memory_off', 'The memory browser is off.')
    const q = buildFtsQuery(f.q)
    const state = this.indexing || this.running ? ('indexing' as const) : ('ready' as const)
    if (!q.match) return { hits: [], next_cursor: null, index: state }
    const roots = f.root_ids.filter((r) => scope.root(r))
    if (f.root_ids.length > 0 && roots.length === 0) return { hits: [], next_cursor: null, index: state }
    const start = f.cursor ? Math.max(0, Number(/^i(\d+)$/.exec(f.cursor)?.[1] ?? 0)) : 0
    const t0 = this.o.clock.now()
    let rows: Array<{ root: string; path: string; mtime_ms: number; title: string; snip: string }>
    try {
      const where = roots.length ? `AND f.root IN (${roots.map(() => '?').join(',')})` : ''
      rows = db
        .query(
          `SELECT f.root AS root, f.path AS path, f.mtime_ms AS mtime_ms, f.title AS title,
                  snippet(mem_fts, -1, char(1), char(2), '…', 24) AS snip
             FROM mem_fts JOIN idx_files f ON f.id = mem_fts.rowid
            WHERE mem_fts MATCH ? ${where} ORDER BY rank LIMIT ? OFFSET ?`,
        )
        .all(q.match, ...roots, f.limit + 1, start) as typeof rows
    } catch (e) {
      this.o.log.warn('memory search failed', { error: (e as Error).message })
      throw new ReadError('bad_query', 'That search is not valid.')
    }
    void t0
    const hits: MemoryHitT[] = []
    let used = 0
    let consumed = 0
    for (const r of rows.slice(0, f.limit)) {
      consumed++
      // visible right now? (an exclude or a private marker added since the index was built)
      if (!scope.allowed(r.root, r.path)) continue
      const { text, marks } = fromMarked(r.snip)
      const hit: MemoryHitT = {
        root_id: r.root,
        path: r.path,
        title: r.title.slice(0, 200),
        snippet: text,
        marks,
        mtime: isoOf(r.mtime_ms),
      }
      used += jsonBytes(hit) + 1
      if (used > FRAME_BUDGET) {
        consumed--
        break
      }
      hits.push(hit)
    }
    return { hits, next_cursor: rows.length > consumed ? `i${start + consumed}` : null, index: state }
  }

  // ---- [Ask {agent}] -----------------------------------------------------------------------------------------------

  checkRefs(refs: MessageRefT[]): { meta: Record<string, string>; notes: string[] } {
    const meta: Record<string, string> = {}
    const notes: string[] = []
    const scope = this.scope
    let first = true
    for (const ref of refs) {
      const hit = scope && this.enabled() ? this.loadFile(scope, ref.root_id, ref.path) : null
      if (!hit) {
        notes.push("That note isn't shared any more.")
        continue
      }
      const changed = hit.sha !== ref.sha256
      if (first) {
        meta.memory_root = ref.root_id
        meta.memory_path = hit.abs
        first = false
      } else notes.push(`(Also attached: ${hit.abs})`)
      if (changed) meta.memory_changed = 'true'
    }
    return { meta, notes }
  }
}

/** FTS5 snippet with \x01 and \x02 around matches -> plain text and `[start, end)` UTF-16 offsets. */
function fromMarked(s: string): { text: string; marks: [number, number][] } {
  let text = ''
  const marks: [number, number][] = []
  let open = -1
  for (const ch of s) {
    if (ch === '\x01') open = text.length
    else if (ch === '\x02') {
      if (open >= 0 && text.length <= SNIPPET_MAX) marks.push([open, Math.min(text.length, SNIPPET_MAX)])
      open = -1
    } else if (text.length < SNIPPET_MAX) text += ch
  }
  return { text, marks: marks.filter(([a, b]) => a < b && a < SNIPPET_MAX).slice(0, 20) }
}
