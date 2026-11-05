// Adversarial review of WP-V2 search (PR #45). Every test here goes through a real seam: a real history.sqlite opened by
// `openHistory` (the indexer every process installs), the real bridge with FakeRelay/FakeApp, or the real CLI process.
// Tests named "(holds)" are probes that passed; the rest FAIL on the PR head and describe the bug in their name.
import { afterEach, describe, expect, test } from 'bun:test'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { type FrameOf, type MessageT, newId, newUlid } from '@talos-app/protocol'
import { mkFrame } from '@talos-app/testkit'
import { type HistoryStore, openHistory } from '../src/history-store.ts'
import { RECONCILE_BATCH } from '../src/search/indexer.ts'
import { createSearchService, indexerFor } from '../src/search/install.ts'
import { ReadError } from '../src/v2-seams.ts'
import { type Harness, sleep, startHarness, tempHome, waitFor } from './helpers.ts'

let h: Harness | undefined
const stores: HistoryStore[] = []
afterEach(async () => {
  await h?.stop()
  h = undefined
  for (const s of stores.splice(0)) {
    try {
      s.close()
    } catch {}
  }
})

const msg = (over: Partial<MessageT> = {}): MessageT => ({
  id: newId('m'),
  thread_id: 'general',
  author: 'owner',
  kind: 'text',
  text: 'hello',
  format: 'plain',
  attachments: [],
  via: 'app',
  created_at: new Date().toISOString(),
  ...over,
})
const F0 = { thread_ids: [], from: 'any', has_file: null, after: null, before: null } as const
const q = (text: string, over: Record<string, unknown> = {}) =>
  ({
    ...mkFrame('search.query'),
    request_id: newUlid(),
    q: text,
    filters: F0,
    sort: 'relevance',
    cursor: null,
    limit: 50,
    ...over,
  }) as unknown as FrameOf<'search.query'>
const ids = (r: { hits: Array<{ message_id: string }> }) => r.hits.map((x) => x.message_id)
const open = (path = join(tempHome(), 'h.sqlite')) => {
  const s = openHistory(path)
  stores.push(s)
  return s
}
const rawInsert = (s: HistoryStore, m: MessageT, json = JSON.stringify(m)) =>
  s.db
    .query('INSERT INTO messages (id, thread_id, seq, created_at, author, json) VALUES (?, ?, ?, ?, ?, ?)')
    .run(m.id, m.thread_id, null, m.created_at, m.author, json)

// ---- FTS5 query injection ------------------------------------------------------------------------------------------

describe('query safety in the bridge runtime (bun:sqlite), not just node:sqlite', () => {
  // bun:sqlite encodes a lone UTF-16 surrogate followed by `"` as ONE 4-byte UTF-8 sequence (F0 90 80 A2): the closing
  // quote of the FTS5 literal is swallowed, so what follows is parsed as FTS5 syntax. V0's property test runs in Node
  // (DatabaseSync), which does not do this, so it passes while the bridge fails.
  test('FAILS: a lone surrogate lets owner text escape the literal: `OR` and a `card:` column filter run as FTS5 syntax', async () => {
    const s = open()
    const svc = createSearchService(s, { budgetMs: 30_000 })
    const secret = msg({ author: 'hook', kind: 'event', text: 'secretcard rotation' })
    s.addMessage(secret)
    // Honest reading: every term must match, and nothing contains "zz". The injected reading is `... OR card:secretcard OR ...`.
    const r = await svc.query(q('zz\uD800 OR card:secretcard OR zz\uD800')).catch((e: ReadError) => e)
    expect(r instanceof ReadError ? `threw ${r.code}` : ids(r)).toEqual([])
  })

  test('FAILS: a 200+ character query whose cut lands inside an emoji is search_unavailable, not results', async () => {
    const s = open()
    const svc = createSearchService(s, { budgetMs: 30_000 })
    s.addMessage(msg({ text: 'plain text' }))
    // MAX_QUERY_CHARS slices UTF-16 code units: char 200 is the high half of the emoji, a lone surrogate before `"*`
    const long = `release ${'x'.repeat(191)}😀 more`
    expect(long.length).toBeGreaterThan(200)
    const r = await svc.query(q(long)).catch((e: ReadError) => e)
    expect(r instanceof ReadError ? r.code : 'answered').toBe('answered')
  })

  test('FAILS: property, random input (with lone surrogates) never errors through the real service', async () => {
    const s = open()
    const svc = createSearchService(s, { budgetMs: 30_000 })
    s.addMessage(msg({ text: 'alpha bravo café 😀 "quoted" NEAR minus' }))
    const alphabet = [
      'a',
      'é',
      ' ',
      '"',
      '-',
      '*',
      '(',
      ')',
      ':',
      '^',
      '{',
      '}',
      'NEAR',
      'OR',
      'NOT',
      '😀',
      '\uD800',
      '\uDC00',
      '́',
      '　',
    ]
    let seed = 0x5eed
    const rnd = () => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff
      return seed / 0x7fffffff
    }
    const failures: string[] = []
    for (let n = 0; n < 1500; n++) {
      let text = ''
      const len = 1 + Math.floor(rnd() * 14)
      for (let k = 0; k < len; k++) text += alphabet[Math.floor(rnd() * alphabet.length)]
      try {
        await svc.query(q(text))
      } catch (e) {
        failures.push(`${JSON.stringify(text)} -> ${(e as ReadError).code}`)
      }
    }
    expect(failures.slice(0, 5)).toEqual([])
  })

  test('FAILS: the same through the real bridge: a signed query with a split emoji answers search.results', async () => {
    h = await startHarness()
    h.bridge.ctx.store.addMessage(msg({ text: 'the launch checklist' }))
    const f = await h.app.sign(q(`launch ${'x'.repeat(192)}😀`))
    h.app.send(f)
    const answers = () =>
      h?.relay.frames.filter(
        (r) =>
          r.direction === 'from_bridge' &&
          ((r.raw.type === 'search.results' && r.raw.request_id === f.request_id) ||
            (r.raw.type === 'error' && r.raw.ref === f.id)),
      ) ?? []
    await waitFor(() => answers().length > 0, 4000, 'an answer to the query')
    const out = answers()
    expect(out.map((r) => (r.raw.type === 'error' ? `error:${r.raw.code}` : r.raw.type))).toEqual(['search.results'])
  })

  test('(holds) quotes, NEAR(, column filters, ^ and lone - stay literal without surrogates', async () => {
    const s = open()
    const svc = createSearchService(s, { budgetMs: 30_000 })
    s.addMessage(msg({ author: 'hook', kind: 'event', text: 'secretcard' }))
    for (const t of [
      'card:secretcard zz',
      'zz OR secretcard',
      '{card}:secretcard zz',
      'NEAR(zz secretcard)',
      '"zz" OR "secretcard"',
      '-',
      '"',
      '^secretcard zz',
    ])
      expect(ids(await svc.query(q(t))), t).toEqual([])
  })
})

