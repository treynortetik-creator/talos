// Bug hunt 2026-11-10, relay #10: a card whose decision was on its way to the Mac across a relay restart had no expiry
// timer (timers are armed at boot only for cards pending then). When the Mac then refused the decision the card went back
// to `pending` and stayed there: no `card.update{expired}` was stored or sent, and the sweep keeps every pending card.
// The first half of the old file (a `stale` refusal reopens the card) is in stale-resolve-reopens.test.ts.
import { fakeClock, waitFor } from '@talos-app/testkit'
import { afterEach, expect, it, vi } from 'vitest'
import { startTestRelay, type TestRelay } from '../core/harness.ts'
import { advance, kit, silentBridge } from '../core/helpers.ts'

vi.setConfig({ testTimeout: 40_000 })
const relays: TestRelay[] = []
afterEach(async () => {
  for (const r of relays.splice(0)) await r.stop().catch(() => undefined)
})

const cardFrame = async () => {
  const { buildCard, mkFrame } = await import('@talos-app/testkit')
  const card = buildCard({ thread_id: 'general' })
  return { card, frame: mkFrame('card.create', { card }) }
}

it('a card put back to pending after a relay restart still expires on time', async () => {
  const c = fakeClock(new Date().toISOString())
  const first = await startTestRelay({ clock: c })
  relays.push(first)
  const a = await kit(first).connectedApp()
  const b = await silentBridge(first, first.bridgeKey)
  const { card, frame } = await cardFrame() // expires in 24 h
  b.send(frame)
  await a.expectFrame('card.create', (f) => f.card.id === card.id)
  const resolve = await a.resolveCard(card, 'primary', card.payload_hash)
  await a.expectFrame('ack', (f) => f.ref === resolve.id)
  await b.reaches('card.resolve', resolve.id, 1)
  await b.close()
  await a.close()
  const { dir, bridgeKey } = first
  await first.stopKeepData() // a deploy while the decision is on its way
  relays.splice(relays.indexOf(first), 1)

  const second = await startTestRelay({ clock: c, dir, bridgeKey })
  relays.push(second)
  const b2 = await silentBridge(second, second.bridgeKey)
  await b2.reaches('card.resolve', resolve.id, 1)
  b2.send({ type: 'error', ref: resolve.id, code: 'sig_invalid', message: 'signature check failed' })
  b2.ack(resolve.id, 'consumed')
  await b2.sync()
  expect(second.runtime.store.getCard(card.id)?.state).toBe('pending') // rolled back, as designed
  await b2.close()
  await waitFor(() => !second.runtime.hub.bridgeOnline(), 10_000, 'bridge offline')

  await advance(c, 25 * 3600_000, 3600_000) // a day later: well past the card's expiry
  expect(second.runtime.store.getCard(card.id)?.state).toBe('expired')
})
