// A device revoked while a push pass is already running must get nothing from that pass, whichever path started it: a
// card, a reply, the failure notice for a notification tap, or a health alert. Real relay, real HTTP/2 fake APNs, real
// store. The revoke lands at the exact seam that matters: after the pass listed its devices, before it sent. A second
// phone the Mac still trusts is the positive signal: the pass is over when both phones are accounted for in the log
// (one sent, one skipped), not after a sleep.
//
// The seams, each exercised with the guard in place: right after the pass listed its devices; inside a sealPush that is
// still running; during the PING wait on a connection that has sat idle; and between an ExpiredProviderToken answer and
// the repeat. Each also covers the grant changing underneath the seal (replaced, expired) and a phone declined (pinned=0).
import http2 from 'node:http2'
import {
  createDeviceKey,
  createPhoneKeys,
  type DeviceKey,
  NATIVE_ACT_FEATURE,
  newUlid,
  openPush,
  signNativeAct,
  signNativeGrant,
  signOwnerFrame,
} from '@talos-app/protocol'
import { fakeClock, waitFor } from '@talos-app/testkit'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ORIGIN, startTestRelay, type TestRelay } from '../core/harness.ts'
import { advance, kit } from '../core/helpers.ts'
import { type FakeApns, startFakeApns, testKey } from '../helpers/fake-apns.ts'

vi.setConfig({ testTimeout: 30_000 })

// sealPush runs for real; the test can hold it open and act while it is open.
const seam = vi.hoisted(() => ({ inSeal: null as null | ((deviceId: string) => Promise<void> | void) }))
vi.mock('@talos-app/protocol', async (importOriginal) => {
  const real = await importOriginal<typeof import('@talos-app/protocol')>()
  return {
    ...real,
    sealPush: async (input: Parameters<typeof real.sealPush>[0]) => {
      await seam.inSeal?.(input.deviceId)
      return real.sealPush(input)
    },
  }
})

const GONE_TOKEN = 'a'.repeat(64)
const KEEP_TOKEN = 'b'.repeat(64)
const SECRET = 'the quarterly plan is in the blue folder'
const SKIPPED = 'push skipped: device no longer trusted'
const key = testKey()
const APNS_ENV = {
  APNS_KEY_ID: 'KEYID12345',
  APNS_TEAM_ID: 'TEAMID1234',
  APNS_KEY_P8: key.p8,
  APNS_BUNDLE_ID: 'com.example.talos',
}

let relay: TestRelay | null = null
let fake: FakeApns | null = null
afterEach(async () => {
  seam.inSeal = null
  vi.restoreAllMocks()
  await relay?.stop()
  await fake?.close()
  relay = null
  fake = null
})

type PhoneKeys = Awaited<ReturnType<typeof createPhoneKeys>>
type Phone = { dev: DeviceKey; keys: PhoneKeys; token: string; grant: Record<string, unknown> & { osig: string } }

