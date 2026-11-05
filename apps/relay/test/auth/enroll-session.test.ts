// WP-N0: setup-code sign-in for native shells (POST /api/auth/enroll/session). Everything here runs the REAL relay
// (startRelay, the real auth module, the real core routes) over real HTTP, with the repo's FakeBridge standing in for the
// Mac. No test-auth, no always-pinned session: the cookie comes from enroll/session and nothing else.
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  type BridgeKeyPair,
  bindingMac,
  createExtractableDeviceKeyForTests,
  deriveEnrollAuth,
  deriveEnrollBind,
  enrollAuthHash,
  enrollCodeId,
  generateBridgeKey,
  newEnrollCode,
  parseFrame,
  ROUTE_LIST,
  signBridgeHttp,
  signDeviceProof,
} from '@talos-app/protocol'
import { FakeBridge, waitFor } from '@talos-app/testkit'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { resetAuthImplementation } from '../../src/auth/contract.ts'
import { DEVICE_USE_INTERVAL_MS } from '../../src/auth/core.ts'
import { authState } from '../../src/auth/state.ts'
import { COOKIE_NAME } from '../../src/auth/util.ts'
import { NoopTransport } from '../../src/core/push.ts'
import { loadEnv } from '../../src/env.ts'
import { type RunningRelay, startRelay } from '../../src/index.ts'
import { TEST_DATA_KEY } from '../helpers/fake-services.ts'

const ORIGIN = 'https://relay.example.com'

type Rig = {
  relay: RunningRelay
  base: string
  bridgeKey: BridgeKeyPair
  logs: string[]
  skew: { ms: number }
  dir: string
  /** Registers a fresh one-time code the way `talos-app enroll` does (signed POST /bridge/enroll). */
  mintCode(ttlMs?: number): Promise<{ code: string; codeAuth: string; hash: string; codeId: string }>
  post(path: string, body: unknown, over?: { cookie?: string; headers?: Record<string, string> }): Promise<Response>
  get(path: string, cookie?: string): Promise<Response>
  stop(): Promise<void>
}

async function startRig(): Promise<Rig> {
  const dir = mkdtempSync(join(tmpdir(), 'talos-n0-'))
  const bridgeKey = await generateBridgeKey()
  const logs: string[] = []
  const skew = { ms: 0 }
  const clock = {
    now: () => Date.now() + skew.ms,
    setTimeout: (fn: () => void, ms: number) => {
      const h = setTimeout(fn, ms)
      h.unref?.()
      return h
    },
    clearTimeout: (h: unknown) => clearTimeout(h as ReturnType<typeof setTimeout>),
  }
  const rec = (level: string) => (o: unknown, m?: string) => logs.push(`${level} ${JSON.stringify(o)} ${m ?? ''}`)
  const log = { debug: rec('debug'), info: rec('info'), warn: rec('warn'), error: rec('error'), child: () => log }
  const relay = await startRelay({
    env: loadEnv({
      NODE_ENV: 'development', // NOT 'test': test-auth is refused here, so this is the production auth module
      DATA_DIR: dir,
      PUBLIC_ORIGIN: ORIGIN,
      RP_ID: 'relay.example.com',
      DATA_KEY: TEST_DATA_KEY,
      BRIDGE_PUBKEY: bridgeKey.publicKeyB64,
      LOG_LEVEL: 'debug',
    }),
    host: '127.0.0.1',
    port: 0,
    transport: new NoopTransport(),
    clock,
    log: log as never,
  })
  const base = `http://127.0.0.1:${relay.port}`
  const post: Rig['post'] = (path, body, over = {}) =>
    fetch(`${base}${path}`, {
      method: 'POST',
      headers: {
        origin: ORIGIN,
        'x-talos-csrf': '1',
        'content-type': 'application/json',
        ...(over.cookie ? { cookie: over.cookie } : {}),
        ...over.headers,
      },
      body: JSON.stringify(body),
    })
  return {
    relay,
    base,
    bridgeKey,
    logs,
    skew,
    dir,
    post,
    get: (path, cookie) => fetch(`${base}${path}`, { headers: cookie ? { cookie } : {} }),
    async mintCode(ttlMs = 600_000) {
      const code = newEnrollCode()
      const codeAuth = deriveEnrollAuth(code)
      const hash = enrollAuthHash(codeAuth)
      const codeId = enrollCodeId(hash)
      const raw = JSON.stringify({
        code_id: codeId,
        code_auth_hash: hash,
        expires_at: new Date(clock.now() + ttlMs).toISOString(),
        label: 'n0',
      })
      const authorization = await signBridgeHttp({
        privateKey: bridgeKey.privateKey,
        keyId: bridgeKey.keyId,
        method: 'POST',
        pathWithQuery: '/bridge/enroll',
        body: raw,
        ts: Math.floor(clock.now() / 1000),
      })
      const res = await fetch(`${base}/bridge/enroll`, { method: 'POST', headers: { authorization }, body: raw })
      if (res.status !== 200) throw new Error(`bridge/enroll ${res.status}`)
      return { code, codeAuth, hash, codeId }
    },
    async stop() {
      await relay.stop()
      resetAuthImplementation()
      rmSync(dir, { recursive: true, force: true })
    },
  }
}

