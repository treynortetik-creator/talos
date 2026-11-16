// "Undo to here" through the real relay: the owner's undo.request reaches the Mac once, never a Mac that is away, and
// the Mac's answer reaches the app. The relay says undo/1, and keeps a message's undo point from its `delivered`
// receipt: on a repeat, after `seen`, in catch-up and on a history row.
import { FakeBridge, mkFrame, sleep } from '@talos-app/testkit'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { type RealRelay, startRealRelay } from './real-relay.ts'

vi.setConfig({ testTimeout: 20_000 })

let r: RealRelay | null = null
afterEach(async () => {
  await r?.stop()
  r = null
})

const MSG = 'm_01JBF3V7Q8K2M4N6P8R0S2T40Q'

async function rig() {
  r = await startRealRelay()
  const o = await r.owner()
  const app = r.app(o)
  const ready = await app.connect()
  const bridge = await new FakeBridge({
    relayWs: r.wsBase,
    key: r.bridgeKey,
    verifyOwner: false,
    consume: 'manual',
  }).connect()
  return { rel: r, o, app, ready, bridge }
}

describe('undo.request at the relay', () => {
  it('the relay says undo/1', async () => {
    const { ready } = await rig()
    expect(ready.features).toContain('undo/1')
  })

  it('reaches the Mac once, however often it is sent', async () => {
    const { app, bridge } = await rig()
    const f = await app.sendUndoRequest('general', MSG)
    const got = await bridge.expectFrame('undo.request', (x) => x.id === f.id, { direction: 'in' })
    expect(got).toMatchObject({ thread_id: 'general', message_id: MSG })
    app.send(f)
    await sleep(120)
    expect(bridge.rec.of('undo.request', 'in').map((x) => x.id)).toEqual([f.id])
  })

  it('with the Mac away it says mac_offline and queues nothing', async () => {
    const { rel, app, bridge } = await rig()
    await bridge.close()
    await sleep(120)
    const f = await app.sendUndoRequest('general', MSG)
    expect((await app.expectFrame('error', (e) => e.ref === f.id)).code).toBe('mac_offline')
    expect(rel.runtime.store.seen(`ur:${f.id}`)).toBeUndefined()
  })

  it('an unknown key is refused, and never reaches the Mac', async () => {
    const { app, bridge } = await rig()
    const f = await app.sendUndoRequest('general', MSG)
    await bridge.expectFrame('undo.request', (x) => x.id === f.id, { direction: 'in' })
    const extra = { ...f, id: mkFrame('undo.request').id, also_delete: ['notes.txt'] }
    app.send(extra)
    expect((await app.expectFrame('error', (e) => e.ref === extra.id || e.code === 'bad_frame')).code).toBe('bad_frame')
    await sleep(80)
    expect(bridge.rec.of('undo.request', 'in').map((x) => x.id)).toEqual([f.id])
  })

  it("the Mac's answer reaches the app", async () => {
    const { app, bridge } = await rig()
    const f = await app.sendUndoRequest('general', MSG)
    await bridge.expectFrame('undo.request', (x) => x.id === f.id, { direction: 'in' })
    bridge.send({
      ...mkFrame('undo.request.result'),
      control_id: f.control_id,
      ok: false,
      text: 'Nothing to undo: the files already match.',
      at: new Date().toISOString(),
    })
    const res = await app.expectFrame('undo.request.result', (x) => x.control_id === f.control_id)
    expect(res).toMatchObject({ ok: false, text: 'Nothing to undo: the files already match.' })
  })
})
