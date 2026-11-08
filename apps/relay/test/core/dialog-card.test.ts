// Needs-you prompts on the relay: the feature flag, the dialog card carried unchanged, the owner's choice carried signed, and
// the first answer winning.
import {
  bindingFrom,
  type CardT,
  composeDialogCard,
  NATIVE_APPROVABLE_KINDS,
  NEEDS_YOU_FEATURE,
  newId,
  payloadHash,
} from '@talos-app/protocol'
import { sleep } from '@talos-app/testkit'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { startTestRelay, type TestRelay } from './harness.ts'
import { kit } from './helpers.ts'

vi.setConfig({ testTimeout: 20_000 })

let relay: TestRelay | null = null
afterEach(async () => {
  await relay?.stop()
  relay = null
})

async function setup() {
  relay = await startTestRelay({})
  const k = kit(relay)
  const app = await k.connectedApp()
  const bridge = await k
    .bridge({ pinnedDevices: { [app.device.deviceId]: app.device.publicJwk }, consume: 'manual', verifyOwner: false })
    .connect()
  return { k, app, bridge }
}

const dialogCard = (): CardT => {
  const now = Date.now()
  return composeDialogCard({
    card_id: newId('c'),
    thread_id: 'general',
    thread_name: 'General',
    now,
    dialog: {
      id: 'k3Xv9QpT2mLw8ZrNa5HdBe',
      kind: 'trust',
      subject: '~/Documents/x',
      options: ['No, exit', 'Yes, I trust this folder'],
      cursor: 1,
      seen_at: new Date(now).toISOString(),
      expires_at: new Date(now + 900_000).toISOString(),
    },
  }) as CardT
}

describe('needs-you prompts', () => {
  it('the relay lists needs-you/1, so a bridge knows it understands kind:dialog', async () => {
    const { bridge } = await setup()
    const ready = await bridge.expectFrame('ready', undefined, { direction: 'in' })
    expect(ready.features).toContain(NEEDS_YOU_FEATURE)
  })

  it('carries the dialog card to the app unchanged, and a notification can never approve it', async () => {
    const { app, bridge } = await setup()
    const card = dialogCard()
    bridge.send({ type: 'card.create', card })
    const got = await app.expectFrame('card.create', (f) => f.card.id === card.id)
    expect(got.card.kind).toBe('dialog')
    expect(got.card.payload_hash).toBe(card.payload_hash)
    expect(got.card.payload).toEqual(card.payload)
    expect(NATIVE_APPROVABLE_KINDS).not.toContain('dialog')
  })

  it("carries the owner's choice, signed, to the bridge", async () => {
    const { app, bridge } = await setup()
    const card = dialogCard()
    bridge.send({ type: 'card.create', card })
    await app.expectFrame('card.create', (f) => f.card.id === card.id)
    const sent = await app.resolveCard(card, 'primary', payloadHash(bindingFrom(card)), { choice: 1 })
    const got = await bridge.expectFrame('card.resolve', (f) => f.id === sent.id, { direction: 'in' })
    expect(got.choice).toBe(1)
    expect(got.osig).toBe(sent.osig)
  })

  it('a second answer is card_not_pending and only the first reaches the bridge', async () => {
    const { app, bridge } = await setup()
    const card = dialogCard()
    bridge.send({ type: 'card.create', card })
    await app.expectFrame('card.create', (f) => f.card.id === card.id)
    const hash = payloadHash(bindingFrom(card))
    const first = await app.resolveCard(card, 'primary', hash, { choice: 1 })
    await bridge.expectFrame('card.resolve', (f) => f.id === first.id, { direction: 'in' })
    const second = await app.resolveCard(card, 'primary', hash, { choice: 0 })
    expect((await app.expectFrame('error', (f) => f.ref === second.id)).code).toBe('card_not_pending')
    await sleep(80)
    expect(bridge.rec.of('card.resolve', 'in')).toHaveLength(1)
  })

  it('refuses a choice outside 0 to 5 before it reaches the bridge', async () => {
    const { app, bridge } = await setup()
    const card = dialogCard()
    bridge.send({ type: 'card.create', card })
    await app.expectFrame('card.create', (f) => f.card.id === card.id)
    const bad = await app.resolveCard(card, 'primary', payloadHash(bindingFrom(card)), { choice: 9 })
    expect((await app.expectFrame('error', (f) => f.ref === bad.id)).code).toBe('bad_frame')
    await sleep(80)
    expect(bridge.rec.of('card.resolve', 'in')).toHaveLength(0)
  })

  it('shows every app who answered, and the result', async () => {
    const { app, bridge } = await setup()
    const card = dialogCard()
    bridge.send({ type: 'card.create', card })
    await app.expectFrame('card.create', (f) => f.card.id === card.id)
    const at = new Date().toISOString()
    bridge.send({
      type: 'card.update',
      card_id: card.id,
      state: 'done',
      resolution: { action: 'primary', at, edited: false, payload_hash: card.payload_hash, by: "Alex's iPhone" },
      result: { ok: true, text: 'Trusted ~/Documents/x', at, ran: true },
    })
    const upd = await app.expectFrame('card.update', (f) => f.card_id === card.id)
    expect(upd.resolution?.by).toBe("Alex's iPhone")
    expect(upd.result?.text).toBe('Trusted ~/Documents/x')
  })
})