async function world() {
  fake = await startFakeApns(key.publicKey)
  const u = fake.url
  const clock = fakeClock(new Date().toISOString())
  // Every log line the push service writes about a device, so a test can tell "the pass accounted for everyone".
  const accounted: string[] = []
  const errors: string[] = []
  const log = {
    debug() {},
    info(_o: unknown, msg?: string) {
      if (msg === 'push sent' || msg === SKIPPED) accounted.push(msg)
    },
    warn() {},
    error(_o: unknown, msg?: string) {
      if (msg) errors.push(msg)
    },
    child() {
      return this
    },
  }
  const r = await startTestRelay({ clock, log: log as never, env: APNS_ENV, apnsAuthority: () => u })
  relay = r
  const db = r.relay.services.db
  const hdr = (deviceId: string) => ({
    'X-Test-Session': deviceId,
    Origin: ORIGIN,
    'X-Talos-CSRF': '1',
    'content-type': 'application/json',
  })
  /** The phone signs a new grant with fresh keys and the relay takes it: the old one is replaced. */
  const regrant = async (p: Phone) => {
    const keys = await createPhoneKeys()
    const grant = await signNativeGrant({
      deviceId: p.dev.deviceId,
      devicePrivateKey: p.dev.privateKey,
      encPub: keys.encPub,
      actPub: keys.actPub,
      nowMs: clock.now() + 1,
    })
    const res = await fetch(`${r.httpBase}/api/push/grant`, {
      method: 'POST',
      headers: hdr(p.dev.deviceId),
      body: JSON.stringify(grant),
    })
    expect(res.status).toBe(204)
  }
  const add = async (token: string): Promise<Phone> => {
    const dev = await createDeviceKey()
    db.prepare(
      'insert into auth_devices (id, name, pubkey_jwk, binding, pinned, revoked, created_at) values (?, ?, ?, ?, 1, 0, ?)',
    ).run(dev.deviceId, 'phone', JSON.stringify(dev.publicJwk), 'b', Date.now())
    const body = await signOwnerFrame(
      {
        v: 1,
        type: 'push.apns',
        op: 'register',
        device_id: dev.deviceId,
        token,
        env: 'sandbox',
        ts: new Date(clock.now()).toISOString(),
        nonce: `n${newUlid().toLowerCase()}`,
      },
      dev.privateKey,
    )
    const headers = hdr(dev.deviceId)
    expect(
      (await fetch(`${r.httpBase}/api/push/apns`, { method: 'POST', headers, body: JSON.stringify(body) })).status,
    ).toBe(204)
    const keys = await createPhoneKeys()
    const grant = await signNativeGrant({
      deviceId: dev.deviceId,
      devicePrivateKey: dev.privateKey,
      encPub: keys.encPub,
      actPub: keys.actPub,
      nowMs: clock.now(),
    })
    expect(
      (await fetch(`${r.httpBase}/api/push/grant`, { method: 'POST', headers, body: JSON.stringify(grant) })).status,
    ).toBe(204)
    return { dev, keys, token, grant } as Phone
  }
  const gone = await add(GONE_TOKEN)
  const keep = await add(KEEP_TOKEN)
  const bridge = await kit(r)
    .bridge({
      pinnedDevices: { [gone.dev.deviceId]: gone.dev.publicJwk, [keep.dev.deviceId]: keep.dev.publicJwk },
      consume: 'manual',
      verifyOwner: false,
      features: [NATIVE_ACT_FEATURE],
    })
    .connect()
  const first = (token: string) => {
    const q = fake?.requests.find((x) => x.token === token)
    if (!q) throw new Error(`no push reached ${token.slice(0, 4)}`)
    return q
  }
  const to = (token: string) => fake?.requests.filter((q) => q.token === token) ?? []
  /**
   * The next push pass loses `gone` the moment it has listed its devices (before sealing, before any send). When the pass
   * has accounted for both phones it is over; the log, not a sleep, says so.
   */
  const revokeMidPass = () => {
    const store = r.runtime.store
    const list = store.listPushDevices.bind(store)
    store.listPushDevices = () => {
      const rows = list()
      store.listPushDevices = list
      db.prepare('update auth_devices set revoked = 1 where id = ?').run(gone.dev.deviceId)
      return rows
    }
    accounted.length = 0
  }
  const passDone = () => waitFor(() => accounted.length >= 2, 10_000, 'both phones accounted for in the push pass')
  /** The Mac revokes `gone` (the row, as the revoke route writes it). */
  const revokeNow = (): void => {
    db.prepare('update auth_devices set revoked = 1 where id = ?').run(gone.dev.deviceId)
  }
  const fakeNow = () => fake as FakeApns
  return {
    fake: fakeNow,
    r,
    clock,
    gone,
    keep,
    bridge,
    to,
    first,
    revokeMidPass,
    revokeNow,
    regrant,
    passDone,
    accounted,
    errors,
    db,
  }
}
type World = Awaited<ReturnType<typeof world>>

/** The positive signal and the negative claim for one pass. */
async function expectOnlyKeepGotIt(w: World) {
  await w.passDone()
  expect(w.accounted.filter((m) => m === SKIPPED)).toHaveLength(1)
  expect(w.to(GONE_TOKEN)).toHaveLength(0)
  expect(w.to(KEEP_TOKEN).length).toBeGreaterThan(0)
  // and no request of any kind reached the revoked phone's token, so nothing it could read did either
  expect(w.fake().requests.filter((q) => q.token === GONE_TOKEN || q.rawBody.includes(GONE_TOKEN))).toHaveLength(0)
}

