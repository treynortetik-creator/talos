// The bug inbox: `POST /api/bug-inbox`, on the Talos team's relay. Another person's relay (a beta install) sends its new bug
// reports here with the webhook it already has (bug-reports.ts, Standard Webhooks, pointed here by its BUG_TEAM_INBOX_URL).
// Each accepted report becomes ONE problem on this relay's Mac, through the same durable `problem.item` frame the owner's own
// problems take, marked `source: 'install'` with the install's name, so `talos-app errors list` shows it as theirs.
//
// Everything here is outside input. Off unless BUG_INBOX_SECRETS is set (then 404 and nothing read). The order of checks
// is the cheap ones first: the IP bucket, the headers and the timestamp, then the body (capped), then the signature
// against each install's own secret (which also says who sent it), then the shape, then the install's bucket, then a
// report id seen before. The text is scrubbed again here and on the Mac; the picture is checked by its bytes.
import { timingSafeEqual } from 'node:crypto'
import {
  BUG_INBOX_LIMITS,
  BUG_REPORT_LIMITS,
  BugInboxDelivery,
  type BugInboxDeliveryT,
  newUlid,
  Problem,
  type ProblemAttachedT,
  type ProblemT,
  problemFingerprint,
  scrubProblem,
} from '@talos-app/protocol'
import { Hono } from 'hono'
import { takeRate } from '../auth/contract.ts'
import type { RelayEnv } from '../env.ts'
import type { AppEnv, RelayServices } from '../services.ts'
import { idleBodyTimeout, lateRequest, limitBody, readBodyWithDeadline } from './body-guard.ts'
import { standardWebhookSignature } from './bug-reports.ts'
import { findRuntime } from './runtime.ts'
import { sniffMime } from './sniff.ts'

const DAY_MS = 86_400_000

type Install = { name: string; secret: string }

/**
 * The install whose secret signed `body`, or null. Every secret is tried (a list of a handful), and each signature in the
 * header is compared in constant time; `v1,` is the only scheme taken.
 */
export function signedBy(
  installs: readonly Install[],
  h: { id: string; timestamp: string; signature: string },
  body: string,
): Install | null {
  const given = h.signature
    .split(' ')
    .filter((s) => s.startsWith('v1,'))
    .map((s) => Buffer.from(s))
  let found: Install | null = null
  for (const i of installs) {
    const want = Buffer.from(standardWebhookSignature(i.secret, h.id, Number(h.timestamp), body))
    for (const g of given) if (g.length === want.length && timingSafeEqual(g, want) && !found) found = i
  }
  return found
}

/**
 * The problem a delivery becomes. What the person typed goes in full in `attached`, and its start is the problem's message
 * (what `errors list` shows); the error lines always go (scrubbed); the log, the messages and the thread go unless this
 * relay's switch leaves them out, and the messages only ever when the sender chose to attach them.
 */
export function problemFromDelivery(
  d: BugInboxDeliveryT,
  install: string,
  env: Pick<RelayEnv, 'BUG_INBOX_NO_LOGS' | 'BUG_INBOX_NO_MESSAGES' | 'BUG_INBOX_NO_THREAD'>,
  screenshot: ProblemT['screenshot'],
  now: number,
): ProblemT {
  const r = d.data.report
  const v = r.versions
  const attached: ProblemAttachedT = {
    what_went_wrong: r.what_went_wrong,
    ...(r.expected ? { expected: r.expected } : {}),
    errors: r.recent_errors,
    ...(!env.BUG_INBOX_NO_LOGS && r.logs ? { logs: r.logs } : {}),
    ...(!env.BUG_INBOX_NO_MESSAGES && r.messages?.length ? { messages: r.messages } : {}),
    ...(!env.BUG_INBOX_NO_THREAD && r.thread_id ? { thread_id: r.thread_id } : {}),
    ...(!env.BUG_INBOX_NO_THREAD && r.screen ? { screen: r.screen } : {}),
    ...(v.claude_code ? { claude_code: v.claude_code } : {}),
  }
  // the sender's own time for when it happened, unless it lies ahead of ours (the Mac clamps it too)
  const at = Date.parse(d.timestamp)
  const draft: ProblemT = {
    id: newUlid(),
    source: 'install',
    install,
    kind: 'owner',
    fingerprint: '0'.repeat(32),
    at: new Date(Number.isFinite(at) && at <= now ? at : now).toISOString(),
    name: 'bug report',
    message: r.what_went_wrong.slice(0, 300),
    frames: [],
    versions: {
      ...(v.app ? { app: v.app } : {}),
      ...(v.relay ? { relay: v.relay } : {}),
      ...(v.bridge ? { bridge: v.bridge } : {}),
    },
    // the reporter is the web page, whichever shell (a browser, the iPhone app) holds it
    device: 'browser',
    routes: [],
    truncated: false,
    ...(screenshot ? { screenshot } : {}),
    attached,
  }
  const clean = scrubProblem(draft)
  return Problem.parse({ ...clean, fingerprint: problemFingerprint(clean) })
}

/** A report id this inbox has taken from this install before: one problem per report, however often it is sent. */
class Seen extends Error {}

