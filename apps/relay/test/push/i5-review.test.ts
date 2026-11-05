// Push regression tests. Each one pins a confirmed bug that was found and fixed. Real http2, real relay, a real TCP proxy where the
// network is the point. A test goes green when the bug is fixed, not when the assertion is relaxed.
import { mkdtempSync } from 'node:fs'
import { type AddressInfo, connect, createServer, type Server, type Socket } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { type AgentConfigT, createDeviceKey, type DeviceKey, signOwnerFrame } from '@talos-app/protocol'
import { type FakeClock, fakeClock } from '@talos-app/testkit'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_AGENT_CONFIG } from '../../src/core/default-config.ts'
import { CorePush, NoopTransport } from '../../src/core/push.ts'
import { type ApnsSender, createApnsSender } from '../../src/core/push-apns.ts'
import type { Logger } from '../../src/services.ts'
import { ORIGIN, startTestRelay, type TestRelay } from '../core/harness.ts'
import { type FakeApns, startFakeApns, testKey } from '../helpers/fake-apns.ts'
import { type RealRelay, startRealRelay } from '../review/real-relay.ts'

vi.setConfig({ testTimeout: 30_000 })

const TOKEN = 'a'.repeat(64)
const key = testKey()
const BASE_ENV = {
  APNS_KEY_ID: 'KEYID12345',
  APNS_TEAM_ID: 'TEAMID1234',
  APNS_KEY_P8: key.p8,
  APNS_BUNDLE_ID: 'com.example.talos',
}
const silent = {
  debug() {},
  info() {},
  warn() {},
  error() {},
  child() {
    return this
  },
} as Logger

const cleanups: Array<() => unknown> = []
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c()
})

type World = { r: TestRelay; fake: FakeApns; clock: FakeClock; dev: DeviceKey }

async function addDevice(r: TestRelay) {
  const dev = await createDeviceKey()
  r.relay.services.db
    .prepare(
      'insert into auth_devices (id, name, pubkey_jwk, binding, pinned, revoked, created_at) values (?, ?, ?, ?, 1, 0, ?)',
    )
    .run(dev.deviceId, 'phone', JSON.stringify(dev.publicJwk), 'b', Date.now())
  return dev
}

async function world(
  o: { dir?: string; env?: Record<string, string>; authority?: (e: 'sandbox' | 'production') => string } = {},
): Promise<World> {
  const fake = await startFakeApns(key.publicKey)
  cleanups.push(() => fake.close())
  const clock = fakeClock(new Date().toISOString())
  const u = fake.url
  const r = await startTestRelay({
    clock,
    log: silent,
    ...(o.dir ? { dir: o.dir } : {}),
    env: o.env ?? BASE_ENV,
    apnsAuthority: o.authority ?? (() => u),
  })
  cleanups.push(() => r.stop())
  return { r, fake, clock, dev: await addDevice(r) }
}

const headers = (dev: string) => ({
  'X-Test-Session': dev,
  Origin: ORIGIN,
  'X-Talos-CSRF': '1',
  'content-type': 'application/json',
})

let n = 0
const signed = (w: World, over: Record<string, unknown> = {}) =>
  signOwnerFrame(
    {
      v: 1,
      type: 'push.apns',
      op: 'register',
      device_id: w.dev.deviceId,
      token: TOKEN,
      env: 'sandbox',
      ts: new Date(w.clock.now()).toISOString(),
      nonce: `r${String(++n).padStart(20, '0')}`,
      ...over,
    },
    w.dev.privateKey,
  )
const post = (w: World, body: unknown) =>
  fetch(`${w.r.httpBase}/api/push/apns`, {
    method: 'POST',
    headers: headers(w.dev.deviceId),
    body: JSON.stringify(body),
  })
const register = async (w: World, over: Record<string, unknown> = {}) => post(w, await signed(w, over))
const tokens = (w: World) => w.r.runtime.store.listPushDevices().map((d) => d.token)

