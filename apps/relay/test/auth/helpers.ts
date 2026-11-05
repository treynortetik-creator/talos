// Shared harness for the auth tests: real auth module over the fake services, driven through Hono's `request()`.
import {
  type BridgeKeyPair,
  b64urlEncode,
  createExtractableDeviceKeyForTests,
  deriveEnrollAuth,
  enrollAuthHash,
  enrollCodeId,
  generateBridgeKey,
  newEnrollCode,
  signBridgeHttp,
} from '@talos-app/protocol'
import { Hono } from 'hono'
import { expect } from 'vitest'
import { guardWsUpgrade, requireSession, resetAuthImplementation } from '../../src/auth/contract.ts'
import { routes as authRoutes, register } from '../../src/auth/index.ts'
import { authState } from '../../src/auth/state.ts'
import { COOKIE_NAME } from '../../src/auth/util.ts'
import type { AppEnv } from '../../src/services.ts'
import { createFakeServices, type FakeServices } from '../helpers/fake-services.ts'
import type { softAuthenticator } from './soft-passkey.ts'

export const ORIGIN = 'https://relay.example.com'

export type Harness = Awaited<ReturnType<typeof makeHarness>>

export async function makeHarness(
  opts: { env?: Record<string, string>; withBridgeKey?: boolean; origin?: string } = {},
) {
  const bridgeKey: BridgeKeyPair = await generateBridgeKey()
  const fake: FakeServices = createFakeServices({
    env: {
      ...(opts.origin ? { PUBLIC_ORIGIN: opts.origin, RP_ID: new URL(opts.origin).hostname } : {}),
      ...(opts.withBridgeKey === false ? {} : { BRIDGE_PUBKEY: bridgeKey.publicKeyB64 }),
      ...opts.env,
    },
  })
  register(fake.services)
  const state = authState(fake.services)
  const app = new Hono<AppEnv>()
  app.use('*', async (c, next) => {
    c.set('services', fake.services)
    await next()
  })
  app.route('/', authRoutes)
  // Probes for the contract guards other modules use.
  app.get('/probe/session', requireSession, (c) => c.json({ ok: true }))
  app.get('/probe/ws', async (c) => {
    const r = await guardWsUpgrade(c)
    return r instanceof Response ? r : c.json({ ok: true, session: r.sessionId })
  })

  /** A signed-in session for the one fake passkey. Returns the Cookie header. */
  function login(credentialId = 'cred-1', deviceId: string | null = null): string {
    if (!state.core.credential(credentialId)) {
      state.core.addCredential({
        credentialId,
        publicKey: new Uint8Array([1, 2, 3]),
        counter: 0,
        deviceName: 'Test passkey',
      })
    }
    return `${COOKIE_NAME}=${state.core.createSession(credentialId, deviceId)}`
  }

  /**
   * A signed-in session bound to a freshly pinned device (the normal state of the owner's phone). `login()` stays the
   * unpinned case: a passkey session with no pinned device, which may only finish pairing.
   */
  async function loginPinned(credentialId = 'cred-1'): Promise<string> {
    const d = await newDevice()
    login(credentialId)
    state.core.upsertDevice({
      id: d.id as never,
      name: 'Pinned phone',
      pubkeyJwk: d.jwk,
      credentialId,
      binding: 'b',
      codeId: `c-${d.id}`,
    })
    state.core.setPinned(d.id, true)
    return login(credentialId, d.id)
  }

  const jsonHeaders = (cookie?: string, extra: Record<string, string> = {}): Record<string, string> => ({
    Origin: ORIGIN,
    'X-Talos-CSRF': '1',
    'Content-Type': 'application/json',
    'X-Forwarded-For': '203.0.113.7',
    ...(cookie ? { Cookie: cookie } : {}),
    ...extra,
  })

  async function post(path: string, body: unknown, cookie?: string, extra: Record<string, string> = {}) {
    return app.request(path, { method: 'POST', headers: jsonHeaders(cookie, extra), body: JSON.stringify(body) })
  }

  async function bridgePost(
    path: string,
    body: unknown,
    over: { key?: BridgeKeyPair; ts?: number; nonce?: string; method?: string } = {},
  ) {
    const raw = body === undefined ? '' : JSON.stringify(body)
    const key = over.key ?? bridgeKey
    const authorization = await signBridgeHttp({
      privateKey: key.privateKey,
      keyId: key.keyId,
      method: over.method ?? 'POST',
      pathWithQuery: path,
      body: raw,
      ts: over.ts ?? Math.floor(fake.clock.now() / 1000),
      ...(over.nonce ? { nonce: over.nonce } : {}),
    })
    return app.request(path, {
      method: over.method ?? 'POST',
      headers: { Authorization: authorization, 'X-Forwarded-For': '203.0.113.9' },
      body: raw || undefined,
    })
  }

  return { fake, state, app, bridgeKey, login, loginPinned, post, bridgePost, jsonHeaders }
}

/** Registers a passkey through a fresh one-time code, as `talos-app enroll` and the enroll screen do. `cookie` is a live session the request carries. */
export async function registerPasskey(h: Harness, passkey: ReturnType<typeof softAuthenticator>, cookie?: string) {
  const codeAuth = deriveEnrollAuth(newEnrollCode())
  const hash = enrollAuthHash(codeAuth)
  const r = await h.bridgePost('/bridge/enroll', {
    code_id: enrollCodeId(hash),
    code_auth_hash: hash,
    expires_at: new Date(h.fake.clock.now() + 600_000).toISOString(),
  })
  expect(r.status).toBe(200)
  const xff = { 'X-Forwarded-For': '203.0.113.7' }
  const opts = await h.post('/api/auth/enroll/options', { code_auth: codeAuth }, undefined, xff)
  const { challenge } = (await opts.json()) as { challenge: string }
  const res = await h.post(
    '/api/auth/enroll/verify',
    { code_auth: codeAuth, response: passkey.register(challenge) },
    cookie,
    xff,
  )
  expect(res.status).toBe(200)
}

export async function newDevice() {
  const k = await createExtractableDeviceKeyForTests()
  return { id: k.deviceId, jwk: k.publicJwk, key: k }
}

export const randomB64 = (n = 16) => b64urlEncode(crypto.getRandomValues(new Uint8Array(n)))

export function afterEachReset(): void {
  resetAuthImplementation()
}
