// "Why was that push plain?": the relay keeps, per phone, how its latest message push left (with its words or as the fixed
// phrase), why when plain, which seal it was, and when; Settings reads it from GET /api/push/apns. Real relay, real HTTP/2
// fake APNs, real store; a push is driven straight through the push service so each test knows when it is over. The sender's
// own reasons (too big, the gate's answer) are checked on the sender, where they are decided.
import {
  createDeviceKey,
  createPhoneKeys,
  type DeviceKey,
  newUlid,
  PLAIN_PUSH_REASONS,
  type RelayPlainReasonT,
  signNativeGrant,
  signOwnerFrame,
} from '@talos-app/protocol'
import { fakeClock, t } from '@talos-app/testkit'
import { afterEach, describe, expect, expectTypeOf, it, vi } from 'vitest'
import { type ApnsSender, createApnsSender } from '../../src/core/push-apns.ts'
import { pushLast, putPushLast, type SealWhy, type SenderWhy } from '../../src/core/push-last.ts'
import type { Logger } from '../../src/services.ts'
import { ORIGIN, startTestRelay, type TestRelay } from '../core/harness.ts'
import { type FakeApns, startFakeApns, testKey } from '../helpers/fake-apns.ts'
import { type RealRelay, startRealRelay } from '../review/real-relay.ts'

vi.setConfig({ testTimeout: t(30_000) }) // real relays and HTTP/2 fake APNs per test; scaled for a loaded machine

// sealPush and richContentFor run for real unless a test asks for a fault or holds the seal open.
const seam = vi.hoisted(() => ({
  inSeal: null as null | (() => Promise<void> | void),
  sealThrows: false,
  contentThrows: false,
}))
vi.mock('@talos-app/protocol', async (importOriginal) => {
  const real = await importOriginal<typeof import('@talos-app/protocol')>()
  return {
    ...real,
    sealPush: async (input: Parameters<typeof real.sealPush>[0]) => {
      await seam.inSeal?.()
      if (seam.sealThrows) throw new Error('seal broke')
      return real.sealPush(input)
    },
    richContentFor: (a: Parameters<typeof real.richContentFor>[0]) => {
      if (seam.contentThrows) throw new Error('no content')
      return real.richContentFor(a)
    },
  }
})

