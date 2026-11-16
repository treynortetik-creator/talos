// Settings -> Memory folders through the REAL relay hub: a signed `memory.folders` and `memory.roots_set` go to the Mac, and
// its `memory.folders_result` comes back to the asking socket and no other. The same class of gap as files.sent (a route the
// real relay lacked while the fake passed), so this runs against the real hub, not the testkit's fake.
import { newUlid } from '@talos-app/protocol'
import { mkFrame } from '@talos-app/testkit'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { startTestRelay, type TestRelay } from './harness.ts'
import { kit } from './helpers.ts'

vi.setConfig({ testTimeout: 30_000 })

let relay: TestRelay | null = null
afterEach(async () => {
  await relay?.stop()
  relay = null
})

describe('memory folders through the real relay', () => {
  it.each([
    ['memory.folders', {}],
    ['memory.roots_set', { names: ['notes'] }],
  ] as const)("%s reaches the Mac, and the Mac's answer reaches only the asker", async (type, extra) => {
    relay = await startTestRelay()
    const k = kit(relay)
    const app = await k.connectedApp()
    const other = await k.connectedApp()
    const pinned = { [app.device.deviceId]: app.device.publicJwk, [other.device.deviceId]: other.device.publicJwk }
    const bridge = await k.bridge({ pinnedDevices: pinned, autoReply: false }).connect()
    const ask = await app.sign({ ...mkFrame(type), request_id: newUlid(), ...extra })
    app.send(ask)
    await bridge.expectFrame(type, (x) => x.id === ask.id, { direction: 'in' })
    bridge.send({
      ...mkFrame('memory.folders_result'),
      request_id: ask.request_id,
      folders: [{ name: 'notes', notes: 2 }],
      chosen: ['notes'],
      enabled: true,
      ...(type === 'memory.roots_set' ? { saved: true } : {}),
    })
    const got = await app.expectFrame('memory.folders_result', (x) => x.request_id === ask.request_id, {
      direction: 'in',
    })
    expect(got.chosen).toEqual(['notes'])
    // the other device never sees it
    await expect(
      other.expectFrame('memory.folders_result', (x) => x.request_id === ask.request_id, {
        direction: 'in',
        timeoutMs: 300,
      }),
    ).rejects.toThrow()
  })
})
