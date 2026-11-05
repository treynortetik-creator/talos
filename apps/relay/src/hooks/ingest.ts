// The hook pipeline (spec 7.1): lookup -> gating -> body cap -> handshake -> verify -> pre-filter -> dedup -> durable
// write -> 200. A worker then normalizes, filters, dedups per event and routes (route.ts).

import { createHash } from 'node:crypto'
import type { NormalizeConnection, RawDelivery } from '@talos-app/integrations'
import { moduleExtras } from '@talos-app/integrations'
import type { IntegrationIdT, NormalizedEventT } from '@talos-app/protocol'
import { ConnId, IntegrationId, NormalizedEvent } from '@talos-app/protocol'
import { effectiveToggles, keepEvent, withToggleState } from './filters.ts'
import { deliverPending, notifyNewItems, type RouteInput, storeEvents } from './route.ts'
import {
  addDelivery,
  credsFor,
  dedupFirstSeen,
  deliveriesInLastHour,
  getConn,
  randomId,
  secretsFor,
  toConn,
} from './store.ts'
import {
  type BodyRead,
  type ConnRow,
  DEDUP_TTL_MS,
  DELIVERIES_PER_HOUR,
  FAILED_VERIFY_PER_MIN,
  GITHUB_DEDUP_TTL_MS,
  type HooksRuntime,
  MAX_BODY_BYTES,
  PREV_SECRET,
  PREV_SECRET_UNTIL,
  RAW_SOFT_CAP_SHARE,
} from './types.ts'

export type HookResponse = { status: number; contentType: string; body: string }

const json = (status: number, body: unknown): HookResponse => ({
  status,
  contentType: 'application/json',
  body: JSON.stringify(body),
})

// ---- throttle for unknown connection ids (spec 7.1 step 1: 404 + throttle; 6th miss in a minute -> 429) -----------------

const MISS_LIMIT = 5
const MISS_WINDOW_MS = 60_000
const missLog = new WeakMap<HooksRuntime, Map<string, number[]>>()

/** Records a miss; true when this client is over the limit. */
export function recordMissFor(rt: HooksRuntime, ip: string): boolean {
  return recordMiss(rt, ip)
}

function recordMiss(rt: HooksRuntime, ip: string, limit = MISS_LIMIT): boolean {
  let m = missLog.get(rt)
  if (!m) {
    m = new Map()
    missLog.set(rt, m)
  }
  const now = rt.now()
  const recent = (m.get(ip) ?? []).filter((t) => now - t < MISS_WINDOW_MS)
  recent.push(now)
  m.set(ip, recent)
  if (m.size > 5000) for (const [k, v] of m) if (v.every((t) => now - t >= MISS_WINDOW_MS)) m.delete(k)
  return recent.length > limit
}

/** Charges an UNVERIFIED request to its own small bucket (per connection + client). Verified traffic never touches it. */
function recordFailedVerify(rt: HooksRuntime, connId: string, ip: string): 'ok' | 'first_over' | 'over' {
  const over = recordMiss(rt, `fail|${connId}|${ip}`, FAILED_VERIFY_PER_MIN)
  if (!over) return 'ok'
  const m = missLog.get(rt)?.get(`fail|${connId}|${ip}`)
  return m && m.length === FAILED_VERIFY_PER_MIN + 1 ? 'first_over' : 'over'
}

// ---- gating --------------------------------------------------------------------------------------------------------

export function integrationEnabled(rt: HooksRuntime, id: IntegrationIdT): boolean {
  const mod = rt.module(id)
  if (mod.setup.category !== 'work') return true
  if (rt.services.env.WORK_INTEGRATIONS === 'off') return false
  return rt.services.agentConfig()?.work.enabled.includes(id) ?? false
}

/**
 * What `verify()` checks against. Modules that sign with the VENDOR's secret (Slack, Zoom, Stripe) declare the wizard field
 * that holds it; that stored value (current, then the previous one for 24 h after a re-paste) is the key. Everything else
 * uses the relay-generated connection secret.
 */
