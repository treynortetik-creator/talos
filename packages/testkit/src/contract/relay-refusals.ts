// What a relay refuses on its own, before the Mac sees a frame, and what it does when the Mac refuses one. These are cases
// of defineRelayContract, so they run against the real relay as well as FakeRelay: a refusal only the fake makes is a
// refusal an app built against it would wrongly rely on. Every "not forwarded" check ends on a LATER frame that does reach
// the Mac (the relay keeps each socket's order), never on a pause.
import {
  bindingFrom,
  createDeviceKey,
  generateBridgeKey,
  newId,
  payloadHash,
  signBridgeHttp,
  signRotation,
} from '@talos-app/protocol'
import { describe, expect, it } from 'vitest'
import { WebSocket } from 'ws'
import { FakeApp } from '../fake-app.ts'
import type { FakeBridge } from '../fake-bridge.ts'
import { buildCard, mkFrame, waitFor } from '../frame-utils.ts'
import type { RelayHandle } from './harness.ts'
import { kit, relayCaughtUp, signedPost } from './relay-kit.ts'

const HOUR = 3_600_000

export function defineRelayRefusals(getRelay: () => RelayHandle) {
  const k = () => kit(getRelay())

  /** An app, a Mac that takes frames but does not act on them (manual consume), and one card the app has seen. */
  async function withCard(opts: { lapsed?: boolean } = {}) {
    const app = await k().connectedApp()
    const bridge = k().bridge({ verifyOwner: false, consume: 'manual' })
    await bridge.connect()
    // A card made an hour ago that lapsed a minute after: valid when it was made, expired now.
    const card = opts.lapsed
      ? buildCard(
          { thread_id: 'general', title: 'Decide', expires_at: new Date(Date.now() - HOUR + 60_000).toISOString() },
          new Date(Date.now() - HOUR),
        )
      : buildCard({ thread_id: 'general', title: 'Decide' })
    bridge.send({ type: 'card.create', card })
    await app.expectFrame('card.create', (f) => f.card.id === card.id)
    return { app, bridge, card, hash: payloadHash(bindingFrom(card)) }
  }

  /** A second card sent and taken to the Mac: once it arrives, everything the app sent before it has been decided. */
  async function markerReaches(app: FakeApp, bridge: FakeBridge) {
    const card = buildCard({ thread_id: 'general', title: 'Marker' })
    bridge.send({ type: 'card.create', card })
    await app.expectFrame('card.create', (f) => f.card.id === card.id)
    const sent = await app.resolveCard(card, 'kill', payloadHash(bindingFrom(card)))
    await bridge.expectFrame('card.resolve', (f) => f.id === sent.id, { direction: 'in' })
  }
  const atMac = (bridge: FakeBridge, id: string) => bridge.rec.of('card.resolve', 'in').filter((f) => f.id === id)

  describe('card.resolve checks', () => {
    it('an expired card is card_expired, the apps are told it expired, and a second tap is card_expired too', async () => {
      const { app, bridge, card, hash } = await withCard({ lapsed: true })
      const first = await app.resolveCard(card, 'primary', hash)
      expect((await app.expectFrame('error', (f) => f.ref === first.id)).code).toBe('card_expired')
      await app.expectFrame('card.update', (f) => f.card_id === card.id && f.state === 'expired')
      const second = await app.resolveCard(card, 'primary', hash)
      expect((await app.expectFrame('error', (f) => f.ref === second.id)).code).toBe('card_expired')
      await markerReaches(app, bridge)
      expect(atMac(bridge, first.id)).toHaveLength(0)
      expect(atMac(bridge, second.id)).toHaveLength(0)
    })

    it('a hash that is not the card is card_hash_mismatch and is not forwarded', async () => {
      const { app, bridge, card } = await withCard()
      const sent = await app.resolveCard(card, 'primary', `sha256:${'1'.repeat(64)}`)
      expect((await app.expectFrame('error', (f) => f.ref === sent.id)).code).toBe('card_hash_mismatch')
      await markerReaches(app, bridge)
      expect(atMac(bridge, sent.id)).toHaveLength(0)
    })

    it('a card already resolved is card_not_pending, so a second tap is not forwarded', async () => {
      const { app, bridge, card, hash } = await withCard()
      const first = await app.resolveCard(card, 'kill', hash)
      await bridge.expectFrame('card.resolve', (f) => f.id === first.id, { direction: 'in' })
      const second = await app.resolveCard(card, 'kill', hash)
      expect((await app.expectFrame('error', (f) => f.ref === second.id)).code).toBe('card_not_pending')
      await markerReaches(app, bridge)
      expect(atMac(bridge, second.id)).toHaveLength(0)
      expect(atMac(bridge, first.id)).toHaveLength(1)
    })

    it('a resolve the Mac refused puts the card back to pending, tells the apps, and the next tap is forwarded', async () => {
      const { app, bridge, card, hash } = await withCard()
      const first = await app.resolveCard(card, 'kill', hash)
      await bridge.expectFrame('card.resolve', (f) => f.id === first.id, { direction: 'in' })
      bridge.send({ type: 'error', ref: first.id, code: 'device_not_pinned', message: 'not pinned' })
      await app.expectFrame('error', (f) => f.ref === first.id && f.code === 'device_not_pinned')
      await app.expectFrame('card.update', (f) => f.card_id === card.id && f.state === 'pending')
      const retry = await app.resolveCard(card, 'kill', hash)
      await bridge.expectFrame('card.resolve', (f) => f.id === retry.id, { direction: 'in' })
    })

    it('a card the Mac DID decide is not put back to pending by a later error on the same frame', async () => {
      const app = await k().connectedApp()
      const bridge = await k()
        .bridge({ pinnedDevices: { [app.device.deviceId]: app.device.publicJwk } })
        .connect()
      const card = bridge.createCard({ thread_id: 'general', title: 'Decided' })
      await app.expectFrame('card.create', (f) => f.card.id === card.id)
      const hash = payloadHash(bindingFrom(card))
      const first = await app.resolveCard(card, 'kill', hash)
      await app.expectFrame('card.update', (f) => f.card_id === card.id && f.state === 'done') // the Mac decided it
      bridge.send({ type: 'error', ref: first.id, code: 'device_not_pinned', message: 'late' })
      await relayCaughtUp(bridge)
      const second = await app.resolveCard(card, 'kill', hash)
      expect((await app.expectFrame('error', (f) => f.ref === second.id)).code).toBe('card_not_pending')
      expect(app.rec.of('card.update', 'in').filter((f) => f.card_id === card.id && f.state === 'pending')).toEqual([])
    })

    it('a card.create sent again with the same frame id is acked again and does not reopen a decided card', async () => {
      const app = await k().connectedApp()
      const bridge = await k()
        .bridge({ pinnedDevices: { [app.device.deviceId]: app.device.publicJwk } })
        .connect()
      const card = buildCard({ thread_id: 'general', title: 'Once' })
      bridge.cards.set(card.id, { ...card }) // the fake Mac keeps its own copy, which it changes as it decides the card
      const created = bridge.send({ type: 'card.create', card })
      await app.expectFrame('card.create', (f) => f.card.id === card.id)
      const hash = payloadHash(bindingFrom(card))
      await app.resolveCard(card, 'kill', hash)
      await app.expectFrame('card.update', (f) => f.card_id === card.id && f.state === 'done')
      bridge.send(created) // the Mac's outbox re-sends the very same frame
      await waitFor(() => bridge.rec.of('ack', 'in').filter((a) => a.ref === created.id).length === 2, 3000, 'two acks')
      const [a1, a2] = bridge.rec.of('ack', 'in').filter((a) => a.ref === created.id)
      expect(a2?.seq).toBe(a1?.seq)
      bridge.reply('general', 'marker')
      await app.expectFrame('reply', (f) => f.message.text === 'marker')
      expect(app.rec.of('card.create', 'in').filter((f) => f.card.id === card.id)).toHaveLength(1)
      const again = await app.resolveCard(card, 'kill', hash)
      expect((await app.expectFrame('error', (f) => f.ref === again.id)).code).toBe('card_not_pending')
    })
  })

  describe('which device the session belongs to', () => {
    it("a hello from a device other than the session's is closed 4401 device_changed", async () => {
      const relay = getRelay()
      if (!relay.deviceHeaders) return
      const key = await createDeviceKey()
      const other = await createDeviceKey()
      // the listener goes on before the connection starts, so the close cannot be missed
      const ws = new WebSocket(`${relay.wsBase}/ws`, { headers: relay.deviceHeaders(other.deviceId) })
      const closed = new Promise<{ code: number; reason: string }>((resolve) =>
        ws.on('close', (code, reason) => resolve({ code, reason: reason.toString() })),
      )
      ws.on('error', () => {})
      ws.on('open', () =>
        ws.send(
          JSON.stringify(
            mkFrame('hello', {
              role: 'app',
              device_id: key.deviceId,
              last_seq: 0,
              visible: true,
              client: { version: '0.0.0', standalone: true, platform: 'test' },
            }),
          ),
        ),
      )
      expect(await closed).toEqual({ code: 4401, reason: 'device_changed' })
    })

    it('a frame signed by another device is unauthorized and is not forwarded', async () => {
      const relay = getRelay()
      if (!relay.deviceHeaders) return
      const key = await createDeviceKey()
      const mine = new FakeApp({ relayWs: relay.wsBase, deviceKey: key, headers: relay.deviceHeaders(key.deviceId) })
      await mine.connect()
      const stranger = await k().connectedApp() // a session with no device, so only its signing key differs
      const bridge = k().bridge({ verifyOwner: false, consume: 'manual' })
      await bridge.connect()
      const forged = await stranger.buildMessage('general', 'signed by someone else')
      mine.sendRaw(JSON.stringify(forged))
      expect((await mine.expectFrame('error', (f) => f.ref === forged.id)).code).toBe('unauthorized')
      const own = await mine.sendMessage('general', 'signed by me')
      await bridge.expectFrame('message', (f) => f.id === own.id, { direction: 'in' })
      expect(bridge.rec.of('message', 'in').filter((f) => f.id === forged.id)).toHaveLength(0)
    })
  })

  describe('a device the Mac has not pinned', () => {
    it('gets the handshake only, device_not_pinned for any other frame, and the full ready once the Mac pins it', async () => {
      const relay = getRelay()
      if (!relay.deviceHeaders || !relay.pinDevice) return
      const key = await createDeviceKey()
      const app = new FakeApp({
        relayWs: relay.wsBase,
        deviceKey: key,
        headers: relay.deviceHeaders(key.deviceId, { pinned: false }),
      })
      const ready = await app.connect()
      expect(ready.agent_config).toBeUndefined()
      expect(ready.open_cards).toBeUndefined()
      const sent = await app.sendMessage('general', 'hello?')
      expect((await app.expectFrame('error', (f) => f.ref === sent.id)).code).toBe('device_not_pinned')
      expect(app.rec.of('ack', 'in')).toHaveLength(0)
      // presence is part of the handshake, so a pairing-only socket still hears the Mac come online
      const bridge = await k()
        .bridge({ pinnedDevices: { [key.deviceId]: key.publicJwk } })
        .connect()
      await app.expectFrame('presence', (f) => f.bridge_online === true)
      relay.pinDevice(key.deviceId)
      const nonce = mkFrame('ping').id.slice(-12)
      app.send({ type: 'ping', nonce }) // any frame is a look at the session: the full ready comes before the answer
      await app.expectFrame('pong', (f) => f.nonce === nonce)
      const full = app.rec.of('ready', 'in')
      expect(full).toHaveLength(2)
      expect(full[1]?.agent_config).toBeDefined()
      const later = await app.sendMessage('general', 'now?')
      await app.expectFrame('ack', (f) => f.ref === later.id)
      await bridge.expectFrame('message', (f) => f.id === later.id, { direction: 'in' })
    })
  })

  describe('media.fetch', () => {
    it('with the Mac offline the asker hears mac_offline at once', async () => {
      const app = await k().connectedApp()
      const sent = await app.sign({ ...mkFrame('media.fetch'), media_id: 'md_01JBF3V7Q8K2M4N6P8R0S2T4V6' })
      app.send(sent)
      expect((await app.expectFrame('error', (f) => f.ref === sent.id)).code).toBe('mac_offline')
    })
  })

  describe('what the Mac posts over HTTP', () => {
    async function post(frame: Record<string, unknown>) {
      const relay = getRelay()
      const { body, header } = await signedPost(relay, frame)
      return fetch(`${relay.httpBase}/bridge/post`, {
        method: 'POST',
        body,
        headers: { 'content-type': 'application/json', authorization: header },
      })
    }

    it('a card whose payload_hash is not its content is refused with bad_frame and never reaches the apps', async () => {
      const app = await k().connectedApp()
      const good = buildCard({ thread_id: 'general', title: 'Fine' })
      expect((await post({ ...mkFrame('card.create'), card: good })).status).toBe(200)
      await app.expectFrame('card.create', (f) => f.card.id === good.id)
      const bad = { ...good, id: 'c_01JBF3V7Q8K2M4N6P8R0S2T4V6', payload_hash: `sha256:${'2'.repeat(64)}` }
      const res = await post({ ...mkFrame('card.create'), card: bad })
      expect(res.status).toBe(400)
      expect(((await res.json()) as { error?: string }).error).toBe('bad_frame')
      // a later post reaching the apps shows the refused one was decided, and dropped, before it
      const marker = await post({ ...mkFrame('reply'), message: replyMessage('marker') })
      expect(marker.status).toBe(200)
      await app.expectFrame('reply', (f) => f.message.text === 'marker')
      expect(app.rec.of('card.create', 'in').map((f) => f.card.id)).toEqual([good.id])
    })

    it('the same card.create posted twice answers with the same seq and shows the apps one card', async () => {
      const app = await k().connectedApp()
      const frame = { ...mkFrame('card.create'), card: buildCard({ thread_id: 'general', title: 'Twice' }) }
      const first = (await (await post(frame)).json()) as { ack: { seq: number } }
      const second = (await (await post(frame)).json()) as { ack: { seq: number } }
      expect(second.ack.seq).toBe(first.ack.seq)
      await post({ ...mkFrame('reply'), message: replyMessage('marker') })
      await app.expectFrame('reply', (f) => f.message.text === 'marker')
      expect(app.rec.of('card.create', 'in')).toHaveLength(1)
    })
  })

  describe('POST /bridge/rotate', () => {
    async function rotate(over: { ts?: number; sign?: 'new' | 'other' } = {}) {
      const relay = getRelay()
      const next = await generateBridgeKey()
      const other = await generateBridgeKey()
      const ts = over.ts ?? Math.floor(Date.now() / 1000)
      const sig_new = await signRotation((over.sign === 'other' ? other : next).privateKey, next.publicKeyB64, ts)
      const body = JSON.stringify({ new_pubkey: next.publicKeyB64, sig_new, ts })
      const key = relay.bridgeKey
      const res = await fetch(`${relay.httpBase}/bridge/rotate`, {
        method: 'POST',
        body,
        headers: {
          'content-type': 'application/json',
          authorization: await signBridgeHttp({
            privateKey: key.privateKey,
            keyId: key.keyId,
            method: 'POST',
            pathWithQuery: '/bridge/rotate',
            body,
          }),
        },
      })
      return res.status
    }

    // The accepted rotation is not here: it needs the relay's real key store, which a test sign-in does not have. The
    // real relay's own tests (apps/relay/test/auth/bridge-auth.test.ts) and FakeRelay's cover that side.
    it('refuses an announcement signed by a different key', async () => {
      expect(await rotate({ sign: 'other' })).toBe(401)
    })
    it('refuses a stale timestamp', async () => {
      expect(await rotate({ ts: Math.floor(Date.now() / 1000) - 600 })).toBe(401)
    })
  })
}

function replyMessage(text: string) {
  return {
    id: newId('m'),
    thread_id: 'general',
    author: 'agent',
    kind: 'text',
    text,
    format: 'plain',
    attachments: [],
    via: 'app',
    created_at: new Date().toISOString(),
  }
}
