// RE-CHECK of PR #53 at 72a21b1 (device proof of possession, atomic claim, strict paths). Same rig as n0-review.test.ts.
// FAILS block: fail on 72a21b1. probes: pass on 72a21b1.
// Adversarial review of PR #53 (WP-N0, POST /api/auth/enroll/session). Runs the REAL relay (startRelay, NODE_ENV=development
// so test-auth is refused) over real HTTP and WebSocket, with FakeBridge as the Mac, exactly like the PR's own suite.
//
// The `FAILS` block holds tests that describe what the spec / threat model needs and FAIL on 3b2c637 (the PR head).
// The `probes` block holds checks that PASS on 3b2c637: they are evidence for the review, not findings.
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
  NativeNavigate,
  NativeNotify,
  newEnrollCode,
  signBridgeHttp,
  signDeviceProof,
} from '@talos-app/protocol'
import { FakeBridge, waitFor } from '@talos-app/testkit'
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
  skew: { ms: number }
  mintCode(): Promise<{ code: string; codeAuth: string; codeId: string }>
  post(path: string, body: unknown, cookie?: string): Promise<Response>
  get(path: string, cookie?: string): Promise<Response>
  stop(): Promise<void>
}

async function startRig(): Promise<Rig> {
  const dir = mkdtempSync(join(tmpdir(), 'talos-n0-recheck-'))
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
    skew,
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

type Key = Awaited<ReturnType<typeof createExtractableDeviceKeyForTests>>

/** device/verify with an optional proof. */
const verifyWith = (rig: Rig, code: string, cookie: string, dev: Dev, proof?: { nonce: string; sig: string }) =>
  rig.post(
    '/api/auth/device/verify',
    {
      device: { id: dev.deviceId, name: 'shell', pubkey_jwk: dev.publicJwk },
      binding: bindingMac(deriveEnrollBind(code), dev.deviceId, dev.publicJwk as never),
      code_auth: deriveEnrollAuth(code),
      ...(proof ? { proof } : {}),
    },
    cookie,
  )

async function askNonce(rig: Rig, code: string, cookie: string, dev: Dev): Promise<string> {
  const r = await verifyWith(rig, code, cookie, dev)
  expect(r.status).toBe(409)
  const j = (await r.json()) as { error: string; challenge: string }
  expect(j.error).toBe('device_proof_required')
  return j.challenge
}

const sign = (k: Key, nonce: string, codeId: string) =>
  signDeviceProof(k.privateKey, { nonce, codeId, deviceId: k.deviceId })

let rig: Rig
beforeEach(async () => {
  rig = await startRig()
})
afterEach(async () => {
  await rig.stop()
})

describe('N0 re-check: FAILS on 72a21b1', () => {
  it("R1 (HIGH): an EXISTING-but-unpinned device needs no proof, so a second code rides the owner's pending pin", async () => {
    const bridge = await new FakeBridge({ relayWs: `ws://127.0.0.1:${rig.relay.port}`, key: rig.bridgeKey }).connect()
    try {
      const core = authState(rig.relay.services).core
      // The owner is mid-pairing: shell D did device/verify with code A and the Mac shows four words, waiting for y.
      const a = await rig.mintCode()
      const owner = cookieOf(await rig.post('/api/auth/enroll/session', { code_auth: a.codeAuth }))
      const d = await createExtractableDeviceKeyForTests()
      expect((await verifyWith(rig, a.code, owner, d)).status).toBe(202)
      expect(core.device(d.deviceId)?.pinned).toBe(false)

      // An attacker with a second live code B and D's PUBLIC key attaches their session to D. `existing.pinned` is false,
      // so the proof branch never runs.
      const b = await rig.mintCode()
      const attacker = cookieOf(await rig.post('/api/auth/enroll/session', { code_auth: b.codeAuth }))
      const hijack = await verifyWith(rig, b.code, attacker, { deviceId: d.deviceId, publicJwk: d.publicJwk as never })

      // The owner types y for HIS prompt. The relay pins by device id, so every session attached to D is now pinned.
      bridge.send({ type: 'device.pinned', device_id: d.deviceId, ok: true })
      await waitFor(() => core.device(d.deviceId)?.pinned === true, 3000, 'pinned')
      const outcome = {
        hijackStatus: hijack.status,
        attackerConnections: (await rig.get('/api/connections', attacker)).status,
        ownerConnections: (await rig.get('/api/connections', owner)).status,
      }
      expect(outcome).toEqual({ hijackStatus: 409, attackerConnections: 403, ownerConnections: 200 })
    } finally {
      await bridge.close()
    }
  })

  it('R2 (NIT): navigate refuses percent-encoded spellings of the excluded spaces', () => {
    for (const path of ['/%6dedia/med_1', '/%61pi/devices', '/%4D%45%44%49%41/x']) {
      const decoded = decodeURIComponent(new URL(path, ORIGIN).pathname)
      expect(decoded).toMatch(/^\/(media|api)\//i) // what a decoding router or WKWebView URL.path sees
      expect(NativeNavigate.safeParse({ type: 'navigate', path }).success, path).toBe(false)
    }
  })
})

describe('N0 re-check: probes (PASS on 72a21b1)', () => {
  async function pinnedShell() {
    const bridge = await new FakeBridge({ relayWs: `ws://127.0.0.1:${rig.relay.port}`, key: rig.bridgeKey }).connect()
    const owner = await ownerPinsNativeShell(rig, bridge)
    await bridge.close()
    return owner
  }

  it('Q1: a nonce issued for device A cannot be used for device B (same session, both keys held)', async () => {
    const one = await pinnedShell()
    const k1 = one.dev as Key
    // Pin a second shell too.
    const core = authState(rig.relay.services).core
    const c2 = await rig.mintCode()
    const s2 = cookieOf(await rig.post('/api/auth/enroll/session', { code_auth: c2.codeAuth }))
    const k2 = await createExtractableDeviceKeyForTests()
    expect((await verifyWith(rig, c2.code, s2, k2)).status).toBe(202)
    core.setPinned(k2.deviceId, true)

    const c = await rig.mintCode()
    const s = cookieOf(await rig.post('/api/auth/enroll/session', { code_auth: c.codeAuth }))
    const nonceForA = await askNonce(rig, c.code, s, k1)
    const r = await verifyWith(rig, c.code, s, k2, { nonce: nonceForA, sig: await sign(k2, nonceForA, c.codeId) })
    expect(r.status).toBe(409)
    expect(core.findCode(c.codeAuth)).not.toBeNull() // released, not burned
  })

  it('Q2: a spent nonce cannot be replayed with a fresh code and a fresh session', async () => {
    const one = await pinnedShell()
    const k = one.dev as Key
    const b = await rig.mintCode()
    const s = cookieOf(await rig.post('/api/auth/enroll/session', { code_auth: b.codeAuth }))
    const n = await askNonce(rig, b.code, s, k)
    expect((await verifyWith(rig, b.code, s, k, { nonce: n, sig: await sign(k, n, b.codeId) })).status).toBe(202)
    const c = await rig.mintCode()
    const s2 = cookieOf(await rig.post('/api/auth/enroll/session', { code_auth: c.codeAuth }))
    expect((await verifyWith(rig, c.code, s2, k, { nonce: n, sig: await sign(k, n, c.codeId) })).status).toBe(409)
  })

  it('Q3: the nonce dies at 120 s (119 s ok, 121 s refused)', async () => {
    const one = await pinnedShell()
    const k = one.dev as Key
    const b = await rig.mintCode()
    const s = cookieOf(await rig.post('/api/auth/enroll/session', { code_auth: b.codeAuth }))
    const late = await askNonce(rig, b.code, s, k)
    rig.skew.ms = 121_000
    expect((await verifyWith(rig, b.code, s, k, { nonce: late, sig: await sign(k, late, b.codeId) })).status).toBe(409)
    const n = await askNonce(rig, b.code, s, k)
    rig.skew.ms += 119_000
    expect((await verifyWith(rig, b.code, s, k, { nonce: n, sig: await sign(k, n, b.codeId) })).status).toBe(202)
  })

  it('Q4: asking for a nonce counts no failure, burns nothing, and leaves the code unclaimed', async () => {
    const one = await pinnedShell()
    const k = one.dev as Key
    const core = authState(rig.relay.services).core
    const b = await rig.mintCode()
    const other = await rig.mintCode()
    const s = cookieOf(await rig.post('/api/auth/enroll/session', { code_auth: b.codeAuth }))
    for (let i = 0; i < 6; i++) await askNonce(rig, b.code, s, k)
    expect(core.db.prepare('select count(*) from auth_enroll_failures').pluck().get()).toBe(0)
    expect(core.findCode(b.codeAuth)).not.toBeNull()
    expect(core.findCode(other.codeAuth)).not.toBeNull()
  })

  it('Q5: a forged JWK cannot collide with a pinned device id (the id is checked against the presented key)', async () => {
    const one = await pinnedShell()
    const b = await rig.mintCode()
    const s = cookieOf(await rig.post('/api/auth/enroll/session', { code_auth: b.codeAuth }))
    const mine = await createExtractableDeviceKeyForTests()
    // the owner's id with the attacker's key: refused before the proof branch
    const r = await verifyWith(rig, b.code, s, { deviceId: one.dev.deviceId, publicJwk: mine.publicJwk as never })
    expect(r.status).toBe(400)
  })

  it('Q6: F3 path rule holds for the backslash, whitespace, dot-segment and case tricks', () => {
    for (const path of [
      '/\\evil.example',
      '/\t/evil.example',
      '/x/%2e%2e/media/1',
      '/x/../api/me',
      '/MEDIA/1',
      '/ws',
      '//x',
    ]) {
      expect(NativeNavigate.safeParse({ type: 'navigate', path }).success, path).toBe(false)
      expect(NativeNotify.safeParse({ type: 'notify', title: 't', body: 'b', navigate: path }).success, path).toBe(
        false,
      )
    }
    for (const path of ['/', '/t/th_x?q=1#m', '/settings']) {
      expect(NativeNavigate.safeParse({ type: 'navigate', path }).success, path).toBe(true)
    }
  })

  it('Q7: the parallel claim: two device/verify on one code, one 202', async () => {
    const c = await rig.mintCode()
    const s = cookieOf(await rig.post('/api/auth/enroll/session', { code_auth: c.codeAuth }))
    const [d1, d2] = [await createExtractableDeviceKeyForTests(), await createExtractableDeviceKeyForTests()]
    const rs = await Promise.all([verifyWith(rig, c.code, s, d1), verifyWith(rig, c.code, s, d2)])
    expect(rs.map((r) => r.status).sort()).toEqual([202, 410])
  })
})

describe('v6fu review: a wrong device proof burns the code it was sent with (finding 16)', () => {
  it('five wrong proofs on a held code burn the owner other codes AND the leaked one', async () => {
    const bridge = await new FakeBridge({ relayWs: `ws://127.0.0.1:${rig.relay.port}`, key: rig.bridgeKey }).connect()
    try {
      const owner = await ownerPinsNativeShell(rig, bridge)
      const held = await rig.mintCode() // the leaked one
      const other = await rig.mintCode() // the owner's next code
      const cookie = cookieOf(await rig.post('/api/auth/enroll/session', { code_auth: held.codeAuth }))
      let challenge = await askNonce(rig, held.code, cookie, owner.dev)
      const burned = (id: string) =>
        authState(rig.relay.services)
          .core.db.prepare('select burned_at from auth_enroll_codes where code_id = ?')
          .pluck()
          .get(id)
      for (let i = 0; i < 5; i++) {
        expect(burned(held.codeId)).toBeNull()
        const r = await verifyWith(rig, held.code, cookie, owner.dev, { nonce: challenge, sig: 'A'.repeat(86) })
        expect(r.status).toBe(409)
        challenge = ((await r.json()) as { challenge: string }).challenge
      }
      expect(burned(other.codeId)).not.toBeNull()
      expect(burned(held.codeId)).not.toBeNull()
      // and the leaker cannot mint a fresh session with the burned code
      expect((await rig.post('/api/auth/enroll/session', { code_auth: held.codeAuth })).status).toBe(410)
    } finally {
      await bridge.close()
    }
  })
})
