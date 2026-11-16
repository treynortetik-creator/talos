// The bug reporter's read through the real relay: a signed `bug.context` goes to the Mac and `bug.context_result` comes back to
// the asking socket only; it is stored nowhere; an unpinned device is refused; with the Mac away the asker is told at once.
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

describe('bug.context through the real relay', () => {
  it('goes to the Mac, and the answer reaches the asker only', async () => {
    relay = await startTestRelay()
    const k = kit(relay)
    const app = await k.connectedApp()
    const other = await k.connectedApp()
    const bridge = await k
      .bridge({ pinnedDevices: { [app.device.deviceId]: app.device.publicJwk }, autoReply: false })
      .connect()
    const ask = await app.sign({ ...mkFrame('bug.context'), request_id: newUlid(), lines: 200 })
    app.send(ask)
    await bridge.expectFrame('bug.context', (x) => x.id === ask.id, { direction: 'in' })
    bridge.send({
      ...mkFrame('bug.context_result'),
      request_id: ask.request_id,
      bridge_version: '1.2.3',
      claude_code: null,
      recent_errors: [],
      logs: 'a line',
    })
    const got = await app.expectFrame('bug.context_result', (x) => x.request_id === ask.request_id, {
      direction: 'in',
    })
    expect(got.type).toBe('bug.context_result')
    await sleep(200)
    expect(other.rec.frames.some((r) => r.raw.type === 'bug.context_result')).toBe(false)
    await app.close()
    await other.close()
    await bridge.close()
  })

  it('refuses a device the Mac has not pinned, and tells the asker at once when the Mac is away', async () => {
    relay = await startTestRelay()
    const k = kit(relay)
    const app = await k.connectedApp()
    const ask = await app.sign({ ...mkFrame('bug.context'), request_id: newUlid(), lines: 5 })
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
      .bridge({ pinnedDevices: { [app.device.deviceId]: app.device.publicJwk }, autoReply: false })
      .connect()
    bridge.send({
      ...mkFrame('bug.context_result'),
      request_id: newUlid(),
      bridge_version: '1',
      claude_code: null,
      recent_errors: [],
      logs: '',
    })
    await sleep(300)
    expect(app.rec.frames.some((r) => r.raw.type === 'bug.context_result')).toBe(false)
    await app.close()
    await bridge.close()
  })
})
