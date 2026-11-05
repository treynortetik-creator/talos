// Re-check of PR #45 at edecc01: the chunked reindex racing the live indexer, the anchor-first byte fit, and fresh
// attempts on the surrogate sanitiser. Real stores (two connections = two processes' worth of state), the real bridge
// with FakeRelay/FakeApp. "(holds)" = probe passed; the rest FAIL on edecc01.
import { afterEach, describe, expect, test } from 'bun:test'
import { join } from 'node:path'
import { buildFtsQuery, type FrameOf, MAX_FRAME_BYTES, type MessageT, newId, newUlid } from '@talos-app/protocol'
import { mkFrame } from '@talos-app/testkit'
import { type HistoryStore, openHistory } from '../src/history-store.ts'
import { createSearchService, indexerFor } from '../src/search/install.ts'
import { type Harness, startHarness, tempHome } from './helpers.ts'

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
const q = (text: string) =>
  ({
    ...mkFrame('search.query'),
    request_id: newUlid(),
    q: text,
    filters: F0,
    sort: 'relevance',
    cursor: null,
    limit: 50,
  }) as unknown as FrameOf<'search.query'>
const open = (path: string) => {
  const s = openHistory(path)
  stores.push(s)
  return s
}
const ftsCount = (s: HistoryStore) =>
  (s.db.query('SELECT COUNT(DISTINCT rowid) AS n FROM msg_fts').get() as { n: number }).n

describe('the chunked reindex next to the live indexer', () => {
  test('FAILS: a reindex that starts while the live bridge is mid-pass loses rows for good (stale mark written after the drop)', async () => {
    const path = join(tempHome(), 'history.sqlite')
    const live = open(path)
    createSearchService(live) // the live bridge's indexer (ticks driven by hand below)
    live.db.transaction(() => {
      for (let i = 0; i < 6000; i++) live.addMessage(msg({ text: `row ${i} lemur` }))
    })()
    const A = indexerFor(live)
    if (!A) throw new Error('no indexer')
    // the live bridge is catching up (e.g. a dirty rebuild after an upgrade) and has reached ord 5000
    live.kvSet('search_dirty', '1')
    for (let i = 0; i < 10; i++) A.reconcile()
    expect(A.hwm()).toBe(5000)
    // `talos-app search reindex` runs in another process (its own connection and indexer)
    const cli = open(path)
    const B = indexerFor(cli)
    if (!B) throw new Error('no indexer')
    // Interleave at one statement boundary of A's pass: A has selected rows 5001..5500 (autocommit read, no txn open),
    // then the CLI's first reindex pass lands (rebuildAll's own first two steps: dirty=1, reconcile -> drop + rows 1..500).
    const orig = live.db.query.bind(live.db)
    let armed = true
    ;(live.db as unknown as { query: (sql: string) => unknown }).query = (sql: string) => {
      const st = orig(sql)
      if (!armed || !sql.startsWith('SELECT ord, json FROM messages WHERE ord > ? ORDER BY ord LIMIT ?')) return st
      return {
        all: (...a: unknown[]) => {
          const rows = (st.all as (...x: unknown[]) => unknown[])(...a)
          armed = false
          cli.kvSet('search_dirty', '1')
          B.reconcile()
          return rows
        },
      }
    }
    A.reconcile() // writes 5001..5500 into the NEW table, then hwm = 5500
    ;(live.db as unknown as { query: unknown }).query = orig
    while (B.reconcile()); // the CLI's rebuildAll carries on with its remaining passes (the loop after its first pass)
    while (A.reconcile());
    expect(A.dirty()).toBe('') // everything says "ready"...
    expect(ftsCount(live)).toBe(6000) // ...but 501..5000 were never indexed again
  })

  test('(holds) the reindex converges under a heavy concurrent writer and indexes every row once', async () => {
    const path = join(tempHome(), 'history.sqlite')
    const live = open(path)
    createSearchService(live)
    live.db.transaction(() => {
      for (let i = 0; i < 20_000; i++) live.addMessage(msg({ text: `seed ${i} okapi` }))
    })()
    const cli = open(path)
    const B = indexerFor(cli)
    if (!B) throw new Error('no indexer')
    let written = 0
    const n = await B.rebuildAll(async () => {
      for (let k = 0; k < 100; k++) live.addMessage(msg({ text: `during ${written++} okapi` })) // 100 writes per pause
    })
    expect(B.dirty()).toBe('')
    expect(n).toBe(20_000 + written)
    expect(ftsCount(live)).toBe(20_000 + written)
  })
})

