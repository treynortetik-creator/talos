// WP2: relay auth and security. Passkeys, sessions, CSRF, step-up, the device registry, bridge enrollment and key
// rotation, rate limits. `register` installs the AuthContract implementation the other modules code against.
import { Buffer } from 'node:buffer'
import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
} from '@simplewebauthn/server'
import {
  b64urlDecode,
  DEVICE_PROOF_NONCE_RE,
  DEVICE_PROOF_TTL_MS,
  DeviceId,
  type DeviceT,
  deviceIdFromJwk,
  type FrameType,
  loginProofCodeId,
  newUlid,
  routes as R,
  SESSION_PROOF_CODE_ID,
  verifyDeviceProof,
  verifyRotation,
} from '@talos-app/protocol'
import { type Context, Hono } from 'hono'
import { z } from 'zod'
import { bodyTimeout, limitBody, smallBodyGuard } from '../core/body-guard.ts'
import { findRuntime } from '../core/runtime.ts'
import { dictateStatus } from '../dictate/status.ts'
import type { AppEnv, RelayServices } from '../services.ts'
import { VERSION } from '../version.ts'
import { voiceStatus } from '../voice/status.ts'
import { isTestAuthInstalled, setAuthImplementation } from './contract.ts'
import { enrollSessionRoutes } from './enroll-session.ts'
import { implFor, sessionFor } from './impl.ts'
import { authState } from './state.ts'
import { clearedCookie, ENROLL_CODE_MAX_TTL_MS, newToken, sessionCookie, sessionTtlMs } from './util.ts'

export const routes = new Hono<AppEnv>()
// Every sign-in route reads a small JSON body, often before it knows who is asking: cap it and put a clock on it. This
// is registered BEFORE the routes below, because Hono runs middleware in registration order.
routes.use('/api/auth/*', smallBodyGuard())
routes.route('/', enrollSessionRoutes) // WP-N0

/** The optional proof in a sign-in body: the login challenge and the device's signature over it. Anything else counts as no proof. */
const DeviceLoginProof = z.object({ nonce: z.string().regex(DEVICE_PROOF_NONCE_RE), sig: z.string().length(86) })

const state = (c: Context<AppEnv>) => authState(c.get('services'))
const auth = (c: Context<AppEnv>) => implFor(state(c))
const iso = (ms: number | null) => (ms === null ? null : new Date(ms).toISOString())

// Middleware that picks the implementation per request (the sub-app is built before any services exist).
const rate = (name: string) => (c: Context<AppEnv>, next: () => Promise<void>) => auth(c).rateLimit(name)(c, next)
const csrf = (c: Context<AppEnv>, next: () => Promise<void>) => auth(c).requireCsrf(c, next)
const session = (c: Context<AppEnv>, next: () => Promise<void>) => auth(c).requireSession(c, next)
// Pairing routes accept a session whose device is not pinned yet (the passkey exists, the Mac has not said y).
const sessionAny = (c: Context<AppEnv>, next: () => Promise<void>) => auth(c).requireSessionAny(c, next)
const stepup =
  (purpose: Parameters<ReturnType<typeof implFor>['requireStepup']>[0]) =>
  (c: Context<AppEnv>, next: () => Promise<void>) =>
    auth(c).requireStepup(purpose)(c, next)

async function body<S extends z.ZodType>(c: Context<AppEnv>, schema: S): Promise<z.infer<S> | null> {
  let raw: unknown
  try {
    raw = await c.req.json()
  } catch {
    return null
  }
  const r = schema.safeParse(raw)
  return r.success ? r.data : null
}

function setSession(c: Context<AppEnv>, token: string): void {
  c.header('Set-Cookie', sessionCookie(token, sessionTtlMs(state(c).services.env) / 1000))
}

function frame(type: FrameType, fields: Record<string, unknown>, now: number): Record<string, unknown> {
  return { v: 1, type, id: newUlid(), ts: new Date(now).toISOString(), ...fields }
}

// ---- passkey registration (enroll-code gated) -----------------------------------------------------------------

