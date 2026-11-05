// Browser and Home Screen push subscriptions: one unreadable row degrades only itself, and a subscription belongs to the
// device that made it, so revoking or signing out that device ends its pushes. Real relay, real auth, real routes.
import { afterEach, describe, expect, it } from 'vitest'
import { type Owner, type RealRelay, startRealRelay } from '../review/real-relay.ts'

let r: RealRelay | null = null
afterEach(async () => {
  await r?.stop()
  r = null
})

const sub = (endpoint: string) => ({ endpoint, keys: { p256dh: 'a', auth: 'b' } })
const EP_A = 'https://fcm.googleapis.com/send/phone-a'
const EP_B = 'https://fcm.googleapis.com/send/phone-b'

async function subscribe(rel: RealRelay, o: Owner, endpoint: string) {
  const res = await rel.post('/api/push/subscribe', sub(endpoint), o)
  expect(res.status).toBe(204)
}
const endpoints = (rel: RealRelay) => rel.runtime.store.listSubs().map((s) => s.endpoint)
const stepupRevoke = async (rel: RealRelay, by: Owner, target: Owner) =>
  rel.post(
    `/api/devices/${target.device.deviceId}/revoke`,
    { stepup_token: rel.auth.core.mintStepup(by.sessionId, 'device:revoke') },
    by,
  )

describe('an unreadable web push row', () => {
  it('is skipped and reported while the good subscriptions still get the push', async () => {
    r = await startRealRelay()
    r.runtime.store.putSub(sub(EP_A))
    r.runtime.store.putSub(sub(EP_B))
    r.relay.services.db.prepare("update core_push_subs set sub = x'00' where endpoint = ?").run(EP_A)
    const bad: string[] = []
    expect(r.runtime.store.listSubs((e) => bad.push(e)).map((s) => s.endpoint)).toEqual([EP_B])
    expect(bad).toEqual([EP_A])
    const counts = await r.runtime.push.notifyCounted({ template: 'reply', thread_id: 'general' })
    expect(r.transport.sent.map((s) => s.endpoint)).toEqual([EP_B])
    // The unreadable row is a failed send, never "nobody to notify".
    expect(counts?.sent).toBe(2)
    expect(counts?.ok).toBe(1)
  })

  it('alone is a failed send, not a silent skip', async () => {
    r = await startRealRelay()
    r.runtime.store.putSub(sub(EP_A))
    r.relay.services.db.prepare("update core_push_subs set sub = x'00'").run()
    const counts = await r.runtime.push.notifyCounted({ template: 'reply', thread_id: 'general' })
    expect(counts?.sent).toBe(1)
    expect(counts?.ok).toBe(0)
  })
})

describe('the health test button with an unreadable row', () => {
  const press = async (rel: RealRelay) => {
    const res = await rel.post('/api/health/test', {}, await rel.owner())
    return { status: res.status, body: (await res.json()) as { push?: { sent: number; ok: number }; error?: string } }
  }

  it('alone is reported as one failed send, not as nobody to alert and not as an error', async () => {
    r = await startRealRelay()
    r.runtime.store.putSub(sub(EP_A))
    r.relay.services.db.prepare("update core_push_subs set sub = x'00'").run()
    const got = await press(r)
    expect(got.status).toBe(200)
    expect(got.body.push).toEqual({ sent: 1, ok: 0 })
  })

  it('beside a good one still reaches the good one and counts both', async () => {
    r = await startRealRelay()
    r.runtime.store.putSub(sub(EP_A))
    r.runtime.store.putSub(sub(EP_B))
    r.relay.services.db.prepare("update core_push_subs set sub = x'00' where endpoint = ?").run(EP_A)
    const got = await press(r)
    expect(got.status).toBe(200)
    expect(got.body.push).toEqual({ sent: 2, ok: 1 })
    expect(r.transport.sent.map((s) => s.endpoint)).toEqual([EP_B])
  })

  it('with no rows at all is still nobody to alert', async () => {
    r = await startRealRelay()
    const got = await press(r)
    expect(got.status).toBe(409)
    expect(got.body.error).toBe('no_alert_path')
  })
})