function verifySecretsFor(rt: HooksRuntime, conn: ConnRow, mod: ReturnType<HooksRuntime['module']>): string[] {
  const field = moduleExtras(mod).verifySecretField
  if (!field) return secretsFor(rt, conn.id)
  const creds = credsFor(rt, conn.id)
  const out: string[] = []
  if (creds[field]) out.push(creds[field])
  if (creds[PREV_SECRET] && Number(creds[PREV_SECRET_UNTIL]) > rt.now()) out.push(creds[PREV_SECRET])
  return out
}

export function normConn(c: ConnRow, work: boolean): NormalizeConnection {
  return { id: c.id, integration: c.integration, thread: c.thread, work, extra: c.extra }
}

// ---- the request ---------------------------------------------------------------------------------------------------

export type HookRequest = {
  integration: string
  connId: string
  method: string
  headers: Record<string, string>
  url: string
  ip: string
  /** Null when the body exceeded the cap. Called only after the connection is known and enabled. */
  readBody(): Promise<BodyRead>
  declaredLength?: number
  /**
   * Charges the rate buckets (spec 5.4: 120/min per connection, 600/min total). Called once per VERIFIED delivery, so a
   * flood of junk or unsigned requests can never spend a real sender's budget. Absent = never limited.
   */
  admit?(connId: string): 'ok' | 'conn' | 'global'
}

function tryJson(bytes: Uint8Array): unknown {
  if (bytes.length === 0) return undefined
  try {
    return JSON.parse(new TextDecoder().decode(bytes))
  } catch {
    return undefined
  }
}

function rawBytesStored(rt: HooksRuntime): number {
  return (
    rt.services.db.prepare('select coalesce(sum(length(raw_enc)), 0) as n from hooks_inbound').get() as { n: number }
  ).n
}

