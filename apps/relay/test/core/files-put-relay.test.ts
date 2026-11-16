// Upload into a thread's folder through the real relay: a signed `files.put` goes to the Mac and its answer reaches the
// asking socket only; the relay keeps none of it (a device that connects later, or the Mac reconnecting, is handed nothing).
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

const media = {
  media_id: 'md_01JBF3V7Q8K2M4N6P8R0S2T4AB',
  name: 'zq-put-marker-52.md',
  mime: 'text/markdown',
  size: 7,
  sha256: 'c'.repeat(64),
  kind: 'file',
  role: 'attachment',
}

describe('files.put through the real relay', () => {
  it('goes to the Mac, its answer reaches the asker only, and nothing of it is kept or replayed', async () => {
    relay = await startTestRelay()
    const k = kit(relay)
    const app = await k.connectedApp()
    const other = await k.connectedApp()
    const pinned = { [app.device.deviceId]: app.device.publicJwk }
    const bridge = await k.bridge({ pinnedDevices: pinned, autoReply: false }).connect()
    const put = await app.sign({
      ...mkFrame('files.put'),
      request_id: newUlid(),
      thread_id: 'general',
      dir: '',
      name: 'zq-put-marker-52.md',
      media,
    })
    app.send(put)
    await bridge.expectFrame('files.put', (x) => x.id === put.id, { direction: 'in' })
    bridge.send({
      ...mkFrame('files.put_result'),
      request_id: put.request_id,
      thread_id: 'general',
      dir: '',
      name: 'zq-put-marker-52.md',
      size: 7,
    })
    await app.expectFrame('files.put_result', (x) => x.request_id === put.request_id, { direction: 'in' })
    await sleep(200)
    const seen = (frames: Array<{ raw: unknown }>) => JSON.stringify(frames.map((f) => f.raw))
    expect(seen(other.rec.frames)).not.toContain('zq-put-marker-52')
    const later = await k.connectedApp()
    await bridge.close()
    const again = await k.bridge({ pinnedDevices: pinned, autoReply: false }).connect()
    await sleep(300)
    expect(seen(later.rec.frames)).not.toContain('zq-put-marker-52')
    expect(again.rec.frames.some((f) => f.raw.type === 'files.put')).toBe(false)
    await app.close()
    await other.close()
    await later.close()
    await again.close()
  })
})
