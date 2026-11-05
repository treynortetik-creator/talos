// Relay core (WP1): health, the two WebSocket upgrades, push subscriptions, media, the bridge's HTTP routes, security
// headers and the static web app. Auth comes from the contract (`../auth/contract.ts`), never from here.

import { readFileSync, statSync } from 'node:fs'
import type { IncomingMessage } from 'node:http'
import { extname, normalize, resolve, sep } from 'node:path'
import { upgradeWebSocket } from '@hono/node-server'
import {
  APNS_REGISTRATION_SKEW_MS,
  APP_CSP_HEADER,
  ApnsRegistration,
  type ApnsStatusT,
  type AppCspT,
  appCsp,
  buildAppCsp,
  checkGrant,
  checkNativeAct,
  declaredFileType,
  decodeAppCspHeader,
  FILE_TYPE_HEADER,
  type Frame,
  fileTypeAllowed,
  MAX_FRAME_BYTES,
  MediaId,
  NativeActWire,
  NativeGrant,
  NativeGrantRevoke,
  type NativeGrantT,
  PushSubscriptionJson,
  parseFrame,
  routes as protocolRoutes,
  sha256Hex,
  ThreadId,
  verifyOwnerFrame,
} from '@talos-app/protocol'
import type { Context } from 'hono'
import { Hono } from 'hono'
import type { WSContext } from 'hono/ws'
import { z } from 'zod'
import {
  getSession,
  guardWsUpgrade,
  noteDeviceUse,
  preflightBridgeHttp,
  rateLimit,
  requireCsrf,
  requireSession,
  type Session,
  sessionActive,
  verifyBridgeHttp,
  verifyBridgeHttpHash,
} from '../auth/contract.ts'
import type { AppEnv, RelayServices } from '../services.ts'
import { VERSION } from '../version.ts'
import { aasaDocument } from './aasa.ts'
import { bodyTimeout, idleBodyTimeout, lateRequest, limitBody, readBodyWithDeadline } from './body-guard.ts'
import { DEFAULT_AGENT_CONFIG } from './default-config.ts'
import { type Conn, FrameRejected } from './hub.ts'
import { cleanName, dispositionHeader, parseRange } from './media.ts'
import { registerProblems } from './problems.ts'
import { type CoreRuntime, findRuntime, runtimeOf } from './runtime.ts'
import { registerShare, shareBytesSince } from './share.ts'
import { isInlineMime, sniffMime } from './sniff.ts'
import { frameGate, SMALL_BODY_BYTES, uploadGate } from './upload-gate.ts'
import { clientIp, DAY_MS } from './util.ts'

export const routes = new Hono<AppEnv>()

const MIB = 1024 * 1024
const asBody = (b: Uint8Array): BodyInit => b as unknown as BodyInit
const MEDIA_CSP = "sandbox; default-src 'none'; img-src 'self' data:; media-src 'self'"
const PAGE_CSP =
  "sandbox allow-scripts; default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; media-src data: blob:; font-src data:"
/** An MCP app page is at most this big (spec M3.5). */
const APP_PAGE_MAX_BYTES = 8 * MIB
/** Spec M3.5, byte for byte. */
const APP_PERMISSIONS_POLICY =
  'camera=(), microphone=(), geolocation=(), clipboard-read=(), clipboard-write=(), payment=(), usb=(), serial=(), hid=(), bluetooth=(), display-capture=(), fullscreen=()'
const RESERVED = /^\/(api|hook|bridge|media|ws|healthz|\.well-known)(\/|$)/

export function register(services: RelayServices): void {
  // Services made by createRelayServices carry a runtime; the unit-test fakes do not, and need no timers.
  findRuntime(services)?.start()
  registerProblems(services)
  registerShare(services) // docs/V2-FEATURES.md V4: share/1 is a relay feature (works with the Mac offline)
}

const rt = (c: Context<AppEnv>): CoreRuntime => runtimeOf(c.get('services'))

// ---- security headers (every response) --------------------------------------------------------------------------

routes.use('*', async (c, next) => {
  await next()
  const h = c.res.headers
  const set = (k: string, v: string) => {
    if (!h.has(k)) h.set(k, v)
  }
  set('Strict-Transport-Security', 'max-age=63072000')
  set('X-Content-Type-Options', 'nosniff')
  set('Referrer-Policy', 'no-referrer')
  set('Permissions-Policy', 'microphone=(self), camera=(), geolocation=(), payment=()')
  set('Cross-Origin-Opener-Policy', 'same-origin')
  set('Cross-Origin-Resource-Policy', 'same-origin')
  if ((h.get('content-type') ?? '').includes('text/html'))
    set('Content-Security-Policy', appCsp(c.get('services').env.PUBLIC_ORIGIN))
})

