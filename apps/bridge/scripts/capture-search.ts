#!/usr/bin/env bun
// The search capture (docs/V2-FEATURES.md V8, WP-V2): `bun run capture:search [--check]`.
// It runs the REAL bridge (live, in process) against testkit's FakeRelay and FakeApp, over a fixed generated conversation,
// sends signed `search.query` and `history.request` frames, and writes every answer the bridge sent as JSON in
// packages/testkit/fixtures/captured/search/ (ids, timestamps and signatures normalised). The web specs replay these frames
// and never hand-write an answer. `--check` re-runs the capture and fails if what is committed differs.
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { type MessageT, newUlid } from '@talos-app/protocol'
import { mkFrame } from '@talos-app/testkit'
import { createSearchService } from '../src/search/install.ts'
import { type Harness, startHarness } from '../test/helpers.ts'

const HERE = dirname(fileURLToPath(import.meta.url))
export const CAPTURE_DIR = join(HERE, '..', '..', '..', 'packages', 'testkit', 'fixtures', 'captured', 'search')
/** The "now" every ranking is computed at. */
const NOW = Date.parse('2026-10-29T18:00:00Z')

const mid = (n: number) => `m_${String(n).padStart(26, '0')}`
const fid = (n: number) => `md_${String(n).padStart(26, '0')}`
const at = (daysAgo: number, hour = 14) => new Date(NOW - daysAgo * 86_400_000 + (hour - 18) * 3600_000).toISOString()
const att = (n: number, name: string, over: Record<string, unknown> = {}) => ({
  media_id: fid(n),
  kind: 'file',
  role: 'attachment',
  mime: 'text/markdown',
  name,
  size: 120,
  sha256: 'b'.repeat(64),
  ...over,
})
const m = (n: number, over: Partial<MessageT>): MessageT => ({
  id: mid(n),
  thread_id: 'projects',
  author: 'owner',
  kind: 'text',
  format: 'plain',
  attachments: [],
  via: 'app',
  created_at: at(1),
  ...over,
})

/** A fixed conversation. Generic content only. */
const DATA: MessageT[] = [
  m(1, { text: 'Can you draft the release notes for v0.3?', created_at: at(2, 14) }),
  m(2, {
    author: 'agent',
    text: 'Draft is ready. The release notes cover search, health and driving mode.',
    created_at: at(2, 14),
  }),
  m(3, { text: 'Add a line about the release party.', created_at: at(1, 9) }),
  m(4, {
    author: 'agent',
    text: 'Done. I also looked at <img src=x onerror=alert(1)> in the old release page; it is plain text here.',
    created_at: at(1, 9),
  }),
  m(5, {
    thread_id: 'general',
    kind: 'file',
    text: '',
    attachments: [att(5, 'release-notes.md')],
    created_at: at(1, 10),
  }),
  m(6, {
    thread_id: 'inbox',
    kind: 'voice_note',
    text: '',
    attachments: [att(6, 'note.m4a', { kind: 'voice_note', mime: 'audio/mp4' })],
    transcript: { text: 'remind me about the release party on Friday', engine: 'fixture', status: 'done' },
    created_at: at(3, 8),
  }),
  m(7, {
    thread_id: 'inbox',
    author: 'hook',
    kind: 'event',
    via: 'hook',
    text: 'Release pipeline finished',
    created_at: at(0, 7),
  }),
  m(8, {
    text: 'Tomato soup recipe photo',
    attachments: [att(8, 'soup.png', { kind: 'image', mime: 'image/png' })],
    created_at: at(20),
  }),
  m(9, {
    author: 'agent',
    text: 'Spoken answer about the garden.',
    attachments: [att(9, 'reply.mp3', { role: 'voice_reply', kind: 'audio', mime: 'audio/mpeg' })],
    created_at: at(5),
  }),
  m(10, { text: 'Water the garden before the release party.', created_at: at(40) }),
]
// a longer chat in one thread so the context view has something to page
const CHAT: MessageT[] = Array.from({ length: 60 }, (_, i) =>
  m(100 + i, {
    thread_id: 'general',
    author: i % 2 === 0 ? 'owner' : 'agent',
    text: i === 30 ? 'The needle is in this message.' : `Chat line ${i}.`,
    created_at: new Date(NOW - (60 - i) * 3600_000).toISOString(),
  }),
)