export async function handleHookRequest(rt: HooksRuntime, req: HookRequest): Promise<HookResponse> {
  if (req.method !== 'POST') return json(405, { error: 'method_not_allowed' })
  const idOk = IntegrationId.safeParse(req.integration)
  const connOk = ConnId.safeParse(req.connId)
  const conn = idOk.success && connOk.success ? getConn(rt, req.connId) : null
  if (!conn || !idOk.success || conn.integration !== idOk.data) {
    return recordMiss(rt, req.ip) ? json(429, { error: 'too_many_requests' }) : json(404, { error: 'not_found' })
  }
  const mod = rt.module(conn.integration)
  if (!integrationEnabled(rt, conn.integration)) return json(403, { error: 'integration_disabled' }) // nothing stored
  if (conn.status === 'paused') {
    addDelivery(rt, conn.id, 200, 'paused')
    return json(200, { ok: true })
  }
  if ((req.declaredLength ?? 0) > MAX_BODY_BYTES) return json(413, { error: 'payload_too_large' })
  const body = await req.readBody()
  if (body === 'busy') return json(429, { error: 'too_many_requests', retry_after_s: 5 })
  if (body === 'slow') return json(408, { error: 'request_timeout' })
  if (!body) return json(413, { error: 'payload_too_large' })

  const secrets = verifySecretsFor(rt, conn, mod)
  // `x-talos-*` headers are the relay's own (the poller marks its deliveries); a sender never gets to set one.
  const headers = Object.fromEntries(
    Object.entries(req.headers).filter(([k]) => !k.toLowerCase().startsWith('x-talos-')),
  )
  const raw: RawDelivery = { headers, rawBody: body, json: tryJson(body), receivedAt: rt.now() }
  const vconn = { secrets, extra: conn.extra }

  const hs = mod.handshake?.(raw, vconn)
  if (hs) return { status: hs.status, contentType: hs.contentType, body: hs.body }

  const v = await mod.verify({ headers: req.headers, rawBody: body, url: req.url, now: rt.now() }, vconn)
  if (!v.ok) {
    // Verification comes first and is cheap. A failure is charged to the small failed-verify bucket only; it never
    // counts toward the connection's verified budget, so junk cannot cost a real event.
    const b = recordFailedVerify(rt, conn.id, req.ip)
    if (b === 'ok') addDelivery(rt, conn.id, 401, v.reason)
    else {
      if (b === 'first_over') addDelivery(rt, conn.id, 429, 'bad_signature_flood') // one summary row, then silence
      return json(429, { error: 'too_many_requests' })
    }
    return json(401, { error: 'unauthorized' }) // the reason stays in Recent deliveries, never in the response
  }

  const admitted = req.admit?.(conn.id) ?? 'ok'
  if (admitted === 'global') return json(429, { error: 'too_many_requests', retry_after_s: 60 })
  if (admitted === 'conn') return shed(rt, conn, mod)

  const work = mod.setup.category === 'work'
  const nconn = normConn(conn, work)
  if (mod.prefilter && !mod.prefilter(raw, nconn)) {
    addDelivery(rt, conn.id, 200, 'prefiltered', { received: 1, kept: 0 })
    return ack(rt, conn, mod)
  }

  // Verified from here on. If we must shed load, say so (429): the sender retries. The one exception is the per-connection
  // limit for providers that disable an endpoint that keeps failing (spec 5.4): they get 200 and the event is dropped.
  const cap = rt.services.env.VOLUME_SOFT_CAP_MB * 1024 * 1024 * RAW_SOFT_CAP_SHARE
  if (deliveriesInLastHour(rt, conn.id) >= DELIVERIES_PER_HOUR) return shed(rt, conn, mod)
  if (rawBytesStored(rt) > cap) return shed(rt, conn, mod, true)

  const ttl = conn.integration === 'github' ? GITHUB_DEDUP_TTL_MS : DEDUP_TTL_MS
  const keys = v.deliveryKey ? [`d:${conn.id}:${v.deliveryKey}`] : []
  // These senders identify a delivery by an UNSIGNED header, and GitHub signs no timestamp: a captured signed body would
  // replay under a fresh id forever. The hash of the signed body is the key they cannot change without the secret.
  if (BODY_HASH_DEDUP.has(conn.integration))
    keys.push(`b:${conn.id}:${createHash('sha256').update(body).digest('hex')}`)
  const stored = persistRaw(rt, conn, raw, 'ok', keys.length ? { keys, ttl } : undefined)
  if (stored && rt.opts.autoProcess !== false) void kick(rt)
  return ack(rt, conn, mod)
}

const BODY_HASH_DEDUP = new Set<string>(['github', 'jira', 'linear'])

/** Providers that switch an endpoint off after repeated failures: over the per-connection limit they get 200 and a drop. */
const DROP_WHEN_OVER_LIMIT = new Set<string>(['slack', 'linear', 'zoom'])

/**
 * Over a per-connection limit. The delivery is recorded once a minute as `over_limit` (Recent deliveries). Slack, Linear
 * and Zoom get 200 and the event is dropped; everyone else gets 429 and retries. `storage` (the raw store is full) is
 * never dropped silently: that is the relay's own pressure, not the sender's rate.
 */
function shed(rt: HooksRuntime, conn: ConnRow, mod: ReturnType<HooksRuntime['module']>, storage = false): HookResponse {
  const drop = !storage && DROP_WHEN_OVER_LIMIT.has(conn.integration)
  const recent = rt.services.db
    .prepare("select 1 from hooks_deliveries where conn_id = ? and reason = 'over_limit' and at >= ? limit 1")
    .get(conn.id, rt.now() - 60_000)
  if (!recent) addDelivery(rt, conn.id, drop ? 200 : 429, 'over_limit')
  return drop ? ack(rt, conn, mod) : json(429, { error: 'too_many_requests', retry_after_s: 60 })
}

function ack(_rt: HooksRuntime, _conn: ConnRow, mod: ReturnType<HooksRuntime['module']>): HookResponse {
  const a = moduleExtras(mod).ack?.()
  return a ? { status: 200, contentType: a.contentType, body: a.body } : json(200, { ok: true })
}