// Every /media response, including 401 and 404, carries the sandbox CSP: an error body is never rendered as a page.
routes.use('/media/*', async (c, next) => {
  await next()
  if (!c.res.headers.has('Content-Security-Policy')) c.res.headers.set('Content-Security-Policy', MEDIA_CSP)
})

// ---- health -----------------------------------------------------------------------------------------------------

routes.get('/healthz', (c) => c.json({ ok: true as const, version: VERSION }))

// ---- Apple App Site Association (IOS-SPEC WP-I6) ----------------------------------------------------------------
// webcredentials only, from APNS_TEAM_ID + APNS_BUNDLE_ID. Without both it is a plain 404 (JSON, never the app shell).
// Apple's CDN wants a direct 200 over https with no redirect; the body is tiny and carries no secret.
routes.get('/.well-known/apple-app-site-association', (c) => {
  const doc = aasaDocument(c.get('services').env)
  if (!doc) return c.json({ error: 'not_found' }, 404)
  return c.body(JSON.stringify(doc), 200, {
    'Content-Type': 'application/json',
    'Cache-Control': 'public, max-age=300',
  })
})

// ---- WebSockets -------------------------------------------------------------------------------------------------

function connOf(ws: WSContext): Conn {
  return {
    send: (t) => {
      if (ws.readyState === 1) ws.send(t)
    },
    close: (code, reason) => ws.close(code, reason),
    terminate: () => (ws.raw as { terminate?: () => void } | undefined)?.terminate?.() ?? ws.close(1011),
  }
}

function ipOf(c: Context<AppEnv>): string {
  const incoming = (c.env as { incoming?: IncomingMessage } | undefined)?.incoming
  return clientIp(
    { realIp: c.req.header('x-real-ip'), xff: c.req.header('x-forwarded-for') },
    incoming?.socket?.remoteAddress,
    c.get('services').env.TRUST_PROXY_HOPS,
  )
}

const wsSessions = new WeakMap<Request, Session>()

routes.get(
  '/ws',
  rateLimit('ws'),
  async (c, next) => {
    const guard = await guardWsUpgrade(c)
    if (guard instanceof Response) return guard
    wsSessions.set(c.req.raw, guard)
    await next()
  },
  upgradeWebSocket((c) => {
    const session = wsSessions.get(c.req.raw) ?? getSession(c as unknown as Context<AppEnv>)
    const hub = rt(c as unknown as Context<AppEnv>).hub
    const ip = ipOf(c as unknown as Context<AppEnv>)
    let handle: ReturnType<typeof hub.attachApp> | null = null
    return {
      onOpen: (_e, ws) => {
        handle = hub.attachApp(connOf(ws), { session: session ?? null, ip })
      },
      onMessage: (e) =>
        handle?.onMessage(typeof e.data === 'string' ? e.data : Buffer.from(e.data as ArrayBuffer).toString('utf8')),
      onClose: () => handle?.onClose(),
    }
  }),
)

routes.get(
  '/bridge',
  rateLimit('bridge_ws'),
  upgradeWebSocket((c) => {
    const cc = c as unknown as Context<AppEnv>
    const hub = rt(cc).hub
    const ip = ipOf(cc)
    const relayHost = new URL(cc.get('services').env.PUBLIC_ORIGIN).host
    let handle: ReturnType<typeof hub.attachBridge> | null = null
    return {
      onOpen: (_e, ws) => {
        handle = hub.attachBridge(connOf(ws), { ip, relayHost })
      },
      onMessage: (e) =>
        handle?.onMessage(typeof e.data === 'string' ? e.data : Buffer.from(e.data as ArrayBuffer).toString('utf8')),
      onClose: () => handle?.onClose(),
    }
  }),
)

// ---- push -------------------------------------------------------------------------------------------------------

routes.post('/api/push/subscribe', requireSession, requireCsrf, async (c) => {
  const body = PushSubscriptionJson.safeParse(await c.req.json().catch(() => null))
  if (!body.success) return c.json({ error: 'bad_request' }, 400)
  // The body took time to arrive; the session and device are checked again now, in the same step as the write.
  const session = getSession(c)
  if (!sessionActive(session)) return c.json({ error: 'unauthorized' }, 401)
  if (!rt(c).store.putSub({ endpoint: body.data.endpoint, keys: body.data.keys }, session?.deviceId ?? null))
    return c.json({ error: 'unauthorized' }, 401)
  return c.body(null, 204)
})

routes.delete('/api/push/subscribe', requireSession, requireCsrf, async (c) => {
  const body = protocolRoutes.pushUnsubscribe.req.safeParse(await c.req.json().catch(() => null))
  if (!body.success) return c.json({ error: 'bad_request' }, 400)
  rt(c).store.deleteSub(body.data.endpoint)
  return c.body(null, 204)
})

// ---- native push (APNs, WP-I5) ----------------------------------------------------------------------------------

