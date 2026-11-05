// PR #69 review (Option C WP-OC4, docs/OPTION-C.md): adversarial tests against the real web components and the real
// thread-sessions / session stores, driven through the in-memory fake client (signed owner frames, real merge-patch and
// thread-patch rules). Tests named REVIEW-FAIL assert the correct behaviour and fail on fe43b0d; the rest document what
// holds.
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

const base = {
  kind: 'fixed' as const,
  notify: 'all' as const,
  voice_context: 'recent' as const,
  archived: false,
  created_at: '2026-10-28T00:00:00.000Z',
}
const trip: ThreadT = { ...base, id: 'trip', name: 'Trip', order: 2 }
const work: ThreadT = { ...base, id: 'work', name: 'Work', order: 3 }

function withConfig(client: FakeClient, change: (c: AgentConfigT) => Record<string, unknown> = () => ({})) {
  const cur = client.store.getState().config as AgentConfigT
  const next = AgentConfig.parse({ ...cur, threads: [...cur.threads, trip, work], ...change(cur) })
  client.store.setState({ config: next, threads: next.threads })
}
/** The bridge advertises thread-sessions/1 (presence.features), as a Mac with PR #65 does. */
function withFeature(client: FakeClient, on = true) {
  const p = client.store.getState().presence
  const features = (p.features ?? []).filter((f) => f !== THREAD_SESSIONS_FEATURE)
  client.store.setState({ presence: { ...p, features: on ? [...features, THREAD_SESSIONS_FEATURE] : features } })
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
const patches = (client: FakeClient) =>
  client.sent.filter((f) => f.type === 'config.patch') as Array<{
    patch: Record<string, unknown>
    base_rev: number
    osig?: string
    stepup_token?: string
  }>
const controls = (client: FakeClient) =>
  client.sent.filter((f) => f.type === 'thread.session.control') as Array<{
    control_id: string
    thread_id: string
    action: string
    osig?: string
  }>
const click = async (el: HTMLElement) =>
  act(async () => {
    fireEvent.click(el)
    await wait()
  })

// ---- 1. the switch only changes config through the owner-signed config.patch --------------------------------------

describe('PR69 review: Own session switch writes config', () => {
  it('turning a thread to shared is one signed config.patch with base_rev; other fields and threads are untouched', async () => {
    const client = setup()
    withConfig(client, (c) => ({
      dedicated: { enabled: true, max_live: 2 },
      threads: [
        ...c.threads,
        {
          ...trip,
          session: 'dedicated',
          color: 'teal',
          topic: 'Planning the trip',
          session_opts: { model: 'sonnet', idle_park_min: 45 },
        },
        { ...work, session: 'dedicated', color: 'amber' },
      ],
    }))
    withFeature(client)
    const rev = (client.store.getState().config as AgentConfigT).rev
    mount(client, <OwnSession thread={thread(client, 'trip')} />)
    await act(async () => client.emit('workers.status', { status: status() }))
    const sw = screen.getByTestId('own-session-switch')
    expect(sw.getAttribute('aria-checked')).toBe('true')
    await click(sw)
    // Signing is async: the patch lands after the click settles.
    await waitFor(() => expect(patches(client)).toHaveLength(1))
    const p = patches(client)
    expect(p[0]?.base_rev).toBe(rev)
    expect(p[0]?.osig).toBeTruthy()
    expect(p[0]?.stepup_token).toBeUndefined()
    const after = thread(client, 'trip')
    expect(after.session ?? 'shared').toBe('shared')
    expect(after.color).toBe('teal')
    expect(after.topic).toBe('Planning the trip')
    expect(after.session_opts?.model).toBe('sonnet')
    expect(after.session_opts?.idle_park_min).toBe(45)
    expect(thread(client, 'work').session).toBe('dedicated')
    expect(thread(client, 'work').color).toBe('amber')
    const d = (client.store.getState().config as AgentConfigT).dedicated
    expect(d?.max_live).toBe(2)
  })

  it('the master switch is an RFC 7386 merge: max_live and governor survive turning it off', async () => {
    const client = setup()
    withConfig(client, () => ({
      dedicated: { enabled: true, max_live: 5, governor: { five_hour: 60, weekly: 70, park_all: 90, off: true } },
    }))
    mount(client, <ThreadSessionsSection readOnly={false} />)
    await act(async () => client.emit('workers.status', { status: status() }))
    await click(screen.getByRole('switch', { name: 'Allow threads to have their own session' }))
    // Signing is async: the patch lands after the click settles.
    await waitFor(() => expect(patches(client).at(-1)?.patch).toEqual({ dedicated: { enabled: false } }))
    expect(patches(client).at(-1)?.osig).toBeTruthy()
    await waitFor(() => {
      const d = (client.store.getState().config as AgentConfigT).dedicated
      expect(d).toMatchObject({ enabled: false, max_live: 5, governor: { five_hour: 60, park_all: 90, off: true } })
    })
  })

  it('a refusal (thread_session_refused) is shown and the switch stays off (no optimistic lie)', async () => {
    const client = setup()
    withConfig(client, () => ({ dedicated: { enabled: true } }))
    withFeature(client)
    mount(client, <OwnSession thread={thread(client, 'trip')} />)
    await act(async () => client.emit('workers.status', { status: status() }))
    client.failNextPatchWith('thread_session_refused')
    await click(screen.getByTestId('own-session-switch'))
    expect(screen.getByRole('alert').textContent).toBeTruthy()
    expect(screen.getByTestId('own-session-switch').getAttribute('aria-checked')).toBe('false')
    expect(thread(client, 'trip').session ?? 'shared').toBe('shared')
  })

  it('REVIEW-FAIL: a config_conflict reads as a sentence, like every other thread edit (useThreadPatch), not the raw code', async () => {
    const client = setup()
    withConfig(client, () => ({ dedicated: { enabled: true } }))
    withFeature(client)
    mount(client, <OwnSession thread={thread(client, 'trip')} />)
    await act(async () => client.emit('workers.status', { status: status() }))
    client.failNextPatchWith('config_conflict')
    await click(screen.getByTestId('own-session-switch'))
    const text = screen.getByRole('alert').textContent ?? ''
    expect(text).not.toContain('config_conflict')
    expect(text).toMatch(/try again/i)
  })
})

// ---- 2. default off everywhere -------------------------------------------------------------------------------------

describe('PR69 review: hidden unless every condition holds', () => {
  it('REVIEW-FAIL: hidden when the Mac does not list thread-sessions/1, even with workers.status.supported', async () => {
    const client = setup()
    withConfig(client, () => ({ dedicated: { enabled: true } }))
    withFeature(client, false)
    mount(client, <OwnSession thread={thread(client, 'trip')} />)
    await act(async () => client.emit('workers.status', { status: status() }))
    expect(screen.queryByTestId('own-session')).toBeNull()
  })

  it('shown when the feature is listed, the master switch is on and the Mac supports it', async () => {
    const client = setup()
    withConfig(client, () => ({ dedicated: { enabled: true } }))
    withFeature(client)
    mount(client, <OwnSession thread={thread(client, 'trip')} />)
    await act(async () => client.emit('workers.status', { status: status() }))
    expect(screen.getByTestId('own-session-switch')).toBeTruthy()
  })

  it('hidden with no workers.status at all, for an archived thread, for a system thread and for the default thread', async () => {
    const client = setup()
    withConfig(client, (c) => ({
      dedicated: { enabled: true },
      default_thread: 'work',
      threads: [...c.threads, { ...trip, archived: true }, work],
    }))
    withFeature(client)
    // nothing received yet
    const first = mount(client, <OwnSession thread={thread(client, 'work')} />)
    expect(screen.queryByTestId('own-session')).toBeNull()
    first.unmount()
    await act(async () => client.emit('workers.status', { status: status() }))
    const ids = [
      'trip',
      'work',
      ...client.store
        .getState()
        .threads.filter((t) => t.kind === 'system')
        .map((t) => t.id),
    ]
    for (const id of ids) {
      const { unmount } = mount(client, <OwnSession thread={thread(client, id)} />)
      expect(screen.queryByTestId('own-session'), id).toBeNull()
      unmount()
    }
  })
})

// ---- 3. status correctness -----------------------------------------------------------------------------------------

describe('PR69 review: status', () => {
  it("thread A's worker state is never shown on thread B", async () => {
    const client = setup()
    withConfig(client, (c) => ({
      dedicated: { enabled: true },
      threads: [...c.threads, { ...trip, session: 'dedicated' }, { ...work, session: 'dedicated' }],
    }))
    withFeature(client)
    mount(client, <OwnSession thread={thread(client, 'work')} />)
    await act(async () =>
      client.emit('workers.status', {
        status: status({ threads: [{ thread_id: 'trip', state: 'failed', error: 'crash_loop' }] }),
      }),
    )
    expect(screen.getByTestId('own-session-state').textContent).toBe('Starts with the next message.')
    expect(screen.queryByRole('button', { name: 'Start fresh' })).toBeNull()
  })

  it('REVIEW-FAIL: a reconnect whose ready has no workers_status (older Mac / relay) drops the previous status', async () => {
    const client = setup()
    withConfig(client, () => ({ dedicated: { enabled: true } }))
    withFeature(client)
    const ctl = getThreadSessionsController(client)
    const stop = ctl.start()
    client.emit('workers.status', { status: status() })
    expect(ctl.store.getState().status?.supported).toBe(true)
    const s = client.store.getState()
    client.emit('ready', {
      session_id: 'sess_1',
      policy: { max_frame_bytes: 262144, ping_ms: 25000 },
      server_seq: 0,
      presence: s.presence,
    })
    expect(ctl.store.getState().status).toBeUndefined()
    stop()
  })

  it('the governor banner shows for park_all with its reset time, and not for ok', async () => {
    const client = setup()
    withConfig(client, () => ({ dedicated: { enabled: true } }))
    mount(client, <ThreadSessionsSection readOnly={false} />)
    await act(async () => client.emit('workers.status', { status: status() }))
    expect(screen.queryByTestId('thread-sessions-paused')).toBeNull()
    await act(async () =>
      client.emit('workers.status', {
        status: status({ governor: { state: 'park_all', resets_at: '2026-10-30T18:00:00.000Z' } }),
      }),
    )
    expect(screen.getByTestId('thread-sessions-paused').textContent).toMatch(/paused until .*Main keeps answering/)
  })

  it('a thread-scoped session.state and ready.thread_session_states never replace main in the session store', async () => {
    const client = setup()
    const ctl = getSessionController(client)
    const stop = ctl.start()
    const st = {
      source: 'mod' as const,
      capabilities: [],
      rate_limits: [],
      surfaces: [],
      at: '2026-10-30T00:00:00.000Z',
    }
    client.emit('session.state', { state: { ...st, session_id: 'main-1' } })
    client.emit('session.state', { state: { ...st, session_id: 'w-1', scope: { thread_id: 'trip' } } })
    const s = client.store.getState()
    client.emit('ready', {
      session_id: 'sess_1',
      policy: { max_frame_bytes: 262144, ping_ms: 25000 },
      server_seq: 0,
      presence: s.presence,
      thread_session_states: [{ thread_id: 'trip', state: { ...st, session_id: 'w-2', scope: { thread_id: 'trip' } } }],
    })
    expect(ctl.store.getState().state?.session_id).toBe('main-1')
    stop()
  })

  it('REVIEW-FAIL: a scoped state in ready.session_state is not taken as main (the session.state filter is not applied to ready)', async () => {
    const client = setup()
    const ctl = getSessionController(client)
    const stop = ctl.start()
    const st = {
      source: 'mod' as const,
      capabilities: [],
      rate_limits: [],
      surfaces: [],
      at: '2026-10-30T00:00:00.000Z',
    }
    client.emit('session.state', { state: { ...st, session_id: 'main-1' } })
    const s = client.store.getState()
    client.emit('ready', {
      session_id: 'sess_1',
      policy: { max_frame_bytes: 262144, ping_ms: 25000 },
      server_seq: 0,
      presence: s.presence,
      session_state: { ...st, session_id: 'w-1', scope: { thread_id: 'trip' } },
    })
    expect(ctl.store.getState().state?.session_id).toBe('main-1')
    stop()
  })
})

// ---- 4. controls ---------------------------------------------------------------------------------------------------

describe('PR69 review: controls', () => {
  async function dedicatedTrip(state: 'live' | 'parked' | 'failed' = 'live') {
    const client = setup()
    withConfig(client, (c) => ({
      dedicated: { enabled: true },
      threads: [...c.threads, { ...trip, session: 'dedicated' }],
    }))
    withFeature(client)
    mount(client, <OwnSession thread={thread(client, 'trip')} />)
    await act(async () =>
      client.emit('workers.status', { status: status({ threads: [{ thread_id: 'trip', state }] }) }),
    )
    return client
  }

  it('each control is signed, names the thread, gets a fresh control_id, and only its own result settles it', async () => {
    const client = await dedicatedTrip('live')
    await click(screen.getByRole('button', { name: 'Park now' }))
    await waitFor(() => expect(controls(client)).toHaveLength(1))
    const first = controls(client).at(-1)
    expect(first).toMatchObject({ thread_id: 'trip', action: 'park' })
    expect(first?.osig).toBeTruthy()
    // a result for some other control (main's session.control, or another device) must not settle this one
    await act(async () => {
      client.emit('session.control.result', {
        control_id: 'other',
        ok: false,
        text: 'Not yours',
        at: '2026-10-30T00:00:00.000Z',
      })
      await wait()
    })
    expect(screen.queryByRole('status')).toBeNull()
    expect(screen.getByRole('button', { name: 'Park now' }).hasAttribute('disabled')).toBe(true)
    await act(async () => {
      client.emit('session.control.result', {
        control_id: first?.control_id ?? '',
        ok: false,
        code: 'worker_unavailable',
        text: 'The supervisor is not running.',
        at: '2026-10-30T00:00:00.000Z',
      })
      await wait()
    })
    expect(screen.getByRole('status').textContent).toContain('The supervisor is not running.')
    await click(screen.getByRole('button', { name: 'Restart' }))
    await waitFor(() => expect(controls(client)).toHaveLength(2))
    const second = controls(client).at(-1)
    expect(second).toMatchObject({ thread_id: 'trip', action: 'restart' })
    expect(second?.control_id).not.toBe(first?.control_id)
  })

  it('no control buttons and no state line for a shared thread', async () => {
    const client = setup()
    withConfig(client, () => ({ dedicated: { enabled: true } }))
    withFeature(client)
    mount(client, <OwnSession thread={thread(client, 'trip')} />)
    await act(async () =>
      client.emit('workers.status', { status: status({ threads: [{ thread_id: 'trip', state: 'live' }] }) }),
    )
    expect(screen.queryByTestId('own-session-state')).toBeNull()
    expect(screen.queryByRole('button')).toBeNull()
  })
})

// ---- 5. old Mac -----------------------------------------------------------------------------------------------------

describe('PR69 review: older Mac', () => {
  it('REVIEW-FAIL: with the master switch already on and an old Mac (no workers.status), it can still be turned off', async () => {
    const client = setup()
    withConfig(client, () => ({ dedicated: { enabled: true } }))
    mount(client, <ThreadSessionsSection readOnly={false} />)
    expect(screen.getByTestId('thread-sessions').textContent).toContain('needs a newer Talos')
    // turning things off is never refused by the bridge (docs/OPTION-C.md); the app must still offer it
    const sw = screen.getByRole('switch', { name: 'Allow threads to have their own session' })
    await click(sw)
    await waitFor(() => expect((client.store.getState().config as AgentConfigT).dedicated?.enabled).toBe(false))
  })

  it('an old Mac with the master switch off: "needs a newer Talos" and no switch anywhere', async () => {
    const client = setup()
    withConfig(client)
    mount(client, <ThreadSessionsSection readOnly={false} />)
    expect(screen.getByTestId('thread-sessions').textContent).toContain('needs a newer Talos')
    expect(screen.queryByRole('switch')).toBeNull()
  })
})
