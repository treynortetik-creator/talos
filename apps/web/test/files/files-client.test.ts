// The Files pane's client side: an answer is checked against what was asked (the relay could write anything into it), a hidden
// or malformed name is dropped rather than shown, and the pane layout is kept per thread on this device.
import { FILES_WORDING } from '@talos-app/protocol'
import { beforeEach, describe, expect, it } from 'vitest'
import { treeRows } from '../../src/features/files/useFilesBrowser.ts'
import {
  closePane,
  openPane,
  PANES_KEY,
  paneLayout,
  resetPanesForTests,
  setPaneCollapsed,
} from '../../src/features/panes/panesStore.ts'
import { createSocketFiles, toFilesFile, toFilesListing, toFilesSentPage } from '../../src/lib/socketFiles.ts'

describe('socket files client', () => {
  it('drops hidden and malformed names, and refuses an answer for another thread or path', () => {
    const l = toFilesListing(
      {
        thread_id: 'general',
        root: '/Users/alex/talos-agent',
        path: 'docs',
        entries: [
          { name: 'plan.md', kind: 'file', size: 10 },
          { name: '.env', kind: 'file' },
          { name: 'node_modules', kind: 'dir' },
          { name: '../up', kind: 'file' },
          { name: 'odd', kind: 'socket' },
          { name: 'sub', kind: 'dir' },
        ],
        more: 2,
      },
      'general',
      'docs',
    )
    expect(l.entries).toEqual([
      { name: 'plan.md', kind: 'file', size: 10 },
      { name: 'sub', kind: 'dir' },
    ])
    expect(l.more).toBe(2)
    for (const [t, p] of [
      ['other', 'docs'],
      ['general', 'apps'],
    ] as const)
      expect(() => toFilesListing({ thread_id: t, path: p, entries: [] }, 'general', 'docs')).toThrow(
        FILES_WORDING.refused,
      )
  })

  it('a kind the app does not know shows as a file it cannot display, and only text keeps text', () => {
    const f = toFilesFile(
      { thread_id: 'general', path: 'a.bin', kind: 'video', size: 3, mtime: 'x', text: 'leak', truncated: false },
      'general',
      'a.bin',
    )
    expect(f.kind).toBe('binary')
    expect(f.text).toBeUndefined()
    expect(f.nextOffset).toBeNull()
  })

  it('asks with the thread and path, for the matching answer type', async () => {
    const asked: Array<[Record<string, unknown>, string]> = []
    const c = createSocketFiles({
      ask: async (frame, answer) => {
        asked.push([frame, answer])
        return answer === 'files.listing'
          ? { thread_id: 'general', path: '', root: '/r', entries: [], more: 0 }
          : {
              thread_id: 'general',
              path: 'a.md',
              kind: 'text',
              size: 1,
              mtime: 'x',
              text: 'a',
              next_offset: null,
              truncated: false,
            }
      },
    })
    await c.list('general', '')
    await c.read('general', 'a.md', 5)
    expect(asked.map(([f, a]) => [f.type, f.thread_id, f.path, f.offset, a])).toEqual([
      ['files.list', 'general', '', undefined, 'files.listing'],
      ['files.read', 'general', 'a.md', 5, 'files.file'],
    ])
  })
})

describe('the tree rows', () => {
  const ok = (entries: Array<{ name: string; kind: 'dir' | 'file' }>) =>
    ({ state: 'ok', listing: { threadId: 't', root: '/r', path: '', entries, more: 0 } }) as const
  const dirs = {
    '': ok([
      { name: 'docs', kind: 'dir' },
      { name: 'src', kind: 'dir' },
      { name: 'README.md', kind: 'file' },
    ]),
    docs: ok([{ name: 'notes.txt', kind: 'file' }]),
  }
  it('shows an open folder under itself, and with a filter only matches and the folders they are in', () => {
    expect(treeRows(dirs, new Set(), '').map((r) => r.path)).toEqual(['docs', 'src', 'README.md'])
    expect(treeRows(dirs, new Set(['docs']), '').map((r) => `${r.depth}:${r.path}`)).toEqual([
      '0:docs',
      '1:docs/notes.txt',
      '0:src',
      '0:README.md',
    ])
    expect(treeRows(dirs, new Set(), 'NOTES').map((r) => r.path)).toEqual(['docs', 'docs/notes.txt'])
    expect(treeRows(dirs, new Set(), 'zzz')).toEqual([])
  })
})

