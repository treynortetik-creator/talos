// WP-V2 acceptance, bridge part (docs/V2-FEATURES.md V3.4): the FTS5 index in history.sqlite behind the signed
// `search.query`, its isolation from message writes, ranking, filters, query safety, context paging, the probe, signatures.
// Real stores and a real bridge with FakeRelay/FakeApp; 5,000 generated messages for the volume cases.
import { afterEach, describe, expect, test } from 'bun:test'
import { mkdirSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { type FrameOf, type MessageT, newId, newUlid, parseFrame } from '@talos-app/protocol'
import { mkFrame } from '@talos-app/testkit'
import { HistoryStore, openHistory } from '../src/history-store.ts'
import { createSearchService, indexerFor } from '../src/search/install.ts'
import { ReadError } from '../src/v2-seams.ts'
import { type Harness, sleep, startHarness, tempHome } from './helpers.ts'

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

const DAY = 24 * 3600_000
const ago = (ms: number) => new Date(Date.now() - ms).toISOString()
const mediaId = (n: number) => `md_${String(n).padStart(26, '0')}`
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
const att = (name: string, over: Record<string, unknown> = {}) => ({
  media_id: newId('md'),
  kind: 'file' as const,
  role: 'attachment' as const,
  mime: 'text/markdown',
  name,
  size: 10,
  sha256: 'a'.repeat(64),
  ...over,
})
const open = () => {
  const s = openHistory(join(tempHome(), 'h.sqlite'))
  stores.push(s)
  return s
}
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

// ---- isolation -------------------------------------------------------------------------------------------------

describe('isolation: a message write never fails because of search', () => {
  test('msg_fts dropped behind our back, then a write: the message is stored, search_dirty=1, reconcile rebuilds', async () => {
    const s = open()
    const svc = createSearchService(s)
    const a = msg({ text: 'alpha release' })
    s.addMessage(a)
    s.db.exec('DROP TABLE msg_fts')
    const b = msg({ text: 'beta release' })
    expect(() => s.addMessage(b)).not.toThrow()
    expect(s.page({ thread_id: 'general', limit: 10 }).messages.map((m) => m.id)).toEqual([a.id, b.id])
    expect(s.kvGet('search_dirty')).toBe('1')
    expect((await svc.query(q('release')).catch((e: ReadError) => e)) instanceof ReadError).toBe(true) // table gone
    while (svc.tick());
    expect(s.kvGet('search_dirty')).toBeUndefined()
    expect(ids(await svc.query(q('release')))).toEqual(expect.arrayContaining([a.id, b.id]))
  })

  test('a headless process opening the store with no FTS table creates it; one that fails goes quietly dirty', () => {
    const path = join(tempHome(), 'h.sqlite')
    const live = openHistory(path)
    stores.push(live)
    live.db.exec('DROP TABLE msg_fts')
    const headless = openHistory(path) // second opener: installSearchIndex recreates the table
    stores.push(headless)
    const m = msg({ text: 'written by a headless process' })
    expect(() => headless.addMessage(m)).not.toThrow()
    expect(headless.db.query("SELECT 1 FROM sqlite_master WHERE name='msg_fts'").get()).not.toBeNull()
    expect(headless.db.query('SELECT rowid FROM msg_fts WHERE msg_fts MATCH ?').all('"headless"')).toHaveLength(1)
  })

  test('a crash between commit and index: reconcile indexes the message by the high-water mark', async () => {
    const s = open()
    const svc = createSearchService(s)
    const lost = msg({ text: 'committed but never indexed' })
    s.db
      .query('INSERT INTO messages (id, thread_id, seq, created_at, author, json) VALUES (?, ?, ?, ?, ?, ?)')
      .run(lost.id, lost.thread_id, null, lost.created_at, lost.author, JSON.stringify(lost)) // no listener ran
    const next = msg({ text: 'indexed normally afterwards' })
    s.addMessage(next)
    expect(ids(await svc.query(q('committed')))).toEqual([])
    while (svc.tick());
    expect(ids(await svc.query(q('committed')))).toEqual([lost.id])
    expect(ids(await svc.query(q('afterwards')))).toEqual([next.id])
  })

  test('prune removes the pruned rows from the index', async () => {
    const s = open()
    const svc = createSearchService(s)
    const old = msg({ text: 'ancient pineapple', created_at: ago(100 * DAY) })
    const fresh = msg({ text: 'fresh pineapple' })
    s.addMessage(old)
    s.addMessage(fresh)
    s.pruneOld(Date.now())
    expect(ids(await svc.query(q('pineapple')))).toEqual([fresh.id])
  })

  test('HISTORY_DAYS=0 keeps old text searchable forever', async () => {
    const s = open()
    const svc = createSearchService(s)
    const old = msg({ text: 'year old walnut', created_at: ago(400 * DAY) })
    s.addMessage(old)
    s.pruneOld(Date.now(), { historyDays: 0 })
    expect(ids(await svc.query(q('walnut')))).toEqual([old.id])
  })
})

// ---- ranking, matching, filters, safety --------------------------------------------------------------------------

describe('ranking and match_in', () => {
  test('equal relevance: the newer hit first (relevance and newest)', async () => {
    const s = open()
    const svc = createSearchService(s)
    const old = msg({ text: 'quarterly roadmap', created_at: ago(40 * DAY) })
    const fresh = msg({ text: 'quarterly roadmap', created_at: ago(1 * DAY) })
    s.addMessage(old)
    s.addMessage(fresh)
    expect(ids(await svc.query(q('roadmap')))).toEqual([fresh.id, old.id])
    expect(ids(await svc.query(q('roadmap', { sort: 'newest' })))).toEqual([fresh.id, old.id])
  })

  test('the same word in an old and a new message: the new one first', async () => {
    const s = open()
    const svc = createSearchService(s)
    const old = msg({ text: 'we should talk about the budget today', created_at: ago(120 * DAY) })
    const fresh = msg({ text: 'we should talk about the budget today', created_at: ago(2 * DAY) })
    s.addMessage(old)
    s.addMessage(fresh)
    expect(ids(await svc.query(q('budget')))[0]).toBe(fresh.id)
  })

  test('match_in: transcript for a voice note, attachment_name for a file name, text otherwise, card for an event row', async () => {
    const s = open()
    const svc = createSearchService(s)
    const voice = msg({
      kind: 'voice_note',
      text: '',
      attachments: [att('note.m4a', { kind: 'voice_note', mime: 'audio/mp4' })],
      transcript: { text: 'remind me about the garden party', engine: 't', status: 'done' },
    })
    const file = msg({ kind: 'file', text: '', attachments: [att('garden-plan.md')] })
    const plain = msg({ text: 'the garden needs water' })
    const ev = msg({ author: 'hook', kind: 'event', via: 'hook', text: 'Garden sensor offline' })
    for (const m of [voice, file, plain, ev]) s.addMessage(m)
    const r = await svc.query(q('garden', { sort: 'newest' }))
    const by = Object.fromEntries(r.hits.map((x) => [x.message_id, x.match_in]))
    expect(by[voice.id]).toBe('transcript')
    expect(by[file.id]).toBe('attachment_name')
    expect(by[plain.id]).toBe('text')
    expect(by[ev.id]).toBe('card')
    const fileHit = r.hits.find((x) => x.message_id === file.id)
    expect(fileHit?.attachment?.name).toBe('garden-plan.md')
  })

  test('marks are offsets into the plain snippet; a sentinel typed into the source cannot forge one', async () => {
    const s = open()
    const svc = createSearchService(s)
    const long = `${'lorem ipsum '.repeat(40)}the Release notes are ready ${'dolor sit '.repeat(40)}`
    const a = msg({ text: long })
    const b = msg({ text: 'forged release mark' })
    s.addMessage(a)
    s.addMessage(b)
    const r = await svc.query(q('release'))
    expect(r.hits).toHaveLength(2)
    for (const hit of r.hits) {
      expect(hit.snippet.length).toBeLessThanOrEqual(320)
      expect(hit.snippet).not.toMatch(/[]/)
      expect(hit.marks.length).toBeGreaterThan(0)
      for (const [x, y] of hit.marks) expect(hit.snippet.slice(x, y).toLowerCase()).toBe('release')
    }
  })

  test('a transcript that arrives later is searchable', async () => {
    const s = open()
    const svc = createSearchService(s)
    const v = msg({ kind: 'voice_note', text: '', attachments: [att('v.m4a', { kind: 'voice_note' })] })
    s.addMessage(v)
    expect(ids(await svc.query(q('thermostat')))).toEqual([])
    s.updateTranscript(v.id, { text: 'turn the thermostat down', engine: 't', status: 'done' })
    const r = await svc.query(q('thermostat'))
    expect(ids(r)).toEqual([v.id])
    expect(r.hits[0]?.match_in).toBe('transcript')
  })

  test('a share is findable', async () => {
    const s = open()
    const svc = createSearchService(s)
    const share = msg({
      thread_id: 'inbox',
      via: 'share',
      text: 'saved for later',
      share_content: { title: 'Sourdough starter guide', url: 'https://example.com/bread' },
    })
    s.addMessage(share)
    expect(ids(await svc.query(q('sourdough')))).toEqual([share.id])
    expect(ids(await svc.query(q('sourdough', { filters: { ...F0, from: 'owner' } })))).toEqual([]) // shares: only under any
  })
})

describe('filters and query safety', () => {
  test('has_file excludes a message whose only attachment is a voice reply (or a voice note)', async () => {
    const s = open()
    const svc = createSearchService(s)
    const spoken = msg({
      author: 'agent',
      text: 'tomato soup recipe',
      attachments: [att('reply.mp3', { role: 'voice_reply', kind: 'audio' })],
    })
    const real = msg({
      text: 'tomato soup photo',
      attachments: [att('soup.png', { kind: 'image', mime: 'image/png' })],
    })
    const note = msg({ kind: 'voice_note', text: 'tomato note', attachments: [att('n.m4a', { kind: 'voice_note' })] })
    for (const m of [spoken, real, note]) s.addMessage(m)
    const withFile = await svc.query(q('tomato', { filters: { ...F0, has_file: true } }))
    expect(ids(withFile)).toEqual([real.id])
    const none = await svc.query(q('tomato', { filters: { ...F0, has_file: false } }))
    expect(ids(none).sort()).toEqual([spoken.id, note.id].sort())
  })

  test('thread, author and date filters', async () => {
    const s = open()
    const svc = createSearchService(s)
    const a = msg({ thread_id: 'general', text: 'cedar fence', created_at: ago(10 * DAY) })
    const b = msg({ thread_id: 'projects', author: 'agent', text: 'cedar fence', created_at: ago(2 * DAY) })
    const c = msg({ thread_id: 'projects', author: 'system', text: 'cedar fence', created_at: ago(1 * DAY) })
    for (const m of [a, b, c]) s.addMessage(m)
    const f = (over: Record<string, unknown>) => svc.query(q('cedar', { filters: { ...F0, ...over } })).then(ids)
    expect(await f({ thread_ids: ['projects'] })).toHaveLength(2)
    expect(await f({ from: 'owner' })).toEqual([a.id])
    expect((await f({ from: 'agent' })).sort()).toEqual([b.id, c.id].sort())
    expect((await f({ after: ago(3 * DAY) })).sort()).toEqual([b.id, c.id].sort())
    expect(await f({ before: ago(5 * DAY) })).toEqual([a.id])
  })

  test('a quote, NEAR( or a lone -x is literal or dropped, never a syntax error', async () => {
    const s = open()
    const svc = createSearchService(s)
    s.addMessage(msg({ text: 'say "hello" to NEAR( the door and -x marks' }))
    for (const text of [
      '"',
      'NEAR(',
      '-x',
      'a AND OR NOT',
      '"unclosed',
      'col:val',
      '*',
      '^x',
      'x"y',
      '()',
      '{a b}',
      '\u0000x',
      'x'.repeat(200),
    ])
      await expect(svc.query(q(text))).resolves.toBeDefined()
    expect((await svc.query(q('-x'))).hits).toEqual([]) // a NOT-only query is dropped, not an FTS5 error
    expect((await svc.query(q('door -zebra'))).hits).toHaveLength(1)
    expect((await svc.query(q('door -hello'))).hits).toHaveLength(0)
  })

  test('a cursor from another query is bad_query', async () => {
    const s = open()
    const svc = createSearchService(s)
    for (let i = 0; i < 5; i++) s.addMessage(msg({ text: `pear ${i}` }))
    const first = await svc.query(q('pear', { limit: 2 }))
    expect(first.next_cursor).not.toBeNull()
    await expect(svc.query(q('apple', { limit: 2, cursor: first.next_cursor }))).rejects.toMatchObject({
      code: 'bad_query',
    })
  })
})

const QUERY_VS_SCAN = 30 // a query may cost this many LIKE scans of the table; see the volume test

describe('volume: 5,000 generated messages', () => {
  test('answers for a small multiple of a scan of the same table, pages relevance (cap 200) and newest', async () => {
    const s = open()
    const svc = createSearchService(s)
    const words = ['alpha', 'bravo', 'charlie', 'delta', 'echo', 'foxtrot', 'golf', 'hotel']
    const all: MessageT[] = []
    s.db.transaction(() => {
      for (let i = 0; i < 5000; i++) {
        const m = msg({
          thread_id: i % 3 === 0 ? 'projects' : 'general',
          text: `${words[i % 8]} ${words[(i * 7) % 8]} note number ${i} about the ${i % 50 === 0 ? 'launch' : 'weekly'} plan`,
          created_at: ago((5000 - i) * 3600_000),
        })
        all.push(m)
        s.addMessage(m)
      }
    })()
    // No millisecond limit. The figure is the CPU time of one query, and the limit is a ratio to a plain LIKE scan of the
    // same 5,000 rows taken in the same run (the dumbest answer there is), so a busy machine moves both together. A query
    // that does extra work per hit or per row, or ranks every match before it pages, costs hundreds of scans; a good one costs
    // under ten (about nine measured, since it ranks and builds the page) and 30 is the limit. The lowest of several runs is used, and a miss is measured once more.
    const cpuOf = async (fn: () => unknown) => {
      let best = Number.POSITIVE_INFINITY
      for (let i = 0; i < 5; i++) {
        const a = process.cpuUsage()
        await fn()
        const d = process.cpuUsage(a)
        best = Math.min(best, (d.user + d.system) / 1000)
      }
      return best
    }
    const scan = () =>
      s.db.query("SELECT count(*) FROM messages WHERE json LIKE '%launch%' AND json LIKE '%plan%'").get()
    const ratio = async () => {
      const ref = Math.max(await cpuOf(scan), 0.05)
      const mine = await cpuOf(() => svc.query(q('launch plan', { limit: 50 })))
      return { ok: mine <= ref * QUERY_VS_SCAN, why: `query ${mine.toFixed(2)} ms, scan ${ref.toFixed(2)} ms` }
    }
    const first = await ratio()
    const verdict = first.ok ? first : await ratio()
    expect(verdict.ok, verdict.why).toBe(true)
    const r = await svc.query(q('launch plan', { limit: 50 }))
    expect(r.hits).toHaveLength(50)
    expect(r.total_estimate).toBeLessThanOrEqual(1000)
    expect(r.total_estimate).toBe(100)
    expect(r.index).toBe('ready')
    // every page of a relevance search is a distinct slice of the same ranking
    const seen = new Set(ids(r))
    const p2 = await svc.query(q('launch plan', { limit: 50, cursor: r.next_cursor }))
    for (const id of ids(p2)) expect(seen.has(id)).toBe(false)
    expect(p2.next_cursor).toBeNull()
    // newest: keyset on ord, newest first
    const n1 = await svc.query(q('weekly', { sort: 'newest', limit: 50 }))
    expect(n1.hits[0]?.message_id).toBe(all[4999]?.id)
    const n2 = await svc.query(q('weekly', { sort: 'newest', limit: 50, cursor: n1.next_cursor }))
    expect(n2.hits[0]?.created_at < (n1.hits[49]?.created_at ?? '')).toBe(true)
    expect(n1.total_estimate).toBe(1000)
    // frames parse
    expect(parseFrame({ ...mkFrame('search.results'), request_id: newUlid(), ...r }).ok).toBe(true)
  })

  test('the 1.5 s budget answers search_unavailable', async () => {
    const s = open()
    const svc = createSearchService(s, { budgetMs: -1 })
    s.addMessage(msg({ text: 'slow thing' }))
    await expect(svc.query(q('slow'))).rejects.toMatchObject({ code: 'search_unavailable' })
  })
})

describe('context paging by ord', () => {
  test('around_id, before_id and after_id page correctly and stay in the thread', async () => {
    const s = open()
    const svc = createSearchService(s)
    const list: MessageT[] = []
    for (let i = 0; i < 100; i++) {
      s.addMessage(msg({ thread_id: 'other', text: `noise ${i}` })) // interleaved: paging is by thread
      const m = msg({ text: `m${i}` })
      list.push(m)
      s.addMessage(m)
    }
    const hist = (extra: Record<string, unknown>) =>
      svc.history?.({ type: 'history.request', request_id: 'r', thread_id: 'general', limit: 50, ...extra } as never)
    const around = hist({ around_id: list[50]?.id })
    expect(around?.messages.map((m) => m.text)).toEqual(list.slice(25, 76).map((m) => m.text))
    expect(around?.hasMore).toBe(true)
    expect(around?.hasNewer).toBe(true)
    const older = hist({ before_id: around?.messages[0]?.id })
    expect(older?.messages.map((m) => m.text)).toEqual(list.slice(0, 25).map((m) => m.text))
    expect(older?.hasMore).toBe(false)
    const newer = hist({ after_id: around?.messages.at(-1)?.id, limit: 100 })
    expect(newer?.messages.map((m) => m.text)).toEqual(list.slice(76).map((m) => m.text))
    expect(newer?.hasNewer).toBe(false)
    expect(hist({ around_id: newId('m') })?.messages).toEqual([])
    const first = hist({ around_id: list[0]?.id })
    expect(first?.messages[0]?.text).toBe('m0')
    expect(first?.hasMore).toBe(false)
  })
})

// ---- the probe, the CLI, and the real bridge ------------------------------------------------------------------------

describe('probe and features', () => {
  test('no FTS5 (a shim fails the probe): not available, search/1 is not advertised, history stays fully working', async () => {
    const s = new HistoryStore(join(tempHome(), 'h.sqlite'))
    stores.push(s)
    const svc = createSearchService(s, { probe: () => false })
    expect(svc.available).toBe(false)
    expect(indexerFor(s)).toBeNull()
    expect(() => s.addMessage(msg())).not.toThrow()
    const { bridgeFeatures } = await import('../src/handshake.ts')
    expect(bridgeFeatures({ search: svc })).not.toContain('search/1')
    await expect(svc.query(q('x'))).rejects.toMatchObject({ code: 'search_unavailable' })
  })

  test('a real bridge advertises search/1 and answers a signed query from its own history', async () => {
    h = await startHarness()
    const hello = await h.relay.expectFrame('hello', (f) => f.role === 'bridge', { direction: 'from_bridge' })
    expect((hello.client as { features?: string[] }).features).toContain('search/1')
    const m = msg({ text: 'the launch checklist' })
    h.bridge.ctx.store.addMessage(m)
    const f = await h.app.sign(q('launch'))
    h.app.send(f)
    const res = await h.app.expectFrame('search.results', (x) => x.request_id === f.request_id, { direction: 'in' })
    expect(res.hits.map((x) => x.message_id)).toEqual([m.id])
    expect(parseFrame(res).ok).toBe(true)
  })

  test('a bad signature is sig_invalid and returns no results', async () => {
    h = await startHarness()
    h.bridge.ctx.store.addMessage(msg({ text: 'secret launch plan' }))
    const f = { ...q('launch'), device_id: h.app.device.deviceId, osig: 'A'.repeat(86) }
    h.relay.sendToBridge(f as never, { durable: false })
    await sleep(200)
    const err = h.relay.frames.find(
      (r) => r.direction === 'from_bridge' && r.raw.type === 'error' && r.raw.ref === f.id,
    )
    expect(err?.raw.code).toBe('sig_invalid')
    expect(h.relay.frames.filter((r) => r.direction === 'from_bridge' && r.raw.type === 'search.results')).toHaveLength(
      0,
    )
  })

  test('context paging through the relay: history.request around_id', async () => {
    h = await startHarness()
    const list: MessageT[] = []
    for (let i = 0; i < 6; i++) {
      const m = msg({ text: `c${i}` })
      list.push(m)
      h.bridge.ctx.store.addMessage(m)
    }
    const rid = newUlid()
    await h.app.sendHistoryRequest('general', { request_id: rid, around_id: list[3]?.id, limit: 4 })
    const page = await h.relay.expectFrame('history.page', (x) => x.request_id === rid, { direction: 'from_bridge' })
    expect(page.messages.map((m) => m.text)).toEqual(['c1', 'c2', 'c3', 'c4', 'c5'])
    expect(page.anchor_id).toBe(list[3]?.id)
    expect(page.has_newer).toBe(false)
    expect(page.has_more).toBe(true)
  })
})

describe('talos-app search reindex', () => {
  test('rebuilds the whole index and says how many messages', async () => {
    const { runCli } = await import('../src/cli.ts')
    const home = tempHome()
    const s = openHistory(join(home, 'history.sqlite'))
    for (let i = 0; i < 12; i++) s.addMessage(msg({ text: `reindex me ${i}` }))
    s.db.exec('DELETE FROM msg_fts') // a damaged index
    s.close()
    const lines: string[] = []
    const io = {
      out: (l: string) => lines.push(l),
      err: (l: string) => lines.push(l),
      prompt: async () => '',
      sleep: async () => {},
      now: () => Date.now(),
    }
    const code = await runCli(['search', 'reindex'], io, { TALOS_APP_HOME: home })
    expect(lines.join('\n')).not.toContain('talos-app')
    expect(code).toBe(0)
    expect(lines.join('\n')).toMatch(/12/)
    const again = openHistory(join(home, 'history.sqlite'))
    stores.push(again)
    expect(again.db.query('SELECT COUNT(*) AS n FROM msg_fts').get()).toEqual({ n: 12 })
  })
})

describe('file contents (P1)', () => {
  const setup = () => {
    const home = tempHome()
    const media = join(home, 'media')
    mkdirSync(media, { recursive: true })
    const s = openHistory(join(home, 'h.sqlite'))
    stores.push(s)
    const svc = createSearchService(s, { mediaDir: media, budgetMs: 30_000 })
    const put = (n: number, name: string, body: string | Buffer, over: Record<string, unknown> = {}) => {
      const path = join(media, `${mediaId(n)}${name.slice(name.lastIndexOf('.'))}`)
      writeFileSync(path, body)
      writeFileSync(join(media, `${mediaId(n)}.json`), JSON.stringify({ path }))
      return att(name, { media_id: mediaId(n), size: Buffer.byteLength(body), ...over })
    }
    return { home, media, s, svc, put }
  }

  test('a text file is findable by its contents, as attachment_text', async () => {
    const { s, svc, put } = setup()
    const m = msg({
      kind: 'file',
      text: '',
      attachments: [put(1, 'notes.md', '# Plan\nthe marmalade schedule is final')],
    })
    s.addMessage(m)
    expect(ids(await svc.query(q('marmalade')))).toEqual([])
    while (svc.tickFiles());
    const r = await svc.query(q('marmalade'))
    expect(ids(r)).toEqual([m.id])
    expect(r.hits[0]?.match_in).toBe('attachment_text')
    // a later message update keeps the file text in the index
    s.addMessage({ ...m, text: 'edited caption' })
    expect(ids(await svc.query(q('marmalade')))).toEqual([m.id])
  })

  test('only the first 200 KB, only small text files, never binary, never outside the media folder', async () => {
    const { home, s, svc, put } = setup()
    const big = `${'filler '.repeat(40_000)}lategroup`
    const outside = join(home, 'elsewhere.txt')
    writeFileSync(outside, 'outsideword lives here')
    const outsideRef = att('elsewhere.txt', { media_id: mediaId(5), size: 22, mime: 'text/plain' })
    writeFileSync(join(home, 'media', `${mediaId(5)}.json`), JSON.stringify({ path: outside }))
    const link = join(home, 'media', 'link.txt')
    symlinkSync(outside, link)
    writeFileSync(join(home, 'media', `${mediaId(6)}.json`), JSON.stringify({ path: link }))
    const linkRef = att('link.txt', { media_id: mediaId(6), size: 22, mime: 'text/plain' })
    const m = msg({
      kind: 'file',
      text: '',
      attachments: [
        put(2, 'big.txt', big.slice(0, 900_000), { mime: 'text/plain' }),
        put(3, 'bin.txt', Buffer.concat([Buffer.from('binaryword'), Buffer.from([0, 1, 2])]), { mime: 'text/plain' }),
        put(4, 'huge.log', 'hugeword', { mime: 'text/plain', size: 2 * 1024 * 1024 }),
        outsideRef,
        linkRef,
      ],
    })
    s.addMessage(m)
    while (svc.tickFiles());
    expect(ids(await svc.query(q('filler')))).toEqual([m.id])
    expect(ids(await svc.query(q('lategroup')))).toEqual([]) // past the first 200 KB
    expect(ids(await svc.query(q('binaryword')))).toEqual([])
    expect(ids(await svc.query(q('hugeword')))).toEqual([])
    expect(ids(await svc.query(q('outsideword')))).toEqual([]) // outside the media folder, even via a symlink
  })

  test('20 files per pass', async () => {
    const { s, svc, put } = setup()
    for (let i = 0; i < 45; i++)
      s.addMessage(
        msg({
          kind: 'file',
          text: '',
          attachments: [put(100 + i, `f${i}.txt`, `uniqueword${i}`, { mime: 'text/plain' })],
        }),
      )
    expect(svc.tickFiles()).toBe(true)
    const done = () => (s.db.query("SELECT COUNT(*) AS n FROM fts_files WHERE state = 'done'").get() as { n: number }).n
    expect(done()).toBe(20)
    expect(svc.tickFiles()).toBe(true)
    expect(done()).toBe(40)
    expect(svc.tickFiles()).toBe(false)
    expect(done()).toBe(45)
  })

  test('a full reindex finds the file text again', async () => {
    const { s, svc, put } = setup()
    const m = msg({ kind: 'file', text: '', attachments: [put(7, 'again.md', 'persimmon harvest')] })
    s.addMessage(m)
    while (svc.tickFiles());
    await indexerFor(s)?.rebuildAll()
    expect(ids(await svc.query(q('persimmon')))).toEqual([])
    while (svc.tickFiles());
    expect(ids(await svc.query(q('persimmon')))).toEqual([m.id])
  })
})

describe('buildFtsQuery under bun:sqlite (the bridge runtime, not Node)', () => {
  test('random input, lone surrogates included, never errors in a real MATCH and never escapes its literals', async () => {
    const { buildFtsQuery } = await import('@talos-app/protocol')
    const s = open()
    s.addMessage(msg({ text: 'alpha bravo' }))
    const alphabet = [
      'a',
      ' ',
      '"',
      '-',
      '*',
      '(',
      ')',
      ':',
      '^',
      'NEAR',
      'OR',
      'NOT',
      '😀',
      '\ud800',
      '\udc00',
      'card:x',
    ]
    let seed = 7
    const rnd = () => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff
      return seed / 0x7fffffff
    }
    for (let n = 0; n < 3000; n++) {
      let t = ''
      for (let k = 0, len = 1 + Math.floor(rnd() * 16); k < len; k++) t += alphabet[Math.floor(rnd() * alphabet.length)]
      const { match } = buildFtsQuery(t)
      if (match) expect(() => s.db.query('SELECT rowid FROM msg_fts WHERE msg_fts MATCH ?').all(match), t).not.toThrow()
    }
    // a cut at 200 never lands inside an emoji
    const cut = buildFtsQuery(`${'x'.repeat(199)}😀tail`)
    expect(cut.match).not.toMatch(/[\ud800-\udbff]"/)
  })
})
