// The thread's AGENTS.md through the real relay: a signed `agents_md.read` / `agents_md.write` goes to the Mac and the file
// comes back to the asking socket only. The relay stores none of it: a device that connects later, or the Mac reconnecting,
// is handed nothing of the save. With the Mac away the asker is told at once.
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

const TEXT = '# Trip\n\nzq-marker-agents-md-41\n'
const file = (requestId: unknown) => ({
  ...mkFrame('agents_md.file'),
  request_id: requestId,
  thread_id: 'general',
  exists: true,
  sha: 'b'.repeat(64),
  text: TEXT,
  saved: true,
})

describe('agents_md.* through the real relay', () => {
  it('a save goes to the Mac and its answer reaches the asker only; nothing of it is kept or replayed', async () => {
    relay = await startTestRelay()
    const k = kit(relay)
    const app = await k.connectedApp()
    const other = await k.connectedApp()
    const pinned = { [app.device.deviceId]: app.device.publicJwk }
    const bridge = await k.bridge({ pinnedDevices: pinned, autoReply: false }).connect()
    const save = await app.sign({
      ...mkFrame('agents_md.write'),
      request_id: newUlid(),
      thread_id: 'general',
      text: TEXT,
      base_sha: null,
    })
    app.send(save)
    await bridge.expectFrame('agents_md.write', (x) => x.id === save.id, { direction: 'in' })
    bridge.send(file(save.request_id))
    const got = await app.expectFrame('agents_md.file', (x) => x.request_id === save.request_id, { direction: 'in' })
    expect(got.text).toBe(TEXT)
    const read = await app.sign({ ...mkFrame('agents_md.read'), request_id: newUlid(), thread_id: 'general' })
    app.send(read)
    await bridge.expectFrame('agents_md.read', (x) => x.id === read.id, { direction: 'in' })
    await sleep(200)
    const seen = (frames: Array<{ raw: unknown }>) => JSON.stringify(frames.map((f) => f.raw))
    expect(seen(other.rec.frames)).not.toContain('zq-marker-agents-md-41')
    // a device that connects now, and the Mac reconnecting, are handed nothing of it
    const later = await k.connectedApp()
    await bridge.close()
    const again = await k.bridge({ pinnedDevices: pinned, autoReply: false }).connect()
    await sleep(300)
    expect(seen(later.rec.frames)).not.toContain('zq-marker-agents-md-41')
    expect(again.rec.frames.some((f) => f.raw.type === 'agents_md.write')).toBe(false)
    await app.close()
    await other.close()
    await later.close()
    await again.close()
  })

  it('with the Mac away, the asker gets mac_offline at once', async () => {
    relay = await startTestRelay()
    const k = kit(relay)
    const app = await k.connectedApp()
    const save = await app.sign({
      ...mkFrame('agents_md.write'),
      request_id: newUlid(),
      thread_id: 'general',
      text: TEXT,
      base_sha: null,
    })
    app.send(save)
    const err = await app.expectFrame('error', ((x: { ref?: string }) => x.ref === save.id) as never, {
      direction: 'in',
    })
    expect((err as unknown as { code: string }).code).toBe('mac_offline')
    await app.close()
  })
})
