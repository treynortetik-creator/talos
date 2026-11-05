// The AuthContract (src/auth/contract.ts) over the real auth state. Installed by `register`.
import {
  BRIDGE_HTTP_SKEW_S,
  b64urlDecode,
  bridgeKeyId,
  FORM_SENDABLE_TYPES,
  parseBridgeAuthHeader,
  trustOn,
  verifyBridgeHttp as verifyBridgeHttpSignature,
  verifyChallenge,
} from '@talos-app/protocol'
import type { Context, MiddlewareHandler } from 'hono'
import { hasBodyBytes } from '../core/body-guard.ts'
import type { AppEnv } from '../services.ts'
import type { AuthContract, BridgeAuthResult, Session } from './contract.ts'
import type { AuthState } from './state.ts'
import { COOKIE_NAME, clientIp, readCookie, relayHost, sessionCookie, sessionTtlMs } from './util.ts'

const sessions = new WeakMap<object, Session>()

const MEDIA_PATH = '/api/media'
const DICTATE_PATH = '/api/dictate'
const FORM_TYPES = FORM_SENDABLE_TYPES

/** Looks up the cookie session for this request (and caches it on the request). */
export function sessionFor(state: AuthState, c: Context<AppEnv>, opts: { stamp?: boolean } = {}): Session | null {
  const cached = sessions.get(c.req.raw)
  if (cached) return cached
  const token = readCookie(c.req.header('cookie'), COOKIE_NAME)
  const row = state.core.lookupSession(token)
  if (!row) return null
  // Slide the browser's copy too, or it drops the cookie 30 days after sign-in however active the owner is.
  if (row.slid && token) c.header('Set-Cookie', sessionCookie(token, sessionTtlMs(state.services.env) / 1000))
  const s: Session = { sessionId: row.id, deviceId: row.deviceId }
  // An authenticated request from a device's session counts as that device being in use (throttled in the core). A socket
  // upgrade does not (`stamp: false`): a tab left open reconnects by itself, and that is not a person.
  if (row.deviceId && opts.stamp !== false) state.core.noteDeviceUse(row.deviceId)
  sessions.set(c.req.raw, s)
  return s
}

const impls = new WeakMap<AuthState, ReturnType<typeof createAuthImplementation>>()

/** The same implementation `register` installs, for the auth routes' own middleware. */
export function implFor(state: AuthState): ReturnType<typeof createAuthImplementation> {
  let i = impls.get(state)
  if (!i) {
    i = createAuthImplementation(state)
    impls.set(state, i)
  }
  return i
}

