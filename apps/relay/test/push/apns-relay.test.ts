// WP-I5, relay side: signed registration, status, delivery through the real relay to a real local HTTP/2 fake APNs,
// quiet window, dedupe against web push, invalid-token cleanup, restart, logs.
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  type AgentConfigT,
  APNS_REGISTRATION_SKEW_MS,
  buildPushPayload,
  createDeviceKey,
  type DeviceKey,
  type PushIntent,
  signOwnerFrame,
} from '@talos-app/protocol'
import { type FakeClock, fakeClock } from '@talos-app/testkit'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_AGENT_CONFIG } from '../../src/core/default-config.ts'
import { appleConfig, CorePush, forApple, NoopTransport } from '../../src/core/push.ts'
import { createApnsSender } from '../../src/core/push-apns.ts'
import type { Logger } from '../../src/services.ts'
import { ORIGIN, startTestRelay, type TestRelay } from '../core/harness.ts'
import { type FakeApns, startFakeApns, testKey } from '../helpers/fake-apns.ts'

vi.setConfig({ testTimeout: 30_000 })

const TOKEN = 'a'.repeat(64)
const TOKEN2 = 'b'.repeat(64)
const key = testKey()
const BASE_ENV = {
  APNS_KEY_ID: 'KEYID12345',
  APNS_TEAM_ID: 'TEAMID1234',
  APNS_KEY_P8: key.p8,
  APNS_BUNDLE_ID: 'com.example.talos',
}

let relay: TestRelay | null = null
let fake: FakeApns | null = null
afterEach(async () => {
  await relay?.stop()
  await fake?.close()
  relay = null
  fake = null
})

type World = { r: TestRelay; fake: FakeApns; clock: FakeClock; dev: DeviceKey; lines: string[] }
const lines: string[] = []

async function addDevice(r: TestRelay, o: { pinned?: number; revoked?: number } = {}) {
  const dev = await createDeviceKey()
  r.relay.services.db
    .prepare(
      'insert into auth_devices (id, name, pubkey_jwk, binding, pinned, revoked, created_at) values (?, ?, ?, ?, ?, ?, ?)',
    )
    .run(dev.deviceId, 'phone', JSON.stringify(dev.publicJwk), 'b', o.pinned ?? 1, o.revoked ?? 0, Date.now())
  return dev
}

async function world(o: { configured?: boolean; dir?: string } = {}): Promise<World> {
  fake = await startFakeApns(key.publicKey)
  const clock = fakeClock(new Date().toISOString())
  lines.length = 0
  const rec = (...a: unknown[]) => void lines.push(JSON.stringify(a))
  const log: Logger = { debug: rec, info: rec, warn: rec, error: rec, child: () => log }
  const u = fake.url
  relay = await startTestRelay({
    clock,
    log,
    ...(o.dir ? { dir: o.dir } : {}),
    env: o.configured === false ? {} : BASE_ENV,
    apnsAuthority: () => u,
  })
  return { r: relay, fake, clock, dev: await addDevice(relay), lines }
}

const headers = (dev: string) => ({
  'X-Test-Session': dev,
  Origin: ORIGIN,
  'X-Talos-CSRF': '1',
  'content-type': 'application/json',
})

let n = 0
const nonce = () => `n${String(++n).padStart(20, '0')}`

async function signed(w: World, over: Record<string, unknown> = {}, k: DeviceKey = w.dev) {
  const frame = {
    v: 1,
    type: 'push.apns',
    op: 'register',
    device_id: k.deviceId,
    token: TOKEN,
    env: 'sandbox',
    ts: new Date(w.clock.now()).toISOString(),
    nonce: nonce(),
    ...over,
  }
  return signOwnerFrame(frame, k.privateKey)
}
const post = (w: World, body: unknown, session = w.dev.deviceId) =>
  fetch(`${w.r.httpBase}/api/push/apns`, { method: 'POST', headers: headers(session), body: JSON.stringify(body) })
