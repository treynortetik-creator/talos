import {
  bindingFrom,
  createDeviceKey,
  generateBridgeKey,
  payloadHash,
  signBridgeHttp,
  signRotation,
} from '@talos-app/protocol'
import { describe, expect, it } from 'vitest'
import { WebSocket } from 'ws'
import {
  buildCard,
  defineRelayContract,
  defineTwoStageAckContract,
  FakeApp,
  FakeBridge,
  FakeRelay,
  fakeRelayHarness,
  TEST_DEVICE_HEADER,
  TEST_UNPINNED_HEADER,
} from '../src/index.ts'

// The kit proves the contracts are satisfiable by running them against FakeRelay. WP1 runs the same functions
// against the real relay.
defineRelayContract('FakeRelay (no session guard)', fakeRelayHarness())
defineRelayContract('FakeRelay (session header + Origin guard)', fakeRelayHarness({ authHeaders: true }))
defineTwoStageAckContract('FakeRelay', fakeRelayHarness())
defineTwoStageAckContract('FakeRelay (session guard)', fakeRelayHarness({ authHeaders: true }))

describe('FakeRelay HTTP', () => {
  it('serves /healthz, rejects unsigned bridge requests, and stores bridge media with a sha256 check', async () => {
    const relay = await new FakeRelay().start()
    try {
      expect(((await (await fetch(`${relay.httpUrl}/healthz`)).json()) as { ok: boolean }).ok).toBe(true)
      const id = 'md_01JBF3V7Q8K2M4N6P8R0S2T4V6'
      const path = `/bridge/media/${id}`
      const k = relay.bridgeKey
      const call = async (method: string, body: string, extra: Record<string, string> = {}, signed = true) =>
        fetch(`${relay.httpUrl}${path}`, {
          method,
          ...(method === 'GET' ? {} : { body }),
          headers: {
            ...extra,
            ...(signed
              ? {
                  authorization: await signBridgeHttp({
                    privateKey: k.privateKey,
                    keyId: k.keyId,
                    method,
                    pathWithQuery: path,
                    body: method === 'GET' ? '' : body,
                  }),
                }
              : {}),
          },
        })
      expect((await call('PUT', 'abc', {}, false)).status).toBe(401)
      expect((await call('PUT', 'abc', { 'x-talos-sha256': '0'.repeat(64) })).status).toBe(400)
      expect((await call('PUT', 'abc')).status).toBe(200)
      expect(await (await call('GET', '')).text()).toBe('abc')
    } finally {
      await relay.stop()
    }
  })
})

describe('FakeRelay black hole', () => {
  const open = (url: string) =>
    new Promise<{ ws: WebSocket; got: string[] }>((resolve, reject) => {
      const ws = new WebSocket(url)
      const got: string[] = []
      ws.on('message', (d) => got.push(d.toString()))
      ws.on('open', () => resolve({ ws, got }))
      ws.on('error', reject)
    })
  const until = async (ok: () => boolean) => {
    for (let i = 0; i < 500 && !ok(); i++) await new Promise((r) => setTimeout(r, 10))
    expect(ok()).toBe(true)
  }

  it('swallows everything bound for the bridge but keeps the socket open; the control hears the challenge', async () => {
    const relay = await new FakeRelay().start()
    try {
      const control = await open(`${relay.wsBase}/bridge`)
      await until(() => control.got.length === 1)
      expect(JSON.parse(control.got[0] as string).type).toBe('challenge')
      control.ws.close()

      relay.blackHole = true
      const dark = await open(`${relay.wsBase}/bridge`)
      await until(() => relay.blackHoled === 1) // the challenge was produced and swallowed
      expect(dark.ws.readyState).toBe(WebSocket.OPEN)
      expect(dark.got).toEqual([])
      expect(relay.frames.filter((r) => r.direction === 'to_bridge' && r.frame.type === 'challenge')).toHaveLength(1) // only the control's
      dark.ws.close()
    } finally {
      await relay.stop()
    }
  })
})

