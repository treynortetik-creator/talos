// The Files sheet's pages (useSentFiles): Show more appends without repeats, a cursor that comes back unchanged ends the list,
// empty pages the Mac cut short at its scan cap are read through, and a failed Show more says so until a retry succeeds.
// The arrow keys move the type chip.
import type { SentFileT } from '@talos-app/protocol'
import { act, fireEvent, render, renderHook, screen, waitFor } from '@testing-library/react'
import type { ReactNode } from 'react'
import { MemoryRouter } from 'react-router'
import { describe, expect, it, vi } from 'vitest'
import { SentFiles } from '../../src/features/files/SentFiles.tsx'
import { useOpenSent } from '../../src/features/files/useOpenSent.ts'
import { AUTO_PAGES, useSentFiles } from '../../src/features/files/useSentFiles.ts'
import { ClientProvider, TalosClientError } from '../../src/lib/client.ts'
import type { FilesSentPage } from '../../src/lib/v2Client.ts'
import { setup } from '../cards/helpers.tsx'

const file = (n: number): SentFileT => ({
  message_id: `m_01JBF3V7Q8K2M4N6P8R0S2${String(n).padStart(4, '0')}`,
  thread_id: 'general',
  author: 'agent',
  created_at: new Date(Date.UTC(2026, 0, 1, 0, 0, 100_000 - n)).toISOString(),
  index: 0,
  file: {
    media_id: `md_01JBF3V7Q8K2M4N6P8R0S2${String(n).padStart(4, '0')}`,
    kind: 'file',
    role: 'attachment',
    mime: 'text/plain',
    name: `f${n}.txt`,
    size: 7,
    sha256: 'a'.repeat(64),
  },
  removed: false,
})
const page = (files: SentFileT[], nextCursor: string | null): FilesSentPage => ({ files, nextCursor, days: 90 })

function withSent(answers: Array<FilesSentPage | Error>) {
  const client = setup()
  const calls: Array<string | null> = []
  client.files.sent = vi.fn(async ({ cursor }: { cursor: string | null }) => {
    calls.push(cursor)
    const a = answers.shift()
    if (!a) throw new Error('no more answers scripted')
    if (a instanceof Error) throw a
    return a
  }) as never
  const wrapper = ({ children }: { children: ReactNode }) => (
    <ClientProvider client={client}>
      <MemoryRouter>{children}</MemoryRouter>
    </ClientProvider>
  )
  return { client, calls, wrapper }
}

describe('useSentFiles paging', () => {
  it('more than one page: Show more appends, and a row sent again is not shown twice', async () => {
    const one = Array.from({ length: 50 }, (_, i) => file(i))
    const { wrapper, calls } = withSent([page(one, 'c1'), page([file(49), file(50), file(51)], null)])
    const { result } = renderHook(() => useSentFiles(), { wrapper })
    await waitFor(() => expect(result.current.files).toHaveLength(50))
    expect(result.current.hasMore).toBe(true)
    await act(async () => result.current.more?.())
    await waitFor(() => expect(result.current.files).toHaveLength(52))
    expect(new Set(result.current.files.map((f) => f.message_id)).size).toBe(52)
    expect(result.current.hasMore).toBe(false)
    expect(calls).toEqual([null, 'c1'])
  })

  it('a cursor that comes back unchanged ends the list (no endless Show more)', async () => {
    const { wrapper } = withSent([page([file(1)], 'same'), page([file(1)], 'same')])
    const { result } = renderHook(() => useSentFiles(), { wrapper })
    await waitFor(() => expect(result.current.hasMore).toBe(true))
    await act(async () => result.current.more?.())
    await waitFor(() => expect(result.current.hasMore).toBe(false))
    expect(result.current.files).toHaveLength(1)
  })

  it(`empty pages the Mac cut short are read through on their own (up to ${AUTO_PAGES}), so a match further back is found`, async () => {
    const { wrapper, calls } = withSent([page([], 'a'), page([], 'b'), page([file(7)], null)])
    const { result } = renderHook(() => useSentFiles(), { wrapper })
    await waitFor(() => expect(result.current.files.map((f) => f.file.name)).toEqual(['f7.txt']))
    expect(calls).toEqual([null, 'a', 'b'])
    expect(result.current.hasMore).toBe(false)
  })

  it('a failed Show more says so, keeps the list, and the error goes when a retry succeeds', async () => {
    const { wrapper } = withSent([
      page([file(1)], 'c1'),
      new TalosClientError('internal', "Your Mac didn't answer."),
      page([file(2)], null),
    ])
    const { result } = renderHook(() => useSentFiles(), { wrapper })
    await waitFor(() => expect(result.current.files).toHaveLength(1))
    await act(async () => result.current.more?.())
    await waitFor(() => expect(result.current.error).toBe("Your Mac didn't answer."))
    expect(result.current.files).toHaveLength(1)
    await act(async () => result.current.more?.())
    await waitFor(() => expect(result.current.files).toHaveLength(2))
    expect(result.current.error).toBeNull()
  })
})

