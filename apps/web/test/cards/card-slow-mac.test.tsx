// A Mac whose clock is slow writes cards whose `expires_at` is already behind the relay's clock. The relay keeps such a
// card open for its whole life (it times expiry with the Mac's measured offset) and sends the apps its own expiry as
// `relay_expires_at`, beside the signed card. The phone must show the buttons for as long as the relay holds the card, and
// fall back to `expires_at` when an older relay sends none (bug hunt relay #12).
import { FakeRelay, mkFrame, NodeWebSocket, waitFor } from '@talos-app/testkit'
import { cleanup, render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { afterEach, expect, it } from 'vitest'
import { useAwaitingOwner } from '../../src/features/cards/useAwaitingOwner.ts'
import { ClientProvider } from '../../src/lib/client.ts'
import { createSocketClient, type SocketClient } from '../../src/lib/socketClient.ts'
import { createMemoryStorage } from '../../src/lib/storage.ts'
import { LiveCard, makeCard } from './helpers.tsx'

let relay: FakeRelay
let client: SocketClient

afterEach(async () => {
  cleanup()
  client.close()
  await relay.stop()
})

function Count() {
  return <output data-testid="needs-you">{useAwaitingOwner().length}</output>
}

async function show(relayExpiresInMs: number | null) {
  relay = await new FakeRelay().start()
  client = createSocketClient({
    storage: createMemoryStorage(),
    wsUrl: `${relay.wsBase}/ws`,
    WebSocketImpl: NodeWebSocket as unknown as typeof WebSocket,
    backoff: { baseMs: 20, maxMs: 40 },
    isOnline: () => true,
  })
  await client.ensureDevice()
  await client.start({ pinned: true })
  await waitFor(() => client.store.getState().connection === 'online', 4000, 'online')
  const macNow = Date.now() - 15 * 60_000 // the Mac's clock is 15 minutes slow
  const card = makeCard({
    created_at: new Date(macNow).toISOString(),
    expires_at: new Date(macNow + 10 * 60_000).toISOString(), // "5 minutes ago" on the relay's clock
    ...(relayExpiresInMs !== null ? { relay_expires_at: new Date(Date.now() + relayExpiresInMs).toISOString() } : {}),
  })
  relay.sendToApps(mkFrame('card.create', { card }))
  await waitFor(() => client.store.getState().cards.length === 1, 2000, 'card')
  render(
    <ClientProvider client={client}>
      <MemoryRouter>
        <LiveCard id={card.id} />
        <Count />
      </MemoryRouter>
    </ClientProvider>,
  )
  return document.querySelector(`article[data-card-id="${card.id}"]`)
}

it("a slow Mac's card the relay still holds open for 10 minutes can be answered", async () => {
  const article = await show(10 * 60_000)
  expect(article).toBeTruthy()
  expect(screen.queryByText(/Expired/)).toBeNull()
  expect(screen.queryByRole('button', { name: /^Send/ })).not.toBeNull()
  expect(screen.getByTestId('needs-you').textContent).toBe('1')
})

it('from an older relay with no relay_expires_at, the card is judged by its expires_at as before', async () => {
  const article = await show(null)
  expect(article).toBeTruthy()
  expect(screen.queryByText(/Expired/)).not.toBeNull()
  expect(screen.queryByRole('button', { name: /^Send/ })).toBeNull()
  expect(screen.getByTestId('needs-you').textContent).toBe('0')
})
