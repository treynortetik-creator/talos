// Rich notifications on the relay, end to end through the real routes: a phone registers a grant, pushes carry a seal only
// that phone can open, and a Reply / Approve tapped from a notification is checked, stored once, queued for the Mac,
// shown to the app, and undone when the Mac refuses it. Real relay, real HTTP/2 fake APNs, testkit bridge and app.
import {
  type ActBodyT,
  type CardT,
  cardNotice,
  composePermissionCard,
  createDeviceKey,
  createPhoneKeys,
  type DeviceKey,
  NATIVE_ACT_FEATURE,
  newUlid,
  openPush,
  shownHash,
  signNativeAct,
  signNativeGrant,
  signNativeGrantRevoke,
  signOwnerFrame,
} from '@talos-app/protocol'
import { type FakeClock, fakeClock, sleep, waitFor } from '@talos-app/testkit'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DEVICE_USE_INTERVAL_MS } from '../../src/auth/core.ts'
import { ORIGIN, startTestRelay, type TestRelay } from '../core/harness.ts'
import { kit } from '../core/helpers.ts'
import { type FakeApns, startFakeApns, testKey } from '../helpers/fake-apns.ts'
import { startRealRelay } from '../review/real-relay.ts'

vi.setConfig({ testTimeout: 30_000 })

const DAY = 86_400_000
const TOKEN = 'a'.repeat(64)
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
  await relay?.stop()
  await fake?.close()
  relay = null
  fake = null
})

async function world() {
  fake = await startFakeApns(key.publicKey)
  const clock = fakeClock(new Date().toISOString())
  const u = fake.url
  relay = await startTestRelay({ clock, env: APNS_ENV, apnsAuthority: () => u })
  const r = relay
  const dev = await createDeviceKey()
  r.relay.services.db
    .prepare(
      'insert into auth_devices (id, name, pubkey_jwk, binding, pinned, revoked, created_at) values (?, ?, ?, ?, 1, 0, ?)',
    )
    .run(dev.deviceId, 'phone', JSON.stringify(dev.publicJwk), 'b', Date.now())
  const phone = await createPhoneKeys()
  const k = kit(r)
  return { r, clock, dev, phone, k, fake }
}
type World = Awaited<ReturnType<typeof world>>

const sessionHeaders = (deviceId: string) => ({
  'X-Test-Session': deviceId,
  Origin: ORIGIN,
  'X-Talos-CSRF': '1',
  'content-type': 'application/json',
})
const postJson = (w: World, path: string, body: unknown, headers: Record<string, string>) =>
  fetch(`${w.r.httpBase}${path}`, {
    method: 'POST',
    headers,
    body: typeof body === 'string' ? body : JSON.stringify(body),
  })

async function registerToken(w: World, who: { deviceId: string; privateKey: CryptoKey } = w.dev, token = TOKEN) {
  const body = await signOwnerFrame(
    {
      v: 1,
      type: 'push.apns',
      op: 'register',
      device_id: who.deviceId,
      token,
      env: 'sandbox',
      ts: new Date(w.clock.now()).toISOString(),
      nonce: `n${newUlid().toLowerCase()}`,
    },
    who.privateKey,
  )
  expect((await postJson(w, '/api/push/apns', body, sessionHeaders(who.deviceId))).status).toBe(204)
}

async function grantBody(w: World, over: { ttlMs?: number; scopes?: string[] } = {}) {
  return signNativeGrant({
    deviceId: w.dev.deviceId,
    devicePrivateKey: w.dev.privateKey,
    encPub: w.phone.encPub,
    actPub: w.phone.actPub,
    nowMs: w.clock.now(),
    ...over,
  })
}
async function registerGrant(w: World, over: { ttlMs?: number; scopes?: string[] } = {}) {
  const grant = await grantBody(w, over)
  const res = await postJson(w, '/api/push/grant', grant, sessionHeaders(w.dev.deviceId))
  expect(res.status).toBe(204)
  return grant
}

/** What the phone's background process posts: no cookie, no CSRF, no session. */
async function tapBody(
  w: World,
  grant: Record<string, unknown> & { osig: string },
  body: ActBodyT,
  over: { id?: string; ts?: number } = {},
) {
  return signNativeAct({
    deviceId: w.dev.deviceId,
    id: over.id ?? newUlid(),
    ts: new Date(over.ts ?? w.clock.now()).toISOString(),
    grant,
    body,
    actPrivateKey: w.phone.act.privateKey,
  })
}
const sendTap = (w: World, frame: unknown) =>
  fetch(`${w.r.httpBase}/api/native/act`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(frame),
  })

const cardInput = {
  thread_id: 'general',
  title: 'Archive old drafts',
  summary: 'Moves 12 drafts',
  body: 'Folder: Drafts',
}
const approveBody = (card: CardT, shown = shownHash(cardNotice(card).text, 'General')): ActBodyT => ({
  a: 'approve',
  card_id: card.id,
  payload_hash: card.payload_hash,
  shown,
})

async function bridgeFor(w: World, features: string[] = [NATIVE_ACT_FEATURE]) {
  return w.k
    .bridge({ pinnedDevices: { [w.dev.deviceId]: w.dev.publicJwk }, consume: 'manual', verifyOwner: false, features })
    .connect()
}
const outboxRows = (w: World) =>
  (w.r.relay.services.db.prepare('select count(*) n from core_outbox').get() as { n: number }).n
const eventRows = (w: World, type: string) =>
  (w.r.relay.services.db.prepare('select count(*) n from core_events where type = ?').get(type) as { n: number }).n