describe('a device revoked while a push is in flight gets nothing', () => {
  it('card: the revoked phone gets no push and no seal; the trusted phone still gets its sealed card', async () => {
    const w = await world()
    w.revokeMidPass()
    const card = w.bridge.createCard({
      thread_id: 'general',
      title: 'Archive old drafts',
      summary: 'Moves 12 drafts',
      body: 'Folder: Drafts',
    })
    await waitFor(() => w.to(KEEP_TOKEN).length >= 1, 10_000, 'the trusted phone push')
    await expectOnlyKeepGotIt(w)
    const t = w.first(KEEP_TOKEN).body.talos as { enc?: unknown; card_id?: string }
    const opened = await openPush({
      envelope: t.enc,
      encPrivate: w.keep.keys.enc.privateKey,
      deviceId: w.keep.dev.deviceId,
      kind: 'card',
      cardId: t.card_id,
    })
    expect(opened?.c).toBe(card.id)
  })

  it('reply: the revoked phone gets no push and none of the reply text; the trusted phone gets the sealed reply', async () => {
    const w = await world()
    w.revokeMidPass()
    w.bridge.reply('general', SECRET)
    await waitFor(() => w.to(KEEP_TOKEN).length >= 1, 10_000, 'the trusted phone push')
    await expectOnlyKeepGotIt(w)
    const t = w.first(KEEP_TOKEN).body.talos as { enc?: unknown }
    const opened = await openPush({
      envelope: t.enc,
      encPrivate: w.keep.keys.enc.privateKey,
      deviceId: w.keep.dev.deviceId,
      kind: 'reply',
    })
    expect(JSON.stringify(opened)).toContain(SECRET)
  })

  it('failed tap: the revoked phone is not told, the trusted phone is', async () => {
    const w = await world()
    // a tap from the trusted phone that the relay accepts and the Mac then refuses
    const grant = w.keep.grant
    const frame = await signNativeAct({
      deviceId: w.keep.dev.deviceId,
      id: newUlid(),
      ts: new Date(w.clock.now()).toISOString(),
      grant,
      body: { a: 'reply', thread_id: 'general', text: 'hello' },
      actPrivateKey: w.keep.keys.act.privateKey,
    })
    const res = await fetch(`${w.r.httpBase}/api/native/act`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(frame),
    })
    expect(res.status).toBe(200)
    w.revokeMidPass()
    w.bridge.send({ type: 'error', ref: frame.id, code: 'stale', message: SECRET })
    await waitFor(() => w.to(KEEP_TOKEN).length >= 1, 10_000, 'the failure push to the trusted phone')
    await expectOnlyKeepGotIt(w)
    expect((w.first(KEEP_TOKEN).body.aps as { alert: { body: string } }).alert.body).toBe(
      'That tap did not go through. Open Talos to check.',
    )
  })

  it('health: the revoked phone gets no "Mac session stopped"; the trusted phone does', async () => {
    const w = await world()
    await w.bridge.close()
    await waitFor(() => !w.r.relay.services.bus.bridgeOnline(), 5000, 'the relay sees the bridge gone')
    w.revokeMidPass()
    await advance(w.clock, 6 * 60_000)
    await waitFor(() => w.to(KEEP_TOKEN).length >= 1, 10_000, 'the health push to the trusted phone')
    await expectOnlyKeepGotIt(w)
    expect((w.first(KEEP_TOKEN).body.aps as { alert: { body: string } }).alert.body).toContain('Mac session stopped')
  })

  it('a grant removed while the seal is being made: the phone gets the fixed template, never a seal for the old grant', async () => {
    const w = await world()
    const store = w.r.runtime.store
    const real = store.nativeGrant.bind(store)
    let first = true
    // rich notifications are switched off for this phone right after the seal read its key
    store.nativeGrant = (id: string) => {
      const g = real(id)
      if (first && id === w.gone.dev.deviceId) {
        first = false
        store.deleteNativeGrant(id)
      }
      return g
    }
    w.accounted.length = 0
    w.bridge.reply('general', SECRET)
    await waitFor(() => w.to(GONE_TOKEN).length >= 1 && w.to(KEEP_TOKEN).length >= 1, 10_000, 'both pushes')
    await w.passDone()
    const sent = w.first(GONE_TOKEN)
    expect((sent.body.talos as { enc?: unknown }).enc).toBeUndefined()
    expect(sent.rawBody).not.toContain(SECRET)
    expect((w.first(KEEP_TOKEN).body.talos as { enc?: unknown }).enc).toBeDefined()
  })
})

