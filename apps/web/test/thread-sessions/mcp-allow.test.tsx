// The MCP allow list control in a thread's own-session sheet: off = no list (today's behaviour), on = only the servers
// named (talos-app is always there). Each change is one owner-signed thread patch; a refusal goes back to the saved list.
import {
  AgentConfig,
  type AgentConfigT,
  THREAD_SESSIONS_FEATURE,
  type ThreadT,
  type WorkersStatusT,
} from '@talos-app/protocol'
import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router'
import { afterEach, describe, expect, it } from 'vitest'
import { OwnSession } from '../../src/features/thread-sessions/OwnSession.tsx'
import { ClientProvider, useTalos } from '../../src/lib/client.ts'
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
const status: WorkersStatusT = {
  supported: true,
  supervisor_online: true,
  threads: [{ thread_id: 'trip', state: 'live' }],
  governor: { state: 'ok' },
  at: '2026-10-30T00:00:00.000Z',
}

/** The sheet reads its thread from the store, as the app does, so a saved change shows. */
function Live() {
  const thread = useTalos((s) => s.threads.find((t) => t.id === 'trip')) as ThreadT
  return <OwnSession thread={thread} />
}

async function mount(session_opts?: Record<string, unknown>) {
  const client: FakeClient = setup()
  const cur = client.store.getState().config as AgentConfigT
  const next = AgentConfig.parse({
    ...cur,
    dedicated: { enabled: true },
    threads: [...cur.threads, session_opts ? { ...trip, session_opts } : trip],
  })
  client.store.setState({
    config: next,
    threads: next.threads,
    presence: {
      ...client.store.getState().presence,
      features: [...(client.store.getState().presence.features ?? []), THREAD_SESSIONS_FEATURE],
    },
  })
  render(
    <StorageProvider storage={createMemoryStorage()}>
      <ClientProvider client={client}>
        <MemoryRouter>
          <Live />
        </MemoryRouter>
      </ClientProvider>
    </StorageProvider>,
  )
  await act(async () => client.emit('workers.status', { status }))
  return { client, box: await screen.findByTestId('mcp-allow') }
}
const list = (c: FakeClient) => c.store.getState().threads.find((t) => t.id === 'trip')?.session_opts?.mcp_allow
const patches = (c: FakeClient) => c.sent.filter((f) => f.type === 'config.patch')

describe('the MCP servers control', () => {
  it('starts off with no list, and says what that means', async () => {
    const { box } = await mount()
    expect(
      (within(box).getByRole('switch', { name: 'Limit MCP servers' }) as HTMLElement).getAttribute('aria-checked'),
    ).toBe('false')
    expect(box.textContent).toMatch(/whatever servers Claude Code gives it/)
    expect(within(box).queryByLabelText('Add a server')).toBeNull()
  })

  it('turning it on saves an empty list (talos-app only); turning it off removes the list', async () => {
    const { client, box } = await mount()
    await userEvent.click(within(box).getByRole('switch', { name: 'Limit MCP servers' }))
    await waitFor(() => expect(list(client)).toEqual([]))
    expect(box.textContent).toMatch(/Only talos-app and these/)
    await userEvent.click(within(box).getByRole('switch', { name: 'Limit MCP servers' }))
    await waitFor(() => expect(list(client)).toBeUndefined())
    expect(patches(client)).toHaveLength(2)
    // off is a null, not an omitted key: a patch that only leaves a key out keeps it (an old client must not wipe the list)
    const sent = (patches(client).at(-1) as unknown as { patch: { threads: ThreadT[] } }).patch.threads
    const tripOpts = (sent.find((t) => t.id === 'trip') as ThreadT).session_opts as Record<string, unknown>
    expect(tripOpts.mcp_allow).toBeNull()
  })

  it('adds servers by name (a connector name with a space too) and removes them, one signed patch each', async () => {
    const { client, box } = await mount({ mcp_allow: ['github'] })
    expect(within(box).getByRole('list', { name: 'Allowed MCP servers' }).textContent).toMatch(/github/)
    const add = within(box).getByLabelText('Add a server')
    await userEvent.type(add, 'claude.ai Gmail{Enter}')
    await waitFor(() => expect(list(client)).toEqual(['github', 'claude.ai Gmail']))
    await userEvent.click(within(box).getByRole('button', { name: 'Remove github' }))
    await waitFor(() => expect(list(client)).toEqual(['claude.ai Gmail']))
    expect((patches(client).at(-1) as { osig?: string }).osig).toBeTruthy()
  })

  it('refuses a duplicate, talos-app and a bad name in words, and sends nothing', async () => {
    const { client, box } = await mount({ mcp_allow: ['github'] })
    const add = within(box).getByLabelText('Add a server')
    for (const [text, said] of [
      ['github', /already on the list/],
      ['talos-app', /always allowed/],
      ['a,b', /up to 80 characters/],
    ] as const) {
      await userEvent.clear(add)
      await userEvent.type(add, `${text}{Enter}`)
      expect((await within(box).findByRole('alert')).textContent).toMatch(said)
    }
    expect(patches(client)).toHaveLength(0)
  })

  it('is read-only with the Mac offline', async () => {
    const { client, box } = await mount({ mcp_allow: ['github'] })
    act(() => client.store.setState((s) => ({ ...s, presence: { ...s.presence, bridge_online: false } })))
    expect((within(box).getByRole('switch', { name: 'Limit MCP servers' }) as HTMLButtonElement).disabled).toBe(true)
    expect((within(box).getByLabelText('Add a server') as HTMLInputElement).disabled).toBe(true)
    expect((within(box).getByRole('button', { name: 'Remove github' }) as HTMLButtonElement).disabled).toBe(true)
  })

  it("a refusal from the Mac leaves the saved list showing, in the Mac's words", async () => {
    const { client, box } = await mount({ mcp_allow: ['github'] })
    client.failNextPatchWith('thread_session_refused', 'thread "trip": those session settings are not valid')
    await userEvent.type(within(box).getByLabelText('Add a server'), 'slack{Enter}')
    expect((await screen.findAllByRole('alert')).map((a) => a.textContent).join(' ')).toMatch(/Your Mac said no/)
    expect(list(client)).toEqual(['github'])
  })

  it('says that saving restarts the session when its turn ends', async () => {
    const { box } = await mount()
    expect(box.parentElement?.textContent).toMatch(/Saving restarts the session when its current turn ends\./)
    expect(box.parentElement?.textContent).not.toMatch(/next time this thread's session starts/)
  })
})