describe('anchor-first byte fit', () => {
  test('FAILS: an anchor bigger than the frame cap is sent anyway (the real relay closes the bridge socket at maxPayload)', async () => {
    h = await startHarness()
    const before = msg({ text: 'before' })
    h.bridge.ctx.store.addMessage(before)
    // a long voice note: the bridge stores the transcript in BOTH text and transcript.text (inbound.ts onVoiceNote)
    const long = 'and then I said we should really think about the launch plan again '.repeat(2100) // ~140 KB
    const anchor = msg({ kind: 'voice_note', text: long, transcript: { text: long, engine: 'stt', status: 'done' } })
    h.bridge.ctx.store.addMessage(anchor)
    h.bridge.ctx.store.addMessage(msg({ text: 'after' }))
    const rid = newUlid()
    await h.app.sendHistoryRequest('general', { request_id: rid, around_id: anchor.id, limit: 50 })
    const page = await h.relay
      .expectFrame('history.page', (x) => x.request_id === rid, { direction: 'from_bridge', timeoutMs: 3000 })
      .catch(() => null)
    const hellos = h.relay.frames.filter((r) => r.direction === 'from_bridge' && r.raw.type === 'hello').length
    // FakeRelay (like the real relay, maxPayload = MAX_FRAME_BYTES) drops the bridge socket: the bridge reconnects and
    // the page is lost, so the context view spins until the app's 15 s timeout
    expect({ page: page !== null, bridgeReconnected: hellos > 1 }).toEqual({ page: true, bridgeReconnected: false })
    const rec = h.relay.frames.find(
      (r) => r.direction === 'from_bridge' && r.raw.type === 'history.page' && r.raw.request_id === rid,
    )
    expect(Buffer.byteLength(rec?.text ?? JSON.stringify(rec?.raw))).toBeLessThanOrEqual(MAX_FRAME_BYTES)
  })
})

describe('surrogate sanitiser, fresh attempts', () => {
  test('(holds) every random UTF-16 code-unit string builds a MATCH that bun:sqlite parses', () => {
    const { Database } = require('bun:sqlite') as typeof import('bun:sqlite')
    const db = new Database(':memory:')
    db.exec("CREATE VIRTUAL TABLE t USING fts5(text, card, tokenize = 'unicode61 remove_diacritics 2', prefix = '2 3')")
    db.exec("INSERT INTO t VALUES ('hello world', 'secretcard')")
    let seed = 0xbeef
    const rnd = () => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff
      return seed / 0x7fffffff
    }
    const hot = [0x22, 0x2d, 0x20, 0x2a, 0x3a, 0x28, 0xd800, 0xdbff, 0xdc00, 0xdfff, 0xfffd, 0xfeff, 0x0300]
    const bad: string[] = []
    for (let n = 0; n < 100_000; n++) {
      let s = ''
      const len = 1 + Math.floor(rnd() * 24)
      for (let k = 0; k < len; k++)
        s += String.fromCharCode(
          rnd() < 0.5 ? (hot[Math.floor(rnd() * hot.length)] as number) : Math.floor(rnd() * 0x10000),
        )
      const f = buildFtsQuery(s)
      if (!f.match) continue
      try {
        db.query('SELECT rowid FROM t WHERE t MATCH ?').all(f.match)
      } catch (e) {
        if (bad.length < 5) bad.push(`${JSON.stringify(s)} -> ${(e as Error).message}`)
      }
    }
    expect(bad).toEqual([])
  })

  test('(holds) the earlier injection and the 200-char emoji cut now answer, through the real service', async () => {
    const s = open(join(tempHome(), 'h.sqlite'))
    const svc = createSearchService(s, { budgetMs: 30_000 })
    s.addMessage(msg({ author: 'hook', kind: 'event', text: 'secretcard' }))
    expect((await svc.query(q('zz\uD800 OR card:secretcard OR zz\uD800'))).hits).toEqual([])
    expect((await svc.query(q('zz\uDC00" OR card:secretcard OR "\uDBFFx'))).hits).toEqual([])
    expect((await svc.query(q(`release ${'x'.repeat(191)}😀 more`))).hits).toEqual([])
  })
})

describe('poison rows, fresh attempt', () => {
  test('FAILS: a row that parses but has an odd shape (attachments: [null]) still empties the index forever', async () => {
    const s = open(join(tempHome(), 'h.sqlite'))
    const svc = createSearchService(s, { budgetMs: 30_000 })
    const good = msg({ text: 'pineapple upside down cake' })
    s.addMessage(good)
    const odd = msg({ text: 'odd' })
    s.db
      .query('INSERT INTO messages (id, thread_id, seq, created_at, author, json) VALUES (?, ?, ?, ?, ?, ?)')
      .run(odd.id, odd.thread_id, null, odd.created_at, odd.author, JSON.stringify({ ...odd, attachments: [null] }))
    for (let i = 0; i < 6; i++) svc.tick()
    const r = await svc.query(q('pineapple')).catch(() => ({ hits: [] as Array<{ message_id: string }> }))
    expect(r.hits.map((x) => x.message_id)).toEqual([good.id])
  })
})
