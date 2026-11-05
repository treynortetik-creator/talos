// Audit D35: Undo after Done / Snooze, and a Done view with Restore.

import type { InboxItemT } from '@talos-app/protocol'
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useState } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { restoreInboxItem, UNDO_MS, undoTarget } from '../../src/features/inbox/done.ts'
import { EventRow } from '../../src/features/inbox/EventRow.tsx'
import { InboxScreen } from '../../src/features/inbox/InboxScreen.tsx'
import { UndoStrip } from '../../src/features/inbox/undo.tsx'
import { ItemSheet } from '../../src/features/threads/ItemSheet.tsx'
import { makeItem, renderWith, setup } from '../cards/helpers.tsx'

function swipe(el: HTMLElement, dx: number) {
  fireEvent.pointerDown(el, { clientX: 100, clientY: 100, pointerId: 1 })
  fireEvent.pointerMove(el, { clientX: 100 + dx / 2, clientY: 100, pointerId: 1 })
  fireEvent.pointerMove(el, { clientX: 100 + dx, clientY: 100, pointerId: 1 })
  fireEvent.pointerUp(el, { clientX: 100 + dx, clientY: 100, pointerId: 1 })
}
const stateOf = (client: ReturnType<typeof setup>, id: string) =>
  client.store.getState().inbox.find((i) => i.id === id)?.state

beforeEach(() => {
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} }) // biome-ignore format: stub
})
afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
})

describe('Undo', () => {
  it('a swipe to Done offers Undo; Undo puts it back as read', async () => {
    const item = makeItem({ title: 'Swiped away', state: 'read' })
    const client = setup({ inbox: [item] })
    renderWith(<InboxScreen />, client)
    swipe(screen.getByText('Swiped away').closest('button') as HTMLElement, 120)
    expect(stateOf(client, item.id)).toBe('done')
    expect(screen.queryByText('Swiped away')).toBeNull() // gone from the list
    const strip = screen.getByTestId('inbox-undo')
    expect(strip.textContent).toContain('Marked done')
    await userEvent.click(within(strip).getByRole('button', { name: 'Undo' }))
    await waitFor(() => expect(stateOf(client, item.id)).toBe('read'))
    expect(screen.getByText('Swiped away')).toBeTruthy()
    expect(screen.queryByTestId('inbox-undo')).toBeNull()
  })

  it('a swipe to Snooze offers Undo, and Undo clears the snooze', async () => {
    const item = makeItem({ title: 'Later please', state: 'read' })
    const client = setup({ inbox: [item] })
    renderWith(<InboxScreen />, client)
    swipe(screen.getByText('Later please').closest('button') as HTMLElement, -120)
    expect(stateOf(client, item.id)).toBe('snoozed')
    expect(screen.getByTestId('inbox-undo').textContent).toContain('Snoozed')
    await userEvent.click(screen.getByRole('button', { name: 'Undo' }))
    await waitFor(() => expect(stateOf(client, item.id)).toBe('read'))
  })

  it('Done from the item sheet offers Undo too', async () => {
    const item = makeItem({ title: 'From the sheet', state: 'read' })
    const client = setup({ inbox: [item] })
    renderWith(<InboxScreen />, client)
    await userEvent.click(screen.getByText('From the sheet'))
    await userEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Done' }))
    expect(stateOf(client, item.id)).toBe('done')
    await userEvent.click(await screen.findByRole('button', { name: 'Undo' }))
    await waitFor(() => expect(stateOf(client, item.id)).toBe('read'))
  })

  it('Snooze from the item sheet offers Undo too', async () => {
    const item = makeItem({ title: 'Sheet snooze', state: 'read' })
    const client = setup({ inbox: [item] })
    renderWith(<InboxScreen />, client)
    await userEvent.click(screen.getByText('Sheet snooze'))
    await userEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Snooze' }))
    expect(stateOf(client, item.id)).toBe('snoozed')
    expect(await screen.findByTestId('inbox-undo')).toBeTruthy()
  })

  it('the strip goes away on its own after the timer, and the change stands', () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const item = makeItem({ title: 'Timed', state: 'read' })
    const client = setup({ inbox: [item] })
    renderWith(<InboxScreen />, client)
    swipe(screen.getByText('Timed').closest('button') as HTMLElement, 120)
    expect(screen.getByTestId('inbox-undo')).toBeTruthy()
    act(() => void vi.advanceTimersByTime(UNDO_MS - 100))
    expect(screen.getByTestId('inbox-undo')).toBeTruthy()
    act(() => void vi.advanceTimersByTime(200))
    expect(screen.queryByTestId('inbox-undo')).toBeNull()
    expect(stateOf(client, item.id)).toBe('done')
  })

  it('Undo still works when a list refresh already dropped the done item from the store', async () => {
    const item = makeItem({ title: 'Dropped by refresh', state: 'read' })
    const client = setup({ inbox: [item] })
    renderWith(<InboxScreen />, client)
    swipe(screen.getByText('Dropped by refresh').closest('button') as HTMLElement, 120)
    act(() => client.store.setState((s) => ({ ...s, inbox: s.inbox.filter((i) => i.id !== item.id) }))) // what a refresh does
    await userEvent.click(screen.getByRole('button', { name: 'Undo' }))
    await waitFor(() => expect(stateOf(client, item.id)).toBe('read'))
    expect(screen.getByText('Dropped by refresh')).toBeTruthy()
  })
})

