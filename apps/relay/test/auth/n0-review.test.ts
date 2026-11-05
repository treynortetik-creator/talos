// Adversarial review of PR #53 (WP-N0, POST /api/auth/enroll/session). Runs the REAL relay (startRelay, NODE_ENV=development
// so test-auth is refused) over real HTTP and WebSocket, with FakeBridge as the Mac, exactly like the PR's own suite.
//
// The `FAILS` block holds tests that describe what the spec / threat model needs and FAIL on 3b2c637 (the PR head).
// The `probes` block holds checks that PASS on 3b2c637: they are evidence for the review, not findings.
import { createHash, generateKeyPairSync } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { isoCBOR } from '@simplewebauthn/server/helpers'
import {
  type BridgeKeyPair,
  b64urlEncode,
  bindingMac,
  createExtractableDeviceKeyForTests,
  deriveEnrollAuth,
  deriveEnrollBind,
  enrollAuthHash,
  enrollCodeId,
  generateBridgeKey,
  NativeNotify,
  newEnrollCode,
  signBridgeHttp,
} from '@talos-app/protocol'
import { FakeApp, FakeBridge, waitFor } from '@talos-app/testkit'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { resetAuthImplementation } from '../../src/auth/contract.ts'
import { authState } from '../../src/auth/state.ts'
import { COOKIE_NAME } from '../../src/auth/util.ts'
import { NoopTransport } from '../../src/core/push.ts'
import { loadEnv } from '../../src/env.ts'
import { type RunningRelay, startRelay } from '../../src/index.ts'
import { TEST_DATA_KEY } from '../helpers/fake-services.ts'

const ORIGIN = 'https://relay.example.com'
const RP_ID = 'relay.example.com'

type Rig = {
  relay: RunningRelay
  base: string
  bridgeKey: BridgeKeyPair
  logs: string[]
  mintCode(): Promise<{ code: string; codeAuth: string; codeId: string }>
  post(path: string, body: unknown, cookie?: string): Promise<Response>
  get(path: string, cookie?: string): Promise<Response>
  stop(): Promise<void>
}