export function createAuthImplementation(
  state: AuthState,
): AuthContract & { requireSessionAny: MiddlewareHandler<AppEnv> } {
  const { services, core } = state
  const origin = services.env.PUBLIC_ORIGIN

  const sessionPinned = (session: Session | null): boolean => {
    if (!session?.deviceId) return false
    const d = core.device(session.deviceId)
    return Boolean(d?.pinned && !d.revoked)
  }

  /** 401 for a missing or ended session. When the relay knows why it ended, the body says so (`reason`); old apps ignore it. */
  const unauthorized = (c: Context<AppEnv>) => {
    const reason = core.endedReasonForToken(readCookie(c.req.header('cookie'), COOKIE_NAME))
    return c.json({ error: 'unauthorized', ...(reason ? { reason } : {}) }, 401)
  }

  /** Any valid session, pinned or not: only the pairing routes use this one. */
  const requireSessionAny: MiddlewareHandler<AppEnv> = async (c, next) => {
    if (!sessionFor(state, c)) return unauthorized(c)
    await next()
  }

  /** A valid session whose device the Mac pinned. Everything that returns the owner's data goes through this. */
  const requireSession: MiddlewareHandler<AppEnv> = async (c, next) => {
    const s = sessionFor(state, c)
    if (!s) return unauthorized(c)
    if (!sessionPinned(s)) return c.json({ error: 'device_not_pinned' }, 403)
    await next()
  }

  const requireCsrf: MiddlewareHandler<AppEnv> = async (c, next) => {
    const method = c.req.method
    if (method === 'GET' || method === 'HEAD' || method === 'OPTIONS') return next()
    if (c.req.header('origin') !== origin) return c.json({ error: 'csrf_origin' }, 403)
    if (c.req.header('x-talos-csrf') !== '1') return c.json({ error: 'csrf_header' }, 403)
    const type = c.req.header('content-type')
    const path = new URL(c.req.url).pathname
    if (path === MEDIA_PATH || path === DICTATE_PATH) {
      // The media upload and dictation carry their own type; only the types an HTML form can send are refused.
      if (type && FORM_TYPES.test(type)) return c.json({ error: 'csrf_content_type' }, 403)
    } else if (type === undefined) {
      // No content type is fine only with no body at all.
      if (await hasBodyBytes(c.req.raw)) return c.json({ error: 'csrf_content_type' }, 403)
    } else if (!/^application\/json\s*(;|$)/i.test(type)) {
      return c.json({ error: 'csrf_content_type' }, 403)
    }
    await next()
  }

  async function stepupToken(c: Context<AppEnv>): Promise<string> {
    const header = c.req.header('x-talos-stepup')
    if (header) return header
    try {
      const body = (await c.req.json()) as unknown
      if (body && typeof body === 'object' && typeof (body as { stepup_token?: unknown }).stepup_token === 'string')
        return (body as { stepup_token: string }).stepup_token
    } catch {
      /* no JSON body */
    }
    return ''
  }

  const requireStepup: AuthContract['requireStepup'] = (purpose) => async (c, next) => {
    const session = sessionFor(state, c)
    if (!session) return c.json({ error: 'unauthorized' }, 401)
    const p = typeof purpose === 'function' ? purpose(c) : purpose
    // Trust mode (set on the Mac): revoking a device needs the session, not a fresh passkey tap. Nothing else is relaxed here.
    if (p === 'device:revoke' && trustOn(services.agentConfig())) return next()
    const token = await stepupToken(c)
    if (!core.consumeStepup(token, p, session.sessionId)) return c.json({ error: 'stepup_invalid' }, 403)
    await next()
  }

  // When the last hello was refused; a good hello clears it. In memory: a restart forgets it and the next refused hello sets it again.
  let helloRefusedAt: number | null = null
  const verifyBridgeHello: AuthContract['verifyBridgeHello'] = async ({ hello, challenge, ip }) => {
    // A blocked address is not a blocked KEY. Five bad hellos from one address block strangers there, but a hello that
    // proves it holds a trusted key still gets in: on a shared edge address (or behind one NAT) a stranger must not be able
    // to lock the owner's Mac out. A blocked address that fails is refused as `ip_blocked` and adds no further failure.
    const blocked = state.helloGuard.isBlocked(ip)
    const fail = (reason: string): BridgeAuthResult => {
      helloRefusedAt = services.clock.now()
      if (blocked) return { ok: false, reason: 'ip_blocked' }
      state.helloGuard.fail(ip)
      return { ok: false, reason }
    }
    const host = relayHost(origin)
    if (challenge.relay_host !== host && challenge.relay_host !== new URL(origin).hostname)
      return fail('wrong relay host')
    const key = core.trustedKeys().find((k) => k.keyId === hello.key_id)
    if (!key) return fail('unknown key_id')
    if (bridgeKeyId(b64urlDecode(key.publicKeyB64)) !== hello.key_id) return fail('unknown key_id')
    if (!(await verifyChallenge(key.publicKeyB64, challenge, hello.sig))) return fail('bad signature')
    // A challenge nonce signs in exactly once, so a recorded hello cannot be replayed on another socket.
    if (!core.useNonce(`hello:${challenge.nonce}`)) return fail('nonce replayed')
    helloRefusedAt = null
    return { ok: true, keyId: key.keyId }
  }

  const verifyBridgeHttp: AuthContract['verifyBridgeHttp'] = async (c, body) => {
    const url = new URL(c.req.url)
    const res = await verifyBridgeHttpSignature({
      header: c.req.header('authorization') ?? '',
      method: c.req.method,
      pathWithQuery: url.pathname + url.search,
      body,
      nowS: Math.floor(services.clock.now() / 1000),
      keys: core.trustedKeys(),
    })
    if (!res.ok) return { ok: false, reason: res.reason }
    // Burn the nonce only after the signature checked out, so garbage cannot fill the cache.
    if (!core.useNonce(`http:${res.keyId}:${res.nonce}`)) return { ok: false, reason: 'nonce_replayed' }
    return { ok: true, keyId: res.keyId }
  }

  const verifyBridgeHttpHash: NonNullable<AuthContract['verifyBridgeHttpHash']> = async (c, bodySha256) => {
    const url = new URL(c.req.url)
    const res = await verifyBridgeHttpSignature({
      header: c.req.header('authorization') ?? '',
      method: c.req.method,
      pathWithQuery: url.pathname + url.search,
      bodySha256,
      nowS: Math.floor(services.clock.now() / 1000),
      keys: core.trustedKeys(),
    })
    if (!res.ok) return { ok: false, reason: res.reason }
    // Burnt now, before the body is read: a recorded header cannot be replayed to hold a read open.
    if (!core.useNonce(`http:${res.keyId}:${res.nonce}`)) return { ok: false, reason: 'nonce_replayed' }
    return { ok: true, keyId: res.keyId }
  }

  const preflightBridgeHttp: NonNullable<AuthContract['preflightBridgeHttp']> = (c) => {
    const p = parseBridgeAuthHeader(c.req.header('authorization') ?? '')
    if (!p) return { ok: false, reason: 'malformed' }
    if (!core.trustedKeys().some((k) => k.keyId === p.keyId)) return { ok: false, reason: 'unknown_key' }
    if (Math.abs(Math.floor(services.clock.now() / 1000) - p.ts) > BRIDGE_HTTP_SKEW_S)
      return { ok: false, reason: 'skew' }
    return { ok: true, keyId: p.keyId }
  }

  return {
    requireSession,
    requireSessionAny,
    sessionPinned,
    // Only a check: the hub asks it on its own timer and for every frame, so it must never mark a device as used.
    sessionActive: (session) => Boolean(session && core.sessionExists(session.sessionId)),
    sessionEndReason: (session) => (session ? core.endedReason(session.sessionId) : null),
    noteDeviceUse: (deviceId) => {
      if (deviceId) core.noteDeviceUse(deviceId)
    },
    requireCsrf,
    requireStepup,
    verifyBridgeHello,
    bridgeAuthRefusedAt: () => helloRefusedAt,
    consumeStepupToken: async ({ token, purpose, session }) =>
      core.consumeStepup(token, purpose, session?.sessionId ?? null),
    guardWsUpgrade: async (c) => {
      if (c.req.header('origin') !== origin) return c.json({ error: 'bad_origin' }, 403)
      const session = sessionFor(state, c, { stamp: false })
      if (!session) return unauthorized(c)
      return session
    },
    verifyBridgeHttp,
    verifyBridgeHttpHash,
    preflightBridgeHttp,
    rateLimit: (name) => async (c, next) => {
      const r = state.limiter.take(name, clientIp(c))
      if (!r.ok) {
        c.header('Retry-After', String(r.retryAfterS))
        return c.json({ error: 'rate_limited' }, 429)
      }
      await next()
    },
    takeRate: (c, name, key) => state.limiter.take(name, key ?? clientIp(c)),
    getSession: (c) => sessions.get(c.req.raw) ?? null,
  }
}