// What only the fake can show: the relay's clock is the test's, and the real relay's accepted rotation and device pinning
// live in its auth module, which the contract's test sign-in does not have.
describe('FakeRelay behaviour the contract cannot reach', () => {
  it('a resolve the Mac refused, on a card that lapsed meanwhile, leaves it expired and tells the apps', async () => {
    let clock = Date.now()
    const relay = await new FakeRelay({ now: () => clock }).start()
    try {
      const app = new FakeApp({ relayWs: relay.wsBase })
      await app.connect()
      const bridge = await new FakeBridge({
        relayWs: relay.wsBase,
        key: relay.bridgeKey,
        verifyOwner: false,
        consume: 'manual',
      }).connect()
      const card = buildCard({ thread_id: 'general', title: 'Lapses' })
      bridge.send({ type: 'card.create', card })
      await app.expectFrame('card.create', (f) => f.card.id === card.id)
      const sent = await app.resolveCard(card, 'kill', payloadHash(bindingFrom(card)))
      await bridge.expectFrame('card.resolve', (f) => f.id === sent.id, { direction: 'in' })
      clock = Date.parse(card.expires_at) + 1_000
      bridge.send({ type: 'error', ref: sent.id, code: 'device_not_pinned', message: 'not pinned' })
      const update = await app.expectFrame('card.update', (f) => f.card_id === card.id && f.state === 'expired')
      expect(update.reason).toBe('expired')
      const again = await app.resolveCard(card, 'kill', payloadHash(bindingFrom(card)))
      expect((await app.expectFrame('error', (f) => f.ref === again.id)).code).toBe('card_expired')
    } finally {
      await relay.stop()
    }
  })

  it('agent.recover: with the Mac away it says mac_offline; a restore from an old app is refused in words, trust mode or not', async () => {
    const relay = await new FakeRelay().start()
    try {
      const app = new FakeApp({ relayWs: relay.wsBase })
      const ready = await app.connect()
      const away = await app.sendAgentRecover('restart')
      expect((await app.expectFrame('error', (f) => f.ref === away.id)).code).toBe('mac_offline')
      const bridge = await new FakeBridge({
        relayWs: relay.wsBase,
        key: relay.bridgeKey,
        verifyOwner: false,
        consume: 'manual',
      }).connect()
      const bare = await app.sendAgentRecover('restore_last_good')
      expect((await app.expectFrame('error', (f) => f.ref === bare.id)).message).toContain('needs the Mac now')
      bridge.send({
        type: 'config.sync',
        config: { ...(ready.agent_config as object), rev: 1, trust_mode: true },
        rev: 1,
      })
      await app.expectFrame('config.sync', (f) => f.rev === 1)
      const trusted = await app.sendAgentRecover('restore_last_good')
      expect((await app.expectFrame('error', (f) => f.ref === trusted.id)).message).toContain('needs the Mac now')
      const ok = await app.sendAgentRecover('restart')
      await bridge.expectFrame('agent.recover', (f) => f.id === ok.id, { direction: 'in' })
    } finally {
      await relay.stop()
    }
  })

  it('a device the Mac pins with device.pinned leaves pairing-only', async () => {
    const relay = await new FakeRelay().start()
    try {
      const key = await createDeviceKey()
      const app = new FakeApp({
        relayWs: relay.wsBase,
        deviceKey: key,
        headers: { [TEST_DEVICE_HEADER]: key.deviceId, [TEST_UNPINNED_HEADER]: '1' },
      })
      expect((await app.connect()).agent_config).toBeUndefined()
      const bridge = await new FakeBridge({ relayWs: relay.wsBase, key: relay.bridgeKey }).connect()
      const pinned = bridge.send({ type: 'device.pinned', device_id: key.deviceId, ok: true })
      await app.expectFrame('device.pinned', (f) => f.id === pinned.id) // part of the handshake, so it is not held back
      await app.expectFrame('ready', (f) => f.agent_config !== undefined)
    } finally {
      await relay.stop()
    }
  })

  it('POST /bridge/rotate answers with the new key id when the new key signed its own announcement', async () => {
    const relay = await new FakeRelay().start()
    try {
      const next = await generateBridgeKey()
      const ts = Math.floor(Date.now() / 1000)
      const body = JSON.stringify({
        new_pubkey: next.publicKeyB64,
        sig_new: await signRotation(next.privateKey, next.publicKeyB64, ts),
        ts,
      })
      const k = relay.bridgeKey
      const res = await fetch(`${relay.httpUrl}/bridge/rotate`, {
        method: 'POST',
        body,
        headers: {
          'content-type': 'application/json',
          authorization: await signBridgeHttp({
            privateKey: k.privateKey,
            keyId: k.keyId,
            method: 'POST',
            pathWithQuery: '/bridge/rotate',
            body,
          }),
        },
      })
      expect(res.status).toBe(200)
      expect(((await res.json()) as { key_id?: string }).key_id).toBe(next.keyId)
    } finally {
      await relay.stop()
    }
  })
})
