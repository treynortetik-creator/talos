// The auth surface the rest of the relay codes against. Seam: frozen after WP0 (WP8 may edit).
//
// Modules import the functions below. WP2 implements them in src/auth/** and installs the implementation with
// `setAuthImplementation` at startup. Until then every guard denies (401), so nothing is accidentally open. Tests
// install `test/helpers/test-auth.ts` instead; production entry points never import that file.
import type { Context, MiddlewareHandler } from 'hono'
import type { AppEnv } from '../services.ts'

export type Session = { sessionId: string; deviceId: string | null }

export type StepupPurpose =
  | `card:${string}`
  | 'config:work'
  | 'config:session'
  | 'device:revoke'
  | 'session:control'
  | 'permission:allow'

export type BridgeAuthResult = { ok: true; keyId: string } | { ok: false; reason: string }

export interface AuthContract {
  /** Valid session cookie. Sets `c.var.session`-equivalent via `getSession`. 401 otherwise. */
  requireSession: MiddlewareHandler<AppEnv>
  /** Origin === PUBLIC_ORIGIN, X-Talos-CSRF: 1, JSON (or the media content type) on non-GET /api/*. */
  requireCsrf: MiddlewareHandler<AppEnv>
  /** A fresh single-use step-up token for this purpose, bound to the session. */
  requireStepup(purpose: StepupPurpose | ((c: Context<AppEnv>) => StepupPurpose)): MiddlewareHandler<AppEnv>
  /**
   * Verifies the bridge's `hello` against the challenge it was sent (Ed25519, key from env or rotation table; `key_id`
   * must equal the first 16 hex of sha256(raw key)). `ip` feeds the "5 failed hellos in 10 min block the IP for 1 h" rule.
   */
  verifyBridgeHello(args: {
    hello: { key_id: string; sig: string }
    challenge: { nonce: string; relay_host: string; server_time: number }
    ip: string
  }): Promise<BridgeAuthResult>
  /**
   * When (epoch ms) the most recent bridge hello was refused, or null if the last hello was good (or none was refused).
   * A good hello clears it. Anyone can send a bad hello, so a reader shows it only while the bridge is offline.
   * Test implementations may omit it (never refused).
   */
  bridgeAuthRefusedAt?(): number | null
  /**
   * Checks and burns a step-up token carried INSIDE a WebSocket frame (`card.resolve`, `config.patch`), where HTTP
   * middleware cannot run. True only if the token is unexpired, unused, bound to this session and minted for exactly
   * `purpose`. Single use: a second call with the same token is false.
   */
  consumeStepupToken(args: { token: string; purpose: StepupPurpose; session: Session | null }): Promise<boolean>
  /**
   * Guard for the `/ws` upgrade, run before upgrading: a valid session cookie AND `Origin === PUBLIC_ORIGIN`. Returns the
   * session, or a ready 401 / 403 Response. No CSRF header (browsers cannot set one on an upgrade).
   */
  guardWsUpgrade(c: Context<AppEnv>): Promise<Session | Response>
  /** Verifies `Authorization: TalosBridge ...` on a request (skew, nonce cache, signature over the raw body). */
  verifyBridgeHttp(c: Context<AppEnv>, body: Uint8Array): Promise<BridgeAuthResult>
  /**
   * A cheap look at a signed bridge request BEFORE its body is read: the header parses, the key id is one the relay trusts
   * and the timestamp is inside the skew window. It does not (cannot) check the signature, which covers the body, and it
   * burns no nonce. Lets the relay turn away a stranger without buffering what they send. Test implementations may omit it
   * (everything passes and `verifyBridgeHttp` decides).
   */
  preflightBridgeHttp?(c: Context<AppEnv>): BridgeAuthResult
  /**
   * Verifies the signature of a bridge request against a body hash the caller CLAIMS (the Mac sends `x-talos-sha256`),
   * before the body is read, and burns the nonce on success. The signature covers sha256(body), so a pass proves the key
   * holder signed exactly that hash; the caller must then check the body it reads has that hash. Test implementations may
   * omit it (the caller falls back to reading the body first).
   */
  verifyBridgeHttpHash?(c: Context<AppEnv>, bodySha256: string): Promise<BridgeAuthResult>
  /** Token bucket by name (`auth`, `ws`, `bridge_ws`, `hook`, `media`, `voice`, ...); 429 when empty. */
  rateLimit(name: string): MiddlewareHandler<AppEnv>
  /**
   * Takes one token from a named bucket without being middleware, for callers that must look something up first (the
   * hook route charges its buckets only after the connection resolved). `key` defaults to the client IP; global buckets
   * ignore it. Test implementations may omit it (never limited).
   */
  takeRate?(c: Context<AppEnv>, name: string, key?: string): { ok: true } | { ok: false; retryAfterS: number }
  /** The session the guards attached, or null. */
  getSession(c: Context<AppEnv>): Session | null
  /**
   * True when the session belongs to a device the Mac pinned and the owner has not revoked. An unpinned session (a passkey
   * registered through a link the Mac then refused, or a browser jar without a device key) may only finish pairing: it gets
   * 403 `device_not_pinned` from `requireSession` and an empty `ready` on the socket. Test implementations may omit it
   * (everything counts as pinned).
   */
  sessionPinned?(session: Session | null): boolean
  /**
   * False once the session row is gone (logout, revoke, expiry). The hub re-checks live sockets with it, so a revoked
   * phone loses its feed instead of keeping a socket opened before the revoke. Test implementations may omit it.
   */
  sessionActive?(session: Session | null): boolean
  /** Why this session ended ('expired', 'revoked', 'logged_out', ...), or null when unknown. Sent with the 4401 close. */
  sessionEndReason?(session: Session | null): string | null
  /**
   * Records that the person used this device just now (a frame that shows real activity, a signed notification action).
   * Never called for keepalives or for the relay's own checks, and never implied by `sessionActive`: a socket left open
   * overnight must not look like a device in use. Test implementations may omit it.
   */
  noteDeviceUse?(deviceId: string | null): void
}