routes.post('/api/auth/enroll/options', rate('auth'), csrf, async (c) => {
  const { core, services } = state(c)
  const b = await body(c, R.enrollOptions.req)
  if (!b) return c.json({ error: 'bad_request' }, 400)
  const code = core.checkCode(b.code_auth)
  if (!code || code.registeredCredentialId) return c.json({ error: 'code_invalid' }, 410)
  core.purge()
  const options = await generateRegistrationOptions({
    rpName: services.env.RP_NAME,
    rpID: services.env.RP_ID,
    userName: 'owner',
    userID: core.userHandle(),
    attestationType: 'none',
    authenticatorSelection: { residentKey: 'required', userVerification: 'required' },
    supportedAlgorithmIDs: [-7, -8, -257],
    excludeCredentials: core
      .credentials()
      .map((k) => ({ id: k.credentialId, ...(k.transports ? { transports: k.transports } : {}) })),
  })
  core.putChallenge('reg', options.challenge)
  return c.json(options)
})

routes.post('/api/auth/enroll/verify', rate('auth'), csrf, async (c) => {
  const { core, services } = state(c)
  const b = await body(c, R.enrollVerify.req)
  if (!b) return c.json({ error: 'bad_request' }, 400)
  const code = core.checkCode(b.code_auth)
  if (!code || code.registeredCredentialId) return c.json({ error: 'code_invalid' }, 410)
  let verified: Awaited<ReturnType<typeof verifyRegistrationResponse>>
  try {
    verified = await verifyRegistrationResponse({
      response: b.response as never,
      expectedChallenge: (ch) => core.consumeChallenge('reg', ch),
      expectedOrigin: services.env.PUBLIC_ORIGIN,
      expectedRPID: services.env.RP_ID,
      requireUserVerification: true,
    })
  } catch {
    return c.json({ error: 'registration_failed' }, 400)
  }
  if (!verified.verified) return c.json({ error: 'registration_failed' }, 400)
  const cred = verified.registrationInfo.credential
  if (core.credential(cred.id)) return c.json({ error: 'credential_exists' }, 409)
  if (!core.claimCodeForRegistration(code.codeId, cred.id)) return c.json({ error: 'code_invalid' }, 410)
  core.addCredential({
    credentialId: cred.id,
    publicKey: cred.publicKey,
    counter: cred.counter,
    ...(cred.transports ? { transports: cred.transports } : {}),
    deviceName: b.device_name ?? 'Passkey',
  })
  const old = sessionFor(state(c), c)
  if (old) core.deleteSession(old.sessionId, 'signed_in_again')
  setSession(c, core.createSession(cred.id, null))
  return c.json({ ok: true })
})

// ---- sign-in ----------------------------------------------------------------------------------------------------

routes.post('/api/auth/login/options', rate('auth'), csrf, async (c) => {
  const { core, services } = state(c)
  core.purge()
  const options = await generateAuthenticationOptions({ rpID: services.env.RP_ID, userVerification: 'required' })
  core.putChallenge('login', options.challenge)
  return c.json(options)
})