describe('the pane layout', () => {
  beforeEach(() => {
    localStorage.clear()
    resetPanesForTests()
  })
  it('is kept per thread, in the order opened; a closed pane is forgotten, and so is a thread with none open', () => {
    openPane('a', 'library')
    openPane('a', 'terminal')
    setPaneCollapsed('a', 'library', true)
    openPane('b', 'terminal')
    resetPanesForTests()
    expect(paneLayout('a')).toEqual({ open: ['library', 'terminal'], collapsed: ['library'] })
    expect(paneLayout('b')).toEqual({ open: ['terminal'], collapsed: [] })
    closePane('b', 'terminal')
    expect(JSON.parse(localStorage.getItem(PANES_KEY) ?? '{}')).not.toHaveProperty('b')
  })
  it('a layout kept from before the Library opens it in place of Files or Pages (once, folded if either was)', () => {
    localStorage.setItem(
      PANES_KEY,
      JSON.stringify({ a: { open: ['files', 'terminal', 'pages'], collapsed: ['pages'] } }),
    )
    expect(paneLayout('a')).toEqual({ open: ['library', 'terminal'], collapsed: ['library'] })
  })
  it('reads junk in storage as nothing open, and survives storage that throws', () => {
    localStorage.setItem(
      PANES_KEY,
      JSON.stringify({ a: { open: ['terminal', 'nope', 7], collapsed: ['library'] }, b: 'x' }),
    )
    expect(paneLayout('a')).toEqual({ open: ['terminal'], collapsed: [] })
    expect(paneLayout('b')).toEqual({ open: [], collapsed: [] })
    resetPanesForTests()
    const set = Storage.prototype.setItem
    Storage.prototype.setItem = () => {
      throw new Error('blocked')
    }
    try {
      openPane('c', 'library')
      expect(paneLayout('c').open).toEqual(['library'])
    } finally {
      Storage.prototype.setItem = set
    }
  })
})

describe('socket files client: put', () => {
  const media = {
    media_id: 'md_01JBF3V7Q8K2M4N6P8R0S2T4AB',
    name: 'a.md',
    mime: 'text/markdown',
    size: 3,
    sha256: '0'.repeat(64),
    kind: 'file',
  } as never
  it('sends the folder, the name and the media as an attachment, and takes the name the Mac gave it', async () => {
    const asked: Array<Record<string, unknown>> = []
    const c = createSocketFiles({
      ask: async (f) => {
        asked.push(f)
        return { thread_id: 'general', dir: 'docs', name: 'a (2).md', size: 3 }
      },
    })
    expect(await (c.put as NonNullable<typeof c.put>)('general', 'docs', 'a.md', media)).toEqual({
      name: 'a (2).md',
      size: 3,
    })
    expect(asked[0]).toMatchObject({ type: 'files.put', thread_id: 'general', dir: 'docs', name: 'a.md' })
    expect(asked[0]).toMatchObject({ media: { role: 'attachment' } })
  })
  it('refuses an answer for another thread or folder, or a name that is not one plain name', async () => {
    for (const answer of [
      { thread_id: 'work', dir: 'docs', name: 'a.md', size: 3 },
      { thread_id: 'general', dir: '', name: 'a.md', size: 3 },
      { thread_id: 'general', dir: 'docs', name: '../a.md', size: 3 },
      { thread_id: 'general', dir: 'docs', name: '.env', size: 3 },
    ]) {
      const c = createSocketFiles({ ask: async () => answer })
      await expect((c.put as NonNullable<typeof c.put>)('general', 'docs', 'a.md', media)).rejects.toThrow(
        FILES_WORDING.refused,
      )
    }
  })
})

describe('toFilesSentPage: a list of sent files as the app takes it (the relay could write anything into it)', () => {
  const row = (over: Record<string, unknown> = {}) => ({
    message_id: 'm_01JBF3V7Q8K2M4N6P8R0S2T001',
    thread_id: 'general',
    author: 'agent',
    created_at: '2026-01-01T00:00:00.000Z',
    index: 0,
    file: {
      media_id: 'md_01JBF3V7Q8K2M4N6P8R0S2T001',
      kind: 'file',
      role: 'attachment',
      mime: 'text/markdown',
      name: 'plan.md',
      size: 7,
      sha256: 'a'.repeat(64),
    },
    removed: false,
    ...over,
  })
  const known = (id: string) => id === 'general'

  it('keeps rows the protocol allows under a thread this device lists; drops the rest', () => {
    const p = toFilesSentPage(
      {
        files: [row(), row({ thread_id: 'invented' }), row({ author: 'nobody' }), { nope: 1 }, null, 'x'],
        next_cursor: 'abc_123',
        days: 90,
      },
      known,
    )
    expect(p.files.map((f) => f.thread_id)).toEqual(['general'])
    expect(p.nextCursor).toBe('abc_123')
    expect(p.days).toBe(90)
  })

  it('takes at most a page, a cursor only of the allowed shape, and a whole number of days', () => {
    const p = toFilesSentPage({ files: Array(80).fill(row()), next_cursor: 'not a cursor!', days: -3 }, known)
    expect(p.files).toHaveLength(50)
    expect(p.nextCursor).toBeNull()
    expect(p.days).toBe(0)
  })
})

describe('the pane layout of a thread whose id is a built-in name', () => {
  beforeEach(() => {
    localStorage.clear()
    resetPanesForTests()
  })
  it('"constructor" and "__proto__" are threads like any other', () => {
    expect(paneLayout('constructor')).toEqual({ open: [], collapsed: [] })
    openPane('__proto__', 'library')
    openPane('constructor', 'library')
    resetPanesForTests()
    expect(paneLayout('__proto__').open).toEqual(['library'])
    expect(paneLayout('constructor').open).toEqual(['library'])
  })
})
