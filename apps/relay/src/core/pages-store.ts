// Org pages' store (docs/ORG-PAGES-SPEC.md): versions named by the SHA-256 of their bytes, kept as encrypted files
// (DATA_DIR/pages/<page_id>/<hash>.bin), 10 to a page, with the page, version and share rows. No routes here (core/pages.ts),
// so the runtime's sweeper can use it without importing the HTTP layer.
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  newId,
  PAGE_LIMITS,
  PageId,
  type PageInfoT,
  type PagePublishQueryT,
  type PageShareT,
} from '@talos-app/protocol'
import type Database from 'better-sqlite3'
import type { Clock, CryptoService } from '../services.ts'

// ---- storage ----------------------------------------------------------------------------------------------------------

export type Deps = { db: Database.Database; crypto: CryptoService; clock: Clock; dataDir: string }
export type Caps = { maxBytes: number; maxPages: number }

const rootOf = (dataDir: string) => join(dataDir, 'pages')
const dirOf = (dataDir: string, id: string) => join(rootOf(dataDir), id)
const fileOf = (dataDir: string, id: string, hash: string) => join(dirOf(dataDir, id), `${hash}.bin`)
const aad = (id: string, hash: string) => `page:${id}:${hash}`

type PageRow = {
  page_id: string
  title: string
  thread_id: string
  created_at: number
  updated_at: number
  current_hash: string
}
type VersionRow = { hash: string; bytes: number; created_at: number }
type ShareRow = { scope: 'people' | 'org'; emails: string; shared_at: number; expires_at: number | null }

const iso = (ms: number) => new Date(ms).toISOString()
export const pageRow = (db: Database.Database, id: string) =>
  db.prepare('select * from core_pages where page_id = ?').get(id) as PageRow | undefined
/** Newest first. */
const versionRows = (db: Database.Database, id: string) =>
  db
    .prepare(
      'select hash, bytes, created_at from core_page_versions where page_id = ? order by created_at desc, rowid desc',
    )
    .all(id) as VersionRow[]

/** Bytes every kept version uses (as published; the encrypted files are a few bytes more). */
export function pagesBytes(d: Pick<Deps, 'db'>): number {
  return (d.db.prepare('select coalesce(sum(bytes), 0) as n from core_page_versions').get() as { n: number }).n
}

function pageCount(db: Database.Database): number {
  return (db.prepare('select count(*) as n from core_pages').get() as { n: number }).n
}

function shareOf(db: Database.Database, id: string): PageShareT | null {
  const s = db.prepare('select * from core_page_shares where page_id = ?').get(id) as ShareRow | undefined
  if (!s) return null
  return {
    scope: s.scope,
    emails: JSON.parse(s.emails) as string[],
    shared_at: iso(s.shared_at),
    expires_at: s.expires_at === null ? null : iso(s.expires_at),
  }
}

export function pageInfo(db: Database.Database, id: string): PageInfoT | null {
  const p = pageRow(db, id)
  if (!p) return null
  return {
    id: p.page_id,
    title: p.title,
    thread_id: p.thread_id,
    created_at: iso(p.created_at),
    updated_at: iso(p.updated_at),
    current: p.current_hash,
    versions: versionRows(db, id).map((v) => ({ hash: v.hash, bytes: v.bytes, at: iso(v.created_at) })),
    share: shareOf(db, id),
  }
}

function writeAtomic(path: string, bytes: Uint8Array): void {
  const tmp = `${path}.tmp`
  writeFileSync(tmp, bytes, { mode: 0o600 })
  renameSync(tmp, path)
}

export type Published =
  | { kind: 'ok'; status: 200 | 201; page_id: string; version: string; unchanged: boolean }
  | { kind: 'not_found' }
  | { kind: 'full' }

/**
 * One publish. A new page, or (with `page_id`) a version of a page THIS thread published; the same bytes as a kept version add
 * nothing (that version becomes current again). The file is written first, then the rows in one transaction; a failed
 * transaction removes the file again. Past the caps (counted after the oldest version a full page drops) nothing is written.
 */
