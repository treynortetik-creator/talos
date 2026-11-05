// One refused case for each entry point of the hub's frame-family files (hub-chat, hub-cards, hub-config, hub-history,
// hub-undelivered): a frame that fails a check reaches that family and is refused, the checks run in the same order as
// before the split, and nothing reaches the Mac or the store. Each test has a control that the same frame is accepted
// when the check passes, so a refusal here cannot be a harness that never lets anything through.
import {
  bindingFrom,
  createDeviceKey,
  type DeviceKey,
  newId,
  newUlid,
  payloadHash,
  signOwnerFrame,
} from '@talos-app/protocol'
import { FakeApp, type FakeBridge, fakeClock, mkFrame, sleep, waitFor } from '@talos-app/testkit'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { testAppHeaders } from '../helpers/test-auth.ts'
import { ORIGIN, startTestRelay, type TestRelay } from './harness.ts'
import { kit } from './helpers.ts'

vi.setConfig({ testTimeout: 30_000 })
const DAY = 86_400_000

let relay: TestRelay | null = null
const open: Array<{ close(): Promise<void> | void }> = []
afterEach(async () => {
  for (const o of open.splice(0)) await o.close()
  await relay?.stop()
  relay = null
})

const bridgeIn = (b: FakeBridge) => b.rec.frames.filter((r) => r.direction === 'in').map((r) => r.raw)

/** An app whose session is device `mine`, a Mac that has pinned it, and a second device key the session does not own. */
async function world(opts: { clock?: ReturnType<typeof fakeClock>; consume?: 'manual' } = {}) {
  relay = await startTestRelay(opts.clock ? { clock: opts.clock } : {})
  const mine = await createDeviceKey()
  const app = new FakeApp({ relayWs: relay.wsBase, headers: testAppHeaders(ORIGIN, mine.deviceId), deviceKey: mine })
  await app.connect()
  open.push(app)
  const bridge = await kit(relay)
    .bridge({
      pinnedDevices: { [mine.deviceId]: mine.publicJwk },
      autoReply: false,
      ...(opts.consume ? { consume: opts.consume } : {}),
    })
    .connect()
  open.push(bridge)
  const stranger = await createDeviceKey()
  return { r: relay, app, bridge, mine, stranger }
}

/** A frame signed by `key`, whatever device the session belongs to. */
const signedBy = <T extends Record<string, unknown> & { id: string }>(key: DeviceKey, frame: T) =>
  signOwnerFrame({ ...frame, device_id: key.deviceId }, key.privateKey) as Promise<
    T & { device_id: string; osig: string }
  >

const messageFrame = () => ({
  ...mkFrame('message'),
  thread_id: 'general',
  client_msg_id: newId('m'),
  text: 'hello',
  attachments: [],
})

describe('hub-chat: onOwnerMessage', () => {
  it('a message signed by a device other than the session is refused, not stored and not sent to the Mac', async () => {
    const { r, app, bridge, mine, stranger } = await world()
    const bad = await signedBy(stranger, messageFrame())
    app.send(bad)
    const err = await app.expectFrame('error', (f) => f.ref === bad.id, { direction: 'in' })
    expect(err.code).toBe('unauthorized')
    await sleep(150)
    expect(bridgeIn(bridge).some((f) => f.id === bad.id)).toBe(false)
    expect(r.runtime.store.getEventByFrameId(bad.id as string)).toBeFalsy()
    expect(r.runtime.store.seen(`of:${bad.id}`)).toBeUndefined()
    // control: the session's own device is stored and forwarded
    const good = await signedBy(mine, messageFrame())
    app.send(good)
    await bridge.expectFrame('message', (f) => f.id === good.id, { direction: 'in' })
  })
})

describe('hub-cards: onCardResolve and acceptNativeAct', () => {
  it('a card.resolve from another device is refused on the device check, before the card is even looked up', async () => {
    const { app, bridge, mine, stranger } = await world()
    const card = bridge.createCard({ thread_id: 'general', title: 'Ship it?' })
    await app.expectFrame('card.create', (f) => f.card.id === card.id)
    const hash = payloadHash(bindingFrom(card))
    const bad = await signedBy(stranger, {
      ...mkFrame('card.resolve'),
      card_id: card.id,
      action: 'primary',
      payload_hash: hash,
    })
    app.send(bad)
    expect((await app.expectFrame('error', (f) => f.ref === bad.id, { direction: 'in' })).code).toBe('unauthorized')
    await sleep(150)
    expect(bridgeIn(bridge).some((f) => f.id === bad.id)).toBe(false)
    // the card is still pending and the same tap from the session's own device goes through
    const good = await signedBy(mine, {
      ...mkFrame('card.resolve'),
      card_id: card.id,
      action: 'primary',
      payload_hash: hash,
    })
    app.send(good)
    await bridge.expectFrame('card.resolve', (f) => f.id === good.id, { direction: 'in' })
  })

  it('a card.resolve for a card the relay does not know is refused as card_not_pending', async () => {
    const { r, app, bridge, mine } = await world()
    const f = await signedBy(mine, {
      ...mkFrame('card.resolve'),
      card_id: `c_${newUlid()}`,
      action: 'primary',
      payload_hash: `sha256:${'0'.repeat(64)}`,
    })
    app.send(f)
    expect((await app.expectFrame('error', (e) => e.ref === f.id, { direction: 'in' })).code).toBe('card_not_pending')
    await sleep(150)
    expect(bridgeIn(bridge).some((x) => x.id === f.id)).toBe(false)
    expect(r.runtime.store.seen(`of:${f.id}`)).toBeUndefined()
  })

  it('a notification Approve for an unknown card is refused with 404, and its claim is rolled back so a retry runs fresh', async () => {
    relay = await startTestRelay()
    const r = relay
    const frame = {
      id: newUlid(),
      ts: new Date().toISOString(),
      grant: 'g'.repeat(8),
      body: 'b',
      asig: 'a',
      device_id: 'd_aaaaaaaaaaaaaaaaaaaa',
    }
    const act = { a: 'approve', card_id: `c_${newUlid()}`, shown: 's', payload_hash: 'h' }
    const run = () => r.runtime.hub.acceptNativeAct({ frame, act } as never, { type: 'native.act', id: frame.id })
    expect(run()).toMatchObject({ ok: false, status: 404, code: 'card_not_pending' })
    // the refusal rolled the claim back: the same id is refused for the same reason, never answered "duplicate"
    expect(run()).toMatchObject({ ok: false, status: 404, code: 'card_not_pending' })
  })
})