describe('the three new routes are declared and guarded', () => {
  it('the relay boots with them (default-deny route table), and GET /api/push/grant needs a session', async () => {
    const w = await world()
    expect((await fetch(`${w.r.httpBase}/api/push/grant`)).status).toBe(401)
    expect(
      (await postJson(w, '/api/push/grant', {}, { 'content-type': 'application/json', Origin: ORIGIN })).status,
    ).toBe(401)
  })
  it('POST /api/native/act takes no cookie but answers junk, wrong shapes and unknown devices with a refusal', async () => {
    const w = await world()
    for (const junk of ['not json', {}, [], null, { device_id: w.dev.deviceId }]) {
      const res = await sendTap(w, junk)
      expect(res.status, JSON.stringify(junk)).toBe(401)
      // The refusal must not say what the route expects.
      expect(await res.json()).toEqual({ error: 'bad_signature' })
    }
    const grant = await grantBody(w)
    const stranger = await createDeviceKey()
    const frame = await signNativeAct({
      deviceId: stranger.deviceId,
      id: newUlid(),
      ts: new Date(w.clock.now()).toISOString(),
      grant,
      body: { a: 'reply', thread_id: 'general', text: 'x' },
      actPrivateKey: w.phone.act.privateKey,
    })
    const res = await sendTap(w, frame)
    expect(res.status).toBe(401)
    expect(await res.json()).toEqual({ error: 'bad_signature' })
  })
  it('an unknown device and a revoked device get the same answer, byte for byte, as an unsigned frame', async () => {
    const w = await world()
    const grant = await registerGrant(w)
    const body = { a: 'reply', thread_id: 'general', text: 'x' } as ActBodyT
    const answer = async (frame: unknown) => {
      const res = await sendTap(w, frame)
      return { status: res.status, type: res.headers.get('content-type'), body: await res.text() }
    }
    const unsigned = await answer({})
    // a device id nobody registered, replaying the first phone's grant
    const stranger = await createDeviceKey()
    const unknown = await answer(
      await signNativeAct({
        deviceId: stranger.deviceId,
        id: newUlid(),
        ts: new Date(w.clock.now()).toISOString(),
        grant,
        body,
        actPrivateKey: w.phone.act.privateKey,
      }),
    )
    // the first phone, once the Mac has revoked it, and one the Mac never pinned
    w.r.relay.services.db.prepare('update auth_devices set revoked = 1 where id = ?').run(w.dev.deviceId)
    const revoked = await answer(await tapBody(w, grant, body))
    const loose = await createDeviceKey()
    w.r.relay.services.db
      .prepare(
        'insert into auth_devices (id, name, pubkey_jwk, binding, pinned, revoked, created_at) values (?, ?, ?, ?, 0, 0, ?)',
      )
      .run(loose.deviceId, 'unpinned', JSON.stringify(loose.publicJwk), 'b', Date.now())
    const unpinned = await answer(
      await signNativeAct({
        deviceId: loose.deviceId,
        id: newUlid(),
        ts: new Date(w.clock.now()).toISOString(),
        grant,
        body,
        actPrivateKey: w.phone.act.privateKey,
      }),
    )
    expect(unsigned.status).toBe(401)
    expect(JSON.parse(unsigned.body)).toEqual({ error: 'bad_signature' })
    expect(unknown).toEqual(unsigned)
    expect(revoked).toEqual(unsigned)
    expect(unpinned).toEqual(unsigned)
    expect(outboxRows(w)).toBe(0)
  })
  it('a pinned, unrevoked device id cannot be told from a stranger by an unsigned caller, with or without a held grant', async () => {
    const w = await world()
    const grant = await registerGrant(w)
    const body = { a: 'reply', thread_id: 'general', text: 'x' } as ActBodyT
    const answer = async (frame: unknown) => {
      const res = await sendTap(w, frame)
      return { status: res.status, type: res.headers.get('content-type'), body: await res.text() }
    }
    const stranger = await createDeviceKey()
    const signed = (await tapBody(w, grant, body)) as unknown as { grant: string; asig: string; device_id: string }
    const forged = (over: object) => ({ ...signed, asig: 'A'.repeat(86), ...over })
    const baseline = await answer(forged({ device_id: stranger.deviceId }))
    // pinned device, a grant that is not the held one
    const wrongGrant = await answer(forged({ grant: '{"not":"it"}' }))
    // pinned device, the held grant, a signature that is not valid
    const badSig = await answer(forged({}))
    // pinned device whose grant row is gone
    w.r.relay.services.db.prepare('delete from core_native_grants where device_id = ?').run(w.dev.deviceId)
    const noGrant = await answer(forged({}))
    expect(baseline).toMatchObject({ status: 401 })
    expect(JSON.parse(baseline.body)).toEqual({ error: 'bad_signature' })
    expect(wrongGrant).toEqual(baseline)
    expect(noGrant).toEqual(baseline)
    // Past the grant check the caller has proven it holds the exact grant string, so a bad act signature may say so (still 401).
    expect(badSig.status).toBe(401)
  })
})

describe('grant registration', () => {
  it('registers, reports status without keys, and takes a signed revoke', async () => {
    const w = await world()
    const status = async () =>
      (await (
        await fetch(`${w.r.httpBase}/api/push/grant`, { headers: sessionHeaders(w.dev.deviceId) })
      ).json()) as Record<string, unknown>
    expect(await status()).toEqual({ registered: false })
    await registerGrant(w)
    const s = await status()
    expect(s.registered).toBe(true)
    expect(JSON.stringify(s)).not.toContain(w.phone.encPub)
    const revoke = await signNativeGrantRevoke({
      deviceId: w.dev.deviceId,
      devicePrivateKey: w.dev.privateKey,
      nowMs: w.clock.now(),
    })
    expect((await postJson(w, '/api/push/grant', revoke, sessionHeaders(w.dev.deviceId))).status).toBe(204)
    expect(await status()).toEqual({ registered: false })
  })
  it("refuses another device's grant, a replay, a tampered grant and a stale one", async () => {
    const w = await world()
    const grant = await grantBody(w)
    const other = await createDeviceKey()
    w.r.relay.services.db
      .prepare(
        'insert into auth_devices (id, name, pubkey_jwk, binding, pinned, revoked, created_at) values (?, ?, ?, ?, 1, 0, ?)',
      )
      .run(other.deviceId, 'other', JSON.stringify(other.publicJwk), 'b', Date.now())
    expect((await postJson(w, '/api/push/grant', grant, sessionHeaders(other.deviceId))).status).toBe(403)
    expect(
      (await postJson(w, '/api/push/grant', { ...grant, act_pub: w.phone.encPub }, sessionHeaders(w.dev.deviceId)))
        .status,
    ).toBe(401)
    expect((await postJson(w, '/api/push/grant', grant, sessionHeaders(w.dev.deviceId))).status).toBe(204)
    expect((await postJson(w, '/api/push/grant', grant, sessionHeaders(w.dev.deviceId))).status).toBe(409)
    w.clock.advance(5 * 60_000)
    expect((await postJson(w, '/api/push/grant', await grantBody(w, {}), sessionHeaders(w.dev.deviceId))).status).toBe(
      204,
    )
  })
  it('a missing grant refuses a tap at once (the row deleted directly; the real sign-out routes are tested below)', async () => {
    const w = await world()
    const grant = await registerGrant(w)
    w.r.relay.services.db.prepare('delete from core_native_grants where device_id = ?').run(w.dev.deviceId)
    const res = await sendTap(w, await tapBody(w, grant, { a: 'reply', thread_id: 'general', text: 'late' }))
    expect(res.status).toBe(401)
    expect(((await res.json()) as { error: string }).error).toBe('bad_signature')
    expect(eventRows(w, 'native.act')).toBe(0)
  })
})

