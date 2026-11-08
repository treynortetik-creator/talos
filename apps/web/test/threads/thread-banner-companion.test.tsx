// ThreadBanner reads the companion flag: while the Mac companion delivers replies, a reply in another thread is HELD (not
// toasted); when he stops, the page toasts what he did not show. This fails if ThreadBanner stops reading the flag or
// stops reporting the thread on screen (a card page counts as its thread).
import { act, cleanup, render, screen } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ThreadBanner } from '../../src/features/threads/ThreadBanner.tsx'
import { ClientProvider } from '../../src/lib/client.ts'
import type { FakeClient } from '../../src/lib/fakeClient.ts'
import {
  heldReplies,
  resetCompanionRepliesForTest,
  setCompanionReplies,
  viewingThread,
} from '../../src/lib/native/companionReplies.ts'
import { ToastProvider, ToastViewport } from '../../src/ui/toast.tsx'
import { makeCard, setup } from '../cards/helpers.tsx'

for (const k of ['hasPointerCapture', 'setPointerCapture', 'releasePointerCapture'] as const)
  (Element.prototype as unknown as Record<string, unknown>)[k] ??= () => false

beforeEach(() => resetCompanionRepliesForTest())
afterEach(() => {
  cleanup()
  resetCompanionRepliesForTest()
})

let n = 0
const reply = (thread_id: string, text: string) => ({
  id: `m_cb_${++n}`,
  thread_id,
  author: 'agent' as const,
  kind: 'text' as const,
  text,
  format: 'plain' as const,
  attachments: [],
  via: 'app' as const,
  created_at: new Date().toISOString(),
})

function addThread(client: FakeClient, id: string, name: string) {
  client.store.setState((s) => ({
    ...s,
    threads: [
      ...s.threads,
      {
        id,
        name,
        kind: 'fixed' as const,
        order: 5,
        notify: 'all' as const,
        voice_context: 'recent' as const,
        archived: false,
        created_at: '2026-10-01T00:00:00.000Z',
      },
    ],
  }))
}

function shell(client: FakeClient, route: string) {
  render(
    <ClientProvider client={client}>
      <MemoryRouter initialEntries={[route]}>
        <ToastProvider swipeDirection="up">
          <Routes>
            <Route path="*" element={<ThreadBanner />} />
          </Routes>
          <ToastViewport />
        </ToastProvider>
      </MemoryRouter>
    </ClientProvider>,
  )
}

const land = (client: FakeClient, thread: string, text: string) =>
  act(() => {
    const m = reply(thread, text)
    client.store.setState((s) => ({
      ...s,
      messages: { ...s.messages, [thread]: [...(s.messages[thread] ?? []), m] },
      unread: { ...s.unread, [thread]: (s.unread[thread] ?? 0) + 1 },
    }))
  })

describe('ThreadBanner and the Mac companion', () => {
  it('shows no toast while he delivers, and holds the reply for him', () => {
    const client = setup()
    addThread(client, 'research', 'Research')
    shell(client, '/t/general')
    act(() => setCompanionReplies(true))
    land(client, 'research', 'Found three venues')
    expect(screen.queryByTestId('thread-banner')).toBeNull()
    expect(heldReplies().map((h) => h.thread_id)).toEqual(['research'])
  })

  it('shows the toast as today when no shell ever sent the flag', async () => {
    const client = setup()
    addThread(client, 'research', 'Research')
    shell(client, '/t/general')
    land(client, 'research', 'Found three venues')
    expect((await screen.findByTestId('thread-banner')).textContent).toMatch(/Found three venues/)
  })

  it('toasts the held reply when he stops delivering', async () => {
    const client = setup()
    addThread(client, 'research', 'Research')
    shell(client, '/t/general')
    act(() => setCompanionReplies(true))
    land(client, 'research', 'Found three venues')
    expect(screen.queryByTestId('thread-banner')).toBeNull()
    act(() => setCompanionReplies(false))
    expect((await screen.findByTestId('thread-banner')).textContent).toMatch(/Found three venues/)
  })

  it('reports the thread on screen, and a card page counts as its thread', () => {
    const client = setup()
    shell(client, '/t/general')
    expect(viewingThread()).toBe('general')
    cleanup()
    const card = makeCard({ thread_id: 'general' })
    act(() => client.store.setState((s) => ({ ...s, cards: [card] })))
    shell(client, `/card/${card.id}`)
    expect(viewingThread()).toBe('general')
    cleanup()
    shell(client, '/')
    expect(viewingThread()).toBeNull()
  })

  it('holds nothing for the thread of the card on screen', () => {
    const client = setup()
    const card = makeCard({ thread_id: 'general' })
    act(() => client.store.setState((s) => ({ ...s, cards: [card] })))
    shell(client, `/card/${card.id}`)
    act(() => setCompanionReplies(true))
    land(client, 'general', 'on the card thread')
    expect(heldReplies()).toEqual([])
  })
})
