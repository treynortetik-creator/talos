// The app keeps its unsent messages when a session ran out from sitting idle, and wipes them when the device was revoked
// or signed out. The relay says which on the 401 (`reason`) and on the 4401 close, and says nothing when it does not know:
// an app that sees no reason wipes, so an old relay or an unknown cookie never keeps a lost phone's queue.
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createDeviceKey, generateBridgeKey } from '@talos-app/protocol'
import { FakeApp, type FakeClock, fakeClock } from '@talos-app/testkit'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { resetAuthImplementation } from '../../src/auth/contract.ts'
import { authState } from '../../src/auth/state.ts'
import { COOKIE_NAME } from '../../src/auth/util.ts'
import { NoopTransport } from '../../src/core/push.ts'
import { loadEnv } from '../../src/env.ts'
import { type RunningRelay, startRelay } from '../../src/index.ts'
import { TEST_DATA_KEY } from '../helpers/fake-services.ts'
import { afterEachReset, type Harness, makeHarness, registerPasskey } from './helpers.ts'
import { softAuthenticator } from './soft-passkey.ts'

vi.setConfig({ testTimeout: 60_000 })

const DAY = 24 * 3600_000

describe('the 401 says why the session ended', () => {
  let h: Harness
  afterEach(afterEachReset)
  beforeEach(async () => {
    h = await makeHarness()
  })
  const me = async (cookie: string) => {
    const res = await h.app.request('/api/me', { headers: { Cookie: cookie } })
    return { status: res.status, body: (await res.json()) as { error?: string; reason?: string } }
  }

  it('idle for more than 14 days is "expired", and it is still "expired" after the relay tidies old rows', async () => {
    const cookie = await h.loginPinned()
    expect((await me(cookie)).status).toBe(200)
    h.fake.clock.advance(15 * DAY)
    expect(await me(cookie)).toMatchObject({ status: 401, body: { reason: 'expired' } })

    const second = await h.loginPinned()
    h.fake.clock.advance(15 * DAY)
    h.state.core.purge() // tidied before the owner ever opened the app again
    expect(await me(second)).toMatchObject({ status: 401, body: { reason: 'expired' } })
  })

  it('with a sign-in lasting 100 days, the idle-expired record is still there when the cookie comes back at day 75', async () => {
    const long = await makeHarness({ env: { SESSION_TTL_DAYS: '100' } })
    const cookie = await long.loginPinned()
    long.fake.clock.advance(15 * DAY)
    long.state.core.purge() // ends the session as "expired"
    long.fake.clock.advance(60 * DAY)
    long.state.core.purge() // the cookie (100 days) is still alive; the record must be too
    const res = await long.app.request('/api/me', { headers: { Cookie: cookie } })
    expect(res.status).toBe(401)
    expect(await res.json()).toMatchObject({ reason: 'expired' })
  })

  it('a lowered SESSION_TTL_DAYS does not shorten how long the end record is kept; the bound is 365 days', async () => {
    const long = await makeHarness({ env: { SESSION_TTL_DAYS: '100' } })
    const cookie = await long.loginPinned()
    long.fake.clock.advance(15 * DAY)
    long.state.core.purge() // ends the session as "expired"
    // the owner lowers the setting after this cookie was issued; the cookie still lives on its old 100 days
    ;(long.state.core as unknown as { ttlMs: number }).ttlMs = 1 * DAY
    long.fake.clock.advance(75 * DAY) // day 90: past the old 45-day floor
    long.state.core.purge()
    const res = await long.app.request('/api/me', { headers: { Cookie: cookie } })
    expect(await res.json()).toMatchObject({ reason: 'expired' })
    // the bound itself: kept at about 363 days old, gone at about 367
    long.fake.clock.advance(287 * DAY) // the record is about 363 days old
    long.state.core.purge()
    expect(await (await long.app.request('/api/me', { headers: { Cookie: cookie } })).json()).toMatchObject({
      reason: 'expired',
    })
    long.fake.clock.advance(4 * DAY) // about 367 days old
    long.state.core.purge()
    expect(
      (await (await long.app.request('/api/me', { headers: { Cookie: cookie } })).json()) as { reason?: string },
    ).not.toHaveProperty('reason')
  })

  it('a session that expired and was tidied away is "revoked" once its device is revoked', async () => {
    const cookie = await h.loginPinned()
    const id = h.state.core.lookupSession(cookie.split('=')[1] ?? '')?.deviceId as string
    h.fake.clock.advance(15 * DAY)
    h.state.core.purge() // the record now says "expired"
    expect(await me(cookie)).toMatchObject({ status: 401, body: { reason: 'expired' } })
    h.state.core.revokeDevice(id)
    expect(await me(cookie)).toMatchObject({ status: 401, body: { reason: 'revoked' } }) // the phone must wipe
  })

  it('a session that expired and was tidied away is "logged_out_everywhere" after sign-out everywhere', async () => {
    const old = await h.loginPinned()
    h.fake.clock.advance(15 * DAY)
    h.state.core.purge()
    expect(await me(old)).toMatchObject({ status: 401, body: { reason: 'expired' } })
    const now = await h.loginPinned()
    expect((await h.post('/api/auth/logout-all', {}, now)).status).toBe(204)
    expect(await me(old)).toMatchObject({ status: 401, body: { reason: 'logged_out_everywhere' } })
  })

  it('sign-out is "logged_out", sign-out everywhere is "logged_out_everywhere"', async () => {
    const one = await h.loginPinned()
    expect((await h.post('/api/auth/logout', {}, one)).status).toBe(204)
    expect(await me(one)).toMatchObject({ status: 401, body: { reason: 'logged_out' } })

    const a = await h.loginPinned()
    const b = await h.loginPinned()
    expect((await h.post('/api/auth/logout-all', {}, a)).status).toBe(204)
    expect(await me(b)).toMatchObject({ status: 401, body: { reason: 'logged_out_everywhere' } })
  })

  it('sign-out everywhere is all or nothing: a failure while relabelling expired rows ends no session', async () => {
    const cookie = await h.loginPinned()
    const db = h.state.core.db
    const realPrepare = db.prepare.bind(db)
    db.prepare = ((sql: string) => {
      if (/update auth_session_ends set reason/.test(sql)) throw new Error('disk full')
      return realPrepare(sql)
    }) as typeof db.prepare
    expect(() => h.state.core.deleteAllSessions()).toThrow('disk full')
    db.prepare = realPrepare as typeof db.prepare
    expect((await me(cookie)).status).toBe(200)
    expect(db.prepare('select count(*) from auth_session_ends').pluck().get()).toBe(0)
  })

  it('a revoked device is "revoked", whichever way the revoke happened', async () => {
    const cookie = await h.loginPinned()
    const id = h.state.core.lookupSession(cookie.split('=')[1] ?? '')?.deviceId as string
    h.state.core.revokeDevice(id)
    expect(await me(cookie)).toMatchObject({ status: 401, body: { reason: 'revoked' } })
  })

  it('a session that was signed in again, then its device is revoked, is "revoked": the phone must wipe', async () => {
    const cookie = await h.loginPinned()
    const token = cookie.split('=')[1] ?? ''
    const id = h.state.core.lookupSession(token)?.deviceId as string
    h.state.core.deleteSession(h.state.core.lookupSession(token)?.id as string, 'signed_in_again')
    expect(await me(cookie)).toMatchObject({ status: 401, body: { reason: 'signed_in_again' } })
    h.state.core.revokeDevice(id)
    expect(await me(cookie)).toMatchObject({ status: 401, body: { reason: 'revoked' } })
  })

  it('with a second device on the same passkey, revoking one still relabels its signed_in_again session and leaves the other signed in', async () => {
    const first = await h.loginPinned()
    const second = await h.loginPinned() // another device on the same passkey: revoking the first leaves the passkey valid
    const token = first.split('=')[1] ?? ''
    const id = h.state.core.lookupSession(token)?.deviceId as string
    h.state.core.deleteSession(h.state.core.lookupSession(token)?.id as string, 'signed_in_again')
    expect(await me(first)).toMatchObject({ status: 401, body: { reason: 'signed_in_again' } })
    h.state.core.revokeDevice(id)
    expect(await me(first)).toMatchObject({ status: 401, body: { reason: 'revoked' } })
    expect((await me(second)).status).toBe(200)
  })

  it('a session that was signed in again with no device, then its passkey is revoked with the last device, is "revoked"', async () => {
    const pinned = await h.loginPinned()
    const id = h.state.core.lookupSession(pinned.split('=')[1] ?? '')?.deviceId as string
    const bare = h.login() // a passkey session with no device, on the same passkey
    const bareId = h.state.core.lookupSession(bare.split('=')[1] ?? '')?.id as string
    h.state.core.deleteSession(bareId, 'signed_in_again')
    expect(await me(bare)).toMatchObject({ status: 401, body: { reason: 'signed_in_again' } })
    h.state.core.revokeDevice(id) // the last pinned device of the passkey: the passkey goes too
    expect(await me(bare)).toMatchObject({ status: 401, body: { reason: 'revoked' } })
  })

  it('a session that was signed in again, then sign-out everywhere, is "logged_out_everywhere"', async () => {
    const old = await h.loginPinned()
    h.state.core.deleteSession(h.state.core.lookupSession(old.split('=')[1] ?? '')?.id as string, 'signed_in_again')
    const now = await h.loginPinned()
    expect((await h.post('/api/auth/logout-all', {}, now)).status).toBe(204)
    expect(await me(old)).toMatchObject({ status: 401, body: { reason: 'logged_out_everywhere' } })
  })

  it('a cookie the relay never issued gets no reason, and neither does a request with none', async () => {
    const junk = `${COOKIE_NAME}=${'a'.repeat(43)}`
    const res = await me(junk)
    expect(res.status).toBe(401)
    expect(res.body.reason).toBeUndefined()
    const none = await h.app.request('/api/me')
    expect(none.status).toBe(401)
    expect(((await none.json()) as { reason?: string }).reason).toBeUndefined()
  })

  it('the websocket upgrade refusal carries the same reason', async () => {
    const cookie = await h.loginPinned()
    expect((await h.post('/api/auth/logout', {}, cookie)).status).toBe(204)
    const res = await h.app.request('/probe/ws', { headers: { Cookie: cookie, Origin: 'https://relay.example.com' } })
    expect(res.status).toBe(401)
    expect(((await res.json()) as { reason?: string }).reason).toBe('logged_out')
  })
})