// ---- isolation: the message write can never fail because of search -------------------------------------------------

// A full indexing pass may cost this many times the CPU of reading and parsing its rows (measured to be well under).
const PASS_VS_READ = 400

describe('isolation under a full reindex', () => {
  test('FAILS: `talos-app search reindex` holds the write lock for one long transaction; a live write meanwhile throws SQLITE_BUSY', async () => {
    const home = tempHome()
    const path = join(home, 'history.sqlite')
    const live = open(path) // the live bridge's connection (busy_timeout 5000, as in production)
    const words = 'release plan launch weekly notes meeting draft budget review agent search index bridge relay voice'
    const body = Array.from({ length: 14 }, () => words).join(' ')
    live.db.transaction(() => {
      for (let i = 0; i < 100_000; i++)
        rawInsert(
          live,
          msg({ text: `${body} n${i}`, created_at: new Date(Date.now() - (100_000 - i) * 60_000).toISOString() }),
        )
    })()
    const cli = Bun.spawn(['bun', join(import.meta.dir, '../src/cli.ts'), 'search', 'reindex'], {
      env: { ...process.env, TALOS_APP_HOME: home },
      stdout: 'pipe',
      stderr: 'pipe',
    })
    // wait until the CLI holds the write lock
    const probe = openHistory(path)
    stores.push(probe)
    probe.db.exec('PRAGMA busy_timeout = 0')
    let locked = false
    for (let i = 0; i < 200 && !locked; i++) {
      try {
        probe.db.exec('BEGIN IMMEDIATE')
        probe.db.exec('ROLLBACK')
        await sleep(25)
      } catch {
        locked = true
      }
    }
    expect(locked).toBe(true)
    let err = ''
    try {
      live.addMessage(msg({ text: 'an owner message arriving during the reindex' }))
    } catch (e) {
      err = (e as Error).message
    }
    await cli.exited
    // The write waited for the lock with the production busy_timeout (5 s) and got in. How long that took is not claimed
    // here: that the lock is only ever held for one bounded pass is claimed, and checked in the next test.
    expect(err).toBe('')
  }, 120_000)

  test('a reindex holds the write lock for one bounded pass at a time and lets go between passes', async () => {
    // Pinned as literals, not derived from RECONCILE_BATCH: raising the batch must fail this test, not move it along.
    // A live write waits on the lock for one whole pass, so the pass size is what bounds how long an owner message blocks.
    expect(RECONCILE_BATCH).toBeLessThanOrEqual(500)
    const rows = 1507 // three full passes of 500 and a short one
    const path = join(tempHome(), 'history.sqlite')
    const live = open(path)
    live.db.transaction(() => {
      for (let i = 0; i < rows; i++) rawInsert(live, msg({ text: `release plan n${i}` }))
    })()
    const probe = open(path)
    probe.db.exec('PRAGMA busy_timeout = 0') // a held lock is refused at once, so "free" means free
    const indexer = indexerFor(live)
    expect(indexer).not.toBeNull()
    if (!indexer) return
    // CPU time of each pass. `addMessage` is synchronous, so a live write cannot run until the pass ends: a pass that burns
    // seconds freezes the bridge. No millisecond limit; each full pass is held to a multiple of the CPU time of just
    // reading and parsing the same number of rows (a reference outside the indexer), measured in this run.
    const cpuMs = (fn: () => unknown) => {
      const a = process.cpuUsage()
      fn()
      const d = process.cpuUsage(a)
      return (d.user + d.system) / 1000
    }
    const readBatch = () => {
      for (const r of live.db.query('SELECT ord, json FROM messages ORDER BY ord LIMIT 500').all() as {
        json: string
      }[])
        JSON.parse(r.json)
    }
    let ref = Number.POSITIVE_INFINITY
    for (let i = 0; i < 5; i++) ref = Math.min(ref, cpuMs(readBatch))
    ref = Math.max(ref, 0.05)
    const passCpu: number[] = []
    const realReconcile = indexer.reconcile.bind(indexer)
    indexer.reconcile = (now?: Date) => {
      let more = false
      passCpu.push(cpuMs(() => (more = realReconcile(now))))
      return more
    }
    let pauses = 0
    const n = await indexer.rebuildAll(async () => {
      pauses++
      expect(live.db.inTransaction).toBe(false) // no transaction is open across a pause
      probe.db.exec('BEGIN IMMEDIATE') // so a live write could take the lock right now
      probe.db.exec('ROLLBACK')
    })
    expect(n).toBe(rows)
    expect(pauses).toBeGreaterThanOrEqual(3) // four passes, three gaps: one pass per batch, not one for all
    const worst = Math.max(...passCpu.slice(0, 3)) // the three full passes
    expect(
      worst,
      `worst full pass ${worst.toFixed(1)} ms of CPU, reading the same rows ${ref.toFixed(2)} ms`,
    ).toBeLessThanOrEqual(ref * PASS_VS_READ)
    const svc = createSearchService(live)
    expect((await svc.query(q('release plan', { limit: 1 }))).index).toBe('ready')
  })
})

