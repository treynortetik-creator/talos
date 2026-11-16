// A card's `expires_at` is the relay's and the Mac's time. The socket client learns how far the phone's clock is from the
// relay's at every `ready` and signs with the corrected time. The card screen and the "Needs you" count must judge expiry
// by that same corrected time: a phone whose clock runs fast must not draw a live card as expired, and a phone whose clock
// runs slow must not offer buttons on a card the relay would refuse (bug hunt 2026-11-10, web finding 16).
import { FakeRelay, mkFrame, NodeWebSocket, waitFor } from '@talos-app/testkit'
import { cleanup, render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { afterEach, expect, it, vi } from 'vitest'
import { useAwaitingOwner } from '../../src/features/cards/useAwaitingOwner.ts'
import { ClientProvider } from '../../src/lib/client.ts'
import { createSocketClient, type SocketClient } from '../../src/lib/socketClient.ts'
import { createMemoryStorage } from '../../src/lib/storage.ts'
import { LiveCard, makeCard } from './helpers.tsx'

const trueNow = Date.now.bind(Date)
let relay: FakeRelay
let client: SocketClient

async function phone(skewMs: number) {
  const phoneNow = () => trueNow() + skewMs
  relay = await new FakeRelay().start()
  client = createSocketClient({
    storage: createMemoryStorage(),
    wsUrl: `${relay.wsBase}/ws`,
    WebSocketImpl: NodeWebSocket as unknown as typeof WebSocket,
    backoff: { baseMs: 20, maxMs: 40 },
    isOnline: () => true,
    now: phoneNow,
  })
  await client.ensureDevice()
  await client.start({ pinned: true })
  // `ready` carried the relay's time: the client now knows how far off this phone is
  await waitFor(() => client.store.getState().connection === 'online', 4000, 'online')
  return phoneNow
}
afterEach(async () => {
  vi.restoreAllMocks()
  cleanup()
  client.close()
  await relay.stop()
})

function Count() {
  return <output data-testid="needs-you">{useAwaitingOwner().length}</output>
}
async function show(expiresInMs: number, phoneNow: () => number) {
  const card = makeCard({
    created_at: new Date(trueNow()).toISOString(),
    expires_at: new Date(trueNow() + expiresInMs).toISOString(),
  })
  relay.sendToApps(mkFrame('card.create', { card }))
  await waitFor(() => client.store.getState().cards.length === 1, 2000, 'card')
  // from here on the page reads the phone's clock
  vi.spyOn(Date, 'now').mockImplementation(phoneNow)
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

it('a card with 5 minutes left on the relay clock can still be answered on a phone whose clock is 10 minutes fast', async () => {
  const article = await show(5 * 60_000, await phone(10 * 60_000))
  expect(article).toBeTruthy()
  expect(screen.queryByText(/Expired/)).toBeNull()
  expect(article?.getAttribute('data-card-state')).toBe('pending')
  expect(screen.queryByRole('button', { name: /^Send/ })).not.toBeNull()
  // and it still counts as waiting for the owner (the badge, the sidebar, the thread pill)
  expect(screen.getByTestId('needs-you').textContent).toBe('1')
})

it('a card the relay expired 5 minutes ago offers no buttons on a phone whose clock is 10 minutes slow', async () => {
  const article = await show(-5 * 60_000, await phone(-10 * 60_000))
  expect(article).toBeTruthy()
  expect(screen.queryByText(/Expired/)).not.toBeNull()
  expect(screen.queryByRole('button', { name: /^Send/ })).toBeNull()
  expect(screen.getByTestId('needs-you').textContent).toBe('0')
})

it('a phone whose clock is right is left alone', async () => {
  const article = await show(5 * 60_000, await phone(0))
  expect(article?.getAttribute('data-card-state')).toBe('pending')
  expect(client.store.getState().clockOffset ?? 0).toBe(0)
  expect(screen.getByTestId('needs-you').textContent).toBe('1')
})
