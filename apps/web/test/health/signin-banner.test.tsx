// Claude not signed in on the agent's computer: the supervisor's state reaches the app as presence.main, and while it is
// `signin` the app says so in plain words for that computer, instead of looking dead. It clears when the state moves on.
// Driven through real presence frames (onPresence), the real Banners and the host words.
import { act, cleanup, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Banners } from '../../src/features/threads/Banners.tsx'
import { ClientProvider } from '../../src/lib/client.ts'
import { createFakeClient } from '../../src/lib/fakeClient.ts'
import { onPresence } from '../../src/lib/socket-frames-threads.ts'

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

const PC = 'Claude needs you to sign in on your PC: use the Talos icon by the clock, Sign in to Claude.'

function mount(features: string[]) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response('nope', { status: 500 })),
  )
  const client = createFakeClient()
  client.store.setState({ connection: 'online' })
  const presence = (main?: string, online = true) =>
    act(() =>
      onPresence(
        { set: (fn: (s: never) => object) => client.store.setState(fn(client.store.getState() as never)) } as never,
        {
          bridge_online: online,
          last_seen: new Date().toISOString(),
          queue_depth: 0,
          features,
          ...(main ? { main } : {}),
        } as never,
      ),
    )
  render(
    <MemoryRouter>
      <ClientProvider client={client}>
        <Banners />
      </ClientProvider>
    </MemoryRouter>,
  )
  return { presence }
}

describe('the sign-in banner', () => {
  it('on a PC: says what to do while Main is at signin, and clears when it is not', async () => {
    const { presence } = mount(['host/windows'])
    presence('signin')
    await waitFor(() => expect(screen.getByTestId('signin-banner').textContent).toBe(PC))
    presence('running')
    await waitFor(() => expect(screen.queryByTestId('signin-banner')).toBeNull())
    presence('signin')
    await waitFor(() => expect(screen.getByTestId('signin-banner')).toBeTruthy())
    presence(undefined) // the bridge sent no state (a stale file): no banner
    await waitFor(() => expect(screen.queryByTestId('signin-banner')).toBeNull())
  })

  it('names "your computer" on another host, and says nothing on a Mac (its supervisor sends no state yet)', async () => {
    const linux = mount(['host/linux'])
    linux.presence('signin')
    await waitFor(() =>
      expect(screen.getByTestId('signin-banner').textContent).toBe(
        'Claude needs you to sign in on your computer: open Claude Code there and sign in.',
      ),
    )
    cleanup()
    const mac = mount(['host/mac'])
    mac.presence('signin')
    await new Promise((r) => setTimeout(r, 50))
    expect(screen.queryByTestId('signin-banner')).toBeNull()
  })

  it('only from a live bridge, and other states show nothing', async () => {
    const { presence } = mount(['host/windows'])
    for (const s of ['waiting', 'starting', 'stopped']) {
      presence(s)
      await new Promise((r) => setTimeout(r, 20))
      expect(screen.queryByTestId('signin-banner'), s).toBeNull()
    }
    presence('signin', false)
    await new Promise((r) => setTimeout(r, 20))
    expect(screen.queryByTestId('signin-banner')).toBeNull()
  })
})