describe('index drift and rebuilds', () => {
  test('FAILS: one row the indexer cannot parse empties the whole index forever (dirty -> drop -> fail -> dirty ...)', async () => {
    const s = open()
    const svc = createSearchService(s, { budgetMs: 30_000 })
    const good = msg({ text: 'pineapple upside down cake' })
    s.addMessage(good)
    expect(ids(await svc.query(q('pineapple')))).toEqual([good.id])
    rawInsert(s, msg({ text: 'x' }), '{"id": "m_broken", truncated') // a damaged row, written by anything but addMessage
    s.addMessage(msg({ text: 'after the bad row' }))
    for (let i = 0; i < 6; i++) svc.tick()
    expect(ids(await svc.query(q('pineapple')).catch(() => ({ hits: [] })))).toEqual([good.id])
  })

  test('FAILS: an edit that drops a text attachment keeps the old file contents searchable', async () => {
    const home = tempHome()
    const media = join(home, 'media')
    mkdirSync(media, { recursive: true })
    const s = open(join(home, 'h.sqlite'))
    const svc = createSearchService(s, { mediaDir: media, budgetMs: 30_000 })
    const mid = `md_${'0'.repeat(25)}1`
    const file = join(media, `${mid}.md`)
    writeFileSync(file, 'the quetzalcoatl itinerary')
    writeFileSync(join(media, `${mid}.json`), JSON.stringify({ path: file }))
    const m = msg({
      kind: 'file',
      text: 'see attached',
      attachments: [
        {
          media_id: mid,
          kind: 'file',
          role: 'attachment',
          mime: 'text/markdown',
          name: 'trip.md',
          size: 26,
          sha256: 'a'.repeat(64),
        },
      ],
    })
    s.addMessage(m)
    while (svc.tickFiles());
    expect(ids(await svc.query(q('quetzalcoatl')))).toEqual([m.id])
    s.addMessage({ ...m, text: 'see attached (removed the file)', attachments: [] })
    expect(ids(await svc.query(q('quetzalcoatl')))).toEqual([])
  })

  test('(holds) an edit replaces the indexed text; a later transcript replaces the old one', async () => {
    const s = open()
    const svc = createSearchService(s, { budgetMs: 30_000 })
    const m = msg({ text: 'original wording' })
    s.addMessage(m)
    s.addMessage({ ...m, text: 'replacement wording' })
    expect(ids(await svc.query(q('original')))).toEqual([])
    expect(ids(await svc.query(q('replacement')))).toEqual([m.id])
    const v = msg({ kind: 'voice_note', text: '', transcript: { text: 'first pass', engine: 'x', status: 'done' } })
    s.addMessage(v)
    s.updateTranscript(v.id, { text: 'second pass', engine: 'x', status: 'done' })
    expect(ids(await svc.query(q('first')))).toEqual([])
    expect(ids(await svc.query(q('second')))).toEqual([v.id])
  })

  test('(holds) a dirty rebuild while a headless process writes: every message indexed exactly once, flag cleared', async () => {
    const path = join(tempHome(), 'h.sqlite')
    const live = open(path)
    const svc = createSearchService(live, { budgetMs: 30_000 })
    live.db.transaction(() => {
      for (let i = 0; i < 1600; i++) live.addMessage(msg({ text: `bulk row ${i} marmot` }))
    })()
    const headless = open(path) // a second process: its own connection and its own indexer
    live.kvSet('search_dirty', '1')
    svc.tick() // drop + first 500
    for (let i = 0; i < 30; i++) headless.addMessage(msg({ text: `headless write ${i} marmot` }))
    svc.tick()
    headless.db.exec('DROP TABLE msg_fts') // and someone drops the table mid-rebuild
    headless.addMessage(msg({ text: 'written while the table is gone marmot' }))
    for (let i = 0; i < 20 && svc.tick(); i++);
    while (svc.tick());
    const n = (live.db.query('SELECT COUNT(*) AS n FROM messages').get() as { n: number }).n
    const f = live.db.query('SELECT COUNT(*) AS n, COUNT(DISTINCT rowid) AS d FROM msg_fts').get() as {
      n: number
      d: number
    }
    expect(f).toEqual({ n, d: n })
    expect(live.kvGet('search_dirty')).toBeUndefined()
    const r = await svc.query(q('marmot', { sort: 'newest', limit: 50 }))
    expect(r.total_estimate).toBe(1000) // capped; the point is that it answers
    expect(r.index).toBe('ready')
  })

  test('(holds) prune with HISTORY_DAYS=90 leaves no orphan rows; HISTORY_DAYS=0 prunes nothing', async () => {
    const s = open()
    createSearchService(s)
    for (let i = 0; i < 50; i++)
      s.addMessage(msg({ text: `row ${i}`, created_at: new Date(Date.now() - i * 4 * 86_400_000).toISOString() }))
    expect(s.pruneOld(Date.now(), { historyDays: 0 }).messages).toBe(0)
    s.pruneOld(Date.now(), { historyDays: 90 })
    const orphans = s.db.query('SELECT COUNT(*) AS n FROM msg_fts WHERE rowid NOT IN (SELECT ord FROM messages)').get()
    expect(orphans).toEqual({ n: 0 })
  })
})