export function publishPage(d: Deps, q: PagePublishQueryT, html: Uint8Array, caps: Caps): Published {
  const hash = createHash('sha256').update(html).digest('hex')
  const now = d.clock.now()
  if (q.page_id !== undefined) {
    const p = pageRow(d.db, q.page_id)
    // another thread's page and no page at all look the same
    if (!p || p.thread_id !== q.thread_id) return { kind: 'not_found' }
    const kept = versionRows(d.db, p.page_id)
    if (kept.some((v) => v.hash === hash)) {
      d.db
        .prepare('update core_pages set current_hash = ?, title = ?, updated_at = ? where page_id = ?')
        .run(hash, q.title, now, p.page_id)
      return { kind: 'ok', status: 200, page_id: p.page_id, version: hash, unchanged: true }
    }
    // the version a full page drops to make room: the oldest one that is not current
    const drop =
      kept.length >= PAGE_LIMITS.versionsPerPage
        ? [...kept].reverse().find((v) => v.hash !== p.current_hash)
        : undefined
    if (pagesBytes(d) - (drop?.bytes ?? 0) + html.length > caps.maxBytes) return { kind: 'full' }
    mkdirSync(dirOf(d.dataDir, p.page_id), { recursive: true, mode: 0o700 })
    const path = fileOf(d.dataDir, p.page_id, hash)
    writeAtomic(path, d.crypto.encrypt(html, aad(p.page_id, hash)))
    try {
      d.db.transaction(() => {
        d.db
          .prepare('insert into core_page_versions (page_id, hash, bytes, created_at) values (?, ?, ?, ?)')
          .run(p.page_id, hash, html.length, now)
        d.db
          .prepare('update core_pages set current_hash = ?, title = ?, updated_at = ? where page_id = ?')
          .run(hash, q.title, now, p.page_id)
        if (drop)
          d.db.prepare('delete from core_page_versions where page_id = ? and hash = ?').run(p.page_id, drop.hash)
      })()
    } catch (e) {
      rmSync(path, { force: true })
      throw e
    }
    if (drop) rmSync(fileOf(d.dataDir, p.page_id, drop.hash), { force: true })
    return { kind: 'ok', status: 201, page_id: p.page_id, version: hash, unchanged: false }
  }
  if (pageCount(d.db) >= caps.maxPages || pagesBytes(d) + html.length > caps.maxBytes) return { kind: 'full' }
  const id = newId('pg')
  mkdirSync(dirOf(d.dataDir, id), { recursive: true, mode: 0o700 })
  const path = fileOf(d.dataDir, id, hash)
  writeAtomic(path, d.crypto.encrypt(html, aad(id, hash)))
  try {
    d.db.transaction(() => {
      d.db
        .prepare(
          'insert into core_pages (page_id, title, thread_id, created_at, updated_at, current_hash) values (?, ?, ?, ?, ?, ?)',
        )
        .run(id, q.title, q.thread_id, now, now, hash)
      d.db
        .prepare('insert into core_page_versions (page_id, hash, bytes, created_at) values (?, ?, ?, ?)')
        .run(id, hash, html.length, now)
    })()
  } catch (e) {
    rmSync(dirOf(d.dataDir, id), { recursive: true, force: true })
    throw e
  }
  return { kind: 'ok', status: 201, page_id: id, version: hash, unchanged: false }
}

/** The bytes of a kept version of a page, or null (no such page, no such version, or its file is gone). */
export function readVersion(d: Deps, id: string, hash: string): Uint8Array | null {
  const kept = d.db.prepare('select 1 from core_page_versions where page_id = ? and hash = ?').get(id, hash)
  if (!kept) return null
  try {
    return d.crypto.decrypt(readFileSync(fileOf(d.dataDir, id, hash)), aad(id, hash))
  } catch {
    return null
  }
}

export function deletePage(d: Deps, id: string): void {
  d.db.prepare('delete from core_pages where page_id = ?').run(id) // versions and share go with it (on delete cascade)
  rmSync(dirOf(d.dataDir, id), { recursive: true, force: true })
}

/**
 * Ends every share past its end (the page stays), and removes files no row names: a page folder with no page, a version file
 * with no version, a temp file left by a crash. Returns how many shares ended and how many files went.
 */
export function sweepPages(d: Pick<Deps, 'db' | 'clock' | 'dataDir'>): { sharesEnded: number; orphans: number } {
  const ended = d.db
    .prepare('delete from core_page_shares where expires_at is not null and expires_at <= ?')
    .run(d.clock.now()).changes
  let orphans = 0
  const root = rootOf(d.dataDir)
  if (existsSync(root)) {
    for (const id of readdirSync(root)) {
      const dir = join(root, id)
      // a stray file beside the page folders (a crash's temp file, say) goes too, and never stops the sweep
      if (!statSync(dir).isDirectory()) {
        rmSync(dir, { force: true })
        orphans++
        continue
      }
      const known = PageId.safeParse(id).success && pageRow(d.db, id) !== undefined
      const keep = new Set(known ? versionRows(d.db, id).map((v) => `${v.hash}.bin`) : [])
      for (const f of readdirSync(dir)) {
        if (keep.has(f)) continue
        rmSync(join(dir, f), { force: true })
        orphans++
      }
      if (!known) rmSync(dir, { recursive: true, force: true })
    }
  }
  return { sharesEnded: ended, orphans }
}
