// A history.sqlite the database cannot read used to stop the bridge at start-up (exit 1), so the owner's phone went quiet.
// Now the live bridge keeps the bad file beside the new one (never deletes it), starts with an empty history, tells the
// owner in the thread, and messages flow. The files here are really damaged, not mocked; so is the file that is NOT corrupt.

import { Database } from 'bun:sqlite'
import { afterEach, describe, expect, setDefaultTimeout, test } from 'bun:test'
import {
  chmodSync,
  closeSync,
  existsSync,
  fstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  writeFileSync,
  writeSync,
} from 'node:fs'
import { join } from 'node:path'
import type { MessageT } from '@talos-app/protocol'
import { t } from '@talos-app/testkit'
import { Bridge } from '../src/bridge.ts'
import { loadEnv } from '../src/config.ts'
import { dropSearchTables, openHistoryOrKeepAside } from '../src/history-recover.ts'
import { openHistory } from '../src/history-store.ts'
import { nullLogger } from '../src/log.ts'
import { WorkerStore } from '../src/worker/store.ts'
import { HARNESS_START_MS, type Harness, sleep, startHarness, stopRelay, tempHome, waitFor } from './helpers.ts'
import { durableSqlite } from './sqlite-durable.ts'

// this file's point is what survives a kill or a crash mid-write: SQLite syncs as the product runs (sqlite-test-seam.ts)
durableSqlite()

// a test that starts a harness has HARNESS_START_MS on top of its own waits; the rest of this file's tests are synchronous
setDefaultTimeout(t(30_000))

let h: Harness | undefined
afterEach(async () => {
  await h?.stop()
  h = undefined
})

/**
 * A real history.sqlite with enough rows to span several pages, checkpointed so the main file holds them all. Built once per
 * process (each caller gets its own copy of the bytes), in one transaction: 600 separate commits cost an fsync each, ~10 s on
 * a Linux disk.
 */
let realBytes: Buffer | undefined
function realHistoryBytes(): Buffer {
  if (!realBytes) {
    const dir = tempHome('talos-hist-src-')
    const path = join(dir, 'history.sqlite')
    const s = openHistory(path)
    s.db.exec('BEGIN')
    for (let i = 0; i < 600; i++) s.kvSet(`k${i}`, 'v'.repeat(300))
    s.db.exec('COMMIT')
    s.db.exec('PRAGMA wal_checkpoint(TRUNCATE)')
    s.close()
    realBytes = readFileSync(path)
  }
  return Buffer.from(realBytes)
}

const damage: Record<string, () => Buffer> = {
  'text that is not a database': () => Buffer.from('this is not a database. '.repeat(500)),
  'a real database with its header overwritten': () => {
    const b = Buffer.from(realHistoryBytes())
    b.write('XXXXXXXXXXXXXXXX', 0)
    return b
  },
  'a real database cut off in the middle of a page': () => realHistoryBytes().subarray(0, 4096 + 100),
  'a real database whose inner pages were overwritten': () => {
    const b = Buffer.from(realHistoryBytes())
    b.fill(0xff, 4096, 4096 * 4)
    return b
  },
}

/** The kept database files (their -wal and -shm companions are checked by name where they matter). */
const quarantined = (home: string) =>
  readdirSync(home).filter((f) => f.startsWith('history.sqlite.corrupt-') && !/-(wal|shm)$/.test(f))

const ownerNotices = (x: Harness) =>
  x.relay.frames.filter(
    (r) =>
      r.direction === 'from_bridge' &&
      r.raw.type === 'reply' &&
      (r.raw.message as { author?: string; text?: string }).author === 'system' &&
      /history/i.test((r.raw.message as { text: string }).text),
  )

