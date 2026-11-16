// Memory -> Graph through the REAL relay hub: a signed `memory.graph` goes to the Mac and its `memory.graph_result` comes back
// to the asking socket only. The same class of gap as files.sent (a route the real relay lacked while the fake passed).
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

describe('memory.graph through the real relay', () => {
  it("reaches the Mac, and the Mac's graph reaches only the asker", async () => {
    relay = await startTestRelay()
    const k = kit(relay)
    const app = await k.connectedApp()
    const other = await k.connectedApp()
    const pinned = { [app.device.deviceId]: app.device.publicJwk, [other.device.deviceId]: other.device.publicJwk }
    const bridge = await k.bridge({ pinnedDevices: pinned, autoReply: false }).connect()
    const ask = await app.sign({ ...mkFrame('memory.graph'), request_id: newUlid() })
    app.send(ask)
    await bridge.expectFrame('memory.graph', (x) => x.id === ask.id, { direction: 'in' })
    bridge.send({
      ...mkFrame('memory.graph_result'),
      request_id: ask.request_id,
      roots: [{ id: 'notes', label: 'Notes' }],
      nodes: [
        { r: 0, p: 'alpha.md', t: 'Alpha' },
        { r: 0, p: 'beta.md', t: 'Beta' },
      ],
      edges: [[0, 1]],
      total_nodes: 2,
      truncated: false,
    })
    const got = await app.expectFrame('memory.graph_result', (x) => x.request_id === ask.request_id, {
      direction: 'in',
    })
    expect(got.edges).toEqual([[0, 1]])
    await expect(
      other.expectFrame('memory.graph_result', (x) => x.request_id === ask.request_id, {
        direction: 'in',
        timeoutMs: 300,
      }),
    ).rejects.toThrow()
  })
})
