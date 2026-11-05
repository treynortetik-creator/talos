// @vitest-environment jsdom
// The card screen on the real socket client across a reconnect: an approval that got no answer keeps saying so, and the
// relay leaving the card out of `ready` does not turn it into "Expired" with Ask again.
import { FakeRelay, mkFrame, NodeWebSocket, waitFor } from '@talos-app/testkit'
import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { ClientProvider } from '../src/lib/client.ts'
import { createSocketClient, type SocketClient } from '../src/lib/socketClient.ts'
import { createMemoryStorage } from '../src/lib/storage.ts'
import { LiveCard, makeCard } from './cards/helpers.tsx'

let relay: FakeRelay
let client: SocketClient

beforeEach(async () => {
  relay = await new FakeRelay().start()
  client = createSocketClient({
    storage: createMemoryStorage(),
    wsUrl: `${relay.wsBase}/ws`,
    WebSocketImpl: NodeWebSocket as unknown as typeof WebSocket,
    backoff: { baseMs: 20, maxMs: 40 },
    isOnline: () => true,
  })
})
afterEach(async () => {
  cleanup()
  client.close()
  await relay.stop()
})

it('an approval with no answer keeps its message across a reconnect, with no Expired line and no Ask again', async () => {
  const card = makeCard()
  await client.ensureDevice()
  await client.start({ pinned: true })
  await waitFor(() => client.store.getState().connection === 'online', 4000, 'online')
  relay.sendToApps(mkFrame('card.create', { card }))
  await waitFor(() => client.store.getState().cards.length === 1, 2000, 'card')
  render(
    <ClientProvider client={client}>
      <MemoryRouter>
        <LiveCard id={card.id} />
      </MemoryRouter>
    </ClientProvider>,
  )
  relay.swallowAcks = true
  await userEvent.click(screen.getByRole('button', { name: 'Send' }))
  await waitFor(
    () => relay.frames.some((f) => f.direction === 'from_app' && f.raw.type === 'card.resolve'),
    2000,
    'card.resolve sent',
  )
  relay.dropApps()
  expect((await screen.findByRole('alert')).textContent).toBe(
    "Didn't hear back. Check whether it ran before trying again.",
  )
  relay.swallowAcks = false
  await waitFor(() => client.store.getState().connection !== 'online', 2000, 'dropped')
  await waitFor(() => client.store.getState().connection === 'online', 4000, 'back online')
  await waitFor(() => (client.store.getState().readySeq ?? 0) >= 2, 2000, 'second ready')
  expect(client.store.getState().cards[0]?.state).toBe('pending')
  expect(screen.getByRole('alert').textContent).toBe("Didn't hear back. Check whether it ran before trying again.")
  expect(screen.queryByText(/Expired/)).toBeNull()
  expect(screen.queryByTestId('ask-again')).toBeNull()
})

it('a card past its expires_at that the relay leaves out of ready does read Expired, with Ask again', async () => {
  const card = makeCard({ expires_at: new Date(Date.now() - 60_000).toISOString() })
  await client.ensureDevice()
  await client.start({ pinned: true })
  await waitFor(() => client.store.getState().connection === 'online', 4000, 'online')
  relay.sendToApps(mkFrame('card.create', { card }))
  await waitFor(() => client.store.getState().cards.length === 1, 2000, 'card')
  render(
    <ClientProvider client={client}>
      <MemoryRouter>
        <LiveCard id={card.id} />
      </MemoryRouter>
    </ClientProvider>,
  )
  expect((await screen.findByTestId('collapse-line')).textContent).toBe('⌛ Expired')
  expect(screen.getByTestId('ask-again')).toBeTruthy()
})