routes.get('/api/push/apns', requireSession, async (c) => {
  const deviceId = getSession(c)?.deviceId
  const body: ApnsStatusT = {
    configured: rt(c).push.apnsConfigured,
    registered: deviceId ? rt(c).store.hasPushDevice(deviceId) : false,
  }
  return c.json(body)
})

/** What a notification's opaque thread reference means. Signed-in sessions only; Apple only ever saw the reference. */
routes.get('/api/push/ref/:ref', requireSession, async (c) => {
  const ref = c.req.param('ref')
  if (!/^r_[A-Za-z0-9_-]{16}$/.test(ref)) return c.json({ error: 'bad_request' }, 400)
  const thread = rt(c).store.threadForPushRef(ref)
  return thread ? c.json({ thread_id: thread }) : c.json({ error: 'not_found' }, 404)
})

/**
 * The reverse of the route above: the opaque reference an iPhone notification uses for a thread. The app needs it to clear
 * a named thread's delivered notifications once it is read, and to keep a banner quiet while the thread is on screen,
 * because Apple's payload never carries the thread id (`forApple`). Minted on first ask (stable and idempotent, so the first
 * push cannot race the lookup); only a thread that exists gets one, so a session cannot fill the table.
 */
routes.get('/api/push/thread-ref/:thread', requireSession, async (c) => {
  const parsed = ThreadId.safeParse(c.req.param('thread'))
  if (!parsed.success) return c.json({ error: 'bad_request' }, 400)
  const known = (c.get('services').agentConfig()?.threads ?? DEFAULT_AGENT_CONFIG.threads).some(
    (t) => t.id === parsed.data,
  )
  if (!known) return c.json({ error: 'not_found' }, 404)
  return c.json({ ref: rt(c).store.pushRef(parsed.data) })
})

routes.post('/api/push/apns', requireSession, requireCsrf, rateLimit('push_apns'), async (c) => {
  const raw: unknown = await c.req.json().catch(() => null)
  const parsed = ApnsRegistration.safeParse(raw)
  if (!parsed.success) return c.json({ error: 'bad_request' }, 400)
  const reg = parsed.data
  const services = c.get('services')
  const { store } = rt(c)
  const session = getSession(c)
  if (!session?.deviceId || session.deviceId !== reg.device_id) return c.json({ error: 'wrong_device' }, 403)
  // Signed with the device key the Mac pinned. The RAW object is verified (zod defaults must not touch what was signed).
  const row = services.db
    .prepare('select pubkey_jwk from auth_devices where id = ? and pinned = 1 and revoked = 0')
    .get(reg.device_id) as { pubkey_jwk: string } | undefined
  let jwk: unknown = null
  try {
    jwk = row ? JSON.parse(row.pubkey_jwk) : null
  } catch {
    jwk = null
  }
  const jwkOk = jwk !== null && typeof jwk === 'object'
  if (!row || !jwkOk || !(await verifyOwnerFrame(raw as Record<string, unknown>, jwk as never)))
    return c.json({ error: 'bad_signature' }, 401)
  const now = services.clock.now()
  // Fresh in both directions: a stale capture and a phone clock that is minutes off both fail, with a reason the app can show.
  if (Math.abs(Date.parse(reg.ts) - now) > APNS_REGISTRATION_SKEW_MS) return c.json({ error: 'stale' }, 400)
  // Single use, and it survives a restart: the insert is the check (a second one, even at the same instant, changes nothing).
  services.db.prepare('delete from core_push_nonces where expires_at <= ?').run(now)
  const burned = services.db
    .prepare('insert or ignore into core_push_nonces (nonce_key, expires_at) values (?, ?)')
    .run(`${reg.device_id}:${reg.nonce}`, now + 2 * APNS_REGISTRATION_SKEW_MS)
  if (burned.changes === 0) return c.json({ error: 'replay' }, 409)
  if (reg.op === 'unregister') {
    store.deletePushDeviceByDevice(reg.device_id)
    return c.body(null, 204)
  }
  if (!rt(c).push.apnsConfigured) return c.json({ error: 'not_configured' }, 409)
  if (reg.token && reg.env) store.putPushDevice({ deviceId: reg.device_id, token: reg.token, env: reg.env })
  return c.body(null, 204)
})

/** Does the relay hold a current grant for this session's phone, and until when? Never the keys. */
routes.get('/api/push/grant', requireSession, async (c) => {
  const session = getSession(c)
  const g = session?.deviceId ? rt(c).store.nativeGrant(session.deviceId) : null
  return c.json(g ? { registered: true, exp: new Date(g.exp).toISOString() } : { registered: false })
})

/**
 * A phone's rich-notification grant (docs/IOS-PUSH.md "Message text and quick actions"): the device key signs two public keys
 * the phone made. Same checks as the token registration above (this session's own pinned device, fresh, single use), then
 * the relay keeps the grant exactly as received. `native.grant.revoke` takes it away again.
 */
