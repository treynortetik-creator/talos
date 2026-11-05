// A push whose recheck could not be answered (the store threw) is an attempted, failed send. The two callers that retry
// on "sent but none accepted" must therefore try again, and must not record the reminder or wipe the held summary.
// Real relay, real store, real HTTP/2 fake APNs; the only fault is pushDeviceLive throwing.
import { createDeviceKey, newUlid, signOwnerFrame } from '@talos-app/protocol'
import { type FakeBridge, type FakeClock, fakeClock, waitFor } from '@talos-app/testkit'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_AGENT_CONFIG } from '../../src/core/default-config.ts'
import { readQuietHeld } from '../../src/core/quiet-summary.ts'
import { ORIGIN, startTestRelay, type TestRelay } from '../core/harness.ts'
import { advance, kit } from '../core/helpers.ts'
import { type FakeApns, startFakeApns, testKey } from '../helpers/fake-apns.ts'

vi.setConfig({ testTimeout: 60_000 })

const HOUR = 3_600_000
const TOKEN = 'c'.repeat(64)
const key = testKey()
const ENV = {
  APNS_KEY_ID: 'KEYID12345',
  APNS_TEAM_ID: 'TEAMID1234',
  APNS_KEY_P8: key.p8,
  APNS_BUNDLE_ID: 'com.example.talos',
}
const utc7 = (hhmm: string) => {
  const [h, m] = hhmm.split(':').map(Number) as [number, number]
  return new Date(Date.UTC(2026, 9, 30, h + 7, m)).toISOString()
}

let relay: TestRelay | null = null
let fake: FakeApns | null = null
afterEach(async () => {
  await relay?.stop()
  await fake?.close()
  relay = null
  fake = null
})

async function world(startAt: string) {
  fake = await startFakeApns(key.publicKey)
  const url = fake.url
  const errors: string[] = []
  const log = {
    debug() {},
    info() {},
    warn() {},
    error(_o: unknown, msg?: string) {
      if (msg) errors.push(msg)
    },
    child() {
      return this
    },
  }
  const clock: FakeClock = fakeClock(startAt)
  const r = await startTestRelay({ clock, log: log as never, env: ENV, apnsAuthority: () => url })
  relay = r
  const dev = await createDeviceKey()
  r.relay.services.db
    .prepare(
      'insert into auth_devices (id, name, pubkey_jwk, binding, pinned, revoked, created_at) values (?, ?, ?, ?, 1, 0, ?)',
    )
    .run(dev.deviceId, 'phone', JSON.stringify(dev.publicJwk), 'b', Date.now())
  const body = await signOwnerFrame(
    {
      v: 1,
      type: 'push.apns',
      op: 'register',
      device_id: dev.deviceId,
      token: TOKEN,
      env: 'sandbox',
      ts: new Date(clock.now()).toISOString(),
      nonce: `n${newUlid().toLowerCase()}`,
    },
    dev.privateKey,
  )
  const res = await fetch(`${r.httpBase}/api/push/apns`, {
    method: 'POST',
    headers: {
      'X-Test-Session': dev.deviceId,
      Origin: ORIGIN,
      'X-Talos-CSRF': '1',
      'content-type': 'application/json',
    },
    body: JSON.stringify(body),
  })
  expect(res.status).toBe(204)
  const bridge: FakeBridge = await kit(r)
    .bridge({ autoReply: false, pinnedDevices: { [dev.deviceId]: dev.publicJwk } })
    .connect()
  const cfg = { ...DEFAULT_AGENT_CONFIG, timezone: 'Etc/GMT+7', quiet_window: { start: '20:30', end: '04:00' } }
  bridge.send({ type: 'config.sync', config: { ...cfg, rev: 9 }, rev: 9 })
  await waitFor(() => r.runtime.hub.agentConfig()?.rev === 9, 3000, 'config applied')
  const store = r.runtime.store
  const realLive = store.pushDeviceLive.bind(store)
  const realList = store.listPushDevices.bind(store)
  return {
    dev,
    /** Every listing of devices throws ("database is locked") until `fixList()`. */
    breakList() {
      store.listPushDevices = () => {
        throw new Error('database is locked')
      }
    },
    fixList() {
      store.listPushDevices = realList
    },
    /** The next listing throws once; every later one answers. */
    breakListOnce() {
      let thrown = false
      store.listPushDevices = (...a: Parameters<typeof realList>) => {
        if (!thrown) {
          thrown = true
          throw new Error('database is locked')
        }
        return realList(...a)
      }
    },
    /** The owner's "test push to my iPhone" button. */
    testPush: () =>
      fetch(`${r.httpBase}/api/push/test?via=apns`, {
        method: 'POST',
        headers: { 'X-Test-Session': dev.deviceId, Origin: ORIGIN, 'X-Talos-CSRF': '1' },
      }),
    r,
    clock,
    bridge,
    store,
    errors,
    /** The next recheck throws once; every later one answers. */
    breakRecheckOnce() {
      let thrown = false
      store.pushDeviceLive = (id: string) => {
        if (!thrown) {
          thrown = true
          throw new Error('database is locked')
        }
        return realLive(id)
      }
    },
    requests: () => fake?.requests ?? [],
    alerts: () => (fake?.requests ?? []).map((q) => (q.body.aps as { alert?: { body?: string } }).alert?.body ?? ''),
  }
}

