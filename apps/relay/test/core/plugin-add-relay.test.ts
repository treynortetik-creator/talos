// "Add plugin to agent" through the relay: the owner's signed request is queued once for the Mac, the Mac's result comes back to the app, and the
// plugin-add/1 is the BRIDGE's feature, so the relay lists nothing.
import { fakeClock, t } from '@talos-app/testkit'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { startTestRelay, type TestRelay } from './harness.ts'
import { kit } from './helpers.ts'

vi.setConfig({ testTimeout: t(30_000) })
let relay: TestRelay | null = null
afterEach(async () => {
  await relay?.stop()
  relay = null
})

describe('plugin.add through the relay', () => {
  it('a signed request reaches the Mac once (a repeat of the same frame does not), and the Mac’s result reaches the app', async () => {
    relay = await startTestRelay({ clock: fakeClock('2026-11-26T15:00:00.000Z') })
    const k = kit(relay)
    const app = await k.connectedApp({ visible: false })
    const bridge = await k
      .bridge({ pinnedDevices: { [app.device.deviceId]: app.device.publicJwk }, autoReply: false })
      .connect()
    const f = await app.sendPluginAddRequest('notes', 'market')
    const got = await bridge.expectFrame('plugin.add.request', (x) => x.control_id === f.control_id)
    expect(got).toMatchObject({ plugin: 'notes', marketplace: 'market' })
    app.send(f) // the same frame again: not queued twice
    await new Promise((r) => setTimeout(r, t(300))) // timing-ok: negative window
    expect(bridge.rec.frames.filter((r) => r.raw.type === 'plugin.add.request')).toHaveLength(1)
    bridge.send({
      type: 'plugin.add.result',
      control_id: f.control_id,
      ok: true,
      text: 'Asked the owner to add notes@market. Nothing was installed yet.',
      at: new Date().toISOString(),
    })
    const r = await app.expectFrame('plugin.add.result', (x) => x.control_id === f.control_id)
    expect(r.ok).toBe(true)
  })

  it('a name that is not plain is refused by the schema before it is queued', async () => {
    relay = await startTestRelay({ clock: fakeClock('2026-11-26T15:00:00.000Z') })
    const k = kit(relay)
    const app = await k.connectedApp({ visible: false })
    const bridge = await k
      .bridge({ pinnedDevices: { [app.device.deviceId]: app.device.publicJwk }, autoReply: false })
      .connect()
    await app.sendPluginAddRequest('a;rm -rf', 'market')
    await new Promise((r) => setTimeout(r, t(300))) // timing-ok: negative window
    expect(bridge.rec.frames.some((r) => r.raw.type === 'plugin.add.request')).toBe(false)
  })
})