routes.post('/api/push/grant', requireSession, requireCsrf, rateLimit('push_apns'), async (c) => {
  const raw: unknown = await c.req.json().catch(() => null)
  const revoke = NativeGrantRevoke.safeParse(raw)
  const parsedGrant = revoke.success ? null : NativeGrant.safeParse(raw)
  if (!revoke.success && !parsedGrant?.success) return c.json({ error: 'bad_request' }, 400)
  const deviceId = revoke.success ? revoke.data.device_id : (parsedGrant as { data: NativeGrantT }).data.device_id
  const stamp = revoke.success ? revoke.data.ts : (parsedGrant as { data: NativeGrantT }).data.ts
  const nonceValue = revoke.success ? revoke.data.nonce : (parsedGrant as { data: NativeGrantT }).data.nonce
  const services = c.get('services')
  const { store } = rt(c)
  const session = getSession(c)
  if (!session?.deviceId || session.deviceId !== deviceId) return c.json({ error: 'wrong_device' }, 403)
  const row = services.db
    .prepare('select pubkey_jwk from auth_devices where id = ? and pinned = 1 and revoked = 0')
    .get(deviceId) as { pubkey_jwk: string } | undefined
  let jwk: unknown = null
  try {
    jwk = row ? JSON.parse(row.pubkey_jwk) : null
  } catch {
    jwk = null
  }
  if (!row || jwk === null || typeof jwk !== 'object') return c.json({ error: 'bad_signature' }, 401)
  const now = services.clock.now()
  if (revoke.success) {
    if (!(await verifyOwnerFrame(raw as Record<string, unknown>, jwk as never)))
      return c.json({ error: 'bad_signature' }, 401)
  } else {
    const g = await checkGrant(raw, jwk as never, now)
    if (!g.ok) return c.json({ error: g.reason }, g.reason === 'bad_signature' ? 401 : 400)
  }
  if (Math.abs(Date.parse(stamp) - now) > APNS_REGISTRATION_SKEW_MS) return c.json({ error: 'stale' }, 400)
  services.db.prepare('delete from core_push_nonces where expires_at <= ?').run(now)
  const burned = services.db
    .prepare('insert or ignore into core_push_nonces (nonce_key, expires_at) values (?, ?)')
    .run(`${deviceId}:${nonceValue}`, now + 2 * APNS_REGISTRATION_SKEW_MS)
  if (burned.changes === 0) return c.json({ error: 'replay' }, 409)
  if (revoke.success) {
    store.deleteNativeGrant(deviceId)
    return c.body(null, 204)
  }
  const g = (parsedGrant as { data: NativeGrantT }).data
  store.putNativeGrant({
    deviceId,
    encPub: g.enc_pub,
    actPub: g.act_pub,
    grantJson: JSON.stringify(raw),
    exp: Date.parse(g.exp),
  })
  return c.body(null, 204)
})

/**
 * Reply or Approve from a notification button. The phone's background process posts here with no cookie: the credential is
 * the signature chain itself (device key -> grant -> action key), checked here and again by the Mac. Order: size and
 * rate first, then who (a pinned, un-revoked device whose current grant this is), then the chain, then the same rules the
 * socket path applies (Hub.acceptNativeAct). A retry of the same bytes is answered "done"; nothing is ever answered "done"
 * that was not queued for the Mac.
 */
routes.post(
  '/api/native/act',
  rateLimit('native_act'),
  limitBody(() => 16 * 1024),
  bodyTimeout(),
  async (c) => {
    const services = c.get('services')
    const raw: unknown = await c.req.json().catch(() => null)
    if (lateRequest(c)) return c.json({ error: 'request_timeout' }, 408)
    const wire = NativeActWire.safeParse(raw)
    // Nothing here has been proven yet, so a missing, unparseable or wrong-shaped frame is "not signed", the same answer an
    // anonymous caller gets on every other route (401). It must not describe what the route expects. A frame that is
    // well-formed and really signed but wrong inside (bad_body, scope, ...) still gets its own 400/403 below.
    if (!wire.success) return c.json({ error: 'bad_signature' }, 401)
    const f = wire.data
    const dev = services.db
      .prepare('select pubkey_jwk from auth_devices where id = ? and pinned = 1 and revoked = 0')
      .get(f.device_id) as { pubkey_jwk: string } | undefined
    let jwk: unknown = null
    try {
      jwk = dev ? JSON.parse(dev.pubkey_jwk) : null
    } catch {
      jwk = null
    }
    // An unknown, un-pinned or revoked device answers exactly like a bad signature, so a caller cannot probe which device
    // ids exist.
    if (!dev || jwk === null || typeof jwk !== 'object') return c.json({ error: 'bad_signature' }, 401)
    const { store } = rt(c)
    // Only the grant this relay holds right now. A replaced, revoked, signed-out or expired grant is dead here at once,
    // even though the Mac would still accept its signature until it expires.
    const held = store.nativeGrant(f.device_id)
    // Same answer as a bad signature, so an unsigned caller cannot tell a trusted device id from any other. The phone treats
    // both codes alike ("open Talos to renew").
    if (!held || held.grantJson !== f.grant) return c.json({ error: 'bad_signature' }, 401)
    const check = await checkNativeAct(raw, jwk as never, services.clock.now())
    if (!check.ok) {
      const code = check.reason
      const status =
        code === 'bad_signature' || code === 'bad_act_signature'
          ? 401
          : code === 'scope' || code === 'expired'
            ? 403
            : 400
      return c.json({ error: code }, status)
    }
    // The signature chain checked out: this phone's owner just acted from a notification. That is real use, whatever the
    // action's own rules say next (a refused reply was still someone at the phone).
    noteDeviceUse(f.device_id)
    let out: ReturnType<CoreRuntime['hub']['acceptNativeAct']>
    try {
      out = rt(c).hub.acceptNativeAct(check, raw as Record<string, unknown>)
    } catch {
      return c.json({ error: 'server_error' }, 500)
    }
    if (!out.ok) return c.json({ error: out.code, message: out.message }, out.status)
    return c.json({ ok: true, duplicate: out.duplicate })
  },
)

