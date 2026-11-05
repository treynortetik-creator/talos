import { verifyOwnerFrame } from '@talos-app/protocol'
import { describe, expect, it } from 'vitest'
import { assertWebSentOnlyValidFrames, FakeApp, FakeBridge, FakeRelay } from '../src/index.ts'

describe('FakeApp', () => {
  it('signs the raw object, with explicit empty arrays, and the relay-side bytes verify', async () => {
    const relay = await new FakeRelay().start()
    const app = new FakeApp({ relayWs: relay.wsBase })
    try {
      await app.connect()
      const sent = await app.sendMessage('general', 'hi')
      expect(sent.attachments).toEqual([])
      const raw = (await relay.expectFrame('message', (f) => f.id === sent.id)) as unknown as Record<string, unknown>
      expect(await verifyOwnerFrame(raw, app.device.publicJwk)).toBe(true)
      expect(app.sentBytes.at(-1)).toBe(JSON.stringify(sent))
      await assertWebSentOnlyValidFrames(relay, { [app.device.deviceId]: app.device.publicJwk })
    } finally {
      await app.close()
      await relay.stop()
    }
  })

  it('FakeBridge with pinned devices drops a tampered frame and answers sig_invalid', async () => {
    const relay = await new FakeRelay().start()
    const app = new FakeApp({ relayWs: relay.wsBase })
    const bridge = new FakeBridge({ relayWs: relay.wsBase, key: relay.bridgeKey })
    try {
      await app.connect()
      bridge.pin(app.device)
      await bridge.connect()
      const good = await app.buildMessage('general', 'legit')
      const tampered = { ...good, text: 'tampered' }
      app.sendRaw(JSON.stringify(tampered))
      const err = await bridge.expectFrame('error', (f) => f.ref === tampered.id, { direction: 'out' })
      expect(err.code).toBe('sig_invalid')
      expect(bridge.notified).toHaveLength(0)
      expect(bridge.dropped).toHaveLength(1)
    } finally {
      await app.close()
      await bridge.close()
      await relay.stop()
    }
  })
})

describe('FakeBridge enforces the owner-frame rules of spec 3.5 by default', () => {
  async function rig() {
    const relay = await new FakeRelay().start()
    const app = new FakeApp({ relayWs: relay.wsBase })
    await app.connect()
    const bridge = new FakeBridge({ relayWs: relay.wsBase, key: relay.bridgeKey, autoReply: false })
    bridge.pin(app.device)
    await bridge.connect()
    return { relay, app, bridge }
  }
  it('rejects a frame older than 8 days and one more than 2 minutes in the future (both validly signed)', async () => {
    const { relay, app, bridge } = await rig()
    try {
      const old = await app.sendMessage('general', 'old', { ts: new Date(Date.now() - 9 * 86_400_000).toISOString() })
      expect((await bridge.expectFrame('error', (f) => f.ref === old.id, { direction: 'out' })).code).toBe(
        'sig_invalid',
      )
      const future = await app.sendMessage('general', 'future', {
        ts: new Date(Date.now() + 10 * 60_000).toISOString(),
      })
      expect((await bridge.expectFrame('error', (f) => f.ref === future.id, { direction: 'out' })).code).toBe(
        'sig_invalid',
      )
      const fine = await app.sendMessage('general', 'fine')
      await bridge.waitNotified('message')
      expect(bridge.notified.map((f) => f.id)).toEqual([fine.id])
    } finally {
      await app.close()
      await bridge.close()
      await relay.stop()
    }
  })
  it('a replay under a new frame id with the same client_msg_id never reaches Claude twice', async () => {
    const { relay, app, bridge } = await rig()
    try {
      const first = await app.sendMessage('general', 'one')
      await bridge.waitNotified('message')
      const replay = await app.sign({
        ...(await app.buildMessage('general', 'one again', { client_msg_id: first.client_msg_id })),
      })
      // The relay would drop this itself, so it is handed straight to the bridge: only the bridge's own check can stop it.
      relay.sendToBridge(replay as Record<string, unknown>, { durable: false })
      // The bridge handles frames in order; a later frame being notified shows the replay was already decided.
      await app.sendMessage('general', 'two')
      await bridge.waitNotified('message', 2)
      expect(bridge.notified).toHaveLength(2) // 'one' and 'two'; the replay never reached Claude
      expect(JSON.stringify(bridge.notified)).not.toContain('one again')
    } finally {
      await app.close()
      await bridge.close()
      await relay.stop()
    }
  })
  it('a bridge that opts out with verifyOwner:false accepts unsigned-by-anyone frames (tests that are not about signatures)', async () => {
    const relay = await new FakeRelay().start()
    const app = new FakeApp({ relayWs: relay.wsBase })
    const bridge = new FakeBridge({ relayWs: relay.wsBase, key: relay.bridgeKey, verifyOwner: false, autoReply: false })
    try {
      await app.connect()
      await bridge.connect()
      await app.sendMessage('general', 'hi')
      await bridge.waitNotified('message')
    } finally {
      await app.close()
      await bridge.close()
      await relay.stop()
    }
  })
})
