// PR #69 review round 2 at 3c3da96 (Option C WP-OC4, docs/OPTION-C.md): adversarial tests against the real web components and the real
// thread-sessions / session stores, driven through the in-memory fake client (signed owner frames, real merge-patch and
// thread-patch rules). Tests named REVIEW-FAIL assert the correct behaviour and fail on 3c3da96; the rest document what
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
import { OwnSession } from '../../src/features/thread-sessions/OwnSession.tsx'
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
const click = async (el: HTMLElement) =>
  act(async () => {
    fireEvent.click(el)
    await wait()
  })

// A config the Mac holds with a `dedicated` value this build can't fully read (a newer Mac allowing max_live 8, or a
// hand edit). AgentConfig.parse is the same schema parseFrame applies to `ready.agent_config` and `config.sync`.
describe('PR69 review r2: the owner can always switch off', () => {
  it('control: max_live 3 shows the master switch on', async () => {
    const client = setup()
    withConfig(client, () => ({ dedicated: { enabled: true, max_live: 3 } }))
    withFeature(client)
    mount(client, <ThreadSessionsSection readOnly={false} />)
    await act(async () => client.emit('workers.status', { status: status() }))
    const sw = screen.getByRole('switch', { name: 'Allow threads to have their own session' })
    expect(sw.getAttribute('aria-checked')).toBe('true')
  })

  it('REVIEW-FAIL: with the Mac switched on and a dedicated block this build cannot fully read, the switch reads on and can be turned off', async () => {
    const client = setup()
    withConfig(client, () => ({ dedicated: { enabled: true, max_live: 8 } }))
    withFeature(client)
    mount(client, <ThreadSessionsSection readOnly={false} />)
    await act(async () => client.emit('workers.status', { status: status() }))
    const sw = screen.getByRole('switch', { name: 'Allow threads to have their own session' })
    expect(sw.getAttribute('aria-checked')).toBe('true')
    await click(sw)
    // Signing is async: the patch lands after the click settles.
    await waitFor(() => expect((client.store.getState().config as AgentConfigT).dedicated?.enabled).toBe(false))
  })

  it('REVIEW-FAIL: in that state a dedicated thread still offers Own session, so it can be turned back to shared', async () => {
    const client = setup()
    withConfig(client, (c) => ({
      dedicated: { enabled: true, max_live: 8 },
      threads: [...c.threads, { ...trip, session: 'dedicated' }, work],
    }))
    withFeature(client)
    mount(client, <OwnSession thread={thread(client, 'trip')} />)
    await act(async () => client.emit('workers.status', { status: status() }))
    expect(screen.queryByTestId('own-session-switch')).not.toBeNull()
  })
})
