// APNs sender (IOS-SPEC WP-I5): token-based auth (an ES256 JWT signed with the `.p8` key), HTTP/2 to Apple, one request
// per device. The payload is built from the same fixed-phrase `PushPayloadT` the web push uses (`buildApnsBody`), so no
// message text, card title, sender or subject can reach it. Inert unless all four APNS_* variables are set.
//
// What this never does: log the key, the JWT, a device token or a response body. Logs carry the HTTP status and Apple's
// short `reason` code (letters only), the environment and nothing else.
import { createPrivateKey, type KeyObject, sign } from 'node:crypto'
import { type ClientHttp2Session, connect, constants as h2 } from 'node:http2'
import {
  type ApnsEnvT,
  attachSeal,
  buildApnsBody,
  type PushPayloadT,
  pushTtlSeconds,
  type SealEnvelopeT,
} from '@talos-app/protocol'
import type { Clock, Logger } from '../services.ts'

export type ApnsConfig = { keyId: string; teamId: string; keyP8: string; bundleId: string }

/**
 * The four APNS_* variables as a config, or null (push stays off). Never throws: a missing or malformed variable names
 * itself in one warn line (never its value) and the relay boots without native push (review H2).
 */
export function apnsConfigFromEnv(
  env: { APNS_KEY_ID?: string; APNS_TEAM_ID?: string; APNS_KEY_P8?: string; APNS_BUNDLE_ID?: string },
  log: Logger,
): ApnsConfig | null {
  const names = ['APNS_KEY_ID', 'APNS_TEAM_ID', 'APNS_KEY_P8', 'APNS_BUNDLE_ID'] as const
  const set = names.filter((k) => env[k])
  if (set.length === 0) return null
  const bad: string[] = names.filter((k) => !env[k]).map((k) => `${k} (missing)`)
  if (env.APNS_KEY_ID && !/^[A-Z0-9]{10}$/.test(env.APNS_KEY_ID))
    bad.push('APNS_KEY_ID (not 10 capital letters/digits)')
  if (env.APNS_TEAM_ID && !/^[A-Z0-9]{10}$/.test(env.APNS_TEAM_ID))
    bad.push('APNS_TEAM_ID (not 10 capital letters/digits)')
  if (env.APNS_BUNDLE_ID && !/^[A-Za-z0-9.-]{3,155}$/.test(env.APNS_BUNDLE_ID))
    bad.push('APNS_BUNDLE_ID (not a bundle id)')
  if (bad.length) {
    log.warn({ variables: bad }, 'APNS_* is incomplete or malformed: native push stays off')
    return null
  }
  return {
    keyId: env.APNS_KEY_ID as string,
    teamId: env.APNS_TEAM_ID as string,
    keyP8: env.APNS_KEY_P8 as string,
    bundleId: env.APNS_BUNDLE_ID as string,
  }
}
export type ApnsSendResult = {
  ok: boolean
  gone: boolean
  status?: number
  reason?: string
  /** True when the gate said the device is no longer trusted: nothing was sent, and nothing was attempted. */
  skipped?: boolean
}

/**
 * Asked right before each request leaves, including the one repeated after an expired provider token. 'seal' sends the
 * sealed body, 'template' the fixed phrase alone, 'none' sends nothing. It may throw: that is a failed send, not a skip.
 */
export type SendGate = () => 'seal' | 'template' | 'none'

export interface ApnsSender {
  send(
    device: { token: string; env: ApnsEnvT },
    payload: PushPayloadT,
    opts?: { timeoutMs?: number; secondsLeft?: number; seal?: SealEnvelopeT; openOnly?: boolean; gate?: SendGate },
  ): Promise<ApnsSendResult>
  close(): void
}

export const APNS_HOSTS: Record<ApnsEnvT, string> = {
  sandbox: 'https://api.sandbox.push.apple.com',
  production: 'https://api.push.apple.com',
}

/** Apple wants a provider token refreshed at most every 20 minutes and at least every 60. */
export const JWT_REFRESH_MS = 50 * 60_000
const JWT_MIN_REFRESH_MS = 20 * 60_000
const REQUEST_TIMEOUT_MS = 10_000
/** Apple refuses a regular alert body over 4 KiB; stay a little under. */
export const APNS_MAX_BODY_BYTES = 3900
/** A connection idle this long is PINGed before reuse: a dropped NAT entry gives no FIN or RST (review H3). */
const IDLE_PING_MS = 30_000
const PING_TIMEOUT_MS = 3_000

const b64u = (b: Buffer | string) => Buffer.from(b).toString('base64url')

/** Accepts a PEM, a PEM pasted with literal `\n` sequences (one-line env var), or the bare base64 body of the `.p8`. */
export function parseP8(raw: string): KeyObject | null {
  try {
    let pem = raw.trim().replace(/\\n/g, '\n')
    if (!pem.includes('-----BEGIN')) pem = `-----BEGIN PRIVATE KEY-----\n${pem}\n-----END PRIVATE KEY-----`
    const key = createPrivateKey({ key: pem, format: 'pem' })
    if (key.asymmetricKeyType !== 'ec' || key.asymmetricKeyDetails?.namedCurve !== 'prime256v1') return null
    return key
  } catch {
    return null
  }
}

