// One-time secret claim for the Apps Script integrations (spec 7.6): `POST /hook/<integration>/<cn>/claim` for every module that sets `claim`.
// The rendered script holds only a claim code; it trades it for the signing secret once, then the code is dead (410).
import { createHash } from 'node:crypto'
import { moduleExtras, safeEqual } from '@talos-app/integrations'
import type { IntegrationIdT } from '@talos-app/protocol'
import { ConnId, IntegrationId } from '@talos-app/protocol'
import type { HookResponse } from './ingest.ts'
import { integrationEnabled, recordMissFor } from './ingest.ts'
import { getConn, newClaimCode, secretsFor } from './store.ts'
import type { BodyRead, HooksRuntime } from './types.ts'

/** Which integrations hand their secret over through /claim is catalog metadata (`ModuleExtras.claim`), not a list here. */
export function claimsSecret(rt: HooksRuntime, id: IntegrationIdT): boolean {
  return moduleExtras(rt.module(id)).claim === true
}
export const CLAIM_TTL_MS = 30 * 60_000
const MAX_WRONG_CODES = 5

const hash = (code: string) => createHash('sha256').update(code).digest('hex')
const json = (status: number, body: unknown): HookResponse => ({
  status,
  contentType: 'application/json',
  body: JSON.stringify(body),
})

/** A fresh claim code for the connection (any earlier code stops working). Returned once; only its hash is stored. */
export function issueClaim(rt: HooksRuntime, connId: string): string {
  const code = newClaimCode()
  rt.services.db
    .prepare(
      `insert into hooks_claims (conn_id, code_hash, expires_at, attempts, used_at) values (?, ?, ?, 0, null)
       on conflict(conn_id) do update set code_hash = excluded.code_hash, expires_at = excluded.expires_at, attempts = 0, used_at = null`,
    )
    .run(connId, hash(code), rt.now() + CLAIM_TTL_MS)
  return code
}

export async function handleClaim(
  rt: HooksRuntime,
  args: {
    integration: string
    connId: string
    ip: string
    declaredLength?: number
    maxBytes: number
    /** Null when the body exceeded `maxBytes`. */
    readBody(): Promise<BodyRead>
  },
): Promise<HookResponse> {
  const idOk = IntegrationId.safeParse(args.integration)
  const conn = idOk.success && ConnId.safeParse(args.connId).success ? getConn(rt, args.connId) : null
  if (!conn || !idOk.success || conn.integration !== idOk.data || !claimsSecret(rt, conn.integration)) {
    return recordMissFor(rt, args.ip) ? json(429, { error: 'too_many_requests' }) : json(404, { error: 'not_found' })
  }
  if (!integrationEnabled(rt, conn.integration)) return json(403, { error: 'integration_disabled' })
  // The connection is known; only now is the body read, and only up to a kilobyte (anyone can POST here).
  if ((args.declaredLength ?? 0) > args.maxBytes) return json(413, { error: 'payload_too_large' })
  const bytes = await args.readBody()
  if (bytes === 'busy') return json(429, { error: 'too_many_requests', retry_after_s: 5 })
  if (bytes === 'slow') return json(408, { error: 'request_timeout' })
  if (!bytes) return json(413, { error: 'payload_too_large' })
  let body: unknown = null
  try {
    body = JSON.parse(new TextDecoder().decode(bytes))
  } catch {
    // falls through to 400
  }
  const code = (body as { claim_code?: unknown } | null)?.claim_code
  if (typeof code !== 'string' || code.length > 100) return json(400, { error: 'bad_request' })
  const { db } = rt.services
  const row = db
    .prepare('select code_hash, expires_at, attempts, used_at from hooks_claims where conn_id = ?')
    .get(conn.id) as { code_hash: string; expires_at: number; attempts: number; used_at: number | null } | undefined
  if (!row || row.used_at !== null || row.expires_at <= rt.now() || row.attempts >= MAX_WRONG_CODES)
    return json(410, { error: 'gone' })
  if (!safeEqual(hash(code), row.code_hash)) {
    db.prepare('update hooks_claims set attempts = attempts + 1 where conn_id = ?').run(conn.id)
    return json(401, { error: 'unauthorized' })
  }
  // Burn the code before the secret leaves, so a crash can only ever fail closed.
  const used = db
    .prepare('update hooks_claims set used_at = ? where conn_id = ? and used_at is null')
    .run(rt.now(), conn.id)
  if (used.changes !== 1) return json(410, { error: 'gone' })
  return json(200, { secret: secretsFor(rt, conn.id)[0] })
}
