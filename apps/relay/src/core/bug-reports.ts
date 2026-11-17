// In-app bug reports, relay side. One route, `POST /api/bug-reports`: the page signs the whole report (text and picture) with
// the device key, exactly like `native.grant`, and this file checks the same things that route does (a session whose pinned
// device signed it, fresh, single use) before it stores anything. The report is kept 90 days as two encrypted files, then the
// sweeper removes it. When the owner set `bug_webhook_url` (Mac only) and the relay has `BUG_WEBHOOK_SECRET`, one signed
// Standard Webhooks call tells that URL about it. Without an address of the owner's own, the Talos team's inbox this relay was
// deployed with (`BUG_TEAM_INBOX_URL`) is used the same way, and that call carries the picture too (core/bug-inbox.ts is the
// other end); otherwise nothing leaves this relay.
import { createHmac, randomBytes } from 'node:crypto'
import dns from 'node:dns'
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import http from 'node:http'
import https from 'node:https'
import { join } from 'node:path'
import {
  APNS_REGISTRATION_SKEW_MS,
  type AttachmentRefT,
  BUG_REPORT_LIMITS,
  BUG_REPORTED_EVENT,
  type BugReportDestinationT,
  BugReportPost,
  type BugReportPostT,
  type BugReportWebhookT,
  bugWebhookUrlOk,
  eventInfo,
  isBlockedAddress,
  PROBLEM_LIMITS,
  Problem,
  type ProblemT,
  problemFingerprint,
  redactReport,
  scrubProblem,
  shownWebhookHost,
  verifyOwnerFrame,
} from '@talos-app/protocol'
import type Database from 'better-sqlite3'
import { Hono } from 'hono'
import {
  getSession,
  preflightBridgeHttp,
  requireCsrf,
  requireSession,
  takeRate,
  verifyBridgeHttp,
} from '../auth/contract.ts'
import type { AppEnv, Clock, CryptoService, Logger, RelayServices } from '../services.ts'
import { idleBodyTimeout, lateRequest, limitBody, readBodyWithDeadline } from './body-guard.ts'
import { findRuntime } from './runtime.ts'
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

// ---- the owner's own Mac -------------------------------------------------------------------------------------------------

type StoredPost = Omit<BugReportPostT, 'osig' | 'image_b64'>

/** A stored report, decrypted: the JSON as stored (the post minus the signature and the picture) and the picture. Null when a file is gone or unreadable. */
export function loadBugReport(d: Deps, id: string): { post: StoredPost; image: Buffer } | null {
  try {
    const json = d.crypto.decrypt(readFileSync(jsonPath(d, id)), `bug:${id}:json`)
    const image = d.crypto.decrypt(readFileSync(imgPath(d, id)), `bug:${id}:img`)
    return { post: JSON.parse(new TextDecoder().decode(json)) as StoredPost, image: Buffer.from(image) }
  } catch {
    return null
  }
}

/**
 * The problem the owner's own report becomes on his Mac: `source: 'web'` (the reporter is the web page), `device` the app that
 * sent it (a browser when an older app did not say), no `install`, so it is not shown as another install's. Its id is `opts.id`
 * (the report's own key, see `queueToBridge`), so a retry or the reconcile merges
 * and never doubles. What he typed is the message (its start) and the steps (all of it, with what he expected).
 */
export async function ownReportProblem(
  services: RelayServices,
  post: StoredPost,
  image: Buffer,
  opts: { id?: string; screenshot?: AttachmentRefT } = {},
): Promise<ProblemT> {
  const r = post.report
  const v = r.versions
  const now = services.clock.now()
  const at = Date.parse(post.ts)
  const full = r.expected ? `${r.what_went_wrong}\n\nExpected: ${r.expected}` : r.what_went_wrong
  const screenshot =
    opts.screenshot ??
    (await services.media.put({
      bytes: image,
      mime: post.image_type,
      name: `bug-report.${post.image_type === 'image/png' ? 'png' : 'jpg'}`,
    }))
  const draft: ProblemT = {
    id: opts.id ?? post.id,
    source: 'web',
    kind: 'owner',
    fingerprint: '0'.repeat(32),
    at: new Date(Number.isFinite(at) && at <= now ? at : now).toISOString(),
    name: 'bug report',
    message: r.what_went_wrong.slice(0, PROBLEM_LIMITS.messageChars),
    frames: [],
    versions: {
      ...(v.app ? { app: v.app } : {}),
      ...(v.relay ? { relay: v.relay } : {}),
      ...(v.bridge ? { bridge: v.bridge } : {}),
    },
    device: r.client ?? 'browser',
    // an older app sent only the one screen: better than none
    routes: r.routes?.length ? r.routes : r.screen ? [r.screen.slice(0, PROBLEM_LIMITS.routeChars)] : [],
    steps: full.slice(0, PROBLEM_LIMITS.stepsChars),
    truncated: full.length > PROBLEM_LIMITS.stepsChars,
    screenshot,
  }
  const clean = scrubProblem(draft)
  return Problem.parse({ ...clean, fingerprint: problemFingerprint(clean) })
}