function burn(services: RelayServices, key: string, now: number): void {
  services.db.transaction(() => {
    services.db.prepare('delete from core_push_nonces where expires_at <= ?').run(now)
    const r = services.db
      .prepare('insert or ignore into core_push_nonces (nonce_key, expires_at) values (?, ?)')
      .run(key, now + BUG_REPORT_LIMITS.retentionDays * DAY_MS)
    if (r.changes === 0) throw new Seen()
  })()
}

const refuse = (why: string) => ({ error: why })

export const bugInboxRoutes = new Hono<AppEnv>()

bugInboxRoutes.post(
  '/api/bug-inbox',
  async (c, next) => {
    // Off by default: no secret, no inbox. Nothing is read and no bucket is touched.
    if (!c.get('services').env.BUG_INBOX_SECRETS) return c.json(refuse('not_found'), 404)
    return next()
  },
  async (c, next) => {
    // Per address, before a byte of the body: a stranger cannot make the relay read 8 MiB at will.
    const limit = takeRate(c, 'bug_inbox_ip')
    if (!limit.ok)
      return c.json({ error: 'rate_limited', retry_after_s: limit.retryAfterS }, 429, {
        'Retry-After': String(limit.retryAfterS),
      })
    return next()
  },
  limitBody(() => BUG_INBOX_LIMITS.bodyBytes),
  idleBodyTimeout(undefined, undefined, { stopWhenBodyIn: true }),
  async (c) => {
    const services = c.get('services')
    const installs = services.env.BUG_INBOX_SECRETS ?? []
    const h = {
      id: c.req.header('webhook-id') ?? '',
      timestamp: c.req.header('webhook-timestamp') ?? '',
      signature: c.req.header('webhook-signature') ?? '',
    }
    if (!/^[A-Za-z0-9_.-]{1,100}$/.test(h.id) || !/^\d{1,12}$/.test(h.timestamp) || !h.signature.includes('v1,'))
      return c.json(refuse('bad_signature'), 401)
    const now = services.clock.now()
    // a delivery from too long ago, or too far ahead, is a replay or a broken clock: refused before the body is read
    if (Math.abs(Number(h.timestamp) - Math.floor(now / 1000)) > BUG_INBOX_LIMITS.toleranceS)
      return c.json(refuse('stale'), 400)
    const read = await readBodyWithDeadline(c, BUG_INBOX_LIMITS.bodyBytes)
    if (lateRequest(c)) return c.json(refuse('request_timeout'), 408)
    if (!read.ok)
      return read.why === 'timeout' ? c.json(refuse('request_timeout'), 408) : c.json(refuse('too_large'), 413)
    const text = new TextDecoder().decode(read.body)
    const install = signedBy(installs, h, text)
    if (!install) {
      services.log.warn({}, 'bug inbox: a delivery no install signed was refused')
      return c.json(refuse('bad_signature'), 401)
    }
    let raw: unknown
    try {
      raw = JSON.parse(text)
    } catch {
      return c.json(refuse('bad_request'), 400)
    }
    const parsed = BugInboxDelivery.safeParse(raw)
    if (!parsed.success) return c.json(refuse('bad_request'), 400)
    const d = parsed.data
    const perInstall = takeRate(c, 'bug_inbox', install.name)
    if (!perInstall.ok)
      return c.json({ error: 'rate_limited', retry_after_s: perInstall.retryAfterS }, 429, {
        'Retry-After': String(perInstall.retryAfterS),
      })
    // The picture: decoded strictly, within the reporter's cap, and its first bytes must be the type it claims.
    let image: { bytes: Buffer; type: string } | null = null
    if (d.data.image && !services.env.BUG_INBOX_NO_SCREENSHOT) {
      const bytes = Buffer.from(d.data.image.b64, 'base64')
      if (bytes.length > BUG_REPORT_LIMITS.imageBytes) return c.json(refuse('too_large'), 413)
      if (bytes.length === 0 || bytes.toString('base64') !== d.data.image.b64 || sniffMime(bytes) !== d.data.image.type)
        return c.json(refuse('bad_image'), 400)
      image = { bytes, type: d.data.image.type }
    }
    const rt = findRuntime(services)
    if (!rt) return c.json(refuse('server_error'), 500)
    const key = `bug-inbox:${install.name}:${d.data.id}`
    try {
      burn(services, key, now)
    } catch (e) {
      if (e instanceof Seen) return c.json(refuse('replay'), 409)
      throw e
    }
    try {
      const shot = image
        ? await services.media.put({
            bytes: image.bytes,
            mime: image.type,
            name: `bug-report.${image.type === 'image/png' ? 'png' : 'jpg'}`,
          })
        : undefined
      const p = problemFromDelivery(d, install.name, services.env, shot, now)
      await rt.hub.toBridge({ type: 'problem.item', id: p.id, problem: p }, { durable: true })
      services.log.info(
        { install: install.name, report_id: d.data.id, screenshot: Boolean(shot) },
        'bug inbox: report filed',
      )
    } catch (e) {
      // nothing was handed on: the id is free again, so the same delivery can be tried once more
      services.db.prepare('delete from core_push_nonces where nonce_key = ?').run(key)
      throw e
    }
    return c.json({ ok: true }, 202)
  },
)
