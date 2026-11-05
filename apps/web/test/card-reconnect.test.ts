// @vitest-environment node
// A device that held a card as pending, then reconnects after the card was decided elsewhere: `ready` lists open cards
// only, and the catch-up `card.update` only changes a card the device still holds. The card must not vanish.
import type { CardT } from '@talos-app/protocol'
import { buildCard, FakeRelay, mkFrame, waitFor } from '@talos-app/testkit'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createSocketClient, type SocketClient } from '../src/lib/socketClient.ts'
import { createMemoryStorage } from '../src/lib/storage.ts'

let relay: FakeRelay
let client: SocketClient

beforeEach(async () => {
  relay = await new FakeRelay().start()
  client = createSocketClient({
    storage: createMemoryStorage(),
    wsUrl: `${relay.wsBase}/ws`,
    backoff: { baseMs: 20, maxMs: 40 },
    isOnline: () => true,
  })
  await client.ensureDevice()
  await client.start({ pinned: true })
  await waitFor(() => client.store.getState().connection === 'online', 4000, 'online')
})
afterEach(async () => {
  client.close()
  await relay.stop()
})

const ready = (open: CardT[]) =>
  relay.sendToApps(
    mkFrame('ready', {
      session_id: 'sess_reconnect',
      policy: { max_frame_bytes: 262144, ping_ms: 25000 },
      server_seq: 99,
      presence: { bridge_online: true, last_seen: new Date().toISOString(), queue_depth: 0 },
      open_cards: open,
    }),
  )

describe('a card held as pending across a reconnect', () => {
  it('is kept as it was when ready no longer lists it (not past its time), and the catch-up update then sets its real state', async () => {
    const card = buildCard({ thread_id: 'general' })
    relay.sendToApps(mkFrame('card.create', { card }))
    await waitFor(() => client.store.getState().cards.length === 1, 2000, 'card')
    expect(client.store.getState().cards[0]?.state).toBe('pending')

    ready([])
    await waitFor(() => (client.store.getState().readySeq ?? 0) >= 2, 2000, 'second ready')
    const kept = client.store.getState().cards
    expect(kept.map((c) => c.id)).toEqual([card.id])
    expect(kept[0]?.state).toBe('pending') // the relay may have resolved it with no card.update: not expired by absence

    relay.sendToApps(mkFrame('card.update', { card_id: card.id, state: 'done' }))
    await waitFor(() => client.store.getState().cards[0]?.state === 'done', 2000, 'done')
  })

  it('a card still open stays pending, and a card the device never held arrives from open_cards', async () => {
    const held = buildCard({ thread_id: 'general' })
    const fresh = buildCard({ thread_id: 'general' })
    relay.sendToApps(mkFrame('card.create', { card: held }))
    await waitFor(() => client.store.getState().cards.length === 1, 2000, 'card')
    ready([held, fresh])
    await waitFor(() => client.store.getState().cards.length === 2, 2000, 'both')
    expect(client.store.getState().cards.map((c) => c.state)).toEqual(['pending', 'pending'])
  })
})