describe('a sealed push, through real APNs framing', () => {
  it('carries the card words only inside a seal this phone can open, and no button for a card that leaves the app', async () => {
    const w = await world()
    await registerToken(w)
    await registerGrant(w)
    const bridge = await bridgeFor(w)
    const card = bridge.createCard(cardInput)
    await waitFor(() => w.fake.requests.length >= 1, 8000, 'a push')
    const req = w.fake.requests[0]!
    expect(req.rawBody).not.toContain('Archive old drafts') // Apple sees the fixed template only
    const talos = req.body.talos as { enc?: unknown; card_id?: string }
    const opened = await openPush({
      envelope: talos.enc,
      encPrivate: w.phone.enc.privateKey,
      deviceId: w.dev.deviceId,
      kind: 'card',
      cardId: talos.card_id,
    })
    expect(opened?.b).toBe(cardNotice(card).text)
    expect(opened?.s).toBe('General') // the subtitle the phone shows, and signs into `shown`
    expect(opened?.c).toBe(card.id)
    expect(opened?.h).toBe(card.payload_hash)
    // an email card: words, but no card id/hash to approve with
    const email = bridge.createCard({
      ...cardInput,
      kind: 'email',
      title: 'Tidy up inbox',
      destination: [{ label: 'To', value: 'ceo@example.com' }],
    })
    await waitFor(() => w.fake.requests.length >= 2, 8000, 'a second push')
    const t2 = w.fake.requests[1]!.body.talos as { enc?: unknown; card_id?: string }
    const o2 = await openPush({
      envelope: t2.enc,
      encPrivate: w.phone.enc.privateKey,
      deviceId: w.dev.deviceId,
      kind: 'card',
      cardId: t2.card_id,
    })
    expect(o2?.b).toContain('ceo@example.com')
    expect(o2?.c).toBeUndefined()
    expect(email.kind).toBe('email')
  })
  it('stays the fixed template for a phone without a grant', async () => {
    const w = await world()
    await registerToken(w)
    const bridge = await bridgeFor(w)
    bridge.createCard(cardInput)
    await waitFor(() => w.fake.requests.length >= 1, 8000, 'a push')
    expect((w.fake.requests[0]!.body.talos as { enc?: unknown }).enc).toBeUndefined()
  })
})

describe('sign-out through the real routes (real auth, real session cookie)', () => {
  it.each([['/api/auth/logout'], ['/api/auth/logout-all']])(
    '%s deletes the grant, and the same signed tap that worked a moment ago is refused',
    async (path) => {
      const real = await startRealRelay({ env: APNS_ENV })
      try {
        const o = await real.owner()
        const phone = await createPhoneKeys()
        const grant = await signNativeGrant({
          deviceId: o.device.deviceId,
          devicePrivateKey: o.device.privateKey,
          encPub: phone.encPub,
          actPub: phone.actPub,
          nowMs: Date.now(),
        })
        expect((await real.post('/api/push/grant', grant, o)).status).toBe(204)
        const tapOf = async (text: string) =>
          signNativeAct({
            deviceId: o.device.deviceId,
            id: newUlid(),
            ts: new Date().toISOString(),
            grant,
            body: { a: 'reply', thread_id: 'general', text },
            actPrivateKey: phone.act.privateKey,
          })
        const post = (f: unknown) => real.post('/api/native/act', f, null)
        expect((await post(await tapOf('before'))).status).toBe(200) // the control: the grant works
        expect((await real.post(path, {}, o)).status).toBe(204)
        const after = await post(await tapOf('after'))
        expect(after.status).toBe(401)
        expect(((await after.json()) as { error: string }).error).toBe('bad_signature')
        expect(
          real.relay.services.db.prepare('select count(*) n from core_native_grants').get() as { n: number },
        ).toEqual({ n: 0 })
      } finally {
        await real.stop()
      }
    },
  )
})

describe('a notification action is real use of the phone', () => {
  it("a signed tap moves the phone's last-used time; a tap that fails its signature does not", async () => {
    const clock = fakeClock(new Date().toISOString())
    const real = await startRealRelay({ env: APNS_ENV, clock })
    try {
      const o = await real.owner()
      const phone = await createPhoneKeys()
      const grant = await signNativeGrant({
        deviceId: o.device.deviceId,
        devicePrivateKey: o.device.privateKey,
        encPub: phone.encPub,
        actPub: phone.actPub,
        nowMs: clock.now(),
      })
      expect((await real.post('/api/push/grant', grant, o)).status).toBe(204)
      const lastUsed = () => real.auth.core.device(o.device.deviceId)?.lastUsedAt ?? null
      const seen = lastUsed() // the cookie request above was use too
      clock.advance(DEVICE_USE_INTERVAL_MS + 1000)
      const tapWith = async (actKey: CryptoKey) =>
        signNativeAct({
          deviceId: o.device.deviceId,
          id: newUlid(),
          ts: new Date(clock.now()).toISOString(),
          grant,
          body: { a: 'reply', thread_id: 'general', text: 'hi' },
          actPrivateKey: actKey,
        })
      const post = (f: unknown) => real.post('/api/native/act', f, null)
      const stranger = await createPhoneKeys()
      expect((await post(await tapWith(stranger.act.privateKey))).status).toBe(401) // someone else's key
      expect(lastUsed()).toBe(seen) // an unproven caller cannot make a device look alive
      expect((await post(await tapWith(phone.act.privateKey))).status).toBe(200)
      expect(lastUsed()).toBe(clock.now())
    } finally {
      await real.stop()
    }
  })
})