describe('I5-H1 privacy: the plaintext APNs request', () => {
  it('H1 an agent thread slug (slugified from its name) never reaches Apple under fixed_only', async () => {
    // apps/bridge/src/tools/threads.ts slugifies the id from the name: create_thread({name:'Severance talks with Bob'}).
    const slug = 'severance_talks_with_bob'
    const w = await world()
    await register(w)
    const cfg = {
      ...DEFAULT_AGENT_CONFIG,
      threads: [
        ...DEFAULT_AGENT_CONFIG.threads,
        { id: slug, name: 'Severance talks with Bob', kind: 'agent', order: 9, notify: 'all' },
      ],
    } as AgentConfigT
    const sender = createApnsSender({
      config: { keyId: 'KEYID12345', teamId: 'TEAMID1234', keyP8: key.p8, bundleId: 'com.example.talos' },
      clock: w.clock,
      log: silent,
      authority: () => w.fake.url,
    }) as ApnsSender
    cleanups.push(() => sender.close())
    const push = new CorePush({
      store: w.r.runtime.store,
      clock: w.clock,
      log: silent,
      transport: new NoopTransport(),
      config: () => cfg,
      anyVisible: () => false,
      apns: sender,
    })
    await push.notify({ template: 'reply', thread_id: slug })
    const req = w.fake.requests[0]
    if (!req) throw new Error('nothing reached the fake APNs')
    // The name is hidden on purpose ("agent-created thread names can carry content")...
    expect(req.body).toMatchObject({ aps: { alert: { body: 'New reply in a thread' } } })
    // ...and the same words must not ride along next to it: unlike web push, this body is not encrypted to the device.
    expect(req.rawBody).not.toMatch(/severance/)
    expect(req.collapseId ?? '').not.toMatch(/severance/)
  })
})

describe('I5-H2 inert when any variable is missing', () => {
  const status = async (w: World) =>
    (await (await fetch(`${w.r.httpBase}/api/push/apns`, { headers: headers(w.dev.deviceId) })).json()) as {
      configured: boolean
    }

  it.each([
    ['one of four', { APNS_KEY_ID: 'KEYID12345' }],
    ['three of four', { APNS_KEY_ID: 'KEYID12345', APNS_TEAM_ID: 'TEAMID1234', APNS_BUNDLE_ID: 'com.example.talos' }],
    [
      'the four names in IOS-SPEC 6.4 (APNS_KEY, APNS_TOPIC)',
      {
        APNS_KEY_ID: 'KEYID12345',
        APNS_TEAM_ID: 'TEAMID1234',
        APNS_KEY: key.p8,
        APNS_TOPIC: 'com.example.talos',
      },
    ],
    ['a Key ID with a stray lowercase letter', { ...BASE_ENV, APNS_KEY_ID: 'keyid12345' }],
  ])('H2 %s: the relay still boots and push reads not configured', async (_name, env) => {
    const w = await world({ env: env as Record<string, string> })
    expect((await status(w)).configured).toBe(false)
  })
})

