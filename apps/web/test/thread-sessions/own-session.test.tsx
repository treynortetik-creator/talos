// Option C in the app (docs/OPTION-C.md 9.2-9.4): the Own session switch is hidden while the feature is off and for the
// default thread, General and Inbox; it is a plain config.patch (no card, no step-up); park/restart send a signed
// thread.session.control; parked rows appear in Settings; the plan bars say "all sessions".
import {
  AgentConfig,
  type AgentConfigT,
  THREAD_SESSIONS_FEATURE,
  type ThreadT,
  type WorkersStatusT,
} from '@talos-app/protocol'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { afterEach, describe, expect, it } from 'vitest'
import { getSessionController } from '../../src/features/session/store.ts'
import { OwnSession } from '../../src/features/thread-sessions/OwnSession.tsx'
import { getThreadSessionsController } from '../../src/features/thread-sessions/store.ts'
import { ThreadSessionsSection } from '../../src/features/thread-sessions/ThreadSessionsSection.tsx'
import { ClientProvider } from '../../src/lib/client.ts'
import type { FakeClient } from '../../src/lib/fakeClient.ts'
import { createMemoryStorage } from '../../src/lib/storage.ts'
import { StorageProvider } from '../../src/lib/storageContext.tsx'
import { setup } from '../cards/helpers.tsx'

afterEach(cleanup)
const wait = (ms = 30) => new Promise((r) => setTimeout(r, ms))

const trip: ThreadT = {
  id: 'trip',
  name: 'Trip',
  kind: 'fixed',
  order: 2,
  notify: 'all',
  voice_context: 'recent',
  archived: false,
  created_at: '2026-10-28T00:00:00.000Z',
}

function withConfig(client: FakeClient, change: (c: AgentConfigT) => Record<string, unknown>) {
  const cur = client.store.getState().config as AgentConfigT
  const next = AgentConfig.parse({ ...cur, threads: [...cur.threads, trip], ...change(cur) })
  const presence = client.store.getState().presence
  client.store.setState({
    config: next,
    threads: next.threads,
    presence: { ...presence, features: [...(presence.features ?? []), THREAD_SESSIONS_FEATURE] },
  })
}

const status = (over: Partial<WorkersStatusT> = {}): WorkersStatusT => ({
  supported: true,
  supervisor_online: true,
  threads: [],
  governor: { state: 'ok' },
  at: '2026-10-30T00:00:00.000Z',
  ...over,
})

function mount(client: FakeClient, node: React.ReactNode) {
  return render(
    <StorageProvider storage={createMemoryStorage()}>
      <ClientProvider client={client}>
        <MemoryRouter>{node}</MemoryRouter>
      </ClientProvider>
    </StorageProvider>,
  )
}

const thread = (client: FakeClient, id: string) => client.store.getState().threads.find((t) => t.id === id) as ThreadT

