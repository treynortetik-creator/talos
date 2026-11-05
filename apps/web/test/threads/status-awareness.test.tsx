// D15 working row + Stop, D17 stale rows on Home, D18 unread counts and the jump banner.
import type { MessageT } from '@talos-app/protocol'
import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, Route, Routes, useNavigate } from 'react-router'
import { afterEach, describe, expect, it } from 'vitest'
import { buildHome, STALE_STATUS_MS } from '../../src/features/home/groups.ts'
import { BottomBar, Sidebar } from '../../src/features/threads/Nav.tsx'
import { ThreadBanner } from '../../src/features/threads/ThreadBanner.tsx'
import { ThreadScreen } from '../../src/features/threads/ThreadScreen.tsx'
import { ClientProvider } from '../../src/lib/client.ts'
import type { FakeClient } from '../../src/lib/fakeClient.ts'
import { ToastProvider, ToastViewport } from '../../src/ui/toast.tsx'
import { LocationProbe, makeCard, renderWith, setup } from '../cards/helpers.tsx'

afterEach(cleanup)
// jsdom has no pointer capture; Radix Toast's swipe handler calls it on press.
for (const k of ['hasPointerCapture', 'setPointerCapture', 'releasePointerCapture'] as const)
  (Element.prototype as unknown as Record<string, unknown>)[k] ??= () => false

const iso = () => new Date().toISOString()
let n = 0
const msg = (thread_id: string, author: MessageT['author'], text: string, over: Partial<MessageT> = {}): MessageT =>
  ({
    id: `m_status_${++n}`,
    thread_id,
    author,
    kind: 'text',
    text,
    format: 'plain',
    attachments: [],
    via: 'app',
    created_at: iso(),
    ...over,
  }) as MessageT