routes.post('/api/push/test', requireSession, requireCsrf, async (c) => {
  const res = await rt(c).push.notifyCounted({ template: 'reply' }, { force: true })
  // 204 only when something was accepted (or there was nothing to send to). "Sent" must not mean "Apple said no" (L2).
  if (res && res.sent > 0 && res.ok === 0) return c.json({ error: 'push_failed' }, 502)
  // The iPhone row asks about the phone alone (`?via=apns`): a browser that took the push must not hide Apple's refusal (R6).
  if (c.req.query('via') === 'apns') {
    if (!res || res.native.sent === 0) return c.json({ error: 'no_device' }, 409)
    if (res.native.ok === 0) return c.json({ error: 'push_failed' }, 502)
  }
  return c.body(null, 204)
})

// ---- media (owner) ----------------------------------------------------------------------------------------------

function maxMediaBytes(c: Context<AppEnv>): number {
  return c.get('services').env.MEDIA_MAX_MB * MIB
}

// /api/media authenticates (session + CSRF) before it reads a byte, so a slow phone upload may use an idle timeout.
const mediaBodyGuard = [limitBody(maxMediaBytes), idleBodyTimeout()] as const
// /bridge/* reads the whole body BEFORE it can verify the signature: a fixed deadline, never an idle one. The media one
// matches the bridge's own deadline for a full-size file (15 s + 2 s per MB, 115 s at 50 MB).
const bridgeMediaBodyGuard = [limitBody(maxMediaBytes), bodyTimeout(120_000)] as const
const frameBodyGuard = [limitBody(() => MAX_FRAME_BYTES), bodyTimeout()] as const

routes.post('/api/media', ...mediaBodyGuard, requireSession, requireCsrf, rateLimit('media'), async (c) => {
  const max = maxMediaBytes(c)
  const declared = Number(c.req.header('content-length') ?? 0)
  if (declared > max) return c.json({ error: 'too_large' }, 413)
  // The real type of a text file (its Content-Type was hidden as octet-stream). Refused before the body is read.
  const declaredType = declaredFileType(c.req.header(FILE_TYPE_HEADER))
  if (declaredType !== null && !fileTypeAllowed(declaredType)) return c.json({ error: 'file_type_not_allowed' }, 415)
  const bytes = new Uint8Array(await c.req.arrayBuffer())
  if (lateRequest(c)) return c.json({ error: 'request_timeout' }, 408) // the client was told it failed; save nothing
  if (bytes.length === 0) return c.json({ error: 'bad_request' }, 400)
  if (bytes.length > max) return c.json({ error: 'too_large' }, 413)
  const r = rt(c)
  const claimed = c.req.header('x-talos-sha256')
  const sha = sha256Hex(bytes)
  if (claimed && claimed.toLowerCase() !== sha) return c.json({ error: 'sha256 mismatch' }, 400)
  const now = c.get('services').clock.now()
  // Share uploads have their own daily budget (core/share.ts) and do not count against the owner's daily budget (MEDIA_DAILY_MAX_MB, 200 by default).
  if (
    r.store.uploadedBytesSince(now - DAY_MS) - shareBytesSince(r.store.db, now - DAY_MS) + bytes.length >
    c.get('services').env.MEDIA_DAILY_MAX_MB * MIB
  )
    return c.json({ error: 'rate_limited' }, 429)
  const dur = Number(c.req.header('x-talos-duration-ms'))
  const { ref } = r.media.save({
    bytes,
    claimedMime: c.req.header('content-type') ?? '',
    declaredType,
    name: decodeName(c.req.header('x-talos-name')),
    durationMs: Number.isFinite(dur) && dur > 0 ? Math.trunc(dur) : undefined,
    origin: 'app',
  })
  return c.json(ref)
})