routes.post('/api/auth/login/verify', rate('auth'), csrf, async (c) => {
  const { core, services } = state(c)
  const b = await body(c, R.loginVerify.req)
  if (!b) return c.json({ error: 'bad_request' }, 400)
  const response = b.response as { id?: unknown }
  const cred = typeof response.id === 'string' ? core.credential(response.id) : null
  if (!cred) return c.json({ error: 'unauthorized' }, 401)
  let verified: Awaited<ReturnType<typeof verifyAuthenticationResponse>>
  let signedChallenge = ''
  try {
    verified = await verifyAuthenticationResponse({
      response: b.response as never,
      expectedChallenge: (ch) => {
        const ok = core.consumeChallenge('login', ch)
        if (ok) signedChallenge = ch
        return ok
      },
      expectedOrigin: services.env.PUBLIC_ORIGIN,
      expectedRPID: services.env.RP_ID,
      credential: {
        id: cred.credentialId,
        publicKey: cred.publicKey as never,
        counter: cred.counter,
        ...(cred.transports ? { transports: cred.transports } : {}),
      },
      requireUserVerification: true,
    })
  } catch {
    return c.json({ error: 'unauthorized' }, 401)
  }
  if (!verified.verified) return c.json({ error: 'unauthorized' }, 401)
  core.touchCredential(cred.credentialId, verified.authenticationInfo.newCounter)
  // The app may say which device key lives in this storage jar (read from the raw body; not in the protocol schema).
  // A client-named device_id only attaches when that device was enrolled with THIS passkey: knowing the owner's
  // (not secret) device id is not enough for another passkey to ride its pin.
  const claimed = (await c.req.json().catch(() => ({}))) as { device_id?: unknown; device_proof?: unknown }
  const deviceId = DeviceId.safeParse(claimed.device_id)
  const device = deviceId.success ? core.device(deviceId.data) : null
  const eligible = device && !device.revoked && device.credentialId === cred.credentialId ? device : null
  // The session that came with this request, read before anything below can end it: a device's first proof ends the
  // device's other sessions as 'replaced', and this one is not among them (it ends as 'signed_in_again' further down).
  const old = sessionFor(state(c), c)
  let attach: string | null = null
  let unproven = false
  let endedUnproven = false
  if (eligible) {
    // Item 3: the same passkey is not enough to be a device. Another device (or a thief on a synced keychain) can name this
    // device id, so the device must also sign the login challenge the passkey just signed (single use, made by the relay).
    // Same proof as enrollment, with the passkey's label in the code_id slot (packages/protocol/src/device-proof.ts).
    const proof = DeviceLoginProof.safeParse(claimed.device_proof)
    if (proof.success) {
      const good =
        proof.data.nonce === signedChallenge &&
        (await verifyDeviceProof(eligible.pubkeyJwk, {
          nonce: proof.data.nonce,
          codeId: loginProofCodeId(cred.credentialId),
          deviceId: eligible.id,
          sig: proof.data.sig,
        }))
      if (!good) return c.json({ error: 'device_proof_invalid' }, 401)
      attach = eligible.id
      // The device's first proof also ends every session attached to it without one (a thief's, from the compat path).
      endedUnproven = core.markLoginProven(eligible.id, old?.sessionId) > 0
    } else if (eligible.loginProvenAt !== null || services.env.DEVICE_PROOF_REQUIRED === '1') {
      // This device has signed a proof before (or the owner switched enforcement on): leaving it out is not an old client.
      return c.json({ error: 'device_proof_required' }, 403)
    } else {
      // A device that never proved (a web build from before this change): let it in as before, and tell the owner.
      attach = eligible.id
      unproven = true
    }
  }
  // Rotate: the session that came with this request (if any) dies, a fresh one is issued. Only after every check above, so
  // a refused sign-in does not sign the caller's current session out.
  if (old) core.deleteSession(old.sessionId, 'signed_in_again')
  if (attach) core.touchDevice(attach)
  core.purge()
  setSession(c, core.createSession(cred.credentialId, attach))
  if (endedUnproven) services.bus.revalidateApps() // live sockets of the sessions just ended close now
  // Tell the owner about every sign-in. A push that fails is logged and never blocks the sign-in.
  void Promise.resolve()
    .then(() => services.push.notify({ template: unproven ? 'sign_in_unproven' : 'sign_in' }))
    .catch((e) => services.log.warn({ err: String(e) }, 'sign-in alert not sent'))
  return c.json({ ok: true })
})

// ---- half 2: the device key -----------------------------------------------------------------------------------

