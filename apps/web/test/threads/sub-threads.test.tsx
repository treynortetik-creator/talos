// Sub-threads in the thread lists: each parent is followed by its sub-threads (the keyboard numbers follow that order), the
// sidebar and the phone menu draw them as an accordion whose open state is remembered per device, a closed parent counts its
// sub-threads' unread replies, and a list without sub-threads draws no chevron column at all.
import type { ThreadT } from '@talos-app/protocol'
import { act, cleanup, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Sidebar } from '../../src/features/threads/Nav.tsx'
import {
  groupSubThreads,
  inDrawnOrder,
  rolledUpUnread,
  SUBTHREADS_OPEN_KEY,
  setSubThreadsOpen,
} from '../../src/features/threads/subThreads.ts'
import type { FakeClient } from '../../src/lib/fakeClient.ts'
import { renderWith, setup } from '../cards/helpers.tsx'

afterEach(cleanup)
beforeEach(() => {
  for (const id of ['trip', 'notes']) setSubThreadsOpen(id, false)
  localStorage.removeItem(SUBTHREADS_OPEN_KEY)
})

const t = (id: string, order: number, parent_id?: string) =>
  ({
    id,
    name: id[0]?.toUpperCase() + id.slice(1),
    kind: 'fixed',
    order,
    notify: 'all',
    archived: false,
    created_at: '2026-10-01T00:00:00.000Z',
    ...(parent_id ? { parent_id } : {}),
  }) as ThreadT

describe('grouping and order', () => {
  it('puts each parent before its sub-threads, and draws an orphan or a nested one at the top level', () => {
    const list = [t('trip', 1), t('notes', 2), t('packing', 3, 'trip'), t('visas', 4, 'trip'), t('lost', 5, 'gone')]
    expect(inDrawnOrder(list).map((x) => x.id)).toEqual(['trip', 'packing', 'visas', 'notes', 'lost'])
    // a hand edit two levels deep: the grandchild is not nested under a sub-thread
    const deep = [t('trip', 1), t('packing', 2, 'trip'), t('socks', 3, 'packing')]
    expect(groupSubThreads(deep).map((g) => [g.thread.id, g.subs.map((s) => s.id)])).toEqual([
      ['trip', ['packing']],
      ['socks', []],
    ])
  })

  it("counts a closed parent's sub-threads with its own unread, and only its own when open", () => {
    const [g] = groupSubThreads([t('trip', 1), t('packing', 2, 'trip'), t('visas', 3, 'trip')])
    const unread = { trip: 1, packing: 2, visas: 3 }
    expect(g && rolledUpUnread(g, unread, false)).toBe(6)
    expect(g && rolledUpUnread(g, unread, true)).toBe(1)
  })
})

function withThreads(client: FakeClient, threads: ThreadT[], unread: Record<string, number> = {}) {
  client.store.setState((s) => ({
    ...s,
    threads: [...s.threads.filter((x) => x.id === 'inbox' || x.id === 'general'), ...threads],
    unread: { ...s.unread, ...unread },
  }))
}

describe('the sidebar accordion', () => {
  it('shows sub-threads under their parent when opened, remembers it, and rolls unread up while closed', async () => {
    const client = setup()
    withThreads(client, [t('trip', 1), t('packing', 2, 'trip'), t('notes', 3)], { packing: 4, trip: 1 })
    renderWith(<Sidebar />, client)
    const toggle = await screen.findByTestId('subthreads-toggle-trip')
    // a 44 x 44 px touch (web-ux audit 2026-11-10 #9), at the right of the row: sub-thread-chevron.spec.ts measures where
    expect(toggle.className).toMatch(/\bsize-11\b/)
    expect(toggle.getAttribute('aria-expanded')).toBe('false')
    expect(screen.queryByRole('link', { name: /Packing/ })).toBeNull()
    expect(screen.getByRole('link', { name: /Trip/ }).textContent).toContain('5')
    await userEvent.click(toggle)
    expect(toggle.getAttribute('aria-expanded')).toBe('true')
    // the button controls the list it opens (aria-controls)
    const group = document.getElementById(toggle.getAttribute('aria-controls') ?? '') as HTMLElement
    expect(group).toBeTruthy()
    expect(within(group).getByRole('link', { name: /Packing/ }).textContent).toContain('4')
    expect(screen.getByRole('link', { name: /Trip/ }).textContent).not.toContain('5')
    expect(JSON.parse(localStorage.getItem(SUBTHREADS_OPEN_KEY) ?? '[]')).toEqual(['trip'])
    // only parents get a chevron
    expect(screen.queryByTestId('subthreads-toggle-notes')).toBeNull()
  })

  it('keeps a parent open while one of its sub-threads is on screen', async () => {
    const client = setup()
    withThreads(client, [t('trip', 1), t('packing', 2, 'trip')])
    renderWith(<Sidebar />, client, '/t/packing')
    expect((await screen.findByTestId('subthreads-toggle-trip')).getAttribute('aria-expanded')).toBe('true')
  })

  it('follows another tab on this device', async () => {
    const client = setup()
    withThreads(client, [t('trip', 1), t('packing', 2, 'trip')])
    renderWith(<Sidebar />, client)
    const toggle = await screen.findByTestId('subthreads-toggle-trip')
    act(() => {
      localStorage.setItem(SUBTHREADS_OPEN_KEY, JSON.stringify(['trip']))
      window.dispatchEvent(new StorageEvent('storage', { key: SUBTHREADS_OPEN_KEY }))
    })
    expect(toggle.getAttribute('aria-expanded')).toBe('true')
  })

  it('shows the full name of a long thread on hover', async () => {
    const client = setup()
    const long = { ...t('packing', 2, 'trip'), name: 'Packing list for the long trip' }
    withThreads(client, [t('trip', 1), long])
    setSubThreadsOpen('trip', true)
    renderWith(<Sidebar />, client)
    const link = await screen.findByRole('link', { name: /Packing list for the long trip/ })
    expect(link.querySelector('[title="Packing list for the long trip"]')).toBeTruthy()
  })

  it('draws no chevron column when no thread has sub-threads', async () => {
    const client = setup()
    withThreads(client, [t('trip', 1), t('notes', 2)])
    renderWith(<Sidebar />, client)
    await screen.findByRole('link', { name: /Trip/ })
    expect(document.querySelector('[data-testid^="subthreads-toggle-"]')).toBeNull()
    expect(document.querySelector('[aria-hidden="true"].w-7')).toBeNull()
  })
})