describe('a history.sqlite the database cannot read', () => {
  for (const [name, make] of Object.entries(damage)) {
    test(
      `${name}: the bridge starts, keeps the file aside, tells the owner, and messages flow`,
      async () => {
        const home = tempHome('talos-hist-')
        const bad = make()
        writeFileSync(join(home, 'history.sqlite'), bad)
        h = await startHarness({ home })
        // the bad bytes are kept whole under a new name; nothing was deleted
        const kept = quarantined(home)
        expect(kept).toHaveLength(1)
        expect(readFileSync(join(home, kept[0] as string)).equals(bad)).toBe(true)
        // a fresh, working history took its place
        expect((h.bridge.ctx.store.db.query('PRAGMA quick_check').get() as Record<string, string>).quick_check).toBe(
          'ok',
        )
        // the owner is told, in a message the app shows, naming the kept file
        await waitFor(() => ownerNotices(h as Harness).length === 1, 5000, 'the owner notice')
        const [notice] = ownerNotices(h)
        const text = (notice?.raw.message as unknown as { text: string } | undefined)?.text ?? ''
        expect(text).toContain(kept[0] as string)
        // a message waiting for a thread's own session lived in the same file: the note says to send it again
        expect(text).toMatch(/thread[^.]*session[^.]*not (yet )?read[^.]*lost|not (yet )?read by a thread[^.]*lost/i)
        await waitFor(
          () => (h as Harness).bridge.ctx.store.kvGet('history_kept_aside') === undefined,
          5000,
          'the pending mark',
        )
        // messages still flow both ways
        await h.app.sendMessage('general', 'hello after the repair')
        await waitFor(
          () => (h as Harness).notes.some((n) => n.content.includes('hello after the repair')),
          5000,
          'the message',
        )
        const res = await h.bridge.callTool('reply', { thread_id: 'general', text: 'got it' })
        expect(res.isError).toBeFalsy()
        await h.relay.expectFrame('reply', (f) => f.message.text === 'got it', { direction: 'from_bridge' })
      },
      HARNESS_START_MS + t(60_000),
    )
  }

  test(
    'a stale -wal and -shm beside the bad file go aside with it, and are not replayed into the new history',
    async () => {
      const home = tempHome('talos-hist-')
      writeFileSync(join(home, 'history.sqlite'), Buffer.from('not a database. '.repeat(400)))
      writeFileSync(join(home, 'history.sqlite-wal'), Buffer.from('stale wal bytes '.repeat(300)))
      writeFileSync(join(home, 'history.sqlite-shm'), Buffer.alloc(32768))
      h = await startHarness({ home })
      const [kept] = quarantined(home)
      expect(kept).toBeDefined()
      expect(
        readdirSync(home)
          .filter((f) => f.startsWith(`${kept}-`))
          .sort(),
      ).toEqual([`${kept}-shm`, `${kept}-wal`])
      expect(existsSync(join(home, `${kept}-shm`))).toBe(true)
      expect((h.bridge.ctx.store.db.query('PRAGMA quick_check').get() as Record<string, string>).quick_check).toBe('ok')
    },
    HARNESS_START_MS + t(30_000),
  )

  test(
    'the notice is sent once: a restart on the repaired history says nothing more and keeps the same single file',
    async () => {
      const home = tempHome('talos-hist-')
      writeFileSync(join(home, 'history.sqlite'), Buffer.from('not a database. '.repeat(400)))
      h = await startHarness({ home })
      await waitFor(() => ownerNotices(h as Harness).length === 1, 5000, 'the owner notice')
      await h.stop()
      h = await startHarness({ home })
      await sleep(t(300)) // timing-ok: negative window, from the bridge authed (its ready, and the once-per-process notice check, have run): no second notice
      expect(ownerNotices(h)).toHaveLength(0)
      expect(quarantined(home)).toHaveLength(1)
    },
    HARNESS_START_MS * 2 + t(30_000),
  )

  test(
    'the notice survives a start that never reached the relay: it is sent at the next connection',
    async () => {
      const home = tempHome('talos-hist-')
      writeFileSync(join(home, 'history.sqlite'), Buffer.from('not a database. '.repeat(400)))
      h = await startHarness({ home, startBridge: false }) // created (history repaired) but never connected
      expect(quarantined(home)).toHaveLength(1)
      await h.bridge.stop()
      await h.app.close()
      await stopRelay(h.relay)
      h = await startHarness({ home })
      await waitFor(() => ownerNotices(h as Harness).length === 1, 5000, 'the owner notice')
    },
    HARNESS_START_MS * 2 + t(30_000),
  )

  test(
    'a history.sqlite that is NOT corrupt but cannot be opened is left exactly where it is, and the bridge refuses to start',
    async () => {
      const home = tempHome('talos-hist-')
      mkdirSync(join(home, 'history.sqlite')) // "unable to open database file": not damage, so nothing may be moved
      await expect(startHarness({ home })).rejects.toThrow(/EISDIR|directory/)
      expect(quarantined(home)).toHaveLength(0)
      expect(existsSync(join(home, 'history.sqlite'))).toBe(true)
    },
    HARNESS_START_MS + t(30_000),
  )
})

// ---- the rule: read through the OS, one whole-file check, search tables rebuilt, anything else kept aside ---------------

const NOW = Date.now()
const message = (i: number): MessageT => ({
  id: `m_hist${String(i).padStart(6, '0')}`,
  thread_id: 'general',
  author: i % 2 ? 'agent' : 'owner',
  kind: 'text',
  text: `history message ${i} about the quarterly plan`,
  format: 'plain',
  attachments: [],
  via: 'app',
  created_at: new Date(NOW - (3000 - i) * 1000).toISOString(),
})

/**
 * A real, healthy history: 2000 messages (indexed for search), seen ids, worker routes, three indexed files, and a free list
 * (a big table made and dropped), checkpointed so the main file holds everything.
 */
/**
 * A healthy history at `path`: 2000 messages, seen ids, routes, search files. Built for real once per process, then copied:
 * the same bytes for every test, without 2000 indexed inserts each time (tens of them per file).
 */
let healthyBytes: Buffer | undefined
function buildHealthy(path: string) {
  if (!healthyBytes) {
    const tmp = join(tempHome('talos-hist-healthy-'), 'history.sqlite')
    buildHealthyOnce(tmp)
    healthyBytes = readFileSync(tmp)
  }
  writeFileSync(path, healthyBytes)
}
function buildHealthyOnce(path: string) {
  const s = openHistory(path)
  new WorkerStore(s.db)
  s.db.exec('BEGIN')
  for (let i = 0; i < 2000; i++) s.addMessage(message(i))
  for (let i = 0; i < 100; i++) s.markSeen(`seen-${i}`, NOW - i * 1000)
  for (let i = 0; i < 30; i++)
    s.db
      .query(
        'INSERT INTO worker_routes(message_id, thread_id, notification_json, woke_at, deadline_at, cold) VALUES (?,?,?,?,?,?)',
      )
      .run(`route-${i}`, 'general', '{}', 1, 2, 0)
  for (let i = 0; i < 3; i++)
    s.db
      .query('INSERT INTO fts_files(media_id, ord, state) VALUES (?,?,?)')
      .run(`md_search_file_${i}_abcdefghij`, i + 1, 'done')
  s.db.exec('CREATE TABLE junk(x)')
  for (let i = 0; i < 1500; i++) s.db.query('INSERT INTO junk VALUES (?)').run('y'.repeat(500))
  s.db.exec('COMMIT')
  s.db.exec('DROP TABLE junk')
  s.db.exec('PRAGMA wal_checkpoint(TRUNCATE)')
  s.close()
}

const PAGE = 4096
/** Overwrites one page of the file with 0xff: real damage, on that page only. */
function smashPage(path: string, page: number) {
  const fd = openSync(path, 'r+')
  writeSync(fd, Buffer.alloc(PAGE, 0xff), 0, PAGE, (page - 1) * PAGE)
  closeSync(fd)
}
const rootOf = (path: string, name: string) => {
  const db = new Database(path)
  try {
    return (db.query('SELECT rootpage AS r FROM sqlite_master WHERE name = ?').get(name) as { r: number }).r
  } finally {
    db.close()
  }
}
/** What `quick_check` does on this file: its rows, or the SQLite code it threw. */
function checkOutcome(path: string): { rows?: string[]; code?: string } {
  const db = new Database(path)
  try {
    return { rows: (db.query('PRAGMA quick_check').all() as Array<{ quick_check: string }>).map((r) => r.quick_check) }
  } catch (e) {
    return { code: (e as { code?: string }).code ?? 'unknown' }
  } finally {
    db.close()
  }
}

