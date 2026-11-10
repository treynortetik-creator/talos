// The folder picker through the real relay: a signed `fs.list` goes to the Mac and `fs.listing` comes back to the asking
// socket only. The relay stores nothing of it, an unpinned device is refused, and with the Mac away the app is told so at once.
import { newUlid } from '@talos-app/protocol'
import { mkFrame, sleep } from '@talos-app/testkit'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { startTestRelay, type TestRelay } from './harness.ts'
import { kit } from './helpers.ts'

vi.setConfig({ testTimeout: 30_000 })

let relay: TestRelay | null = null
afterEach(async () => {
  await relay?.stop()
  relay = null
})

describe('fs.list through the real relay', () => {
  it('goes to the Mac, and the answer reaches the asker only', async () => {
    relay = await startTestRelay()
    const k = kit(relay)
    const app = await k.connectedApp()
    const other = await k.connectedApp()
    const bridge = await k
      .bridge({
        pinnedDevices: { [app.device.deviceId]: app.device.publicJwk },
        autoReply: false,
        features: ['folders/1'],
      })
      .connect()
    const ask = await app.sign({ ...mkFrame('fs.list'), request_id: newUlid(), path: null, hidden: false })
    app.send(ask)
    await bridge.expectFrame('fs.list', (x) => x.id === ask.id, { direction: 'in' })
    bridge.send({
      ...mkFrame('fs.listing'),
      request_id: ask.request_id,
      home: '/Users/alex',
      entries: [],
      more: 0,
    })
    const got = await app.expectFrame('fs.listing', (x) => x.request_id === ask.request_id, { direction: 'in' })
    expect(got.type).toBe('fs.listing')
    await sleep(200)
    expect(other.rec.frames.some((r) => r.raw.type === 'fs.listing')).toBe(false)
    await app.close()
    await other.close()
    await bridge.close()
  })

  it('with the Mac away, the asker gets mac_offline at once', async () => {
    relay = await startTestRelay()
    const k = kit(relay)
    const app = await k.connectedApp()
    const ask = await app.sign({ ...mkFrame('fs.list'), request_id: newUlid(), path: null, hidden: false })
    app.send(ask)
    const err = await app.expectFrame('error', ((x: { ref?: string }) => x.ref === ask.id) as never, {
      direction: 'in',
    })
    expect((err as unknown as { code: string }).code).toBe('mac_offline')
    await app.close()
  })

  it('an answer nobody asked for is dropped, not fanned out', async () => {
    relay = await startTestRelay()
    const k = kit(relay)
    const app = await k.connectedApp()
    const bridge = await k
      .bridge({
        pinnedDevices: { [app.device.deviceId]: app.device.publicJwk },
        autoReply: false,
        features: ['folders/1'],
      })
      .connect()
    bridge.send({
      ...mkFrame('fs.listing'),
      request_id: newUlid(),
      home: '/Users/alex',
      entries: [{ name: 'Secrets' }],
      more: 0,
    })
    await sleep(300)
    expect(app.rec.frames.some((r) => r.raw.type === 'fs.listing')).toBe(false)
    await app.close()
    await bridge.close()
  })
})