describe('Reply from a notification', () => {
  it('while the Mac is asleep: answered ok, queued, shown to the app on catch-up, and the Mac later gets it stamped at the tap', async () => {
    const w = await world()
    const grant = await registerGrant(w)
    // the app was open once and then closed (web view gone), so it only knows the seq it last saw
    const before = await w.k.connectedApp({ deviceKey: w.dev as DeviceKey })
    const early = await bridgeFor(w)
    early.reply('general', 'earlier answer')
    await before.expectFrame('reply')
    const seen = before.lastSeq
    expect(seen).toBeGreaterThan(0)
    await before.close()
    await early.close() // the Mac goes to sleep
    const tappedAt = w.clock.now()
    const frame = await tapBody(w, grant, { a: 'reply', thread_id: 'general', text: 'on my way' })
    const res = await sendTap(w, frame)
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true, duplicate: false })
    expect(outboxRows(w)).toBe(1)

    // the owner opens the app (no live socket was open at the tap): the question is in catch-up
    const app = await w.k.connectedApp({ deviceKey: w.dev as DeviceKey, lastSeq: seen })
    const batch = (await app.expectFrame('catchup.batch')).frames as Array<Record<string, any>>
    const stored = batch.find((f) => f.type === 'message.stored' && f.message?.text === 'on my way')
    expect(stored?.message.author).toBe('owner')
    expect(stored?.message.thread_id).toBe('general')

    // 15 minutes later the Mac wakes and gets the same signed bytes, stamped with the time of the tap
    w.clock.advance(15 * 60_000)
    const bridge = await bridgeFor(w)
    const got = await bridge.expectFrame('native.act', (f) => f.id === frame.id, { direction: 'in' })
    expect(Date.parse(got.relay!.received_at)).toBe(tappedAt)
  })
  it('a really signed frame with a malformed action body keeps its own 400, distinct from the unsigned 401', async () => {
    const w = await world()
    const grant = await registerGrant(w)
    const frame = await tapBody(w, grant, { a: 'reply', thread_id: 'general', text: '   ' })
    const res = await sendTap(w, frame)
    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({ error: 'bad_body' })
    // the same frame with one signature byte changed is unproven: 401, not 400
    const forged = { ...frame, asig: `${frame.asig.slice(0, -2)}${frame.asig.endsWith('AA') ? 'BB' : 'AA'}` }
    expect((await sendTap(w, forged)).status).toBe(401)
    expect(outboxRows(w)).toBe(0)
  })
  it('an unknown thread is refused and leaves no claim, so the same bytes cannot be "done" later', async () => {
    const w = await world()
    const grant = await registerGrant(w)
    const frame = await tapBody(w, grant, { a: 'reply', thread_id: 'no_such_thread', text: 'x' })
    expect((await sendTap(w, frame)).status).toBe(404)
    expect(outboxRows(w)).toBe(0)
    expect(w.r.relay.services.db.prepare('select count(*) n from core_native_acts').get()).toEqual({ n: 0 })
  })
  it('the same tap sent twice at once is queued once', async () => {
    const w = await world()
    const grant = await registerGrant(w)
    const frame = await tapBody(w, grant, { a: 'reply', thread_id: 'general', text: 'once' })
    const out = await Promise.all([sendTap(w, frame), sendTap(w, frame)])
    const bodies = (await Promise.all(out.map((r) => r.json()))) as Array<{ duplicate: boolean }>
    expect(bodies.map((b) => b.duplicate).sort()).toEqual([false, true])
    expect(outboxRows(w)).toBe(1)
    expect(eventRows(w, 'native.act')).toBe(1)
    // the same id with other words is a replay, not a second reply
    const forged = await tapBody(w, grant, { a: 'reply', thread_id: 'general', text: 'twice' }, { id: frame.id })
    expect((await sendTap(w, forged)).status).toBe(409)
  })
  it('a failed write leaves nothing behind: no claim, no event, no queue row, and the retry works', async () => {
    const w = await world()
    const grant = await registerGrant(w)
    const frame = await tapBody(w, grant, { a: 'reply', thread_id: 'general', text: 'retry me' })
    const store = w.r.runtime.store
    const real = store.enqueueOutbox.bind(store)
    let failed = false
    store.enqueueOutbox = (...a: Parameters<typeof real>) => {
      if (!failed) {
        failed = true
        throw new Error('disk full')
      }
      return real(...a)
    }
    expect((await sendTap(w, frame)).status).toBe(500)
    expect(eventRows(w, 'native.act')).toBe(0)
    expect(eventRows(w, 'message.stored')).toBe(0)
    expect(w.r.relay.services.db.prepare('select count(*) n from core_native_acts').get()).toEqual({ n: 0 })
    const retry = await sendTap(w, frame)
    expect(await retry.json()).toEqual({ ok: true, duplicate: false })
    expect(outboxRows(w)).toBe(1)
  })
  it('a Mac that never comes back gets a not_delivered receipt for the reply, like any other message', async () => {
    const w = await world()
    const grant = await registerGrant(w)
    const app = await w.k.connectedApp({ deviceKey: w.dev as DeviceKey, visible: false })
    const frame = await tapBody(w, grant, { a: 'reply', thread_id: 'general', text: 'anyone there' })
    expect((await sendTap(w, frame)).status).toBe(200)
    w.clock.set(w.clock.now() + 8 * DAY)
    w.r.runtime.hub.sweep()
    const rec = await app.expectFrame('receipt', (f) => f.message_id === `m_${frame.id}`, { direction: 'in' })
    expect(rec.state).toBe('not_delivered')
    expect(w.r.runtime.store.outboxDepth()).toBe(0)
  })
})