/** What `quick_check` and then FTS5's own `integrity-check` of the search index do on this file (the check is rolled back). */
function indexCheckOutcome(path: string): { rows?: string[]; code?: string; fts?: string } {
  const outcome: { rows?: string[]; code?: string; fts?: string } = checkOutcome(path)
  const db = new Database(path)
  try {
    db.exec('BEGIN')
    db.run("INSERT INTO msg_fts(msg_fts) VALUES('integrity-check')")
    outcome.fts = 'ok'
  } catch (e) {
    outcome.fts = (e as { code?: string }).code ?? 'unknown'
  } finally {
    if (db.inTransaction) db.exec('ROLLBACK')
    db.close()
  }
  return outcome
}

/**
 * Garbles 40 bytes inside one block of the search index until the check answers the way `accept` wants, and returns that
 * answer. The damage is by structure, not by file offset: each block of FTS5's own data table (`msg_fts_data`, the segment
 * blocks, ids above the averages (1) and structure (10) records) is read through SQL, its bytes are found in the file by
 * content, and only those payload bytes are overwritten, so every page header and cell stays well formed and the damage is
 * in the search index alone. (Writing at fixed page offsets assumed one SQLite's page layout: on a newer one, Bun's bundled
 * 3.51+ on Linux or 3.54 here, the bytes landed in the b-tree. SQL cannot write the block itself: Bun opens databases in
 * defensive mode, where FTS5's shadow tables "may not be modified".) Each try is put back unless it is the damage wanted.
 */
function garbleSearchIndex<O extends { rows?: string[]; code?: string }>(
  path: string,
  accept: (o: O) => boolean,
  check: (path: string) => O = checkOutcome as (path: string) => O,
  offsets: number[] = [200, 2000],
): O {
  const blocks = (() => {
    const db = new Database(path)
    try {
      return (
        db.query('SELECT block AS b FROM msg_fts_data WHERE id > 10 ORDER BY id').all() as Array<{ b: Uint8Array }>
      ).map((r) => Buffer.from(r.b))
    } finally {
      db.close()
    }
  })()
  const file = readFileSync(path)
  const fd = openSync(path, 'r+')
  try {
    for (const block of blocks)
      for (const want of offsets) {
        if (block.length < 128) continue
        const at = Math.min(want, block.length - 64)
        // 64 bytes of the block, found once in the file: where its payload lies, whatever page it is on
        const needle = block.subarray(at, at + 64)
        const pos = file.indexOf(needle)
        if (pos < 0 || file.indexOf(needle, pos + 1) >= 0) continue
        const was = Buffer.alloc(40)
        readSync(fd, was, 0, 40, pos)
        writeSync(fd, Buffer.alloc(40, 0xff), 0, 40, pos)
        const outcome = check(path)
        if (accept(outcome)) return outcome
        writeSync(fd, was, 0, 40, pos)
      }
  } finally {
    closeSync(fd)
  }
  throw new Error('no search block could be damaged in that way')
}
/**
 * quick_check's answer when the damage is in the search index and nowhere else: every line names the FTS5 index msg_fts. SQLite
 * words it differently by version (3.44-3.50: "malformed inverted index for FTS5 table main.msg_fts"; newer, e.g. 3.54:
 * 'fts5: corruption found reading blob N from table "msg_fts"'), so the lines are matched by what they name, not their words.
 * The bridge itself never reads these lines (history-recover.ts drops the search tables and checks again).
 */
const ftsOnly = (rows: readonly string[] | undefined): boolean =>
  Array.isArray(rows) &&
  rows.length > 0 &&
  rows.every((r) => /\bmsg_fts\b/.test(r) && /fts5/i.test(r) && !/\bmessages\b/.test(r))
/**
 * `PRAGMA quick_check` checks FTS5 tables from SQLite 3.44.0 on. Bun uses the system SQLite on macOS, and macOS 15 ships 3.43.2:
 * there a damaged search index answers `ok`, so these cases cannot make the damage they test (garbleSearchIndex finds no page).
 * They are skipped there, by name of the condition, and run wherever the SQLite is newer (Linux, a newer macOS).
 */
const sqliteVersion = (() => {
  const db = new Database(':memory:')
  try {
    return (db.query('SELECT sqlite_version() AS v').get() as { v: string }).v
  } finally {
    db.close()
  }
})()
const atLeast = (v: string, min: string) => {
  const a = v.split('.').map(Number)
  const b = min.split('.').map(Number)
  for (let i = 0; i < 3; i++) if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) > (b[i] ?? 0)
  return true
}
const FTS5_IN_QUICK_CHECK = atLeast(sqliteVersion, '3.44.0')
const ftsTest = FTS5_IN_QUICK_CHECK ? test : test.skip
/** The search index's own check runs only where quick_check does not cover FTS5 (before 3.44.0): its seam is reached only there. */
const indexCheckTest = FTS5_IN_QUICK_CHECK ? test.skip : test
const freeTrunk = (path: string) => readFileSync(path).readUInt32BE(32)

