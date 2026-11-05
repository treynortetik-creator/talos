// All SQL for connections, secrets, deliveries and dedup. Secrets and credentials are encrypted with the relay's
// CryptoService (AAD = table + row id + purpose) and never logged.
import { randomBytes } from 'node:crypto'
import { newWebhookSecret } from '@talos-app/integrations'
import type { IntegrationIdT } from '@talos-app/protocol'
import { newConnectionId } from '@talos-app/protocol'
import type { AdvancedFilter, ConnRow, HooksRuntime } from './types.ts'
import { DAY_MS, HOUR_MS, OLD_SECRET_GRACE_MS } from './types.ts'

const te = new TextEncoder()
const td = new TextDecoder()

type DbConn = {
  id: string
  integration: IntegrationIdT
  name: string
  thread: string
  status: ConnRow['status']
  paused_reason: string | null
  filters: string
  advanced: string
  extra: string
  created_at: number
  last_event_at: number | null
}

export function toConn(r: DbConn): ConnRow {
  return {
    id: r.id,
    integration: r.integration,
    name: r.name,
    thread: r.thread,
    status: r.status,
    paused_reason: r.paused_reason,
    filters: JSON.parse(r.filters) as Record<string, boolean>,
    advanced: JSON.parse(r.advanced) as AdvancedFilter[],
    extra: JSON.parse(r.extra) as Record<string, string>,
    created_at: r.created_at,
    last_event_at: r.last_event_at,
  }
}

const COLS = 'id, integration, name, thread, status, paused_reason, filters, advanced, extra, created_at, last_event_at'

export function getConn(rt: HooksRuntime, id: string): ConnRow | null {
  const r = rt.services.db.prepare(`select ${COLS} from hooks_connections where id = ?`).get(id) as DbConn | undefined
  return r ? toConn(r) : null
}

export function listConns(rt: HooksRuntime): ConnRow[] {
  const rows = rt.services.db.prepare(`select ${COLS} from hooks_connections order by created_at, id`).all() as DbConn[]
  return rows.map(toConn)
}

export function countConns(rt: HooksRuntime): number {
  return (rt.services.db.prepare('select count(*) as n from hooks_connections').get() as { n: number }).n
}

export function newClaimCode(): string {
  return newConnectionId().slice(3)
}

function enc(rt: HooksRuntime, text: string, id: string, purpose: string): Buffer {
  return Buffer.from(rt.services.crypto.encrypt(te.encode(text), `hooks_connections:${id}:${purpose}`))
}
function dec(rt: HooksRuntime, blob: Uint8Array, id: string, purpose: string): string {
  return td.decode(rt.services.crypto.decrypt(blob, `hooks_connections:${id}:${purpose}`))
}

