// R2 (D24, D25): an approval ("Needs you") reaches the phone while a desktop window is open, and goes out urgent and
// long-lived on both transports; a reply does neither. Real CorePush, real HTTP/2 APNs sender against a local fake, and the
// real web-push transport with only `sendNotification` (the network call) replaced.
import {
  type AgentConfigT,
  buildApnsBody,
  buildPushPayload,
  createDeviceKey,
  type PushPayloadT,
  pushTtlSeconds,
} from '@talos-app/protocol'
import { fakeClock } from '@talos-app/testkit'
import { afterEach, describe, expect, it, vi } from 'vitest'
import webpush from 'web-push'
import { DEFAULT_AGENT_CONFIG } from '../../src/core/default-config.ts'
import { CorePush, createWebPushTransport, NoopTransport } from '../../src/core/push.ts'
import { createApnsSender } from '../../src/core/push-apns.ts'
import type { Logger } from '../../src/services.ts'
import { startTestRelay, type TestRelay } from '../core/harness.ts'
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
const CARD = 'c_01JABCDEFGHJKMNPQRSTVWXYZ0'
const quietLog = {
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

async function rig(over: Partial<AgentConfigT> = {}) {
  const fake: FakeApns = await startFakeApns(key.publicKey)
  cleanups.push(() => fake.close())
  const clock = fakeClock('2026-10-31T15:00:00.000Z') // 08:00 in the UTC-7 zone; the default quiet window is not in force
  const r: TestRelay = await startTestRelay({ clock, env: ENV, apnsAuthority: () => fake.url })
  cleanups.push(() => r.stop())
  const dev = await createDeviceKey()
  r.relay.services.db
    .prepare(
      'insert into auth_devices (id, name, pubkey_jwk, binding, pinned, revoked, created_at) values (?, ?, ?, ?, 1, 0, ?)',
    )
    .run(dev.deviceId, 'phone', JSON.stringify(dev.publicJwk), 'b', Date.now())
  r.runtime.store.putPushDevice({ deviceId: dev.deviceId, token: TOKEN, env: 'sandbox' })
  r.runtime.store.putSub({ endpoint: 'https://push.example/one', keys: { p256dh: 'a', auth: 'b' } })
  const web = new NoopTransport()
  let visible = false
  const cfg: AgentConfigT = { ...DEFAULT_AGENT_CONFIG, ...over }
  const push = new CorePush({
    store: r.runtime.store,
    clock,
    log: quietLog,
    transport: web,
    config: () => cfg,
    anyVisible: () => visible,
    apns: createApnsSender({
      config: { keyId: 'KEYID12345', teamId: 'TEAMID1234', keyP8: key.p8, bundleId: 'com.example.talos' },
      clock,
      log: quietLog,
      authority: () => fake.url,
    }),
  })
  return { fake, push, web, setVisible: (v: boolean) => (visible = v), clock }
}

describe('D24: an approval is not swallowed by a visible window', () => {
  it('needs_you goes to the phone (APNs and web) while a desktop window is visible; a reply does not', async () => {
    const x = await rig()
    x.setVisible(true)
    await x.push.notify({ template: 'reply', thread_id: 'general' })
    expect(x.fake.requests).toHaveLength(0)
    expect(x.web.sent).toHaveLength(0)
    await x.push.notify({ template: 'needs_you', thread_id: 'general', card_id: CARD })
    expect(x.fake.requests).toHaveLength(1)
    expect(x.web.sent).toHaveLength(1)
    // other chat templates still respect a visible window
    await x.push.notify({ template: 'answer_ready', thread_id: 'general' })
    await x.push.notify({ template: 'overnight', count: 3 })
    expect(x.fake.requests).toHaveLength(1)
  })

  it('the quiet window, the master switch and a thread set to off still hold needs_you (quiet is owner call O7)', async () => {
    const quiet = await rig({ quiet_window: { start: '07:00', end: '09:00' }, timezone: 'Etc/GMT+7' })
    quiet.setVisible(true)
    await quiet.push.notify({ template: 'needs_you', thread_id: 'general', card_id: CARD })
    expect(quiet.fake.requests).toHaveLength(0)

    const master = await rig({ notifications: { master: false, show_thread_names: 'fixed_only' } })
    master.setVisible(true)
    await master.push.notify({ template: 'needs_you', thread_id: 'general', card_id: CARD })
    expect(master.fake.requests).toHaveLength(0)

    const off = await rig({ threads: DEFAULT_AGENT_CONFIG.threads.map((t) => ({ ...t, notify: 'off' as const })) })
    off.setVisible(true)
    await off.push.notify({ template: 'needs_you', thread_id: 'general', card_id: CARD })
    expect(off.fake.requests).toHaveLength(0)
  })
})

describe('D25: card pushes are urgent and keep longer, on both transports', () => {
  it('APNs: a card is time-sensitive with a 24 h expiry; a reply is a plain alert with the 1 h expiry', async () => {
    const x = await rig()
    const t0 = Math.floor(x.clock.now() / 1000)
    await x.push.notify({ template: 'needs_you', thread_id: 'general', card_id: CARD })
    await x.push.notify({ template: 'reply', thread_id: 'general' })
    const [card, reply] = x.fake.requests
    expect(card?.priority).toBe('10')
    expect(Number(card?.expiration)).toBe(t0 + 86_400)
    expect(card?.body.aps).toMatchObject({ 'interruption-level': 'time-sensitive' })
    expect(Number(reply?.expiration)).toBe(t0 + 3600)
    expect(reply?.body.aps as Record<string, unknown>).not.toHaveProperty('interruption-level')
  })

  it('a needs_you with no card id is still a card push (the kind decides, not the id)', async () => {
    const x = await rig()
    await x.push.notify({ template: 'needs_you', thread_id: 'general' })
    expect(x.fake.requests[0]?.body.aps).toMatchObject({ 'interruption-level': 'time-sensitive' })
  })

  it('web push: urgency high and a 24 h TTL for a card, normal and 1 h for everything else', async () => {
    const spy = vi.spyOn(webpush, 'sendNotification').mockResolvedValue({ statusCode: 201, body: '', headers: {} })
    const transport = createWebPushTransport({ publicKey: 'k', privateKey: 'p', subject: 'mailto:a@example.com' })
    const sub = { endpoint: 'https://push.example/one', keys: { p256dh: 'a', auth: 'b' } }
    const cfg = DEFAULT_AGENT_CONFIG
    const card: PushPayloadT = buildPushPayload({ template: 'needs_you', thread_id: 'general', card_id: CARD }, cfg)
    const reply: PushPayloadT = buildPushPayload({ template: 'reply', thread_id: 'general' }, cfg)
    const health: PushPayloadT = buildPushPayload({ template: 'session_stopped' }, cfg)
    await transport.send(sub, card)
    await transport.send(sub, reply)
    await transport.send(sub, health)
    const opts = spy.mock.calls.map((c) => c[2] as { TTL: number; urgency: string })
    expect(opts.map((o) => [o.urgency, o.TTL])).toEqual([
      ['high', 86_400],
      ['normal', 3600],
      ['normal', 3600],
    ])
  })

  it('a card that dies in 30 minutes is not kept for 24 h: the push never outlives it, on both transports', async () => {
    const x = await rig()
    const t0 = Math.floor(x.clock.now() / 1000)
    const soon = new Date(x.clock.now() + 1800_000).toISOString()
    await x.push.notify({ template: 'needs_you', thread_id: 'general', card_id: CARD, expires_at: soon })
    expect(Number(x.fake.requests[0]?.expiration)).toBe(t0 + 1800)
    expect(x.web.opts[0]?.secondsLeft).toBe(1800)
    // a long-lived card is still capped at the day; an unreadable expiry falls back to the day
    const far = new Date(x.clock.now() + 10 * 86_400_000).toISOString()
    await x.push.notify({ template: 'needs_you', thread_id: 'general', card_id: CARD, expires_at: far })
    await x.push.notify({ template: 'needs_you', thread_id: 'general', card_id: CARD, expires_at: 'not a date' })
    expect(Number(x.fake.requests[1]?.expiration)).toBe(t0 + 86_400)
    expect(Number(x.fake.requests[2]?.expiration)).toBe(t0 + 86_400)
    // an already-expired card is now-or-never, never stored
    await x.push.notify({
      template: 'needs_you',
      thread_id: 'general',
      card_id: CARD,
      expires_at: new Date(x.clock.now() - 5000).toISOString(),
    })
    expect(Number(x.fake.requests[3]?.expiration)).toBe(t0)
    // only a card push is capped: a reply keeps its hour whatever it is told
    expect(pushTtlSeconds(buildPushPayload({ template: 'reply', thread_id: 'general' }, DEFAULT_AGENT_CONFIG), 5)).toBe(
      3600,
    )
  })

  it('web push: the transport passes the capped TTL to the push service', async () => {
    const spy = vi.spyOn(webpush, 'sendNotification').mockResolvedValue({ statusCode: 201, body: '', headers: {} })
    const transport = createWebPushTransport({ publicKey: 'k', privateKey: 'p', subject: 'mailto:a@example.com' })
    const sub = { endpoint: 'https://push.example/one', keys: { p256dh: 'a', auth: 'b' } }
    const card = buildPushPayload({ template: 'needs_you', thread_id: 'general', card_id: CARD }, DEFAULT_AGENT_CONFIG)
    await transport.send(sub, card, { secondsLeft: 600.9 })
    const sent = spy.mock.calls[0]?.[2] as { TTL: number } | undefined
    expect(sent?.TTL).toBe(600)
  })

  it('the protocol: only a card body carries interruption-level', () => {
    const cfg = DEFAULT_AGENT_CONFIG
    for (const template of [
      'reply',
      'answer_ready',
      'overnight',
      'session_stopped',
      'device_pinned',
      'disk_low',
    ] as const)
      expect(buildApnsBody(buildPushPayload({ template }, cfg)).aps).not.toHaveProperty('interruption-level')
    expect(buildApnsBody(buildPushPayload({ template: 'needs_you', card_id: CARD }, cfg)).aps).toMatchObject({
      'interruption-level': 'time-sensitive',
    })
  })
})
