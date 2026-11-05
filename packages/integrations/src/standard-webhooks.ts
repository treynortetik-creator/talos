// Standard Webhooks verification and signing (spec 7.2 row `standard`), plus the constant-time and HMAC helpers every
// verifier in this package shares. Reference: OpenClaw's mcp-events protocol.ts (see THIRD_PARTY_NOTICES.md).
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import type { VerifyConnection, VerifyRequest, VerifyResult } from './types.ts'

/** Replay window for timestamped schemes (spec 7.2): 5 minutes either side. */
export const REPLAY_WINDOW_MS = 5 * 60_000

const te = new TextEncoder()

export function toBytes(v: string | Uint8Array): Uint8Array {
  return typeof v === 'string' ? te.encode(v) : v
}

export function hmacSha256(key: string | Uint8Array, ...parts: Array<string | Uint8Array>): Buffer {
  const h = createHmac('sha256', key)
  for (const p of parts) h.update(p)
  return h.digest()
}

export function sha256Hex(data: string | Uint8Array): string {
  return createHash('sha256').update(data).digest('hex')
}

/** Constant-time equality that does not leak the length either (both sides are hashed first). */
export function safeEqual(a: string | Uint8Array, b: string | Uint8Array): boolean {
  const ha = createHash('sha256').update(a).digest()
  const hb = createHash('sha256').update(b).digest()
  return timingSafeEqual(ha, hb)
}

/** Decodes `whsec_<base64>` (prefix optional) to the HMAC key. Null unless the key is 24..64 bytes (spec 7.2). */
export function decodeSecretKey(secret: string): Uint8Array | null {
  const b64 = secret.startsWith('whsec_') ? secret.slice(6) : secret
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(b64)) return null
  const key = Buffer.from(b64, 'base64')
  return key.length >= 24 && key.length <= 64 ? new Uint8Array(key) : null
}

/** A fresh signing secret: `whsec_` + base64 of 32 random bytes. */
export function newWebhookSecret(): string {
  return `whsec_${randomBytes(32).toString('base64')}`
}

/** Headers a Standard Webhooks sender adds. Used by the relay's `/test` and by the tests. */
export function signStandard(args: {
  secret: string
  id: string
  /** Unix seconds. */
  timestampS: number
  body: string | Uint8Array
}): Record<string, string> {
  const key = decodeSecretKey(args.secret)
  if (!key) throw new Error('invalid webhook secret')
  const mac = hmacSha256(key, `${args.id}.${args.timestampS}.`, toBytes(args.body))
  return {
    'webhook-id': args.id,
    'webhook-timestamp': String(args.timestampS),
    'webhook-signature': `v1,${mac.toString('base64')}`,
  }
}

export function hasStandardHeaders(headers: Record<string, string>): boolean {
  return Boolean(headers['webhook-id'] || headers['webhook-timestamp'] || headers['webhook-signature'])
}

/**
 * Verifies the three `webhook-*` headers against every secret (current first, then the one still valid after rotation).
 * `webhook-signature` may hold several space-separated `v1,<base64>` entries; any match passes.
 */
export function verifyStandard(req: VerifyRequest, conn: Pick<VerifyConnection, 'secrets'>): VerifyResult {
  const id = req.headers['webhook-id']
  const ts = req.headers['webhook-timestamp']
  const sigHeader = req.headers['webhook-signature']
  if (!id || !ts || !sigHeader) return { ok: false, reason: 'missing_header' }
  if (id.length > 256) return { ok: false, reason: 'bad_id' }
  if (!/^\d{1,12}$/.test(ts)) return { ok: false, reason: 'bad_timestamp' }
  if (Math.abs(req.now - Number(ts) * 1000) > REPLAY_WINDOW_MS) return { ok: false, reason: 'stale_timestamp' }
  const sigs = sigHeader
    .split(' ')
    .filter(Boolean)
    .map((s) => s.split(','))
    .filter((p) => p.length === 2 && p[0] === 'v1')
    .map((p) => p[1] as string)
  if (sigs.length === 0) return { ok: false, reason: 'no_v1_signature' }
  let usable = false
  for (const secret of conn.secrets) {
    const key = decodeSecretKey(secret)
    if (!key) continue
    usable = true
    const expected = hmacSha256(key, `${id}.${ts}.`, req.rawBody).toString('base64')
    for (const s of sigs) if (safeEqual(expected, s)) return { ok: true, deliveryKey: `wh:${id}` }
  }
  return { ok: false, reason: usable ? 'signature_mismatch' : 'no_valid_secret' }
}