type Json = Record<string, unknown>
const norm = (o: unknown, top = true): unknown => {
  if (Array.isArray(o)) return o.map((x) => norm(x, false))
  if (o && typeof o === 'object') {
    const out: Json = {}
    for (const [k, v] of Object.entries(o as Json)) {
      if (top && ['id', 'ts', 'relay', 'osig', 'device_id'].includes(k)) continue
      if (k === 'request_id') out[k] = 'REQ'
      else if (k === 'ref') out[k] = 'REF'
      else if (k === 'took_ms') out[k] = 1
      else out[k] = norm(v, false)
    }
    return out
  }
  return o
}

async function ask(h: Harness, label: string, frame: Json, want: 'search.results' | 'history.page' | 'error') {
  const before = h.relay.frames.length
  if (want === 'history.page') {
    h.app.send(await h.app.sign({ ...mkFrame('history.request'), ...frame } as never))
  } else {
    const f = await h.app.sign({ ...mkFrame('search.query'), ...frame } as never)
    h.app.send(f)
  }
  for (let i = 0; i < 100; i++) {
    await new Promise((r) => setTimeout(r, 50))
    if (h.relay.frames.slice(before).some((x) => x.direction === 'from_bridge' && x.raw.type === want)) break
  }
  const out = h.relay.frames
    .slice(before)
    .filter((x) => x.direction === 'from_bridge' && (x.raw.type === want || x.raw.type === 'error'))
    .map((x) => norm(x.raw))
  return { label, request: norm(frame), sent_by_bridge: out }
}

const F0 = { thread_ids: [], from: 'any', has_file: null, after: null, before: null }
const sq = (q: string, over: Json = {}) => ({
  request_id: newUlid(),
  q,
  filters: F0,
  sort: 'relevance',
  cursor: null,
  limit: 50,
  ...over,
})

