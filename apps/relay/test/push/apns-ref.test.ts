// WP-I5 re-review R3/R4/R6: the opaque thread reference, and a test button that tells the truth about the phone.
import { createDeviceKey } from '@talos-app/protocol'
import { fakeClock } from '@talos-app/testkit'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ORIGIN, startTestRelay, type TestRelay } from '../core/harness.ts'
import { type FakeApns, startFakeApns, testKey } from '../helpers/fake-apns.ts'

vi.setConfig({ testTimeout: 30_000 })
const key = testKey()
const ENV = {
  APNS_KEY_ID: 'KEYID12345',
  APNS_TEAM_ID: 'TEAMID1234',
  APNS_KEY_P8: key.p8,
  APNS_BUNDLE_ID: 'com.example.talos',
}
const TOKEN = 'a'.repeat(64)
const cleanups: Array<() => unknown> = []
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c()
})
const h = (dev: string) => ({
  'X-Test-Session': dev,
  Origin: ORIGIN,
  'X-Talos-CSRF': '1',
  'content-type': 'application/json',
})

async function world() {
  const fake: FakeApns = await startFakeApns(key.publicKey)
  cleanups.push(() => fake.close())
  const r: TestRelay = await startTestRelay({
    clock: fakeClock(new Date().toISOString()),
    env: ENV,
    apnsAuthority: () => fake.url,
  })
  cleanups.push(() => r.stop())
  const dev = await createDeviceKey()
  r.relay.services.db
    .prepare(
      'insert into auth_devices (id, name, pubkey_jwk, binding, pinned, revoked, created_at) values (?, ?, ?, ?, 1, 0, ?)',
    )
    .run(dev.deviceId, 'phone', JSON.stringify(dev.publicJwk), 'b', Date.now())
  r.runtime.store.putPushDevice({ deviceId: dev.deviceId, token: TOKEN, env: 'sandbox' })
  return { r, fake, dev }
}
const get = (r: TestRelay, path: string, dev?: string) =>
  fetch(`${r.httpBase}${path}`, { headers: dev ? h(dev) : { Origin: ORIGIN } })

describe('opaque thread reference', () => {
  it('is stable per thread, random, and carries nothing of the id', async () => {
    const { r } = await world()
    const a = r.runtime.store.pushRef('severance_talks_with_bob')
    expect(r.runtime.store.pushRef('severance_talks_with_bob')).toBe(a)
    expect(r.runtime.store.pushRef('another')).not.toBe(a)
    expect(a).toMatch(/^r_[A-Za-z0-9_-]{16}$/)
    expect(a).not.toMatch(/severance/)
  })

  it('a push for a named thread opens through the reference, and only a signed-in session can resolve it', async () => {
    const { r, fake, dev } = await world()
    await r.runtime.push.notify({ template: 'reply', thread_id: 'severance_talks_with_bob' }, { force: true })
    const talos = fake.requests[0]?.body.talos as { navigate: string }
    const ref = talos.navigate.replace('/open/', '')
    expect(fake.requests[0]?.rawBody).not.toMatch(/severance/)
    expect(fake.requests[0]?.collapseId).toBe(`thread:${ref}`)
    const ok = await get(r, `/api/push/ref/${ref}`, dev.deviceId)
    expect(ok.status).toBe(200)
    expect(await ok.json()).toEqual({ thread_id: 'severance_talks_with_bob' })
    expect((await get(r, `/api/push/ref/${ref}`)).status).toBe(401)
    expect((await get(r, '/api/push/ref/r_AAAAAAAAAAAAAAAA', dev.deviceId)).status).toBe(404)
    expect((await get(r, '/api/push/ref/severance_talks_with_bob', dev.deviceId)).status).toBe(400)
    expect((await get(r, '/api/push/ref/r_short', dev.deviceId)).status).toBe(400)
  })
})

describe('the iPhone test button (R6)', () => {
  const test = (r: TestRelay, dev: string) =>
    fetch(`${r.httpBase}/api/push/test?via=apns`, { method: 'POST', headers: h(dev), body: '{}' })

  it('is accepted when Apple took it', async () => {
    const { r, dev } = await world()
    expect((await test(r, dev.deviceId)).status).toBe(204)
  })
  it('is NOT sent when Apple refused, even though a browser subscription took the push', async () => {
    const { r, fake, dev } = await world()
    r.runtime.store.putSub({ endpoint: 'https://fcm.googleapis.com/send/abc', keys: { p256dh: 'a', auth: 'b' } })
    fake.replyAll({ status: 403, reason: 'InvalidProviderToken' })
    expect((await test(r, dev.deviceId)).status).toBe(502)
    // the plain route (the browser's own button) still reads the browser's result
    const plain = await fetch(`${r.httpBase}/api/push/test`, { method: 'POST', headers: h(dev.deviceId), body: '{}' })
    expect(plain.status).toBe(204)
  })
  it('says there is no phone when none is registered', async () => {
    const { r, dev } = await world()
    r.runtime.store.deletePushDeviceByDevice(dev.deviceId)
    expect((await test(r, dev.deviceId)).status).toBe(409)
  })
})
