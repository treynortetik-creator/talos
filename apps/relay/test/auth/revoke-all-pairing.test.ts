// V11: does "sign out everywhere" (POST /api/auth/logout-all, the only revoke-all the relay has) also cancel a pairing in
// progress? A code has been shown on the Mac and the new device has not finished. After it, the pending pairing is refused
// and its code is dead; a device that had done its half and waits for the Mac's y is never pinned. The REAL relay, real auth,
// real HTTP, the repo's FakeBridge as the Mac (as enroll-session.test.ts does).
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
  signBridgeHttp,
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

let relay: RunningRelay
let bridgeKey: BridgeKeyPair
let dir: string
let base: string
let bridge: FakeBridge

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'talos-v11-'))
  bridgeKey = await generateBridgeKey()
  relay = await startRelay({
    env: loadEnv({
      NODE_ENV: 'development', // not 'test': this is the production auth module
      DATA_DIR: dir,
      PUBLIC_ORIGIN: ORIGIN,
      RP_ID: 'relay.example.com',
      DATA_KEY: TEST_DATA_KEY,
      BRIDGE_PUBKEY: bridgeKey.publicKeyB64,
      LOG_LEVEL: 'silent',
    }),
    host: '127.0.0.1',
    port: 0,
    transport: new NoopTransport(),
  })
  base = `http://127.0.0.1:${relay.port}`
  bridge = await new FakeBridge({ relayWs: `ws://127.0.0.1:${relay.port}`, key: bridgeKey }).connect()
})
afterEach(async () => {
  await bridge.close()
  await relay.stop()
  resetAuthImplementation()
  rmSync(dir, { recursive: true, force: true })
})

const core = () => authState(relay.services).core

let ipCounter = 0
const post = (path: string, body: unknown, cookie?: string) =>
  fetch(`${base}${path}`, {
    method: 'POST',
    headers: {
      origin: ORIGIN,
      'x-talos-csrf': '1',
      'content-type': 'application/json',
      'x-real-ip': `198.51.100.${(ipCounter++ % 250) + 1}`, // each call from its own address: the per-address rate limit is not under test
      ...(cookie ? { cookie } : {}),
    },
    body: JSON.stringify(body),
  })

const cookieOf = (res: Response): string => {
  const m = new RegExp(`${COOKIE_NAME}=([A-Za-z0-9_-]+)`).exec(res.headers.get('set-cookie') ?? '')
  if (!m) throw new Error('no session cookie')
  return `${COOKIE_NAME}=${m[1]}`
}

/** What `talos-app enroll` does: a signed POST /bridge/enroll registers a one-time code. */
async function showCode() {
  const code = newEnrollCode()
  const codeAuth = deriveEnrollAuth(code)
  const hash = enrollAuthHash(codeAuth)
  const raw = JSON.stringify({
    code_id: enrollCodeId(hash),
    code_auth_hash: hash,
    expires_at: new Date(Date.now() + 600_000).toISOString(),
    label: 'v11',
  })
  const authorization = await signBridgeHttp({
    privateKey: bridgeKey.privateKey,
    keyId: bridgeKey.keyId,
    method: 'POST',
    pathWithQuery: '/bridge/enroll',
    body: raw,
    ts: Math.floor(Date.now() / 1000),
  })
  const res = await fetch(`${base}/bridge/enroll`, { method: 'POST', headers: { authorization }, body: raw })
  if (res.status !== 200) throw new Error(`bridge/enroll ${res.status}`)
  return { code, codeAuth }
}

async function finishPhoneHalf(code: string, cookie: string) {
  const dev = await createExtractableDeviceKeyForTests()
  const res = await post(
    '/api/auth/device/verify',
    {
      device: { id: dev.deviceId, name: 'Phone', pubkey_jwk: dev.publicJwk },
      binding: bindingMac(deriveEnrollBind(code), dev.deviceId, dev.publicJwk),
      code_auth: deriveEnrollAuth(code),
    },
    cookie,
  )
  return { dev, res }
}

/** An owner who is paired and signed in (the only caller logout-all accepts). */
async function ownerSession(): Promise<string> {
  const c = await showCode()
  const cookie = cookieOf(await post('/api/auth/enroll/session', { code_auth: c.codeAuth }))
  const { dev, res } = await finishPhoneHalf(c.code, cookie)
  expect(res.status).toBe(202)
  bridge.send({ type: 'device.pinned', device_id: dev.deviceId, ok: true })
  await waitFor(() => core().device(dev.deviceId)?.pinned === true, 3000, 'owner device pinned')
  return cookie
}

const signOutEverywhere = (cookie: string) => post('/api/auth/logout-all', {}, cookie)