const TOKEN = 'd'.repeat(64)
const key = testKey()
const ENV = {
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

let relay: TestRelay | null = null
let real: RealRelay | null = null
let fake: FakeApns | null = null
afterEach(async () => {
  seam.inSeal = null
  seam.sealThrows = false
  seam.contentThrows = false
  vi.restoreAllMocks()
  await relay?.stop()
  await real?.stop()
  await fake?.close()
  relay = null
  real = null
  fake = null
})

type Last = { rich: boolean; reason?: string; id?: string; at: string }

async function world(o: { grant: boolean }) {
  fake = await startFakeApns(key.publicKey)
  const u = fake.url
  const clock = fakeClock(new Date().toISOString())
  const r = await startTestRelay({ clock, log: silent as never, env: ENV, apnsAuthority: () => u })
  relay = r
  const db = r.relay.services.db
  const dev: DeviceKey = await createDeviceKey()
  db.prepare(
    'insert into auth_devices (id, name, pubkey_jwk, binding, pinned, revoked, created_at) values (?, ?, ?, ?, 1, 0, ?)',
  ).run(dev.deviceId, 'phone', JSON.stringify(dev.publicJwk), 'b', Date.now())
  const headers = {
    'X-Test-Session': dev.deviceId,
    Origin: ORIGIN,
    'X-Talos-CSRF': '1',
    'content-type': 'application/json',
  }
  const register = async (token: string, op: 'register' | 'unregister' = 'register') => {
    const body = await signOwnerFrame(
      {
        v: 1,
        type: 'push.apns',
        op,
        device_id: dev.deviceId,
        ...(op === 'register' ? { token, env: 'sandbox' } : {}),
        ts: new Date(clock.now()).toISOString(),
        nonce: `n${newUlid().toLowerCase()}`,
      },
      dev.privateKey,
    )
    return (await fetch(`${r.httpBase}/api/push/apns`, { method: 'POST', headers, body: JSON.stringify(body) })).status
  }
  expect(await register(TOKEN)).toBe(204)
  if (o.grant) {
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
  }
  const status = async () =>
    (await (await fetch(`${r.httpBase}/api/push/apns`, { headers })).json()) as { registered: boolean; last?: Last }
  /** A reply push that carries its text, through the push service; resolves when the pass is over. */
  const push = (text = 'the quarterly plan is in the blue folder') =>
    r.runtime.push.notifyCounted({ template: 'reply', thread_id: 'general' }, { rich: { text } })
  const row = () => pushLast(db, dev.deviceId)
  const sealIdOnWire = (n = 0) => {
    const q = fake?.requests.filter((x) => x.token === TOKEN)[n]
    return ((q?.body.talos as { enc?: { id?: string } } | undefined)?.enc?.id ?? null) as string | null
  }
  return { r, clock, dev, headers, register, status, push, row, db, sealIdOnWire }
}

describe('the relay remembers how the latest message push to a phone left', () => {
  it('before any push there is nothing to say', async () => {
    const w = await world({ grant: true })
    expect((await w.status()).last ?? null).toBeNull()
  })

  it('a reply sent with its text is rich, with the seal id and the time', async () => {
    const w = await world({ grant: true })
    await w.push()
    const last = (await w.status()).last
    expect(last?.rich).toBe(true)
    expect(last?.reason).toBeUndefined()
    expect(last?.id).toBe(w.sealIdOnWire())
    expect(last?.id).toMatch(/^[A-Za-z0-9_-]{22}$/)
    expect(Date.parse(last?.at ?? '')).toBe(w.clock.now())
  })

  it('a phone with text off (no key registered) is plain: no_grant', async () => {
    const w = await world({ grant: false })
    await w.push()
    const last = (await w.status()).last
    expect(last).toMatchObject({ rich: false, reason: 'no_grant' })
    expect(last?.id).toBeUndefined()
  })

  it('a grant that has run out is grant_expired', async () => {
    const w = await world({ grant: true })
    w.db.prepare('update core_native_grants set exp = 1').run()
    await w.push()
    expect((await w.status()).last?.reason).toBe('grant_expired')
  })

  it('a grant the relay cannot read is grant_bad', async () => {
    const w = await world({ grant: true })
    w.db.prepare("update core_native_grants set grant_json = '{}'").run()
    await w.push()
    expect((await w.status()).last).toMatchObject({ rich: false, reason: 'grant_bad' })
  })

  it('a seal that fails is seal_failed', async () => {
    const w = await world({ grant: true })
    seam.sealThrows = true
    await w.push()
    expect((await w.status()).last).toMatchObject({ rich: false, reason: 'seal_failed' })
  })

  it('content that cannot be built is seal_failed too, not "no words"', async () => {
    const w = await world({ grant: true })
    seam.contentThrows = true
    await w.push()
    expect((await w.status()).last).toMatchObject({ rich: false, reason: 'seal_failed' })
  })

  it('a grant replaced while the push is leaving is grant_changed', async () => {
    const w = await world({ grant: true })
    seam.inSeal = () => void w.db.prepare("update core_native_grants set grant_json = grant_json || ' '").run()
    await w.push()
    expect((await w.status()).last).toMatchObject({ rich: false, reason: 'grant_changed' })
  })

  it('a grant check that fails while the push is leaving is seal_failed, not grant_changed', async () => {
    const w = await world({ grant: true })
    seam.inSeal = () => {
      const store = w.r.runtime.store
      store.nativeGrant = () => {
        throw new Error('locked')
      }
    }
    await w.push()
    expect((await w.status()).last).toMatchObject({ rich: false, reason: 'seal_failed' })
  })
})

describe('only a push that was given text writes the readout', () => {
  it('Send test, and a push with no text, leave a rich readout as it was', async () => {
    const w = await world({ grant: true })
    await w.push()
    const before = w.row()
    expect(before?.rich).toBe(true)
    w.clock.advance(5000)
    expect((await fetch(`${w.r.httpBase}/api/push/test`, { method: 'POST', headers: w.headers })).status).toBe(204)
    await w.r.runtime.push.notifyCounted({ template: 'reply', thread_id: 'general' }, { force: true })
    expect(w.row()).toEqual(before)
  })
})

describe('latest means the last push sent', () => {
  it('a slow older push that finishes after a newer one does not replace it', async () => {
    const w = await world({ grant: true })
    let release: () => void = () => {}
    const held = new Promise<void>((res) => {
      release = res
    })
    let entered: () => void = () => {}
    const inside = new Promise<void>((res) => {
      entered = res
    })
    seam.inSeal = async () => {
      seam.inSeal = null // only the first push waits
      entered()
      await held
    }
    const first = w.push('first, slow')
    await inside
    w.clock.advance(2000)
    w.db.prepare('delete from core_native_grants').run() // the second push finds no key: plain, no_grant
    await w.push('second, quick')
    expect(w.row()).toMatchObject({ rich: false, reason: 'no_grant' })
    release()
    await first // this one now sees its grant gone: plain, grant_changed, but it started first
    expect(w.row()).toMatchObject({ rich: false, reason: 'no_grant' })
  })
})

describe('what Apple said decides whether there is anything to write', () => {
  it('a push Apple refused leaves the readout unchanged', async () => {
    const w = await world({ grant: true })
    await w.push()
    const before = w.row()
    w.clock.advance(5000)
    fake?.reply(TOKEN, { status: 400, reason: 'BadDeviceToken' })
    await w.push()
    expect(w.row()).toEqual(before)
  })

  it('Apple saying the token is gone (410) deletes the readout with the token', async () => {
    const w = await world({ grant: true })
    await w.push()
    expect(w.row()).not.toBeNull()
    fake?.reply(TOKEN, { status: 410, reason: 'Unregistered' })
    await w.push()
    expect(w.row()).toBeNull()
  })
})

describe('the readout goes with the phone', () => {
  it('turning notifications off (unregister) deletes it', async () => {
    const w = await world({ grant: true })
    await w.push()
    expect(await w.register(TOKEN, 'unregister')).toBe(204)
    expect(w.row()).toBeNull()
  })

  it('registering the same token again (every app open) keeps it', async () => {
    const w = await world({ grant: true })
    await w.push()
    const before = w.row()
    expect(await w.register(TOKEN)).toBe(204)
    expect(w.row()).toEqual(before)
  })

  it('registering a different token (iOS rotated it) deletes it', async () => {
    const w = await world({ grant: true })
    await w.push()
    expect(await w.register('e'.repeat(64))).toBe(204)
    expect(w.row()).toBeNull()
  })

  it('GET hides a row when the phone has no token registered', async () => {
    const w = await world({ grant: true })
    await w.push()
    w.db.prepare('delete from core_push_devices').run() // the row is still there; the phone is not registered
    expect(w.row()).not.toBeNull()
    const s = await w.status()
    expect(s.registered).toBe(false)
    expect(s.last).toBeUndefined()
  })
})

describe('signing out and revoking delete it', () => {
  const TOKEN2 = 'f'.repeat(64)
  it.each([['/api/auth/logout'], ['/api/auth/logout-all']])('%s deletes the signed-out phone readout', async (path) => {
    real = await startRealRelay({ env: ENV })
    const o = await real.owner()
    const db = real.runtime.store.db
    real.runtime.store.putPushDevice({ deviceId: o.device.deviceId, token: TOKEN2, env: 'sandbox' })
    putPushLast(db, 1, o.device.deviceId, { rich: true, id: 'A'.repeat(22) })
    expect((await real.post(path, {}, o)).status).toBe(204)
    expect(pushLast(db, o.device.deviceId)).toBeNull()
  })

  it('revoking a device deletes its readout, and leaves the other phone alone', async () => {
    real = await startRealRelay({ env: ENV })
    const a = await real.owner()
    const b = await real.owner()
    const db = real.runtime.store.db
    putPushLast(db, 1, a.device.deviceId, { rich: false, reason: 'no_grant' })
    putPushLast(db, 1, b.device.deviceId, { rich: false, reason: 'no_grant' })
    expect((await real.post(`/api/devices/${a.device.deviceId}/revoke`, {}, b)).status).toBe(204)
    expect(pushLast(db, a.device.deviceId)).toBeNull()
    expect(pushLast(db, b.device.deviceId)).not.toBeNull()
  })
})

describe('the codes', () => {
  it('the codes the relay and the sender can write are exactly the relay codes the protocol lists', () => {
    expectTypeOf<SealWhy | SenderWhy>().toEqualTypeOf<RelayPlainReasonT>()
    expect(PLAIN_PUSH_REASONS.length).toBe(9)
  })
})

describe('the write: one row per phone, the newest start wins', () => {
  it('an older start does not replace a newer one; an equal or newer one does', async () => {
    const w = await world({ grant: false })
    putPushLast(w.db, 100, w.dev.deviceId, { rich: true, id: 'A'.repeat(22) })
    putPushLast(w.db, 50, w.dev.deviceId, { rich: false, reason: 'no_grant' })
    expect(w.row()).toMatchObject({ rich: true, at: 100 })
    putPushLast(w.db, 100, w.dev.deviceId, { rich: false, reason: 'too_big' })
    expect(w.row()).toMatchObject({ rich: false, reason: 'too_big', at: 100 })
    expect(w.db.prepare('select count(*) as n from core_push_last').get()).toEqual({ n: 1 })
  })
})

describe('the sender says which body it sent and why it was plain', () => {
  const reply = {
    web_push: 8030,
    notification: { title: 'Talos', body: 'New reply in a thread', navigate: '/', silent: false },
    talos: { v: 1, kind: 'reply' },
  } as const
  const dev = { token: TOKEN, env: 'sandbox' } as const
  const seal = (ct: string) => ({ v: 1, id: 'A'.repeat(22), epk: 'B'.repeat(87), iv: 'C'.repeat(16), ct }) as never

  async function sender() {
    fake = await startFakeApns(key.publicKey)
    const u = fake.url
    return createApnsSender({
      config: { keyId: 'KEYID12345', teamId: 'TEAMID1234', keyP8: key.p8, bundleId: 'com.example.talos' },
      clock: fakeClock(),
      log: silent,
      authority: () => u,
    }) as ApnsSender
  }

  it('a seal that fits goes as sealed', async () => {
    const s = await sender()
    const r = await s.send(dev, reply, { seal: seal('D'.repeat(200)) })
    s.close()
    expect(r.ok).toBe(true)
    expect(r.body).toBe('sealed')
    expect(r.plainWhy).toBeUndefined()
  })

  it('a seal that is over what Apple takes goes plain, too_big', async () => {
    const s = await sender()
    const r = await s.send(dev, reply, { seal: seal('D'.repeat(4000)) })
    s.close()
    expect(r.body).toBe('plain')
    expect(r.plainWhy).toBe('too_big')
  })

  it('a gate that says template with a seal in hand is grant_changed', async () => {
    const s = await sender()
    const r = await s.send(dev, reply, { seal: seal('D'.repeat(200)), gate: () => 'template' })
    s.close()
    expect(r.body).toBe('plain')
    expect(r.plainWhy).toBe('grant_changed')
  })

  it('a gate that gives its own reason has it passed back', async () => {
    const s = await sender()
    const r = await s.send(dev, reply, {
      seal: seal('D'.repeat(200)),
      gate: () => ({ pick: 'template', why: 'seal_failed' }),
    })
    s.close()
    expect(r.body).toBe('plain')
    expect(r.plainWhy).toBe('seal_failed')
  })

  it('no seal offered: plain, and no reason from the sender (the relay knows why)', async () => {
    const s = await sender()
    const r = await s.send(dev, reply)
    s.close()
    expect(r.body).toBe('plain')
    expect(r.plainWhy).toBeUndefined()
  })
})
