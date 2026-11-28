// A push whose recheck could not be answered (the store threw) is an attempted, failed send. The two callers that retry
// on "sent but none accepted" must therefore try again, and must not record the reminder or wipe the held summary.
// Real relay, real store, real HTTP/2 fake APNs; the only fault is pushDeviceLive throwing.
import { createDeviceKey, newUlid, signOwnerFrame } from '@talos-app/protocol'
import { type FakeBridge, type FakeClock, fakeClock, waitFor } from '@talos-app/testkit'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { CardReminder, REMINDER_TICK_MS } from '../../src/core/card-reminder.ts'
import { DEFAULT_AGENT_CONFIG } from '../../src/core/default-config.ts'
import { QuietSummary, readQuietHeld, SUMMARY_TICK_MS } from '../../src/core/quiet-summary.ts'
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
const utc5 = (hhmm: string) => {
  const [h, m] = hhmm.split(':').map(Number) as [number, number]
  return new Date(Date.UTC(2026, 9, 30, h + 5, m)).toISOString()
}

let relay: TestRelay | null = null
let fake: FakeApns | null = null
afterEach(async () => {
  vi.restoreAllMocks()
  await relay?.stop()
  await fake?.close()
  relay = null
  fake = null
})

async function world(startAt: string) {
  fake = await startFakeApns(key.publicKey)
  const url = fake.url
  const errors: string[] = []
  /** The template of each push whose recheck failed, so a test knows which push its fault hit. */
  const recheckFailed: string[] = []
  const log = {
    debug() {},
    info() {},
    warn() {},
    error(o: unknown, msg?: string) {
      if (msg) errors.push(msg)
      if (msg === 'push recheck failed; not sending') recheckFailed.push(String((o as { template?: unknown }).template))
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
  const cfg = { ...DEFAULT_AGENT_CONFIG, timezone: 'Etc/GMT+5', quiet_window: { start: '22:00', end: '06:00' } }
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
    recheckFailed,
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

/**
 * Counts the looks of a ticking loop (the card reminder, the quiet summary) that did their work: a look that starts while one
 * is still running returns at once, and is not counted. The spy is set before the relay starts, so it wraps the runtime's.
 */
function countLooks(loop: typeof CardReminder | typeof QuietSummary) {
  const done = { n: 0 }
  const proto = loop.prototype as { tick(): Promise<void> }
  const real = proto.tick
  vi.spyOn(proto, 'tick').mockImplementation(async function (this: unknown) {
    const ran = !(this as { busy: boolean }).busy
    await real.call(this)
    if (ran) done.n++
  })
  return done
}
/**
 * Moves the fake clock one reminder tick at a time until `cond`, each step only after the look it started has finished, so a
 * slow machine never runs fake time past work still in flight. Bounded in fake time (`maxTicks`); the real wait per step is a
 * hang cap only.
 */
async function tickUntil(
  clock: FakeClock,
  looks: { n: number },
  cond: () => boolean,
  maxTicks: number,
  what: string,
  tickMs = REMINDER_TICK_MS,
) {
  for (let i = 0; i < maxTicks && !cond(); i++) {
    const before = looks.n
    clock.advance(tickMs)
    await waitFor(() => looks.n > before, 10_000, 'the reminder look for this tick')
  }
  if (!cond()) throw new Error(`${what}: not reached within ${maxTicks} reminder ticks`)
}

describe('a recheck error is a failed send to the callers that retry', () => {
  it('card reminder: not recorded as sent while the recheck fails, and it goes out once the store answers', async () => {
    const looks = countLooks(CardReminder)
    const w = await world(utc5('08:00'))
    const made = w.bridge.createCard({
      thread_id: 'general',
      title: 'Send the contract',
      created_at: new Date(w.clock.now()).toISOString(),
      expires_at: new Date(w.clock.now() + 24 * HOUR).toISOString(),
    })
    await waitFor(() => w.store.getCard(made.id) !== null, 3000, 'card stored')
    await waitFor(() => w.alerts().includes('Needs you in General'), 5000, "the card's own push")
    // to just before the reminder is due (an hour before expiry). Other pushes on the way (the quiet bridge's "session
    // stopped") are not what this test is about, so the fault is set only after them: it must hit the reminder.
    await advance(w.clock, 22 * HOUR + 50 * 60_000, 5 * 60_000)
    await waitFor(() => looks.n > 0, 10_000, 'a reminder look')
    expect(w.store.getState(`card_reminded:${made.id}`)).toBeFalsy()
    w.requests().length = 0
    w.breakRecheckOnce()
    // the reminder comes due and its first try fails on the recheck; it is not recorded as sent
    await tickUntil(w.clock, looks, () => w.recheckFailed.length > 0, 30, 'the failed try')
    expect(w.recheckFailed).toEqual(['card_expiring'])
    expect(w.store.getState(`card_reminded:${made.id}`)).not.toBe('sent')
    expect(w.requests()).toHaveLength(0)
    // the failed attempt is not "nobody to notify": the reminder is tried again and reaches the phone, well before expiry
    await tickUntil(
      w.clock,
      looks,
      () => w.store.getState(`card_reminded:${made.id}`) === 'sent',
      30,
      'the retried reminder',
    )
    expect(w.alerts()).toEqual(['A card in General expires soon'])
  })

  it('quiet summary: the held counts survive a failing recheck and the summary goes out after', async () => {
    const looks = countLooks(QuietSummary)
    const w = await world(utc5('22:30'))
    for (let i = 0; i < 3; i++) w.bridge.reply('general', `private words ${i}`)
    await waitFor(() => readQuietHeld(w.store).replies === 3, 3000, 'three replies held')
    // to 05:50, just before quiet ends at 06:00. Other pushes on the way (the quiet bridge's "session stopped") are not what
    // this test is about, so the fault is set only after them: it must hit the summary.
    await advance(w.clock, 7 * HOUR + 20 * 60_000, 5 * 60_000)
    await waitFor(() => looks.n > 0, 10_000, 'a summary look')
    expect(readQuietHeld(w.store).replies).toBe(3)
    w.requests().length = 0
    w.breakRecheckOnce()
    // quiet ends and the summary's first try fails on the recheck: the held counts are kept and nothing counts as sent
    await tickUntil(w.clock, looks, () => w.recheckFailed.length > 0, 30, 'the failed try', SUMMARY_TICK_MS)
    expect(w.recheckFailed).toEqual(['quiet_summary'])
    expect(readQuietHeld(w.store).replies).toBe(3)
    // the quiet bridge's "session stopped", held through the window, may go out on the same tick: it is not the summary
    const notSystem = () =>
      w
        .requests()
        .filter((q) => (q.body.talos as { kind?: string } | undefined)?.kind !== 'system')
        .map((q) => (q.body.aps as { alert?: { body?: string } }).alert?.body ?? '')
    expect(notSystem()).toEqual([])
    // the summary is tried again and arrives; only then are the held counts cleared
    await tickUntil(
      w.clock,
      looks,
      () => readQuietHeld(w.store).replies === 0,
      30,
      'the retried summary',
      SUMMARY_TICK_MS,
    )
    expect(notSystem()).toEqual(['3 replies'])
  })
})

describe('an unreadable device list is a failed send, not "nobody to notify"', () => {
  it('card reminder: the failed attempt leaves it to be retried, and it goes out once the list answers', async () => {
    const looks = countLooks(CardReminder)
    const w = await world(utc5('08:00'))
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
    // One reminder tick per step, each only after its look (send and record) has finished: the push's 30 s deadline runs on
    // this fake clock, so a step taken while a send is in flight would time it out, count it failed and send it again.
    await tickUntil(w.clock, looks, () => !!w.store.getState(`card_reminded:${made.id}`), 90, 'the first attempt')
    expect(w.errors).toContain('push devices unreadable')
    // not "sent": the attempt failed, so it is tried again (the broken code wrote 'sent' here)
    expect(w.store.getState(`card_reminded:${made.id}`)).toMatch(/^try:/)
    w.fixList()
    const errorsBefore = w.errors.length // the log line names no card, so the window is from here to the record
    await tickUntil(
      w.clock,
      looks,
      () => w.store.getState(`card_reminded:${made.id}`) === 'sent',
      30,
      'the retried reminder',
    )
    // one more look after it is recorded: nothing more goes out
    for (let i = 0; i < 2; i++) {
      const before = looks.n
      w.clock.advance(REMINDER_TICK_MS)
      await waitFor(() => looks.n > before, 10_000, 'a look after the record')
    }
    // the retry and its record ran with nothing timing out (the send deadline is on the fake clock): other pushes earlier
    // in the long fast-forward may time out, those are not this reminder
    expect(w.errors.slice(errorsBefore)).not.toContain('push send timed out')
    // exactly one reminder, whatever else (a health notice) the long clock jump produced
    expect(w.alerts().filter((x) => x === 'A card in General expires soon')).toHaveLength(1)
  })

  // timing-ok: the waits are hang caps; each ends the moment its condition holds
  it('card reminder: a send still in flight, its record not yet written, is not sent again by later looks', async () => {
    const looks = countLooks(CardReminder)
    const w = await world(utc5('08:00'))
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
    // The push reaches the phone, but the caller is held before it can record "sent": a slow write, a busy database.
    const push = w.r.runtime.push
    const realNotify = push.notifyCounted.bind(push)
    let release: () => void = () => {}
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    let held = 0
    vi.spyOn(push, 'notifyCounted').mockImplementation(async (intent, opts) => {
      const res = await realNotify(intent, opts)
      if (intent.template === 'card_expiring') {
        held++
        await gate
      }
      return res
    })
    // time runs on one tick at a time, each look finished before the next step, until the reminder is sent and held
    for (let i = 0; i < 90 && held === 0; i++) {
      const before = looks.n
      w.clock.advance(REMINDER_TICK_MS)
      await waitFor(() => looks.n > before || held > 0, 10_000, 'the look for this tick')
    }
    await waitFor(() => held === 1, 10_000, 'the reminder is sent and held before its record')
    for (let i = 0; i < 10; i++) w.clock.advance(REMINDER_TICK_MS) // ten more ticks while the write is pending
    expect(w.store.getState(`card_reminded:${made.id}`)).toBeNull()
    expect(held).toBe(1)
    release()
    await waitFor(() => w.store.getState(`card_reminded:${made.id}`) === 'sent', 10_000, 'now it is recorded')
    const before = looks.n
    w.clock.advance(REMINDER_TICK_MS)
    await waitFor(() => looks.n > before, 10_000, 'a look after the record')
    expect(w.alerts().filter((x) => x === 'A card in General expires soon')).toHaveLength(1)
  })

  it('quiet summary: the held counts survive a failing list and the summary goes out after', async () => {
    const looks = countLooks(QuietSummary)
    const w = await world(utc5('22:30'))
    for (let i = 0; i < 3; i++) w.bridge.reply('general', `private words ${i}`)
    await waitFor(() => readQuietHeld(w.store).replies === 3, 3000, 'three replies held')
    w.requests().length = 0
    await advance(w.clock, 7 * HOUR, 5 * 60_000) // 05:30, still quiet
    w.breakList()
    // One summary tick per step, each only after its look (send and record) has finished: the push's 30 s deadline runs on
    // this fake clock, so a step taken while a send is in flight would time it out, count it failed and send it again.
    await tickUntil(
      w.clock,
      looks,
      () => readQuietHeld(w.store).tries > 0 || readQuietHeld(w.store).replies === 0,
      90,
      'the failed attempt',
      SUMMARY_TICK_MS,
    )
    expect(w.errors).toContain('push devices unreadable')
    // the failed attempt neither wiped the held counts nor counted as sent (the broken code cleared them here)
    expect(readQuietHeld(w.store)).toMatchObject({ replies: 3, tries: 1 })
    w.fixList()
    await tickUntil(
      w.clock,
      looks,
      () => readQuietHeld(w.store).replies === 0,
      90,
      'the retried summary',
      SUMMARY_TICK_MS,
    )
    await waitFor(() => w.requests().length >= 1, 5000, 'the summary reaches the phone')
    // two more looks after the record: nothing more goes out
    for (let i = 0; i < 2; i++) {
      const before = looks.n
      w.clock.advance(SUMMARY_TICK_MS)
      await waitFor(() => looks.n > before, 10_000, 'a look after the record')
    }
    expect(w.alerts()).toEqual(['3 replies'])
  })

  it('test push (?via=apns): a failing list answers 502, not 409 no_device; once it reads, 204', async () => {
    const w = await world(utc5('08:00'))
    w.breakListOnce()
    const bad = await w.testPush()
    expect(bad.status).toBe(502)
    expect(await bad.json()).toEqual({ error: 'push_failed' })
    expect(w.requests()).toHaveLength(0)
    expect((await w.testPush()).status).toBe(204)
    expect(w.requests()).toHaveLength(1)
  })

  it('one row that no longer decrypts does not hide the good device, and still counts as a failed send', async () => {
    const w = await world(utc5('08:00'))
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