describe('signing in over a live cookie ends the old session as signed_in_again', () => {
  let h: Harness
  afterEach(afterEachReset)
  beforeEach(async () => {
    h = await makeHarness()
  })
  const reasonOf = async (cookie: string) => {
    const res = await h.app.request('/api/me', { headers: { Cookie: cookie } })
    return { status: res.status, reason: ((await res.json()) as { reason?: string }).reason }
  }
  const cookieOf = (res: Response) => (res.headers.get('set-cookie') ?? '').split(';')[0] as string

  it('a passkey sign-in (login/verify)', async () => {
    const passkey = softAuthenticator()
    await registerPasskey(h, passkey)
    const signIn = async (cookie?: string) => {
      const o = await h.post('/api/auth/login/options', {})
      const { challenge } = (await o.json()) as { challenge: string }
      return h.post('/api/auth/login/verify', { response: passkey.assert(challenge) }, cookie)
    }
    const first = cookieOf(await signIn())
    const second = await signIn(first)
    expect(second.status).toBe(200)
    expect(await reasonOf(first)).toEqual({ status: 401, reason: 'signed_in_again' })
  })

  it('a new passkey (enroll/verify)', async () => {
    const first = softAuthenticator()
    await registerPasskey(h, first)
    const o = await h.post('/api/auth/login/options', {})
    const { challenge } = (await o.json()) as { challenge: string }
    const cookie = cookieOf(await h.post('/api/auth/login/verify', { response: first.assert(challenge) }))
    await registerPasskey(h, softAuthenticator(), cookie)
    expect(await reasonOf(cookie)).toEqual({ status: 401, reason: 'signed_in_again' })
  })
})