routes.post('/api/auth/device/verify', rate('auth'), csrf, sessionAny, async (c) => {
  const { core, services } = state(c)
  const sess = sessionFor(state(c), c)
  const b = await body(c, R.deviceVerify.req)
  if (!sess || !b) return c.json({ error: 'bad_request' }, 400)
  const code = core.checkCode(b.code_auth)
  if (!code) return c.json({ error: 'code_invalid' }, 410)
  // WP-N0: a session minted from a setup code may only pin with that same code. Any other live code is a failed attempt.
  const mintedBy = core.sessionEnrollCodeId(sess.sessionId)
  if (mintedBy !== null && mintedBy !== code.codeId) {
    core.recordEnrollFailure()
    return c.json({ error: 'code_invalid' }, 410)
  }
  // Take the code NOW, before the first await: two parallel calls on one code cannot both enroll (review F2). Every early
  // return below gives it back, so a retry (for instance with the proof of possession) still works.
  if (!core.claimCode(code.codeId)) return c.json({ error: 'code_invalid' }, 410)
  let enrolled = false
  try {
    let expectedId: string
    try {
      expectedId = await deviceIdFromJwk(b.device.pubkey_jwk)
    } catch {
      return c.json({ error: 'bad_device_key' }, 400)
    }
    if (expectedId !== b.device.id) return c.json({ error: 'bad_device_key' }, 400)
    const existing = core.device(b.device.id)
    if (existing?.revoked) return c.json({ error: 'device_revoked' }, 409)
    const credentialId = core.db
      .prepare('select credential_id from auth_sessions where id = ?')
      .pluck()
      .get(sess.sessionId) as string | null
    if (code.registeredCredentialId && code.registeredCredentialId !== credentialId)
      return c.json({ error: 'code_invalid' }, 410)
    // A device id already pinned under another credential is not ours to re-enroll.
    if (existing?.pinned && existing.credentialId !== credentialId) return c.json({ error: 'device_exists' }, 409)
    // WP-N0 review F1: an already-pinned device is re-enrolled ("signing in again needs a new code but no re-pair", spec 5.2
    // step 5) only by whoever holds its PRIVATE key. The id and public JWK are not secret, and a setup-code session carries no
    // passkey to bind the device, so the device signs a fresh nonce that is bound to this session, this code and this device.
    // Any EXISTING device, pinned or not (re-check R1): an unpinned one may be waiting on the owner's y, and a second code must
    // not be able to ride that pending pin.
    if (existing) {
      const proof = b.proof
      const proven =
        proof !== undefined &&
        core.consumeChallenge('device', proof.nonce, sess.sessionId, existing.id) &&
        (await verifyDeviceProof(existing.pubkeyJwk, {
          nonce: proof.nonce,
          codeId: code.codeId,
          deviceId: existing.id,
          sig: proof.sig,
        }))
      if (!proven) {
        if (proof !== undefined) core.recordEnrollFailure(code.codeId) // a wrong signature is a guess, not a first ask
        const challenge = newToken(32)
        core.putChallenge('device', challenge, sess.sessionId, existing.id, DEVICE_PROOF_TTL_MS)
        return c.json({ error: 'device_proof_required', challenge }, 409)
      }
    }
    core.upsertDevice({
      id: b.device.id,
      name: b.device.name,
      pubkeyJwk: b.device.pubkey_jwk,
      credentialId: credentialId ?? null,
      binding: b.binding,
      codeId: code.codeId,
    })
    core.attachDevice(sess.sessionId, b.device.id)
    core.touchDevice(b.device.id) // enrolling is the device's first use
    // The key that enrolled here (a new one, or an existing one that just proved itself above) counts as proven for sign-in,
    // so a device enrolled after this change cannot be imitated by a sign-in that leaves the proof out. A device with no
    // passkey (a setup-code shell) never signs in with one, so this only matters to browsers.
    if (core.markLoginProven(b.device.id, sess.sessionId) > 0) services.bus.revalidateApps()
    enrolled = true
    const now = services.clock.now()
    await services.bus.toBridge(
      frame(
        'device.enrolled',
        {
          device: { id: b.device.id, name: b.device.name, pubkey_jwk: b.device.pubkey_jwk },
          binding: b.binding,
          code_id: code.codeId,
          // A setup-code session (WP-N0) has no passkey; the frame schema wants a non-empty id, and the bridge never reads it.
          credential_id: credentialId ?? 'setup-code',
        },
        now,
      ),
      { durable: true, ttl_s: 24 * 3600 },
    )
    return c.json({ accepted: true }, 202)
  } finally {
    if (!enrolled) core.releaseCode(code.codeId)
  }
})

// A signed-in browser proves its device key in place (finding: an open browser never returns to the sign-in page, so it
// would stay "never proved" for ever). Step 1 hands out a challenge bound to this session and device; step 2 takes the
// device's signature over it.
routes.post('/api/auth/device/prove/options', csrf, session, rate('prove'), (c) => {
  const { core } = state(c)
  const sess = sessionFor(state(c), c)
  if (!sess?.deviceId) return c.json({ error: 'bad_request' }, 400)
  // Nothing to upgrade: the browser skips the signing (and the next page load costs one small request).
  if (core.device(sess.deviceId)?.loginProvenAt != null) return c.json({ proven: true })
  const challenge = newToken(32)
  core.putChallenge('device', challenge, sess.sessionId, `prove:${sess.deviceId}`, DEVICE_PROOF_TTL_MS)
  return c.json({ challenge })
})