function decodeName(raw: string | undefined): string {
  if (!raw) return 'upload'
  try {
    return cleanName(decodeURIComponent(raw))
  } catch {
    return cleanName(raw)
  }
}

function mediaHeaders(extra: Record<string, string>): Record<string, string> {
  return {
    // Chromium keeps a 410 forever unless told not to, and the answer flips once the Mac sends the file back.
    'Cache-Control': 'no-store',
    'Content-Security-Policy': MEDIA_CSP,
    'X-Content-Type-Options': 'nosniff',
    'Cross-Origin-Resource-Policy': 'same-origin',
    ...extra,
  }
}

routes.get('/media/:id', requireSession, (c) => {
  const id = c.req.param('id')
  if (!MediaId.safeParse(id).success) return c.json({ error: 'not_found' }, 404, { 'Cache-Control': 'no-store' })
  const r = rt(c)
  const row = r.store.getMediaRow(id)
  if (!row) return c.json({ error: 'not_found' }, 404, { 'Cache-Control': 'no-store' })
  const data = row.evicted ? null : r.media.read(id)
  // Past the buffer window the bytes live on the Mac; the app asks for them with `media.fetch` and waits for `media.ready`.
  if (!data) return c.json({ error: 'gone', rehydrate: true }, 410, mediaHeaders({}))
  const bytes = data.bytes
  const size = bytes.length
  const base = mediaHeaders({
    'Content-Type': row.mime,
    'Content-Disposition': dispositionHeader(isInlineMime(row.mime) ? 'inline' : 'attachment', row.name),
    'Accept-Ranges': 'bytes',
    ETag: `"${row.sha256}"`,
    'Cache-Control': 'private, max-age=3600',
  })
  const range = parseRange(c.req.header('range'), size)
  if (range === 'unsatisfiable')
    return new Response(null, { status: 416, headers: { ...base, 'Content-Range': `bytes */${size}` } })
  if (range) {
    const part = bytes.subarray(range.start, range.end + 1)
    return new Response(asBody(part), {
      status: 206,
      headers: {
        ...base,
        'Content-Range': `bytes ${range.start}-${range.end}/${size}`,
        'Content-Length': String(part.length),
      },
    })
  }
  return new Response(asBody(bytes), { status: 200, headers: { ...base, 'Content-Length': String(size) } })
})

// HTML attachments (agent-made pages) run script, but in an opaque origin: no cookies, no same-origin access (5.4).
routes.get('/media/:id/page', requireSession, (c) => {
  const id = c.req.param('id')
  if (!MediaId.safeParse(id).success) return c.json({ error: 'not_found' }, 404, { 'Cache-Control': 'no-store' })
  const r = rt(c)
  const row = r.store.getMediaRow(id)
  // An MCP app page is only ever served by /media/:id/app, under the policy its approval pinned. This route's policy
  // allows any inline script, so serving an app page here would void the approval.
  if (row?.mime !== 'text/html' || row.app_csp)
    return c.json({ error: 'not_found' }, 404, { 'Cache-Control': 'no-store' })
  const data = row.evicted ? null : r.media.read(id)
  if (!data) return c.json({ error: 'gone', rehydrate: true }, 410, mediaHeaders({}))
  return new Response(asBody(data.bytes), {
    status: 200,
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Content-Security-Policy': PAGE_CSP,
      'X-Content-Type-Options': 'nosniff',
      'Cross-Origin-Resource-Policy': 'same-origin',
      'Cache-Control': 'private, no-store',
    },
  })
})

// An MCP app view's page (spec M3.5). Hostile by default: an opaque origin (`sandbox` without allow-same-origin), script
// only by the hashes the owner approved, no network except the approved domains, no powerful features. 404 unless the
// bridge uploaded it as an app page (text/html AND an approved CSP); 410 + rehydrate like /page.
routes.get('/media/:id/app', requireSession, (c) => {
  const id = c.req.param('id')
  if (!MediaId.safeParse(id).success) return c.json({ error: 'not_found' }, 404, { 'Cache-Control': 'no-store' })
  const r = rt(c)
  const row = r.store.getMediaRow(id)
  if (row?.mime !== 'text/html' || !row.app_csp)
    return c.json({ error: 'not_found' }, 404, { 'Cache-Control': 'no-store' })
  let policy: string
  try {
    policy = buildAppCsp(row.app_csp)
  } catch {
    return c.json({ error: 'not_found' }, 404, { 'Cache-Control': 'no-store' }) // fail closed: a policy that will not build is no policy
  }
  const data = row.evicted ? null : r.media.read(id)
  if (!data) return c.json({ error: 'gone', rehydrate: true }, 410, mediaHeaders({}))
  return new Response(asBody(data.bytes), {
    status: 200,
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Content-Security-Policy': `sandbox allow-scripts; ${policy}`,
      'Permissions-Policy': APP_PERMISSIONS_POLICY,
      'Referrer-Policy': 'no-referrer',
      'X-Content-Type-Options': 'nosniff',
      'Cross-Origin-Resource-Policy': 'same-origin',
      'Cache-Control': 'private, no-store',
    },
  })
})