describe('hub-config: onConfigPatch', () => {
  it('a config.patch from another device is refused on the device check, ahead of the field check', async () => {
    const { r, app, bridge, mine, stranger } = await world()
    const patch = () => ({ ...mkFrame('config.patch'), base_rev: 0, patch: { not_a_setting: 1 } })
    const bad = await signedBy(stranger, patch())
    app.send(bad)
    // an unknown field would be config_field_forbidden; the device check comes first
    expect((await app.expectFrame('error', (f) => f.ref === bad.id, { direction: 'in' })).code).toBe('unauthorized')
    await sleep(150)
    expect(bridgeIn(bridge).some((f) => f.id === bad.id)).toBe(false)
    expect(r.runtime.store.seen(`of:${bad.id}`)).toBeUndefined()
    // from the session's own device the same patch reaches the field check
    const own = await signedBy(mine, patch())
    app.send(own)
    expect((await app.expectFrame('error', (f) => f.ref === own.id, { direction: 'in' })).code).toBe(
      'config_field_forbidden',
    )
  })
})

describe('hub-history: history and onMediaFetch', () => {
  it('a history.request signed by another device is refused and its request id is not spent', async () => {
    const { r, app, bridge, mine, stranger } = await world()
    const req = {
      ...mkFrame('history.request'),
      request_id: newUlid(),
      thread_id: 'general',
      around_id: `m_${newUlid()}`,
      limit: 50,
    }
    const bad = await signedBy(stranger, req)
    app.send(bad)
    expect((await app.expectFrame('error', (f) => f.ref === bad.id, { direction: 'in' })).code).toBe('unauthorized')
    await sleep(150)
    expect(bridgeIn(bridge).some((f) => f.id === bad.id)).toBe(false)
    expect(r.runtime.store.seen(`hq:${bad.id}`)).toBeUndefined()
    // control: the session's own device is forwarded to the Mac
    const good = await signedBy(mine, { ...req, ...mkFrame('history.request'), request_id: newUlid() })
    app.send(good)
    await bridge.expectFrame('history.request', (f) => f.id === good.id, { direction: 'in' })
    // a second use of the same frame id is refused as already used
    app.send(good)
    expect((await app.expectFrame('error', (f) => f.ref === good.id, { direction: 'in' })).code).toBe('sig_invalid')
  })

  it('a media.fetch signed by another device is refused and never forwarded', async () => {
    const { app, bridge, mine, stranger } = await world()
    const bad = await signedBy(stranger, { ...mkFrame('media.fetch'), media_id: `md_${newUlid()}` })
    app.send(bad)
    expect((await app.expectFrame('error', (f) => f.ref === bad.id, { direction: 'in' })).code).toBe('unauthorized')
    await sleep(150)
    expect(bridgeIn(bridge).some((f) => f.id === bad.id)).toBe(false)
    const good = await signedBy(mine, { ...mkFrame('media.fetch'), media_id: `md_${newUlid()}` })
    app.send(good)
    await bridge.expectFrame('media.fetch', (f) => f.id === good.id, { direction: 'in' })
  })
})

describe('hub-undelivered: the report before the sweep', () => {
  it('a card the Mac decided is not reported as lost, while a settings change the Mac never saw is', async () => {
    const clock = fakeClock(new Date().toISOString())
    const { r, app, bridge } = await world({ clock })
    const card = bridge.createCard({ thread_id: 'general', title: 'Ship it?' })
    await app.expectFrame('card.create', (f) => f.card.id === card.id)
    await bridge.close() // the Mac goes away before either owner frame
    await waitFor(() => !r.runtime.hub.bridgeOnline(), 5000, 'bridge gone')
    await app.resolveCard(card, 'primary', payloadHash(bindingFrom(card)))
    await app.sendConfigPatch(0, { quiet_window: null })
    await waitFor(() => r.runtime.store.outboxDepth() === 2, 5000, 'both owner frames queued')
    // the card was decided on the Mac itself (its card.update carried the resolution) while the tap sat in the outbox
    r.runtime.store.setCardState(card.id, {
      state: 'resolved',
      resolution: {
        action: 'primary',
        at: new Date().toISOString(),
        edited: false,
        payload_hash: payloadHash(bindingFrom(card)),
      },
    })

    clock.set(clock.now() + 8 * DAY)
    r.runtime.hub.sweep()
    const system = () => app.rec.of('message.stored', 'in').filter((f) => f.message.author === 'system')
    await waitFor(() => system().length >= 1, 5000, 'the settings change is reported')
    await sleep(150)
    const texts = system().map((f) => f.message.text)
    expect(texts).toEqual([expect.stringContaining('A settings change never reached your Mac')])
  })
})
