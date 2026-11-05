// Jira inbound POSTs: the Automation "Send web request" rule sends `Authorization: Bearer <secret>`; an admin webhook sends
// `X-Hub-Signature: sha256=<hex HMAC-SHA256(secret, raw body)>` with `X-Atlassian-Webhook-Identifier`. Polled items never
// pass through here. Neither path has a timestamp, so replays are stopped by the dedup key.
import { hmacSha256, safeEqual, sha256Hex } from '../standard-webhooks.ts'
import type { VerifyConnection, VerifyRequest, VerifyResult } from '../types.ts'

export function verifyJira(req: VerifyRequest, conn: VerifyConnection): VerifyResult {
  if (conn.secrets.length === 0) return { ok: false, reason: 'no_valid_secret' }
  const auth = req.headers.authorization
  const hub = req.headers['x-hub-signature']
  if (!auth && !hub) return { ok: false, reason: 'missing_header' }
  if (auth) {
    const m = /^Bearer\s+(.+)$/i.exec(auth.trim())
    if (!m) return { ok: false, reason: 'bad_authorization' }
    const given = m[1] as string
    let ok = false
    for (const s of conn.secrets) if (safeEqual(s, given)) ok = true
    if (!ok) return { ok: false, reason: 'secret_mismatch' }
    const key = req.headers['idempotency-key'] ?? req.headers['webhook-id'] ?? sha256Hex(req.rawBody)
    return { ok: true, deliveryKey: `jira:${key.slice(0, 128)}` }
  }
  const m = /^(sha256)=([0-9a-f]{64})$/i.exec((hub as string).trim())
  if (!m) return { ok: false, reason: 'bad_signature_format' }
  const given = (m[2] as string).toLowerCase()
  for (const s of conn.secrets) {
    if (safeEqual(hmacSha256(s, req.rawBody).toString('hex'), given)) {
      const id = req.headers['x-atlassian-webhook-identifier']
      return { ok: true, deliveryKey: `jira:${(id ?? sha256Hex(req.rawBody)).slice(0, 128)}` }
    }
  }
  return { ok: false, reason: 'signature_mismatch' }
}
