// The context chip (top right, and the phone header's ring) and the Session panel show the context of the session that
// answers the open thread: a thread with its own session shows THAT worker's, never main's. Weekly usage is account-wide
// and stays main's everywhere. A worker that is parked or not started shows its last known value dimmed, or "not running".
import {
  AgentConfig,
  type AgentConfigT,
  THREAD_SESSIONS_FEATURE,
  type ThreadT,
  type WorkersStatusT,
} from '@talos-app/protocol'
import { act, cleanup, render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { afterEach, describe, expect, it } from 'vitest'
import { chipParts } from '../../src/features/session/logic.ts'
import { SessionPanel } from '../../src/features/session/SessionPanel.tsx'
import { SessionTrigger } from '../../src/features/session/SessionTrigger.tsx'
import { getSessionController } from '../../src/features/session/store.ts'
import { ClientProvider } from '../../src/lib/client.ts'
import type { FakeClient } from '../../src/lib/fakeClient.ts'
import { createMemoryStorage } from '../../src/lib/storage.ts'
import { StorageProvider } from '../../src/lib/storageContext.tsx'
import { setup } from '../cards/helpers.tsx'

afterEach(cleanup)

const trip: ThreadT = {
  id: 'trip',
  name: 'Trip',
  kind: 'fixed',
  order: 2,
  notify: 'all',
  voice_context: 'recent',
  archived: false,
  created_at: '2026-10-28T00:00:00.000Z',
  session: 'dedicated',
}
const plain: ThreadT = { ...trip, id: 'plain', name: 'Plain', order: 3 }
delete (plain as { session?: string }).session

const at = () => new Date().toISOString()
const MAIN = () => ({
  session_id: 'main-1',
  source: 'mod' as const,
  capabilities: ['stop' as const],
  context: { tokens: 62_000, window: 200_000, percent: 31 },
  rate_limits: [{ kind: 'seven_day', percent: 60 }],
  surfaces: [],
  at: at(),
})
const WORKER = () => ({
  session_id: 'w-1',
  scope: { thread_id: 'trip' },
  source: 'hooks' as const,
  capabilities: [],
  context: { tokens: 126_000, window: 200_000, percent: 63 },
  rate_limits: [],
  surfaces: [],
  at: at(),
})
const status = (state?: WorkersStatusT['threads'][number]['state']): WorkersStatusT => ({
  supported: true,
  supervisor_online: true,
  threads: state ? [{ thread_id: 'trip', state }] : [],
  governor: { state: 'ok' },
  at: '2026-10-30T00:00:00.000Z',
})

function boot(ui: (client: FakeClient) => React.ReactElement) {
  const client = setup({ mod: 'absent' })
  const cur = client.store.getState().config as AgentConfigT
  const next = AgentConfig.parse({ ...cur, threads: [...cur.threads, trip, plain], dedicated: { enabled: true } })
  const presence = client.store.getState().presence
  client.store.setState({
    config: next,
    threads: next.threads,
    presence: { ...presence, features: [...(presence.features ?? []), THREAD_SESSIONS_FEATURE] },
  })
  getSessionController(client).start()
  const view = render(
    <StorageProvider storage={createMemoryStorage()}>
      <ClientProvider client={client}>
        <MemoryRouter>{ui(client)}</MemoryRouter>
      </ClientProvider>
    </StorageProvider>,
  )
  return { client, view }
}

async function feed(client: FakeClient, worker: ReturnType<typeof WORKER> | null, st?: Parameters<typeof status>[0]) {
  await act(async () => {
    client.emit('session.state', { state: MAIN() })
    if (worker) client.emit('session.state', { state: worker })
    client.emit('workers.status', { status: status(st) })
  })
}

const chip = () => screen.getByTestId('session-chip')
const text = () => chip().textContent ?? ''

describe('the chip', () => {
  it('a thread with its own live session shows the worker context, and weekly stays main’s', async () => {
    const { client } = boot(() => <SessionTrigger threadId="trip" />)
    await feed(client, WORKER(), 'live')
    expect(text()).toContain('ctx 63%')
    expect(text()).not.toContain('ctx 31%')
    expect(text()).toContain('wk 60%')
    expect(chip().getAttribute('data-ctx')).toBe('worker')
  })

  it('a busy worker counts as running too', async () => {
    const { client } = boot(() => <SessionTrigger threadId="trip" />)
    await feed(client, WORKER(), 'busy')
    expect(text()).toContain('ctx 63%')
  })

  it('a parked worker shows its last known value, dimmed, never main’s', async () => {
    const { client } = boot(() => <SessionTrigger threadId="trip" />)
    await feed(client, WORKER(), 'parked')
    expect(text()).toContain('ctx 63%')
    expect(text()).not.toContain('31%')
    expect(text()).toContain('wk 60%')
    expect(chip().getAttribute('data-ctx')).toBe('last')
  })

  it('a worker not started, with no reading yet, says not running — never main’s numbers', async () => {
    const { client } = boot(() => <SessionTrigger threadId="trip" />)
    await feed(client, null, 'off')
    expect(text()).toContain('not running')
    expect(text()).not.toContain('31%')
    expect(text()).toContain('wk 60%')
    expect(chip().getAttribute('data-ctx')).toBe('off')
  })

  it('no worker status at all (an older Mac) is also not running, not main', async () => {
    const { client } = boot(() => <SessionTrigger threadId="trip" />)
    await act(async () => client.emit('session.state', { state: MAIN() }))
    expect(text()).toContain('not running')
    expect(text()).not.toContain('31%')
  })

  it('a thread answered by main still shows main’s', async () => {
    const { client } = boot(() => <SessionTrigger threadId="plain" />)
    await feed(client, WORKER(), 'live')
    expect(text()).toContain('ctx 31%')
    expect(text()).not.toContain('63%')
    expect(text()).toContain('wk 60%')
    expect(chip().getAttribute('data-ctx')).toBe('main')
  })

  it('switching threads switches the numbers; weekly does not move', async () => {
    const { client, view } = boot(() => <SessionTrigger threadId="trip" />)
    await feed(client, WORKER(), 'live')
    expect(text()).toContain('ctx 63%')
    const tree = (id: string) => (
      <StorageProvider storage={createMemoryStorage()}>
        <ClientProvider client={client}>
          <MemoryRouter>
            <SessionTrigger threadId={id} />
          </MemoryRouter>
        </ClientProvider>
      </StorageProvider>
    )
    view.rerender(tree('plain'))
    expect(text()).toContain('ctx 31%')
    expect(text()).toContain('wk 60%')
    view.rerender(tree('trip'))
    expect(text()).toContain('ctx 63%')
    expect(text()).toContain('wk 60%')
  })

  it('a state that arrives in ready.thread_session_states is used, and a garbled one is ignored', async () => {
    const { client } = boot(() => <SessionTrigger threadId="trip" />)
    const s = client.store.getState()
    await act(async () => {
      client.emit('ready', {
        session_id: 'sess_1',
        policy: { max_frame_bytes: 262144, ping_ms: 25000 },
        server_seq: 0,
        presence: s.presence,
        session_state: MAIN(),
        workers_status: status('live'),
        thread_session_states: [
          { thread_id: 'trip', state: WORKER() },
          { thread_id: 'plain', state: { session_id: 'x', context: 'nope' } },
        ],
      })
    })
    expect(text()).toContain('ctx 63%')
  })

  it('the worker’s state does not replace main’s: the main-routed chip never reads it', async () => {
    const { client } = boot(() => <SessionTrigger threadId="plain" />)
    await feed(client, WORKER(), 'live')
    expect(getSessionController(client).store.getState().state?.session_id).toBe('main-1')
  })
})

describe('review fixes', () => {
  it('a worker reading shows even when main has no state yet', async () => {
    const { client } = boot(() => <SessionTrigger threadId="trip" />)
    await act(async () => {
      client.emit('session.state', { state: WORKER() })
      client.emit('workers.status', { status: status('live') })
    })
    expect(text()).toContain('ctx 63%')
  })

  it('chipParts keeps a worker reading with no main state', () => {
    expect(chipParts(undefined, { kind: 'worker', ctx: { used: 63 } })).toEqual({ ctx: 63, kind: 'worker' })
    expect(chipParts(undefined, { kind: 'main', ctx: undefined })).toBeUndefined()
  })

  it('"ctx not running" is a separate word from the weekly reading, for anything that joins the text', async () => {
    const { client } = boot(() => <SessionTrigger threadId="trip" />)
    await feed(client, null, 'off')
    expect(text()).toContain('wk 60% used ctx not running')
  })
})

describe('the panel', () => {
  const panel = (id: string) => () => <SessionPanel threadId={id} />
  const ctxText = () => screen.getByTestId('meter-context').textContent ?? ''
  const weekText = () => screen.getByTestId('meter-week').textContent ?? ''

  it('a dedicated live thread: the worker’s percent and tokens, main’s weekly', async () => {
    const { client } = boot(panel('trip'))
    await feed(client, WORKER(), 'live')
    expect(ctxText()).toContain('63% used')
    expect(ctxText()).toContain('126k of 200k tokens')
    expect(ctxText()).not.toContain('31%')
    expect(weekText()).toContain('60% used')
  })

  it('a parked worker: last known, marked as such, dimmed', async () => {
    const { client } = boot(panel('trip'))
    await feed(client, WORKER(), 'parked')
    expect(ctxText()).toContain('63% used')
    expect(ctxText()).toContain('last known')
    expect(screen.getByTestId('meter-context').getAttribute('data-stale')).toBe('true')
    expect(weekText()).toContain('60% used')
  })

  it('a worker not started: "Not running", not main’s 31%', async () => {
    const { client } = boot(panel('trip'))
    await feed(client, null, 'off')
    expect(ctxText()).toContain('Not running')
    expect(ctxText()).not.toContain('31%')
    expect(weekText()).toContain('60% used')
  })

  it('a main-routed thread: main’s', async () => {
    const { client } = boot(panel('plain'))
    await feed(client, WORKER(), 'live')
    expect(ctxText()).toContain('31% used')
    expect(weekText()).toContain('60% used')
  })
})
