// The Library's one list (libraryLogic.ts): the Mac's files and the relay's pages, newest first. Pages are the agent's (never
// on "From you", never under Files); while older files are still to come a page waits for them, so the order never jumps;
// under Files the HTML reports (pages) are left out. Neutral names only.
import type { PageInfoT, SentFileT } from '@talos-app/protocol'
import { describe, expect, it } from 'vitest'
import { mergeLibrary, pageMatches } from '../../src/features/files/libraryLogic.ts'
import { NO_FILTERS, type SentFilterState } from '../../src/features/files/sentLogic.ts'

const NOW = Date.parse('2026-03-11T12:00:00Z')
const at = (h: number) => new Date(NOW - h * 3600_000).toISOString()

const file = (name: string, h: number, mime = 'text/plain', author: 'agent' | 'owner' = 'agent'): SentFileT =>
  ({
    message_id: `m_${name}`,
    thread_id: 'general',
    author,
    created_at: at(h),
    index: 0,
    file: {
      media_id: `md_${name}`,
      kind: mime === 'text/html' ? 'html' : 'file',
      role: 'attachment',
      mime,
      name,
      size: 7,
    },
    removed: false,
  }) as unknown as SentFileT
const page = (title: string, h: number, thread = 'general'): PageInfoT =>
  ({ id: `pg_${title}`, title, thread_id: thread, updated_at: at(h), share: null }) as unknown as PageInfoT

const s = (o: Partial<SentFilterState> = {}): SentFilterState => ({ ...NO_FILTERS, ...o })
const names = (rows: ReturnType<typeof mergeLibrary>) =>
  rows.map((r) => (r.kind === 'page' ? `page:${r.page.title}` : r.f.file.name))

describe('one list, newest first', () => {
  it('pages and files interleave by time', () => {
    const rows = mergeLibrary([file('a.txt', 1), file('c.txt', 5)], [page('Plan', 3), page('Old', 9)], s(), false, NOW)
    expect(names(rows)).toEqual(['a.txt', 'page:Plan', 'c.txt', 'page:Old'])
  })

  it('while older files are still to come, a page older than the files so far waits (no jump on Show more)', () => {
    const rows = mergeLibrary([file('a.txt', 1), file('c.txt', 5)], [page('Plan', 3), page('Old', 9)], s(), true, NOW)
    expect(names(rows)).toEqual(['a.txt', 'page:Plan', 'c.txt'])
  })

  it('with no files yet (an empty Mac, or none listed), every page shows', () => {
    expect(names(mergeLibrary([], [page('Plan', 3)], s(), true, NOW))).toEqual(['page:Plan'])
  })
})

describe('the filters', () => {
  it('From you: no pages (they are the agent’s)', () => {
    expect(mergeLibrary([], [page('Plan', 3)], s({ from: 'owner' }), false, NOW)).toEqual([])
  })

  it('Pages: published pages and the HTML reports; Files: everything else, the reports left out', () => {
    const files = [file('report.html', 2, 'text/html'), file('notes.txt', 4)]
    // the Mac answers Pages with its HTML files only, and Files (all files) with everything
    expect(names(mergeLibrary([files[0] as SentFileT], [page('Plan', 3)], s({ kind: 'pages' }), false, NOW))).toEqual([
      'report.html',
      'page:Plan',
    ])
    expect(names(mergeLibrary(files, [page('Plan', 3)], s({ kind: 'files' }), false, NOW))).toEqual(['notes.txt'])
  })

  it('name, thread and date filter the pages as they filter the files', () => {
    const p = page('Weekly Plan', 3, 'inbox')
    expect(pageMatches(p, s({ name: 'plan' }), NOW)).toBe(true)
    expect(pageMatches(p, s({ name: 'budget' }), NOW)).toBe(false)
    expect(pageMatches(p, s({ threadId: 'general' }), NOW)).toBe(false)
    expect(pageMatches(page('Old', 24 * 9), s({ range: 'week' }), NOW)).toBe(false)
  })
})
