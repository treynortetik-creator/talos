// The plain explanation of a permission card on the REAL relay store and hub: the Mac sends it as a card.update after the card
// is out; the relay keeps it with the card (so a device that connects later still has it), never lets it move the card's state
// (a card the owner already answered stays answered, and is not reopened), and keeps the first answer.
import { bindingFrom, type PermissionExplainT, payloadHash } from '@talos-app/protocol'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { startTestRelay, type TestRelay } from './harness.ts'
import { kit } from './helpers.ts'

vi.setConfig({ testTimeout: 20_000 })

let relay: TestRelay | null = null
afterEach(async () => {
  await relay?.stop()
  relay = null
})

const READY: PermissionExplainT = {
  status: 'ready',
  tag: 'Deletes',
  mismatch: true,
  sentence: 'Claude says it tidies up, but it deletes your Downloads. Check before allowing.',
}

async function setup() {
  relay = await startTestRelay()
  const k = kit(relay)
  const app = await k.connectedApp()
  const bridge = await k
    .bridge({ pinnedDevices: { [app.device.deviceId]: app.device.publicJwk }, consume: 'manual', verifyOwner: false })
    .connect()
  const card = bridge.createCard({ thread_id: 'general', title: 'Allow Bash?', explain: { status: 'pending' } })
  await app.expectFrame('card.create', (f) => f.card.id === card.id)
  const explain = (e: PermissionExplainT) =>
    bridge.send({ type: 'card.update', card_id: card.id, state: 'pending', explain: e })
  const storeCard = () => relay!.runtime.store.getCard(card.id)
  return { k, app, bridge, card, explain, storeCard }
}

describe('the explanation reaches the relay copy of the card', () => {
  it('an explanation sent after the card is stored, so a device that connects later has it in open_cards', async () => {
    const { k, app, card, explain, storeCard } = await setup()
    explain(READY)
    await app.expectFrame('card.update', (f) => f.card_id === card.id && f.explain !== undefined)
    expect(storeCard()).toMatchObject({ state: 'pending', explain: READY })
    await app.close()
    const back = k.app({})
    await back.connect()
    const open = back.rec.of('ready', 'in')[0]?.open_cards ?? []
    expect(open.find((c) => c.id === card.id)).toMatchObject({ state: 'pending', explain: READY })
  })

  it('the first answer wins: a later one, and a return to pending, change nothing', async () => {
    const { app, card, explain, storeCard } = await setup()
    explain(READY)
    await app.expectFrame('card.update', (f) => f.card_id === card.id && f.explain?.status === 'ready')
    explain({ status: 'failed' })
    explain({ status: 'pending' })
    explain({ ...READY, tag: 'Reads files', mismatch: false, sentence: 'Lists files.' })
    await vi.waitFor(() => expect(app.rec.of('card.update', 'in').length).toBeGreaterThanOrEqual(4), {
      timeout: 10_000,
    })
    expect(storeCard()?.explain).toEqual(READY)
  })
})

describe('the explanation never moves the card', () => {
  it('one that arrives after the owner answered leaves the card answered: the apps are told the real state, and it is not reopened', async () => {
    const { k, app, bridge, card, explain, storeCard } = await setup()
    const first = await app.resolveCard(card, 'primary', payloadHash(bindingFrom(card)))
    await bridge.expectFrame('card.resolve', (f) => f.id === first.id, { direction: 'in' })
    expect(storeCard()?.state).toBe('resolved')
    explain(READY)
    const seen = await app.expectFrame('card.update', (f) => f.card_id === card.id && f.explain !== undefined)
    expect(seen.state).toBe('resolved') // an older app applies the state in the frame: it must be the real one
    expect(storeCard()).toMatchObject({ state: 'resolved', explain: { status: 'pending' } }) // and nothing was kept
    await app.close()
    const back = k.app({})
    await back.connect()
    expect((back.rec.of('ready', 'in')[0]?.open_cards ?? []).some((c) => c.id === card.id)).toBe(false)
  })

  it('a state-changing update that also names a resolution or result is applied as before', async () => {
    const { app, bridge, card, storeCard } = await setup()
    bridge.send({
      type: 'card.update',
      card_id: card.id,
      state: 'done',
      result: { ok: true, text: 'Sent to Claude Code', at: new Date().toISOString() },
    })
    await app.expectFrame('card.update', (f) => f.card_id === card.id && f.state === 'done')
    expect(storeCard()?.state).toBe('done')
  })

  it('an update without an explanation is applied exactly as before', async () => {
    const { app, bridge, card, storeCard } = await setup()
    bridge.send({ type: 'card.update', card_id: card.id, state: 'expired', reason: 'closed' })
    await app.expectFrame('card.update', (f) => f.card_id === card.id && f.state === 'expired')
    expect(storeCard()?.state).toBe('expired')
  })
})