export type ApnsOptions = {
  config: ApnsConfig
  clock: Clock
  log: Logger
  /** Tests point this at a local HTTP/2 server. Default: Apple's hosts, chosen by the device's environment. */
  authority?: (env: ApnsEnvT) => string
  timeoutMs?: number
}

/** Returns null (and logs why, without the key) when the key does not parse: push stays inert instead of crashing boot. */
export function createApnsSender(o: ApnsOptions): ApnsSender | null {
  const key = parseP8(o.config.keyP8)
  if (!key) {
    o.log.error({}, 'apns key is not an ES256 .p8: native push stays off')
    return null
  }
  const authorityOf = o.authority ?? ((env: ApnsEnvT) => APNS_HOSTS[env])
  const defaultTimeoutMs = o.timeoutMs ?? REQUEST_TIMEOUT_MS
  const sessions = new Map<string, ClientHttp2Session>()
  const lastUse = new Map<string, number>()
  let jwt: { value: string; at: number } | null = null

  /** One token for 50 minutes. A clock that stepped backwards (token issued "in the future") makes a fresh one. */
  const token = (force = false): string => {
    const now = o.clock.now()
    const stale = !jwt || now - jwt.at >= JWT_REFRESH_MS || now < jwt.at
    if (stale || (force && jwt && now - jwt.at >= JWT_MIN_REFRESH_MS)) {
      const head = b64u(JSON.stringify({ alg: 'ES256', kid: o.config.keyId }))
      const body = b64u(JSON.stringify({ iss: o.config.teamId, iat: Math.floor(now / 1000) }))
      const sig = sign('sha256', Buffer.from(`${head}.${body}`), { key, dsaEncoding: 'ieee-p1363' })
      jwt = { value: `${head}.${body}.${b64u(sig)}`, at: now }
    }
    return (jwt as { value: string }).value
  }

  /**
   * Destroys `s`, and forgets it only if it is still the connection for `authority`. A send that failed on an old connection
   * must never take down the replacement a faster send already opened (review R5).
   */
  const dropSession = (authority: string, s: ClientHttp2Session) => {
    if (sessions.get(authority) === s) {
      sessions.delete(authority)
      lastUse.delete(authority)
    }
    s.destroy()
  }

  /** One PING in flight per connection: every send that finds it idle waits on the same answer. */
  const pings = new WeakMap<ClientHttp2Session, Promise<boolean>>()
  /** True when the connection answers a PING; a half-dead one (no FIN, no RST) never does. */
  const alive = (s: ClientHttp2Session): Promise<boolean> => {
    const running = pings.get(s)
    if (running) return running
    const p = new Promise<boolean>((resolve) => {
      const t = setTimeout(() => resolve(false), PING_TIMEOUT_MS)
      try {
        s.ping((err) => {
          clearTimeout(t)
          resolve(!err)
        })
      } catch {
        clearTimeout(t)
        resolve(false)
      }
    }).finally(() => pings.delete(s))
    pings.set(s, p)
    return p
  }

  const usable = (s: ClientHttp2Session | undefined): s is ClientHttp2Session => Boolean(s && !s.closed && !s.destroyed)

  const sessionFor = async (authority: string): Promise<ClientHttp2Session> => {
    const have = sessions.get(authority)
    if (usable(have)) {
      if (Date.now() - (lastUse.get(authority) ?? 0) < IDLE_PING_MS || (await alive(have))) {
        lastUse.set(authority, Date.now())
        return have
      }
      dropSession(authority, have)
    }
    // Another send may have replaced the dead connection while this one waited on the PING: join that one.
    const current = sessions.get(authority)
    if (usable(current) && current !== have) return current
    const s = connect(authority)
    lastUse.set(authority, Date.now())
    const drop = () => {
      if (sessions.get(authority) === s) sessions.delete(authority)
    }
    s.on('error', () => {
      drop()
      s.destroy()
    })
    s.on('close', drop)
    s.on('goaway', () => {
      drop()
      s.close()
    })
    s.unref()
    sessions.set(authority, s)
    return s
  }

  /**
   * Resolves when the connection (TCP, and TLS for Apple) is up; rejects if it fails, closes, or takes longer than
   * `timeoutMs`. The gate must run after this: a request queued behind a handshake leaves whenever the handshake ends, so
   * a look taken earlier is not the last one.
   */
  const connected = (s: ClientHttp2Session, timeoutMs: number): Promise<void> =>
    new Promise<void>((resolve, reject) => {
      if (s.destroyed || s.closed) return reject(new Error('closed'))
      if (!s.connecting) return resolve()
      const finish = (err?: Error) => {
        clearTimeout(t)
        s.off('connect', onUp)
        s.off('error', onDown)
        s.off('close', onDown)
        if (err) reject(err)
        else resolve()
      }
      const onUp = () => finish()
      const onDown = () => finish(new Error('closed'))
      const t = setTimeout(() => finish(new Error('connect timeout')), timeoutMs)
      s.once('connect', onUp)
      s.once('error', onDown)
      s.once('close', onDown)
    })

  const once = async (
    device: { token: string; env: ApnsEnvT },
    bodies: { sealed: string | null; plain: string },
    gate: SendGate | undefined,
    collapse: string | undefined,
    ttlS: number,
    jwtValue: string,
    timeoutMs: number,
  ): Promise<{ status: number; reason?: string; skipped?: true }> => {
    const authority = authorityOf(device.env)
    let session: ClientHttp2Session
    try {
      session = await sessionFor(authority)
      await connected(session, timeoutMs)
    } catch {
      // A connection that did not come up in time is replaced by the next send, not waited on again.
      const stuck = sessions.get(authority)
      if (stuck?.connecting) dropSession(authority, stuck)
      return { status: 0, reason: 'ConnectionError' }
    }
    return new Promise<{ status: number; reason?: string; skipped?: true }>((resolve) => {
      let settled = false
      const done = (r: { status: number; reason?: string; skipped?: true }) => {
        if (settled) return
        settled = true
        resolve(r)
      }
      try {
        // The last look before the bytes leave: the PING wait above can be seconds long, and a revoke can land in it.
        let pick: 'seal' | 'template' | 'none' = 'seal'
        if (gate) {
          try {
            pick = gate()
          } catch {
            return done({ status: 0, reason: 'RecheckFailed' })
          }
        }
        if (pick === 'none') return done({ status: 0, reason: 'NotTrusted', skipped: true })
        const body = pick === 'seal' && bodies.sealed ? bodies.sealed : bodies.plain
        const headers: Record<string, string | number> = {
          [h2.HTTP2_HEADER_METHOD]: 'POST',
          [h2.HTTP2_HEADER_PATH]: `/3/device/${device.token}`,
          authorization: `bearer ${jwtValue}`,
          'apns-topic': o.config.bundleId,
          'apns-push-type': 'alert',
          'apns-priority': '10',
          'apns-expiration': Math.floor(o.clock.now() / 1000) + ttlS,
          'content-type': 'application/json',
        }
        if (collapse && Buffer.byteLength(collapse) <= 64) headers['apns-collapse-id'] = collapse
        const req = session.request(headers)
        let status = 0
        let text = ''
        req.setEncoding('utf8')
        req.on('response', (h) => {
          status = Number(h[h2.HTTP2_HEADER_STATUS] ?? 0)
        })
        req.on('data', (c: string) => {
          if (text.length < 2048) text += c
        })
        req.on('end', () => {
          let reason: string | undefined
          try {
            const r = (JSON.parse(text) as { reason?: unknown }).reason
            if (typeof r === 'string' && /^[A-Za-z]{1,40}$/.test(r)) reason = r
          } catch {
            /* an empty body on 200 */
          }
          done({ status, ...(reason ? { reason } : {}) })
        })
        req.on('error', () => done({ status: 0, reason: 'ConnectionError' }))
        req.setTimeout(timeoutMs, () => {
          // Silence for this long means the connection may be dead, not just this request: replace it (review H3).
          done({ status: 0, reason: 'Timeout' })
          dropSession(authority, session)
        })
        req.end(body)
      } catch {
        done({ status: 0, reason: 'ConnectionError' })
      }
    })
  }

  return {
    async send(device, payload, opts) {
      const timeoutMs = opts?.timeoutMs ?? defaultTimeoutMs
      const shape = { openOnly: opts?.openOnly === true }
      const plain = JSON.stringify(buildApnsBody(payload, shape))
      // A sealed push is the same fixed alert plus the seal. If the seal would push it past what Apple accepts, it goes
      // as the plain template (the owner still hears about it; only the text is missing).
      const sealed = opts?.seal ? JSON.stringify(attachSeal(buildApnsBody(payload, shape), opts.seal)) : null
      const bodies = { sealed: sealed && Buffer.byteLength(sealed) <= APNS_MAX_BODY_BYTES ? sealed : null, plain }
      const collapse = payload.notification.tag
      const ttlS = pushTtlSeconds(payload, opts?.secondsLeft)
      const gate = opts?.gate
      let r = await once(device, bodies, gate, collapse, ttlS, token(), timeoutMs)
      if (r.status === 403 && r.reason === 'ExpiredProviderToken')
        r = await once(device, bodies, gate, collapse, ttlS, token(true), timeoutMs)
      if (r.skipped) return { ok: false, gone: false, status: 0, reason: r.reason ?? 'NotTrusted', skipped: true }
      const gone = r.status === 410
      const ok = r.status === 200
      if (!ok) o.log.warn({ status: r.status, reason: r.reason ?? null, env: device.env, gone }, 'apns send failed')
      return { ok, gone, status: r.status, ...(r.reason ? { reason: r.reason } : {}) }
    },
    close() {
      for (const s of sessions.values()) s.destroy()
      sessions.clear()
      lastUse.clear()
    },
  }
}