export function insertConn(
  rt: HooksRuntime,
  c: {
    integration: IntegrationIdT
    name: string
    thread: string
    filters: Record<string, boolean>
    advanced: AdvancedFilter[]
    extra: Record<string, string>
    creds: Record<string, string>
  },
): { id: string; secret: string } {
  const id = newConnectionId()
  const secret = newWebhookSecret()
  rt.services.db
    .prepare(
      `insert into hooks_connections (id, integration, name, thread, status, filters, advanced, extra, secret_enc, creds_enc, created_at)
       values (?, ?, ?, ?, 'active', ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      id,
      c.integration,
      c.name,
      c.thread,
      JSON.stringify(c.filters),
      JSON.stringify(c.advanced),
      JSON.stringify(c.extra),
      enc(rt, secret, id, 'secret'),
      enc(rt, JSON.stringify(c.creds), id, 'creds'),
      rt.now(),
    )
  return { id, secret }
}

/** Current secret first; the previous one while its 24 h grace lasts. */
export function secretsFor(rt: HooksRuntime, id: string): string[] {
  const r = rt.services.db
    .prepare('select secret_enc, old_secret_enc, old_secret_expires_at from hooks_connections where id = ?')
    .get(id) as { secret_enc: Buffer; old_secret_enc: Buffer | null; old_secret_expires_at: number | null } | undefined
  if (!r) return []
  const out = [dec(rt, r.secret_enc, id, 'secret')]
  if (r.old_secret_enc && r.old_secret_expires_at && r.old_secret_expires_at > rt.now())
    out.push(dec(rt, r.old_secret_enc, id, 'old_secret'))
  return out
}

export function rotateSecret(rt: HooksRuntime, id: string): string {
  const cur = secretsFor(rt, id)[0]
  if (!cur) throw new Error('no such connection')
  const next = newWebhookSecret()
  rt.services.db
    .prepare('update hooks_connections set secret_enc = ?, old_secret_enc = ?, old_secret_expires_at = ? where id = ?')
    .run(enc(rt, next, id, 'secret'), enc(rt, cur, id, 'old_secret'), rt.now() + OLD_SECRET_GRACE_MS, id)
  return next
}

export function credsFor(rt: HooksRuntime, id: string): Record<string, string> {
  const r = rt.services.db.prepare('select creds_enc from hooks_connections where id = ?').get(id) as
    | { creds_enc: Buffer | null }
    | undefined
  if (!r?.creds_enc) return {}
  return JSON.parse(dec(rt, r.creds_enc, id, 'creds')) as Record<string, string>
}

export function saveCreds(rt: HooksRuntime, id: string, creds: Record<string, string>): void {
  rt.services.db
    .prepare('update hooks_connections set creds_enc = ? where id = ?')
    .run(enc(rt, JSON.stringify(creds), id, 'creds'), id)
}

export function updateConn(
  rt: HooksRuntime,
  id: string,
  patch: Partial<Pick<ConnRow, 'name' | 'thread' | 'status' | 'filters' | 'advanced' | 'extra' | 'paused_reason'>>,
): void {
  const sets: string[] = []
  const args: unknown[] = []
  for (const [k, v] of Object.entries(patch)) {
    sets.push(`${k} = ?`)
    args.push(typeof v === 'object' && v !== null ? JSON.stringify(v) : v)
  }
  if (sets.length === 0) return
  rt.services.db.prepare(`update hooks_connections set ${sets.join(', ')} where id = ?`).run(...args, id)
}

export function deleteConn(rt: HooksRuntime, id: string): void {
  const db = rt.services.db
  db.transaction(() => {
    for (const t of ['hooks_inbound', 'hooks_deliveries', 'hooks_events', 'hooks_claims', 'hooks_poll_state'])
      db.prepare(`delete from ${t} where conn_id = ?`).run(id)
    db.prepare("delete from hooks_dedup where key like ? escape '\\'").run(`%:${id}:%`)
    db.prepare('delete from hooks_connections where id = ?').run(id)
  })()
}

// ---- deliveries ------------------------------------------------------------------------------------------------

export function addDelivery(
  rt: HooksRuntime,
  connId: string,
  status: number,
  reason?: string,
  counts?: { received: number; kept: number },
): number {
  const r = rt.services.db
    .prepare('insert into hooks_deliveries (conn_id, at, status, reason, received, kept) values (?, ?, ?, ?, ?, ?)')
    .run(connId, rt.now(), status, reason ?? null, counts?.received ?? 0, counts?.kept ?? 0)
  return Number(r.lastInsertRowid)
}

export function stats24h(rt: HooksRuntime, connId: string): { received: number; kept: number } {
  const r = rt.services.db
    .prepare(
      'select coalesce(sum(received), 0) as received, coalesce(sum(kept), 0) as kept from hooks_deliveries where conn_id = ? and at >= ?',
    )
    .get(connId, rt.now() - DAY_MS) as { received: number; kept: number }
  return r
}

export function deliveriesInLastHour(rt: HooksRuntime, connId: string): number {
  return (
    rt.services.db
      .prepare("select count(*) as n from hooks_deliveries where conn_id = ? and at >= ? and reason in ('ok', 'poll')")
      .get(connId, rt.now() - HOUR_MS) as { n: number }
  ).n
}

// ---- dedup -----------------------------------------------------------------------------------------------------

/** True when the key is new (and now recorded). */
export function dedupFirstSeen(rt: HooksRuntime, key: string, ttlMs: number): boolean {
  const now = rt.now()
  const r = rt.services.db
    .prepare('insert or ignore into hooks_dedup (key, seen_at, expires_at) values (?, ?, ?)')
    .run(key.slice(0, 400), now, now + ttlMs)
  if (r.changes === 1) return true
  // An expired row that has not been purged yet counts as unseen.
  const u = rt.services.db
    .prepare('update hooks_dedup set seen_at = ?, expires_at = ? where key = ? and expires_at <= ?')
    .run(now, now + ttlMs, key.slice(0, 400), now)
  return u.changes === 1
}

export function randomId(prefix: string): string {
  return `${prefix}_${randomBytes(12).toString('hex')}`
}