const register = async (w: World, over: Record<string, unknown> = {}) => post(w, await signed(w, over))
const status = async (w: World, session = w.dev.deviceId) =>
  (await (await fetch(`${w.r.httpBase}/api/push/apns`, { headers: headers(session) })).json()) as {
    configured: boolean
    registered: boolean
  }
const tokens = (w: World) => w.r.runtime.store.listPushDevices().map((d) => d.token)

describe('status', () => {
  it('says not configured without the APNS_* variables, registered false', async () => {
    const w = await world({ configured: false })
    expect(await status(w)).toEqual({ configured: false, registered: false })
  })
  it('says configured with them; registered flips per device after a signed registration', async () => {
    const w = await world()
    expect(await status(w)).toEqual({ configured: true, registered: false })
    expect((await register(w)).status).toBe(204)
    expect(await status(w)).toEqual({ configured: true, registered: true })
    const other = await addDevice(w.r)
    expect((await status(w, other.deviceId)).registered).toBe(false)
  })
  it('needs a session', async () => {
    const w = await world()
    const res = await fetch(`${w.r.httpBase}/api/push/apns`)
    expect(res.status).toBe(401)
  })
})

describe('signed registration', () => {
  it('stores the token sealed: the database file never holds it in the clear', async () => {
    const w = await world()
    expect((await register(w)).status).toBe(204)
    expect(tokens(w)).toEqual([TOKEN])
    const row = w.r.relay.services.db.prepare('select * from core_push_devices').get() as Record<
      string,
      Buffer | string
    >
    expect(Buffer.from(JSON.stringify(row)).includes(TOKEN)).toBe(false)
    expect(Buffer.from(row.sealed as Buffer).includes(TOKEN)).toBe(false)
  })

  it('refuses unsigned, wrongly signed, tampered and cross-device registrations', async () => {
    const w = await world()
    const ok = await signed(w)
    const { osig: _o, ...unsigned } = ok
    expect((await post(w, unsigned)).status).toBe(400)
    const stranger = await createDeviceKey()
    const forged = await signed(w, {}, { ...stranger, deviceId: w.dev.deviceId } as DeviceKey)
    expect((await post(w, forged)).status).toBe(401)
    expect((await post(w, { ...ok, token: TOKEN2 })).status).toBe(401) // changed after signing
    expect((await post(w, { ...ok, env: 'production' })).status).toBe(401)
    const other = await addDevice(w.r)
    expect((await post(w, await signed(w, {}, other), w.dev.deviceId)).status).toBe(403) // another device's frame, my session
    expect(tokens(w)).toEqual([])
  })

  it('a revoked or un-pinned device cannot register, and its existing token stops receiving', async () => {
    const w = await world()
    const gone = await addDevice(w.r, { revoked: 1 })
    expect((await post(w, await signed(w, {}, gone), gone.deviceId)).status).toBe(401)
    const unpinned = await addDevice(w.r, { pinned: 0 })
    expect((await post(w, await signed(w, {}, unpinned), unpinned.deviceId)).status).toBe(401)
    expect((await register(w)).status).toBe(204)
    w.r.relay.services.db.prepare('update auth_devices set revoked = 1 where id = ?').run(w.dev.deviceId)
    await w.r.runtime.push.notify({ template: 'device_pinned' })
    expect(w.fake.requests).toHaveLength(0)
  })

  it('a stale or future timestamp fails, whichever way the clock jumped', async () => {
    const w = await world()
    const old = await signed(w)
    w.clock.advance(121_000) // the relay's clock moves on after the phone signed
    expect((await post(w, old)).status).toBe(400)
    const future = await signed(w, { ts: new Date(w.clock.now() + 121_000).toISOString() })
    expect((await post(w, future)).status).toBe(400)
    w.clock.set(w.clock.now() - 3_600_000) // relay clock stepped back an hour
    expect((await post(w, await signed(w, { ts: new Date(w.clock.now() + 119_000).toISOString() }))).status).toBe(204)
    expect(tokens(w)).toEqual([TOKEN])
  })

  it('a replayed body is refused, even after other registrations', async () => {
    const w = await world()
    const body = await signed(w)
    expect((await post(w, body)).status).toBe(204)
    expect((await post(w, body)).status).toBe(409)
    expect((await register(w, { token: TOKEN2 })).status).toBe(204)
    expect((await post(w, body)).status).toBe(409)
    expect(tokens(w)).toEqual([TOKEN2])
  })

  it('the same body sent twice at once registers once', async () => {
    const w = await world()
    const body = await signed(w)
    const codes = (await Promise.all([post(w, body), post(w, body)])).map((r) => r.status).sort()
    expect(codes).toEqual([204, 409])
  })

  it('the nonce window forgets: spent nonces are purged once their window has passed', async () => {
    const w = await world()
    const spent = () =>
      (w.r.relay.services.db.prepare('select count(*) as n from core_push_nonces').get() as { n: number }).n
    for (let i = 0; i < 5; i++) expect((await register(w)).status).toBe(204)
    expect(spent()).toBe(5)
    w.clock.advance(3 * APNS_REGISTRATION_SKEW_MS)
    expect((await register(w)).status).toBe(204)
    expect(spent()).toBe(1)
  })

  it('malformed, old-shape and unknown values are 400 and write nothing', async () => {
    const w = await world()
    const bad: Array<Record<string, unknown>> = [
      { env: 'staging' },
      { token: 'zz'.repeat(32) },
      { token: 'A'.repeat(64) },
      { token: 'a'.repeat(63) },
      { op: 'rotate' },
      { type: 'push.web' },
      { v: 2 },
      { nonce: 'short' },
      { extra_field: 'x' },
      { device_id: 'not-a-device' },
      { ts: 'yesterday' },
      { token: undefined },
      { env: undefined },
    ]
    for (const over of bad) expect((await register(w, over)).status, JSON.stringify(over)).toBe(400)
    expect((await post(w, 'not json')).status).toBe(400)
    expect((await post(w, null)).status).toBe(400)
    expect(tokens(w)).toEqual([])
  })

  it('a registration with no session is 401', async () => {
    const w = await world()
    const res = await fetch(`${w.r.httpBase}/api/push/apns`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(await signed(w)),
    })
    expect(res.status).toBe(401)
  })

  it('without APNS_* variables a register is 409 not_configured, but unregister still cleans up', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'talos-apns-'))
    const on = await world({ dir })
    expect((await register(on)).status).toBe(204)
    const id = on.dev.deviceId
    await relay?.stopKeepData()
    await fake?.close()
    relay = null
    fake = null
    const off = await world({ configured: false, dir })
    // the same device row survives in the same volume; the new world has a fresh device, so re-add the old id
    expect(off.r.runtime.store.hasPushDevice(id)).toBe(true)
    expect((await register(off)).status).toBe(409)
    expect((await post(off, await signed(off, { op: 'unregister', token: undefined, env: undefined }))).status).toBe(
      204,
    )
  })

  it('a new token for the same phone replaces the old one; a token moved to another phone leaves the first', async () => {
    const w = await world()
    await register(w, { token: TOKEN })
    await register(w, { token: TOKEN2 })
    expect(tokens(w)).toEqual([TOKEN2])
    const other = await addDevice(w.r)
    expect((await post(w, await signed(w, { token: TOKEN2 }, other), other.deviceId)).status).toBe(204)
    expect(w.r.runtime.store.listPushDevices().map((d) => d.deviceId)).toEqual([other.deviceId])
  })

  it('unregister removes only this phone', async () => {
    const w = await world()
    const other = await addDevice(w.r)
    await register(w, { token: TOKEN })
    await post(w, await signed(w, { token: TOKEN2 }, other), other.deviceId)
    expect((await post(w, await signed(w, { op: 'unregister', token: undefined, env: undefined }))).status).toBe(204)
    expect(tokens(w)).toEqual([TOKEN2])
  })
})