const noticeText = (x: Harness) => {
  const [n] = ownerNotices(x)
  return (n?.raw.message as unknown as { text: string } | undefined)?.text ?? ''
}
const count = (x: Harness, table: string) =>
  (x.bridge.ctx.store.db.query(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n

describe('what is moved and what is not', () => {
  test(
    'a healthy 2000-message history is opened as it is: nothing is moved, nothing is lost, the owner hears nothing',
    async () => {
      const home = tempHome('talos-hist-')
      buildHealthy(join(home, 'history.sqlite'))
      h = await startHarness({ home })
      await sleep(t(300)) // timing-ok: negative window, from the bridge authed (its ready has run): nothing moved, no notice
      expect(quarantined(home)).toHaveLength(0)
      expect(count(h, 'messages')).toBe(2000)
      expect(h.bridge.ctx.store.hasSeen('seen-99')).toBe(true)
      expect(ownerNotices(h)).toHaveLength(0)
    },
    HARNESS_START_MS + t(30_000),
  )

  test('a read error on one page of the file (EIO, every time) moves nothing and refuses to start', () => {
    const home = tempHome('talos-hist-')
    const path = join(home, 'history.sqlite')
    buildHealthy(path)
    const before = readFileSync(path)
    const badPage = 5
    const eio: typeof readSync = ((fd: number, buf: Buffer, off: number, len: number, pos: number) => {
      if (pos <= (badPage - 1) * PAGE && (badPage - 1) * PAGE < pos + len)
        throw Object.assign(new Error('EIO: i/o error, read'), { code: 'EIO' })
      return readSync(fd, buf, off, len, pos)
    }) as typeof readSync
    for (let attempt = 0; attempt < 2; attempt++)
      expect(() => openHistoryOrKeepAside(path, nullLogger, NOW, { readAt: eio })).toThrow(/EIO/)
    expect(quarantined(home)).toHaveLength(0)
    expect(readFileSync(path).equals(before)).toBe(true)
  })

  test(
    'a file the account cannot read (no permission) moves nothing and the bridge refuses to start',
    async () => {
      const home = tempHome('talos-hist-')
      const path = join(home, 'history.sqlite')
      buildHealthy(path)
      const before = readFileSync(path)
      chmodSync(path, 0o000)
      try {
        await expect(startHarness({ home, startBridge: false })).rejects.toThrow(/EACCES|permission/i)
      } finally {
        chmodSync(path, 0o600)
      }
      expect(quarantined(home)).toHaveLength(0)
      expect(readFileSync(path).equals(before)).toBe(true)
    },
    HARNESS_START_MS + t(30_000),
  )

  const keptAside: Array<[string, (path: string) => number]> = [
    ['sqlite_sequence (what numbers messages)', (p) => rootOf(p, 'sqlite_sequence')],
    ['worker_routes (what hands a message to a thread session)', (p) => rootOf(p, 'worker_routes')],
    ['a free-list trunk page', (p) => freeTrunk(p)],
    ['the messages table', (p) => rootOf(p, 'messages')],
  ]
  for (const [name, page] of keptAside) {
    test(
      `damage to ${name} keeps the file aside, tells the owner, and messages flow`,
      async () => {
        const home = tempHome('talos-hist-')
        const path = join(home, 'history.sqlite')
        buildHealthy(path)
        const target = page(path)
        expect(target).toBeGreaterThan(1)
        smashPage(path, target)
        const bad = readFileSync(path)
        h = await startHarness({ home })
        const [kept] = quarantined(home)
        expect(kept).toBeDefined()
        expect(readFileSync(join(home, kept as string)).equals(bad)).toBe(true)
        await waitFor(() => ownerNotices(h as Harness).length === 1, 5000, 'the owner notice')
        expect(h.bridge.ctx.store.hasSeen('seen-0')).toBe(false) // a new, empty history took its place
        await h.app.sendMessage('general', 'hello after the repair')
        await waitFor(
          () => (h as Harness).notes.some((n) => n.content.includes('hello after the repair')),
          5000,
          'the message',
        )
      },
      HARNESS_START_MS + t(40_000),
    )
  }

  ftsTest(
    'damage inside the search index alone rebuilds search, moves nothing and loses no message',
    async () => {
      const home = tempHome('talos-hist-')
      const path = join(home, 'history.sqlite')
      buildHealthy(path)
      const outcome = garbleSearchIndex(path, (o) => ftsOnly(o.rows))
      expect(ftsOnly(outcome.rows)).toBe(true) // the check names the search index and nothing else
      h = await startHarness({ home })
      expect(quarantined(home)).toHaveLength(0)
      expect(count(h, 'messages')).toBe(2000)
      expect(h.bridge.ctx.store.hasSeen('seen-0')).toBe(true)
      const search = h.bridge.ctx.search as unknown as { tick(): boolean }
      await waitFor(
        () => {
          search.tick()
          return !h?.bridge.ctx.store.kvGet('search_dirty')
        },
        10_000,
        'the search rebuild',
      )
      expect(count(h, 'msg_fts')).toBe(2000)
      expect(h.bridge.ctx.store.db.query('PRAGMA quick_check').all()).toEqual([{ quick_check: 'ok' }])
      expect(ownerNotices(h)).toHaveLength(0)
    },
    HARNESS_START_MS + t(35_000),
  )

  // Not skipped anywhere: the damage is made, and found, the same way on every SQLite version.
  test(
    'search damage that quick_check does not see (SQLite before 3.44) is found by the index check, and only search is rebuilt',
    async () => {
      const home = tempHome('talos-hist-')
      const path = join(home, 'history.sqlite')
      buildHealthy(path)
      const before = new Database(path)
      const messagesBefore = before.query('SELECT * FROM messages ORDER BY rowid').all()
      before.close()
      const outcome = garbleSearchIndex(
        path,
        // the file is sound apart from the search index (a newer quick_check names it, an older one says ok), and the index check fails
        (o) => (JSON.stringify(o.rows) === '["ok"]' || ftsOnly(o.rows)) && o.fts === 'SQLITE_CORRUPT_VTAB',
        indexCheckOutcome,
        [200, 2000, PAGE - 600, PAGE - 200],
      )
      if (!FTS5_IN_QUICK_CHECK) expect(outcome.rows).toEqual(['ok']) // the gap this check closes, proven on this SQLite
      const garbled = new Database(path)
      expect(garbled.query('SELECT * FROM messages ORDER BY rowid').all()).toEqual(messagesBefore) // the damage is search only
      garbled.close()
      // the start's own check repairs it (not a later weekly rebuild): it says so, and leaves the rebuild queued
      const warned: string[] = []
      const opened = openHistoryOrKeepAside(path, { ...nullLogger, warn: (m: string) => warned.push(m) }, NOW, {})
      expect(opened.keptAs).toBeUndefined()
      expect(warned).toContain('search tables were damaged; dropped, a rebuild is queued')
      expect(opened.store.kvGet('search_dirty')).toBe('1')
      opened.store.close()
      h = await startHarness({ home })
      expect(quarantined(home)).toHaveLength(0)
      expect(count(h, 'messages')).toBe(2000)
      expect(h.bridge.ctx.store.hasSeen('seen-0')).toBe(true)
      const search = h.bridge.ctx.search as unknown as { tick(): boolean }
      await waitFor(
        () => {
          search.tick()
          return !h?.bridge.ctx.store.kvGet('search_dirty')
        },
        10_000,
        'the search rebuild',
      )
      expect(count(h, 'msg_fts')).toBe(2000)
      expect(() => h?.bridge.ctx.store.db.run("INSERT INTO msg_fts(msg_fts) VALUES('integrity-check')")).not.toThrow()
      expect(ownerNotices(h)).toHaveLength(0)
    },
    HARNESS_START_MS + t(35_000),
  )

  test(
    'search damage that cannot be dropped counts as any other damage: the file is kept aside',
    async () => {
      const home = tempHome('talos-hist-')
      const path = join(home, 'history.sqlite')
      buildHealthy(path)
      smashPage(path, rootOf(path, 'msg_fts_data'))
      h = await startHarness({ home })
      expect(quarantined(home)).toHaveLength(1)
      await waitFor(() => ownerNotices(h as Harness).length === 1, 5000, 'the owner notice')
    },
    HARNESS_START_MS + t(30_000),
  )

  ftsTest(
    'garbled search data that makes the check itself throw (not "corrupt") rebuilds search and moves nothing',
    async () => {
      const home = tempHome('talos-hist-')
      const path = join(home, 'history.sqlite')
      buildHealthy(path)
      const outcome = garbleSearchIndex(
        path,
        (o) => o.code !== undefined && !['SQLITE_NOTADB', 'SQLITE_CORRUPT'].includes(o.code),
      )
      expect(outcome.code).toBeDefined()
      const plain = openHistory(path) // an ordinary open of this file works: the messages are fine
      expect((plain.db.query('SELECT COUNT(*) AS n FROM messages').get() as { n: number }).n).toBe(2000)
      plain.close()
      h = await startHarness({ home })
      expect(quarantined(home)).toHaveLength(0)
      expect(count(h, 'messages')).toBe(2000)
      const search = h.bridge.ctx.search as unknown as { tick(): boolean }
      await waitFor(
        () => {
          search.tick()
          return !h?.bridge.ctx.store.kvGet('search_dirty')
        },
        10_000,
        'the search rebuild',
      )
      expect(count(h, 'msg_fts')).toBe(2000)
      expect(ownerNotices(h)).toHaveLength(0)
    },
    HARNESS_START_MS + t(35_000),
  )

  ftsTest(
    'the search rebuild mark is set in the same transaction as the drop, so a crash cannot leave search empty and unqueued',
    () => {
      const home = tempHome('talos-hist-')
      const path = join(home, 'history.sqlite')
      buildHealthy(path)
      garbleSearchIndex(path, (o) => ftsOnly(o.rows))
      expect(dropSearchTables(path)).toBe(true)
      // read the file without openHistory: the drop and the mark are all that happened
      const db = new Database(path)
      try {
        expect(db.query("SELECT 1 FROM sqlite_master WHERE name = 'msg_fts'").get()).toBeNull()
        expect((db.query("SELECT value FROM kv WHERE key = 'search_dirty'").get() as { value: string }).value).toBe('1')
      } finally {
        db.close()
      }
    },
  )

  ftsTest(
    'if the rebuild mark cannot be written, the drop is undone: search is never left empty with no rebuild queued',
    () => {
      const home = tempHome('talos-hist-')
      const path = join(home, 'history.sqlite')
      buildHealthy(path)
      garbleSearchIndex(path, (o) => ftsOnly(o.rows))
      const db = new Database(path)
      db.exec('DROP TABLE kv') // the mark has nowhere to go
      db.close()
      expect(dropSearchTables(path)).toBe(false)
      const after = new Database(path)
      try {
        expect(after.query("SELECT 1 FROM sqlite_master WHERE name = 'msg_fts'").get()).not.toBeNull() // still there
      } finally {
        after.close()
      }
    },
  )

  // SQLite's errors as Bun throws them: `errno` always (the extended code), `code` only for codes it names. A plain SQLITE_ERROR
  // has errno 1 and NO code.
  const sqliteError = (errno: number, code?: string) =>
    Object.assign(new Error(code ?? `errno ${errno}`), { errno }, code ? { code } : {})
  const E = {
    plain: () => sqliteError(1),
    perm: () => sqliteError(3, 'SQLITE_PERM'),
    busy: () => sqliteError(5, 'SQLITE_BUSY'),
    locked: () => sqliteError(6, 'SQLITE_LOCKED'),
    nomem: () => sqliteError(7, 'SQLITE_NOMEM'),
    readonly: () => sqliteError(8, 'SQLITE_READONLY'),
    ioerr: () => sqliteError(10, 'SQLITE_IOERR'),
    ioerrVnode: () => sqliteError(10 | (27 << 8), 'SQLITE_IOERR_VNODE'),
    corrupt: () => sqliteError(11, 'SQLITE_CORRUPT'),
    corruptVtab: () => sqliteError(11 | (1 << 8), 'SQLITE_CORRUPT_VTAB'),
    full: () => sqliteError(13, 'SQLITE_FULL'),
    cantopen: () => sqliteError(14, 'SQLITE_CANTOPEN'),
    protocol: () => sqliteError(15, 'SQLITE_PROTOCOL'),
    auth: () => sqliteError(23, 'SQLITE_AUTH'),
    notadb: () => sqliteError(26, 'SQLITE_NOTADB'),
    notSqlite: () => new TypeError('not from SQLite'),
    // a file-system error as Bun throws it: a negative errno, and a code that is not SQLite's
    fsEacces: () => Object.assign(new Error('EACCES: permission denied'), { errno: -13, code: 'EACCES' }),
    fsEio: () => Object.assign(new Error('EIO: i/o error'), { errno: -5, code: 'EIO' }),
    misuse: () => sqliteError(21, 'SQLITE_MISUSE'),
    schema: () => sqliteError(17, 'SQLITE_SCHEMA'),
    interrupt: () => sqliteError(9, 'SQLITE_INTERRUPT'),
  } as const
  type Kind = keyof typeof E | 'ok' | 'not ok'

  /** The start check's query, answering `kinds` in turn; records each call. */
  function query(kinds: Kind[]) {
    const seen: Kind[] = []
    let i = 0
    return {
      seen,
      quickCheck: () => {
        const k = kinds[Math.min(i++, kinds.length - 1)] as Kind
        seen.push(k)
        if (k === 'ok') return [{ quick_check: 'ok' }]
        if (k === 'not ok') return [{ quick_check: '*** in database main ***' }]
        throw E[k]()
      },
    }
  }
  const fresh = () => {
    const home = tempHome('talos-hist-')
    const path = join(home, 'history.sqlite')
    buildHealthy(path)
    return { home, path, before: readFileSync(path) }
  }
  const noWait = () => {}

  test('an error that says nothing about the content never moves a healthy file: the start is refused and the bytes stay', () => {
    for (const k of [
      'perm',
      'readonly',
      'ioerr',
      'ioerrVnode',
      'full',
      'cantopen',
      'protocol',
      'auth',
      'busy',
      'locked',
      'notSqlite',
      'fsEacces',
      'fsEio',
      'misuse',
      'schema',
      'interrupt',
    ] as const) {
      const f = fresh()
      let repairs = 0
      const hooks = { quickCheck: query([k]).quickCheck, sleep: noWait, dropSearch: () => (repairs++, true) }
      expect(() => openHistoryOrKeepAside(f.path, nullLogger, NOW, hooks), k).toThrow()
      expect(repairs, k).toBe(0)
      expect(quarantined(f.home), k).toHaveLength(0)
      expect(readFileSync(f.path).equals(f.before), k).toBe(true)
    }
  })

  test('a refused start says why, with the code, and that the history was left alone (the Mac shows this line)', () => {
    for (const [k, code] of [
      ['readonly', 'SQLITE_READONLY'],
      ['plainPerm', 'SQLITE_PERM'],
      ['fsEacces', 'not a SQLite error'],
    ] as const) {
      const f = fresh()
      const kind = k === 'plainPerm' ? 'perm' : k
      expect(
        () => openHistoryOrKeepAside(f.path, nullLogger, NOW, { quickCheck: query([kind]).quickCheck, sleep: noWait }),
        k,
      ).toThrow(new RegExp(`could not be checked \\(${code}: .*\\); it was left as it is`))
    }
    // a code Bun does not name (errno only) is named from the number
    const f = fresh()
    const unnamed = () => {
      throw Object.assign(new Error('attempt to write a readonly database'), { errno: 8 | (1 << 8) })
    }
    expect(() => openHistoryOrKeepAside(f.path, nullLogger, NOW, { quickCheck: unnamed, sleep: noWait })).toThrow(
      /\(SQLITE_READONLY: attempt/,
    )
  })

  test('a passing error (busy, locked, I/O, a WAL lock, memory) is tried again after a short wait; others are refused at once', () => {
    for (const k of ['busy', 'locked', 'ioerr', 'protocol', 'nomem'] as const) {
      const f = fresh()
      const waits: number[] = []
      const q = query([k, k, 'ok'])
      const opened = openHistoryOrKeepAside(f.path, nullLogger, NOW, {
        quickCheck: q.quickCheck,
        sleep: (ms) => waits.push(ms),
      })
      expect(q.seen, k).toEqual([k, k, 'ok'])
      expect(waits, k).toEqual([250, 1000])
      expect(opened.keptAs, k).toBeUndefined()
      opened.store.close()
    }
    const f = fresh()
    const q = query(['perm', 'ok'])
    expect(() => openHistoryOrKeepAside(f.path, nullLogger, NOW, { quickCheck: q.quickCheck, sleep: noWait })).toThrow()
    expect(q.seen).toEqual(['perm'])
  })

  test('content errors (corrupt, not a database, a plain SQL error, out of memory every time) go to the repair, then aside', () => {
    for (const k of ['corrupt', 'corruptVtab', 'notadb', 'plain', 'nomem', 'not ok'] as const) {
      // the repair fixes it (damage only in search): the history opens as it is, nothing moved
      let f = fresh()
      let opened = openHistoryOrKeepAside(f.path, nullLogger, NOW, {
        quickCheck: query([k]).quickCheck,
        sleep: noWait,
        dropSearch: () => true,
      })
      expect(opened.keptAs, k).toBeUndefined()
      opened.store.close()
      // the repair cannot fix it: the file is kept aside and the bridge starts, never refused for good
      f = fresh()
      opened = openHistoryOrKeepAside(f.path, nullLogger, NOW, {
        quickCheck: query([k]).quickCheck,
        sleep: noWait,
        dropSearch: () => false,
      })
      expect(opened.keptAs, k).toBeDefined()
      opened.store.close()
    }
  })

  indexCheckTest(
    'the search index check: only a corrupt answer is damage; a passing error or one not about the file refuses; others skip it',
    () => {
      const run = (k: Kind, dropSearch: () => boolean = () => true) => {
        const f = fresh()
        let repairs = 0
        const seen: Kind[] = []
        const hooks = {
          sleep: noWait,
          dropSearch: () => (repairs++, dropSearch()),
          ftsCheck: () => {
            seen.push(k)
            if (k !== 'ok') throw E[k as keyof typeof E]()
          },
        }
        let opened: ReturnType<typeof openHistoryOrKeepAside> | undefined
        let threw: unknown
        try {
          opened = openHistoryOrKeepAside(f.path, nullLogger, NOW, hooks)
        } catch (e) {
          threw = e
        }
        const out = {
          threw,
          repairs,
          keptAs: opened?.keptAs,
          moved: quarantined(f.home).length,
          seen,
          same: readFileSync(f.path).equals(f.before),
        }
        opened?.store.close()
        return out
      }
      // the index answers that it is damaged: the search repair runs, and nothing is moved when it works
      for (const k of ['corrupt', 'corruptVtab'] as const) {
        const r = run(k)
        expect([r.threw, r.repairs, r.keptAs, r.moved], k).toEqual([undefined, 1, undefined, 0])
      }
      // out of memory every time is read as the content, as from quick_check
      expect(run('nomem').repairs).toBe(1)
      // a passing error is tried again (three checks in all), then the start is refused; not about the file: refused at once
      for (const k of ['busy', 'locked', 'ioerr', 'ioerrVnode', 'protocol'] as const) {
        const r = run(k)
        expect([r.threw !== undefined, r.repairs, r.moved, r.same, r.seen.length], k).toEqual([true, 0, 0, true, 3])
      }
      for (const k of [
        'perm',
        'readonly',
        'cantopen',
        'auth',
        'full',
        'interrupt',
        'schema',
        'misuse',
        'notSqlite',
        'fsEacces',
        'fsEio',
      ] as const) {
        const r = run(k)
        expect([r.threw !== undefined, r.repairs, r.moved, r.same, r.seen.length], k).toEqual([true, 0, 0, true, 1])
      }
      // anything else says nothing about the file (this SQLite has no FTS5: 'no such module', a plain error): the step is skipped
      // and the file, which quick_check found sound, opens as it is. Never a repair, never a move.
      for (const k of ['plain', 'notadb', 'ok'] as const) {
        const r = run(k, () => false)
        expect([r.threw, r.repairs, r.keptAs, r.moved], k).toEqual([undefined, 0, undefined, 0])
      }
    },
  )

  indexCheckTest(
    'the search index check runs in a transaction that is rolled back, waiting out a short write elsewhere',
    () => {
      const f = fresh()
      const inside: unknown[] = []
      const opened = openHistoryOrKeepAside(f.path, nullLogger, NOW, {
        sleep: noWait,
        ftsCheck: (db) => {
          inside.push(db.inTransaction, (db.query('PRAGMA busy_timeout').get() as { timeout: number }).timeout)
          db.run('CREATE TABLE written_by_the_check (x)') // anything the step wrote is rolled back
          db.run("INSERT INTO msg_fts(msg_fts) VALUES('integrity-check')")
        },
      })
      try {
        expect(inside).toEqual([true, 2000])
        expect(
          opened.store.db.query("SELECT name FROM sqlite_master WHERE name = 'written_by_the_check'").all(),
        ).toEqual([])
      } finally {
        opened.store.close()
      }
    },
  )

  test('a file that checked out is never moved for what comes after the check: a failing open refuses the start', () => {
    for (const k of ['plain', 'corrupt', 'fsEacces'] as const) {
      const f = fresh()
      const openExisting = () => {
        throw E[k]() // a migration bug on an older file, or anything else after the verdict
      }
      expect(
        () =>
          openHistoryOrKeepAside(f.path, nullLogger, NOW, {
            quickCheck: query(['ok']).quickCheck,
            sleep: noWait,
            openExisting,
          }),
        k,
      ).toThrow()
      expect(quarantined(f.home), k).toHaveLength(0)
      expect(readFileSync(f.path).equals(f.before), k).toBe(true)
    }
  })

  test('a lock that ends in a can-not-tell error after the retries still refuses, and moves nothing', () => {
    const f = fresh()
    const q = query(['busy', 'busy', 'ioerr'])
    expect(() => openHistoryOrKeepAside(f.path, nullLogger, NOW, { quickCheck: q.quickCheck, sleep: noWait })).toThrow()
    expect(q.seen).toEqual(['busy', 'busy', 'ioerr'])
    expect(quarantined(f.home)).toHaveLength(0)
  })

  test('a healthy file under a real lock (busy) is not damage: nothing is moved and the start is refused', () => {
    const home = tempHome('talos-hist-')
    const path = join(home, 'history.sqlite')
    buildHealthy(path)
    const before = readFileSync(path)
    const holder = new Database(path)
    holder.exec('PRAGMA locking_mode = EXCLUSIVE')
    holder.exec('BEGIN EXCLUSIVE') // another process holding the file: every other connection gets "database is locked"
    try {
      expect(() => openHistoryOrKeepAside(path, nullLogger, NOW)).toThrow(/locked|busy/i)
    } finally {
      holder.exec('ROLLBACK')
      holder.close()
    }
    expect(quarantined(home)).toHaveLength(0)
    expect(readFileSync(path).equals(before)).toBe(true)
  })

  test('a held -wal link left by a start that crashed is removed, and never put back beside the kept-aside file', () => {
    const home = tempHome('talos-hist-')
    const path = join(home, 'history.sqlite')
    writeFileSync(path, Buffer.from('not a database. '.repeat(400)))
    writeFileSync(`${path}-wal.held`, Buffer.from('a crashed start left this '.repeat(100)))
    // the Linux path (the only one that ever takes such links)
    const { store, keptAs } = openHistoryOrKeepAside(path, nullLogger, NOW, { platform: 'linux' })
    store.close()
    expect(keptAs).toBeDefined()
    expect(readdirSync(home).filter((f) => f.endsWith('.held'))).toEqual([])
    expect(existsSync(join(home, `${keptAs}-wal`))).toBe(false)
  })

  test('the -wal and -shm are held only on Linux, and only for a file a read-only check did not find healthy', () => {
    const home = tempHome('talos-hist-')
    const path = join(home, 'history.sqlite')
    const good = openHistory(path)
    good.close()
    const writer = new Database(path)
    writer.exec('PRAGMA journal_mode = WAL')
    writer.exec("INSERT INTO kv (key, value) VALUES ('live', '1')")
    try {
      // a healthy database another connection holds open, with its -wal: never linked, on any platform
      let holds = 0
      const opened = openHistoryOrKeepAside(path, nullLogger, NOW, { platform: 'linux', onHold: () => holds++ })
      opened.store.close()
      expect(opened.keptAs).toBeUndefined()
      expect(holds).toBe(0)
    } finally {
      writer.close()
    }
    const bad = join(home, 'bad.sqlite')
    writeFileSync(bad, Buffer.from('not a database. '.repeat(400)))
    let linux = 0
    openHistoryOrKeepAside(bad, nullLogger, NOW, { platform: 'linux', onHold: () => linux++ }).store.close()
    expect(linux).toBe(1)
    const bad2 = join(home, 'bad2.sqlite')
    writeFileSync(bad2, Buffer.from('not a database. '.repeat(400)))
    let mac = 0
    openHistoryOrKeepAside(bad2, nullLogger, NOW, { platform: 'darwin', onHold: () => mac++ }).store.close()
    expect(mac).toBe(0)
  })

  ftsTest('a drop that finds the file busy refuses the start instead of moving the file', () => {
    const home = tempHome('talos-hist-')
    const path = join(home, 'history.sqlite')
    buildHealthy(path)
    garbleSearchIndex(path, (o) => ftsOnly(o.rows))
    const before = readFileSync(path)
    const writer = new Database(path)
    writer.exec('BEGIN IMMEDIATE') // reads still work, a second writer is told "locked"
    try {
      expect(() => openHistoryOrKeepAside(path, nullLogger, NOW)).toThrow(/locked|busy/i)
    } finally {
      writer.exec('ROLLBACK')
      writer.close()
    }
    expect(quarantined(home)).toHaveLength(0)
    expect(readdirSync(home).filter((f) => f.endsWith('.held'))).toEqual([])
    expect(readFileSync(path).equals(before)).toBe(true)
  })

  test('the -wal is read through too: a read error there refuses the start and moves nothing', () => {
    const home = tempHome('talos-hist-')
    const path = join(home, 'history.sqlite')
    buildHealthy(path)
    writeFileSync(`${path}-wal`, Buffer.alloc(12_345, 1)) // a -wal with a size of its own
    const before = readFileSync(path)
    const eio: typeof readSync = ((fd: number, buf: Buffer, off: number, len: number, pos: number) => {
      if (fstatSync(fd).size === 12_345) throw Object.assign(new Error('EIO: i/o error, read'), { code: 'EIO' })
      return readSync(fd, buf, off, len, pos)
    }) as typeof readSync
    expect(() => openHistoryOrKeepAside(path, nullLogger, NOW, { readAt: eio })).toThrow(/EIO/)
    expect(quarantined(home)).toHaveLength(0)
    expect(readFileSync(path).equals(before)).toBe(true)
  })

  test(
    'a headless process never moves the file: it fails as before and leaves the bytes alone',
    async () => {
      const home = tempHome('talos-hist-')
      const bad = Buffer.from('not a database. '.repeat(400))
      writeFileSync(join(home, 'history.sqlite'), bad)
      await expect(startHarness({ home, startBridge: false, bridge: { headless: true } })).rejects.toThrow(
        /not a database/,
      )
      expect(quarantined(home)).toHaveLength(0)
      expect(readFileSync(join(home, 'history.sqlite')).equals(bad)).toBe(true)
    },
    HARNESS_START_MS + t(30_000),
  )

  test(
    'a thread-session process never moves the file either',
    async () => {
      const home = tempHome('talos-hist-')
      const bad = Buffer.from('not a database. '.repeat(400))
      writeFileSync(join(home, 'history.sqlite'), bad)
      await expect(
        startHarness({ home, startBridge: false, env: { TALOS_APP_BRIDGE: '0', TALOS_APP_WORKER_THREAD: 'general' } }),
      ).rejects.toThrow(/not a database/)
      expect(quarantined(home)).toHaveLength(0)
      expect(readFileSync(join(home, 'history.sqlite')).equals(bad)).toBe(true)
    },
    HARNESS_START_MS + t(30_000),
  )

  test('a full disk while the new history is made puts the damaged file back, so the next start tries again and tells the owner', () => {
    const home = tempHome('talos-hist-')
    const path = join(home, 'history.sqlite')
    const bad = Buffer.from('not a database. '.repeat(400))
    writeFileSync(path, bad)
    expect(() =>
      openHistoryOrKeepAside(path, nullLogger, NOW, {
        openFresh: () => {
          throw new Error('ENOSPC: no space left on device')
        },
      }),
    ).toThrow(/no space left/)
    expect(quarantined(home)).toHaveLength(0)
    expect(readFileSync(path).equals(bad)).toBe(true)
    const again = openHistoryOrKeepAside(path, nullLogger, NOW)
    expect(again.keptAs).toBeDefined()
    expect(again.store.kvGet('history_kept_aside')).toBe(again.keptAs as string)
    again.store.close()
  })
})

describe('the owner note and a message that comes twice', () => {
  test(
    'the note says what is lost and carries the exact line about a repeated message',
    async () => {
      const home = tempHome('talos-hist-')
      writeFileSync(join(home, 'history.sqlite'), Buffer.from('not a database. '.repeat(400)))
      h = await startHarness({ home })
      await waitFor(() => ownerNotices(h as Harness).length === 1, 5000, 'the owner notice')
      const text = noticeText(h)
      expect(text).toContain('A recent message may arrive at your agent a second time.')
      expect(text).toMatch(/not searchable/)
      expect(text).toMatch(/had not reached the app/)
      expect(text).toMatch(/card/)
    },
    HARNESS_START_MS + t(30_000),
  )

  test(
    'what the note warns about is real: a handled message the relay sends again is handled again after a keep-aside',
    async () => {
      const home = tempHome('talos-hist-')
      buildHealthy(join(home, 'history.sqlite'))
      h = await startHarness({ home })
      const frame = await h.app.buildMessage('general', 'run the export now')
      h.app.sendRaw(JSON.stringify(frame))
      await h.waitNotes(1)
      await h.bridge.stop()
      Bun.gc(true) // the stopped bridge's database handle must really be gone before its file is damaged and moved
      smashPage(join(home, 'history.sqlite'), rootOf(join(home, 'history.sqlite'), 'messages'))
      const env = loadEnv({
        TALOS_APP_HOME: home,
        TALOS_APP_RELAY_URL: h.relay.httpUrl,
        TALOS_APP_BRIDGE: '1',
      })
      const b2 = await Bridge.create({ env, logger: nullLogger, inbound: { settleMs: 20, maxSettleMs: 200 } })
      const notes: string[] = []
      b2.setEmit(async (n) => {
        notes.push(n.content)
      })
      try {
        b2.start()
        await waitFor(() => b2.client?.connected === true, 10_000, 'the second bridge to connect')
        h.relay.sendToBridge(frame as unknown as Record<string, unknown>)
        await h.app.sendMessage('general', 'canary after the repeat')
        await waitFor(() => notes.some((t) => t.includes('canary after the repeat')), 10_000, 'the canary')
        expect(notes.filter((t) => t.includes('run the export now'))).toHaveLength(1)
      } finally {
        await b2.stop()
      }
    },
    HARNESS_START_MS + t(75_000),
  )
})