describe('Undo puts back what was there', () => {
  it('an unread item swiped to Done comes back unread, not read', async () => {
    const item = makeItem({ title: 'Still unread', state: 'new' })
    const client = setup({ inbox: [item] })
    renderWith(<InboxScreen />, client)
    swipe(screen.getByText('Still unread').closest('button') as HTMLElement, 120)
    expect(stateOf(client, item.id)).toBe('done')
    await userEvent.click(screen.getByRole('button', { name: 'Undo' }))
    await waitFor(() => expect(stateOf(client, item.id)).toBe('new'))
  })

  it('undoTarget: new stays new, a snooze still pending returns, anything else is read', () => {
    const now = Date.parse('2026-10-31T12:00:00.000Z')
    const base = makeItem()
    expect(undoTarget({ ...base, state: 'new' }, now)).toBe('new')
    expect(undoTarget({ ...base, state: 'read' }, now)).toBe('read')
    expect(undoTarget({ ...base, state: 'snoozed', snooze_until: '2026-10-31T18:00:00.000Z' }, now)).toBe('snoozed')
    expect(undoTarget({ ...base, state: 'snoozed', snooze_until: '2026-10-31T08:00:00.000Z' }, now)).toBe('read')
  })
})

function SheetHost({ item }: { item: InboxItemT }) {
  const [open, setOpen] = useState<InboxItemT | null>(item) // closes on Done / Snooze, like the thread screen does
  return <ItemSheet item={open} onClose={() => setOpen(null)} />
}

describe('Undo on the other Done and Snooze surfaces', () => {
  it('Done from a thread item sheet offers Undo and Undo restores it', async () => {
    const item = makeItem({ title: 'Thread sheet item', state: 'read' })
    const client = setup({ inbox: [item] })
    renderWith(
      <>
        <SheetHost item={item} />
        <UndoStrip floating />
      </>,
      client,
    )
    await userEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Done' }))
    expect(stateOf(client, item.id)).toBe('done')
    expect(screen.getByTestId('inbox-undo').textContent).toContain('Marked done')
    await userEvent.click(screen.getByRole('button', { name: 'Undo' }))
    await waitFor(() => expect(stateOf(client, item.id)).toBe('read'))
  })

  it('Snooze from a thread item sheet offers Undo', async () => {
    const item = makeItem({ title: 'Thread snooze item', state: 'read' })
    const client = setup({ inbox: [item] })
    renderWith(
      <>
        <SheetHost item={item} />
        <UndoStrip floating />
      </>,
      client,
    )
    await userEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Snooze' }))
    expect(stateOf(client, item.id)).toBe('snoozed')
    await userEvent.click(screen.getByRole('button', { name: 'Undo' }))
    await waitFor(() => expect(stateOf(client, item.id)).toBe('read'))
  })

  it('a swipe on an EventRow in a thread offers Undo', async () => {
    const item = makeItem({ title: 'Thread row', state: 'read' })
    const client = setup({ inbox: [item] })
    renderWith(
      <>
        <EventRow item={item} onOpen={() => {}} />
        <UndoStrip floating />
      </>,
      client,
    )
    swipe(screen.getByText('Thread row').closest('button') as HTMLElement, 120)
    await userEvent.click(screen.getByRole('button', { name: 'Undo' }))
    await waitFor(() => expect(stateOf(client, item.id)).toBe('read'))
  })
})

describe('Done view (fake mode: the store is the list)', () => {
  beforeEach(() => vi.stubEnv('VITE_FAKE', '1'))

  it('lists done items newest first with Restore, and Restore brings one back to its tab', async () => {
    const a = makeItem({ title: 'Old done', state: 'done', ts: '2026-10-28T10:00:00.000Z' })
    const b = makeItem({ title: 'New done', state: 'done', ts: '2026-10-28T12:00:00.000Z' })
    const open = makeItem({ title: 'Still open' })
    const client = setup({ inbox: [a, b, open] })
    renderWith(<InboxScreen />, client)
    await userEvent.click(screen.getByRole('tab', { name: 'Done' }))
    const list = await screen.findByRole('list', { name: 'Done' })
    expect(
      within(list)
        .getAllByRole('listitem')
        .map((li) => li.textContent?.includes('New done')),
    ).toEqual([true, false])
    expect(within(list).queryByText('Still open')).toBeNull()
    await userEvent.click(within(list).getByRole('button', { name: 'Restore Old done' }))
    await waitFor(() => expect(stateOf(client, a.id)).toBe('read'))
    await waitFor(() => expect(screen.queryByText('Old done')).toBeNull())
    expect(screen.getByRole('status').textContent).toContain('Restored to Priority')
    await userEvent.click(screen.getByRole('tab', { name: /^Priority/ }))
    expect(screen.getByText('Old done')).toBeTruthy()
  })

  it('says so when nothing is done yet', async () => {
    renderWith(<InboxScreen />, setup({ inbox: [makeItem()] }))
    await userEvent.click(screen.getByRole('tab', { name: 'Done' }))
    expect((await screen.findByTestId('done-empty')).textContent).toBe('Nothing finished yet.')
  })
})