/** Crockford base32, what a ULID is written in. */
const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'

/**
 * A ULID-shaped id for a delivery (a problem id or a frame id): the time in 10 characters and 80 bits from the system's random
 * source in 16. Not `newUlid()`: that is one monotonic sequence shared with ids a browser sees (a pong's), where ids made in the
 * same millisecond are each the last plus one, so one seen id would give the next away.
 */
export function deliveryId(nowMs: number): string {
  let t = Math.max(0, Math.floor(nowMs))
  let time = ''
  for (let i = 0; i < 10; i++) {
    time = CROCKFORD[t % 32] + time
    t = Math.floor(t / 32)
  }
  let bits = 0n
  for (const b of randomBytes(10)) bits = (bits << 8n) | BigInt(b)
  let rand = ''
  for (let i = 0; i < 16; i++) {
    rand = CROCKFORD[Number(bits & 31n)] + rand
    bits >>= 5n
  }
  return time + rand
}

/**
 * True when `id` is a stored bug report's id, or the id one was queued under (its problem id or a frame id), for a problem of
 * any kind: a problem a device posts under one of them would be filed as that report, or lend it a picture. The ids the relay
 * makes are random and never shown to a device; the report id is the one a device does know.
 */
export function reportIdTaken(d: Pick<Deps, 'db'>, id: string): boolean {
  return (
    d.db
      .prepare('select 1 from core_bug_reports where report_id = ? or bridge_problem_id = ? or bridge_frame_id = ?')
      .get(id, id, id) !== undefined
  )
}

/** Is `held` (a stored frame) this same report: its id, kind and source, its words and its picture's bytes. The picture's media id is new on every queueing and is not compared. */
function sameOwnReport(held: unknown, p: ProblemT): boolean {
  const h = (held as { problem?: Partial<ProblemT> }).problem
  return (
    h !== undefined &&
    h.id === p.id &&
    h.kind === 'owner' &&
    h.source === p.source &&
    h.message === p.message &&
    h.steps === p.steps &&
    h.screenshot?.sha256 === p.screenshot?.sha256
  )
}

/** Another queueing of the same report committed between this one's reading its marks and its writing them: read again. */
class Raced extends Error {}
/** A requeue found the report still queued and unfiled, inside the transaction that would have queued it again. */
class Coalesced extends Error {}

type QueueResult = 'queued' | 'already_queued' | 'failed'

/**
 * One transaction per queueing (`alsoWrite`, with the frame and its queue entry): the marks are read again and checked, the report
 * is marked queued, and for a `fresh` queueing (a requeue) the mark of "filed" is cleared and a report that is still queued and
 * unfiled is left alone, so two requeues at once make one frame. A report is queued under a random id made here the first time
 * (frame id and problem id alike) and kept in the row: it is known only to this relay, so no problem a device posts can share
 * it. One queued before that column existed keeps its report id as problem id, because that is how the Mac already knows it.
 */