describe('Approve from a notification', () => {
  async function pendingCard(w: World, bridge: Awaited<ReturnType<typeof bridgeFor>>, extra: Partial<CardT> = {}) {
    const card = bridge.createCard({ ...cardInput, ...extra })
    await waitFor(() => w.r.runtime.store.getCard(card.id) !== null, 5000, 'the card at the relay')
    return card
  }

  it('resolves the card on the relay, queues the tap for the Mac, and answers ok', async () => {
    const w = await world()
    const grant = await registerGrant(w)
    const bridge = await bridgeFor(w)
    const card = await pendingCard(w, bridge)
    const frame = await tapBody(w, grant, approveBody(card))
    expect(await (await sendTap(w, frame)).json()).toEqual({ ok: true, duplicate: false })
    expect(w.r.runtime.store.getCard(card.id)?.state).toBe('resolved')
    await bridge.expectFrame('native.act', (f) => f.id === frame.id, { direction: 'in' })
  })

  it('the subtitle is part of what was shown: a hash of the body alone or with another thread name is refused', async () => {
    const w = await world()
    const grant = await registerGrant(w)
    const bridge = await bridgeFor(w)
    const card = await pendingCard(w, bridge)
    for (const shown of [shownHash(cardNotice(card).text), shownHash(cardNotice(card).text, 'Payroll')]) {
      const res = await sendTap(w, await tapBody(w, grant, approveBody(card, shown)))
      expect(res.status).toBe(409)
      expect(((await res.json()) as { error: string }).error).toBe('card_hash_mismatch')
    }
    expect(w.r.runtime.store.getCard(card.id)?.state).toBe('pending')
  })

  it('refuses words the relay did not build from this card, a high-risk card, and a card that leaves the app', async () => {
    const w = await world()
    const grant = await registerGrant(w)
    const bridge = await bridgeFor(w)
    const card = await pendingCard(w, bridge)
    const lie = await sendTap(w, await tapBody(w, grant, approveBody(card, shownHash('Approve archive of old drafts'))))
    expect(lie.status).toBe(409)
    expect(((await lie.json()) as { error: string }).error).toBe('card_hash_mismatch')
    const high = await pendingCard(w, bridge, { risk: 'high', title: 'Pay the invoice' })
    const h = await sendTap(w, await tapBody(w, grant, approveBody(high)))
    expect(((await h.json()) as { error: string }).error).toBe('stepup_required')
    const email = await pendingCard(w, bridge, {
      kind: 'email',
      title: 'Tidy up inbox',
      destination: [{ label: 'To', value: 'ceo@example.com' }],
    })
    // The real text and subtitle are signed, so the words check would pass and only the "whole card" gate can refuse it.
    const real = (c: CardT) => shownHash(cardNotice(c).text, 'General')
    const e = await sendTap(w, await tapBody(w, grant, approveBody(email, real(email))))
    expect(((await e.json()) as { error: string }).error).toBe('open_in_app')
    for (const c of [card, high, email]) expect(w.r.runtime.store.getCard(c.id)?.state).toBe('pending')
    expect(outboxRows(w)).toBe(0)
  })

  it('refuses a generic, low-risk card that names a destination, and its push carries no Approve', async () => {
    const w = await world()
    await registerToken(w)
    const grant = await registerGrant(w)
    const bridge = await bridgeFor(w)
    const outward = await pendingCard(w, bridge, {
      kind: 'generic',
      risk: 'low',
      title: 'Tidy up',
      destination: [{ label: 'To', value: 'ceo@example.com' }],
    })
    expect(cardNotice(outward).complete).toBe(false)
    const res = await sendTap(
      w,
      await tapBody(w, grant, approveBody(outward, shownHash(cardNotice(outward).text, 'General'))),
    )
    expect(((await res.json()) as { error: string }).error).toBe('open_in_app')
    expect(w.r.runtime.store.getCard(outward.id)?.state).toBe('pending')
    expect(outboxRows(w)).toBe(0)
    await waitFor(() => w.fake.requests.length >= 1, 8000, 'the card push')
    for (const r of w.fake.requests) {
      const t = r.body.talos as { enc?: unknown; card_id?: string }
      const o = await openPush({
        envelope: t.enc,
        encPrivate: w.phone.enc.privateKey,
        deviceId: w.dev.deviceId,
        kind: 'card',
        cardId: t.card_id,
      })
      expect(o).not.toBeNull()
      expect(o?.c).toBeUndefined() // the sealed content names no card, so the phone cannot build an Approve
    }
  })

  const permissionCard = (w: World, id: string, over: Partial<Parameters<typeof composePermissionCard>[0]> = {}) =>
    composePermissionCard({
      request: { request_id: id, tool_name: 'Read', description: 'Read a file', input_preview: `/home/alex/${id}.txt` },
      card_id: `c_${newUlid()}`,
      thread_id: 'general',
      now: w.clock.now(),
      client_version: '2.1.234',
      ...over,
    })

  it('sends a deny-only permission card with the Open-only category, sealed or not, and a normal card with Approve', async () => {
    for (const withGrant of [false, true]) {
      const w = await world()
      await registerToken(w)
      if (withGrant) await registerGrant(w)
      const bridge = await bridgeFor(w)
      const ok = permissionCard(w, 'abcde')
      const denyOnly = permissionCard(w, 'fghij', { repeated: true })
      bridge.send({ type: 'card.create', card: ok })
      bridge.send({ type: 'card.create', card: denyOnly })
      await waitFor(() => w.fake.requests.length >= 2, 8000, 'two pushes')
      const byCard = new Map(
        w.fake.requests.map((r) => [
          (r.body.talos as { card_id?: string }).card_id,
          r.body.aps as { category: string },
        ]),
      )
      expect(byCard.get(denyOnly.id)?.category, `deny-only, grant=${withGrant}`).toBe('TALOS_OPEN')
      expect(byCard.get(ok.id)?.category, `allowed, grant=${withGrant}`).toBe('TALOS_CARD')
      await relay?.stop()
      await fake?.close()
      relay = null
      fake = null
    }
  })

  it('refuses to approve a deny-only permission card from a notification, and its push carries no Approve', async () => {
    const w = await world()
    await registerToken(w)
    const grant = await registerGrant(w)
    const bridge = await bridgeFor(w)
    const thread = 'general'
    const ok = composePermissionCard({
      request: {
        request_id: 'abcde',
        tool_name: 'Read',
        description: 'Read a file',
        input_preview: '/home/alex/a.txt',
      },
      card_id: `c_${newUlid()}`,
      thread_id: thread,
      now: w.clock.now(),
      client_version: '2.1.234',
    })
    const denyOnly = composePermissionCard({
      request: {
        request_id: 'fghij',
        tool_name: 'Read',
        description: 'Read a file',
        input_preview: '/home/alex/b.txt',
      },
      card_id: `c_${newUlid()}`,
      thread_id: thread,
      now: w.clock.now(),
      repeated: true,
      client_version: '2.1.234',
    })
    expect(cardNotice(ok).complete).toBe(true)
    for (const c of [ok, denyOnly]) bridge.send({ type: 'card.create', card: c })
    await waitFor(() => w.r.runtime.store.getCard(denyOnly.id) !== null, 5000, 'the card at the relay')
    await waitFor(() => w.fake.requests.length >= 2, 8000, 'two pushes')
    const cardIds: Array<string | undefined> = []
    for (const r of w.fake.requests) {
      const t = r.body.talos as { enc?: unknown; card_id?: string }
      const o = await openPush({
        envelope: t.enc,
        encPrivate: w.phone.enc.privateKey,
        deviceId: w.dev.deviceId,
        kind: 'card',
        cardId: t.card_id,
      })
      cardIds.push(o?.c)
    }
    expect(cardIds).toContain(ok.id)
    expect(cardIds).not.toContain(denyOnly.id)
    const res = await sendTap(w, await tapBody(w, grant, approveBody(denyOnly)))
    expect(res.status).toBe(403)
    expect(((await res.json()) as { error: string }).error).toBe('open_in_app')
    expect(w.r.runtime.store.getCard(denyOnly.id)?.state).toBe('pending')
    expect(outboxRows(w)).toBe(0)
  })

  it('a tap from a device the Mac has revoked is refused at the relay, queues nothing, and its old grant stops sealing', async () => {
    const w = await world()
    await registerToken(w)
    // A second phone the Mac still trusts. Its push is the positive signal that a card's push pass has finished.
    const keep = await createDeviceKey()
    const KEEP_TOKEN = 'b'.repeat(64)
    w.r.relay.services.db
      .prepare(
        'insert into auth_devices (id, name, pubkey_jwk, binding, pinned, revoked, created_at) values (?, ?, ?, ?, 1, 0, ?)',
      )
      .run(keep.deviceId, 'kept', JSON.stringify(keep.publicJwk), 'b', Date.now())
    await registerToken(w, keep, KEEP_TOKEN)
    const grant = await registerGrant(w)
    const bridge = await bridgeFor(w)
    const to = (token: string) => w.fake.requests.filter((r) => r.token === token).length
    const card = bridge.createCard(cardInput)
    await waitFor(() => w.r.runtime.store.getCard(card.id) !== null, 5000, 'the card at the relay')
    // The first card's push goes to both phones. Wait until it has reached both: only then is its pass over, and a
    // late arrival can no longer be mistaken for a push to a revoked phone.
    await waitFor(() => to(TOKEN) >= 1 && to(KEEP_TOKEN) >= 1, 8000, 'the first card pushed to both phones')
    // the owner revokes this phone (the Mac and relay both mark it); the phone still holds a valid grant and keys
    w.r.relay.services.db.prepare('update auth_devices set revoked = 1 where id = ?').run(w.dev.deviceId)
    for (const body of [approveBody(card), { a: 'reply', thread_id: 'general', text: 'still me?' } as ActBodyT]) {
      const res = await sendTap(w, await tapBody(w, grant, body))
      expect(res.status).toBe(401)
      expect(await res.json()).toEqual({ error: 'bad_signature' })
    }
    expect(eventRows(w, 'native.act')).toBe(0)
    expect(outboxRows(w)).toBe(0)
    expect(w.r.runtime.store.getCard(card.id)?.state).toBe('pending')
    // and no push goes to a revoked phone any more: a second card reaches the phone that is still trusted (the signal
    // that its push pass is done), and nothing more reached the revoked one.
    const revokedBefore = to(TOKEN)
    const keptBefore = to(KEEP_TOKEN)
    bridge.createCard({ ...cardInput, title: 'Another one' })
    await waitFor(() => to(KEEP_TOKEN) > keptBefore, 8000, 'the second card pushed to the trusted phone')
    expect(to(TOKEN)).toBe(revokedBefore)
  })

  it("a second phone cannot approve with the first phone's grant (device and grant must both be the current ones)", async () => {
    const w = await world()
    const grant = await registerGrant(w)
    const bridge = await bridgeFor(w)
    const card = await pendingCard(w, bridge)
    const second = await createDeviceKey()
    w.r.relay.services.db
      .prepare(
        'insert into auth_devices (id, name, pubkey_jwk, binding, pinned, revoked, created_at) values (?, ?, ?, ?, 1, 0, ?)',
      )
      .run(second.deviceId, 'second', JSON.stringify(second.publicJwk), 'b', Date.now())
    const frame = await signNativeAct({
      deviceId: second.deviceId,
      id: newUlid(),
      ts: new Date(w.clock.now()).toISOString(),
      grant,
      body: approveBody(card),
      actPrivateKey: w.phone.act.privateKey,
    })
    expect((await sendTap(w, frame)).status).toBe(401)
    expect(w.r.runtime.store.getCard(card.id)?.state).toBe('pending')
  })

  it('when the Mac refuses the tap (any reason), the card goes back to pending and the owner can approve again', async () => {
    const w = await world()
    const grant = await registerGrant(w)
    const bridge = await bridgeFor(w)
    const app = await w.k.connectedApp({ deviceKey: w.dev as DeviceKey })
    const card = await pendingCard(w, bridge)
    const first = await tapBody(w, grant, approveBody(card))
    expect((await sendTap(w, first)).status).toBe(200)
    await bridge.expectFrame('native.act', (f) => f.id === first.id, { direction: 'in' })
    for (const code of ['stale', 'stepup_required', 'sig_invalid', 'bad_frame']) {
      bridge.send({ type: 'error', ref: first.id, code, message: 'refused' })
      await waitFor(() => w.r.runtime.store.getCard(card.id)?.state === 'pending', 5000, `rollback after ${code}`)
      await app.expectFrame('card.update', (f) => f.card_id === card.id && f.state === 'pending')
      // put it back to resolved to run the next code through the same path
      w.r.runtime.store.setCardState(card.id, { state: 'resolved' })
    }
    w.r.runtime.store.setCardState(card.id, { state: 'pending' })
    const again = await sendTap(w, await tapBody(w, grant, approveBody(card)))
    expect(again.status).toBe(200)
  })

  it('pushes the owner when the Mac refuses a tap the relay already answered ok (a Reply or an Approve), not only a thread row', async () => {
    const w = await world()
    await registerToken(w)
    const grant = await registerGrant(w)
    const bridge = await bridgeFor(w)
    const card = bridge.createCard(cardInput)
    await waitFor(() => w.fake.requests.length >= 1, 8000, 'the card push')
    const taps = [
      await tapBody(w, grant, { a: 'reply', thread_id: 'general', text: 'hello' }),
      await tapBody(w, grant, approveBody(card)),
    ]
    for (const [i, tapFrame] of taps.entries()) {
      expect((await sendTap(w, tapFrame)).status).toBe(200)
      const before = w.fake.requests.length
      bridge.send({ type: 'error', ref: tapFrame.id, code: 'stale', message: 'too late' })
      await waitFor(() => w.fake.requests.length > before, 8000, `a failure push for tap ${i}`)
      const last = w.fake.requests.at(-1)!
      expect((last.body.aps as { alert: { body: string } }).alert.body).toBe(
        'That tap did not go through. Open Talos to check.',
      )
      expect(last.rawBody).not.toContain('too late') // the Mac's words never ride in the alert
    }
  })

  it('the failed-tap push is not swallowed by an app socket that is connected and visible', async () => {
    const w = await world()
    await registerToken(w)
    const grant = await registerGrant(w)
    const bridge = await bridgeFor(w)
    await w.k.connectedApp({ deviceKey: w.dev as DeviceKey, visible: true })
    const tapFrame = await tapBody(w, grant, { a: 'reply', thread_id: 'general', text: 'hello' })
    expect((await sendTap(w, tapFrame)).status).toBe(200)
    const before = w.fake.requests.length
    bridge.send({ type: 'error', ref: tapFrame.id, code: 'stale', message: 'too late' })
    await waitFor(() => w.fake.requests.length > before, 8000, 'the failure push with an app open')
  })

  it('does not push for an ordinary app request the Mac refuses (only a notification tap, which the phone was told succeeded)', async () => {
    const w = await world()
    await registerToken(w)
    const bridge = await bridgeFor(w)
    await w.k.connectedApp({ deviceKey: w.dev as DeviceKey })
    const before = w.fake.requests.length
    bridge.send({ type: 'error', ref: newUlid(), code: 'stale', message: 'nothing was asked' })
    await sleep(300)
    expect(w.fake.requests.length).toBe(before)
  })

  it('a card the Mac DID decide is not put back to pending by a late error', async () => {
    const w = await world()
    const grant = await registerGrant(w)
    const bridge = await bridgeFor(w)
    const card = await pendingCard(w, bridge)
    const f = await tapBody(w, grant, approveBody(card))
    await sendTap(w, f)
    bridge.send({
      type: 'card.update',
      card_id: card.id,
      state: 'resolved',
      resolution: {
        action: 'primary',
        at: new Date(w.clock.now()).toISOString(),
        edited: false,
        payload_hash: card.payload_hash,
      },
    })
    await waitFor(() => w.r.runtime.store.getCard(card.id)?.resolution !== undefined, 5000, 'the Mac decision')
    bridge.send({ type: 'error', ref: f.id, code: 'stale', message: 'late' })
    await sleep(200)
    expect(w.r.runtime.store.getCard(card.id)?.state).toBe('resolved')
  })

  it('a tap that never reaches the Mac puts the card back to pending when the relay gives up, and says so', async () => {
    const w = await world()
    const grant = await registerGrant(w)
    const bridge = await bridgeFor(w)
    // still open when the relay gives up: a card past its expiry is expired instead (see the Approve tests below)
    const card = await pendingCard(w, bridge, { expires_at: new Date(w.clock.now() + 30 * DAY).toISOString() })
    await bridge.close()
    const app = await w.k.connectedApp({ deviceKey: w.dev as DeviceKey, visible: false })
    expect((await sendTap(w, await tapBody(w, grant, approveBody(card)))).status).toBe(200)
    expect(w.r.runtime.store.getCard(card.id)?.state).toBe('resolved') // queued: the relay holds it as decided
    w.clock.set(w.clock.now() + 8 * DAY)
    w.r.runtime.hub.sweep()
    const msg = await app.expectFrame(
      'message.stored',
      (f) => f.message.author === 'system' && /never reached your Mac/.test(f.message.text ?? ''),
    )
    expect(msg.message.text).toContain('decision on a card')
    // the row alone is not the proof: the card itself is open again, so the owner can approve it in the app
    await waitFor(() => w.r.runtime.store.getCard(card.id)?.state === 'pending', 5000, 'the card back to pending')
    const upd = await app.expectFrame('card.update', (f) => f.card_id === card.id && f.state === 'pending')
    expect(upd.state).toBe('pending')
  })
})