// ---- the context view's page through the real bridge ---------------------------------------------------------------

describe('context paging through the real bridge', () => {
  test('FAILS: around_id in a thread of long replies drops the anchor itself (the byte cut keeps the newest end)', async () => {
    h = await startHarness()
    const list: MessageT[] = []
    for (let i = 0; i < 51; i++) {
      const m = msg({
        author: i % 2 ? 'agent' : 'owner',
        text: `${i === 25 ? 'THE ANCHOR ' : ''}${'long agent answer '.repeat(700)}`,
      }) // ~12.6 KB each
      list.push(m)
      h.bridge.ctx.store.addMessage(m)
    }
    const anchor = list[25] as MessageT
    const rid = newUlid()
    await h.app.sendHistoryRequest('general', { request_id: rid, around_id: anchor.id, limit: 50 })
    const page = await h.relay.expectFrame('history.page', (x) => x.request_id === rid, { direction: 'from_bridge' })
    expect(page.anchor_id).toBe(anchor.id)
    expect(page.messages.map((m) => m.id)).toContain(anchor.id)
  })
})

describe('paging with a time filter (bridge half of the web bug)', () => {
  test('(holds, as designed) a cursor is refused when `after` moved by a few ms; the web recomputes `after` on Show more', async () => {
    const s = open()
    const svc = createSearchService(s, { budgetMs: 30_000 })
    for (let i = 0; i < 60; i++) s.addMessage(msg({ text: `weekly transfer ${i}` }))
    const after = new Date(Date.now() - 7 * 86_400_000).toISOString()
    const p1 = await svc.query(q('transfer', { filters: { ...F0, after } }))
    expect(p1.next_cursor).not.toBeNull()
    const moved = new Date(Date.parse(after) + 35).toISOString()
    await expect(
      svc.query(q('transfer', { filters: { ...F0, after: moved }, cursor: p1.next_cursor })),
    ).rejects.toMatchObject({ code: 'bad_query' })
  })
})