// ---- the revoke lands while the pass is already inside its work ---------------------------------------------------

/** The seal of `gone` is held open while `act` runs; then it finishes for real. */
const duringSeal = (w: World, act: () => Promise<void> | void) => {
  seam.inSeal = async (deviceId) => {
    if (deviceId !== w.gone.dev.deviceId) return
    await act()
    await new Promise((res) => setImmediate(res))
  }
  w.accounted.length = 0
}
const templateOnly = (w: World, token: string) => {
  const sent = w.first(token)
  expect((sent.body.talos as { enc?: unknown }).enc).toBeUndefined()
  expect(sent.rawBody).not.toContain(SECRET)
}

it('revoked inside a sealPush that is still running: nothing is sent to that phone', async () => {
  const w = await world()
  duringSeal(w, () => w.revokeNow())
  w.bridge.reply('general', SECRET)
  await waitFor(() => w.to(KEEP_TOKEN).length >= 1, 10_000, 'the trusted phone push')
  await expectOnlyKeepGotIt(w)
})

it('two passes at once, both holding the revoked phone in their list: the revoke lands, it gets neither, the trusted phone both', async () => {
  const w = await world()
  // Both passes are inside their seal for the revoked phone (so both listed it) before the revoke lands.
  let inside = 0
  let bothIn: () => void = () => {}
  const both = new Promise<void>((res) => {
    bothIn = res
  })
  seam.inSeal = async (deviceId) => {
    if (deviceId !== w.gone.dev.deviceId) return
    if (++inside === 2) {
      w.revokeNow()
      bothIn()
    }
    await both
  }
  w.accounted.length = 0
  w.bridge.reply('general', `${SECRET} one`)
  w.bridge.reply('general', `${SECRET} two`)
  await waitFor(() => w.to(KEEP_TOKEN).length >= 2, 10_000, 'both pushes to the trusted phone')
  await waitFor(() => w.accounted.length >= 4, 10_000, 'both passes accounted for')
  expect(inside).toBe(2)
  expect(w.to(GONE_TOKEN)).toHaveLength(0)
  expect(w.accounted.filter((m) => m === SKIPPED)).toHaveLength(2)
})

it('grant replaced inside a running sealPush: the phone gets the fixed phrase, not words sealed for the old grant', async () => {
  const w = await world()
  duringSeal(w, () => w.regrant(w.gone))
  w.bridge.reply('general', SECRET)
  await waitFor(() => w.to(GONE_TOKEN).length >= 1 && w.to(KEEP_TOKEN).length >= 1, 10_000, 'both pushes')
  await w.passDone()
  templateOnly(w, GONE_TOKEN)
  expect((w.first(KEEP_TOKEN).body.talos as { enc?: unknown }).enc).toBeDefined()
})

it('grant expired inside a running sealPush: the phone gets the fixed phrase', async () => {
  const w = await world()
  duringSeal(w, () => {
    w.db
      .prepare('update core_native_grants set exp = ? where device_id = ?')
      .run(w.clock.now() - 1, w.gone.dev.deviceId)
  })
  w.bridge.reply('general', SECRET)
  await waitFor(() => w.to(GONE_TOKEN).length >= 1 && w.to(KEEP_TOKEN).length >= 1, 10_000, 'both pushes')
  await w.passDone()
  templateOnly(w, GONE_TOKEN)
})

it('declined (pinned = 0, through the Mac answering N) inside a running sealPush: nothing is sent', async () => {
  const w = await world()
  duringSeal(w, async () => {
    w.bridge.send({ type: 'device.pinned', device_id: w.gone.dev.deviceId, ok: false, reason: 'declined' })
    await waitFor(
      () =>
        (w.db.prepare('select pinned from auth_devices where id = ?').get(w.gone.dev.deviceId) as { pinned: number })
          .pinned === 0,
      5000,
      'the relay applied the decline',
    )
  })
  w.bridge.reply('general', SECRET)
  await waitFor(() => w.to(KEEP_TOKEN).length >= 1, 10_000, 'the trusted phone push')
  await expectOnlyKeepGotIt(w)
})