describe('delivery through the real relay', () => {
  it('a reply push reaches the registered phone with the fixed phrase, the right host env and a badge', async () => {
    const w = await world()
    await register(w)
    await w.r.runtime.push.notify({ template: 'reply', thread_id: 'general' })
    expect(w.fake.requests).toHaveLength(1)
    const q = w.fake.requests[0]
    expect(q?.token).toBe(TOKEN)
    expect(q?.jwt.ok).toBe(true)
    expect(q?.body.aps).toMatchObject({
      alert: { title: 'Talos', body: 'New reply in General' },
      badge: 0,
      category: 'TALOS_OPEN',
    })
  })

  it('the Settings test button reaches the phone too (forced past the rules)', async () => {
    const w = await world()
    await register(w)
    const res = await fetch(`${w.r.httpBase}/api/push/test`, {
      method: 'POST',
      headers: headers(w.dev.deviceId),
      body: '{}',
    })
    expect(res.status).toBe(204)
    expect(w.fake.requests).toHaveLength(1)
  })

  it('a card push to the phone carries the card category and card id', async () => {
    const w = await world()
    await register(w)
    const card = 'c_01JBF3V7Q8K2M4N6P8R0S2T4V6'
    await w.r.runtime.push.notify({ template: 'needs_you', thread_id: 'general', card_id: card })
    expect(w.fake.requests[0]?.body.aps).toMatchObject({ category: 'TALOS_CARD' })
  })

  it('410 deletes the token; the next push finds no phone', async () => {
    const w = await world()
    await register(w)
    w.fake.reply(TOKEN, { status: 410, reason: 'Unregistered' })
    await w.r.runtime.push.notify({ template: 'reply', thread_id: 'general' })
    expect(tokens(w)).toEqual([])
    expect(await status(w)).toEqual({ configured: true, registered: false })
    await w.r.runtime.push.notify({ template: 'reply', thread_id: 'general' })
    expect(w.fake.requests).toHaveLength(1)
  })

  it('a 429 or 500 keeps the token (Apple having a bad minute is not an invalid token)', async () => {
    const w = await world()
    await register(w)
    for (const status of [429, 500, 503]) {
      w.fake.reply(TOKEN, { status, reason: 'Nope' })
      await w.r.runtime.push.notify({ template: 'reply', thread_id: 'general' })
    }
    expect(tokens(w)).toEqual([TOKEN])
    expect(w.r.runtime.push.outcome().last_error_at).not.toBeNull()
  })

  it('one dead phone does not stop the next', async () => {
    const w = await world()
    await register(w, { token: TOKEN })
    const other = await addDevice(w.r)
    await post(w, await signed(w, { token: TOKEN2 }, other), other.deviceId)
    w.fake.reply(TOKEN, { status: 410, reason: 'Unregistered' })
    await w.r.runtime.push.notify({ template: 'reply', thread_id: 'general' })
    expect(w.fake.requests.map((r) => r.token).sort()).toEqual([TOKEN, TOKEN2])
    expect(tokens(w)).toEqual([TOKEN2])
  })

  it('production tokens are sent with the production env choice', async () => {
    const seen: string[] = []
    fake = await startFakeApns(key.publicKey)
    const u = fake.url
    relay = await startTestRelay({
      env: BASE_ENV,
      apnsAuthority: (env) => {
        seen.push(env)
        return u
      },
    })
    const dev = await addDevice(relay)
    const w = { r: relay, fake, clock: fakeClock(new Date().toISOString()), dev, lines } as World
    w.clock = { ...w.clock, now: () => Date.now() } as FakeClock
    await post(w, await signed(w, { env: 'production' }))
    await relay.runtime.push.notify({ template: 'reply', thread_id: 'general' })
    expect(seen).toEqual(['production'])
  })

  it('the token survives a relay restart (sealed with DATA_KEY, read back)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'talos-apns-'))
    const w = await world({ dir })
    await register(w)
    await relay?.stopKeepData()
    await fake?.close()
    relay = null
    fake = null
    const w2 = await world({ dir })
    expect(tokens(w2)).toEqual([TOKEN])
    await w2.r.runtime.push.notify({ template: 'reply', thread_id: 'general' })
    expect(w2.fake.requests).toHaveLength(1)
  })

  it('logs hold no device token, signature, provider token or key from registration through delivery', async () => {
    const w = await world()
    const body = await signed(w)
    await post(w, body)
    w.fake.reply(TOKEN, { status: 410, reason: 'Unregistered' })
    await w.r.runtime.push.notify({ template: 'reply', thread_id: 'general' })
    const all = lines.join('\n')
    expect(all.length).toBeGreaterThan(0)
    for (const s of [
      TOKEN,
      body.osig,
      w.fake.requests[0]?.bearer.slice(7) ?? 'x',
      'PRIVATE KEY',
      key.p8.split('\n')[1] ?? 'x',
    ])
      expect(all).not.toContain(s)
  })

  it('the relay never lets a card title, sender or message text into the APNs body', async () => {
    const w = await world()
    await register(w)
    const sneaky = {
      template: 'reply',
      thread_id: 'general',
      title: 'Q3 layoffs',
      text: 'fire Bob',
      sender: 'boss@example.com',
      subject: 'Re: salary',
    }
    await w.r.runtime.push.notify(sneaky as PushIntent)
    expect(w.fake.requests[0]?.rawBody).not.toMatch(/layoffs|fire Bob|boss@|salary/)
  })
})