describe('a web push subscription belongs to the device that made it', () => {
  it('revoking the device in the app ends its browser push and leaves the other phone alone', async () => {
    r = await startRealRelay()
    const a = await r.owner()
    const b = await r.owner()
    await subscribe(r, a, EP_A)
    await subscribe(r, b, EP_B)
    expect((await stepupRevoke(r, b, a)).status).toBe(204)
    expect(endpoints(r)).toEqual([EP_B])
    await r.runtime.push.notify({ template: 'reply', thread_id: 'general' })
    expect(r.transport.sent.map((s) => s.endpoint)).toEqual([EP_B])
  })

  it('revoking from the Mac CLI ends it too', async () => {
    r = await startRealRelay()
    const a = await r.owner()
    const b = await r.owner()
    await subscribe(r, a, EP_A)
    await subscribe(r, b, EP_B)
    expect((await r.bridgePost(`/bridge/devices/${a.device.deviceId}/revoke`, {})).status).toBe(200)
    expect(endpoints(r)).toEqual([EP_B])
  })

  it('a revoked device cannot get its subscription back by subscribing again', async () => {
    r = await startRealRelay()
    const a = await r.owner()
    const b = await r.owner()
    await subscribe(r, a, EP_A)
    expect((await stepupRevoke(r, b, a)).status).toBe(204)
    expect((await r.post('/api/push/subscribe', sub(EP_A), a)).status).toBe(401)
    expect(endpoints(r)).toEqual([])
  })

  it('signing out one device drops only its subscription', async () => {
    r = await startRealRelay()
    const a = await r.owner()
    const b = await r.owner()
    await subscribe(r, a, EP_A)
    await subscribe(r, b, EP_B)
    expect((await r.post('/api/auth/logout', {}, a)).status).toBe(204)
    expect(endpoints(r)).toEqual([EP_B])
  })

  it("subscribing the same endpoint from another device moves it, so the old device's revoke no longer ends it", async () => {
    r = await startRealRelay()
    const a = await r.owner()
    const b = await r.owner()
    const c = await r.owner()
    await subscribe(r, a, EP_A)
    await subscribe(r, b, EP_A)
    expect((await stepupRevoke(r, c, a)).status).toBe(204)
    expect(endpoints(r)).toEqual([EP_A])
    expect((await stepupRevoke(r, c, b)).status).toBe(204)
    expect(endpoints(r)).toEqual([])
  })

  it('a subscribe whose body is still arriving when its device is revoked stores nothing', async () => {
    r = await startRealRelay()
    const a = await r.owner()
    const b = await r.owner()
    const body = JSON.stringify(sub(EP_A))
    let finish: () => void = () => {}
    const held = new ReadableStream<Uint8Array>({
      start(ctrl) {
        ctrl.enqueue(new TextEncoder().encode(body.slice(0, 10)))
        finish = () => {
          ctrl.enqueue(new TextEncoder().encode(body.slice(10)))
          ctrl.close()
        }
      },
    })
    const pending = fetch(`${r.httpBase}/api/push/subscribe`, {
      method: 'POST',
      headers: {
        Origin: 'https://relay.example.com',
        'X-Talos-CSRF': '1',
        'content-type': 'application/json',
        Cookie: a.cookie,
      },
      body: held,
      duplex: 'half',
    } as RequestInit)
    // A round trip on another connection: by the time it answers, the server has seen the held request's headers and
    // run its session check, and is waiting on the body.
    expect((await fetch(`${r.httpBase}/api/push/apns`, { headers: { Cookie: a.cookie } })).status).toBe(200)
    expect((await stepupRevoke(r, b, a)).status).toBe(204)
    finish()
    expect((await pending).status).toBe(401)
    expect(endpoints(r)).toEqual([])
  })

  it('a subscription from before devices were recorded is not lost, and logout-all still clears it', async () => {
    r = await startRealRelay()
    const a = await r.owner()
    r.runtime.store.putSub(sub(EP_A)) // no device: what an older relay stored
    expect(endpoints(r)).toEqual([EP_A])
    expect((await r.post('/api/auth/logout-all', {}, a)).status).toBe(204)
    expect(endpoints(r)).toEqual([])
  })
})

describe('a web push subscription of a device that is not pinned', () => {
  it('gets no push after the Mac declined the device, and gets it again once pinned', async () => {
    r = await startRealRelay()
    const a = await r.owner()
    const b = await r.owner()
    await subscribe(r, a, EP_A)
    await subscribe(r, b, EP_B)
    r.auth.core.declineDevice(a.device.deviceId)
    expect(endpoints(r)).toEqual([EP_B])
    await r.runtime.push.notify({ template: 'reply', thread_id: 'general' })
    expect(r.transport.sent.map((s) => s.endpoint)).toEqual([EP_B])
    r.auth.core.setPinned(a.device.deviceId, true)
    expect(endpoints(r).sort()).toEqual([EP_A, EP_B])
  })
})