// ---- bridge HTTP (Authorization: TalosBridge ...) ----------------------------------------------------------------

type Authed = { keyId: string; body: Uint8Array }

async function bridgeAuth(c: Context<AppEnv>, maxBytes: number): Promise<Authed | Response> {
  // Header first: a caller who names no trusted key, or a stale time, is turned away before one body byte is read.
  const pre = preflightBridgeHttp(c)
  if (!pre.ok) return c.json({ error: 'unauthorized' }, 401)
  const declaredHeader = c.req.header('content-length')
  const declared = declaredHeader === undefined ? undefined : Number(declaredHeader)
  if (declared !== undefined && declared > maxBytes) return c.json({ error: 'too_large' }, 413)
  // Only a method that carries a body has anything to hold. A GET reads nothing, so it never waits on the gate.
  const hasBody = c.req.method !== 'GET' && c.req.method !== 'HEAD'
  // The signature covers sha256(body). A request that carries that hash (the Mac sends `x-talos-sha256` with every
  // upload) is proven before a body byte is read; the body is then checked against the hash it was signed with. A
  // stranger with a junk signature is turned away here and never occupies a slot. No hash (an older peer, a frame post)
  // = the old path: read first, check after, with only a few such reads in flight.
  const claimed = c.req.header('x-talos-sha256')?.trim().toLowerCase()
  let provenHash: string | null = null
  let provenKey = ''
  if (hasBody && claimed && /^[0-9a-f]{64}$/.test(claimed)) {
    const early = verifyBridgeHttpHash(c, claimed)
    if (early) {
      const proof = await early
      if (!proof.ok) return c.json({ error: 'unauthorized' }, 401)
      provenHash = claimed
      provenKey = proof.keyId
    }
  }
  let release: (() => void) | null = () => undefined
  if (hasBody && !provenHash && !(declared !== undefined && declared <= SMALL_BODY_BYTES)) {
    const services = c.get('services')
    release = (maxBytes > MAX_FRAME_BYTES ? uploadGate(services) : frameGate(services)).enter(ipOf(c))
  }
  if (!release) return c.json({ error: 'rate_limited' }, 429, { 'Retry-After': '5' })
  try {
    // Stops waiting when the request's 408 deadline fires, so the `finally` below always runs and the slot comes back.
    const read = await readBodyWithDeadline(c, maxBytes)
    if (!read.ok)
      return read.why === 'timeout' ? c.json({ error: 'request_timeout' }, 408) : c.json({ error: 'too_large' }, 413)
    const body = read.body
    if (provenHash) {
      // Signed over `provenHash`; a body with any other hash is not what the Mac signed.
      if (sha256Hex(body) !== provenHash) return c.json({ error: 'unauthorized' }, 401)
      return { keyId: provenKey, body }
    }
    const res = await verifyBridgeHttp(c, body)
    if (!res.ok) return c.json({ error: 'unauthorized' }, 401)
    return { keyId: res.keyId, body }
  } finally {
    release()
  }
}

routes.post('/bridge/post', ...frameBodyGuard, async (c) => {
  const auth = await bridgeAuth(c, MAX_FRAME_BYTES)
  if (auth instanceof Response) return auth
  if (lateRequest(c)) return c.json({ error: 'request_timeout' }, 408)
  let raw: unknown
  try {
    raw = JSON.parse(new TextDecoder().decode(auth.body))
  } catch {
    return c.json({ error: 'bad_frame' }, 400)
  }
  // Only reply, card.create, thread.upsert and inbox.update are accepted here (spec 3.8).
  if (!protocolRoutes.bridgePost.req.safeParse(raw).success) return c.json({ error: 'bad_frame' }, 400)
  const parsed = parseFrame(raw, { direction: 'bridge_to_relay' })
  if (!parsed.ok) return c.json({ error: parsed.code }, 400)
  const hub = rt(c).hub
  try {
    const { seq, duplicate } = hub.processBridgeDurable(parsed.frame, raw as Record<string, unknown>)
    if (!duplicate) await hub.runBridgeHandlers(auth.keyId, parsed.frame as Frame, raw as Record<string, unknown>)
    return c.json({ ack: { ref: parsed.frame.id, seq } })
  } catch (e) {
    if (e instanceof FrameRejected) return c.json({ error: e.code, message: e.message }, 400)
    throw e
  }
})