describe('the type chips', () => {
  it('are one tab stop, and the arrow keys move the choice', async () => {
    const { client } = withSent([page([file(1)], null), page([], null), page([], null)])
    render(
      <ClientProvider client={client}>
        <MemoryRouter>
          <SentFiles layout="list" />
        </MemoryRouter>
      </ClientProvider>,
    )
    const all = await screen.findByRole('radio', { name: 'All' })
    expect(all.getAttribute('aria-checked')).toBe('true')
    expect(all.tabIndex).toBe(0)
    expect(screen.getByRole('radio', { name: 'Pages' }).tabIndex).toBe(-1)
    fireEvent.keyDown(all, { key: 'ArrowRight' })
    await waitFor(() => expect(screen.getByRole('radio', { name: 'Pages' }).getAttribute('aria-checked')).toBe('true'))
    fireEvent.keyDown(screen.getByRole('radio', { name: 'Pages' }), { key: 'ArrowLeft' })
    await waitFor(() => expect(screen.getByRole('radio', { name: 'All' }).getAttribute('aria-checked')).toBe('true'))
  })
})

describe('an old file the relay let go', () => {
  const old = (n: number, size: number): SentFileT => ({
    ...file(n),
    created_at: new Date(Date.now() - 10 * 86_400_000).toISOString(),
    file: { ...file(n).file, size },
  })
  function mount(files: SentFileT[]) {
    const client = setup()
    const asked: string[] = []
    ;(client as unknown as { fetchMedia: (id: string) => void }).fetchMedia = (id: string) => {
      asked.push(id)
      setTimeout(() => client.emit('media.ready', { media_id: id } as never), 0)
    }
    const gone = new Set(files.map((f) => f.file.media_id))
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        const id = /md_[0-9A-Z]+/.exec(url)?.[0] ?? ''
        // the relay has it again once the Mac was asked for it
        return { ok: !gone.has(id) || asked.includes(id), status: !gone.has(id) || asked.includes(id) ? 200 : 410 }
      }),
    )
    const wrapper = ({ children }: { children: ReactNode }) => (
      <ClientProvider client={client}>{children}</ClientProvider>
    )
    const hook = renderHook(() => useOpenSent(files), { wrapper })
    return { hook, asked }
  }

  it('a small one is asked back from the Mac at once, so its row is a link again (one tap opens it)', async () => {
    const small = old(1, 1000)
    const { hook, asked } = mount([small])
    await waitFor(() => expect(asked).toEqual([small.file.media_id]))
    await waitFor(() => expect(hook.result.current.states).toEqual({}))
    vi.unstubAllGlobals()
  })

  it('a big one waits for a tap: "on your Mac", then asked back on the tap', async () => {
    const big = old(2, 9_000_000)
    const { hook, asked } = mount([big])
    await waitFor(() => expect(Object.values(hook.result.current.states)).toEqual(['gone']))
    expect(asked).toEqual([])
    await act(async () => void (await hook.result.current.getBack(big)))
    expect(asked).toEqual([big.file.media_id])
    expect(hook.result.current.states).toEqual({})
    vi.unstubAllGlobals()
  })
})
