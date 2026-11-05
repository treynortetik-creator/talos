// Helpers shared by the WP3 normalizers: text cleaning, URL safety, event construction, JSON pointers.
import { HttpsUrl, type IntegrationIdT, type NormalizedEventT, newId } from '@talos-app/protocol'
import type { NormalizeConnection, RawDelivery } from '../types.ts'

// biome-ignore lint/suspicious/noControlCharactersInRegex: stripping control characters is the point
const CONTROL = /[\u0000-\u0008\u000B-\u001F\u007F-\u009F​-‏‪-‮⁦-⁩]/g

/** Plain text, no control or bidi characters, whitespace collapsed, at most `max` characters. */
export function clean(input: unknown, max: number): string {
  const s = typeof input === 'string' ? input : input == null ? '' : String(input)
  const t = s.replace(CONTROL, ' ').replace(/\s+/g, ' ').trim()
  return t.length <= max ? t : `${t.slice(0, Math.max(0, max - 1)).trimEnd()}…`
}

/** Only http(s) URLs survive (javascript:, data:, etc. are dropped); the same check the protocol applies. */
export function safeUrl(input: unknown): string | undefined {
  if (typeof input !== 'string') return undefined
  const r = HttpsUrl.safeParse(input.trim())
  return r.success ? r.data : undefined
}

export function decodeText(bytes: Uint8Array): string {
  return new TextDecoder('utf-8', { fatal: false }).decode(bytes)
}

export function parseJson(raw: RawDelivery): unknown {
  if (raw.json !== undefined) return raw.json
  try {
    return JSON.parse(decodeText(raw.rawBody))
  } catch {
    return undefined
  }
}

export function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

/** RFC 6901 pointer lookup. Returns undefined for anything missing or malformed. */
export function getPointer(doc: unknown, pointer: string): unknown {
  if (pointer === '') return doc
  if (!pointer.startsWith('/')) return undefined
  let cur: unknown = doc
  for (const raw of pointer.slice(1).split('/')) {
    const key = raw.replace(/~1/g, '/').replace(/~0/g, '~')
    if (Array.isArray(cur)) {
      if (!/^\d+$/.test(key)) return undefined
      cur = cur[Number(key)]
    } else if (isRecord(cur) && Object.hasOwn(cur, key)) cur = cur[key]
    else return undefined
  }
  return cur
}

const MAX_ISO_MS = 253_402_300_799_999

/** ISO timestamp from an ISO string, epoch seconds or epoch milliseconds; `fallbackMs` otherwise. */
export function toIso(v: unknown, fallbackMs: number): string {
  let ms: number | undefined
  if (typeof v === 'number' && Number.isFinite(v)) ms = v < 1e12 ? v * 1000 : v
  else if (typeof v === 'string' && v.trim()) {
    const p = Date.parse(v)
    if (!Number.isNaN(p)) ms = p
  }
  // 9999-12-31T23:59:59.999Z: past it `toISOString()` prints a `+YYYYYY` year the protocol's IsoTs refuses.
  if (ms === undefined || ms < 0 || ms > MAX_ISO_MS) ms = fallbackMs
  return new Date(ms).toISOString()
}

export type EventParts = {
  kind: string
  title: string
  summary: string
  url?: unknown
  actor?: NormalizedEventT['actor']
  ts: string
  priority: NormalizedEventT['priority']
  dedup_key: string
}

/** Builds a NormalizedEvent from a connection and the source-specific parts, clamping every string to its limit. */
export function makeEvent(conn: NormalizeConnection, source: IntegrationIdT, p: EventParts): NormalizedEventT {
  const title = clean(p.title, 200) || '(untitled)'
  const url = safeUrl(p.url)
  const actor: NormalizedEventT['actor'] = {}
  if (p.actor?.name) actor.name = clean(p.actor.name, 120)
  if (p.actor?.id) actor.id = clean(p.actor.id, 120)
  if (p.actor?.email) actor.email = clean(p.actor.email, 200)
  return {
    id: newId('e'),
    source,
    connection: conn.id,
    kind: p.kind,
    title,
    summary: clean(p.summary, 280) || title,
    ...(url ? { url } : {}),
    actor,
    ts: p.ts,
    thread: conn.thread,
    work: conn.work,
    priority: p.priority,
    dedup_key: p.dedup_key.slice(0, 300),
  }
}

/** "Alex Example <alex@example.com>" -> { name, email }. */
export function parseAddress(from: string): { name?: string; email?: string } {
  const m = /^\s*"?([^"<]*?)"?\s*<([^>]+)>\s*$/.exec(from)
  if (m) {
    const name = (m[1] ?? '').trim()
    const email = (m[2] ?? '').trim()
    return { ...(name ? { name } : {}), ...(email ? { email } : {}) }
  }
  const bare = from.trim()
  return /^[^\s@]+@[^\s@]+$/.test(bare) ? { email: bare } : bare ? { name: bare } : {}
}

/**
 * Optional extras a module may carry beyond `IntegrationModule` (the interface is a frozen seam). The relay reads them
 * through `moduleExtras()` and works without them.
 */
export interface ModuleExtras {
  /** Per-connection toggle (a `setup.filters` key). Return false to drop `event` while that toggle is `enabled`/disabled. */
  toggle?(key: string, enabled: boolean, event: NormalizedEventT, conn: NormalizeConnection): boolean
  /** A JSON body for the connection "Test" button. Only for push-style modules the relay can sign for. */
  sample?(conn: NormalizeConnection): Record<string, unknown>
  /** A non-JSON acknowledgement (Salesforce wants a SOAP `<Ack>true</Ack>`). */
  ack?(): { contentType: string; body: string }
  /**
   * Name of the secret wizard field (`setup.connect` key, stored encrypted in creds) that holds the VENDOR's signing
   * secret. When set, the relay verifies with that value instead of its own generated `whsec_` (Slack, Zoom, Stripe).
   */
  verifySecretField?: string
  /**
   * One-time provisioning at the end of setup (Linear, Calendly): registers the webhook with the vendor using the key the
   * owner pasted, then the relay forgets the key (`forget` lists the secret fields to delete from the stored credentials).
   * `secret` is the connection's own signing secret; `hookUrl` is the public endpoint. Never throws.
   */
  provision?(args: {
    fetch: typeof fetch
    hookUrl: string
    secret: string
    secrets: Record<string, string>
    extra: Record<string, string>
  }): Promise<{ ok: boolean; error?: string; forget: string[] }>
  /** True when the module's Apps Script trades a one-time claim code for the signing secret (`POST .../claim`). */
  claim?: boolean
}