describe('an older Mac', () => {
  it('is told "update the Mac" up front, nothing is queued, and a Mac that has the feature is accepted', async () => {
    const w = await world()
    const grant = await registerGrant(w)
    const old = await bridgeFor(w, [])
    const frame = await tapBody(w, grant, { a: 'reply', thread_id: 'general', text: 'hi' })
    const res = await sendTap(w, frame)
    expect(res.status).toBe(409)
    expect(((await res.json()) as { error: string }).error).toBe('mac_update_needed')
    expect(outboxRows(w)).toBe(0)
    await old.close()
    await bridgeFor(w) // the Mac updates and reconnects
    expect((await sendTap(w, frame)).status).toBe(200)
  })
})

describe('an Approve the Mac took but never confirmed passing to the agent', () => {
  const HOUR = 3_600_000
  type Opts = { decided?: boolean; longExpiry?: boolean; corrupt?: boolean }
  /** The Mac takes the tap two hours after the card was made, then goes away; the relay sweeps hourly for 8 days. */
  async function tapTaken(opts: Opts = {}) {
    const w = await world()
    const grant = await registerGrant(w)
    const bridge = await bridgeFor(w)
    const app = await w.k.connectedApp({ deviceKey: w.dev as DeviceKey, visible: false })
    // the Mac has passed an earlier message on, which is how the relay learns it confirms in two steps
    const earlier = await app.sendMessage('general', 'pushed through')
    await bridge.expectFrame('message', (f) => f.id === earlier.id, { direction: 'in' })
    expect(bridge.consume(String(earlier.id))).toBe(true)
    await waitFor(() => w.r.runtime.store.outboxRow(String(earlier.id)) === undefined, 5000, 'earlier consumed')
    const card = bridge.createCard({
      ...cardInput,
      ...(opts.longExpiry ? { expires_at: new Date(w.clock.now() + 30 * DAY).toISOString() } : {}),
    })
    await waitFor(() => w.r.runtime.store.getCard(card.id) !== null, 5000, 'the card at the relay')
    w.clock.set(w.clock.now() + 2 * HOUR)
    const frame = await tapBody(w, grant, approveBody(card))
    expect((await sendTap(w, frame)).status).toBe(200)
    await bridge.expectFrame('native.act', (f) => f.id === frame.id, { direction: 'in' })
    await waitFor(() => w.r.runtime.store.outboxRow(String(frame.id))?.delivered === 1, 5000, 'delivered')
    if (opts.decided) {
      bridge.send({
        type: 'card.update',
        card_id: card.id,
        state: 'resolved',
        resolution: {
          action: 'primary',
          at: new Date(w.clock.now()).toISOString(),
          edited: false,
          payload_hash: card.payload_hash,
        },
      })
      await waitFor(() => w.r.runtime.store.getCard(card.id)?.resolution !== undefined, 5000, 'decided')
    }
    await bridge.close() // the consumed confirmation never arrives
    await waitFor(() => !w.r.runtime.hub.bridgeOnline(), 5000, 'bridge gone')
    if (opts.corrupt)
      w.r.runtime.store.db
        .prepare("update core_cards set card = x'0102030405060708090a0b0c0d0e0f1011121314' where card_id = ?")
        .run(card.id)
    const later = opts.corrupt ? await app.sendMessage('general', 'queued after the tap') : null
    if (later) await app.expectFrame('ack', (f) => f.ref === later.id) // queued for the Mac, which is gone
    const end = w.clock.now() + 8 * DAY
    while (w.clock.now() < end) {
      w.clock.set(w.clock.now() + HOUR)
      w.r.runtime.hub.sweep()
    }
    app.send({ type: 'ping', nonce: 'caught-up' })
    await app.expectFrame('pong', (f) => f.nonce === 'caught-up') // frames arrive in order: a note would be here by now
    const rows = app.rec.of('message.stored', 'in').filter((f) => f.message.author === 'system')
    const cardStates = app.rec
      .of('card.update', 'in')
      .filter((f) => f.card_id === card.id)
      .map((f) => f.state)
    return { w, app, card, rows, later, cardStates }
  }

  it('a card the Mac did decide gets no note and is left alone, then swept as a decided card', async () => {
    const { w, card, rows, cardStates } = await tapTaken({ decided: true })
    expect(rows).toHaveLength(0)
    expect(cardStates).not.toContain('pending') // never put back
    expect(cardStates).not.toContain('expired')
    expect(w.r.runtime.store.getCard(card.id)).toBeNull()
  })

  it('a card the Mac did not decide, past its expiry by the day of the report, expires and is swept', async () => {
    const { w, card, rows, cardStates } = await tapTaken()
    expect(rows).toHaveLength(1)
    expect((rows[0] as { message: { text?: string } }).message.text).toContain(
      'reached your Mac but never got to your agent',
    )
    expect(cardStates).toEqual(['expired']) // never shown as pending again
    expect(w.r.runtime.store.getCard(card.id)).toBeNull()
  })

  it('a card the Mac did not decide that is not yet past its expiry goes back to pending', async () => {
    const { w, card, rows, cardStates } = await tapTaken({ longExpiry: true })
    expect(rows).toHaveLength(1)
    expect(cardStates).toEqual(['pending'])
    expect(w.r.runtime.store.getCard(card.id)?.state).toBe('pending')
  })

  it('a card row that no longer opens does not stop the reports after it', async () => {
    const { app, rows, later } = await tapTaken({ corrupt: true })
    const got = await app.expectFrame('receipt', (f) => f.message_id === later?.client_msg_id, { direction: 'in' })
    expect(got.state).toBe('not_delivered')
    expect(rows).toHaveLength(1) // the note for the tap, which counts as undecided
  })
})

void (null as unknown as FakeClock)
