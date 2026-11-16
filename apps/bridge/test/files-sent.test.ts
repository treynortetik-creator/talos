// files.sent (src/files/sent.ts): the Files sheet's list of files sent in Talos, from history.sqlite.
import { describe, expect, test } from 'bun:test'
import { join } from 'node:path'
import { type FrameOf, type MessageT, newUlid } from '@talos-app/protocol'
import { decodeCursor, FILES_SENT_SCAN_MAX, FilesSentService, filesSentFor } from '../src/files/sent.ts'
import { HistoryStore } from '../src/history-store.ts'
import { ReadError } from '../src/v2-seams.ts'
import { tempHome } from './helpers.ts'

const SHA = 'a'.repeat(64)
let n = 0
const mediaId = () => `md_${newUlid().slice(0, 26)}`
const att = (name: string, mime: string, kind = 'file', extra: Record<string, unknown> = {}) => ({
  media_id: mediaId(),
  kind,
  role: 'attachment',
  mime,
  name,
  size: 7,
  sha256: SHA,
  ...extra,
})

function setup(threads = ['general', 'trip', 'work']) {
  const store = new HistoryStore(join(tempHome(), 'h.sqlite'))
  const removed = new Set<string>()
  const svc = new FilesSentService({
    db: store.db,
    threads: () => threads,
    removed: (id) => removed.has(id),
    historyDays: () => 90,
  })
  const add = (thread: string, author: MessageT['author'], attachments: ReturnType<typeof att>[], minute: number) => {
    const id = `m_${newUlid()}`
    n++
    store.addMessage({
      id,
      thread_id: thread,
      author,
      kind: 'text',
      text: `row ${n}`,
      format: 'plain',
      attachments,
      via: 'app',
      created_at: new Date(Date.UTC(2026, 0, 1, 0, minute)).toISOString(),
    } as unknown as MessageT)
    return id
  }
  return { store, svc, add, removed }
}

const ask = (
  filters: Partial<FrameOf<'files.sent'>['filters']> = {},
  more: { cursor?: string | null; limit?: number } = {},
): FrameOf<'files.sent'> =>
  ({
    request_id: newUlid(),
    filters: { type: 'all', name: '', thread_ids: [], from: 'any', after: null, before: null, ...filters },
    cursor: more.cursor ?? null,
    limit: more.limit ?? 50,
  }) as FrameOf<'files.sent'>