/** A TCP proxy in front of the fake: `blackhole()` silently stops the connections open right now, like a dropped NAT entry. */
async function proxy(target: string) {
  const t = new URL(target)
  const dead = new WeakSet<Socket>()
  const live = new Set<Socket>()
  const server: Server = createServer((c) => {
    const up = connect(Number(t.port), t.hostname)
    live.add(c)
    c.on('error', () => {})
    up.on('error', () => {})
    c.on('data', (d) => {
      if (!dead.has(c)) up.write(d)
    })
    up.on('data', (d) => {
      if (!dead.has(c)) c.write(d)
    })
    c.on('close', () => up.destroy())
    up.on('close', () => c.destroy())
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    blackhole() {
      for (const c of live) dead.add(c)
    },
    close() {
      for (const c of live) c.destroy()
      server.close()
    },
  }
}

describe('I5-H3 a connection that dies silently', () => {
  it('H3 after a timeout the next send opens a new connection instead of reusing the dead one', async () => {
    const fake = await startFakeApns(key.publicKey)
    cleanups.push(() => fake.close())
    const p = await proxy(fake.url)
    cleanups.push(() => p.close())
    const sender = createApnsSender({
      config: { keyId: 'KEYID12345', teamId: 'TEAMID1234', keyP8: key.p8, bundleId: 'com.example.talos' },
      clock: fakeClock(),
      log: silent,
      authority: () => p.url,
    }) as ApnsSender
    cleanups.push(() => sender.close())
    const reply = {
      web_push: 8030,
      notification: { title: 'Talos', body: 'New reply in a thread', navigate: '/', silent: false },
      talos: { v: 1, kind: 'reply' },
    } as const
    const dev = { token: TOKEN, env: 'sandbox' } as const
    expect((await sender.send(dev, reply)).ok).toBe(true)
    p.blackhole() // no FIN, no RST: the socket looks open to Node. New connections through the proxy still work.
    expect((await sender.send(dev, reply, { timeoutMs: 200 })).reason).toBe('Timeout')
    const later = [
      await sender.send(dev, reply, { timeoutMs: 200 }),
      await sender.send(dev, reply, { timeoutMs: 200 }),
      await sender.send(dev, reply, { timeoutMs: 200 }),
    ]
    expect(later.some((r) => r.ok)).toBe(true)
    expect(fake.connections).toBeGreaterThan(1)
  })
})

describe('I5-H4 web push keeps working alongside (IOS-SPEC 6.4)', () => {
  it('H4 a Mac Safari subscription (also web.push.apple.com) still gets the push when the phone got it natively', async () => {
    const w = await world()
    await register(w)
    const mac = await addDevice(w.r)
    const endpoint = 'https://web.push.apple.com/QMacSafari'
    const res = await fetch(`${w.r.httpBase}/api/push/subscribe`, {
      method: 'POST',
      headers: headers(mac.deviceId),
      body: JSON.stringify({ endpoint, keys: { p256dh: 'a', auth: 'b' } }),
    })
    expect(res.status).toBe(204)
    await w.r.runtime.push.notify({ template: 'reply', thread_id: 'general' })
    expect(w.fake.requests).toHaveLength(1)
    expect(w.r.transport.sent.map((s) => s.endpoint)).toEqual([endpoint])
  })
})

describe('I5-M2 cleanup never deletes a token that is good', () => {
  it('M2 a production-flagged token Apple rejects there but sandbox accepts is not deleted', async () => {
    const sandbox = await startFakeApns(key.publicKey)
    cleanups.push(() => sandbox.close())
    const production = await startFakeApns(key.publicKey)
    cleanups.push(() => production.close())
    production.replyAll({ status: 400, reason: 'BadDeviceToken' }) // what Apple answers a sandbox token at the wrong host
    const w = await world({ authority: (env) => (env === 'sandbox' ? sandbox.url : production.url) })
    await register(w, { env: 'production' })
    await w.r.runtime.push.notify({ template: 'reply', thread_id: 'general' })
    expect(tokens(w)).toEqual([TOKEN])
  })

  it('M2 a wrong APNS_BUNDLE_ID (DeviceTokenNotForTopic on every push) does not wipe the phone', async () => {
    const w = await world()
    await register(w)
    w.fake.replyAll({ status: 400, reason: 'DeviceTokenNotForTopic' })
    await w.r.runtime.push.notify({ template: 'reply', thread_id: 'general' })
    expect(tokens(w)).toEqual([TOKEN])
  })
})

describe('I5-M3 signing out reaches the phone', () => {
  let r: RealRelay | null = null
  afterEach(async () => {
    await r?.stop()
    r = null
  })
  it.each([['/api/auth/logout-all'], ['/api/auth/logout']])('M3 %s stops pushes to that phone', async (path) => {
    r = await startRealRelay({ env: BASE_ENV })
    const o = await r.owner()
    r.runtime.store.putPushDevice({ deviceId: o.device.deviceId, token: TOKEN, env: 'sandbox' })
    expect((await r.post(path, {}, o)).status).toBe(204)
    expect(r.runtime.store.listPushDevices()).toEqual([])
  })
  it('M3 logout-all also drops the browser push subscriptions (they are not tied to a session)', async () => {
    r = await startRealRelay({ env: BASE_ENV })
    const o = await r.owner()
    r.runtime.store.putSub({ endpoint: 'https://fcm.googleapis.com/send/abc', keys: { p256dh: 'a', auth: 'b' } })
    expect((await r.post('/api/auth/logout-all', {}, o)).status).toBe(204)
    expect(r.runtime.store.listSubs()).toEqual([])
  })
})

describe('I5-M5 a web push does not wait on Apple', () => {
  it('M5 a browser subscription gets its push while APNs is hanging', async () => {
    const w = await world()
    await register(w)
    w.fake.replyAll('hang')
    const web = new NoopTransport()
    w.r.runtime.store.putSub({ endpoint: 'https://fcm.googleapis.com/send/abc', keys: { p256dh: 'a', auth: 'b' } })
    const sender = createApnsSender({
      config: { keyId: 'KEYID12345', teamId: 'TEAMID1234', keyP8: key.p8, bundleId: 'com.example.talos' },
      clock: w.clock,
      log: silent,
      authority: () => w.fake.url,
      timeoutMs: 3000,
    }) as ApnsSender
    cleanups.push(() => sender.close())
    const push = new CorePush({
      store: w.r.runtime.store,
      clock: w.clock,
      log: silent,
      transport: web,
      config: () => DEFAULT_AGENT_CONFIG,
      anyVisible: () => false,
      apns: sender,
    })
    const done = push.notify({ template: 'reply', thread_id: 'general' })
    await new Promise((res) => setTimeout(res, 500))
    const during = web.sent.length
    await done
    expect(during).toBe(1)
  })
})

describe('I5-L1 replay across a restart', () => {
  it('L1 a captured registration replayed right after a relay restart is refused', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'talos-apns-review-'))
    const fakeA = await startFakeApns(key.publicKey)
    cleanups.push(() => fakeA.close())
    const clock = fakeClock(new Date().toISOString())
    const a = await startTestRelay({ clock, log: silent, dir, env: BASE_ENV, apnsAuthority: () => fakeA.url })
    const dev = await addDevice(a)
    const frame = await signOwnerFrame(
      {
        v: 1,
        type: 'push.apns',
        op: 'unregister',
        device_id: dev.deviceId,
        ts: new Date(clock.now()).toISOString(),
        nonce: 'replayreplayreplay01',
      },
      dev.privateKey,
    )
    const send = (r: TestRelay) =>
      fetch(`${r.httpBase}/api/push/apns`, {
        method: 'POST',
        headers: headers(dev.deviceId),
        body: JSON.stringify(frame),
      })
    expect((await send(a)).status).toBe(204)
    await a.stopKeepData()
    const b = await startTestRelay({ clock, log: silent, dir, env: BASE_ENV, apnsAuthority: () => fakeA.url })
    cleanups.push(() => b.stop())
    expect((await send(b)).status).toBe(409)
  })
})

describe('I5-L2 the Settings test button tells the truth', () => {
  it('L2 POST /api/push/test does not read as sent when Apple refused the only device', async () => {
    const w = await world()
    await register(w)
    w.fake.replyAll({ status: 403, reason: 'InvalidProviderToken' })
    const res = await fetch(`${w.r.httpBase}/api/push/test`, {
      method: 'POST',
      headers: headers(w.dev.deviceId),
      body: '{}',
    })
    expect(w.fake.requests).toHaveLength(1)
    expect(res.status).not.toBe(204)
  })
})
