// Second round of push regression tests. Each test pins a bug that was found and fixed, unless its name says "control". Real http2, real CorePush, a real
// TCP proxy where the network is the point. A test goes green when the bug is fixed, not when the assertion is relaxed.
import { type AddressInfo, connect, createServer, type Server, type Socket } from 'node:net'
import { type AgentConfigT, createDeviceKey } from '@talos-app/protocol'
import { fakeClock } from '@talos-app/testkit'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_AGENT_CONFIG } from '../../src/core/default-config.ts'
import { CorePush, NoopTransport } from '../../src/core/push.ts'
import { type ApnsSender, createApnsSender } from '../../src/core/push-apns.ts'
import type { Logger } from '../../src/services.ts'
import { startTestRelay } from '../core/harness.ts'
import { type FakeApns, startFakeApns, testKey } from '../helpers/fake-apns.ts'

vi.setConfig({ testTimeout: 30_000 })

const TOKEN = 'a'.repeat(64)
const CARD = 'c_01JBF3V7Q8K2M4N6P8R0S2T4V6'
const key = testKey()
const APNS = { keyId: 'KEYID12345', teamId: 'TEAMID1234', keyP8: key.p8, bundleId: 'com.example.talos' }
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
  vi.restoreAllMocks()
  for (const c of cleanups.splice(0).reverse()) await c()
})

// What the Settings and ThreadEditor "new thread" path produces (apps/web/src/features/agent-config/patch.ts, newThread):
// kind 'fixed', with the id slugified from the name the owner typed.
const OWNER_THREAD = {
  id: 'severance_talks_with_bob',
  name: 'Severance talks with Bob',
  icon: '💬',
  kind: 'fixed',
  order: 2,
  notify: 'all',
  voice_context: 'recent',
  archived: false,
  created_at: '2026-10-28T00:00:00.000Z',
} as const

/** Real relay store, real CorePush, real sender, the fake Apple. Rules are skipped (`force`): only the payload is on trial. */
async function pipeline(mode: 'fixed_only' | 'none' | 'all') {
  const fake = await startFakeApns(key.publicKey)
  cleanups.push(() => fake.close())
  const clock = fakeClock(new Date().toISOString())
  const r = await startTestRelay({ clock, log: silent, env: {} })
  cleanups.push(() => r.stop())
  const dev = await createDeviceKey()
  r.relay.services.db
    .prepare(
      'insert into auth_devices (id, name, pubkey_jwk, binding, pinned, revoked, created_at) values (?, ?, ?, ?, 1, 0, ?)',
    )
    .run(dev.deviceId, 'phone', JSON.stringify(dev.publicJwk), 'b', Date.now())
  r.runtime.store.putPushDevice({ deviceId: dev.deviceId, token: TOKEN, env: 'sandbox' })
  const sender = createApnsSender({ config: APNS, clock, log: silent, authority: () => fake.url }) as ApnsSender
  cleanups.push(() => sender.close())
  const cfg = {
    ...DEFAULT_AGENT_CONFIG,
    notifications: { ...DEFAULT_AGENT_CONFIG.notifications, show_thread_names: mode },
    threads: [...DEFAULT_AGENT_CONFIG.threads, OWNER_THREAD],
  } as AgentConfigT
  const push = new CorePush({
    store: r.runtime.store,
    clock,
    log: silent,
    transport: new NoopTransport(),
    config: () => cfg,
    anyVisible: () => false,
    apns: sender,
  })
  return { fake, push }
}

const sentToApple = (fake: FakeApns) => {
  const req = fake.requests[0]
  if (!req) throw new Error('nothing reached the fake APNs')
  return req
}