async function queueOnce(
  services: RelayServices,
  rt: NonNullable<ReturnType<typeof findRuntime>>,
  post: StoredPost,
  image: Buffer,
  fresh: boolean,
): Promise<QueueResult> {
  const m = services.db
    .prepare(
      'select bridge_queued_at q, bridge_problem_id pid, bridge_frame_id fid from core_bug_reports where report_id = ?',
    )
    .get(post.id) as { q: number | null; pid: string | null; fid: string | null } | undefined
  let problemId = m?.pid ?? (m?.q != null ? post.id : deliveryId(services.clock.now()))
  let known = m?.fid ?? null
  const screenshot = await services.media.put({
    bytes: image,
    mime: post.image_type,
    name: `bug-report.${post.image_type === 'image/png' ? 'png' : 'jpg'}`,
  })
  let p = await ownReportProblem(services, post, image, { id: problemId, screenshot })
  let frameId: string
  for (;;) {
    frameId = fresh ? deliveryId(services.clock.now()) : (known ?? problemId)
    const held = fresh ? null : rt.store.getEventByFrameId(frameId)
    if (!held || sameOwnReport(held, p)) break
    // a frame of that id holds a different problem: the report is never sent as it
    services.log.warn({ report_id: post.id }, 'bug report: a frame of its id holds another problem')
    if (problemId !== post.id || known !== null) throw new Error('another problem holds its frame id')
    problemId = deliveryId(services.clock.now())
    known = null
    p = await ownReportProblem(services, post, image, { id: problemId, screenshot })
  }
  await rt.hub.toBridge(
    { type: 'problem.item', id: frameId, problem: p },
    {
      durable: true,
      resume: !fresh,
      alsoWrite: () => {
        const cur = services.db
          .prepare(
            'select bridge_problem_id pid, bridge_frame_id fid, bridge_consumed_at c from core_bug_reports where report_id = ?',
          )
          .get(post.id) as { pid: string | null; fid: string | null; c: number | null } | undefined
        if (!cur) throw new Error('report is gone')
        if (cur.pid !== (m?.pid ?? null) || cur.fid !== (m?.fid ?? null)) throw new Raced()
        if (fresh && cur.c === null) {
          const live = services.db
            .prepare(`select 1 from core_bug_reports r where r.report_id = ? and ${LIVE_FRAME_SQL}`)
            .get(post.id, services.clock.now())
          if (live !== undefined) throw new Coalesced()
        }
        services.db
          .prepare(
            `update core_bug_reports set bridge_queued_at = ?, bridge_frame_id = ?, bridge_problem_id = ?${fresh ? ', bridge_consumed_at = null' : ''} where report_id = ?`,
          )
          .run(services.clock.now(), frameId, problemId, post.id)
      },
    },
  )
  return 'queued'
}

async function queueReport(
  services: RelayServices,
  post: StoredPost,
  image: Buffer,
  fresh: boolean,
): Promise<QueueResult> {
  const rt = findRuntime(services)
  if (!rt) {
    services.log.info({ report_id: post.id }, 'bug report not queued to the bridge: no runtime')
    return 'failed'
  }
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      return await queueOnce(services, rt, post, image, fresh)
    } catch (e) {
      if (e instanceof Raced) continue
      if (e instanceof Coalesced) return 'already_queued'
      services.log.warn(
        { report_id: post.id, err: e instanceof Error ? e.message.slice(0, 60) : 'error' },
        'bug report not queued to the bridge',
      )
      return 'failed'
    }
  }
  return 'failed'
}

/**
 * Queues one stored report to this relay's own bridge (a durable `problem.item`: sent at once if the Mac is online, else on its
 * next hello) and marks the row, in one transaction with the frame. A frame already stored under the id it would be queued
 * under must hold this same report, or it is refused. `fresh` is for an operator who asks to send a report again (`requeue`): a
 * NEW frame id for the same problem, because the Mac has seen the first frame's id and would only confirm it, and a report it
 * filed without its picture could never be repaired. A failure leaves the mark empty, so the reconcile tries again. Returns
 * whether it was queued.
 */
export async function queueToBridge(
  services: RelayServices,
  post: StoredPost,
  image: Buffer,
  opts: { fresh?: boolean } = {},
): Promise<boolean> {
  return (await queueReport(services, post, image, opts.fresh === true)) === 'queued'
}

/**
 * A queue entry, not expired, for the frame the report was last queued as. A report queued before frame ids were recorded was
 * queued under its own id; one never queued has no frame, so a frame of that id (a problem a device posted) is not its entry.
 */
const LIVE_FRAME_SQL = `exists (select 1 from core_outbox o join core_events e on e.seq = o.seq
  where o.frame_id = coalesce(r.bridge_frame_id, case when r.bridge_queued_at is not null then r.report_id end)
    and o.expires_at > ?)`

let reconciling = false

/**
 * Queues every stored report the Mac has not filed and that has no live queue entry, oldest first: reports from before this
 * path existed, one whose queueing failed, and one whose entry expired or was swept (30 days, 500 reports or 250 MiB, see
 * held-problems.ts) before the Mac came back. "Filed" is the Mac's own `consumed` (`bridge_consumed_at`), not "queued once".
 * Run at startup and every few minutes; a run that is still going is not started twice. Returns how many were queued.
 */