/**
 * Durable write: encrypt first (a failure here burns nothing), then the dedup key, the delivery row and the inbound row
 * commit in ONE transaction. A throw rolls the dedup key back, so the sender's retry is stored, not dropped as a duplicate.
 * Returns the inbound id, or null for a duplicate delivery.
 */
export function persistRaw(
  rt: HooksRuntime,
  conn: ConnRow,
  raw: RawDelivery,
  reason: string,
  dedup?: { keys: string[]; ttl: number },
): string | null {
  const { db, crypto } = rt.services
  const id = randomId('hi')
  const enc = Buffer.from(crypto.encrypt(raw.rawBody, `hooks_inbound:${id}`))
  // Headers can carry a Bearer secret: encrypted with the relay's crypto service like the body (own AAD), stored as base64.
  const headers = Buffer.from(
    crypto.encrypt(new TextEncoder().encode(JSON.stringify(raw.headers)), `hooks_inbound:${id}:headers`),
  ).toString('base64')
  return db.transaction((): string | null => {
    // Every key is recorded (no short-circuit), so a replay under a new id also leaves its own id behind.
    const fresh = dedup ? dedup.keys.map((k) => dedupFirstSeen(rt, k, dedup.ttl)).every(Boolean) : true
    if (!fresh) {
      addDelivery(rt, conn.id, 200, 'duplicate')
      return null
    }
    const deliveryId = addDelivery(rt, conn.id, 200, reason)
    db.prepare(
      'insert into hooks_inbound (id, conn_id, delivery_id, received_at, headers, raw_enc) values (?, ?, ?, ?, ?, ?)',
    ).run(id, conn.id, deliveryId, raw.receivedAt, headers, enc)
    return id
  })()
}

// ---- worker --------------------------------------------------------------------------------------------------------

const MAX_ATTEMPTS = 5
const draining = new WeakMap<HooksRuntime, Promise<void>>()

/** Starts (or joins) a drain of pending rows. */
export function kick(rt: HooksRuntime): Promise<void> {
  const cur = draining.get(rt)
  if (cur) return cur
  const p = drainPending(rt).finally(() => draining.delete(rt))
  draining.set(rt, p)
  return p
}

/** Resolves when nothing is in flight and nothing is pending. */
export async function idle(rt: HooksRuntime): Promise<void> {
  for (;;) {
    const cur = draining.get(rt)
    if (cur) {
      await cur
      continue
    }
    const pending = rt.services.db.prepare("select 1 from hooks_inbound where state = 'pending' limit 1").get()
    if (!pending) return
    await kick(rt)
  }
}

type InboundRow = {
  id: string
  conn_id: string
  delivery_id: number | null
  received_at: number
  headers: string
  raw_enc: Buffer
  attempts: number
}

async function drainPending(rt: HooksRuntime): Promise<void> {
  const { db } = rt.services
  try {
    await drainLoop(rt, db)
  } finally {
    // The durable send pass: anything stored and not yet sent (including rows left by a crash or a failed send).
    const sent = await deliverPending(rt)
    if (sent.pushThread) await notifyNewItems(rt, sent.pushThread)
  }
}

async function drainLoop(rt: HooksRuntime, db: HooksRuntime['services']['db']): Promise<void> {
  for (;;) {
    const rows = db
      .prepare(
        "select id, conn_id, delivery_id, received_at, headers, raw_enc, attempts from hooks_inbound where state = 'pending' order by received_at, rowid limit 25",
      )
      .all() as InboundRow[]
    if (rows.length === 0) return
    for (const row of rows) {
      try {
        await processRow(rt, row)
      } catch (err) {
        const attempts = row.attempts + 1
        db.prepare('update hooks_inbound set attempts = ?, state = ? where id = ?').run(
          attempts,
          attempts >= MAX_ATTEMPTS ? 'failed' : 'pending',
          row.id,
        )
        rt.services.log.warn(
          { inbound: row.id, conn: row.conn_id, attempts, err: errName(err) },
          'hook processing failed',
        )
      }
    }
  }
}