function thread(client: FakeClient, id: string, name: string) {
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

function openThread(client: FakeClient, id = 'general') {
  renderWith(<ThreadScreen />, client, `/t/${id}`, '/t/:thread')
}
const setMessages = (client: FakeClient, id: string, list: MessageT[]) =>
  client.store.setState((s) => ({ ...s, messages: { ...s.messages, [id]: list } }))

describe('D15 working row', () => {
  it('shows the row with Stop when this thread is working and the mod can stop', async () => {
    const client = setup()
    client.store.setState((s) => ({
      ...s,
      statuses: { general: { thread_id: 'general', state: 'working', since: iso() } },
    }))
    openThread(client)
    act(() => client.session.patch({ busy: true, turn_id: 'turn_1' }))
    const row = await screen.findByTestId('working-row')
    await userEvent.click(await within(row).findByRole('button', { name: 'Stop' }))
    const sent = client.session.controls.at(-1)
    expect(sent).toMatchObject({ thread_id: 'general', action: 'stop', turn_id: 'turn_1' })
  })

  it('has no Stop without the stop capability or a turn id, but still shows the row', async () => {
    const client = setup()
    client.store.setState((s) => ({
      ...s,
      statuses: { general: { thread_id: 'general', state: 'working', since: iso() } },
    }))
    openThread(client)
    act(() => client.session.patch({ busy: true, turn_id: 'turn_1', capabilities: ['compact'] }))
    const row = await screen.findByTestId('working-row')
    expect(within(row).queryByRole('button', { name: 'Stop' })).toBeNull()
    act(() => client.session.patch({ capabilities: ['stop'], turn_id: undefined }))
    await waitFor(() =>
      expect(within(screen.getByTestId('working-row')).queryByRole('button', { name: 'Stop' })).toBeNull(),
    )
  })

  it('a busy mod does not make an unrelated thread look busy (newest row is the agent)', async () => {
    const client = setup()
    setMessages(client, 'general', [msg('general', 'owner', 'hi'), msg('general', 'agent', 'hello')])
    openThread(client)
    act(() => client.session.patch({ busy: true, turn_id: 'turn_1' }))
    await waitFor(() => expect(screen.getByTestId('status-word').textContent).toMatch(/idle/i))
    expect(screen.queryByTestId('working-row')).toBeNull()
  })

  it('a busy mod with the owner speaking last reads Working in the row and the header word', async () => {
    const client = setup()
    setMessages(client, 'general', [msg('general', 'agent', 'hello'), msg('general', 'owner', 'do the thing')])
    openThread(client)
    act(() => client.session.patch({ busy: true, turn_id: 'turn_1' }))
    expect(await screen.findByTestId('working-row')).toBeTruthy()
    expect(screen.getByTestId('status-word').textContent).toMatch(/working/i)
  })

  it('has no Stop when the mod is not busy, even with a stale turn id', async () => {
    const client = setup()
    client.store.setState((s) => ({
      ...s,
      statuses: { general: { thread_id: 'general', state: 'working', since: iso() } },
    }))
    openThread(client)
    act(() => client.session.patch({ busy: false, turn_id: 'turn_1' }))
    const row = await screen.findByTestId('working-row')
    expect(within(row).queryByRole('button', { name: 'Stop' })).toBeNull()
  })

  it('the row goes away when the thread status goes idle', async () => {
    const client = setup()
    client.store.setState((s) => ({
      ...s,
      statuses: { general: { thread_id: 'general', state: 'working', since: iso() } },
    }))
    openThread(client)
    await screen.findByTestId('working-row')
    act(() =>
      client.store.setState((s) => ({
        ...s,
        statuses: { general: { thread_id: 'general', state: 'idle', since: iso() } },
      })),
    )
    await waitFor(() => expect(screen.queryByTestId('working-row')).toBeNull())
  })
})

describe('D15 working row: Stop honesty', () => {
  const working = (client: FakeClient, id = 'general', ageMs = 0) =>
    client.store.setState((s) => ({
      ...s,
      statuses: { [id]: { thread_id: id, state: 'working', since: new Date(Date.now() - ageMs).toISOString() } },
    }))

  it('a thread with its own session shows Working from its own status but offers no Stop (Stop would hit main)', async () => {
    const client = setup()
    thread(client, 'build', 'Build')
    client.store.setState(
      (s) =>
        ({
          ...s,
          config: s.config
            ? {
                ...s.config,
                dedicated: { enabled: true },
                threads: [
                  ...s.config.threads,
                  { ...(s.threads.find((t) => t.id === 'build') as object), session: 'dedicated' },
                ],
              }
            : s.config,
        }) as typeof s,
    )
    working(client, 'build')
    openThread(client, 'build')
    act(() => client.session.patch({ busy: true, turn_id: 'turn_main' }))
    const row = await screen.findByTestId('working-row')
    expect(within(row).queryByRole('button', { name: 'Stop' })).toBeNull()
  })

  it('a dedicated thread does not read Working just because main is busy and the owner spoke last', async () => {
    const client = setup()
    thread(client, 'build', 'Build')
    client.store.setState(
      (s) =>
        ({
          ...s,
          messages: { ...s.messages, build: [msg('build', 'owner', 'go')] },
          config: s.config
            ? {
                ...s.config,
                dedicated: { enabled: true },
                threads: [
                  ...s.config.threads,
                  { ...(s.threads.find((t) => t.id === 'build') as object), session: 'dedicated' },
                ],
              }
            : s.config,
        }) as typeof s,
    )
    openThread(client, 'build')
    act(() => client.session.patch({ busy: true, turn_id: 'turn_main' }))
    await new Promise((r) => setTimeout(r, 30))
    expect(screen.queryByTestId('working-row')).toBeNull()
  })

  it('no Stop once the mod has lapsed, even if its last state said busy', async () => {
    const client = setup()
    working(client)
    openThread(client)
    act(() => client.session.patch({ busy: true, turn_id: 'turn_1' }))
    const row = await screen.findByTestId('working-row')
    await within(row).findByRole('button', { name: 'Stop' })
    act(() => client.session.pushStale(10 * 60_000))
    await waitFor(() =>
      expect(within(screen.getByTestId('working-row')).queryByRole('button', { name: 'Stop' })).toBeNull(),
    )
  })

  it('a refused Stop says why in the row, because the panel is closed', async () => {
    const client = setup()
    working(client)
    openThread(client)
    act(() => client.session.patch({ busy: true, turn_id: 'turn_1' }))
    client.session.failNext('turn_mismatch', 'That turn already ended.')
    const row = await screen.findByTestId('working-row')
    await userEvent.click(await within(row).findByRole('button', { name: 'Stop' }))
    const err = await screen.findByTestId('working-row-error')
    expect(err.textContent).toMatch(/already ended/i)
    expect(err.getAttribute('role')).toBe('alert')
  })

  it('a working row older than the age limit reads idle on the thread screen too (header word and row)', async () => {
    const client = setup()
    working(client, 'general', STALE_STATUS_MS + 60_000)
    openThread(client)
    await waitFor(() => expect(screen.getByTestId('status-word').textContent).toMatch(/idle/i))
    expect(screen.queryByTestId('working-row')).toBeNull()
  })
})

describe('D17 stale rows on Home', () => {
  const NOW = Date.parse('2026-10-28T16:00:00.000Z')
  const run = (state: 'working' | 'queued', ageMs: number) => {
    const client = setup()
    client.store.setState((s) => ({
      ...s,
      statuses: { general: { thread_id: 'general', state, since: new Date(NOW - ageMs).toISOString() } },
    }))
    return buildHome(client.store.getState(), { nowMs: NOW, timeZone: 'UTC', localSnoozed: new Map() })
  }
  it('a fresh working row is listed, an old one is not', () => {
    const rows = (m: ReturnType<typeof run>) => m.groups.find((g) => g.id === 'working')?.rows.length
    expect(rows(run('working', 60_000))).toBe(1)
    expect(rows(run('working', STALE_STATUS_MS + 1))).toBe(0)
  })
  it('a stale row that lands in Ready no longer carries the working status or its label', () => {
    const client = setup()
    client.store.setState((s) => ({
      ...s,
      unread: { general: 2 },
      statuses: {
        general: {
          thread_id: 'general',
          state: 'working',
          label: 'Starting a session for this thread…',
          since: new Date(NOW - STALE_STATUS_MS - 1).toISOString(),
        },
      },
    }))
    const m = buildHome(client.store.getState(), { nowMs: NOW, timeZone: 'UTC', localSnoozed: new Map() })
    const row = m.groups.find((g) => g.id === 'ready')?.rows.find((r) => r.id === 'general')
    expect(row?.kind).toBe('thread')
    if (row?.kind === 'thread') {
      expect(row.status?.state).toBe('idle')
      expect(row.status?.label).toBeUndefined()
    }
  })
  it('an old queued row leaves Up next', () => {
    expect(run('queued', 60_000).upNext.length).toBe(1)
    expect(run('queued', STALE_STATUS_MS + 1).upNext.length).toBe(0)
  })
})

describe('D18 counts', () => {
  const wrap = (client: FakeClient, ui: React.ReactNode) =>
    render(
      <ClientProvider client={client}>
        <MemoryRouter>{ui}</MemoryRouter>
      </ClientProvider>,
    )
  it('the bottom-bar Threads tab shows the unread total', () => {
    const client = setup()
    client.store.setState((s) => ({ ...s, unread: { general: 7, inbox: 3 } }))
    wrap(client, <BottomBar />)
    expect(screen.getByTestId('threads-tab-count').textContent).toBe('10')
    expect(screen.getByLabelText('10 unread')).toBeTruthy()
  })
  it('an archived thread adds nothing to the Threads tab badge', () => {
    const client = setup()
    thread(client, 'old', 'Old')
    client.store.setState((s) => ({
      ...s,
      threads: s.threads.map((t) => (t.id === 'old' ? { ...t, archived: true } : t)),
      unread: { general: 2, old: 1 },
    }))
    wrap(client, <BottomBar />)
    expect(screen.getByTestId('threads-tab-count').textContent).toBe('2')
  })
  it('no count when nothing is unread', () => {
    const client = setup()
    client.store.setState((s) => ({ ...s, unread: {} }))
    wrap(client, <BottomBar />)
    expect(screen.queryByTestId('threads-tab-count')).toBeNull()
  })
  it('the Sidebar Inbox link shows its unread count', () => {
    const client = setup()
    client.store.setState((s) => ({ ...s, unread: { inbox: 3 } }))
    wrap(client, <Sidebar />)
    const link = screen.getByRole('link', { name: /Inbox/ })
    expect(within(link).getByLabelText('3 unread').textContent).toBe('3')
  })
})

function GoResearch() {
  const nav = useNavigate()
  return (
    <button type="button" data-testid="go-research" onClick={() => nav('/t/research')}>
      go
    </button>
  )
}

describe('D18 jump banner', () => {
  function shell(client: FakeClient, route: string) {
    return render(
      <ClientProvider client={client}>
        <MemoryRouter initialEntries={[route]}>
          <ToastProvider swipeDirection="up">
            <Routes>
              <Route path="*" element={<ThreadBanner />} />
            </Routes>
            <ToastViewport data-testid="toast-viewport" />
          </ToastProvider>
          <LocationProbe />
          <GoResearch />
        </MemoryRouter>
      </ClientProvider>,
    )
  }
  const land = (client: FakeClient, m: MessageT) =>
    act(() =>
      client.store.setState((s) => ({
        ...s,
        messages: { ...s.messages, [m.thread_id]: [...(s.messages[m.thread_id] ?? []), m] },
        unread: { ...s.unread, [m.thread_id]: (s.unread[m.thread_id] ?? 0) + 1 },
      })),
    )

  it('a reply in another thread shows a banner, and tapping it jumps there', async () => {
    const client = setup()
    thread(client, 'research', 'Research')
    shell(client, '/t/general')
    land(client, msg('research', 'agent', 'Found three venues'))
    const b = await screen.findByTestId('thread-banner')
    expect(b.textContent).toMatch(/Research/)
    expect(b.textContent).toMatch(/Found three venues/)
    await userEvent.click(screen.getByTestId('thread-banner-open'))
    expect(screen.getByTestId('location').textContent).toBe('/t/research')
  })

  // the real socket client stores a reply first and bumps unread in a second write
  const landSplit = (client: FakeClient, m: MessageT) => {
    act(() =>
      client.store.setState((s) => ({
        ...s,
        messages: { ...s.messages, [m.thread_id]: [...(s.messages[m.thread_id] ?? []), m] },
      })),
    )
    act(() =>
      client.store.setState((s) => ({
        ...s,
        unread: { ...s.unread, [m.thread_id]: (s.unread[m.thread_id] ?? 0) + 1 },
      })),
    )
  }

  it('fires when the message lands first and the unread bump follows in a second write', async () => {
    const client = setup()
    thread(client, 'research', 'Research')
    shell(client, '/t/general')
    landSplit(client, msg('research', 'agent', 'two writes'))
    expect((await screen.findByTestId('thread-banner')).textContent).toMatch(/two writes/)
  })

  it('the banner goes away when the owner opens that thread some other way', async () => {
    const client = setup()
    thread(client, 'research', 'Research')
    shell(client, '/t/general')
    land(client, msg('research', 'agent', 'look here'))
    await screen.findByTestId('thread-banner')
    await userEvent.click(screen.getByTestId('go-research'))
    await waitFor(() => expect(screen.queryByTestId('thread-banner')).toBeNull())
  })

  it('no banner for a thread set to Off or Needs you only', async () => {
    const client = setup()
    thread(client, 'quiet', 'Quiet')
    thread(client, 'strict', 'Strict')
    client.store.setState((s) => ({
      ...s,
      threads: s.threads.map((t) =>
        t.id === 'quiet'
          ? { ...t, notify: 'off' as const }
          : t.id === 'strict'
            ? { ...t, notify: 'needs_you' as const }
            : t,
      ),
    }))
    shell(client, '/t/general')
    land(client, msg('quiet', 'agent', 'shh'))
    land(client, msg('strict', 'agent', 'not a card'))
    await new Promise((r) => setTimeout(r, 30))
    expect(screen.queryByTestId('thread-banner')).toBeNull()
  })

  it('no banner for the thread of the card on screen (/card/:id)', async () => {
    const client = setup()
    thread(client, 'research', 'Research')
    client.store.setState((s) => ({
      ...s,
      cards: [makeCard({ id: 'c_00000000000000000000000001', thread_id: 'research' })],
    }))
    shell(client, '/card/c_00000000000000000000000001')
    land(client, msg('research', 'agent', 'already looking at it'))
    await new Promise((r) => setTimeout(r, 30))
    expect(screen.queryByTestId('thread-banner')).toBeNull()
  })

  it('no banner for the thread on screen, the owner’s own rows, a silent (no unread) reply, or a replayed old one', async () => {
    const client = setup()
    thread(client, 'research', 'Research')
    shell(client, '/t/research')
    land(client, msg('research', 'agent', 'visible already'))
    land(client, msg('general', 'owner', 'mine'))
    act(() =>
      client.store.setState((s) => ({
        ...s,
        messages: { ...s.messages, general: [...(s.messages.general ?? []), msg('general', 'agent', 'silent')] },
      })),
    )
    land(client, msg('general', 'agent', 'old replay', { created_at: '2020-01-01T00:00:00.000Z' }))
    await new Promise((r) => setTimeout(r, 30))
    expect(screen.queryByTestId('thread-banner')).toBeNull()
  })

  it('messages already loaded when the banner mounts do not fire it', async () => {
    const client = setup()
    thread(client, 'research', 'Research')
    client.store.setState((s) => ({
      ...s,
      messages: { ...s.messages, research: [msg('research', 'agent', 'loaded earlier')] },
      unread: { research: 2 },
    }))
    shell(client, '/t/general')
    await new Promise((r) => setTimeout(r, 30))
    expect(screen.queryByTestId('thread-banner')).toBeNull()
  })

  it('the toast viewport sits at the top with a safe-area inset, not over the composer', () => {
    const client = setup()
    shell(client, '/t/general')
    const cls = screen.getByTestId('toast-viewport').className
    expect(cls).toMatch(/\btop-0\b/)
    expect(cls).not.toMatch(/\bbottom-0\b/)
    expect(cls).toMatch(/safe-area-inset-top/)
  })
})
