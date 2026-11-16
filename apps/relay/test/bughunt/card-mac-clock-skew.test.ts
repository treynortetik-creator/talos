// BUGHUNT (timestamps / clock skew): a card's `created_at` and `expires_at` are written by the Mac's clock, and the relay
// compares `expires_at` with ITS OWN clock: for the expiry timer (src/core/hub-bridge-frames.ts:261 ->
// src/core/hub-cards.ts:55-68), for `ready.open_cards` (src/core/store.ts:432-436), for a tap (src/core/cards.ts:23) and
// for the push's time to live (src/core/push.ts:380). Nothing measures the offset, although the relay hands the Mac its
// time in every `challenge` (`server_time`) and so could.
// A Mac whose clock is S behind takes S off every card's life on the relay; S ahead adds it (the card stays tappable on
// the phone after the Mac has closed it). With S at or above the card's life (a 10-minute app card, a Mac whose clock
// drifted while it slept or was set by hand) the card is accepted, acked, and expired in the same instant: the owner
// gets a "Needs you" push with a time to live of 0 and opens an expired card, while the agent waits the full 10 minutes.
// PLAUSIBLE: needs a clock difference; the size of the loss is the size of the difference.
// Suggested fix: keep `relay now - Mac ts` from the hello (or from each frame's `ts`) and shift a new card's times by it,
// or refuse a card whose `created_at` is more than a minute or two from the relay's clock with a message that says so.
import { buildCard, fakeClock, mkFrame } from '@talos-app/testkit'
import { afterEach, expect, it, vi } from 'vitest'
import { startTestRelay, type TestRelay } from '../core/harness.ts'
import { kit, silentBridge } from '../core/helpers.ts'

vi.setConfig({ testTimeout: 30_000 })
let relay: TestRelay | null = null
afterEach(async () => {
  await relay?.stop()
  relay = null
})

it('a 10-minute card from a Mac whose clock is 15 minutes slow is not dead on arrival', async () => {
  const c = fakeClock('2026-10-28T09:00:00.000Z')
  relay = await startTestRelay({ clock: c })
  const a = await kit(relay).connectedApp()
  const b = await silentBridge(relay, relay.bridgeKey, -15 * 60_000) // its hello says so too
  const macNow = c.now() - 15 * 60_000
  const card = buildCard({
    thread_id: 'general',
    created_at: new Date(macNow).toISOString(),
    expires_at: new Date(macNow + 10 * 60_000).toISOString(),
  })
  const create = mkFrame('card.create', { card }, new Date(macNow).toISOString())
  b.send(create)
  await b.reaches('ack', undefined, 1) // the relay took the card (it did not refuse it as out of date)
  expect(b.received.some((f) => f.type === 'ack' && f.ref === create.id)).toBe(true)
  await a.expectFrame('card.create', (f) => f.card.id === card.id)
  c.advance(1_000)
  await b.sync()
  // The owner was given ten minutes. One second in, on the relay's own clock, the card must still be open.
  expect(relay.runtime.store.getCard(card.id)?.state).toBe('pending')
  expect(relay.runtime.store.openCards(c.now()).map((x) => x.id)).toContain(card.id)
  await b.close()
})

it('the apps are told the relay expiry beside the card, on card.create and in ready; a value the Mac sent is replaced', async () => {
  const c = fakeClock('2026-10-28T09:00:00.000Z')
  relay = await startTestRelay({ clock: c })
  const k = kit(relay)
  const a = await k.connectedApp()
  const b = await silentBridge(relay, relay.bridgeKey, -15 * 60_000)
  const macNow = c.now() - 15 * 60_000
  const card = buildCard({
    thread_id: 'general',
    created_at: new Date(macNow).toISOString(),
    expires_at: new Date(macNow + 10 * 60_000).toISOString(),
  })
  b.send(mkFrame('card.create', { card: { ...card, relay_expires_at: '2030-01-01T00:00:00.000Z' } }))
  const live = await a.expectFrame('card.create', (f) => f.card.id === card.id)
  const want = new Date(c.now() + 10 * 60_000).toISOString() // ten minutes on the relay's clock
  expect(live.card.relay_expires_at).toBe(want)
  expect(live.card.expires_at).toBe(card.expires_at) // the signed card itself is unchanged
  const late = k.app()
  const ready = (await late.connect()) as unknown as { open_cards: Array<{ id: string; relay_expires_at?: string }> }
  expect(ready.open_cards.find((x) => x.id === card.id)?.relay_expires_at).toBe(want)
  await b.close()
})