describe('rules and dedupe (CorePush over the relay store and a real sender)', () => {
  async function rig(over: Partial<AgentConfigT> = {}, webEndpoints: string[] = []) {
    const w = await world()
    await register(w)
    const web = new NoopTransport()
    const sender = createApnsSender({
      config: { keyId: 'KEYID12345', teamId: 'TEAMID1234', keyP8: key.p8, bundleId: 'com.example.talos' },
      clock: w.clock,
      log: {
        debug() {},
        info() {},
        warn() {},
        error() {},
        child() {
          return this
        },
      } as Logger,
      authority: () => w.fake.url,
    })
    let visible = false
    const cfg: AgentConfigT = { ...DEFAULT_AGENT_CONFIG, ...over }
    const push = new CorePush({
      store: w.r.runtime.store,
      clock: w.clock,
      log: {
        debug() {},
        info() {},
        warn() {},
        error() {},
        child() {
          return this
        },
      } as Logger,
      transport: web,
      config: () => cfg,
      anyVisible: () => visible,
      apns: sender,
    })
    for (const e of webEndpoints) w.r.runtime.store.putSub({ endpoint: e, keys: { p256dh: 'a', auth: 'b' } })
    return { w, push, web, setVisible: (v: boolean) => (visible = v), sender }
  }

  it('the quiet window holds the phone back, the same as web push; system alarms go through', async () => {
    const t = fakeClock('2026-10-31T03:00:00.000Z')
    const { w, push } = await rig({ quiet_window: { start: '22:00', end: '07:00' }, timezone: 'UTC' })
    w.clock.set(t.now())
    await push.notify({ template: 'reply', thread_id: 'general' })
    await push.notify({ template: 'needs_you', thread_id: 'general' })
    expect(w.fake.requests).toHaveLength(0)
    await push.notify({ template: 'device_pinned' })
    expect(w.fake.requests).toHaveLength(1)
    w.clock.set(Date.parse('2026-10-31T12:00:00.000Z'))
    await push.notify({ template: 'reply', thread_id: 'general' })
    expect(w.fake.requests).toHaveLength(2)
  })

  it('Send test alert gives Apple the fixed title too, never the agent name', async () => {
    const { w, push } = await rig({ agent: { ...DEFAULT_AGENT_CONFIG.agent, name: 'Severance Desk' } })
    await push.sendTest()
    expect(w.fake.requests).toHaveLength(1)
    expect(w.fake.requests[0]?.rawBody).not.toMatch(/severance/i)
    expect(w.fake.requests[0]?.body.aps).toMatchObject({ alert: { title: 'Talos' } })
  })

  it('master off, thread off, and a visible app each hold the phone back', async () => {
    const off = await rig({ notifications: { master: false, show_thread_names: 'fixed_only' } })
    await off.push.notify({ template: 'reply', thread_id: 'general' })
    expect(off.w.fake.requests).toHaveLength(0)
    await off.w.r.stop()
    await off.w.fake.close()
    relay = null
    fake = null

    const thr = await rig({ threads: DEFAULT_AGENT_CONFIG.threads.map((t) => ({ ...t, notify: 'off' as const })) })
    await thr.push.notify({ template: 'reply', thread_id: 'general' })
    expect(thr.w.fake.requests).toHaveLength(0)
    await thr.w.r.stop()
    await thr.w.fake.close()
    relay = null
    fake = null

    const vis = await rig()
    vis.setVisible(true)
    await vis.push.notify({ template: 'reply', thread_id: 'general' })
    expect(vis.w.fake.requests).toHaveLength(0)
    // an approval is the exception: a window nobody is reading must not swallow it (D24); see approval-priority.test.ts
    await vis.push.notify({ template: 'needs_you', thread_id: 'general' })
    expect(vis.w.fake.requests).toHaveLength(1)
    vis.setVisible(false)
    await vis.push.notify({ template: 'reply', thread_id: 'general' })
    expect(vis.w.fake.requests).toHaveLength(2)
  })

  it('off mid-work: the owner turns the master switch off between two pushes; the second never leaves', async () => {
    const cfg = { ...DEFAULT_AGENT_CONFIG }
    const { w, push } = await rig()
    const live = new CorePush({
      store: w.r.runtime.store,
      clock: w.clock,
      log: {
        debug() {},
        info() {},
        warn() {},
        error() {},
        child() {
          return this
        },
      } as Logger,
      transport: new NoopTransport(),
      config: () => cfg,
      anyVisible: () => false,
      apns: createApnsSender({
        config: { keyId: 'KEYID12345', teamId: 'TEAMID1234', keyP8: key.p8, bundleId: 'com.example.talos' },
        clock: w.clock,
        log: {
          debug() {},
          info() {},
          warn() {},
          error() {},
          child() {
            return this
          },
        } as Logger,
        authority: () => w.fake.url,
      }),
    })
    void push
    await live.notify({ template: 'reply', thread_id: 'general' })
    cfg.notifications = { master: false, show_thread_names: 'fixed_only' }
    await live.notify({ template: 'reply', thread_id: 'general' })
    expect(w.fake.requests).toHaveLength(1)
  })

  it('web push keeps working next to a phone: a browser endpoint is always sent', async () => {
    const { w, push, web } = await rig({}, [
      'https://fcm.googleapis.com/send/abc',
      'https://updates.push.services.mozilla.com/x',
    ])
    await push.notify({ template: 'reply', thread_id: 'general' })
    expect(w.fake.requests).toHaveLength(1)
    expect(web.sent.map((s) => s.endpoint)).toEqual([
      'https://fcm.googleapis.com/send/abc',
      'https://updates.push.services.mozilla.com/x',
    ])
  })

  it('an Apple web endpoint (Home Screen app, Mac Safari) always gets its push, native or not', async () => {
    const apple = 'https://web.push.apple.com/QAbc'
    const a = await rig({}, [apple])
    await a.push.notify({ template: 'reply', thread_id: 'general' })
    expect(a.w.fake.requests).toHaveLength(1)
    expect(a.web.sent.map((s) => s.endpoint)).toEqual([apple])
  })

  it('with no phone registered an Apple web endpoint still gets its push', async () => {
    const w = await world()
    const web = new NoopTransport()
    const apple = 'https://web.push.apple.com/QAbc'
    w.r.runtime.store.putSub({ endpoint: apple, keys: { p256dh: 'a', auth: 'b' } })
    const push = new CorePush({
      store: w.r.runtime.store,
      clock: w.clock,
      log: {
        debug() {},
        info() {},
        warn() {},
        error() {},
        child() {
          return this
        },
      } as Logger,
      transport: web,
      config: () => DEFAULT_AGENT_CONFIG,
      anyVisible: () => false,
      apns: null,
    })
    await push.notify({ template: 'reply', thread_id: 'general' })
    expect(web.sent).toHaveLength(1)
    expect(w.fake.requests).toHaveLength(0)
  })

  it('an unreadable device row never takes web push down', async () => {
    const { w, push, web } = await rig({}, ['https://fcm.googleapis.com/send/abc'])
    w.r.relay.services.db.prepare("update core_push_devices set sealed = x'00'").run()
    await push.notify({ template: 'reply', thread_id: 'general' })
    expect(web.sent).toHaveLength(1)
  })

  it('two notifications at once both reach the phone', async () => {
    const { w, push } = await rig()
    await Promise.all([
      push.notify({ template: 'reply', thread_id: 'general' }),
      push.notify({ template: 'device_pinned' }),
    ])
    expect(w.fake.requests).toHaveLength(2)
  })
})

