// Card state checks on the relay (spec 9 WP1 acceptance, 10.4): pending, expiry, hash, edits, step-up.
import {
  bindingFrom,
  Card,
  CONFIG_PROPOSE_FEATURE,
  CUSTOM_THEMES_FEATURE,
  configCardCandidate,
  editedHash,
  payloadHash,
  signBridgeHttp,
} from '@talos-app/protocol'
import { buildCard, fakeClock, sleep } from '@talos-app/testkit'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { startTestRelay, type TestRelay } from './harness.ts'
import { kit } from './helpers.ts'

vi.setConfig({ testTimeout: 20_000 })

let relay: TestRelay | null = null
afterEach(async () => {
  await relay?.stop()
  relay = null
})

async function setup(opts: { fake?: boolean } = {}) {
  const c = fakeClock(new Date().toISOString())
  relay = await startTestRelay(opts.fake ? { clock: c } : {})
  const k = kit(relay)
  const app = await k.connectedApp()
  const bridge = await k
    .bridge({ pinnedDevices: { [app.device.deviceId]: app.device.publicJwk }, consume: 'manual', verifyOwner: false })
    .connect()
  return { c, k, app, bridge }
}

describe('card checks', () => {
  it('a second resolve of the same card is card_not_pending', async () => {
    const { app, bridge } = await setup()
    const card = bridge.createCard({ thread_id: 'general', title: 'Once' })
    await app.expectFrame('card.create', (f) => f.card.id === card.id)
    const hash = payloadHash(bindingFrom(card))
    const first = await app.resolveCard(card, 'primary', hash)
    await bridge.expectFrame('card.resolve', (f) => f.id === first.id, { direction: 'in' })
    const second = await app.resolveCard(card, 'kill', hash)
    const err = await app.expectFrame('error', (f) => f.ref === second.id)
    expect(err.code).toBe('card_not_pending')
    await sleep(80)
    await vi.waitFor(() => expect(bridge.rec.of('card.resolve', 'in')).toHaveLength(1), { timeout: 10_000 })
  })

  it('a resolve after the card expired is card_expired, and the apps are told the card expired', async () => {
    const { c, k, app, bridge } = await setup({ fake: true })
    const card = bridge.createCard({ thread_id: 'general', title: 'Too late' })
    await app.expectFrame('card.create', (f) => f.card.id === card.id)
    const seen = app.lastSeq
    await app.close()
    await bridge.close()
    // a long jump with nobody connected: the sockets would otherwise be reaped for missing pongs (fake time passes in one step)
    c.advance(25 * 3_600_000)
    const back = k.app({ lastSeq: seen })
    await back.connect()
    const batch = await back.expectFrame('catchup.batch')
    const upd = batch.frames.find((f) => f.type === 'card.update') as unknown as {
      card_id: string
      state: string
      reason: string
    }
    expect(upd).toMatchObject({ card_id: card.id, state: 'expired', reason: 'expired' })
    expect(back.rec.of('ready', 'in')[0]?.open_cards).toEqual([])
    const late = await back.resolveCard(card, 'primary', payloadHash(bindingFrom(card)))
    expect((await back.expectFrame('error', (f) => f.ref === late.id)).code).toBe('card_expired')
  })

  it('a resolve past expires_at is card_expired even if the expiry timer has not fired yet', async () => {
    const { c, app, bridge } = await setup({ fake: true })
    const now = new Date(c.now())
    const card = buildCard(
      { thread_id: 'general', title: 'Short', expires_at: new Date(now.getTime() + 60_000).toISOString() },
      now,
    )
    bridge.send({ type: 'card.create', card })
    await app.expectFrame('card.create', (f) => f.card.id === card.id)
    c.set(c.now() + 61_000) // no timers fired: set() only moves the clock
    const late = await app.resolveCard(card, 'primary', payloadHash(bindingFrom(card)))
    expect((await app.expectFrame('error', (f) => f.ref === late.id)).code).toBe('card_expired')
  })

  it('a wrong payload_hash is card_hash_mismatch and nothing reaches the bridge', async () => {
    const { app, bridge } = await setup()
    const card = bridge.createCard({ thread_id: 'general', title: 'Hash' })
    await app.expectFrame('card.create', (f) => f.card.id === card.id)
    const sent = await app.resolveCard(card, 'primary', `sha256:${'0'.repeat(64)}`)
    expect((await app.expectFrame('error', (f) => f.ref === sent.id)).code).toBe('card_hash_mismatch')
    await sleep(80)
    expect(bridge.rec.of('card.resolve', 'in')).toHaveLength(0)
    // the card is still pending: a correct resolve goes through
    const ok = await app.resolveCard(card, 'primary', payloadHash(bindingFrom(card)))
    await bridge.expectFrame('card.resolve', (f) => f.id === ok.id, { direction: 'in' })
  })

  it('a high-risk primary resolve without a step-up token is stepup_required; kill needs none', async () => {
    const { app, bridge } = await setup()
    const card = bridge.createCard({
      thread_id: 'general',
      kind: 'publish',
      risk: 'high',
      title: 'Post it',
      destination: [{ label: 'To', value: 'example' }],
    })
    await app.expectFrame('card.create', (f) => f.card.id === card.id)
    const hash = payloadHash(bindingFrom(card))
    const primary = await app.resolveCard(card, 'primary', hash)
    expect((await app.expectFrame('error', (f) => f.ref === primary.id)).code).toBe('stepup_required')
    const kill = await app.resolveCard(card, 'kill', hash)
    await bridge.expectFrame('card.resolve', (f) => f.id === kill.id, { direction: 'in' })
  })

  it('trust mode: config.patch for work integrations and the permission relay skips the passkey step; off, it is asked', async () => {
    const { app, bridge } = await setup()
    const cfg = { ...(app.rec.of('ready', 'in')[0]?.agent_config as object) } as Record<string, unknown>
    // trust mode off (as synced): both ask for a step-up
    const work = await app.sendConfigPatch(0, { work: { enabled: ['github'] } })
    expect((await app.expectFrame('error', (f) => f.ref === work.id)).code).toBe('stepup_required')
    const retention = await app.sendConfigPatch(0, { work: { retention: 'buffer' } })
    expect((await app.expectFrame('error', (f) => f.ref === retention.id)).code).toBe('stepup_required')
    const label = await app.sendConfigPatch(0, { work: { label: 'Office tools' } })
    await bridge.expectFrame('config.patch', (f) => f.id === label.id, { direction: 'in' }) // wording needs no tap
    const relayPatch = await app.sendConfigPatch(0, { permission_relay: true })
    expect((await app.expectFrame('error', (f) => f.ref === relayPatch.id)).code).toBe('stepup_required')
    // the Mac switches trust mode on
    bridge.send({ type: 'config.sync', config: { ...cfg, rev: 1, trust_mode: true }, rev: 1 })
    await app.expectFrame('config.sync', (f) => f.rev === 1)
    const w2 = await app.sendConfigPatch(1, { work: { enabled: ['github'] } })
    await bridge.expectFrame('config.patch', (f) => f.id === w2.id, { direction: 'in' })
    const r2 = await app.sendConfigPatch(1, { permission_relay: true })
    await bridge.expectFrame('config.patch', (f) => f.id === r2.id, { direction: 'in' })
    // turning trust mode ON is never skipped, even while the relay believes it is already on: its copy of the Mac's
    // config can be stale, and a patch queued for a Mac that has since turned it off would otherwise switch it on untapped
    const t = await app.sendConfigPatch(1, { trust_mode: true })
    expect((await app.expectFrame('error', (f) => f.ref === t.id)).code).toBe('stepup_required')
    const mixed = await app.sendConfigPatch(1, { trust_mode: true, permission_relay: true })
    expect((await app.expectFrame('error', (f) => f.ref === mixed.id)).code).toBe('stepup_required')
    // off is free
    const t2 = await app.sendConfigPatch(1, { trust_mode: false })
    await bridge.expectFrame('config.patch', (f) => f.id === t2.id, { direction: 'in' })
    // and the Mac switching it off brings the step-up back
    bridge.send({ type: 'config.sync', config: { ...cfg, rev: 2 }, rev: 2 })
    await app.expectFrame('config.sync', (f) => f.rev === 2)
    const w3 = await app.sendConfigPatch(2, { work: { enabled: ['github'] } })
    expect((await app.expectFrame('error', (f) => f.ref === w3.id)).code).toBe('stepup_required')
  })

  it('edits: an allowed edit with the right edited_hash is forwarded; a forbidden or mis-hashed one is refused', async () => {
    const { app, bridge } = await setup()
    const card = bridge.createCard({
      thread_id: 'general',
      kind: 'email',
      title: 'Reply',
      destination: [{ label: 'To', value: 'alex@example.com' }],
      body: 'Hi',
      fields: [
        { key: 'subject', label: 'Subject', value: 'Hello', editable: true, multiline: false },
        { key: 'to', label: 'To', value: 'alex@example.com', editable: false, multiline: false },
      ],
    })
    await app.expectFrame('card.create', (f) => f.card.id === card.id)
    const hash = payloadHash(bindingFrom(card))
    const binding = bindingFrom(card)

    const forbidden = { fields: [{ key: 'to', value: 'evil@example.net' }] }
    const f1 = await app.resolveCard(card, 'primary', hash, {
      edited: forbidden,
      edited_hash: editedHash(binding, forbidden),
    })
    expect((await app.expectFrame('error', (f) => f.ref === f1.id)).code).toBe('card_edit_forbidden')

    const allowed = { fields: [{ key: 'subject', value: 'Hello there' }] }
    const f2 = await app.resolveCard(card, 'primary', hash, {
      edited: allowed,
      edited_hash: `sha256:${'1'.repeat(64)}`,
    })
    expect((await app.expectFrame('error', (f) => f.ref === f2.id)).code).toBe('card_hash_mismatch')

    const f3 = await app.resolveCard(card, 'primary', hash, {
      edited: allowed,
      edited_hash: editedHash(binding, allowed),
    })
    await bridge.expectFrame('card.resolve', (f) => f.id === f3.id, { direction: 'in' })
  })

  it('open cards are in ready; a resolved or expired card is not', async () => {
    const { k, app, bridge } = await setup()
    const open = bridge.createCard({ thread_id: 'general', title: 'Still open' })
    const done = bridge.createCard({ thread_id: 'general', title: 'Done' })
    await app.expectFrame('card.create', (f) => f.card.id === done.id)
    bridge.send({ type: 'card.update', card_id: done.id, state: 'done' })
    await app.expectFrame('card.update', (f) => f.card_id === done.id && f.state === 'done')
    const late = await k.connectedApp()
    expect(late.rec.of('ready', 'in')[0]?.open_cards?.map((c) => c.id)).toEqual([open.id])
  })

  it('refuses a card whose payload_hash does not match, over the socket and over POST /bridge/post', async () => {
    const { app, bridge } = await setup()
    const tampered = {
      ...buildCard({ thread_id: 'general', title: 'Tampered' }),
      payload_hash: `sha256:${'a'.repeat(64)}`,
    }
    const sent = bridge.send({ type: 'card.create', card: tampered })
    const err = await bridge.expectFrame('error', (f) => f.ref === sent.id, { direction: 'in' })
    expect(err.code).toBe('bad_frame')
    await sleep(60)
    expect(app.rec.of('card.create', 'in')).toHaveLength(0)

    const frame = {
      v: 1,
      type: 'card.create',
      id: `01JBF3V7Q8K2M4N6P8R0S2T4V6`,
      ts: new Date().toISOString(),
      card: tampered,
    }
    const body = JSON.stringify(frame)
    const header = await signBridgeHttp({
      privateKey: (relay as TestRelay).bridgeKey.privateKey,
      keyId: (relay as TestRelay).bridgeKey.keyId,
      method: 'POST',
      pathWithQuery: '/bridge/post',
      body,
    })
    const res = await fetch(`${(relay as TestRelay).httpBase}/bridge/post`, {
      method: 'POST',
      body,
      headers: { 'content-type': 'application/json', authorization: header },
    })
    expect(res.status).toBe(400)
  })
})

describe('settings cards (O1)', () => {
  it('the relay tells the bridge it knows kind:config (config-propose/1), and carries the card to the app unchanged', async () => {
    const { app, bridge } = await setup()
    const ready = await bridge.expectFrame('ready', undefined, { direction: 'in' })
    expect(ready.features).toContain(CONFIG_PROPOSE_FEATURE)
    expect(ready.features).toContain(CUSTOM_THEMES_FEATURE) // this relay ships the web build that previews a theme card
    const card = Card.parse(
      configCardCandidate({
        cardId: 'c_01JBF3V7Q8K2M4N6P8R0S2T4V6',
        threadId: 'general',
        now: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
        origin: 'chat',
        baseRev: 0,
        reason: 'you asked',
        changes: [{ path: 'agent.name', old: 'Talos', new: 'Hal' }],
      }),
    )
    card.payload_hash = payloadHash(bindingFrom(card))
    bridge.send({ type: 'card.create', card })
    const got = await app.expectFrame('card.create', (f) => f.card.id === card.id)
    expect(got.card.kind).toBe('config')
    expect(got.card.payload_hash).toBe(card.payload_hash)
    expect(got.card.allow_edit).toBe(false)
  })
})
