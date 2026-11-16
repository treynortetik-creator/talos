// The session status line (the mock the owner approved, 2026-11-13): the thread row shows it instead of the last message
// only when there is something to say; the phone header shows a pill that opens the whole sentence, with "Open the request"
// when a permission card waits.
import {
  AgentConfig,
  type AgentConfigT,
  type CardT,
  composePermissionCard,
  THREAD_SESSIONS_FEATURE,
  type ThreadT,
  type WorkerStatusItemT,
  type WorkersStatusT,
} from '@talos-app/protocol'
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { afterEach, describe, expect, it } from 'vitest'
import { PhoneHeader } from '../../src/features/phone/PhoneHeader.tsx'
import { ThreadList } from '../../src/features/threads/ThreadList.tsx'
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

function dedicated(client: FakeClient) {
  const cur = client.store.getState().config as AgentConfigT
  const next = AgentConfig.parse({ ...cur, threads: [...cur.threads, trip], dedicated: { enabled: true } })
  const presence = client.store.getState().presence
  client.store.setState({
    config: next,
    threads: next.threads,
    presence: { ...presence, features: [...(presence.features ?? []), THREAD_SESSIONS_FEATURE] },
  })
}

const since = (min: number) => new Date(Date.now() - min * 60_000).toISOString()
const status = (item: Partial<WorkerStatusItemT>, over: Partial<WorkersStatusT> = {}): WorkersStatusT => ({
  supported: true,
  supervisor_online: true,
  threads: [{ thread_id: 'trip', state: 'live', ...item }],
  governor: { state: 'ok' },
  at: new Date().toISOString(),
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

const row = () => screen.getByTestId('thread-row-trip')

describe('the thread row', () => {
  it('waiting on the owner: the session line takes the preview’s place', async () => {
    const client = setup()
    dedicated(client)
    mount(client, <ThreadList />)
    await act(async () =>
      client.emit('workers.status', { status: status({ needs_you: { kind: 'trust this folder', since: since(12) } }) }),
    )
    const line = within(row()).getByTestId('session-line')
    expect(line.textContent).toBe('Needs you at the Mac · trust this folder')
    expect(line.getAttribute('data-tone')).toBe('needs')
  })

  it('working and stopped show; plain idle keeps the last message', async () => {
    const client = setup()
    dedicated(client)
    mount(client, <ThreadList />)
    await act(async () =>
      client.emit('workers.status', { status: status({ state: 'busy', turn_started_at: since(25) }) }),
    )
    expect(within(row()).getByTestId('session-line').textContent).toMatch(/^Working · since .+ \(2[45] min\)$/)
    await act(async () => client.emit('workers.status', { status: status({ state: 'parked', stopped_why: 'owner' }) }))
    expect(within(row()).getByTestId('session-line').textContent).toBe('Stopped by you')
    await act(async () => client.emit('workers.status', { status: status({ state: 'live', last_turn_at: since(5) }) }))
    expect(within(row()).queryByTestId('session-line')).toBeNull()
  })

  it('a thread without its own session never shows a session line', async () => {
    const client = setup()
    mount(client, <ThreadList />)
    await act(async () =>
      client.emit('workers.status', { status: status({ needs_you: { kind: 'sign in', since: since(3) } }) }),
    )
    expect(screen.queryByTestId('session-line')).toBeNull()
  })

  it('the Mac not reporting: says so, never a live line', async () => {
    const client = setup()
    dedicated(client)
    mount(client, <ThreadList />)
    await act(async () =>
      client.emit('workers.status', {
        status: status({ state: 'busy', turn_started_at: since(25) }, { supervisor_online: false, at: since(20) }),
      }),
    )
    expect(within(row()).getByTestId('session-line').textContent).toMatch(/^Mac offline · last heard /)
  })
})

describe('the phone header', () => {
  const thread = (client: FakeClient) => client.store.getState().threads.find((t) => t.id === 'trip') as ThreadT

  it('a pill with the word; a tap opens the sentence, the step at the Mac, and nothing to approve', async () => {
    const client = setup()
    dedicated(client)
    mount(client, <PhoneHeader thread={thread(client)} state={undefined} />)
    await act(async () =>
      client.emit('workers.status', {
        status: status({
          needs_you: {
            kind: 'usage limit',
            since: since(30),
            resets_at: new Date(Date.now() + 3 * 3_600_000).toISOString(),
            step: 'press Esc in its pane at the Mac',
          },
        }),
      }),
    )
    const pill = screen.getByTestId('phone-session-pill')
    expect(pill.textContent).toBe('Needs you')
    fireEvent.click(pill)
    const sheet = await screen.findByTestId('session-sheet')
    expect(sheet.textContent).toMatch(/Usage limit · resets /)
    expect(sheet.textContent).toContain('To go on: press Esc in its pane at the Mac')
    expect(within(sheet).queryByTestId('session-open-request')).toBeNull()
  })

  it('a thread without its own session keeps the plain status dot', async () => {
    const client = setup()
    mount(client, <PhoneHeader thread={client.store.getState().threads[0] as ThreadT} state={undefined} />)
    expect(screen.queryByTestId('phone-session-pill')).toBeNull()
    expect(screen.getByTestId('phone-status')).toBeTruthy()
  })

  const permissionCard = (): CardT =>
    composePermissionCard({
      request: {
        request_id: 'abcde',
        tool_name: 'Bash',
        description: 'Run the tests',
        input_preview: '{"command": "pnpm test"}',
      },
      card_id: 'c_01JBF3V7Q8K2M4N6P8R0S2T4E0',
      thread_id: 'trip',
      now: Date.now(),
      client_version: '2.1.312',
    })

  it('a pending permission card: "Needs you · a permission request" and the sheet opens it', async () => {
    const card = permissionCard()
    const client = setup({ cards: [card] })
    dedicated(client)
    mount(client, <PhoneHeader thread={thread(client)} state={undefined} />)
    await act(async () =>
      client.emit('workers.status', { status: status({ state: 'busy', turn_started_at: since(4) }) }),
    )
    fireEvent.click(screen.getByTestId('phone-session-pill'))
    const sheet = await screen.findByTestId('session-sheet')
    expect(sheet.textContent).toContain('Needs you · a permission request')
    expect(within(sheet).getByTestId('session-open-request').getAttribute('href')).toBe(`/card/${card.id}`)
  })

  it('another kind of card is not a permission request', async () => {
    const card: CardT = { ...permissionCard(), kind: 'generic' }
    const client = setup({ cards: [card] })
    dedicated(client)
    mount(client, <PhoneHeader thread={thread(client)} state={undefined} />)
    await act(async () =>
      client.emit('workers.status', { status: status({ state: 'busy', turn_started_at: since(4) }) }),
    )
    expect(screen.getByTestId('phone-session-pill').getAttribute('aria-label')).toMatch(/^Working: Working · since /)
  })

  it('this page not connected: the last picture, never said as live', async () => {
    const client = setup()
    dedicated(client)
    mount(client, <PhoneHeader thread={thread(client)} state={undefined} />)
    await act(async () =>
      client.emit('workers.status', { status: status({ state: 'busy', turn_started_at: since(4) }) }),
    )
    await act(async () => client.store.setState({ connection: 'offline' }))
    expect(screen.getByTestId('phone-session-pill').getAttribute('aria-label')).toMatch(/^Offline: Not connected/)
  })

  it('a plain idle session keeps the agent’s own status in the header', async () => {
    const client = setup()
    dedicated(client)
    mount(client, <PhoneHeader thread={thread(client)} state="on_call" />)
    await act(async () => client.emit('workers.status', { status: status({ state: 'live', last_turn_at: since(2) }) }))
    expect(screen.queryByTestId('phone-session-pill')).toBeNull()
    expect(screen.getByTestId('phone-status').textContent).toContain('On a call')
  })
})