describe('the 4401 close says why', () => {
  let relay: RunningRelay
  let clock: FakeClock
  let dir: string
  const apps: FakeApp[] = []

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'talos-endreason-'))
    clock = fakeClock('2026-11-01T20:00:00.000Z')
    const bridgeKey = await generateBridgeKey()
    relay = await startRelay({
      env: loadEnv({
        NODE_ENV: 'development',
        DATA_DIR: dir,
        PUBLIC_ORIGIN: 'https://relay.example.com',
        RP_ID: 'relay.example.com',
        DATA_KEY: TEST_DATA_KEY,
        BRIDGE_PUBKEY: bridgeKey.publicKeyB64,
        LOG_LEVEL: 'silent',
      }),
      host: '127.0.0.1',
      port: 0,
      transport: new NoopTransport(),
      clock,
    })
  })
  afterEach(async () => {
    for (const a of apps.splice(0)) await a.close().catch(() => undefined)
    await relay.stop()
    resetAuthImplementation()
    rmSync(dir, { recursive: true, force: true })
  })

  async function phone(name: string) {
    const core = authState(relay.services).core
    const key = await createDeviceKey()
    core.addCredential({
      credentialId: `cred-${name}`,
      publicKey: new Uint8Array([1, 2, 3]),
      counter: 0,
      deviceName: name,
    })
    core.upsertDevice({
      id: key.deviceId as never,
      name,
      pubkeyJwk: key.publicJwk,
      credentialId: `cred-${name}`,
      binding: 'b',
      codeId: `c-${name}`,
    })
    core.setPinned(key.deviceId, true)
    const token = core.createSession(`cred-${name}`, key.deviceId)
    const app = new FakeApp({
      relayWs: `ws://127.0.0.1:${relay.port}`,
      headers: { Cookie: `${COOKIE_NAME}=${token}`, Origin: 'https://relay.example.com' },
      deviceKey: key,
    })
    apps.push(app)
    await app.connect()
    const ws = (app as unknown as { ws: import('ws').WebSocket }).ws
    const closed = new Promise<{ code: number; reason: string }>((resolve) =>
      ws.once('close', (code, reason) => resolve({ code, reason: reason.toString() })),
    )
    return { id: key.deviceId, core, closed }
  }

  it('a revoke closes the live socket with 4401 and "revoked"', async () => {
    const p = await phone('Lost phone')
    p.core.revokeDevice(p.id)
    relay.services.bus.revalidateApps()
    expect(await p.closed).toEqual({ code: 4401, reason: 'revoked' })
  })

  it('sign-out everywhere closes it with "logged_out_everywhere"', async () => {
    const p = await phone('Phone')
    p.core.deleteAllSessions()
    relay.services.bus.revalidateApps()
    expect(await p.closed).toEqual({ code: 4401, reason: 'logged_out_everywhere' })
  })

  it('a session that ran out of time closes the socket with "expired"', async () => {
    const p = await phone('Quiet phone')
    // the stored limit passes (a long jump of the fake clock would instead reap the socket for missing pongs)
    p.core.db.prepare('update auth_sessions set expires_at = ?').run(clock.now() - 1)
    relay.services.bus.revalidateApps()
    expect(await p.closed).toEqual({ code: 4401, reason: 'expired' })
  })
})