describe('a recheck error is a failed send to the callers that retry', () => {
  it('card reminder: not recorded as sent while the recheck fails, and it goes out once the store answers', async () => {
    const w = await world(utc7('08:00'))
    const made = w.bridge.createCard({
      thread_id: 'general',
      title: 'Send the contract',
      created_at: new Date(w.clock.now()).toISOString(),
      expires_at: new Date(w.clock.now() + 24 * HOUR).toISOString(),
    })
    await waitFor(() => w.store.getCard(made.id) !== null, 3000, 'card stored')
    await waitFor(() => w.alerts().includes('Needs you in General'), 5000, "the card's own push")
    w.requests().length = 0 // that push is not what this test is about
    w.breakRecheckOnce()
    await advance(w.clock, 23 * HOUR + 30 * 60_000, 5 * 60_000)
    // the failed attempt is not "nobody to notify": the reminder is tried again and reaches the phone
    expect(w.errors).toContain('push recheck failed; not sending')
    await waitFor(() => w.requests().length >= 1, 5000, 'the reminder reaches the phone')
    await waitFor(() => w.store.getState(`card_reminded:${made.id}`) === 'sent', 5000, 'now it is recorded')
    expect(w.alerts()).toEqual(['A card in General expires soon'])
  })

  it('quiet summary: the held counts survive a failing recheck and the summary goes out after', async () => {
    const w = await world(utc7('21:00'))
    for (let i = 0; i < 3; i++) w.bridge.reply('general', `private words ${i}`)
    await waitFor(() => readQuietHeld(w.store).replies === 3, 3000, 'three replies held')
    w.requests().length = 0
    w.breakRecheckOnce()
    await advance(w.clock, 7 * HOUR + 15 * 60_000, 5 * 60_000) // 04:15, quiet is over
    // the failed attempt neither wipes the held counts nor counts as sent: the summary is tried again and arrives
    expect(w.errors).toContain('push recheck failed; not sending')
    await waitFor(() => w.requests().length >= 1, 5000, 'the summary reaches the phone')
    await waitFor(() => readQuietHeld(w.store).replies === 0, 5000, 'now the held counts are cleared')
    expect(w.alerts()).toEqual(['3 replies'])
  })
})