async function capture(): Promise<Record<string, string>> {
  const h = await startHarness()
  try {
    const store = h.bridge.ctx.store
    const svc = createSearchService(store, { now: () => NOW })
    h.bridge.ctx.search = svc
    for (const x of [...DATA, ...CHAT]) store.addMessage(x)
    const files: Record<string, Json> = {}
    const put = (file: string, title: string, steps: Json[]) => {
      files[file] = { scenario: file.replace('.json', ''), title, steps }
    }
    put('01-relevance.json', 'A query ranks recent-and-relevant first; each hit says where it matched', [
      await ask(h, 'release', sq('release'), 'search.results'),
    ])
    const first = await ask(
      h,
      'release newest, 2 per page',
      sq('release', { sort: 'newest', limit: 2 }),
      'search.results',
    )
    const cursor = ((first.sent_by_bridge[0] as Json).next_cursor as string | null) ?? null
    put('02-newest-paged.json', 'Newest-first paging with a cursor', [
      first,
      await ask(h, 'next page', sq('release', { sort: 'newest', limit: 2, cursor }), 'search.results'),
    ])
    put('03-filters.json', 'Filters: has_file, from, thread', [
      await ask(h, 'has_file', sq('tomato', { filters: { ...F0, has_file: true } }), 'search.results'),
      await ask(h, 'voice reply is not a file', sq('garden', { filters: { ...F0, has_file: true } }), 'search.results'),
      await ask(h, 'thread inbox', sq('release', { filters: { ...F0, thread_ids: ['inbox'] } }), 'search.results'),
      await ask(h, 'from agent', sq('release', { filters: { ...F0, from: 'agent' } }), 'search.results'),
    ])
    put('04-no-match-and-safety.json', 'Nothing found; odd characters are literal', [
      await ask(h, 'no match', sq('zzzzzz'), 'search.results'),
      await ask(h, 'quote', sq('"'), 'search.results'),
      await ask(h, 'lone minus', sq('-x'), 'search.results'),
      await ask(h, 'html in a snippet', sq('onerror'), 'search.results'),
    ])
    put('05-bad-cursor.json', 'A cursor from another query is bad_query', [
      await ask(h, 'wrong cursor', sq('garden', { cursor }), 'error'),
    ])
    put('06-context.json', 'The context view pages by ord: around, older, newer', [
      await ask(
        h,
        'around a hit',
        { request_id: newUlid(), thread_id: 'projects', around_id: mid(3), limit: 50 },
        'history.page',
      ),
      await ask(
        h,
        'around',
        { request_id: newUlid(), thread_id: 'general', around_id: mid(130), limit: 20 },
        'history.page',
      ),
      await ask(
        h,
        'older',
        { request_id: newUlid(), thread_id: 'general', before_id: mid(120), limit: 20 },
        'history.page',
      ),
      await ask(
        h,
        'newer',
        { request_id: newUlid(), thread_id: 'general', after_id: mid(140), limit: 20 },
        'history.page',
      ),
      await ask(
        h,
        'newer to the end',
        { request_id: newUlid(), thread_id: 'general', after_id: mid(150), limit: 20 },
        'history.page',
      ),
    ])
    // an index still being built: rows past the high-water mark
    const late = m(200, { text: 'late release arrival', created_at: at(0, 17) })
    store.db
      .query('INSERT INTO messages (id, thread_id, seq, created_at, author, json) VALUES (?, ?, ?, ?, ?, ?)')
      .run(late.id, late.thread_id, null, late.created_at, late.author, JSON.stringify(late))
    put('07-indexing.json', 'While the index is behind, results say so', [
      await ask(h, 'indexing', sq('release', { limit: 5 }), 'search.results'),
    ])
    const out: Record<string, string> = {}
    const idx = {
      about:
        'Captured by `bun run capture:search` (apps/bridge/scripts/capture-search.ts): the REAL bridge, a fixed conversation, signed search.query and history.request frames. Ids, timestamps and signatures are normalised. Do not edit by hand: re-run the capture.',
      now: new Date(NOW).toISOString(),
      scenarios: Object.keys(files).map((f) => ({ file: f, steps: ((files[f]?.steps ?? []) as unknown[]).length })),
    }
    out['index.json'] = `${JSON.stringify(idx, null, 2)}\n`
    for (const [f, v] of Object.entries(files)) out[f] = `${JSON.stringify(v, null, 2)}\n`
    return out
  } finally {
    await h.stop()
  }
}

const files = await capture()
if (process.argv.includes('--check')) {
  const diff: string[] = []
  for (const [f, text] of Object.entries(files))
    if (!existsSync(join(CAPTURE_DIR, f)) || readFileSync(join(CAPTURE_DIR, f), 'utf8') !== text) diff.push(f)
  if (existsSync(CAPTURE_DIR)) for (const f of readdirSync(CAPTURE_DIR)) if (!(f in files)) diff.push(`${f} (extra)`)
  if (diff.length) {
    console.error(`capture:search --check: the committed captures are out of date:\n- ${diff.join('\n- ')}`)
    process.exit(1)
  }
  console.log(`capture:search --check: ${Object.keys(files).length} files match.`)
} else {
  rmSync(CAPTURE_DIR, { recursive: true, force: true })
  mkdirSync(CAPTURE_DIR, { recursive: true })
  for (const [f, text] of Object.entries(files)) writeFileSync(join(CAPTURE_DIR, f), text)
  console.log(`capture:search: wrote ${Object.keys(files).length} files to ${CAPTURE_DIR}`)
}
process.exit(0)