const BridgeMediaId = z.string().regex(/^md_[0-9A-HJKMNP-TV-Z]{26}$/)

routes.put('/bridge/media/:id', ...bridgeMediaBodyGuard, async (c) => {
  const auth = await bridgeAuth(c, maxMediaBytes(c))
  if (auth instanceof Response) return auth
  if (lateRequest(c)) return c.json({ error: 'request_timeout' }, 408)
  const id = c.req.param('id')
  if (!BridgeMediaId.safeParse(id).success) return c.json({ error: 'bad_request' }, 400)
  if (auth.body.length === 0) return c.json({ error: 'bad_request' }, 400)
  const sha = sha256Hex(auth.body)
  const claimed = c.req.header('x-talos-sha256')
  if (claimed && claimed.toLowerCase() !== sha) return c.json({ error: 'sha256 mismatch' }, 400)
  const r = rt(c)
  // An MCP app page carries the CSP the owner approved. A bad or relay-covering header, a body that is not HTML, or one
  // over 8 MiB is refused before anything is stored; no header = an ordinary file (and a re-upload clears an old policy).
  let appCsp: AppCspT | undefined
  if (c.req.raw.headers.has(APP_CSP_HEADER)) {
    const decoded = decodeAppCspHeader(c.req.header(APP_CSP_HEADER), c.get('services').env.PUBLIC_ORIGIN)
    if (!decoded.ok) return c.json({ error: 'bad_app_csp', message: decoded.reason }, 400)
    if (sniffMime(auth.body, c.req.header('content-type') ?? '') !== 'text/html')
      return c.json({ error: 'bad_app_csp', message: 'an app page must be HTML' }, 400)
    if (auth.body.length > APP_PAGE_MAX_BYTES) return c.json({ error: 'too_large' }, 413)
    appCsp = decoded.csp
  }
  const dur = Number(c.req.header('x-talos-duration-ms'))
  r.media.save({
    ...(appCsp ? { appCsp } : {}),
    id,
    bytes: auth.body,
    claimedMime: c.req.header('content-type') ?? '',
    name: decodeName(c.req.header('x-talos-name')),
    durationMs: Number.isFinite(dur) && dur > 0 ? Math.trunc(dur) : undefined,
    origin: 'bridge',
  })
  await r.hub.toApps({ type: 'media.ready', media_id: id })
  return c.json({ ok: true as const, media_id: id })
})

routes.get('/bridge/media/:id', async (c) => {
  const auth = await bridgeAuth(c, 0)
  if (auth instanceof Response) return auth
  const id = c.req.param('id')
  if (!BridgeMediaId.safeParse(id).success) return c.json({ error: 'bad_request' }, 400)
  const data = rt(c).media.read(id)
  if (!data) return c.json({ error: 'not_found' }, 404)
  return new Response(asBody(data.bytes), {
    status: 200,
    headers: {
      'Content-Type': 'application/octet-stream',
      'Content-Length': String(data.bytes.length),
      'X-Talos-Sha256': data.row.sha256,
      'X-Talos-Mime': data.row.mime,
      'X-Talos-Name': encodeURIComponent(data.row.name),
    },
  })
})

// ---- static web app, with SPA fallback --------------------------------------------------------------------------

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.txt': 'text/plain; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
}

function fileResponse(root: string, rel: string): Response | null {
  const abs = resolve(root, `.${sep}${normalize(rel).replace(/^([/\\]|\.\.[/\\]?)+/, '')}`)
  if (abs !== root && !abs.startsWith(root + sep)) return null
  try {
    if (!statSync(abs).isFile()) return null
    const ext = extname(abs).toLowerCase()
    // Source maps are built for a fixer to read a minified stack. They are never served: nobody needs them off this host.
    if (ext === '.map') return null
    const hashed = rel.startsWith('/assets/')
    return new Response(readFileSync(abs), {
      status: 200,
      headers: {
        'Content-Type': TYPES[ext] ?? 'application/octet-stream',
        'Cache-Control': hashed ? 'public, max-age=31536000, immutable' : 'no-cache',
      },
    })
  } catch {
    return null
  }
}

routes.get('*', async (c, next) => {
  const path = new URL(c.req.url).pathname
  const dir = findRuntime(c.get('services'))?.webDir
  if (RESERVED.test(path) || !dir) return next()
  const root = resolve(dir)
  const direct = path === '/' ? null : fileResponse(root, decodeURIComponentSafe(path))
  if (direct) return direct
  if (extname(path)) return c.json({ error: 'not_found' }, 404)
  return fileResponse(root, '/index.html') ?? next()
})

function decodeURIComponentSafe(p: string): string {
  try {
    return decodeURIComponent(p)
  } catch {
    return p
  }
}