describe('I5-R3 Show thread names: Never', () => {
  it('R3 a reply in an owner-made thread sends Apple no part of the thread name or slug', async () => {
    const { fake, push } = await pipeline('none')
    await push.notify({ template: 'reply', thread_id: OWNER_THREAD.id }, { force: true })
    const req = sentToApple(fake)
    expect(req.body).toMatchObject({ aps: { alert: { body: 'New reply in a thread' } } })
    expect(req.rawBody).not.toMatch(/severance/i)
    expect(req.collapseId ?? '').not.toMatch(/severance/i)
  })

  it('R3 a card in an owner-made thread still opens the card, with no slug beside its id', async () => {
    const { fake, push } = await pipeline('none')
    await push.notify({ template: 'needs_you', thread_id: OWNER_THREAD.id, card_id: CARD }, { force: true })
    const req = sentToApple(fake)
    expect(req.rawBody).toContain(CARD)
    expect(req.rawBody).not.toMatch(/severance/i)
    expect(req.collapseId ?? '').not.toMatch(/severance/i)
  })
})

describe('I5-R4 default settings (fixed_only) on the plaintext path', () => {
  it('R4 an owner-made thread name and slug do not reach Apple', async () => {
    const { fake, push } = await pipeline('fixed_only')
    await push.notify({ template: 'reply', thread_id: OWNER_THREAD.id }, { force: true })
    const req = sentToApple(fake)
    // docs/SECURITY.md: "A push never contains ... a subject. The same holds for native iPhone push".
    expect(req.rawBody).not.toMatch(/severance/i)
    expect(req.collapseId ?? '').not.toMatch(/severance/i)
  })

  it('control: the built-in General thread keeps its name and its deep link', async () => {
    const { fake, push } = await pipeline('fixed_only')
    await push.notify({ template: 'reply', thread_id: 'general' }, { force: true })
    const req = sentToApple(fake)
    expect(req.body).toMatchObject({ aps: { alert: { body: 'New reply in General' } } })
    expect(req.rawBody).toContain('/t/general')
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

const reply = {
  web_push: 8030,
  notification: { title: 'Talos', body: 'New reply in a thread', navigate: '/', silent: false },
  talos: { v: 1, kind: 'reply' },
} as const
const dev = { token: TOKEN, env: 'sandbox' } as const
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

describe('I5-R5 sends that share a connection', () => {
  it('R5 two sends on a silently dead idle connection both arrive', async () => {
    const fake = await startFakeApns(key.publicKey)
    cleanups.push(() => fake.close())
    const p = await proxy(fake.url)
    cleanups.push(() => p.close())
    // Default timeouts on purpose: the only real wait is the 3 s PING, so nothing here is tight under load.
    const sender = createApnsSender({
      config: APNS,
      clock: fakeClock(),
      log: silent,
      authority: () => p.url,
    }) as ApnsSender
    cleanups.push(() => sender.close())
    expect((await sender.send(dev, reply)).ok).toBe(true)
    p.blackhole()
    // Past the 30 s idle check without sitting through it. Only the sender's idle arithmetic reads this.
    const now = Date.now
    vi.spyOn(Date, 'now').mockImplementation(() => now() + 31_000)
    // hub.ts sends one notify per frame, so one phone is enough: two pushes inside the 3 s PING window.
    const results = await Promise.all([sender.send(dev, reply), sender.send(dev, reply)])
    expect(results.map((r) => r.ok)).toEqual([true, true])
    expect(fake.requests).toHaveLength(3)
  })

  it('R5 a stuck request on a draining connection does not destroy its replacement', async () => {
    const fake = await startFakeApns(key.publicKey)
    cleanups.push(() => fake.close())
    const sender = createApnsSender({
      config: APNS,
      clock: fakeClock(),
      log: silent,
      authority: () => fake.url,
      timeoutMs: 3_000,
    }) as ApnsSender
    cleanups.push(() => sender.close())
    const stuck = 'b'.repeat(64)
    fake.reply(stuck, 'hang')
    const first = sender.send({ token: stuck, env: 'sandbox' }, reply) // its 3 s timer fires at t=3.0
    await sleep(1_500)
    fake.goaway() // Apple retires connection 1. The stuck request stays on it, new sends go to connection 2.
    await sleep(100)
    fake.replyAll({ status: 200, delayMs: 2_000 }) // answered at t=3.6: 0.6 s after that timer, 1.0 s before its own
    const second = sender.send(dev, reply)
    expect((await first).reason).toBe('Timeout')
    expect(await second).toMatchObject({ ok: true, status: 200 })
    expect(fake.connections).toBe(2)
  })
})