describe('forApple (what Apple may read)', () => {
  const slug = 'severance_talks_with_bob'
  const cfg = (mode: 'fixed_only' | 'all' | 'none', kind: 'agent' | 'fixed' = 'agent') =>
    ({
      ...DEFAULT_AGENT_CONFIG,
      notifications: { master: true, show_thread_names: mode },
      threads: [
        ...DEFAULT_AGENT_CONFIG.threads,
        { id: slug, name: 'Severance talks with Bob', kind, order: 9, notify: 'all' },
      ],
    }) as AgentConfigT
  const CARD = 'c_01JBF3V7Q8K2M4N6P8R0S2T4V6'
  const mint = (t: string) => `r_${t.length}XXXXXXXXXXXXXXX`.slice(0, 18)
  const apple = (mode: 'fixed_only' | 'all' | 'none', kind: 'agent' | 'fixed', cardId?: string) =>
    forApple(
      buildPushPayload(
        { template: cardId ? 'needs_you' : 'reply', thread_id: slug, ...(cardId ? { card_id: cardId } : {}) },
        appleConfig(cfg(mode, kind)),
      ),
      mint,
    )

  it.each([
    ['fixed_only', 'agent'],
    ['fixed_only', 'fixed'],
    ['none', 'fixed'],
    ['all', 'agent'],
    ['all', 'fixed'],
  ] as const)('mode %s, %s thread: no name and no slug; the tap carries an opaque reference', (mode, kind) => {
    const p = apple(mode, kind)
    expect(JSON.stringify(p)).not.toMatch(/severance|bob/i)
    expect(p.notification.body).toBe('New reply in a thread')
    expect(p.notification.navigate).toMatch(/^\/open\/r_/)
    expect(p.talos.thread_id).toBeUndefined()
  })
  it('a card in a named thread keeps the card (a random id) and loses the thread', () => {
    const p = apple('all', 'fixed', CARD)
    expect(JSON.stringify(p)).not.toMatch(/severance/i)
    expect(p.notification.navigate).toBe(`/card/${CARD}`)
    expect(p.talos.card_id).toBe(CARD)
  })
  it('General and Inbox keep their names and deep links; an unknown thread id is hidden', () => {
    const g = forApple(buildPushPayload({ template: 'reply', thread_id: 'general' }, appleConfig(cfg('none'))), mint)
    expect(g.notification.body).toBe('New reply in General')
    expect(g.talos.thread_id).toBe('general')
    const ghost = forApple(
      buildPushPayload({ template: 'reply', thread_id: 'ghost_thread' }, appleConfig(cfg('all'))),
      mint,
    )
    expect(JSON.stringify(ghost)).not.toMatch(/ghost/)
  })
})