describe('sign out everywhere versus a pairing in progress', () => {
  it('a code that was shown but not used is dead afterwards: no session from it, no pairing with it', async () => {
    const owner = await ownerSession()
    const shown = await showCode()
    expect(core().findCode(shown.codeAuth)).not.toBeNull()

    expect((await signOutEverywhere(owner)).status).toBe(204)

    expect(core().findCode(shown.codeAuth)).toBeNull()
    const again = await post('/api/auth/enroll/session', { code_auth: shown.codeAuth })
    expect(again.status).toBe(410)
  })

  it('a phone that already holds a session from the code (code shown, pairing not finished) is refused at device/verify', async () => {
    const owner = await ownerSession()
    const shown = await showCode()
    const phone = cookieOf(await post('/api/auth/enroll/session', { code_auth: shown.codeAuth }))

    expect((await signOutEverywhere(owner)).status).toBe(204)

    const { dev, res } = await finishPhoneHalf(shown.code, phone)
    expect(res.status).toBeGreaterThanOrEqual(400)
    expect(core().device(dev.deviceId)).toBeNull()
    // and a fresh session from the same code is not available either
    expect((await post('/api/auth/enroll/session', { code_auth: shown.codeAuth })).status).toBe(410)
  })

  it('a phone that finished its half and waits for the Mac y is never pinned, and the Mac is told it is revoked', async () => {
    const owner = await ownerSession()
    const shown = await showCode()
    const phone = cookieOf(await post('/api/auth/enroll/session', { code_auth: shown.codeAuth }))
    const { dev, res } = await finishPhoneHalf(shown.code, phone)
    expect(res.status).toBe(202)
    expect(core().device(dev.deviceId)?.pinned).toBe(false)

    expect((await signOutEverywhere(owner)).status).toBe(204)

    // the owner's Mac had not answered; its later y must not bring the device in
    bridge.send({ type: 'device.pinned', device_id: dev.deviceId, ok: true })
    bridge.send({ type: 'ping', nonce: 'after-y' })
    await bridge.expectFrame('pong', (f) => f.nonce === 'after-y', { direction: 'in' })
    expect(core().device(dev.deviceId)).toMatchObject({ pinned: false, revoked: true })
    expect((await post('/api/auth/enroll/session', { code_auth: shown.codeAuth })).status).toBe(410)
    await bridge.expectFrame('device.revoked', (f) => f.device_id === dev.deviceId, { direction: 'in' })
  })

  it('a pairing whose device/verify is running at the moment of sign-out everywhere ends with nothing pinnable', async () => {
    for (let i = 0; i < 4; i++) {
      const owner = await ownerSession()
      const shown = await showCode()
      const phone = cookieOf(await post('/api/auth/enroll/session', { code_auth: shown.codeAuth }))
      const [verified] = await Promise.all([finishPhoneHalf(shown.code, phone), signOutEverywhere(owner)])
      // whichever came first, the end state is the same: the new device is not paired and cannot be
      const row = core().device(verified.dev.deviceId)
      expect(row === null || (row.revoked && !row.pinned)).toBe(true)
      expect(core().findCode(shown.codeAuth)).toBeNull()
      bridge.send({ type: 'device.pinned', device_id: verified.dev.deviceId, ok: true })
      bridge.send({ type: 'ping', nonce: `n${i}` })
      await bridge.expectFrame('pong', (f) => f.nonce === `n${i}`, { direction: 'in' })
      expect(core().device(verified.dev.deviceId)?.pinned ?? false).toBe(false)
    }
  })

  it('sign-out everywhere landing between the code being claimed and the device being written leaves no device', async () => {
    // device/verify claims the code, then awaits (it derives the device id); the sign-out lands in that window.
    const owner = await ownerSession()
    const shown = await showCode()
    const phone = cookieOf(await post('/api/auth/enroll/session', { code_auth: shown.codeAuth }))
    const c = core()
    const claim = c.claimCode.bind(c)
    c.claimCode = (codeId: string) => {
      const got = claim(codeId)
      if (got) {
        c.deleteAllSessions()
        c.cancelPairings()
      }
      return got
    }
    void owner
    const { dev, res } = await finishPhoneHalf(shown.code, phone)
    expect(res.status).toBe(410)
    expect(c.device(dev.deviceId)).toBeNull()
  })

  it('devices that were already paired stay paired: only sessions end and pending pairings are cancelled', async () => {
    const owner = await ownerSession()
    const pinned = core()
      .devices()
      .filter((d) => d.pinned)
    expect(pinned).toHaveLength(1)
    expect((await signOutEverywhere(owner)).status).toBe(204)
    expect(
      core()
        .devices()
        .filter((d) => d.pinned && !d.revoked),
    ).toHaveLength(1)
    expect((await fetch(`${base}/api/me`, { headers: { cookie: owner } })).status).toBe(401)
  })
})