it('revoked during the PING wait on an idle connection: the sealed body is not sent', async () => {
  const w = await world()
  // a first push opens the connection to Apple
  w.bridge.reply('general', 'first')
  await waitFor(() => w.to(KEEP_TOKEN).length >= 1 && w.to(GONE_TOKEN).length >= 1, 10_000, 'the first pass')
  // the connection now counts as idle, so the next send checks it with a PING first
  const realNow = Date.now.bind(Date)
  vi.spyOn(Date, 'now').mockImplementation(() => realNow() + 10 * 60_000)
  const probe = http2.connect(w.fake().url)
  const proto = Object.getPrototypeOf(probe) as { ping: (...a: unknown[]) => unknown }
  probe.destroy()
  const ping = proto.ping
  let pings = 0
  vi.spyOn(proto, 'ping').mockImplementation(function (this: unknown, ...a: unknown[]) {
    pings++
    w.revokeNow()
    return ping.apply(this, a)
  })
  const before = w.to(GONE_TOKEN).length
  w.accounted.length = 0
  w.bridge.reply('general', SECRET)
  await waitFor(() => w.to(KEEP_TOKEN).length >= 2, 10_000, 'the second push to the trusted phone')
  await w.passDone()
  expect(pings).toBeGreaterThan(0) // the PING wait really happened
  expect(w.to(GONE_TOKEN)).toHaveLength(before)
  expect(w.fake().requests.some((q) => q.rawBody.includes(SECRET) && q.token === GONE_TOKEN)).toBe(false)
})

it('revoked between an ExpiredProviderToken answer and the repeat: the repeat is not sent', async () => {
  const w = await world()
  w.fake().reply(GONE_TOKEN, [{ status: 403, reason: 'ExpiredProviderToken' }, { status: 200 }])
  w.fake().onRequest((q) => {
    if (q.token === GONE_TOKEN) w.revokeNow()
  })
  w.accounted.length = 0
  w.bridge.reply('general', SECRET)
  await waitFor(() => w.to(KEEP_TOKEN).length >= 1, 10_000, 'the trusted phone push')
  await w.passDone()
  // the first attempt left while the phone was still trusted; the repeat did not
  expect(w.to(GONE_TOKEN)).toHaveLength(1)
  expect(w.accounted.filter((m) => m === SKIPPED)).toHaveLength(1)
})

// ---- a recheck that cannot be answered is a failed send, never "nobody to notify" -------------------------------------

it('a recheck that throws: no request goes out, the owner sees the error, and the pass counts it as a failed send', async () => {
  const w = await world()
  const store = w.r.runtime.store
  const real = store.pushDeviceLive.bind(store)
  store.pushDeviceLive = (id: string) => {
    if (id === w.gone.dev.deviceId) throw new Error('database is locked')
    return real(id)
  }
  const counts = await w.r.runtime.push.notifyCounted({ template: 'reply' }, { force: true })
  expect(w.to(GONE_TOKEN)).toHaveLength(0)
  expect(w.errors).toContain('push recheck failed; not sending')
  expect(w.accounted).not.toContain(SKIPPED) // it was not "no longer trusted"
  expect(counts).toMatchObject({ sent: 2, ok: 1, native: { sent: 2, ok: 1 } })
})

it('every recheck failing makes the test alert a 502, not a 409 "no device" and not a 204', async () => {
  const w = await world()
  const store = w.r.runtime.store
  store.pushDeviceLive = () => {
    throw new Error('database is locked')
  }
  const res = await fetch(`${w.r.httpBase}/api/push/test?via=apns`, {
    method: 'POST',
    headers: { 'X-Test-Session': w.keep.dev.deviceId, Origin: ORIGIN, 'X-Talos-CSRF': '1' },
  })
  expect(res.status).toBe(502)
  expect(w.fake().requests).toHaveLength(0)
})

it('a failed grant read for a phone that is still trusted sends the fixed phrase, not nothing', async () => {
  const w = await world()
  const store = w.r.runtime.store
  const real = store.nativeGrant.bind(store)
  let calls = 0
  // the read in sealFor works; the read in the recheck fails
  store.nativeGrant = (id: string) => {
    if (id === w.gone.dev.deviceId && ++calls >= 2) throw new Error('database is locked')
    return real(id)
  }
  w.accounted.length = 0
  w.bridge.reply('general', SECRET)
  await waitFor(() => w.to(GONE_TOKEN).length >= 1 && w.to(KEEP_TOKEN).length >= 1, 10_000, 'both pushes')
  await w.passDone()
  templateOnly(w, GONE_TOKEN)
  expect(w.errors).toContain('grant recheck failed; sending the fixed template')
})
