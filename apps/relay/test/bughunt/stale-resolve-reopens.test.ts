// Bug hunt 2026-11-10 #2: the Mac refuses a card tap (the phone's clock is over 2 min off, or any other refusal made
// before the Mac acted) and the relay kept the card `resolved` while the Mac kept it `pending`: no device could answer it.
import { bindingFrom, payloadHash } from '@talos-app/protocol'
import { mkFrame, sleep } from '@talos-app/testkit'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { startTestRelay, type TestRelay } from '../core/harness.ts'
import { kit } from '../core/helpers.ts'

vi.setConfig({ testTimeout: 30_000 })

let relay: TestRelay | null = null
afterEach(async () => {
  await relay?.stop()
  relay = null
})

const cardState = (r: TestRelay, id: string) => r.runtime.store.getCard(id)?.state

async function world() {
  relay = await startTestRelay()
  const k = kit(relay)
  const tapper = await k.connectedApp()
  const other = await k.connectedApp()
  // The bridge takes the tap and answers nothing by itself: each test plays the Mac's refusal by hand.
  const bridge = await k.bridge({ autoReply: false, consume: 'manual', verifyOwner: false }).connect()
  const card = bridge.createCard({ thread_id: 'general', title: 'Send the email' })
  await tapper.expectFrame('card.create', (f) => f.card.id === card.id)
  await other.expectFrame('card.create', (f) => f.card.id === card.id)
  return { relay, tapper, other, bridge, card, hash: payloadHash(bindingFrom(card)) }
}

describe('bug hunt #2: a card tap the Mac refuses', () => {
  for (const code of ['stale', 'permission_hidden', 'internal'] as const) {
    it(`refused as ${code}: the card is pending again on every device, the tapper is told why, and another device can answer it`, async () => {
      const w = await world()
      const why = "This phone's clock is 3 min ahead of your Mac. Set it to automatic date and time, then try again."
      const first = await w.tapper.resolveCard(w.card, 'primary', w.hash)
      await w.bridge.expectFrame('card.resolve', (f) => f.id === first.id, { direction: 'in' })
      expect(cardState(w.relay, w.card.id)).toBe('resolved')
      w.bridge.send(mkFrame('error', { ref: first.id, code, message: why }))

      // the tapping device hears the Mac's own words, and nobody else gets the error
      const err = await w.tapper.expectFrame('error', (f) => f.ref === first.id)
      expect(err).toMatchObject({ code, message: why })
      // every device sees the card open again
      for (const a of [w.tapper, w.other]) {
        const up = await a.expectFrame('card.update', (f) => f.card_id === w.card.id && f.state === 'pending')
        expect(up.reason).toBe('resolve_rejected')
      }
      expect(w.other.rec.of('error', 'in')).toEqual([])
      expect(cardState(w.relay, w.card.id)).toBe('pending')

      // a second device answers it: the tap reaches the Mac and is not refused as "not pending"
      const second = await w.other.resolveCard(w.card, 'primary', w.hash)
      await w.bridge.expectFrame('card.resolve', (f) => f.id === second.id, { direction: 'in' })
      expect(w.other.rec.of('error', 'in').filter((f) => f.ref === second.id)).toEqual([])

      // a device that connects now is offered the card
      const fresh = kit(w.relay).app()
      const ready = await fresh.connect()
      // (the second tap resolved it again; refuse that one too and look once more)
      w.bridge.send(mkFrame('error', { ref: second.id, code, message: why }))
      await w.other.expectFrame('error', (f) => f.ref === second.id)
      await fresh.expectFrame('card.update', (f) => f.card_id === w.card.id && f.state === 'pending')
      expect(ready.type).toBe('ready')
      await fresh.close()
    })
  }

  for (const code of ['card_not_pending', 'card_expired', 'permission_closed'] as const) {
    it(`refused as ${code} (the Mac says the card itself is closed): the card is not reopened`, async () => {
      const w = await world()
      const first = await w.tapper.resolveCard(w.card, 'primary', w.hash)
      await w.bridge.expectFrame('card.resolve', (f) => f.id === first.id, { direction: 'in' })
      w.bridge.send(mkFrame('error', { ref: first.id, code, message: 'closed on the Mac' }))
      await w.tapper.expectFrame('error', (f) => f.ref === first.id)
      await sleep(150)
      expect(cardState(w.relay, w.card.id)).toBe('resolved')
      expect(w.other.rec.of('card.update', 'in').filter((f) => f.card_id === w.card.id)).toEqual([])
    })
  }

  it('a card the Mac did decide is left alone when a late refusal of the same tap arrives', async () => {
    const w = await world()
    const first = await w.tapper.resolveCard(w.card, 'primary', w.hash)
    await w.bridge.expectFrame('card.resolve', (f) => f.id === first.id, { direction: 'in' })
    w.bridge.send(
      mkFrame('card.update', {
        card_id: w.card.id,
        state: 'resolved',
        resolution: { action: 'primary', at: new Date().toISOString(), edited: false, payload_hash: w.hash },
      }),
    )
    await w.other.expectFrame('card.update', (f) => f.card_id === w.card.id && f.state === 'resolved')
    w.bridge.send(mkFrame('error', { ref: first.id, code: 'stale', message: 'late' }))
    await w.tapper.expectFrame('error', (f) => f.ref === first.id)
    await sleep(150)
    expect(cardState(w.relay, w.card.id)).toBe('resolved')
  })
})
