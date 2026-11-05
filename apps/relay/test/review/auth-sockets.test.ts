// Review fixes #1, #19, #26, #28 against the real relay: real auth, real hub, real sockets.
import { sleep } from '@talos-app/testkit'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { closeCodeWithin, type RealRelay, startRealRelay } from './real-relay.ts'

vi.setConfig({ testTimeout: 20_000 })

let r: RealRelay | null = null
afterEach(async () => {
  await r?.stop()
  r = null
})

describe('#1 a revoked or signed-out session loses its live socket', () => {
  it('revoking a device closes its socket with 4401 and it sees nothing more', async () => {
    r = await startRealRelay()
    const a = await r.owner()
    const b = await r.owner()
    const appA = r.app(a)
    const appB = r.app(b)
    await appA.connect()
    await appB.connect()
    const bridge = await r.bridge().connect()

    const closed = closeCodeWithin(appA, 3000)
    const token = r.auth.core.mintStepup(b.sessionId, 'device:revoke')
    const res = await r.post(`/api/devices/${a.device.deviceId}/revoke`, { stepup_token: token }, b)
    expect(res.status).toBe(204)
    expect(await closed).toBe(4401)

    bridge.reply('general', 'secret reply after revoke')
    await appB.expectFrame('reply')
    expect(appB.connected).toBe(true)
    await appA.rec.expectNoFrame('reply')
  })

  it('a stolen phone cannot pull catch-up or history after the revoke', async () => {
    r = await startRealRelay()
    const a = await r.owner()
    const b = await r.owner()
    const bridge = await r.bridge().connect()
    bridge.reply('general', 'buffered before')
    const appA = r.app(a)
    await appA.connect()
    const closed = closeCodeWithin(appA, 3000)
    const token = r.auth.core.mintStepup(b.sessionId, 'device:revoke')
    expect((await r.post(`/api/devices/${a.device.deviceId}/revoke`, { stepup_token: token }, b)).status).toBe(204)
    expect(await closed).toBe(4401)
    // A frame sent in the same breath, on the dead socket, gets no answer (the socket is gone).
    appA.send({ type: 'catchup.request', since_seq: 0 })
    await appA.rec.expectNoFrame('catchup.batch', () => true, 300, { since: appA.rec.length - 1 })
  })

  it('logout closes only that session socket', async () => {
    r = await startRealRelay()
    const a = await r.owner()
    const b = await r.owner()
    const appA = r.app(a)
    const appB = r.app(b)
    await appA.connect()
    await appB.connect()
    const closed = closeCodeWithin(appA, 3000)
    expect((await r.post('/api/auth/logout', {}, a)).status).toBe(204)
    expect(await closed).toBe(4401)
    expect(appB.connected).toBe(true)
  })

  it('logout-all closes every socket', async () => {
    r = await startRealRelay()
    const a = await r.owner()
    const b = await r.owner()
    const appA = r.app(a)
    const appB = r.app(b)
    await appA.connect()
    await appB.connect()
    const closedA = closeCodeWithin(appA, 3000)
    const closedB = closeCodeWithin(appB, 3000)
    expect((await r.post('/api/auth/logout-all', {}, a)).status).toBe(204)
    expect(await closedA).toBe(4401)
    expect(await closedB).toBe(4401)
  })

  it('when the Mac un-pins a device its live socket stops receiving the feed', async () => {
    r = await startRealRelay()
    const a = await r.owner()
    const b = await r.owner()
    const appA = r.app(a)
    const appB = r.app(b)
    await appA.connect()
    await appB.connect()
    const bridge = await r.bridge().connect()
    bridge.send({ type: 'device.pinned', device_id: a.device.deviceId, ok: false, reason: 'declined' })
    await appB.expectFrame('device.pinned')
    await sleep(100)
    bridge.reply('general', 'after unpin')
    await appB.expectFrame('reply')
    await appA.rec.expectNoFrame('reply')
  })
})

describe('#28 logout-all needs a pinned session', () => {
  it('an unpinned session cannot sign the owner out everywhere', async () => {
    r = await startRealRelay()
    const owner = await r.owner()
    const stranger = await r.owner({ pinned: false })
    const appOwner = r.app(owner)
    await appOwner.connect()
    const res = await r.post('/api/auth/logout-all', {}, stranger)
    expect(res.status).toBe(403)
    expect(appOwner.connected).toBe(true)
    const me = await fetch(`${r.httpBase}/api/me`, { headers: { Cookie: owner.cookie } })
    expect(me.status).toBe(200)
  })
})

describe('#19 step-up has its own rate bucket', () => {
  it('twenty step-up calls in a minute do not hit the login limit', async () => {
    r = await startRealRelay()
    const o = await r.owner()
    const codes: number[] = []
    for (let i = 0; i < 20; i++) {
      codes.push((await r.post('/api/auth/stepup/options', { purpose: 'device:revoke' }, o)).status)
    }
    expect(codes.every((c) => c === 200)).toBe(true)
    // and the shared login budget is untouched
    expect((await r.post('/api/auth/login/options', {}, null)).status).toBe(200)
  })
})

describe('#26 one device.pinned per pin', () => {
  it('the app gets one device.pinned frame and the owner one push', async () => {
    r = await startRealRelay()
    const u = await r.owner({ pinned: false })
    r.runtime.store.putSub({ endpoint: 'https://push.example.com/send/1', keys: { p256dh: 'p', auth: 'a' } })
    const app = r.app(u, { visible: false })
    await app.connect()
    const bridge = await r.bridge().connect()
    bridge.send({ type: 'device.pinned', device_id: u.device.deviceId, ok: true })
    await app.expectFrame('device.pinned')
    await sleep(400)
    await vi.waitFor(() => expect(app.rec.of('device.pinned')).toHaveLength(1), { timeout: 10_000 })
    expect(r.transport.sent).toHaveLength(1)
    // pinning still hands over the real ready
    const readies = app.rec.of('ready')
    expect(readies.length).toBeGreaterThanOrEqual(2)
    expect((readies[readies.length - 1] as { agent_config?: unknown }).agent_config).toBeDefined()
  })
})
