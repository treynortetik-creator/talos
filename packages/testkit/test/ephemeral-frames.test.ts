// The v2 read-router contract against the kit's own FakeRelay + FakeBridge, so the fakes the builders use behave like the
// real relay (which runs the same contract in apps/relay/test/core/v2-v0.test.ts).
import { defineEphemeralFramesContract, FakeApp, FakeBridge, FakeRelay, mkFrame, sleep, waitFor } from '../src/index.ts'

defineEphemeralFramesContract('FakeRelay + FakeBridge', {
  async start() {
    const relay = await new FakeRelay().start()
    const app = new FakeApp({ relayWs: relay.wsBase })
    const other = new FakeApp({ relayWs: relay.wsBase })
    await app.connect()
    await other.connect()
    const bridge = await new FakeBridge({
      relayWs: relay.wsBase,
      key: relay.bridgeKey,
      autoReply: false,
      pinnedDevices: { [app.device.deviceId]: app.device.publicJwk },
    }).connect()
    const inOf = (a: FakeApp) => a.rec.frames.filter((r) => r.direction === 'in').map((r) => r.raw)
    return {
      sendRead: async (frame) => {
        const signed = await app.sign({ ...mkFrame(String(frame.type)), ...frame })
        app.send(signed)
        return signed
      },
      expectApp: (type, pred, timeoutMs) =>
        app.expectFrame(type as never, pred as never, { direction: 'in', timeoutMs }) as never,
      receivedApp: () => inOf(app),
      receivedOther: () => inOf(other),
      expectBridge: (type, pred, timeoutMs) =>
        bridge.expectFrame(type as never, pred as never, { direction: 'in', timeoutMs }) as never,
      bridgeSend: (frame) => {
        bridge.send(frame)
      },
      bridgeOffline: async () => {
        await bridge.close()
        await waitFor(() => !relay.bridgeConnected, 3000, 'bridge gone')
      },
      freshCatchup: async () => {
        const fresh = new FakeApp({ relayWs: relay.wsBase })
        await fresh.connect()
        fresh.send({ type: 'catchup.request', since_seq: 0 })
        await sleep(200)
        const got = inOf(fresh).flatMap((f) =>
          f.type === 'catchup.batch' ? (f.frames as Record<string, unknown>[]) : [f],
        )
        await fresh.close()
        return got
      },
      stop: async () => {
        await app.close()
        await other.close()
        await bridge.close()
        ;(relay as unknown as { server?: { closeAllConnections?: () => void } }).server?.closeAllConnections?.()
        await relay.stop()
      },
    }
  },
})