describe('an unreadable device list is a failed send, not "nobody to notify"', () => {
  it('card reminder: the failed attempt leaves it to be retried, and it goes out once the list answers', async () => {
    const w = await world(utc7('08:00'))
    const made = w.bridge.createCard({
      thread_id: 'general',
      title: 'Send the contract',
      created_at: new Date(w.clock.now()).toISOString(),
      expires_at: new Date(w.clock.now() + 24 * HOUR).toISOString(),
    })
    await waitFor(() => w.store.getCard(made.id) !== null, 3000, 'card stored')
    await waitFor(() => w.alerts().includes('Needs you in General'), 5000, "the card's own push")
    w.requests().length = 0
    await advance(w.clock, 22 * HOUR, 5 * 60_000)
    w.breakList() // broken from here until the first reminder attempt has been made
    for (let i = 0; i < 24 && !w.store.getState(`card_reminded:${made.id}`); i++) await advance(w.clock, 5 * 60_000)
    expect(w.errors).toContain('push devices unreadable')
    // not "sent": the attempt failed, so it is tried again (the broken code wrote 'sent' here)
    expect(w.store.getState(`card_reminded:${made.id}`)).toMatch(/^try:/)
    w.fixList()
    await advance(w.clock, 30 * 60_000, 5 * 60_000)
    await waitFor(() => w.requests().length >= 1, 5000, 'the reminder reaches the phone')
    await waitFor(() => w.store.getState(`card_reminded:${made.id}`) === 'sent', 5000, 'now it is recorded')
    // exactly one reminder, whatever else (a health notice) the long clock jump produced
    expect(w.alerts().filter((x) => x === 'A card in General expires soon')).toHaveLength(1)
  })

  it('quiet summary: the held counts survive a failing list and the summary goes out after', async () => {
    const w = await world(utc7('21:00'))
    for (let i = 0; i < 3; i++) w.bridge.reply('general', `private words ${i}`)
    await waitFor(() => readQuietHeld(w.store).replies === 3, 3000, 'three replies held')
    w.requests().length = 0
    await advance(w.clock, 6 * HOUR + 30 * 60_000, 5 * 60_000) // 03:30, still quiet
    w.breakList()
    for (let i = 0; i < 24 && readQuietHeld(w.store).tries === 0 && readQuietHeld(w.store).replies > 0; i++)
      await advance(w.clock, 5 * 60_000)
    expect(w.errors).toContain('push devices unreadable')
    // the failed attempt neither wiped the held counts nor counted as sent (the broken code cleared them here)
    expect(readQuietHeld(w.store)).toMatchObject({ replies: 3, tries: 1 })
    w.fixList()
    await advance(w.clock, 30 * 60_000, 5 * 60_000)
    await waitFor(() => w.requests().length >= 1, 5000, 'the summary reaches the phone')
    await waitFor(() => readQuietHeld(w.store).replies === 0, 5000, 'now the held counts are cleared')
    expect(w.alerts()).toEqual(['3 replies'])
  })

  it('test push (?via=apns): a failing list answers 502, not 409 no_device; once it reads, 204', async () => {
    const w = await world(utc7('08:00'))
    w.breakListOnce()
    const bad = await w.testPush()
    expect(bad.status).toBe(502)
    expect(await bad.json()).toEqual({ error: 'push_failed' })
    expect(w.requests()).toHaveLength(0)
    expect((await w.testPush()).status).toBe(204)
    expect(w.requests()).toHaveLength(1)
  })

  it('one row that no longer decrypts does not hide the good device, and still counts as a failed send', async () => {
    const w = await world(utc7('08:00'))
    const db = w.r.relay.services.db
    const other = await createDeviceKey()
    db.prepare(
      'insert into auth_devices (id, name, pubkey_jwk, binding, pinned, revoked, created_at) values (?, ?, ?, ?, 1, 0, ?)',
    ).run(other.deviceId, 'old phone', JSON.stringify(other.publicJwk), 'b', Date.now())
    db.prepare(
      'insert into core_push_devices (token_hash, device_id, env, sealed, created_at) values (?, ?, ?, ?, ?)',
    ).run('z'.repeat(16), other.deviceId, 'sandbox', Buffer.from('not a sealed value at all'), Date.now() + 1000)
    // the good phone gets the push ...
    const res = await w.testPush()
    expect(res.status).toBe(204)
    expect(w.requests()).toHaveLength(1)
    // ... and the unreadable row is reported, not silently dropped
    expect(w.errors).toContain('push devices unreadable')
    const counted = await w.r.runtime.push.notifyCounted({ template: 'reply' }, { force: true })
    expect(counted?.native).toEqual({ sent: 2, ok: 1 })
  })
})