const cookieOf = (res: Response): string => {
  const raw = res.headers.get('set-cookie') ?? ''
  const m = new RegExp(`${COOKIE_NAME}=([A-Za-z0-9_-]+)`).exec(raw)
  if (!m) throw new Error(`no session cookie in: ${raw}`)
  return `${COOKIE_NAME}=${m[1]}`
}

async function deviceHalf(rig: Rig, code: string, cookie: string) {
  const dev = await createExtractableDeviceKeyForTests()
  const binding = bindingMac(deriveEnrollBind(code), dev.deviceId, dev.publicJwk)
  const res = await rig.post(
    '/api/auth/device/verify',
    {
      device: { id: dev.deviceId, name: 'Mac app', pubkey_jwk: dev.publicJwk },
      binding,
      code_auth: deriveEnrollAuth(code),
    },
    { cookie },
  )
  return { dev, binding, res }
}

let rig: Rig
beforeEach(async () => {
  rig = await startRig()
})
afterEach(async () => {
  await rig.stop()
})

describe('POST /api/auth/enroll/session', () => {
  it('code -> session -> 403 device_not_pinned -> device/verify -> the Mac pins -> 200', async () => {
    const bridge = await new FakeBridge({ relayWs: `ws://127.0.0.1:${rig.relay.port}`, key: rig.bridgeKey }).connect()
    try {
      const c = await rig.mintCode()
      const res = await rig.post('/api/auth/enroll/session', { code_auth: c.codeAuth })
      expect(res.status).toBe(200)
      expect(await res.json()).toEqual({ ok: true })
      const cookie = cookieOf(res)
      expect(res.headers.get('set-cookie')).toMatch(/Secure; HttpOnly; SameSite=Strict/)

      // The session exists and is unpinned with no passkey behind it; the code is NOT burned yet.
      const core = authState(rig.relay.services).core
      expect(core.db.prepare('select credential_id from auth_sessions').pluck().all()).toEqual([null])
      expect(core.findCode(c.codeAuth)).not.toBeNull()

      const me = await rig.get('/api/me', cookie)
      expect(await me.json()).toMatchObject({ device_pinned: false, has_passkey: false })
      // (The spec names /api/threads; the relay has no such route, so the guarded data routes stand in for it.)
      for (const path of ['/api/devices', '/api/connections', '/api/inbox']) {
        const r = await rig.get(path, cookie)
        expect(r.status, path).toBe(403)
        expect(await r.json()).toEqual({ error: 'device_not_pinned' })
      }

      // Half 2: the existing device/verify, no WebAuthn. It burns the code.
      const half = await deviceHalf(rig, c.code, cookie)
      expect(half.res.status).toBe(202)
      expect(core.findCode(c.codeAuth)).toBeNull()
      const enrolled = await bridge.expectFrame('device.enrolled', (f) => f.device.id === half.dev.deviceId, {
        direction: 'in',
      })
      // A native session has no passkey; the frame must still be one the real bridge accepts.
      expect(enrolled.credential_id.length).toBeGreaterThan(0)
      expect(parseFrame({ ...enrolled }, { direction: 'relay_to_bridge' }).ok).toBe(true)
      expect((await rig.get('/api/connections', cookie)).status).toBe(403) // still unpinned until the Mac answers

      // The Mac answers y.
      bridge.send({ type: 'device.pinned', device_id: half.dev.deviceId, ok: true })
      await waitFor(() => core.device(half.dev.deviceId)?.pinned === true, 3000, 'device pinned')
      const after = await rig.get('/api/connections', cookie)
      expect(after.status).toBe(200)
      expect(await (await rig.get('/api/me', cookie)).json()).toMatchObject({ device_pinned: true })
    } finally {
      await bridge.close()
    }
  })

  it('a phone that signed in with a setup code shows when it was last used, and keeps showing it as it is used', async () => {
    const bridge = await new FakeBridge({ relayWs: `ws://127.0.0.1:${rig.relay.port}`, key: rig.bridgeKey }).connect()
    try {
      const c = await rig.mintCode()
      const cookie = cookieOf(await rig.post('/api/auth/enroll/session', { code_auth: c.codeAuth }))
      const half = await deviceHalf(rig, c.code, cookie)
      expect(half.res.status).toBe(202)
      const core = authState(rig.relay.services).core
      // Enrolling is the first use: the row is never "unknown" for a device enrolled after this change.
      const enrolledAt = core.device(half.dev.deviceId)?.lastUsedAt
      expect(enrolledAt).not.toBeNull()
      bridge.send({ type: 'device.pinned', device_id: half.dev.deviceId, ok: true })
      // The relay handles the bridge's frames in order: once its pong is back, the pin above has been applied.
      const nonce = 'after-pin'
      bridge.send({ type: 'ping', nonce })
      await bridge.expectFrame('pong', (f) => f.nonce === nonce, { direction: 'in' })
      expect(core.device(half.dev.deviceId)?.pinned).toBe(true)
      // This kind of phone never signs in with a passkey again; only its own requests can move the time.
      rig.skew.ms += DEVICE_USE_INTERVAL_MS + 1000
      const list = (await (await rig.get('/api/devices', cookie)).json()) as Array<{
        id: string
        last_used_at: string | null
      }>
      const shown = list.find((d) => d.id === half.dev.deviceId)?.last_used_at
      expect(Date.parse(shown as string)).toBeGreaterThan(enrolledAt as number)
    } finally {
      await bridge.close()
    }
  })

  it('enrolling still succeeds when the last-used write fails, and says so in the log', async () => {
    const c = await rig.mintCode()
    const cookie = cookieOf(await rig.post('/api/auth/enroll/session', { code_auth: c.codeAuth }))
    const core = authState(rig.relay.services).core
    core.db.exec(
      "create trigger no_touch before update of last_used_at on auth_devices begin select raise(abort, 'disk full'); end",
    )
    const half = await deviceHalf(rig, c.code, cookie)
    expect(half.res.status).toBe(202)
    expect(core.device(half.dev.deviceId)).not.toBeNull() // the enrolment itself stands
    expect(rig.logs.some((l) => l.includes('could not record device use'))).toBe(true)
  })

  it('signing in over a live cookie ends the old session as "signed_in_again", not as an unexplained end', async () => {
    const first = await rig.post('/api/auth/enroll/session', { code_auth: (await rig.mintCode()).codeAuth })
    const oldCookie = cookieOf(first)
    const second = await rig.post(
      '/api/auth/enroll/session',
      { code_auth: (await rig.mintCode()).codeAuth },
      { cookie: oldCookie },
    )
    expect(second.status).toBe(200)
    // Another tab still holding the old cookie is told why, so its app keeps the shared unsent queue.
    const stale = await rig.get('/api/me', oldCookie)
    expect(stale.status).toBe(401)
    expect(await stale.json()).toMatchObject({ reason: 'signed_in_again' })
  })

  it('a used code is refused with 410', async () => {
    const c = await rig.mintCode()
    const first = await rig.post('/api/auth/enroll/session', { code_auth: c.codeAuth })
    expect((await deviceHalf(rig, c.code, cookieOf(first))).res.status).toBe(202) // burns it
    const again = await rig.post('/api/auth/enroll/session', { code_auth: c.codeAuth })
    expect(again.status).toBe(410)
    expect(await again.json()).toEqual({ error: 'code_invalid' })
    expect(again.headers.get('set-cookie')).toBeNull()
  })

  it('a code that already registered a passkey is refused', async () => {
    const c = await rig.mintCode()
    const core = authState(rig.relay.services).core
    core.addCredential({ credentialId: 'cred-n0', publicKey: new Uint8Array([1, 2, 3]), counter: 0, deviceName: 'k' })
    expect(core.claimCodeForRegistration(c.codeId, 'cred-n0')).toBe(true)
    const res = await rig.post('/api/auth/enroll/session', { code_auth: c.codeAuth })
    expect(res.status).toBe(410)
    expect(core.db.prepare('select count(*) from auth_sessions').pluck().get()).toBe(0)
  })

  it('an expired code is refused', async () => {
    const c = await rig.mintCode(60_000)
    rig.skew.ms = 61_000
    const res = await rig.post('/api/auth/enroll/session', { code_auth: c.codeAuth })
    expect(res.status).toBe(410)
    expect(res.headers.get('set-cookie')).toBeNull()
  })

  it('five bad codes in 10 minutes burn every outstanding code', async () => {
    const good = await rig.mintCode()
    const other = await rig.mintCode()
    const bad = deriveEnrollAuth(newEnrollCode())
    for (let i = 0; i < 4; i++)
      expect((await rig.post('/api/auth/enroll/session', { code_auth: bad })).status).toBe(410)
    expect((await rig.post('/api/auth/enroll/session', { code_auth: bad })).status).toBe(410) // the fifth
    for (const c of [good, other]) {
      const res = await rig.post('/api/auth/enroll/session', { code_auth: c.codeAuth })
      expect(res.status).toBe(410)
    }
    const core = authState(rig.relay.services).core
    expect(core.db.prepare('select count(*) from auth_enroll_codes where burned_at is null').pluck().get()).toBe(0)
  })

  it('misses on enroll/session and on enroll/options share one counter', async () => {
    const good = await rig.mintCode()
    const bad = deriveEnrollAuth(newEnrollCode())
    for (let i = 0; i < 3; i++) await rig.post('/api/auth/enroll/session', { code_auth: bad })
    for (let i = 0; i < 2; i++) await rig.post('/api/auth/enroll/options', { code_auth: bad })
    expect((await rig.post('/api/auth/enroll/session', { code_auth: good.codeAuth })).status).toBe(410)
  })

  it('a second call with the same live code deletes the first session and mints a new one', async () => {
    const c = await rig.mintCode()
    const core = authState(rig.relay.services).core
    const one = cookieOf(await rig.post('/api/auth/enroll/session', { code_auth: c.codeAuth }))
    expect((await rig.get('/api/me', one)).status).toBe(200)
    const two = cookieOf(await rig.post('/api/auth/enroll/session', { code_auth: c.codeAuth }))
    expect(two).not.toBe(one)
    expect((await rig.get('/api/me', one)).status).toBe(401) // the first is gone
    expect((await rig.get('/api/me', two)).status).toBe(200)
    expect(core.db.prepare('select count(*) from auth_sessions').pluck().get()).toBe(1)
    // The survivor can still finish pairing.
    expect((await deviceHalf(rig, c.code, two)).res.status).toBe(202)
  })

  it('a session minted from code A cannot pin with code B (refused, 410, nothing enrolled, code B untouched)', async () => {
    const a = await rig.mintCode()
    const b = await rig.mintCode()
    const core = authState(rig.relay.services).core
    const cookie = cookieOf(await rig.post('/api/auth/enroll/session', { code_auth: a.codeAuth }))
    const half = await deviceHalf(rig, b.code, cookie)
    expect(half.res.status).toBe(410)
    expect(await half.res.json()).toEqual({ error: 'code_invalid' })
    expect(core.device(half.dev.deviceId)).toBeNull()
    expect(core.findCode(b.codeAuth)).not.toBeNull() // B is not burned by someone else's session
    expect(core.findCode(a.codeAuth)).not.toBeNull()
    // The right code still works afterwards.
    expect((await deviceHalf(rig, a.code, cookie)).res.status).toBe(202)
  })

  it('that refusal counts toward the five-failures rule', async () => {
    const a = await rig.mintCode()
    const b = await rig.mintCode()
    const core = authState(rig.relay.services).core
    const cookie = cookieOf(await rig.post('/api/auth/enroll/session', { code_auth: a.codeAuth }))
    const bad = deriveEnrollAuth(newEnrollCode())
    for (let i = 0; i < 4; i++) await rig.post('/api/auth/enroll/session', { code_auth: bad })
    expect(core.findCode(a.codeAuth)).not.toBeNull() // four misses: still alive
    expect((await deviceHalf(rig, b.code, cookie)).res.status).toBe(410) // the fifth failure
    expect(core.findCode(a.codeAuth)).toBeNull()
    expect(core.findCode(b.codeAuth)).toBeNull()
  })

  it('a passkey session is unaffected: it can still verify a device with any live code', async () => {
    const c = await rig.mintCode()
    const core = authState(rig.relay.services).core
    core.addCredential({ credentialId: 'cred-pk', publicKey: new Uint8Array([1, 2, 3]), counter: 0, deviceName: 'k' })
    const cookie = `${COOKIE_NAME}=${core.createSession('cred-pk', null)}`
    expect(core.db.prepare('select enroll_code_id from auth_sessions').pluck().get()).toBeNull()
    expect((await deviceHalf(rig, c.code, cookie)).res.status).toBe(202)
  })

  describe('proof of possession for an already-pinned device (review F1)', () => {
    async function pinnedShell() {
      const bridge = await new FakeBridge({ relayWs: `ws://127.0.0.1:${rig.relay.port}`, key: rig.bridgeKey }).connect()
      const core = authState(rig.relay.services).core
      const a = await rig.mintCode()
      const cookieA = cookieOf(await rig.post('/api/auth/enroll/session', { code_auth: a.codeAuth }))
      const first = await deviceHalf(rig, a.code, cookieA)
      expect(first.res.status).toBe(202)
      bridge.send({ type: 'device.pinned', device_id: first.dev.deviceId, ok: true })
      await waitFor(() => core.device(first.dev.deviceId)?.pinned === true, 3000, 'pinned')
      return { bridge, core, dev: first.dev }
    }
    const body = (code: string, dev: Awaited<ReturnType<typeof createExtractableDeviceKeyForTests>>) => ({
      device: { id: dev.deviceId, name: 'Mac app', pubkey_jwk: dev.publicJwk },
      binding: bindingMac(deriveEnrollBind(code), dev.deviceId, dev.publicJwk),
      code_auth: deriveEnrollAuth(code),
    })

    it('the real owner re-signs in with a new code and no re-pair: ask, sign the nonce, 202, still pinned', async () => {
      const { bridge, core, dev } = await pinnedShell()
      try {
        const b = await rig.mintCode()
        const cookie = cookieOf(await rig.post('/api/auth/enroll/session', { code_auth: b.codeAuth }))
        const ask = await rig.post('/api/auth/device/verify', body(b.code, dev), { cookie })
        expect(ask.status).toBe(409)
        const j = (await ask.json()) as { error: string; challenge: string }
        expect(j.error).toBe('device_proof_required')
        expect(core.findCode(b.codeAuth)).not.toBeNull()
        const sig = await signDeviceProof(dev.privateKey, {
          nonce: j.challenge,
          codeId: b.codeId,
          deviceId: dev.deviceId,
        })
        const done = await rig.post(
          '/api/auth/device/verify',
          { ...body(b.code, dev), proof: { nonce: j.challenge, sig } },
          { cookie },
        )
        expect(done.status).toBe(202)
        expect(core.device(dev.deviceId)?.pinned).toBe(true)
        expect((await rig.get('/api/connections', cookie)).status).toBe(200) // no new y needed
        expect(core.findCode(b.codeAuth)).toBeNull()
      } finally {
        await bridge.close()
      }
    })

    it('a signature from any other key is refused, counts as a failure, and the nonce is spent', async () => {
      const { bridge, core, dev } = await pinnedShell()
      try {
        const b = await rig.mintCode()
        const cookie = cookieOf(await rig.post('/api/auth/enroll/session', { code_auth: b.codeAuth }))
        const { challenge } = (await (
          await rig.post('/api/auth/device/verify', body(b.code, dev), { cookie })
        ).json()) as {
          challenge: string
        }
        const mine = await createExtractableDeviceKeyForTests()
        const forged = await signDeviceProof(mine.privateKey, {
          nonce: challenge,
          codeId: b.codeId,
          deviceId: dev.deviceId,
        })
        const res = await rig.post(
          '/api/auth/device/verify',
          { ...body(b.code, dev), proof: { nonce: challenge, sig: forged } },
          { cookie },
        )
        expect(res.status).toBe(409)
        expect(core.db.prepare('select count(*) from auth_enroll_failures').pluck().get()).toBe(1)
        // and the right key cannot reuse the spent nonce
        const good = await signDeviceProof(dev.privateKey, {
          nonce: challenge,
          codeId: b.codeId,
          deviceId: dev.deviceId,
        })
        expect(
          (
            await rig.post(
              '/api/auth/device/verify',
              { ...body(b.code, dev), proof: { nonce: challenge, sig: good } },
              { cookie },
            )
          ).status,
        ).toBe(409)
      } finally {
        await bridge.close()
      }
    })

    it('a proof is bound to the session and the code: another session cannot use it, nor another code', async () => {
      const { bridge, dev } = await pinnedShell()
      try {
        const b = await rig.mintCode()
        const c2 = await rig.mintCode()
        const s1 = cookieOf(await rig.post('/api/auth/enroll/session', { code_auth: b.codeAuth }))
        const s2 = cookieOf(await rig.post('/api/auth/enroll/session', { code_auth: c2.codeAuth }))
        const { challenge } = (await (
          await rig.post('/api/auth/device/verify', body(b.code, dev), { cookie: s1 })
        ).json()) as {
          challenge: string
        }
        const sig = await signDeviceProof(dev.privateKey, {
          nonce: challenge,
          codeId: b.codeId,
          deviceId: dev.deviceId,
        })
        // a different session replaying it (with its own code)
        expect(
          (
            await rig.post(
              '/api/auth/device/verify',
              { ...body(c2.code, dev), proof: { nonce: challenge, sig } },
              { cookie: s2 },
            )
          ).status,
        ).toBe(409)
        // same session, signature made for a different code id
        const { challenge: ch2 } = (await (
          await rig.post('/api/auth/device/verify', body(b.code, dev), { cookie: s1 })
        ).json()) as {
          challenge: string
        }
        const wrong2 = await signDeviceProof(dev.privateKey, { nonce: ch2, codeId: c2.codeId, deviceId: dev.deviceId })
        expect(
          (
            await rig.post(
              '/api/auth/device/verify',
              { ...body(b.code, dev), proof: { nonce: ch2, sig: wrong2 } },
              { cookie: s1 },
            )
          ).status,
        ).toBe(409)
      } finally {
        await bridge.close()
      }
    })
  })

  it('two parallel device/verify calls on one code enroll exactly one device (review F2)', async () => {
    const c = await rig.mintCode()
    const cookie = cookieOf(await rig.post('/api/auth/enroll/session', { code_auth: c.codeAuth }))
    const [r1, r2] = await Promise.all([deviceHalf(rig, c.code, cookie), deviceHalf(rig, c.code, cookie)])
    expect([r1.res.status, r2.res.status].sort()).toEqual([202, 410])
  })

  it('a failed verify gives the code back so the owner can retry', async () => {
    const c = await rig.mintCode()
    const cookie = cookieOf(await rig.post('/api/auth/enroll/session', { code_auth: c.codeAuth }))
    const dev = await createExtractableDeviceKeyForTests()
    const bad = await rig.post(
      '/api/auth/device/verify',
      {
        device: { id: 'd_aaaaaaaaaaaaaaaaaaaa', name: 'x', pubkey_jwk: dev.publicJwk },
        binding: 'b',
        code_auth: c.codeAuth,
      },
      { cookie },
    )
    expect(bad.status).toBe(400)
    expect((await deviceHalf(rig, c.code, cookie)).res.status).toBe(202)
  })

  it('does not touch a session made for a different code', async () => {
    const a = await rig.mintCode()
    const b = await rig.mintCode()
    const sa = cookieOf(await rig.post('/api/auth/enroll/session', { code_auth: a.codeAuth }))
    await rig.post('/api/auth/enroll/session', { code_auth: b.codeAuth })
    expect((await rig.get('/api/me', sa)).status).toBe(200)
  })

  it('refuses a missing CSRF header and a bad Origin', async () => {
    const c = await rig.mintCode()
    const noCsrf = await fetch(`${rig.base}/api/auth/enroll/session`, {
      method: 'POST',
      headers: { origin: ORIGIN, 'content-type': 'application/json' },
      body: JSON.stringify({ code_auth: c.codeAuth }),
    })
    expect(noCsrf.status).toBe(403)
    const badOrigin = await rig.post(
      '/api/auth/enroll/session',
      { code_auth: c.codeAuth },
      { headers: { origin: 'https://evil.example.net' } },
    )
    expect(badOrigin.status).toBe(403)
    const formType = await rig.post(
      '/api/auth/enroll/session',
      {},
      { headers: { 'content-type': 'application/x-www-form-urlencoded' } },
    )
    expect(formType.status).toBe(403)
    const core = authState(rig.relay.services).core
    expect(core.db.prepare('select count(*) from auth_sessions').pluck().get()).toBe(0)
    expect(core.findCode(c.codeAuth)).not.toBeNull() // refused before the code was looked at
  })

  it('answers 400 to a body that is not { code_auth }', async () => {
    expect((await rig.post('/api/auth/enroll/session', {})).status).toBe(400)
    expect((await rig.post('/api/auth/enroll/session', { code_auth: 5 })).status).toBe(400)
  })

  it('is rate limited under the auth bucket', async () => {
    const bad = deriveEnrollAuth(newEnrollCode())
    const codes: number[] = []
    for (let i = 0; i < 12; i++) codes.push((await rig.post('/api/auth/enroll/session', { code_auth: bad })).status)
    expect(codes).toContain(429)
  })

  it('never writes the code to the logs or the database in plaintext', async () => {
    const c = await rig.mintCode()
    const res = await rig.post('/api/auth/enroll/session', { code_auth: c.codeAuth })
    const cookie = cookieOf(res)
    await deviceHalf(rig, c.code, cookie)
    await rig.post('/api/auth/enroll/session', { code_auth: deriveEnrollAuth(newEnrollCode()) })
    const token = cookie.split('=')[1] as string
    const core = authState(rig.relay.services).core
    const tables = core.db.prepare("select name from sqlite_master where type = 'table'").pluck().all() as string[]
    const dump = tables.map((t) => JSON.stringify(core.db.prepare(`select * from "${t}"`).all())).join('\n')
    for (const secret of [c.code, c.codeAuth, token]) {
      expect(dump).not.toContain(secret)
      expect(rig.logs.join('\n')).not.toContain(secret)
    }
    expect(dump).toContain(c.hash) // only the hash is kept
  })

  it('the minted session cannot reach any data route before pinning', async () => {
    const c = await rig.mintCode()
    const cookie = cookieOf(await rig.post('/api/auth/enroll/session', { code_auth: c.codeAuth }))
    const allowed = new Set(['/api/me', '/api/auth/logout', '/api/auth/device/verify'])
    const fill = (p: string) => p.replace(/:[A-Za-z_]+/g, 'x0')
    let checked = 0
    for (const r of ROUTE_LIST) {
      if (r.auth !== 'session' || r.path === '/ws' || r.path === '/bridge' || allowed.has(r.path)) continue
      const res = await fetch(`${rig.base}${fill(r.path)}`, {
        method: r.method,
        headers: { cookie, origin: ORIGIN, 'x-talos-csrf': '1', 'content-type': 'application/json' },
        ...(r.method === 'GET' || r.method === 'DELETE' ? {} : { body: '{}' }),
      })
      expect(res.status, `${r.method} ${r.path}`).toBe(403)
      expect(await res.json(), `${r.method} ${r.path}`).toEqual({ error: 'device_not_pinned' })
      checked++
    }
    expect(checked).toBeGreaterThan(20)
  })

  it('the route table is still default-deny, and the new row is listed', async () => {
    const row = ROUTE_LIST.find((r) => r.path === '/api/auth/enroll/session')
    expect(row).toMatchObject({ id: 'enrollSession', method: 'POST', auth: 'code_auth' })
    const { unlistedRoutes } = await import('../../src/route-table.ts')
    const { buildApp } = await import('../../src/routes.ts')
    expect(unlistedRoutes(buildApp(rig.relay.services))).toEqual([])
  })
})