routes.post('/api/auth/device/prove', csrf, session, rate('prove'), async (c) => {
  const { core, services } = state(c)
  const sess = sessionFor(state(c), c)
  const parsed = await body(c, R.deviceProve.req)
  if (!sess?.deviceId || !parsed) return c.json({ error: 'bad_request' }, 400)
  const device = core.device(sess.deviceId)
  if (!device || device.revoked) return c.json({ error: 'bad_request' }, 400)
  const good =
    core.consumeChallenge('device', parsed.nonce, sess.sessionId, `prove:${device.id}`) &&
    (await verifyDeviceProof(device.pubkeyJwk, {
      nonce: parsed.nonce,
      codeId: SESSION_PROOF_CODE_ID,
      deviceId: device.id,
      sig: parsed.sig,
    }))
  if (!good) return c.json({ error: 'device_proof_invalid' }, 401)
  if (core.markLoginProven(device.id, sess.sessionId) > 0) services.bus.revalidateApps()
  return c.json({ ok: true })
})

// ---- step-up --------------------------------------------------------------------------------------------------

routes.post('/api/auth/stepup/options', rate('stepup'), csrf, session, async (c) => {
  const { core, services } = state(c)
  const sess = sessionFor(state(c), c)
  const b = await body(c, R.stepupOptions.req)
  if (!sess || !b) return c.json({ error: 'bad_request' }, 400)
  const row = core.db.prepare('select credential_id from auth_sessions where id = ?').pluck().get(sess.sessionId) as
    | string
    | null
  const cred = row ? core.credential(row) : null
  const options = await generateAuthenticationOptions({
    rpID: services.env.RP_ID,
    userVerification: 'required',
    ...(cred
      ? { allowCredentials: [{ id: cred.credentialId, ...(cred.transports ? { transports: cred.transports } : {}) }] }
      : {}),
  })
  core.putChallenge('stepup', options.challenge, sess.sessionId, b.purpose)
  return c.json(options)
})

routes.post('/api/auth/stepup/verify', rate('stepup'), csrf, session, async (c) => {
  const { core, services } = state(c)
  const sess = sessionFor(state(c), c)
  const b = await body(c, R.stepupVerify.req)
  if (!sess || !b) return c.json({ error: 'bad_request' }, 400)
  const bound = core.db.prepare('select credential_id from auth_sessions where id = ?').pluck().get(sess.sessionId) as
    | string
    | null
  const response = b.response as { id?: unknown }
  const cred = typeof response.id === 'string' ? core.credential(response.id) : null
  if (!cred || (bound && cred.credentialId !== bound)) return c.json({ error: 'stepup_invalid' }, 403)
  try {
    const v = await verifyAuthenticationResponse({
      response: b.response as never,
      expectedChallenge: (ch) => core.consumeChallenge('stepup', ch, sess.sessionId, b.purpose),
      expectedOrigin: services.env.PUBLIC_ORIGIN,
      expectedRPID: services.env.RP_ID,
      credential: {
        id: cred.credentialId,
        publicKey: cred.publicKey as never,
        counter: cred.counter,
        ...(cred.transports ? { transports: cred.transports } : {}),
      },
      requireUserVerification: true,
    })
    if (!v.verified) return c.json({ error: 'stepup_invalid' }, 403)
    core.touchCredential(cred.credentialId, v.authenticationInfo.newCounter)
  } catch {
    return c.json({ error: 'stepup_invalid' }, 403)
  }
  return c.json({ stepup_token: core.mintStepup(sess.sessionId, b.purpose) })
})

// ---- session ----------------------------------------------------------------------------------------------------

routes.post('/api/auth/logout', rate('auth'), csrf, sessionAny, (c) => {
  const sess = sessionFor(state(c), c)
  if (sess) {
    state(c).core.deleteSession(sess.sessionId, 'logged_out')
    // Signed out on purpose: this device stops getting pushes (and badges). A phone's native push stays off until the owner
    // turns it on again; a browser's subscription is made again by the app on its next open after it signs in.
    if (sess.deviceId) {
      c.get('services').db.prepare('delete from core_push_devices where device_id = ?').run(sess.deviceId)
      // The notification keys go with it: no more sealed text, and the buttons on notifications already delivered stop working.
      c.get('services').db.prepare('delete from core_native_grants where device_id = ?').run(sess.deviceId)
      c.get('services').db.prepare('delete from core_push_subs where device_id = ?').run(sess.deviceId)
    }
  }
  c.get('services').bus.revalidateApps() // its live socket closes now, not at the next reconnect
  c.header('Set-Cookie', clearedCookie())
  return c.body(null, 204)
})