describe('Done view (real mode: GET /api/inbox?state=done)', () => {
  const doneItem = makeItem({ title: 'Relay says done', state: 'done', priority: 'low' })
  const feed = (items: unknown[]) => ({ items, counts: { priority: 0, other: 0 } })

  it('fetches state=done from the relay and lists what it returns', async () => {
    const urls: string[] = []
    vi.stubGlobal('fetch', async (u: string) => {
      urls.push(u)
      return Response.json(feed([doneItem]))
    })
    renderWith(<InboxScreen />, setup())
    await userEvent.click(screen.getByRole('tab', { name: 'Done' }))
    expect(await screen.findByText('Relay says done')).toBeTruthy()
    expect(urls).toContain('/api/inbox?state=done')
  })

  it('says so when the relay cut the Done list at its cap', async () => {
    vi.stubGlobal('fetch', async () => Response.json({ ...feed([doneItem]), truncated: true }))
    renderWith(<InboxScreen />, setup())
    await userEvent.click(screen.getByRole('tab', { name: 'Done' }))
    expect((await screen.findByTestId('done-truncated')).textContent).toContain('200 newest')
  })

  it('shows no cut notice for a complete list', async () => {
    vi.stubGlobal('fetch', async () => Response.json(feed([doneItem])))
    renderWith(<InboxScreen />, setup())
    await userEvent.click(screen.getByRole('tab', { name: 'Done' }))
    await screen.findByText('Relay says done')
    expect(screen.queryByTestId('done-truncated')).toBeNull()
  })

  it('a failed load says so and Try again loads it', async () => {
    let ok = false
    vi.stubGlobal('fetch', async () => (ok ? Response.json(feed([doneItem])) : new Response('{}', { status: 500 })))
    renderWith(<InboxScreen />, setup())
    await userEvent.click(screen.getByRole('tab', { name: 'Done' }))
    expect((await screen.findByTestId('done-error')).textContent).toContain("Couldn't load")
    expect(screen.queryByTestId('done-empty')).toBeNull() // an error never reads as empty
    ok = true
    await userEvent.click(screen.getByRole('button', { name: 'Try again' }))
    expect(await screen.findByText('Relay says done')).toBeTruthy()
    expect(screen.queryByTestId('done-error')).toBeNull()
  })

  it('Restore puts the item back in the store even though a refresh had dropped it, and refetches only after the relay applied it', async () => {
    const client = setup() // the store does not hold the item: a list refresh dropped it
    let relayApplied = false
    let doneFetches = 0
    vi.stubGlobal('fetch', async () => {
      doneFetches += 1
      // The relay applies the restore on the 3rd look at the Done list.
      if (doneFetches >= 3) relayApplied = true
      return Response.json(feed(relayApplied ? [] : [doneItem]))
    })
    const refetch = vi.spyOn(client.api, 'inbox')
    let refetchedAfterApplied: boolean | null = null
    refetch.mockImplementation(async () => {
      refetchedAfterApplied = relayApplied
      return { items: [], counts: { priority: 0, other: 0 } }
    })
    renderWith(<InboxScreen />, client)
    await userEvent.click(screen.getByRole('tab', { name: 'Done' }))
    await screen.findByText('Relay says done')
    refetch.mockClear()
    await restoreInboxItem(client, doneItem, { pollMs: 5 })
    expect(stateOf(client, doneItem.id)).toBe('read') // back in the store, not lost to a no-op update
    expect(refetch).toHaveBeenCalledTimes(1)
    expect(refetch).toHaveBeenCalledWith('other') // the low-priority item's tab
    expect(refetchedAfterApplied).toBe(true) // not before the relay had applied it
  })

  it('an unreachable relay during Restore keeps the item on screen and does not refetch', async () => {
    const client = setup()
    vi.stubGlobal('fetch', async () => {
      throw new TypeError('offline')
    })
    const refetch = vi.spyOn(client.api, 'inbox')
    await restoreInboxItem(client, doneItem, { pollMs: 1 })
    expect(stateOf(client, doneItem.id)).toBe('read')
    expect(refetch).not.toHaveBeenCalled()
  })
})