describe('Own session switch', () => {
  it('is hidden while the master switch is off, even when the Mac supports it', async () => {
    const client = setup()
    withConfig(client, () => ({}))
    mount(client, <OwnSession thread={thread(client, 'trip')} />)
    await act(async () => client.emit('workers.status', { status: status() }))
    expect(screen.queryByTestId('own-session')).toBeNull()
  })

  it('is hidden when the Mac cannot host thread sessions', async () => {
    const client = setup()
    withConfig(client, () => ({ dedicated: { enabled: true } }))
    mount(client, <OwnSession thread={thread(client, 'trip')} />)
    await act(async () => client.emit('workers.status', { status: status({ supported: false }) }))
    expect(screen.queryByTestId('own-session')).toBeNull()
  })

  it('never shows for General or Inbox (the default thread is General here)', async () => {
    const client = setup()
    withConfig(client, () => ({ dedicated: { enabled: true } }))
    for (const id of ['general', 'inbox']) {
      const { unmount } = mount(client, <OwnSession thread={thread(client, id)} />)
      await act(async () => client.emit('workers.status', { status: status() }))
      expect(screen.queryByTestId('own-session'), id).toBeNull()
      unmount()
    }
  })

  it('shows for an ordinary thread with the cost note, and switching it on is a plain config.patch', async () => {
    const client = setup()
    withConfig(client, () => ({ dedicated: { enabled: true } }))
    mount(client, <OwnSession thread={thread(client, 'trip')} />)
    await act(async () => client.emit('workers.status', { status: status() }))
    expect(screen.getByTestId('own-session').textContent).toContain('Uses your plan limits on each start')
    await act(async () => {
      fireEvent.click(screen.getByTestId('own-session-switch'))
      await wait()
    })
    // Signing is async: the patch lands after the click settles.
    await waitFor(() => expect(client.sent.filter((f) => f.type === 'config.patch')).toHaveLength(1))
    const patch = client.sent.filter((f) => f.type === 'config.patch').at(-1) as {
      patch: { threads: Array<{ id: string; session?: string }> }
      stepup_token?: string
    }
    expect(patch.patch.threads.find((t) => t.id === 'trip')?.session).toBe('dedicated')
    expect(patch.stepup_token).toBeUndefined()
    await waitFor(() => expect(thread(client, 'trip').session).toBe('dedicated'))
  })

  it('a dedicated thread shows its worker state; Park now sends thread.session.control and shows the result', async () => {
    const client = setup()
    withConfig(client, (c) => ({
      dedicated: { enabled: true },
      threads: [...c.threads, { ...trip, session: 'dedicated' }],
    }))
    mount(client, <OwnSession thread={thread(client, 'trip')} />)
    await act(async () =>
      client.emit('workers.status', { status: status({ threads: [{ thread_id: 'trip', state: 'live' }] }) }),
    )
    expect(screen.getByTestId('own-session-state').textContent).toBe('Live')
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Park now' }))
      await wait()
    })
    await waitFor(() => expect(client.sent.filter((f) => f.type === 'thread.session.control')).toHaveLength(1))
    const sent = client.sent.filter((f) => f.type === 'thread.session.control').at(-1) as {
      control_id: string
      thread_id: string
      action: string
      osig?: string
    }
    expect(sent).toMatchObject({ thread_id: 'trip', action: 'park' })
    expect(sent.osig).toBeTruthy()
    await act(async () => {
      client.emit('session.control.result', {
        control_id: sent.control_id,
        ok: true,
        text: 'Parking this thread’s session.',
        at: '2026-10-30T00:00:00.000Z',
      })
      await wait()
    })
    expect(screen.getByRole('status').textContent).toContain('Parking')
  })

  it('a failed worker explains itself and offers Start fresh', async () => {
    const client = setup()
    withConfig(client, (c) => ({
      dedicated: { enabled: true },
      threads: [...c.threads, { ...trip, session: 'dedicated' }],
    }))
    mount(client, <OwnSession thread={thread(client, 'trip')} />)
    await act(async () =>
      client.emit('workers.status', {
        status: status({ threads: [{ thread_id: 'trip', state: 'failed', error: 'resume_missing' }] }),
      }),
    )
    expect(screen.getByTestId('own-session-state').textContent).toMatch(/can't be resumed/)
    expect(screen.getByRole('button', { name: 'Start fresh' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Restart' })).toBeNull()
  })

  it('D48: a needs_mac worker offers Restart (resumes the answered dialog); other failures do not', async () => {
    const client = setup()
    withConfig(client, (c) => ({
      dedicated: { enabled: true },
      threads: [...c.threads, { ...trip, session: 'dedicated' }],
    }))
    mount(client, <OwnSession thread={thread(client, 'trip')} />)
    await act(async () =>
      client.emit('workers.status', {
        status: status({ threads: [{ thread_id: 'trip', state: 'failed', error: 'needs_mac' }] }),
      }),
    )
    expect(screen.getByTestId('own-session-state').textContent).toMatch(/press Restart/)
    expect(screen.getByRole('button', { name: 'Restart' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Start fresh' })).toBeTruthy()
  })
})

describe('Settings → Thread sessions', () => {
  it('the master switch is off by default and turns on with a config.patch', async () => {
    const client = setup()
    withConfig(client, () => ({}))
    mount(client, <ThreadSessionsSection readOnly={false} />)
    await act(async () => client.emit('workers.status', { status: status() }))
    const sw = screen.getByRole('switch', { name: 'Allow threads to have their own session' })
    expect(sw.getAttribute('aria-checked')).toBe('false')
    await act(async () => {
      fireEvent.click(sw)
      await wait()
    })
    await waitFor(() => expect(client.sent.filter((f) => f.type === 'config.patch')).toHaveLength(1))
    const patch = client.sent.filter((f) => f.type === 'config.patch').at(-1) as { patch: unknown }
    expect(patch.patch).toEqual({ dedicated: { enabled: true } })
  })

  it('parked rows appear, and the governor banner shows when limits are close', async () => {
    const client = setup()
    withConfig(client, (c) => ({
      dedicated: { enabled: true },
      threads: [...c.threads, { ...trip, session: 'dedicated' }],
    }))
    mount(client, <ThreadSessionsSection readOnly={false} />)
    await act(async () =>
      client.emit('workers.status', {
        status: status({
          threads: [{ thread_id: 'trip', state: 'parked', parked_at: '2026-10-30T14:02:00.000Z', model: 'sonnet' }],
          governor: { state: 'paused' },
        }),
      }),
    )
    const rows = screen.getByTestId('thread-session-rows')
    expect(rows.textContent).toContain('Trip')
    expect(rows.textContent).toContain('Parked')
    expect(rows.textContent).toContain('sonnet')
    expect(screen.getByTestId('thread-sessions-paused').textContent).toContain('Saving limits')
  })

  it('in trust mode the close-to-limits band only warns: no "paused" wording, and park-all still says paused', async () => {
    const client = setup()
    withConfig(client, (c) => ({
      trust_mode: true,
      dedicated: { enabled: true },
      threads: [...c.threads, { ...trip, session: 'dedicated' }],
    }))
    mount(client, <ThreadSessionsSection readOnly={false} />)
    const send = (state: 'paused' | 'park_all') =>
      act(async () => client.emit('workers.status', { status: status({ threads: [], governor: { state } }) }))
    await send('paused')
    const warn = screen.getByTestId('thread-sessions-paused').textContent ?? ''
    expect(warn).toContain('Limits are close')
    expect(warn).not.toMatch(/paused/i)
    await send('park_all')
    expect(screen.getByTestId('thread-sessions-paused').textContent).toContain('Saving limits: thread sessions paused')
  })

  it('an old Mac (no workers.status) says it needs a newer Talos', () => {
    const client = setup()
    getThreadSessionsController(client) // fresh store, nothing received
    mount(client, <ThreadSessionsSection readOnly={false} />)
    expect(screen.getByTestId('thread-sessions').textContent).toContain('needs a newer Talos')
  })
})

describe('the status store starts at the root', () => {
  it('a ready that arrived before any screen opened still shows in Settings', async () => {
    const client = setup()
    withConfig(client, () => ({ dedicated: { enabled: true } }))
    const stop = getThreadSessionsController(client).start() // what SessionBoot does at the app root
    await wait()
    const s = client.store.getState()
    client.emit('ready', {
      session_id: 'sess_1',
      policy: { max_frame_bytes: 262144, ping_ms: 25000 },
      server_seq: 0,
      presence: s.presence,
      workers_status: status({ threads: [{ thread_id: 'trip', state: 'parked' }] }),
    })
    mount(client, <ThreadSessionsSection readOnly={false} />)
    await wait()
    expect(screen.getByTestId('thread-session-rows').textContent).toContain('Parked')
    stop()
  })

  it('an unknown state from a newer Mac reads as Unknown, with the switch still there', async () => {
    const client = setup()
    withConfig(client, (c) => ({
      dedicated: { enabled: true },
      threads: [...c.threads, { ...trip, session: 'dedicated' }],
    }))
    mount(client, <OwnSession thread={thread(client, 'trip')} />)
    await act(async () =>
      client.emit('workers.status', { status: status({ threads: [{ thread_id: 'trip', state: 'unknown' }] }) }),
    )
    expect(screen.getByTestId('own-session-state').textContent).toBe('Unknown')
    expect(screen.getByTestId('own-session-switch')).toBeTruthy()
  })
})

describe('main session state stays main', () => {
  it('a thread-scoped session.state does not replace main’s', async () => {
    const client = setup()
    const ctl = getSessionController(client)
    const stop = ctl.start()
    await wait()
    const base = {
      source: 'mod' as const,
      capabilities: [],
      rate_limits: [],
      surfaces: [],
      at: '2026-10-30T00:00:00.000Z',
    }
    client.emit('session.state', { state: { ...base, session_id: 'main-1' } })
    client.emit('session.state', { state: { ...base, session_id: 'worker-1', scope: { thread_id: 'trip' } } })
    await wait()
    expect(ctl.store.getState().state?.session_id).toBe('main-1')
    stop()
  })
})
