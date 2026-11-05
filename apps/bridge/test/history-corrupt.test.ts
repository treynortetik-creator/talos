// A history.sqlite the database cannot read used to stop the bridge at start-up (exit 1), so the owner's phone went quiet.
// Now the live bridge keeps the bad file beside the new one (never deletes it), starts with an empty history, tells the
// owner in the thread, and messages flow. The files here are really damaged, not mocked; so is the file that is NOT corrupt.

import { Database } from 'bun:sqlite'
import { afterEach, describe, expect, test } from 'bun:test'
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
import { Bridge } from '../src/bridge.ts'
import { loadEnv } from '../src/config.ts'
import { dropSearchTables, openHistoryOrKeepAside } from '../src/history-recover.ts'
import { openHistory } from '../src/history-store.ts'
import { nullLogger } from '../src/log.ts'
import { WorkerStore } from '../src/worker/store.ts'
import { type Harness, sleep, startHarness, stopRelay, tempHome, waitFor } from './helpers.ts'

let h: Harness | undefined
afterEach(async () => {
  await h?.stop()
  h = undefined
})

/** A real history.sqlite with enough rows to span several pages, checkpointed so the main file holds them all. */
function realHistoryBytes(): Buffer {
  const dir = tempHome('talos-hist-src-')
  const path = join(dir, 'history.sqlite')
  const s = openHistory(path)
  for (let i = 0; i < 600; i++) s.kvSet(`k${i}`, 'v'.repeat(300))
  s.db.exec('PRAGMA wal_checkpoint(TRUNCATE)')
  s.close()
  return readFileSync(path)
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
    test(`${name}: the bridge starts, keeps the file aside, tells the owner, and messages flow`, async () => {
      const home = tempHome('talos-hist-')
      const bad = make()
      writeFileSync(join(home, 'history.sqlite'), bad)
      h = await startHarness({ home })
      // the bad bytes are kept whole under a new name; nothing was deleted
      const kept = quarantined(home)
      expect(kept).toHaveLength(1)
      expect(readFileSync(join(home, kept[0] as string)).equals(bad)).toBe(true)
      // a fresh, working history took its place
      expect((h.bridge.ctx.store.db.query('PRAGMA quick_check').get() as Record<string, string>).quick_check).toBe('ok')
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
    })
  }

  test('a stale -wal and -shm beside the bad file go aside with it, and are not replayed into the new history', async () => {
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
  })

  test('the notice is sent once: a restart on the repaired history says nothing more and keeps the same single file', async () => {
    const home = tempHome('talos-hist-')
    writeFileSync(join(home, 'history.sqlite'), Buffer.from('not a database. '.repeat(400)))
    h = await startHarness({ home })
    await waitFor(() => ownerNotices(h as Harness).length === 1, 5000, 'the owner notice')
    await h.stop()
    h = await startHarness({ home })
    await sleep(300)
    expect(ownerNotices(h)).toHaveLength(0)
    expect(quarantined(home)).toHaveLength(1)
  })

  test('the notice survives a start that never reached the relay: it is sent at the next connection', async () => {
    const home = tempHome('talos-hist-')
    writeFileSync(join(home, 'history.sqlite'), Buffer.from('not a database. '.repeat(400)))
    h = await startHarness({ home, startBridge: false }) // created (history repaired) but never connected
    expect(quarantined(home)).toHaveLength(1)
    await h.bridge.stop()
    await h.app.close()
    await stopRelay(h.relay)
    h = await startHarness({ home })
    await waitFor(() => ownerNotices(h as Harness).length === 1, 5000, 'the owner notice')
  })

  test('a history.sqlite that is NOT corrupt but cannot be opened is left exactly where it is, and the bridge refuses to start', async () => {
    const home = tempHome('talos-hist-')
    mkdirSync(join(home, 'history.sqlite')) // "unable to open database file": not damage, so nothing may be moved
    await expect(startHarness({ home })).rejects.toThrow(/EISDIR|directory/)
    expect(quarantined(home)).toHaveLength(0)
    expect(existsSync(join(home, 'history.sqlite'))).toBe(true)
  })
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
function buildHealthy(path: string) {
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

/**
 * Garbles 40 bytes inside one data page of the search index, leaving the page itself well formed, until the check answers the
 * way `accept` wants. Returns that answer.
 */
function garbleSearchIndex(path: string, accept: (o: { rows?: string[]; code?: string }) => boolean) {
  const db = new Database(path)
  const pages = (
    db.query("SELECT pageno AS p FROM dbstat WHERE name = 'msg_fts_data' AND pagetype = 'leaf'").all() as Array<{
      p: number
    }>
  ).map((r) => r.p)
  db.close()
  const fd = openSync(path, 'r+')
  try {
    for (const page of pages)
      for (const offset of [200, 2000]) {
        const at = (page - 1) * PAGE + offset
        const was = Buffer.alloc(40)
        readSync(fd, was, 0, 40, at)
        writeSync(fd, Buffer.alloc(40, 0xff), 0, 40, at)
        const outcome = checkOutcome(path)
        if (accept(outcome)) return outcome
        writeSync(fd, was, 0, 40, at)
      }
  } finally {
    closeSync(fd)
  }
  throw new Error('no search page could be damaged in that way')
}
const FTS_ONLY = ['malformed inverted index for FTS5 table main.msg_fts']
const freeTrunk = (path: string) => readFileSync(path).readUInt32BE(32)

const noticeText = (x: Harness) => {
  const [n] = ownerNotices(x)
  return (n?.raw.message as unknown as { text: string } | undefined)?.text ?? ''
}
const count = (x: Harness, table: string) =>
  (x.bridge.ctx.store.db.query(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n

describe('what is moved and what is not', () => {
  test('a healthy 2000-message history is opened as it is: nothing is moved, nothing is lost, the owner hears nothing', async () => {
    const home = tempHome('talos-hist-')
    buildHealthy(join(home, 'history.sqlite'))
    h = await startHarness({ home })
    await sleep(300)
    expect(quarantined(home)).toHaveLength(0)
    expect(count(h, 'messages')).toBe(2000)
    expect(h.bridge.ctx.store.hasSeen('seen-99')).toBe(true)
    expect(ownerNotices(h)).toHaveLength(0)
  })

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

  test('a file the account cannot read (no permission) moves nothing and the bridge refuses to start', async () => {
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
  })

  const keptAside: Array<[string, (path: string) => number]> = [
    ['sqlite_sequence (what numbers messages)', (p) => rootOf(p, 'sqlite_sequence')],
    ['worker_routes (what hands a message to a thread session)', (p) => rootOf(p, 'worker_routes')],
    ['a free-list trunk page', (p) => freeTrunk(p)],
    ['the messages table', (p) => rootOf(p, 'messages')],
  ]
  for (const [name, page] of keptAside) {
    test(`damage to ${name} keeps the file aside, tells the owner, and messages flow`, async () => {
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
    })
  }

  test('damage inside the search index alone rebuilds search, moves nothing and loses no message', async () => {
    const home = tempHome('talos-hist-')
    const path = join(home, 'history.sqlite')
    buildHealthy(path)
    const outcome = garbleSearchIndex(path, (o) => JSON.stringify(o.rows) === JSON.stringify(FTS_ONLY))
    expect(outcome.rows).toEqual(FTS_ONLY) // the check names the search index and nothing else
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
  })

  test('search damage that cannot be dropped counts as any other damage: the file is kept aside', async () => {
    const home = tempHome('talos-hist-')
    const path = join(home, 'history.sqlite')
    buildHealthy(path)
    smashPage(path, rootOf(path, 'msg_fts_data'))
    h = await startHarness({ home })
    expect(quarantined(home)).toHaveLength(1)
    await waitFor(() => ownerNotices(h as Harness).length === 1, 5000, 'the owner notice')
  })

  test('garbled search data that makes the check itself throw (not "corrupt") rebuilds search and moves nothing', async () => {
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
  })

  test('the search rebuild mark is set in the same transaction as the drop, so a crash cannot leave search empty and unqueued', () => {
    const home = tempHome('talos-hist-')
    const path = join(home, 'history.sqlite')
    buildHealthy(path)
    garbleSearchIndex(path, (o) => JSON.stringify(o.rows) === JSON.stringify(FTS_ONLY))
    expect(dropSearchTables(path)).toBe(true)
    // read the file without openHistory: the drop and the mark are all that happened
    const db = new Database(path)
    try {
      expect(db.query("SELECT 1 FROM sqlite_master WHERE name = 'msg_fts'").get()).toBeNull()
      expect((db.query("SELECT value FROM kv WHERE key = 'search_dirty'").get() as { value: string }).value).toBe('1')
    } finally {
      db.close()
    }
  })

  test('if the rebuild mark cannot be written, the drop is undone: search is never left empty with no rebuild queued', () => {
    const home = tempHome('talos-hist-')
    const path = join(home, 'history.sqlite')
    buildHealthy(path)
    garbleSearchIndex(path, (o) => JSON.stringify(o.rows) === JSON.stringify(FTS_ONLY))
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

  test('a drop that finds the file busy refuses the start instead of moving the file', () => {
    const home = tempHome('talos-hist-')
    const path = join(home, 'history.sqlite')
    buildHealthy(path)
    garbleSearchIndex(path, (o) => JSON.stringify(o.rows) === JSON.stringify(FTS_ONLY))
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

  test('a headless process never moves the file: it fails as before and leaves the bytes alone', async () => {
    const home = tempHome('talos-hist-')
    const bad = Buffer.from('not a database. '.repeat(400))
    writeFileSync(join(home, 'history.sqlite'), bad)
    await expect(startHarness({ home, startBridge: false, bridge: { headless: true } })).rejects.toThrow(
      /not a database/,
    )
    expect(quarantined(home)).toHaveLength(0)
    expect(readFileSync(join(home, 'history.sqlite')).equals(bad)).toBe(true)
  })

  test('a thread-session process never moves the file either', async () => {
    const home = tempHome('talos-hist-')
    const bad = Buffer.from('not a database. '.repeat(400))
    writeFileSync(join(home, 'history.sqlite'), bad)
    await expect(
      startHarness({ home, startBridge: false, env: { TALOS_APP_BRIDGE: '0', TALOS_APP_WORKER_THREAD: 'general' } }),
    ).rejects.toThrow(/not a database/)
    expect(quarantined(home)).toHaveLength(0)
    expect(readFileSync(join(home, 'history.sqlite')).equals(bad)).toBe(true)
  })

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
  test('the note says what is lost and carries the exact line about a repeated message', async () => {
    const home = tempHome('talos-hist-')
    writeFileSync(join(home, 'history.sqlite'), Buffer.from('not a database. '.repeat(400)))
    h = await startHarness({ home })
    await waitFor(() => ownerNotices(h as Harness).length === 1, 5000, 'the owner notice')
    const text = noticeText(h)
    expect(text).toContain('A recent message may arrive at your agent a second time.')
    expect(text).toMatch(/not searchable/)
    expect(text).toMatch(/had not reached the app/)
    expect(text).toMatch(/card/)
  })

  test('what the note warns about is real: a handled message the relay sends again is handled again after a keep-aside', async () => {
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
  })
})