async function startRig(): Promise<Rig> {
  const dir = mkdtempSync(join(tmpdir(), 'talos-n0-review-'))
  const bridgeKey = await generateBridgeKey()
  const logs: string[] = []
  const clock = {
    now: () => Date.now(),
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
      NODE_ENV: 'development',
      DATA_DIR: dir,
      PUBLIC_ORIGIN: ORIGIN,
      RP_ID,
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
  return {
    relay,
    base,
    bridgeKey,
    logs,
    post: (path, body, cookie) =>
      fetch(`${base}${path}`, {
        method: 'POST',
        headers: {
          origin: ORIGIN,
          'x-talos-csrf': '1',
          'content-type': 'application/json',
          ...(cookie ? { cookie } : {}),
        },
        body: JSON.stringify(body),
      }),
    get: (path, cookie) => fetch(`${base}${path}`, { headers: cookie ? { cookie } : {} }),
    async mintCode() {
      const code = newEnrollCode()
      const codeAuth = deriveEnrollAuth(code)
      const hash = enrollAuthHash(codeAuth)
      const codeId = enrollCodeId(hash)
      const raw = JSON.stringify({
        code_id: codeId,
        code_auth_hash: hash,
        expires_at: new Date(clock.now() + 600_000).toISOString(),
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
      return { code, codeAuth, codeId }
    },
    async stop() {
      await relay.stop()
      resetAuthImplementation()
      rmSync(dir, { recursive: true, force: true })
    },
  }
}

const cookieOf = (res: Response): string => {
  const m = new RegExp(`${COOKIE_NAME}=([A-Za-z0-9_-]+)`).exec(res.headers.get('set-cookie') ?? '')
  if (!m) throw new Error(`no session cookie (status ${res.status})`)
  return `${COOKIE_NAME}=${m[1]}`
}

type Dev = { deviceId: string; publicJwk: Record<string, unknown> }

/** device/verify for `dev` with `code`. Only PUBLIC device material is used: no private key, no signature. */
const verifyDevice = (rig: Rig, code: string, cookie: string, dev: Dev, name = 'Mac app') =>
  rig.post(
    '/api/auth/device/verify',
    {
      device: { id: dev.deviceId, name, pubkey_jwk: dev.publicJwk },
      binding: bindingMac(deriveEnrollBind(code), dev.deviceId, dev.publicJwk as never),
      code_auth: deriveEnrollAuth(code),
    },
    cookie,
  )

/** The owner signs in a native shell with code A and the Mac says y. Returns the pinned device and its cookie. */
async function ownerPinsNativeShell(rig: Rig, bridge: FakeBridge) {
  const a = await rig.mintCode()
  const cookie = cookieOf(await rig.post('/api/auth/enroll/session', { code_auth: a.codeAuth }))
  const dev = await createExtractableDeviceKeyForTests()
  expect((await verifyDevice(rig, a.code, cookie, dev)).status).toBe(202)
  await bridge.expectFrame('device.enrolled', (f) => f.device.id === dev.deviceId, { direction: 'in' })
  bridge.send({ type: 'device.pinned', device_id: dev.deviceId, ok: true })
  const core = authState(rig.relay.services).core
  await waitFor(() => core.device(dev.deviceId)?.pinned === true, 3000, 'owner device pinned')
  expect((await rig.get('/api/connections', cookie)).status).toBe(200)
  return { dev, cookie }
}

// A software passkey (attestation 'none', ES256), lifted from test/auth/review.test.ts.
const sha = (b: Uint8Array | string) => new Uint8Array(createHash('sha256').update(b).digest())
const concat = (...parts: Uint8Array[]) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0))
  let i = 0
  for (const p of parts) {
    out.set(p, i)
    i += p.length
  }
  return out
}
function softPasskey() {
  const credIdBytes = crypto.getRandomValues(new Uint8Array(16))
  const { publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' })
  const jwk = publicKey.export({ format: 'jwk' }) as { x: string; y: string }
  const cose = new Map<number, number | Uint8Array>([
    [1, 2],
    [3, -7],
    [-1, 1],
    [-2, new Uint8Array(Buffer.from(jwk.x, 'base64url'))],
    [-3, new Uint8Array(Buffer.from(jwk.y, 'base64url'))],
  ])
  const credId = b64urlEncode(credIdBytes)
  return {
    credId,
    register(challenge: string) {
      const clientData = JSON.stringify({ type: 'webauthn.create', challenge, origin: ORIGIN, crossOrigin: false })
      const authData = concat(
        sha(RP_ID),
        new Uint8Array([0x45]),
        new Uint8Array(4),
        new Uint8Array(16),
        new Uint8Array([0, credIdBytes.length]),
        credIdBytes,
        isoCBOR.encode(cose as never),
      )
      const att = isoCBOR.encode(
        new Map<string, unknown>([
          ['fmt', 'none'],
          ['attStmt', new Map()],
          ['authData', authData],
        ]) as never,
      )
      return {
        id: credId,
        rawId: credId,
        type: 'public-key',
        clientExtensionResults: {},
        response: {
          clientDataJSON: b64urlEncode(new TextEncoder().encode(clientData)),
          attestationObject: b64urlEncode(att),
          transports: ['internal'],
        },
      }
    },
  }
}

let rig: Rig
beforeEach(async () => {
  rig = await startRig()
})
afterEach(async () => {
  await rig.stop()
})

describe('N0 review: FAILS on 3b2c637', () => {
  it('F1 (HIGH): a second live code + the owner native device PUBLIC key buys a pinned session with no y at the Mac', async () => {
    const bridge = await new FakeBridge({ relayWs: `ws://127.0.0.1:${rig.relay.port}`, key: rig.bridgeKey }).connect()
    try {
      // The owner's Mac shell is signed in and pinned the WP-N0 way: its device row has credential_id NULL.
      const owner = await ownerPinsNativeShell(rig, bridge)
      const core = authState(rig.relay.services).core
      expect(core.device(owner.dev.deviceId)?.credentialId).toBeNull()

      // Later the owner mints code B (for the iPhone, say) and someone else gets it (the threat setup codes exist for:
      // the y at the Mac is supposed to be the backstop). They know the Mac shell's device id and PUBLIC JWK, which
      // is not a secret (GET /api/devices lists it, device.enrolled carries it, the shell keeps it in plain storage).
      const b = await rig.mintCode()
      const attacker = cookieOf(await rig.post('/api/auth/enroll/session', { code_auth: b.codeAuth }))
      const publicOnly: Dev = { deviceId: owner.dev.deviceId, publicJwk: owner.dev.publicJwk as never }
      const res = await verifyDevice(rig, b.code, attacker, publicOnly, 'iPhone')

      // `existing.pinned && existing.credentialId !== credentialId` is `null !== null` -> false, so the relay re-enrolls
      // the owner's pinned device under the attacker's session and keeps it pinned. Nobody typed y.
      const outcome = {
        verify: res.status,
        connections: (await rig.get('/api/connections', attacker)).status,
        devices: (await rig.get('/api/devices', attacker)).status,
        inbox: (await rig.get('/api/inbox', attacker)).status,
        stillPinned: core.device(owner.dev.deviceId)?.pinned,
      }
      // Expected: 409 device_exists (or an unpinned re-enroll that waits for the Mac), and every data route 403.
      expect(outcome).toEqual({ verify: 409, connections: 403, devices: 403, inbox: 403, stillPinned: true })
    } finally {
      await bridge.close()
    }
  })

  it('F1b: the same hijack gives the attacker a full (not pairing-only) WebSocket', async () => {
    const bridge = await new FakeBridge({ relayWs: `ws://127.0.0.1:${rig.relay.port}`, key: rig.bridgeKey }).connect()
    let app: FakeApp | null = null
    try {
      const owner = await ownerPinsNativeShell(rig, bridge)
      const b = await rig.mintCode()
      const attacker = cookieOf(await rig.post('/api/auth/enroll/session', { code_auth: b.codeAuth }))
      await verifyDevice(rig, b.code, attacker, {
        deviceId: owner.dev.deviceId,
        publicJwk: owner.dev.publicJwk as never,
      })
      // hello carries the owner's device id; the relay checks it equals session.device_id, which it now does.
      app = new FakeApp({
        relayWs: `ws://127.0.0.1:${rig.relay.port}`,
        headers: { cookie: attacker, origin: ORIGIN },
        deviceKey: owner.dev as never,
      })
      await app.connect()
      // A pairing-only socket answers catchup.request with error device_not_pinned; a full one serves the history.
      app.send({ type: 'catchup.request', since_seq: 0 })
      const err = await app.expectFrame('error', undefined, { direction: 'in', timeoutMs: 1500 }).catch(() => null)
      expect((err as { code?: string } | null)?.code, 'attacker socket must be pairing-only').toBe('device_not_pinned')
    } finally {
      await app?.close()
      await bridge.close()
    }
  })

  it('F2 (LOW, pre-existing race, now reachable from a setup-code session): two concurrent device/verify on one code enroll ONE device', async () => {
    const c = await rig.mintCode()
    const cookie = cookieOf(await rig.post('/api/auth/enroll/session', { code_auth: c.codeAuth }))
    const d1 = await createExtractableDeviceKeyForTests()
    const d2 = await createExtractableDeviceKeyForTests()
    // checkCode runs before `await deviceIdFromJwk(...)` and `await bus.toBridge(...)`; markCodeUsed runs after them.
    const [r1, r2] = await Promise.all([verifyDevice(rig, c.code, cookie, d1), verifyDevice(rig, c.code, cookie, d2)])
    const statuses = [r1.status, r2.status].sort()
    const core = authState(rig.relay.services).core
    const enrolled = [d1, d2].filter((d) => core.device(d.deviceId) !== null).length
    expect(enrolled, `statuses ${statuses.join(',')}`).toBe(1)
  })

  it('F3 (MEDIUM): native notify.navigate cannot leave the app (backslash and tab tricks resolve off-origin)', () => {
    for (const navigate of ['/\\evil.example', '/\t/evil.example', '/\\/evil.example', '/\n/evil.example']) {
      const ok = NativeNotify.safeParse({ type: 'notify', title: 't', body: 'b', navigate }).success
      const resolved = new URL(navigate, ORIGIN).origin
      expect(resolved).not.toBe(ORIGIN) // proves the string escapes the app when a shell resolves it
      expect(ok, `${JSON.stringify(navigate)} resolves to ${resolved}`).toBe(false)
    }
  })
})

describe('N0 review: probes (PASS on 3b2c637)', () => {
  it('P1: two concurrent enroll/session calls on one code leave exactly one live session', async () => {
    const c = await rig.mintCode()
    const rs = await Promise.all(
      Array.from({ length: 4 }, () => rig.post('/api/auth/enroll/session', { code_auth: c.codeAuth })),
    )
    const cookies = rs.filter((r) => r.status === 200).map(cookieOf)
    const live = await Promise.all(cookies.map(async (k) => (await rig.get('/api/me', k)).status === 200))
    expect(live.filter(Boolean).length).toBe(1)
    const core = authState(rig.relay.services).core
    expect(core.db.prepare('select count(*) from auth_sessions').pluck().get()).toBe(1)
  })

  it('P2: enroll/session racing a passkey registration on the same code: at most one path can pin', async () => {
    const c = await rig.mintCode()
    const pk = softPasskey()
    const opts = await rig.post('/api/auth/enroll/options', { code_auth: c.codeAuth })
    const { challenge } = (await opts.json()) as { challenge: string }
    const [reg, ses] = await Promise.all([
      rig.post('/api/auth/enroll/verify', { code_auth: c.codeAuth, response: pk.register(challenge) }),
      rig.post('/api/auth/enroll/session', { code_auth: c.codeAuth }),
    ])
    const sessions = [reg, ses].filter((r) => r.status === 200).map(cookieOf)
    let pinned = 0
    for (const k of sessions) {
      const r = await verifyDevice(rig, c.code, k, await createExtractableDeviceKeyForTests())
      if (r.status === 202) pinned++
    }
    expect(pinned).toBeLessThanOrEqual(1)
    // If the passkey won, the setup-code session (if one was minted) is refused by device/verify.
    if (reg.status === 200 && ses.status === 200) {
      expect((await verifyDevice(rig, c.code, cookieOf(ses), await createExtractableDeviceKeyForTests())).status).toBe(
        410,
      )
    }
  })

  it('P3: an unpinned setup-code session gets a pairing-only WebSocket (non-pairing frames refused)', async () => {
    const c = await rig.mintCode()
    const cookie = cookieOf(await rig.post('/api/auth/enroll/session', { code_auth: c.codeAuth }))
    const app = new FakeApp({ relayWs: `ws://127.0.0.1:${rig.relay.port}`, headers: { cookie, origin: ORIGIN } })
    try {
      await app.connect()
      app.send({ type: 'catchup.request', since_seq: 0 })
      const err = await app.expectFrame('error', undefined, { direction: 'in' })
      expect((err as { code: string }).code).toBe('device_not_pinned')
    } finally {
      await app.close()
    }
    // and the upgrade itself is refused without the right Origin
    const bad = new FakeApp({
      relayWs: `ws://127.0.0.1:${rig.relay.port}`,
      headers: { cookie, origin: 'https://x.example' },
    })
    expect(await bad.connectExpectingRefusal()).toBe(403)
  })

  it('P4: media and push subscribe are 403 device_not_pinned for the unpinned session', async () => {
    const c = await rig.mintCode()
    const cookie = cookieOf(await rig.post('/api/auth/enroll/session', { code_auth: c.codeAuth }))
    const sub = await rig.post(
      '/api/push/subscribe',
      { endpoint: 'https://push.example/x', keys: { p256dh: 'a', auth: 'b' } },
      cookie,
    )
    expect(sub.status).toBe(403)
    expect((await rig.get('/media/med_01J0000000000000000000000', cookie)).status).toBe(403)
    const up = await fetch(`${rig.base}/api/media`, {
      method: 'POST',
      headers: { cookie, origin: ORIGIN, 'x-talos-csrf': '1', 'content-type': 'image/png' },
      body: new Uint8Array([1, 2, 3]),
    })
    expect(up.status).toBe(403)
  })

  it('P5: a session minted from a code that is then burned (five failures) can never pin, and the code cannot mint again', async () => {
    const c = await rig.mintCode()
    const cookie = cookieOf(await rig.post('/api/auth/enroll/session', { code_auth: c.codeAuth }))
    const bad = deriveEnrollAuth(newEnrollCode())
    for (let i = 0; i < 5; i++) await rig.post('/api/auth/enroll/session', { code_auth: bad })
    expect((await verifyDevice(rig, c.code, cookie, await createExtractableDeviceKeyForTests())).status).toBe(410)
    expect((await rig.post('/api/auth/enroll/session', { code_auth: c.codeAuth })).status).toBe(410)
  })

  it('P6: the "setup-code" sentinel never lands in the device registry, and a passkey login cannot ride a native device', async () => {
    const bridge = await new FakeBridge({ relayWs: `ws://127.0.0.1:${rig.relay.port}`, key: rig.bridgeKey }).connect()
    try {
      const owner = await ownerPinsNativeShell(rig, bridge)
      const core = authState(rig.relay.services).core
      expect(
        core.db.prepare("select count(*) from auth_devices where credential_id = 'setup-code'").pluck().get(),
      ).toBe(0)
      expect(
        core.db.prepare("select count(*) from auth_sessions where credential_id = 'setup-code'").pluck().get(),
      ).toBe(0)
      // A passkey session (any credential) re-enrolling the native device id is refused (cred X !== null).
      core.addCredential({ credentialId: 'cred-x', publicKey: new Uint8Array([1]), counter: 0, deviceName: 'k' })
      const pkCookie = `${COOKIE_NAME}=${core.createSession('cred-x', null)}`
      const c = await rig.mintCode()
      const r = await verifyDevice(rig, c.code, pkCookie, {
        deviceId: owner.dev.deviceId,
        publicJwk: owner.dev.publicJwk as never,
      })
      expect(r.status).toBe(409)
    } finally {
      await bridge.close()
    }
  })

  it('P8 (control for F1): a device pinned under a PASSKEY session cannot be taken by a setup-code session', async () => {
    const core = authState(rig.relay.services).core
    core.addCredential({ credentialId: 'cred-owner', publicKey: new Uint8Array([1]), counter: 0, deviceName: 'k' })
    const ownerCookie = `${COOKIE_NAME}=${core.createSession('cred-owner', null)}`
    const a = await rig.mintCode()
    const dev = await createExtractableDeviceKeyForTests()
    expect((await verifyDevice(rig, a.code, ownerCookie, dev)).status).toBe(202)
    core.setPinned(dev.deviceId, true)
    const b = await rig.mintCode()
    const attacker = cookieOf(await rig.post('/api/auth/enroll/session', { code_auth: b.codeAuth }))
    const r = await verifyDevice(rig, b.code, attacker, { deviceId: dev.deviceId, publicJwk: dev.publicJwk as never })
    expect(r.status).toBe(409) // 'cred-owner' !== null: the credential binding is what F1 is missing for native devices
    expect((await rig.get('/api/connections', attacker)).status).toBe(403)
  })

  it('P7: no code material in logs on the error paths (bad JSON, bad body, wrong code, used code, CSRF refusals)', async () => {
    const c = await rig.mintCode()
    await fetch(`${rig.base}/api/auth/enroll/session`, {
      method: 'POST',
      headers: { origin: ORIGIN, 'x-talos-csrf': '1', 'content-type': 'application/json' },
      body: `{"code_auth":"${c.codeAuth}"`,
    })
    await rig.post('/api/auth/enroll/session', { code_auth: c.codeAuth, extra: c.code })
    await fetch(`${rig.base}/api/auth/enroll/session`, {
      method: 'POST',
      headers: { origin: 'https://evil.example', 'x-talos-csrf': '1', 'content-type': 'application/json' },
      body: JSON.stringify({ code_auth: c.codeAuth }),
    })
    const k = cookieOf(await rig.post('/api/auth/enroll/session', { code_auth: c.codeAuth }))
    await verifyDevice(rig, c.code, k, await createExtractableDeviceKeyForTests())
    await rig.post('/api/auth/enroll/session', { code_auth: c.codeAuth }) // used
    const all = rig.logs.join('\n')
    for (const s of [c.code, c.codeAuth, deriveEnrollAuth(c.code)]) expect(all).not.toContain(s)
  })
})
