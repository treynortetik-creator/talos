// The ONLY place the `X-Test-Session` header exists. Production entry points never import this file; the relay
// refuses to boot if it is installed outside NODE_ENV=test, and WP8 checks that the production bundle answers
// `X-Test-Session` with 401 (spec 5.4).
//
// It is faithful where the contract suites depend on it: bridge hello and bridge HTTP signatures are REALLY verified
// (pass the key the relay trusts), `key_id` must match, nonces are single use, step-up tokens are single use and bound
// to a purpose, and the WS upgrade guard checks the session header and the Origin. So a relay wired to test-auth passes
// `defineRelayContract` exactly when its own logic is right.
import {
  BRIDGE_HTTP_SKEW_S,
  type BridgeKeyPair,
  b64urlDecode,
  bridgeKeyId,
  newUlid,
  parseBridgeAuthHeader,
  verifyBridgeHttp as verifyBridgeHttpSignature,
  verifyChallenge,
} from '@talos-app/protocol'
import { type AuthContract, type Session, setAuthImplementation } from '../../src/auth/contract.ts'

export const TEST_SESSION_HEADER = 'X-Test-Session'
export const TEST_BRIDGE_HEADER = 'X-Test-Bridge'
/** With `X-Test-Session: <device id>`: the Mac has not pinned that device yet (pairing only) until `pinTestDevice`. */
export const TEST_UNPINNED_HEADER = 'X-Test-Unpinned'

export type TestAuthOptions = {
  /** The bridge key the relay trusts. Without it any hello and any bridge request is accepted (unit tests only). */
  bridgeKey?: Pick<BridgeKeyPair, 'keyId' | 'publicKeyB64'>
  /** Origin the upgrade guard requires. Default: `services.env.PUBLIC_ORIGIN`. */
  origin?: string
}

const stepups = new Map<string, string>() // token -> purpose
const UNPINNED = '-unpinned'
const pinnedLater = new Set<string>()

/** The Mac pins a device that signed in unpinned (what the Mac's `device.pinned` does to the real session store). */
export function pinTestDevice(deviceId: string): void {
  pinnedLater.add(deviceId)
}

/** Mints a single-use step-up token for a purpose (what a passkey step-up would return). */
export function mintTestStepup(purpose: string): string {
  const token = `st_test_${newUlid()}`
  stepups.set(token, purpose)
  return token
}

/** Headers for a FakeApp: `X-Test-Session: <device id or "none">` plus the Origin the guard expects. */
export function testAppHeaders(
  origin: string,
  device = 'none',
  opts: { pinned?: boolean } = {},
): Record<string, string> {
  return {
    [TEST_SESSION_HEADER]: device,
    Origin: origin,
    ...(opts.pinned === false ? { [TEST_UNPINNED_HEADER]: '1' } : {}),
  }
}

function sessionOf(v: string, unpinned: string | undefined): Session {
  return { sessionId: `test-${v}${unpinned === undefined ? '' : UNPINNED}`, deviceId: v === 'none' ? null : v }
}

export function createTestAuth(opts: TestAuthOptions = {}): AuthContract {
  const sessions = new WeakMap<object, Session>()
  const nonces = new Set<string>()
  return {
    requireSession: async (c, next) => {
      const v = c.req.header(TEST_SESSION_HEADER)
      if (!v) return c.json({ error: 'unauthorized' }, 401)
      sessions.set(c.req.raw, sessionOf(c.req.header(TEST_SESSION_HEADER) ?? '', c.req.header(TEST_UNPINNED_HEADER)))
      await next()
    },
    requireCsrf: async (_c, next) => next(),
    requireStepup: (purpose) => async (c, next) => {
      const p = typeof purpose === 'function' ? purpose(c) : purpose
      const token = c.req.header('X-Test-Stepup') ?? ''
      if (stepups.get(token) !== p) return c.json({ error: 'stepup_invalid' }, 403)
      stepups.delete(token)
      await next()
    },
    consumeStepupToken: async ({ token, purpose }) => {
      if (stepups.get(token) !== purpose) return false
      stepups.delete(token)
      return true
    },
    guardWsUpgrade: async (c) => {
      const origin = opts.origin ?? c.get('services').env.PUBLIC_ORIGIN
      const v = c.req.header(TEST_SESSION_HEADER)
      if (!v) return c.json({ error: 'unauthorized' }, 401)
      const o = c.req.header('Origin')
      if (o !== origin) return c.json({ error: 'bad origin' }, 403)
      const session = sessionOf(v, c.req.header(TEST_UNPINNED_HEADER))
      sessions.set(c.req.raw, session)
      return session
    },
    verifyBridgeHello: async ({ hello, challenge }) => {
      const key = opts.bridgeKey
      if (!key) return { ok: true, keyId: hello.key_id }
      if (hello.key_id !== bridgeKeyId(b64urlDecode(key.publicKeyB64))) return { ok: false, reason: 'unknown key_id' }
      return (await verifyChallenge(key.publicKeyB64, challenge, hello.sig))
        ? { ok: true, keyId: hello.key_id }
        : { ok: false, reason: 'bad signature' }
    },
    verifyBridgeHttp: async (c, body) => {
      const key = opts.bridgeKey
      if (!key) {
        const k = c.req.header(TEST_BRIDGE_HEADER)
        return k ? { ok: true, keyId: k } : { ok: false, reason: `missing ${TEST_BRIDGE_HEADER}` }
      }
      const url = new URL(c.req.url)
      const res = await verifyBridgeHttpSignature({
        header: c.req.header('authorization') ?? '',
        method: c.req.method,
        pathWithQuery: url.pathname + url.search,
        body,
        nowS: Math.floor(Date.now() / 1000),
        keys: [{ keyId: key.keyId, publicKeyB64: key.publicKeyB64 }],
      })
      if (!res.ok) return { ok: false, reason: res.reason }
      if (nonces.has(res.nonce)) return { ok: false, reason: 'nonce replayed' }
      nonces.add(res.nonce)
      return { ok: true, keyId: res.keyId }
    },
    preflightBridgeHttp: (c) => {
      const key = opts.bridgeKey
      if (!key) return { ok: true, keyId: c.req.header(TEST_BRIDGE_HEADER) ?? '' }
      const p = parseBridgeAuthHeader(c.req.header('authorization') ?? '')
      if (!p) return { ok: false, reason: 'malformed' }
      if (p.keyId !== key.keyId) return { ok: false, reason: 'unknown_key' }
      if (Math.abs(Math.floor(Date.now() / 1000) - p.ts) > BRIDGE_HTTP_SKEW_S) return { ok: false, reason: 'skew' }
      return { ok: true, keyId: p.keyId }
    },
    sessionPinned: (session) =>
      !session?.sessionId.endsWith(UNPINNED) || (session.deviceId !== null && pinnedLater.has(session.deviceId)),
    rateLimit: () => async (_c, next) => next(),
    getSession: (c) => sessions.get(c.req.raw) ?? null,
  }
}

export function installTestAuth(opts: TestAuthOptions = {}): void {
  setAuthImplementation(createTestAuth(opts), { test: true })
}
