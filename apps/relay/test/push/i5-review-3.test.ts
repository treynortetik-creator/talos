// Third round of push regression tests. Each test pins a bug that was found and fixed, unless its name says "control". Real CorePush, real sender, the
// fake Apple: what is on trial is the bytes Apple receives, however the fix gets there.
import { type AgentConfigT, createDeviceKey } from '@talos-app/protocol'
import { fakeClock } from '@talos-app/testkit'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_AGENT_CONFIG } from '../../src/core/default-config.ts'
import { CorePush, NoopTransport } from '../../src/core/push.ts'
import { type ApnsSender, createApnsSender } from '../../src/core/push-apns.ts'
import type { Logger } from '../../src/services.ts'
import { startTestRelay } from '../core/harness.ts'
import { startFakeApns, testKey } from '../helpers/fake-apns.ts'

vi.setConfig({ testTimeout: 30_000 })

const TOKEN = 'a'.repeat(64)
const OWNER_NAME = 'Severance talks with Bob'
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

type Mode = 'fixed_only' | 'all' | 'none'

/** What Apple receives for a reply in `threadId` when that built-in thread carries the name `name`. */
async function sentToApple(threadId: 'general' | 'inbox', name: string, mode: Mode) {
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
    threads: DEFAULT_AGENT_CONFIG.threads.map((t) => (t.id === threadId ? { ...t, name } : t)),
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
  await push.notify({ template: 'reply', thread_id: threadId }, { force: true })
  const req = fake.requests[0]
  if (!req) throw new Error('nothing reached the fake APNs')
  return req
}

describe('I5-R13 a built-in thread keeps its ID on the safe list, not a name someone typed', () => {
  // AgentSettingsSection.tsx disables the name field for Inbox only, so General is renamed from Settings. Inbox can't be
  // renamed there; it is here because the relay does not refuse it and the standing decision covers every setting.
  it.each([
    ['fixed_only', 'general'],
    ['all', 'general'],
    ['none', 'general'],
    ['fixed_only', 'inbox'],
    ['all', 'inbox'],
    ['none', 'inbox'],
  ] as const)('R13 Show thread names %s: a renamed %s sends Apple nothing the owner typed', async (mode, threadId) => {
    const req = await sentToApple(threadId, OWNER_NAME, mode)
    expect(req.rawBody).not.toMatch(/severance/i)
    expect(req.collapseId ?? '').not.toMatch(/severance/i)
  })

  it('control: General under its own name still reads "General" and still deep-links', async () => {
    const req = await sentToApple('general', 'General', 'none')
    expect(req.body).toMatchObject({ aps: { alert: { body: 'New reply in General' } } })
    expect(req.rawBody).toContain('/t/general')
  })
})