describe('files.sent', () => {
  test('both directions, every listed thread, newest first; a message with two files gives two rows', () => {
    const { svc, add } = setup()
    add('general', 'owner', [att('brief.md', 'text/markdown')], 1)
    add('trip', 'agent', [att('report.html', 'text/html', 'html'), att('photo.png', 'image/png', 'image')], 2)
    const r = svc.list(ask())
    expect(r.files.map((f) => f.file.name)).toEqual(['photo.png', 'report.html', 'brief.md'])
    expect(r.files.map((f) => f.author)).toEqual(['agent', 'agent', 'owner'])
    expect(r.days).toBe(90)
    expect(r.next_cursor).toBeNull()
  })

  test('a thread the Mac no longer lists (deleted, or made up) contributes nothing, even when asked for', () => {
    const { svc, add } = setup(['general'])
    add('general', 'agent', [att('kept.md', 'text/markdown')], 1)
    add('gone', 'agent', [att('from-a-deleted-thread.md', 'text/markdown')], 2)
    expect(svc.list(ask()).files.map((f) => f.file.name)).toEqual(['kept.md'])
    expect(svc.list(ask({ thread_ids: ['gone'] })).files).toEqual([])
  })

  test('voice notes and spoken replies are messages, not files', () => {
    const { svc, add } = setup()
    add('general', 'owner', [att('voice.m4a', 'audio/mp4', 'voice_note')], 1)
    add('general', 'agent', [att('reply.mp3', 'audio/mpeg', 'audio', { role: 'voice_reply' })], 2)
    add('general', 'agent', [att('song.mp3', 'audio/mpeg', 'audio')], 3)
    expect(svc.list(ask()).files.map((f) => f.file.name)).toEqual(['song.mp3'])
  })

  test('filters: type chip, who sent it, threads, dates', () => {
    const { svc, add } = setup()
    add('general', 'owner', [att('a.md', 'text/markdown')], 1)
    add('trip', 'agent', [att('b.html', 'text/html', 'html')], 2)
    add('work', 'agent', [att('c.mp3', 'audio/mpeg', 'audio')], 3)
    add('work', 'system', [att('d.png', 'image/png', 'image')], 4)
    const names = (f: Parameters<typeof ask>[0]) => svc.list(ask(f)).files.map((x) => x.file.name)
    expect(names({ type: 'docs' })).toEqual(['a.md'])
    expect(names({ type: 'pages' })).toEqual(['b.html'])
    expect(names({ type: 'audio' })).toEqual(['c.mp3'])
    expect(names({ type: 'images' })).toEqual(['d.png'])
    expect(names({ from: 'owner' })).toEqual(['a.md'])
    expect(names({ from: 'agent' })).toEqual(['d.png', 'c.mp3', 'b.html'])
    expect(names({ thread_ids: ['trip', 'general'] })).toEqual(['b.html', 'a.md'])
    expect(names({ after: '2026-01-01T00:02:00.000Z', before: '2026-01-01T00:04:00.000Z' })).toEqual([
      'c.mp3',
      'b.html',
    ])
  })

  test('the name filter is plain text: % and _ match only themselves, any letter case', () => {
    const { svc, add } = setup()
    add('general', 'agent', [att('50%_Plan.md', 'text/markdown')], 1)
    add('general', 'agent', [att('500 plans.md', 'text/markdown')], 2)
    add('general', 'agent', [att('50xxplan.md', 'text/markdown')], 3)
    const names = (name: string) => svc.list(ask({ name })).files.map((x) => x.file.name)
    expect(names('50%_plan')).toEqual(['50%_Plan.md'])
    expect(names('%')).toEqual(['50%_Plan.md'])
    expect(names('_')).toEqual(['50%_Plan.md'])
    expect(names("'; DROP TABLE messages; --")).toEqual([])
    expect(names('PLAN')).toHaveLength(3)
  })

  test('pages by position, never offset: a file added between pages neither repeats nor skips one', () => {
    const { svc, add } = setup()
    for (let i = 0; i < 7; i++) add('general', 'agent', [att(`f${i}.md`, 'text/markdown')], i)
    const one = svc.list(ask({}, { limit: 3 }))
    expect(one.files.map((f) => f.file.name)).toEqual(['f6.md', 'f5.md', 'f4.md'])
    expect(one.next_cursor).not.toBeNull()
    add('general', 'agent', [att('newer.md', 'text/markdown')], 30) // arrives while the sheet is open
    const two = svc.list(ask({}, { cursor: one.next_cursor, limit: 3 }))
    expect(two.files.map((f) => f.file.name)).toEqual(['f3.md', 'f2.md', 'f1.md'])
    const three = svc.list(ask({}, { cursor: two.next_cursor, limit: 3 }))
    expect(three.files.map((f) => f.file.name)).toEqual(['f0.md'])
    expect(three.next_cursor).toBeNull()
  })

  test('a write between pages and between rows never breaks the next page (no statement left mid-step)', () => {
    const { store, svc, add } = setup()
    for (let i = 0; i < 6; i++) add('general', 'agent', [att(`f${i}.md`, 'text/markdown')], i)
    let wrote = 0
    // a write while the page's rows are being read: the removed() lookup runs once per file
    const svc2 = new FilesSentService({
      db: store.db,
      threads: () => ['general', 'trip', 'work'],
      removed: () => {
        if (wrote++ < 3) add('trip', 'agent', [], 40 + wrote)
        return false
      },
      historyDays: () => 90,
    })
    let cursor: string | null = null
    const seen: string[] = []
    for (let p = 0; p < 10; p++) {
      const page = svc2.list(ask({}, cursor ? { cursor, limit: 1 } : { limit: 1 }))
      seen.push(...page.files.map((f) => f.file.name))
      add('work', 'owner', [], 50 + p) // a write between pages
      cursor = page.next_cursor
      if (!cursor) break
    }
    expect(seen).toEqual(['f5.md', 'f4.md', 'f3.md', 'f2.md', 'f1.md', 'f0.md'])
    expect(svc.list(ask({}, { limit: 2 })).files).toHaveLength(2)
  })

  test('two files in one message split across pages are each listed once', () => {
    const { svc, add } = setup()
    add(
      'general',
      'agent',
      [att('x1.md', 'text/markdown'), att('x2.md', 'text/markdown'), att('x3.md', 'text/markdown')],
      1,
    )
    const one = svc.list(ask({}, { limit: 2 }))
    const two = svc.list(ask({}, { cursor: one.next_cursor, limit: 2 }))
    expect([...one.files, ...two.files].map((f) => f.file.name)).toEqual(['x3.md', 'x2.md', 'x1.md'])
  })

  test(`a page reads at most ${FILES_SENT_SCAN_MAX} rows, then answers short with a cursor to go on`, () => {
    const { svc, add } = setup()
    add('general', 'agent', [att('the-one.md', 'text/markdown')], 0)
    // many files that are not docs, newer than the one doc
    for (let i = 0; i < FILES_SENT_SCAN_MAX + 10; i++)
      add('general', 'agent', [att(`p${i}.png`, 'image/png', 'image')], 1)
    const first = svc.list(ask({ type: 'docs' }))
    expect(first.files).toEqual([])
    expect(first.next_cursor).not.toBeNull()
    const next = svc.list(ask({ type: 'docs' }, { cursor: first.next_cursor }))
    expect(next.files.map((f) => f.file.name)).toEqual(['the-one.md'])
  })

  test('a file whose bytes the Mac removed is listed as removed', () => {
    const { svc, add, removed } = setup()
    const gone = att('old.pdf', 'application/pdf')
    add('general', 'agent', [gone], 1)
    removed.add(gone.media_id)
    expect(svc.list(ask()).files[0]?.removed).toBe(true)
  })

  test('the name filter folds any letter case and Unicode form, not only ASCII', () => {
    const { svc, add } = setup()
    add('general', 'agent', [att('Émile notes.pdf', 'application/pdf')], 1)
    add('general', 'agent', [att('Straße.md', 'text/markdown')], 2)
    const names = (name: string) => svc.list(ask({ name })).files.map((x) => x.file.name)
    expect(names('émile')).toEqual(['Émile notes.pdf'])
    expect(names('ÉMILE')).toEqual(['Émile notes.pdf'])
    expect(names('E\u0301mile')).toEqual(['Émile notes.pdf']) // a decomposed accent folds to the same name
    expect(names('STRASSE')).toEqual([])
  })

  test('a damaged row (not JSON, or a file that is not an object) is skipped, never a failed read', () => {
    const { svc, add, store } = setup()
    add('general', 'agent', [att('kept.md', 'text/markdown')], 1)
    const raw = store.db.query('INSERT INTO messages (id, thread_id, created_at, author, json) VALUES (?, ?, ?, ?, ?)')
    raw.run(`m_${newUlid()}`, 'general', '2026-01-01T00:05:00.000Z', 'agent', '{not json')
    raw.run(
      `m_${newUlid()}`,
      'general',
      '2026-01-01T00:06:00.000Z',
      'agent',
      JSON.stringify({ attachments: [1, 'x', null] }),
    )
    expect(svc.list(ask()).files.map((f) => f.file.name)).toEqual(['kept.md'])
  })

  test('dates are compared as times: a filter with an offset and no milliseconds', () => {
    const { svc, add } = setup()
    add('general', 'agent', [att('early.md', 'text/markdown')], 10) // 00:10Z
    add('general', 'agent', [att('late.md', 'text/markdown')], 50) // 00:50Z
    // 02:30+02:00 is 00:30Z
    const r = svc.list(ask({ after: '2026-01-01T02:30:00+02:00' }))
    expect(r.files.map((f) => f.file.name)).toEqual(['late.md'])
  })

  test('history kept for good says 0 days', () => {
    const store = new HistoryStore(join(tempHome(), 'h.sqlite'))
    const svc = new FilesSentService({
      db: store.db,
      threads: () => ['general'],
      removed: () => false,
      historyDays: () => 0,
    })
    expect(svc.list(ask()).days).toBe(0)
  })

  test("on a bridge: archived threads and sub-threads count, from the Mac's thread list now", () => {
    const store = new HistoryStore(join(tempHome(), 'h.sqlite'))
    const threads = [
      { id: 'general', archived: false },
      { id: 'old', archived: true },
      { id: 'child', archived: false, parent_id: 'general' },
    ]
    const ctx = {
      config: { config: { threads } },
      media: { removedInfo: () => undefined },
      env: { historyDays: 90 },
    } as unknown as Parameters<typeof filesSentFor>[0]
    const svc = filesSentFor(ctx, store)
    for (const [i, t] of ['general', 'old', 'child', 'deleted'].entries())
      store.addMessage({
        id: `m_${newUlid()}`,
        thread_id: t,
        author: 'agent',
        kind: 'text',
        text: t,
        format: 'plain',
        attachments: [att(`${t}.md`, 'text/markdown')],
        via: 'app',
        created_at: new Date(Date.UTC(2026, 0, 2, 0, i)).toISOString(),
      } as unknown as MessageT)
    expect(svc.list(ask()).files.map((f) => f.file.name)).toEqual(['child.md', 'old.md', 'general.md'])
  })

  test('a cursor it did not make is refused, not guessed at', () => {
    expect(() => decodeCursor('not-a-cursor')).toThrow(ReadError)
    const forged = Buffer.from(JSON.stringify({ at: 'x', id: 'y', i: 1, extra: 1 })).toString('base64url')
    expect(() => decodeCursor(forged)).toThrow(ReadError)
  })
})