// Pinned sessions only: a session the Mac refused must not be able to sign the owner out everywhere (review #28).
routes.post('/api/auth/logout-all', rate('auth'), csrf, session, (c) => {
  state(c).core.deleteAllSessions()
  c.get('services').db.prepare('delete from core_push_devices').run()
  c.get('services').db.prepare('delete from core_native_grants').run()
  // Browser and Home Screen push subscriptions are not tied to a session, so they would keep delivering after this.
  c.get('services').db.prepare('delete from core_push_subs').run()
  c.get('services').bus.revalidateApps()
  c.header('Set-Cookie', clearedCookie())
  return c.body(null, 204)
})

routes.get('/api/me', sessionAny, (c) => {
  const { core, services } = state(c)
  const sess = sessionFor(state(c), c)
  const device = sess?.deviceId ? core.device(sess.deviceId) : null
  return c.json({
    ...(device && !device.revoked ? { device_id: device.id } : {}),
    device_pinned: Boolean(device?.pinned && !device.revoked),
    has_passkey: core.hasPasskey,
    rp_id: services.env.RP_ID,
    version: VERSION,
    bridge_online: services.bus.bridgeOnline(),
    voice: voiceStatus(services.env),
    dictate: dictateStatus(services.env),
    ...(services.env.VAPID_PUBLIC_KEY ? { vapid_public_key: services.env.VAPID_PUBLIC_KEY } : {}),
  })
})

// ---- devices ----------------------------------------------------------------------------------------------------

routes.get('/api/devices', session, (c) => {
  const list: DeviceT[] = state(c)
    .core.devices()
    .map((d) => ({
      id: d.id,
      name: d.name,
      pubkey_jwk: d.pubkeyJwk,
      pinned: d.pinned,
      revoked: d.revoked,
      created_at: iso(d.createdAt) as string,
      last_used_at: iso(d.lastUsedAt),
      shared_passkey: d.revoked ? false : state(c).core.sharesPasskey(d.id),
      login_proven_at: iso(d.loginProvenAt),
    }))
  return c.json(list)
})

// Order matters: the rate limit and the session check run BEFORE csrf, because csrf with no content type reads the
// body. A caller with no session is turned away without a byte of it being read.
routes.post(
  '/api/devices/:id/revoke',
  rate('revoke'),
  session,
  smallBodyGuard(),
  csrf,
  stepup('device:revoke'),
  async (c) => {
    const { core, services } = state(c)
    const id = c.req.param('id') ?? ''
    if (!DeviceId.safeParse(id).success || !core.revokeDevice(id)) return c.json({ error: 'not_found' }, 404)
    services.bus.revalidateApps() // the revoked phone's live socket closes with 4401
    await services.bus.toBridge(frame('device.revoked', { device_id: id }, services.clock.now()), {
      durable: true,
      ttl_s: 7 * 24 * 3600,
    })
    return c.body(null, 204)
  },
)

// ---- bridge (signed HTTP) ---------------------------------------------------------------------------------------

/** These bodies are a few hundred bytes. The guard runs BEFORE the signature is read, so an unsigned client cannot stream or stall. */
const BRIDGE_AUTH_BODY_CAP = 4096
const bridgeBodyGuard = [limitBody(() => BRIDGE_AUTH_BODY_CAP), bodyTimeout()] as const

type Bridged = { keyId: string; raw: Uint8Array }

/** Reads the raw body once and checks the TalosBridge signature over it. */
async function bridgeAuth(c: Context<AppEnv>): Promise<Bridged | Response> {
  const raw = new Uint8Array(await c.req.arrayBuffer())
  const res = await auth(c).verifyBridgeHttp(c, raw)
  if (!res.ok) return c.json({ error: 'unauthorized' }, 401)
  return { keyId: res.keyId, raw }
}

function parseBody<S extends z.ZodType>(raw: Uint8Array, schema: S): z.infer<S> | null {
  try {
    const r = schema.safeParse(JSON.parse(Buffer.from(raw).toString('utf8')))
    return r.success ? r.data : null
  } catch {
    return null
  }
}

routes.post('/bridge/enroll', ...bridgeBodyGuard, async (c) => {
  const a = await bridgeAuth(c)
  if (a instanceof Response) return a
  const { core, services } = state(c)
  const b = parseBody(a.raw, R.bridgeEnroll.req)
  if (!b) return c.json({ error: 'bad_request' }, 400)
  const now = services.clock.now()
  const expiresAt = Date.parse(b.expires_at)
  if (!(expiresAt > now) || expiresAt > now + ENROLL_CODE_MAX_TTL_MS + 60_000)
    return c.json({ error: 'bad_expiry' }, 400)
  const r = core.addCode({
    codeId: b.code_id,
    hash: b.code_auth_hash,
    expiresAt,
    ...(b.label ? { label: b.label } : {}),
  })
  if (r === 'conflict') return c.json({ error: 'code_conflict' }, 409)
  return c.json({ ok: true })
})

