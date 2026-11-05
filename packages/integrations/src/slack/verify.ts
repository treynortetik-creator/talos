// Slack Events API signing: `X-Slack-Signature: v0=` + hex HMAC-SHA256(signing secret, `v0:{ts}:{raw body}`) with
// `X-Slack-Request-Timestamp`, rejected when more than 5 minutes off. Dedup on `event_id` (a retry carries the same one).
import { decodeText, isRecord } from '../generic/common.ts'
import { hmacSha256, REPLAY_WINDOW_MS, safeEqual } from '../standard-webhooks.ts'
import type { VerifyConnection, VerifyRequest, VerifyResult } from '../types.ts'

export function verifySlack(req: VerifyRequest, conn: VerifyConnection): VerifyResult {
  const sig = req.headers['x-slack-signature']
  const ts = req.headers['x-slack-request-timestamp']
  if (!sig || !ts) return { ok: false, reason: 'missing_header' }
  if (!/^\d{1,12}$/.test(ts)) return { ok: false, reason: 'bad_timestamp' }
  if (Math.abs(req.now - Number(ts) * 1000) > REPLAY_WINDOW_MS) return { ok: false, reason: 'stale_timestamp' }
  if (!/^v0=[0-9a-f]{64}$/.test(sig)) return { ok: false, reason: 'bad_signature_format' }
  if (conn.secrets.length === 0) return { ok: false, reason: 'no_valid_secret' }
  for (const secret of conn.secrets) {
    const expected = `v0=${hmacSha256(secret, `v0:${ts}:`, req.rawBody).toString('hex')}`
    if (safeEqual(expected, sig)) {
      let key: string | undefined
      try {
        const j: unknown = JSON.parse(decodeText(req.rawBody))
        if (isRecord(j) && typeof j.event_id === 'string' && j.event_id) key = `slack:${j.event_id.slice(0, 64)}`
      } catch {
        /* not JSON: no delivery key */
      }
      return { ok: true, ...(key ? { deliveryKey: key } : {}) }
    }
  }
  return { ok: false, reason: 'signature_mismatch' }
}