const deny: MiddlewareHandler<AppEnv> = async (c) => c.json({ error: 'unauthorized' }, 401)

const denyAll: AuthContract = {
  requireSession: deny,
  requireCsrf: deny,
  requireStepup: () => deny,
  verifyBridgeHello: async () => ({ ok: false, reason: 'auth not installed' }),
  consumeStepupToken: async () => false,
  guardWsUpgrade: async (c) => c.json({ error: 'unauthorized' }, 401),
  verifyBridgeHttp: async () => ({ ok: false, reason: 'auth not installed' }),
  rateLimit: () => async (_c, next) => next(),
  getSession: () => null,
}

let impl: AuthContract = denyAll
let testInstalled = false

/** WP2 calls this from `auth.register`. Tests call it through `test/helpers/test-auth.ts` with `{ test: true }`. */
export function setAuthImplementation(next: AuthContract, opts: { test?: boolean } = {}): void {
  impl = next
  testInstalled = Boolean(opts.test)
}

/** Back to deny-everything (test cleanup). */
export function resetAuthImplementation(): void {
  impl = denyAll
  testInstalled = false
}

/** True when a test implementation is installed. `registerModules` refuses to boot if so outside NODE_ENV=test. */
export function isTestAuthInstalled(): boolean {
  return testInstalled
}

export const requireSession: MiddlewareHandler<AppEnv> = (c, next) => impl.requireSession(c, next)
export const requireCsrf: MiddlewareHandler<AppEnv> = (c, next) => impl.requireCsrf(c, next)
/** @public The step-up guard modules import; part of the frozen auth seam. */
export const requireStepup: AuthContract['requireStepup'] = (purpose) => (c, next) =>
  impl.requireStepup(purpose)(c, next)
export const verifyBridgeHello: AuthContract['verifyBridgeHello'] = (a) => impl.verifyBridgeHello(a)
export const bridgeAuthRefusedAt = (): number | null => impl.bridgeAuthRefusedAt?.() ?? null
export const consumeStepupToken: AuthContract['consumeStepupToken'] = (a) => impl.consumeStepupToken(a)
export const guardWsUpgrade: AuthContract['guardWsUpgrade'] = (c) => impl.guardWsUpgrade(c)
export const verifyBridgeHttp: AuthContract['verifyBridgeHttp'] = (c, body) => impl.verifyBridgeHttp(c, body)
export const preflightBridgeHttp = (c: Context<AppEnv>): BridgeAuthResult =>
  impl.preflightBridgeHttp?.(c) ?? { ok: true, keyId: '' }
/** Null when this auth implementation cannot check a claimed hash (the caller reads the body first instead). */
export const verifyBridgeHttpHash = (c: Context<AppEnv>, bodySha256: string): Promise<BridgeAuthResult> | null =>
  impl.verifyBridgeHttpHash?.(c, bodySha256) ?? null
export const rateLimit: AuthContract['rateLimit'] = (name) => (c, next) => impl.rateLimit(name)(c, next)
export const takeRate = (
  c: Context<AppEnv>,
  name: string,
  key?: string,
): { ok: true } | { ok: false; retryAfterS: number } => impl.takeRate?.(c, name, key) ?? { ok: true }
export const getSession: AuthContract['getSession'] = (c) => impl.getSession(c)
export const sessionPinned = (session: Session | null): boolean => impl.sessionPinned?.(session) ?? true
export const sessionEndReason = (session: Session | null): string | null => impl.sessionEndReason?.(session) ?? null
export const sessionActive = (session: Session | null): boolean => impl.sessionActive?.(session) ?? true
export const noteDeviceUse = (deviceId: string | null): void => impl.noteDeviceUse?.(deviceId)
