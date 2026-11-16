// The Files pane through the real relay: a signed `files.list` / `files.read` goes to the Mac and the answer comes back to the
// asking socket only. The relay stores nothing of it, an answer of the wrong type for the request is dropped, and with the
// Mac away the app is told so at once.
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

const file = (requestId: unknown) => ({
  ...mkFrame('files.file'),
  request_id: requestId,
  thread_id: 'general',
  path: 'README.md',
  kind: 'text',
  size: 5,
  mtime: new Date().toISOString(),
  text: '# Hi\n',
  offset: 0,
  next_offset: null,
  truncated: false,
})

describe('files.* through the real relay', () => {
  it('a list and a read go to the Mac, and each answer reaches the asker only', async () => {
    relay = await startTestRelay()
    const k = kit(relay)
    const app = await k.connectedApp()
    const other = await k.connectedApp()
    const bridge = await k
      .bridge({
        pinnedDevices: { [app.device.deviceId]: app.device.publicJwk },
        autoReply: false,
        features: ['files/1'],
      })
      .connect()
    const list = await app.sign({ ...mkFrame('files.list'), request_id: newUlid(), thread_id: 'general', path: '' })
    app.send(list)
    await bridge.expectFrame('files.list', (x) => x.id === list.id, { direction: 'in' })
    bridge.send({
      ...mkFrame('files.listing'),
      request_id: list.request_id,
      thread_id: 'general',
      root: '/Users/alex/talos-agent',
      path: '',
      entries: [{ name: 'README.md', kind: 'file', size: 5 }],
      more: 0,
    })
    await app.expectFrame('files.listing', (x) => x.request_id === list.request_id, { direction: 'in' })
    const read = await app.sign({
      ...mkFrame('files.read'),
      request_id: newUlid(),
      thread_id: 'general',
      path: 'README.md',
      offset: 0,
    })
    app.send(read)
    await bridge.expectFrame('files.read', (x) => x.id === read.id, { direction: 'in' })
    bridge.send(file(read.request_id))
    const got = await app.expectFrame('files.file', (x) => x.request_id === read.request_id, { direction: 'in' })
    expect(got.text).toBe('# Hi\n')
    await sleep(200)
    expect(other.rec.frames.some((r) => r.raw.type === 'files.listing' || r.raw.type === 'files.file')).toBe(false)
    await app.close()
    await other.close()
    await bridge.close()
  })

  it('with the Mac away, the asker gets mac_offline at once', async () => {
    relay = await startTestRelay()
    const k = kit(relay)
    const app = await k.connectedApp()
    const ask = await app.sign({ ...mkFrame('files.list'), request_id: newUlid(), thread_id: 'general', path: '' })
    app.send(ask)
    const err = await app.expectFrame('error', ((x: { ref?: string }) => x.ref === ask.id) as never, {
      direction: 'in',
    })
    expect((err as unknown as { code: string }).code).toBe('mac_offline')
    await app.close()
  })

  it('an answer nobody asked for, or of the wrong type for the request, is dropped', async () => {
    relay = await startTestRelay()
    const k = kit(relay)
    const app = await k.connectedApp()
    const bridge = await k
      .bridge({
        pinnedDevices: { [app.device.deviceId]: app.device.publicJwk },
        autoReply: false,
        features: ['files/1'],
      })
      .connect()
    bridge.send(file(newUlid()))
    // a listing was asked for: a file answer under its request_id does not reach the app
    const list = await app.sign({ ...mkFrame('files.list'), request_id: newUlid(), thread_id: 'general', path: '' })
    app.send(list)
    await bridge.expectFrame('files.list', (x) => x.id === list.id, { direction: 'in' })
    bridge.send(file(list.request_id))
    await sleep(300)
    expect(app.rec.frames.some((r) => r.raw.type === 'files.file')).toBe(false)
    await app.close()
    await bridge.close()
  })
})
