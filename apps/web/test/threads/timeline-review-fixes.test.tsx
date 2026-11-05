// Review of the new-device Timeline PR: the Inbox keeps its history, the line and the mark-read guard hold up on a cold
// launch, a long thread retries, and a wiped window starts the open over.
import type { MessageT } from '@talos-app/protocol'
import { act, fireEvent, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { unreadMarker } from '../../src/features/threads/jumpToLatest.ts'
import { ThreadScreen } from '../../src/features/threads/ThreadScreen.tsx'
import type { FakeClient } from '../../src/lib/fakeClient.ts'
import { renderWith, setup } from '../cards/helpers.tsx'

beforeEach(() => {
  Element.prototype.scrollIntoView = vi.fn() // jsdom has none
})

const msg = (seq: number, thread = 'general', over: Partial<MessageT> = {}): MessageT => ({
  id: `m_${thread}_${String(seq).padStart(4, '0')}`,
  thread_id: thread,
  author: 'agent',
  kind: 'text',
  text: `message ${seq}`,
  format: 'plain',
  attachments: [],
  via: 'app',
  seq,
  created_at: new Date(Date.UTC(2026, 9, 1, 12, 0, 0) + seq * 60_000).toISOString(),
  ...over,
})
const range = (from: number, to: number, thread = 'general') =>
  Array.from({ length: to - from + 1 }, (_, i) => msg(from + i, thread))

const inboxThread = {
  id: 'inbox',
  name: 'Inbox',
  kind: 'system',
  order: 0,
  notify: 'all',
  voice_context: 'recent',
  archived: false,
  created_at: '2026-10-01T00:00:00.000Z',
} as never

function make(
  opts: { thread?: string; rows?: MessageT[]; unread?: number; readUpto?: number; offline?: boolean } = {},
) {
  const thread = opts.thread ?? 'general'
  const client: FakeClient = setup(opts.offline ? { macOffline: true } : {})
  client.store.setState((s) => ({
    ...s,
    threads: thread === 'inbox' && !s.threads.some((t) => t.id === 'inbox') ? [...s.threads, inboxThread] : s.threads,
    messages: { ...s.messages, [thread]: opts.rows ?? [] },
    unread: { [thread]: opts.unread ?? 0 },
    ...(opts.readUpto !== undefined ? { readUpto: { [thread]: opts.readUpto } } : {}),
  }))
  const load = vi.fn(
    async (_t: string, _before?: number): Promise<{ hasMore: boolean; unavailable?: 'mac_offline'; stale?: true }> => ({
      hasMore: false,
    }),
  )
  client.loadHistory = load
  return { client, load, thread }
}
const open = (client: FakeClient, thread = 'general') =>
  renderWith(<ThreadScreen />, client, `/t/${thread}`, '/t/:thread')
const put = (client: FakeClient, thread: string, rows: MessageT[]) =>
  act(() => client.store.setState((s) => ({ ...s, messages: { ...s.messages, [thread]: rows } })))

describe('the Inbox conversation keeps its history', () => {
  it('offers Load earlier and loads when it has rows', async () => {
    const { client, load } = make({ thread: 'inbox', rows: range(1, 10, 'inbox') })
    load.mockResolvedValue({ hasMore: true })
    open(client, 'inbox')
    await waitFor(() => expect(load).toHaveBeenCalled())
    expect(await screen.findByTestId('load-earlier')).toBeTruthy()
  })
  it('a new device does not say "Nothing has come in" or mark 4 unread read before it has asked', async () => {
    const { client, load } = make({ thread: 'inbox', unread: 4, offline: true })
    load.mockResolvedValue({ hasMore: false, unavailable: 'mac_offline' })
    open(client, 'inbox')
    await waitFor(() => expect(load).toHaveBeenCalled())
    expect(screen.queryByText(/Nothing has come in/)).toBeNull()
    expect(client.store.getState().unread.inbox).toBe(4)
  })
})

describe('mark read', () => {
  it('a tab switch does not clear unread while nothing is on screen and the Mac may hold more', async () => {
    const { client, load } = make({ unread: 30, offline: true })
    load.mockResolvedValue({ hasMore: false, unavailable: 'mac_offline' })
    open(client)
    await screen.findByText(/live on your Mac/)
    fireEvent(document, new Event('visibilitychange'))
    expect(client.store.getState().unread.general).toBe(30)
  })
})

describe('the "New messages" line', () => {
  it('opens the thread at the line, not at the bottom', async () => {
    const { client } = make({ rows: range(1, 60), unread: 3, readUpto: 57 })
    open(client)
    await screen.findByTestId('unread-marker')
    const jump = Element.prototype.scrollIntoView as ReturnType<typeof vi.fn>
    expect(jump).toHaveBeenCalledWith({ block: 'start' })
  })

  it('without a read mark (an older relay) the line still stays put as live replies land', async () => {
    const { client } = make({ rows: range(1, 60), unread: 3 })
    open(client)
    const marker = await screen.findByTestId('unread-marker')
    expect(marker.nextElementSibling?.textContent).toContain('message 58')
    put(client, 'general', range(1, 63))
    expect(screen.getByTestId('unread-marker').nextElementSibling?.textContent).toContain('message 58')
  })

  it('stays on the first unread message as live replies land', async () => {
    const { client } = make({ rows: range(1, 60), unread: 3, readUpto: 57 })
    open(client)
    const marker = await screen.findByTestId('unread-marker')
    expect(marker.nextElementSibling?.textContent).toContain('message 58')
    put(client, 'general', range(1, 63))
    const after = screen.getByTestId('unread-marker')
    expect(after.nextElementSibling?.textContent).toContain('message 58')
  })

  it('counts from the relay read mark, so a silent reply (stored, shown, never counted) does not shift it', async () => {
    const rows = range(1, 5)
    rows[4] = msg(5, 'general', { text: 'silent one' })
    const { client } = make({ rows, unread: 2, readUpto: 3 }) // 4 and 5 are past the mark; the relay counted both
    open(client)
    const marker = await screen.findByTestId('unread-marker')
    expect(marker.nextElementSibling?.textContent).toContain('message 4')
    // the count said 2 but the relay counted 3 of rows 1..5 with a silent 3rd row: counting back would land on 4 or 3
    expect(marker.previousElementSibling?.textContent).toContain('message 3')
  })

  it('a cold launch waits for the first ready before it decides, then marks the right message', async () => {
    const { client } = make({ rows: range(1, 60), unread: 0 })
    client.store.setState((s) => {
      const { readySeq: _r, ...rest } = s
      return { ...rest, connection: 'connecting' }
    })
    open(client)
    expect(screen.queryByTestId('unread-marker')).toBeNull()
    act(() =>
      client.store.setState((s) => ({
        ...s,
        connection: 'online',
        readySeq: 1,
        unread: { general: 3 },
        readUpto: { general: 57 },
        messages: { ...s.messages, general: range(1, 63) },
      })),
    )
    const marker = await screen.findByTestId('unread-marker')
    expect(marker.nextElementSibling?.textContent).toContain('message 58')
  })

  it('unread above the loaded rows: pages back until the line can be placed, and does not mark them read first', async () => {
    const { client, load } = make({ rows: range(11, 60), unread: 60, readUpto: 0 })
    load.mockImplementation(async () => {
      client.store.setState((s) => ({ ...s, messages: { ...s.messages, general: range(1, 60) } }))
      return { hasMore: false }
    })
    open(client)
    expect(client.store.getState().unread.general).toBe(60) // nothing marked before the page lands
    await waitFor(() => expect(load).toHaveBeenCalledTimes(1))
    const marker = await screen.findByTestId('unread-marker')
    expect(marker.nextElementSibling?.textContent).toContain('message 1')
  })

  it('without a line (all unread rows past the pages) a later page does not yank the view', async () => {
    const { client, load } = make({ rows: range(11, 60), unread: 60 })
    load.mockResolvedValue({ hasMore: true }) // never produces enough rows
    open(client)
    await waitFor(() => expect(load.mock.calls.length).toBeGreaterThan(1))
    await waitFor(() => expect(client.store.getState().unread.general).toBe(0)) // gave up, marked read
    const jump = Element.prototype.scrollIntoView as ReturnType<typeof vi.fn>
    jump.mockClear()
    put(client, 'general', range(1, 60)) // the owner's own scroll-back lands later
    expect(jump).not.toHaveBeenCalled()
  })

  it('opening at the line on a thread that fits leaves no Jump pill and keeps following the bottom', async () => {
    const { client } = make({ rows: range(1, 4), unread: 2, readUpto: 2 })
    open(client)
    await screen.findByTestId('unread-marker')
    expect(screen.queryByTestId('jump-to-latest')).toBeNull()
  })
})

describe('loading history', () => {
  it('a long thread retries when the Mac returns after an offline answer', async () => {
    const { client, load } = make({ rows: range(1, 60) })
    load.mockResolvedValueOnce({ hasMore: true, unavailable: 'mac_offline' })
    load.mockResolvedValue({ hasMore: false })
    open(client)
    await userEvent.click(await screen.findByTestId('load-earlier'))
    expect(await screen.findByText(/live on your Mac/)).toBeTruthy()
    expect(load).toHaveBeenCalledTimes(1)
    act(() => client.store.setState((s) => ({ ...s, readySeq: (s.readySeq ?? 0) + 1 })))
    await waitFor(() => expect(load).toHaveBeenCalledTimes(2))
    await waitFor(() => expect(screen.queryByText(/live on your Mac/)).toBeNull())
  })

  it('an offline answer during a reconnect is retried when the connection is ready, though presence never changed', async () => {
    const { client, load } = make({ rows: [] })
    load.mockResolvedValueOnce({ hasMore: false, unavailable: 'mac_offline' })
    load.mockResolvedValue({ hasMore: false })
    open(client)
    expect(await screen.findByText(/live on your Mac/)).toBeTruthy()
    act(() => client.store.setState((s) => ({ ...s, readySeq: (s.readySeq ?? 0) + 1 })))
    await waitFor(() => expect(load).toHaveBeenCalledTimes(2))
    expect(screen.queryByText(/live on your Mac/)).toBeNull()
  })

  it('a device pinned after the first ask is asked again', async () => {
    const { client, load } = make({ rows: [] })
    load.mockResolvedValueOnce({ hasMore: false, unavailable: 'mac_offline' })
    load.mockResolvedValue({ hasMore: false })
    open(client)
    await screen.findByText(/live on your Mac/)
    act(() => client.store.setState((s) => ({ ...s, devicePinned: !s.devicePinned })))
    await waitFor(() => expect(load).toHaveBeenCalledTimes(2))
  })

  it('a page reported stale is asked for again from what is held now', async () => {
    const { client, load } = make({ rows: range(10, 12) })
    load.mockResolvedValueOnce({ hasMore: true, stale: true })
    load.mockResolvedValue({ hasMore: false })
    open(client)
    await waitFor(() => expect(load).toHaveBeenCalledTimes(2))
    expect(load.mock.calls[1]?.[1]).toBe(10)
  })
})

describe('a window wiped under an open thread', () => {
  it('asks again instead of saying "No messages yet", and holds the unread', async () => {
    const { client, load } = make({ rows: range(1, 5), unread: 0 })
    load.mockResolvedValueOnce({ hasMore: false })
    load.mockResolvedValue({ hasMore: false, unavailable: 'mac_offline' }) // the Mac has not answered yet
    open(client)
    await waitFor(() => expect(load).toHaveBeenCalledTimes(1))
    await screen.findByText('message 5')
    act(() =>
      client.store.setState((s) => ({ ...s, messages: { ...s.messages, general: [] }, unread: { general: 3 } })),
    )
    await waitFor(() => expect(load).toHaveBeenCalledTimes(2))
    expect(screen.queryByText(/No messages yet/)).toBeNull()
    expect(client.store.getState().unread.general).toBe(3)
  })
})

describe('unreadMarker (pure)', () => {
  const r = (seq: number, author = 'agent', via?: string) => ({ key: `k${seq}`, author, via, seq })
  it('uses the read mark, counts a share, skips the owner, and is not certain until a row at or below the mark is loaded', () => {
    const rows = [r(4), r(5, 'owner'), r(6, 'owner', 'share'), r(7)]
    expect(unreadMarker(rows, 3, 3, true)).toEqual({ key: null, needMore: true })
    expect(unreadMarker(rows, 3, 3, false)).toEqual({ key: 'k4', needMore: false })
    expect(unreadMarker([r(3), ...rows], 3, 3, true)).toEqual({ key: 'k4', needMore: false })
    expect(unreadMarker([r(3), r(5, 'owner'), r(6, 'owner', 'share')], 1, 3, true)).toEqual({
      key: 'k6',
      needMore: false,
    })
  })
  it('nothing unread, or nothing loaded and nothing more, places no line and asks for nothing', () => {
    expect(unreadMarker([r(1)], 0, 0, true)).toEqual({ key: null, needMore: false })
    expect(unreadMarker([], 2, 0, false)).toEqual({ key: null, needMore: false })
    expect(unreadMarker([], 2, 0, true)).toEqual({ key: null, needMore: true })
  })
  it('falls back to counting from the end when the relay sent no read mark', () => {
    expect(unreadMarker([r(1), r(2), r(3)], 2, undefined, true)).toEqual({ key: 'k2', needMore: false })
    expect(unreadMarker([r(1)], 2, undefined, true)).toEqual({ key: null, needMore: true })
    expect(unreadMarker([r(1)], 2, undefined, false)).toEqual({ key: null, needMore: false })
  })
})