function errName(err: unknown): string {
  return err instanceof Error ? err.name : 'error'
}

async function processRow(rt: HooksRuntime, row: InboundRow): Promise<void> {
  const { db, crypto } = rt.services
  const connRow = db
    .prepare(
      'select id, integration, name, thread, status, paused_reason, filters, advanced, extra, created_at, last_event_at from hooks_connections where id = ?',
    )
    .get(row.conn_id) as Parameters<typeof toConn>[0] | undefined
  if (!connRow) {
    db.prepare("update hooks_inbound set state = 'done' where id = ?").run(row.id)
    return
  }
  const conn = toConn(connRow)
  const mod = rt.module(conn.integration)
  const work = mod.setup.category === 'work'
  const rawBody = crypto.decrypt(row.raw_enc, `hooks_inbound:${row.id}`)
  const headers = JSON.parse(
    new TextDecoder().decode(crypto.decrypt(Buffer.from(row.headers, 'base64'), `hooks_inbound:${row.id}:headers`)),
  ) as Record<string, string>
  const delivery: RawDelivery = { headers, rawBody, json: tryJson(rawBody), receivedAt: row.received_at }
  const toggles = effectiveToggles(mod, conn.filters)
  const nconn = withToggleState(normConn(conn, work), toggles)
  const events = await mod.normalize(delivery, nconn)
  const ttl = conn.integration === 'github' ? GITHUB_DEDUP_TTL_MS : DEDUP_TTL_MS
  // One transaction: per-event dedup keys, the event rows and the inbound state commit together. A crash before the
  // commit leaves the row pending and un-deduped; after it, the durable send pass (route.ts) owns delivery.
  db.transaction(() => {
    const kept: RouteInput[] = []
    for (const e of events) {
      if (!keepEvent(mod, e, toggles, conn.advanced, nconn)) continue
      // Module output is untrusted (a sender controls its fields): one that does not parse as a NormalizedEvent would be
      // rejected by the Mac as a bad frame, forever. Drop it here, before it burns a dedup key.
      const forced = forceConn(e, conn, work)
      if (!NormalizedEvent.safeParse(forced).success) {
        rt.services.log.warn(
          { conn: conn.id, integration: conn.integration },
          'module returned an invalid event; dropped',
        )
        continue
      }
      if (!dedupFirstSeen(rt, `e:${conn.id}:${e.dedup_key}`, ttl)) continue
      kept.push({ event: forced, rawId: row.id })
    }
    storeEvents(rt, kept)
    if (row.delivery_id !== null)
      db.prepare('update hooks_deliveries set received = ?, kept = ? where id = ?').run(
        events.length,
        kept.length,
        row.delivery_id,
      )
    // Nothing kept = nothing refers to this payload: do not keep it around.
    if (kept.length === 0)
      db.prepare("update hooks_inbound set raw_enc = x'', state = 'wiped' where id = ?").run(row.id)
    else db.prepare("update hooks_inbound set state = 'done' where id = ?").run(row.id)
  })()
}

/** A module can only speak for its own connection: source, connection, thread and work are set by the relay. */
function forceConn(e: NormalizedEventT, conn: ConnRow, work: boolean): NormalizedEventT {
  return { ...e, source: conn.integration, connection: conn.id, thread: conn.thread, work }
}

// ---- polled deliveries enter here (no signature to check) -----------------------------------------------------------

export async function ingestPolled(rt: HooksRuntime, conn: ConnRow, deliveries: RawDelivery[]): Promise<number> {
  const mod = rt.module(conn.integration)
  if (!integrationEnabled(rt, conn.integration)) return 0 // switched off: nothing is stored
  const nconn = normConn(conn, mod.setup.category === 'work')
  let stored = 0
  for (const raw of deliveries) {
    if (mod.prefilter && !mod.prefilter(raw, nconn)) continue
    persistRaw(rt, conn, raw, 'poll')
    stored++
  }
  if (stored > 0 && rt.opts.autoProcess !== false) void kick(rt)
  return stored
}