export async function backfillOwnReports(services: RelayServices): Promise<number> {
  if (reconciling) return 0
  reconciling = true
  try {
    const deps = { db: services.db, crypto: services.crypto, clock: services.clock, dataDir: services.env.DATA_DIR }
    const ids = services.db
      .prepare(
        `select report_id from core_bug_reports r where r.bridge_consumed_at is null and not ${LIVE_FRAME_SQL}
         order by r.created_at, r.report_id`,
      )
      .all(services.clock.now()) as Array<{ report_id: string }>
    let queued = 0
    for (const { report_id: id } of ids) {
      const got = loadBugReport(deps, id)
      if (!got) {
        services.log.warn({ report_id: id }, 'bug report backfill: files missing, skipped')
        continue
      }
      if (await queueToBridge(services, got.post, got.image)) queued++
    }
    if (ids.length > 0) services.log.info({ found: ids.length, queued }, 'bug report backfill to the bridge')
    return queued
  } finally {
    reconciling = false
  }
}

export type RequeueResult = 'queued' | 'already_queued' | 'not_found' | 'files_missing' | 'failed'

/**
 * An operator asks to send one stored report again. A report the Mac has not filed that still has a live queue entry is already
 * on its way (the relay resends it by itself): nothing new is made, no frame and no picture copy. Anything else is queued as a
 * new frame for the same problem.
 */
export async function requeueBugReport(services: RelayServices, id: string): Promise<RequeueResult> {
  const row = services.db.prepare('select bridge_consumed_at c from core_bug_reports where report_id = ?').get(id) as
    | { c: number | null }
    | undefined
  if (!row) return 'not_found'
  const live = services.db
    .prepare(`select 1 from core_bug_reports r where r.report_id = ? and ${LIVE_FRAME_SQL}`)
    .get(id, services.clock.now())
  if (row.c === null && live !== undefined) return 'already_queued'
  const deps = { db: services.db, crypto: services.crypto, clock: services.clock, dataDir: services.env.DATA_DIR }
  const got = loadBugReport(deps, id)
  if (!got) return 'files_missing'
  return queueReport(services, got.post, got.image, true)
}

/**
 * The Mac answered `consumed` for a frame the relay queued for a bug report: the report is filed there. Matched on the frame id
 * the report was last queued under, one indexed update that changes nothing for any other frame, with no decryption.
 */
export function registerBugReports(services: RelayServices): void {
  if (!findRuntime(services)) return
  services.bus.onBridgeFrame('ack', (f) => {
    if (f.stage !== 'consumed') return
    services.db
      .prepare(
        'update core_bug_reports set bridge_consumed_at = ? where bridge_frame_id = ? and bridge_consumed_at is null',
      )
      .run(services.clock.now(), f.ref)
  })
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
    // The owner's own Mac gets it whatever the webhook does.
    const { osig: _sig, image_b64: _img, ...stored } = post
    const bridge = (await queueToBridge(services, stored, image)) ? 'queued' : 'failed'
    const target = bugWebhookTarget(services)
    emitRelayEvent(services.log, BUG_REPORTED_EVENT, {
      report_id: post.id,
      device_id: post.device_id,
      webhook: target ? 'queued' : 'off',
      bridge,
    })
    if (target) void sendWebhook(services, target, post, image.length)
    return c.json({ ok: true, id: post.id }, 201)
  },
)

/** Bodies here are `{}`: 4 KiB is far above that. */
const REQUEUE_BODY_CAP = 4096

// The Mac asks the relay to send one stored report again (`talos-app errors requeue-bug-report <id>`): signed bridge HTTP, the
// same credential as every other Mac-only action (device revoke, share tokens). Nothing of the report is in the answer.
bugReportRoutes.post(
  '/bridge/bug-reports/:id/requeue',
  limitBody(() => REQUEUE_BODY_CAP),
  idleBodyTimeout(),
  async (c) => {
    if (!preflightBridgeHttp(c).ok) return c.json({ error: 'unauthorized' }, 401)
    const body = new Uint8Array(await c.req.arrayBuffer())
    if (body.length > REQUEUE_BODY_CAP) return c.json({ error: 'too_large' }, 413)
    if (!(await verifyBridgeHttp(c, body)).ok) return c.json({ error: 'unauthorized' }, 401)
    const id = c.req.param('id')
    const done = await requeueBugReport(c.get('services'), id)
    if (done === 'not_found' || done === 'files_missing') return c.json({ error: done }, 404)
    if (done === 'failed') return c.json({ error: 'queue_failed' }, 500)
    return c.json({ ok: true, id, ...(done === 'already_queued' ? { already_queued: true } : {}) })
  },
)
