// In-app bug reports, relay side. One route, `POST /api/bug-reports`: the page signs the whole report (text and picture) with
// the device key, exactly like `native.grant`, and this file checks the same things that route does (a session whose pinned
// device signed it, fresh, single use) before it stores anything. The report is kept 90 days as two encrypted files, then the
// sweeper removes it. When the owner set `bug_webhook_url` (Mac only) and the relay has `BUG_WEBHOOK_SECRET`, one signed
// Standard Webhooks call tells that URL about it. Without an address of the owner's own, the Talos team's inbox this relay was
// deployed with (`BUG_TEAM_INBOX_URL`) is used the same way, and that call carries the picture too (core/bug-inbox.ts is the
// other end); otherwise nothing leaves this relay.
import { createHmac } from 'node:crypto'
import dns from 'node:dns'
import { existsSync, mkdirSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import http from 'node:http'
import https from 'node:https'
import { join } from 'node:path'
import {
  APNS_REGISTRATION_SKEW_MS,
  BUG_REPORT_LIMITS,
  BUG_REPORTED_EVENT,
  type BugReportDestinationT,
  BugReportPost,
  type BugReportPostT,
  type BugReportWebhookT,
  bugWebhookUrlOk,
  eventInfo,
  isBlockedAddress,
  redactReport,
  shownWebhookHost,
  verifyOwnerFrame,
} from '@talos-app/protocol'
import type Database from 'better-sqlite3'
import { Hono } from 'hono'
import { getSession, requireCsrf, requireSession, takeRate } from '../auth/contract.ts'
import type { AppEnv, Clock, CryptoService, Logger, RelayServices } from '../services.ts'
import { idleBodyTimeout, lateRequest, limitBody, readBodyWithDeadline } from './body-guard.ts'
import { sniffMime } from './sniff.ts'

const DAY_MS = 86_400_000
/** How long the webhook call may take before it is given up (one try, no retry). */
const BUG_WEBHOOK_TIMEOUT_MS = 10_000

// ---- storage ----------------------------------------------------------------------------------------------------------

type Deps = { db: Database.Database; crypto: CryptoService; clock: Clock; dataDir: string }
const dirOf = (dataDir: string) => join(dataDir, 'bug-reports')
const jsonPath = (d: Deps, id: string) => join(dirOf(d.dataDir), `${id}.json.bin`)
const imgPath = (d: Deps, id: string) => join(dirOf(d.dataDir), `${id}.img.bin`)

function writeAtomic(path: string, bytes: Uint8Array): void {
  const tmp = `${path}.tmp`
  writeFileSync(tmp, bytes, { mode: 0o600 })
  renameSync(tmp, path)
}

export function reportExists(d: Pick<Deps, 'db'>, id: string): boolean {
  return d.db.prepare('select 1 from core_bug_reports where report_id = ?').get(id) !== undefined
}

/** Bytes all kept reports use (the picture and the JSON, as stored). */
export function bugReportBytes(d: Pick<Deps, 'db'>): number {
  const r = d.db.prepare('select coalesce(sum(image_bytes + json_bytes), 0) as n from core_bug_reports').get() as {
    n: number
  }
  return r.n
}

/** A nonce that was already used: the report is not stored. */
class Replayed extends Error {}

/**
 * Stores one verified report: the files first, then the nonce and the row in ONE transaction. A failure after the files (the
 * database, a second use of the nonce) removes them again and burns nothing, so a retry after a 500 stores the report instead of
 * meeting a used nonce. Throws `Replayed` for a nonce seen before.
 */
export function storeBugReport(d: Deps, post: BugReportPostT, image: Uint8Array, nonceExpiresAt: number): void {
  mkdirSync(dirOf(d.dataDir), { recursive: true, mode: 0o700 })
  const { osig: _sig, image_b64: _img, ...meta } = post
  const json = new TextEncoder().encode(JSON.stringify(meta))
  writeAtomic(jsonPath(d, post.id), d.crypto.encrypt(json, `bug:${post.id}:json`))
  writeAtomic(imgPath(d, post.id), d.crypto.encrypt(image, `bug:${post.id}:img`))
  try {
    d.db.transaction(() => {
      const now = d.clock.now()
      d.db.prepare('delete from core_push_nonces where expires_at <= ?').run(now)
      const burned = d.db
        .prepare('insert or ignore into core_push_nonces (nonce_key, expires_at) values (?, ?)')
        .run(`bug:${post.device_id}:${post.nonce}`, nonceExpiresAt)
      if (burned.changes === 0) throw new Replayed()
      d.db
        .prepare(
          'insert into core_bug_reports (report_id, device_id, created_at, image_type, image_bytes, json_bytes) values (?, ?, ?, ?, ?, ?)',
        )
        .run(post.id, post.device_id, now, post.image_type, image.length, json.length)
    })()
  } catch (e) {
    rmSync(jsonPath(d, post.id), { force: true })
    rmSync(imgPath(d, post.id), { force: true })
    throw e
  }
}

/** Deletes every report older than the retention (90 days), files and rows. Returns how many went. */
export function sweepBugReports(d: Deps): number {
  const cutoff = d.clock.now() - BUG_REPORT_LIMITS.retentionDays * DAY_MS
  const old = d.db.prepare('select report_id from core_bug_reports where created_at < ?').all(cutoff) as Array<{
    report_id: string
  }>
  for (const { report_id: id } of old) {
    rmSync(jsonPath(d, id), { force: true })
    rmSync(imgPath(d, id), { force: true })
    d.db.prepare('delete from core_bug_reports where report_id = ?').run(id)
  }
  // A file whose row never got written (a crash between the two steps) is not kept either.
  const dir = dirOf(d.dataDir)
  if (existsSync(dir)) {
    for (const f of readdirSync(dir)) {
      const id = f.split('.')[0] ?? ''
      if (!reportExists(d, id)) rmSync(join(dir, f), { force: true })
    }
  }
  return old.length
}

// ---- the named event ----------------------------------------------------------------------------------------------------

/** One `event` log line for a registered event whose fields fit its payload; a refused one is dropped with a warning (never the values). */
function emitRelayEvent(log: Pick<Logger, 'info' | 'warn'>, name: string, fields: Record<string, unknown>): boolean {
  const info = eventInfo(name)
  if (!info?.payload.safeParse(fields).success) {
    log.warn({ event: name }, 'event dropped')
    return false
  }
  log.info({ event: name, ...fields }, 'event')
  return true
}

// ---- the webhook (Standard Webhooks, https://www.standardwebhooks.com) ---------------------------------------------------

/**
 * `webhook-signature` for a delivery: `v1,` + base64(HMAC-SHA256(key, "<id>.<timestamp>.<body>")), where the key is the
 * base64 part of the `whsec_` secret and the timestamp is whole seconds.
 */
export function standardWebhookSignature(secret: string, id: string, timestampS: number, body: string): string {
  const key = Buffer.from(secret.replace(/^whsec_/, ''), 'base64')
  return `v1,${createHmac('sha256', key).update(`${id}.${timestampS}.${body}`).digest('base64')}`
}

/** The three headers a receiver verifies. */
function standardWebhookHeaders(secret: string, id: string, timestampS: number, body: string) {
  return {
    'content-type': 'application/json',
    'webhook-id': id,
    'webhook-timestamp': String(timestampS),
    'webhook-signature': standardWebhookSignature(secret, id, timestampS, body),
  }
}

// ---- where the webhook may go -------------------------------------------------------------------------------------------

/**
 * True for an address the webhook must not reach: anything that is not a public unicast address. This is the one list all
 * of Talos uses for a URL someone else influences (`isBlockedAddress`, packages/protocol/src/address.ts), so it also covers
 * the IPv6 forms that carry an IPv4 address (mapped, NAT64, 6to4, Teredo) and the reserved ranges a shorter list forgets.
 */
export function isPrivateAddress(ip: string): boolean {
  return isBlockedAddress(ip)
}

/**
 * The webhook URL if it is allowed, else null: https only, no `user:pass@`, no `localhost`, `*.localhost`, `*.internal` or `*.local`
 * name, no single-label name, and no IP literal outside the public internet. `allowLocal` (tests only) lifts all of that. The address a name RESOLVES to is checked
 * again when the connection is made (`pinnedLookup`), so a name that points inward is refused too.
 */
export function checkWebhookUrl(raw: string, allowLocal = false): URL | null {
  let u: URL
  try {
    u = new URL(raw)
  } catch {
    return null
  }
  if (allowLocal) return u.protocol === 'https:' || u.protocol === 'http:' ? u : null
  // A blocked IP literal, a number-shaped host a resolver might read as one, and names that are never public (a trailing
  // dot does not hide one: `localhost.` is `localhost`): the protocol's rule, which the app's Settings use too.
  return bugWebhookUrlOk(raw)
}

/** `dns.lookup` for the connection: refuses a name that resolves to a private address (DNS rebinding), and connects to the checked address. */
export function pinnedLookup(allowLocal: boolean) {
  return (
    host: string,
    opts: dns.LookupOptions,
    cb: (err: Error | null, address: string | dns.LookupAddress[], family?: number) => void,
  ) => {
    dns.lookup(host, { ...opts, all: true }, (err, addrs) => {
      if (err) return cb(err, '', 0)
      const list = addrs as dns.LookupAddress[]
      if (list.length === 0 || (!allowLocal && list.some((a) => isPrivateAddress(a.address))))
        return cb(new Error('webhook address refused'), '', 0)
      if (opts.all) return cb(null, list)
      const first = list[0] as dns.LookupAddress
      cb(null, first.address, first.family)
    })
  }
}

/**
 * Where the webhook goes, or null when it is off. The owner's own `bug_webhook_url` (set at the Mac or in Settings) comes first;
 * without one, the Talos team's inbox this relay was deployed with (`BUG_TEAM_INBOX_URL`). Either needs `BUG_WEBHOOK_SECRET`,
 * and an address the webhook may reach. `quiet` leaves out the warning (the reporter asks this on every open).
 */
export function bugWebhookTarget(
  services: RelayServices,
  quiet = false,
): { url: URL; secret: string; team: boolean } | null {
  const own = services.agentConfig()?.bug_webhook_url
  const raw = own ?? services.env.BUG_TEAM_INBOX_URL
  const secret = services.env.BUG_WEBHOOK_SECRET
  if (!raw || !secret) return null
  const url = checkWebhookUrl(raw, services.env.NODE_ENV === 'test')
  if (!url) {
    if (!quiet) services.log.warn({}, 'bug report webhook URL refused (https, public address, no user:pass@)')
    return null
  }
  return { url, secret, team: own === undefined }
}

/** What the reporter says about where a report goes: the same answer `bugWebhookTarget` gives the send. */
export function bugReportDestination(services: RelayServices): BugReportDestinationT {
  const t = bugWebhookTarget(services, true)
  if (!t) return { to: 'relay' }
  return t.team ? { to: 'team' } : { to: 'webhook', host: shownWebhookHost(t.url.hostname) }
}

async function sendWebhook(
  services: RelayServices,
  target: { url: URL; secret: string; team: boolean },
  post: BugReportPostT,
  imageBytes: number,
) {
  const now = services.clock.now()
  const payload: BugReportWebhookT = {
    type: 'bug.reported',
    timestamp: new Date(now).toISOString(),
    // the report's text through `talos-app report`'s redaction once more before it leaves the relay
    data: {
      id: post.id,
      device_id: post.device_id,
      image_bytes: imageBytes,
      report: redactReport(post.report),
      // The Talos team's inbox gets the marked-up picture too, inside the one signed body (it checks the bytes again). An
      // address the owner set gets the text only, as it always has.
      ...(target.team ? { image: { type: post.image_type, b64: post.image_b64 } } : {}),
    },
  }
  const body = JSON.stringify(payload)
  const allowLocal = services.env.NODE_ENV === 'test'
  const send = target.url.protocol === 'https:' ? https.request : http.request
  try {
    const status = await new Promise<number>((resolve, reject) => {
      // No redirect is followed (http/https.request never does): the owner named this URL, not whatever it points at.
      const req = send(
        target.url,
        {
          method: 'POST',
          headers: {
            ...standardWebhookHeaders(target.secret, `msg_${post.id}`, Math.floor(now / 1000), body),
            'content-length': Buffer.byteLength(body),
          },
          lookup: pinnedLookup(allowLocal) as never,
          timeout: BUG_WEBHOOK_TIMEOUT_MS,
        },
        (res) => {
          // only the status matters: the answer is not read, and the connection is closed at once (a receiver that
          // trickles a body forever does not hold it)
          clearTimeout(whole)
          resolve(res.statusCode ?? 0)
          res.destroy()
        },
      )
      // `timeout` is an idle limit only: a receiver that sends a byte every few seconds would never trip it. This is the
      // limit for the whole exchange, connect to status line.
      const whole = setTimeout(() => req.destroy(new Error('timeout')), BUG_WEBHOOK_TIMEOUT_MS)
      req.on('timeout', () => req.destroy(new Error('timeout')))
      req.on('error', (e) => {
        clearTimeout(whole)
        reject(e)
      })
      req.end(body)
    })
    // a refusal is not a delivery: a wrong secret (401), an inbox that is off (404) or busy (429), a redeploy (502) all say
    // so in the log; 409 is the inbox saying it already has this report
    if ((status >= 200 && status < 300) || (target.team && status === 409))
      services.log.info({ report_id: post.id, status }, 'bug report webhook sent')
    else services.log.warn({ report_id: post.id, status }, 'bug report webhook refused')
  } catch (e) {
    services.log.warn(
      { report_id: post.id, err: e instanceof Error ? e.message.slice(0, 60) : 'error' },
      'bug report webhook failed',
    )
  }
}

// ---- the route ----------------------------------------------------------------------------------------------------------

export const bugReportRoutes = new Hono<AppEnv>()

// Where a report goes, for the reporter's "Goes to" line. The answer names a host at most, never the address.
bugReportRoutes.get('/api/bug-reports/destination', requireSession, (c) =>
  c.json(bugReportDestination(c.get('services'))),
)

bugReportRoutes.post(
  '/api/bug-reports',
  limitBody(() => BUG_REPORT_LIMITS.bodyBytes),
  idleBodyTimeout(undefined, undefined, { stopWhenBodyIn: true }),
  requireSession,
  requireCsrf,
  async (c) => {
    const services = c.get('services')
    const read = await readBodyWithDeadline(c, BUG_REPORT_LIMITS.bodyBytes)
    if (lateRequest(c)) return c.json({ error: 'request_timeout' }, 408)
    if (!read.ok)
      return read.why === 'timeout' ? c.json({ error: 'request_timeout' }, 408) : c.json({ error: 'too_large' }, 413)
    let raw: unknown
    try {
      raw = JSON.parse(new TextDecoder().decode(read.body))
    } catch {
      return c.json({ error: 'bad_request' }, 400)
    }
    const parsed = BugReportPost.safeParse(raw)
    if (!parsed.success) return c.json({ error: 'bad_request' }, 400)
    const post = parsed.data
    // Who: this session's own pinned, un-revoked device. A stranger, an unpinned browser and another paired phone all stop here.
    const session = getSession(c)
    if (!session?.deviceId || session.deviceId !== post.device_id) return c.json({ error: 'wrong_device' }, 403)
    const row = services.db
      .prepare('select pubkey_jwk from auth_devices where id = ? and pinned = 1 and revoked = 0')
      .get(post.device_id) as { pubkey_jwk: string } | undefined
    let jwk: unknown = null
    try {
      jwk = row ? JSON.parse(row.pubkey_jwk) : null
    } catch {
      jwk = null
    }
    if (!row || jwk === null || typeof jwk !== 'object') return c.json({ error: 'bad_signature' }, 401)
    if (!(await verifyOwnerFrame(raw as Record<string, unknown>, jwk as never)))
      return c.json({ error: 'bad_signature' }, 401)
    const now = services.clock.now()
    if (Math.abs(Date.parse(post.ts) - now) > APNS_REGISTRATION_SKEW_MS) return c.json({ error: 'stale' }, 400)
    // A retry of a report already stored (the answer was lost) is answered again, not stored twice.
    if (reportExists(services, post.id)) return c.json({ ok: true, id: post.id }, 200)
    const limit = takeRate(c, 'bug_report', post.device_id)
    if (!limit.ok)
      return c.json({ error: 'rate_limited', retry_after_s: limit.retryAfterS }, 429, {
        'Retry-After': String(limit.retryAfterS),
      })
    const image = Buffer.from(post.image_b64, 'base64')
    if (
      image.length === 0 ||
      image.length > BUG_REPORT_LIMITS.imageBytes ||
      image.toString('base64') !== post.image_b64
    )
      return c.json(
        { error: image.length > BUG_REPORT_LIMITS.imageBytes ? 'too_large' : 'bad_image' },
        image.length > BUG_REPORT_LIMITS.imageBytes ? 413 : 400,
      )
    if (sniffMime(image) !== post.image_type) return c.json({ error: 'bad_image' }, 400)
    // Room on the volume: all kept reports together stay under the cap, whatever is sent.
    const deps = { db: services.db, crypto: services.crypto, clock: services.clock, dataDir: services.env.DATA_DIR }
    if (bugReportBytes(deps) + read.body.length > services.env.BUG_REPORTS_MAX_MB * 1024 * 1024)
      return c.json({ error: 'storage_full', message: 'The relay has no room for more bug reports right now.' }, 507)
    try {
      storeBugReport(deps, post, image, now + 2 * APNS_REGISTRATION_SKEW_MS)
    } catch (e) {
      if (e instanceof Replayed) return c.json({ error: 'replay' }, 409)
      throw e
    }
    const target = bugWebhookTarget(services)
    emitRelayEvent(services.log, BUG_REPORTED_EVENT, {
      report_id: post.id,
      device_id: post.device_id,
      webhook: target ? 'queued' : 'off',
    })
    if (target) void sendWebhook(services, target, post, image.length)
    return c.json({ ok: true, id: post.id }, 201)
  },
)