routes.post('/bridge/rotate', ...bridgeBodyGuard, async (c) => {
  const a = await bridgeAuth(c)
  if (a instanceof Response) return a
  const { core, services } = state(c)
  const b = parseBody(a.raw, R.bridgeRotate.req)
  if (!b) return c.json({ error: 'bad_request' }, 400)
  if (Math.abs(Math.floor(services.clock.now() / 1000) - b.ts) > 120) return c.json({ error: 'unauthorized' }, 401)
  // The NEW key must sign its own announcement, so a stolen old key alone cannot be traded for a key it does not hold.
  try {
    b64urlDecode(b.new_pubkey)
  } catch {
    return c.json({ error: 'bad_request' }, 400)
  }
  if (!(await verifyRotation(b.new_pubkey, b.ts, b.sig_new))) return c.json({ error: 'unauthorized' }, 401)
  if (services.env.BRIDGE_PUBKEY_FORCE) return c.json({ error: 'rotation_disabled' }, 409)
  // Only the ACTIVE key may rotate; a previous key inside its grace window authenticates but cannot rotate.
  const current = core.activeKey()
  if (!current || current.keyId !== a.keyId) return c.json({ error: 'unauthorized' }, 401)
  return c.json({ ok: true, key_id: core.rotateBridgeKey(current, b.new_pubkey) })
})

routes.post('/bridge/devices/:id/revoke', ...bridgeBodyGuard, async (c) => {
  const a = await bridgeAuth(c)
  if (a instanceof Response) return a
  const { core, services } = state(c)
  const id = c.req.param('id') ?? ''
  if (!DeviceId.safeParse(id).success) return c.json({ error: 'not_found' }, 404)
  // Read before the revoke: afterwards the count would still be right, but this is the state the owner is acting on.
  const sharedPasskey = core.sharesPasskey(id)
  if (!core.revokeDevice(id)) return c.json({ error: 'not_found' }, 404)
  services.bus.revalidateApps()
  await services.bus.toApps(
    frame('device.pinned', { device_id: id, ok: false, reason: 'revoked' }, services.clock.now()),
    { durable: false },
  )
  // Revoking one device leaves a passkey valid while another live device uses it; the CLI tells the owner. A bridge from
  // before this field ignores it.
  return c.json({ ok: true, shared_passkey: sharedPasskey })
})

// ---- registration -----------------------------------------------------------------------------------------------

export function register(services: RelayServices): void {
  const st = authState(services)
  // Contract suites install test-auth (NODE_ENV=test only: registerModules refuses to boot otherwise) and keep it.
  if (!isTestAuthInstalled()) setAuthImplementation(implFor(st))

  // The Mac answered the y/N prompt (spec 5.3 step 4). Only a live, authenticated bridge socket can send this.
  services.bus.onBridgeFrame('device.pinned', async (f) => {
    const d = st.core.device(f.device_id)
    if (!d || d.revoked) return
    if (f.ok) st.core.setPinned(d.id, true)
    else st.core.declineDevice(d.id)
    // The hub already stored this durable bridge frame, fanned it out to the apps and sent the "New device pinned" push;
    // doing either again here made two frames and two pushes per pin. What is left is acting on it: re-gate live sockets.
    services.bus.revalidateApps()
  })

  // The sweep re-arms itself, so stop() must clear it: on a stopped relay the database is closed (the e2e suite stops and
  // starts relays inside one process, and a leftover timer fired on the closed database ten minutes later).
  let sweepTimer: unknown
  let swept = false
  const sweep = () => {
    if (swept) return
    st.core.purge()
    st.helloGuard.prune()
    services.bus.revalidateApps()
    sweepTimer = services.clock.setTimeout(sweep, 10 * 60_000)
  }
  sweepTimer = services.clock.setTimeout(sweep, 10 * 60_000)
  findRuntime(services)?.onStop(() => {
    swept = true
    services.clock.clearTimeout(sweepTimer)
  })
}

export { FrameBudget } from './limits.ts'
