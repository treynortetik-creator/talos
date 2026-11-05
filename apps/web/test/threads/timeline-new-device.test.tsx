// D1 + D30: a thread must not look empty on a new or long-away device, and scrolling back must not lose the place.
import type { MessageT } from '@talos-app/protocol'
import { act, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { firstUnreadKey, keepPlace } from '../../src/features/threads/jumpToLatest.ts'
import { ThreadScreen } from '../../src/features/threads/ThreadScreen.tsx'
import type { FakeClient } from '../../src/lib/fakeClient.ts'
import { renderWith, setup } from '../cards/helpers.tsx'

const msg = (seq: number, author: 'agent' | 'owner' = 'agent'): MessageT => ({
  id: `m_${String(seq).padStart(4, '0')}`,
  thread_id: 'general',
  author,
  kind: 'text',
  text: `message ${seq}`,
  format: 'plain',
  attachments: [],
  via: 'app',
  seq,
  created_at: new Date(Date.UTC(2026, 9, 1, 12, seq)).toISOString(),
})

/** A device that has never loaded the thread: nothing cached, 30 unread, the Mac holds 30 messages. */
function newDevice(opts: { macOffline?: boolean } = {}) {
  const client: FakeClient = setup(opts.macOffline ? { macOffline: true } : {})
  client.store.setState((s) => ({ ...s, messages: { ...s.messages, general: [] }, unread: { general: 30 } }))
  const history = Array.from({ length: 30 }, (_, i) => msg(i + 1))
  const load = vi.fn(async (_t: string, before?: number) => {
    if (!client.store.getState().presence.bridge_online) return { hasMore: false, unavailable: 'mac_offline' as const }
    const page = history.filter((m) => before === undefined || (m.seq as number) < before)
    client.store.setState((s) => ({
      ...s,
      messages: { ...s.messages, general: [...page, ...(s.messages.general ?? [])] },
    }))
    return { hasMore: false }
  })
  client.loadHistory = load
  return { client, load }
}

const open = (client: FakeClient) => renderWith(<ThreadScreen />, client, '/t/general', '/t/:thread')

describe('a new device opens a thread', () => {
  it('loads history by itself instead of saying "No messages yet" next to 30 unread', async () => {
    const { client, load } = newDevice()
    open(client)
    expect(await screen.findByText('message 30')).toBeTruthy()
    expect(load).toHaveBeenCalledTimes(1)
    expect(screen.queryByText(/No messages yet/)).toBeNull()
  })

  it('never claims the thread is empty while the Mac is offline; offers Load messages, and loads when the Mac returns', async () => {
    const { client, load } = newDevice({ macOffline: true })
    open(client)
    expect(await screen.findByText(/live on your Mac/)).toBeTruthy()
    expect(screen.queryByText(/No messages yet/)).toBeNull()
    expect(screen.getByTestId('load-earlier').textContent).toBe('Load messages')
    expect(screen.queryByTestId('thread-empty-explainer')).toBeNull()
    act(() => client.setMacOnline(true))
    expect(await screen.findByText('message 30')).toBeTruthy()
    expect(load).toHaveBeenCalledTimes(2)
  })

  it('still says "No messages yet" once the Mac confirms the thread is empty', async () => {
    const client = setup()
    client.store.setState((s) => ({ ...s, messages: { ...s.messages, general: [] }, unread: { general: 0 } }))
    open(client)
    expect((await screen.findByTestId('thread-empty-explainer')).textContent).toMatch(/A thread is one topic/)
  })

  it('does not mark unread messages read before they are on screen', async () => {
    const { client } = newDevice({ macOffline: true })
    open(client)
    await screen.findByText(/live on your Mac/)
    expect(client.store.getState().unread.general).toBe(30)
  })

  it('puts a "New messages" line above the first unread one', async () => {
    const { client } = newDevice()
    client.store.setState((s) => ({ ...s, unread: { general: 5 } }))
    open(client)
    await screen.findByText('message 30')
    const marker = await screen.findByTestId('unread-marker')
    const next = marker.nextElementSibling as HTMLElement
    expect(next.textContent).toContain('message 26')
    expect(marker.previousElementSibling?.textContent).not.toContain('message 26')
  })
})

describe('Load earlier', () => {
  it('stays when a page fails, says so, and works on the next press', async () => {
    const { client, load } = newDevice()
    load.mockRejectedValueOnce(new Error('timeout'))
    open(client)
    const btn = await screen.findByText('Could not load. Try again')
    expect(btn).toBeTruthy()
    await userEvent.click(btn)
    expect(await screen.findByText('message 30')).toBeTruthy()
    expect(load).toHaveBeenCalledTimes(2)
  })

  it('stays after a "Mac offline" answer from a thread that has rows', async () => {
    const { client, load } = newDevice()
    client.store.setState((s) => ({ ...s, messages: { general: [msg(30)] }, unread: { general: 0 } }))
    load.mockResolvedValueOnce({ hasMore: false, unavailable: 'mac_offline' })
    open(client)
    expect(await screen.findByText(/live on your Mac/)).toBeTruthy()
    expect(screen.getByTestId('load-earlier')).toBeTruthy()
  })

  it('is shown on a short thread even when it has rows, and loads on open', async () => {
    const { client, load } = newDevice()
    client.store.setState((s) => ({ ...s, messages: { general: [msg(30)] }, unread: { general: 0 } }))
    load.mockImplementationOnce(async () => ({ hasMore: true }))
    open(client)
    await waitFor(() => expect(load).toHaveBeenCalled())
    expect(await screen.findByTestId('load-earlier')).toBeTruthy()
  })
})

describe('pure helpers', () => {
  it('keepPlace moves scrollTop by the height the prepended rows added', () => {
    expect(keepPlace({ height: 1000, top: 0 }, 1800)).toBe(800)
    expect(keepPlace({ height: 1000, top: 40 }, 1000)).toBe(40)
  })
  it('firstUnreadKey skips owner rows and unsaved rows, and refuses to guess', () => {
    const r = [
      { key: 'a', author: 'agent', seq: 1 },
      { key: 'b', author: 'owner', seq: 2 },
      { key: 'c', author: 'agent', seq: 3 },
      { key: 'd', author: 'agent', seq: 4 },
      { key: 'q', author: 'agent' },
    ]
    expect(firstUnreadKey(r, 2)).toBe('c')
    expect(firstUnreadKey(r, 3)).toBe('a')
    expect(firstUnreadKey(r, 4)).toBeNull()
    expect(firstUnreadKey(r, 0)).toBeNull()
  })
})
