// Zoom webhooks: `x-zm-signature: v0=` + hex HMAC-SHA256(secret token, `v0:{x-zm-request-timestamp}:{raw body}`), 5 minute
// window. Dedup on `event + payload.object.uuid`. The URL validation reply is `{plainToken, encryptedToken}` with
// `encryptedToken` = hex HMAC-SHA256(secret token, plainToken).
import { decodeText, isRecord } from '../generic/common.ts'
import { hmacSha256, REPLAY_WINDOW_MS, safeEqual } from '../standard-webhooks.ts'
import type { HandshakeResponse, RawDelivery, VerifyConnection, VerifyRequest, VerifyResult } from '../types.ts'

function checkSignature(
  headers: Record<string, string>,
  rawBody: Uint8Array,
  now: number,
  secrets: string[],
): VerifyResult {
  const sig = headers['x-zm-signature']
  const ts = headers['x-zm-request-timestamp']
  if (!sig || !ts) return { ok: false, reason: 'missing_header' }
  if (!/^\d{1,12}$/.test(ts)) return { ok: false, reason: 'bad_timestamp' }
  if (Math.abs(now - Number(ts) * 1000) > REPLAY_WINDOW_MS) return { ok: false, reason: 'stale_timestamp' }
  if (!/^v0=[0-9a-f]{64}$/.test(sig)) return { ok: false, reason: 'bad_signature_format' }
  if (secrets.length === 0) return { ok: false, reason: 'no_valid_secret' }
  for (const secret of secrets) {
    if (safeEqual(`v0=${hmacSha256(secret, `v0:${ts}:`, rawBody).toString('hex')}`, sig)) return { ok: true }
  }
  return { ok: false, reason: 'signature_mismatch' }
}

function bodyJson(rawBody: Uint8Array): unknown {
  try {
    return JSON.parse(decodeText(rawBody))
  } catch {
    return undefined
  }
}

export function verifyZoom(req: VerifyRequest, conn: VerifyConnection): VerifyResult {
  const r = checkSignature(req.headers, req.rawBody, req.now, conn.secrets)
  if (!r.ok) return r
  const j = bodyJson(req.rawBody)
  if (!isRecord(j) || typeof j.event !== 'string') return { ok: false, reason: 'bad_body' }
  const obj = isRecord(j.payload) && isRecord(j.payload.object) ? j.payload.object : {}
  const uuid = typeof obj.uuid === 'string' ? obj.uuid : ''
  return {
    ok: true,
    deliveryKey: `zoom:${j.event}:${uuid || (req.headers['x-zm-request-timestamp'] ?? '')}`.slice(0, 200),
  }
}

/**
 * `endpoint.url_validation`. The reply is an HMAC of a caller-chosen string under the secret token, so it is only given for
 * a plain token of the shape Zoom sends (letters, digits, `_`, `-`). A string like `v0:<ts>:<body>` is refused, which keeps
 * this from being used to mint a valid `x-zm-signature`. When the request carries signature headers they must also be valid.
 */
export function zoomHandshake(
  raw: RawDelivery,
  conn: VerifyConnection,
  now = raw.receivedAt,
): HandshakeResponse | null {
  const j = raw.json ?? bodyJson(raw.rawBody)
  if (!isRecord(j) || j.event !== 'endpoint.url_validation') return null
  const plain = isRecord(j.payload) ? j.payload.plainToken : undefined
  const secret = conn.secrets[0]
  const bad = { status: 400, contentType: 'application/json', body: '{"error":"bad_validation"}' }
  if (typeof plain !== 'string' || !/^[A-Za-z0-9_-]{8,128}$/.test(plain) || !secret) return bad
  if (raw.headers['x-zm-signature'] && !checkSignature(raw.headers, raw.rawBody, now, conn.secrets).ok) return bad
  return {
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({ plainToken: plain, encryptedToken: hmacSha256(secret, plain).toString('hex') }),
  }
}
