// Bug hunt (Fable, 2026-11-11), MEDIUM: the desktop Files pane kept thread A's open file after switching to thread B (the pane
// is the same component across threads), and "Show more" then appended B's same-named file to A's text. The browser's state
// (the open file, its paging, the tree, the filter) belongs to one thread; switching threads starts it over, and an answer
// for the thread left behind is never shown in the new one.
import { act, cleanup, waitFor } from '@testing-library/react'
import { useState } from 'react'
import { afterEach, describe, expect, it } from 'vitest'
import { useFilesBrowser } from '../../src/features/files/useFilesBrowser.ts'
import type { FilesClient, FilesFile, FilesListing } from '../../src/lib/v2Client.ts'
import { renderWith, setup } from '../cards/helpers.tsx'

afterEach(cleanup)

/** A Mac whose every thread has a README.md in two chunks, each chunk saying which thread and offset it came from. */
function fakeFiles(hold?: { gate: Promise<void> }) {
  const files: FilesClient = {
    list: async (threadId, path) =>
      ({
        threadId,
        path,
        entries: [{ name: 'README.md', kind: 'file', size: 20 }],
        truncated: false,
      }) as unknown as FilesListing,
    read: async (threadId, path, offset) => {
      if (hold && threadId === 'a') await hold.gate
      return {
        threadId,
        path,
        kind: 'text',
        size: 20,
        mtime: '2026-11-11T10:00:00.000Z',
        text: `[${threadId}@${offset}]`,
        offset,
        nextOffset: offset === 0 ? 10 : null,
        truncated: false,
      } satisfies FilesFile
    },
  }
  return files
}

type B = ReturnType<typeof useFilesBrowser>
type Seen = { b: B | null; go: (t: string) => void }
function Probe({ t, seen }: { t: string; seen: Seen }) {
  seen.b = useFilesBrowser(t)
  return null
}
// the thread switches inside the provider (a rerender from outside would leave it), as the pane sees it
function Host({ first, seen }: { first: string; seen: Seen }) {
  const [t, setT] = useState(first)
  seen.go = setT
  return <Probe t={t} seen={seen} />
}
function mount(files: FilesClient, threadId: string) {
  const c = setup()
  Object.defineProperty(c, 'files', { value: files, configurable: true })
  const seen: Seen = { b: null, go: () => {} }
  renderWith(<Host first={threadId} seen={seen} />, c)
  const switchTo = (t: string) => seen.go(t)
  return { seen, switchTo }
}
const text = (b: B | null) => (b?.viewing?.state === 'ok' ? b.viewing.text : null)

describe('the Files browser belongs to one thread', () => {
  it("switching threads closes the open file: B never shows A's text, and Show more never joins them", async () => {
    const { seen, switchTo } = mount(fakeFiles(), 'a')
    await act(() => seen.b?.view('README.md'))
    expect(text(seen.b)).toBe('[a@0]')
    act(() => switchTo('b'))
    await waitFor(() => expect(seen.b?.viewing).toBeNull())
    await act(() => seen.b?.more()) // nothing open: nothing to page
    expect(text(seen.b)).toBeNull()
    await act(() => seen.b?.view('README.md'))
    expect(text(seen.b)).toBe('[b@0]')
    await act(() => seen.b?.more())
    expect(text(seen.b)).toBe('[b@0][b@10]') // B's own chunks only
  })

  it('an answer for the thread left behind is never shown in the new one', async () => {
    let release = () => {}
    const gate = new Promise<void>((r) => {
      release = r
    })
    const { seen, switchTo } = mount(fakeFiles({ gate }), 'a')
    let pending: Promise<void> | undefined
    act(() => {
      pending = seen.b?.view('README.md') // A's read is held
    })
    act(() => switchTo('b'))
    release()
    await act(async () => {
      await pending
    })
    expect(text(seen.b)).toBeNull()
  })

  it('the filter and the opened folders start over too', async () => {
    const { seen, switchTo } = mount(fakeFiles(), 'a')
    act(() => seen.b?.setFilter('read'))
    act(() => seen.b?.toggle('docs'))
    act(() => switchTo('b'))
    await waitFor(() => expect(seen.b?.filter).toBe(''))
    expect(seen.b?.open.size).toBe(0)
  })
})
