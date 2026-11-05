// `generic` verifier (spec 7.2): `Authorization: Bearer <secret>` OR Standard Webhooks headers.
import { hasStandardHeaders, safeEqual, sha256Hex, verifyStandard } from '../standard-webhooks.ts'
import type { VerifyConnection, VerifyRequest, VerifyResult } from '../types.ts'

export function verifyGeneric(req: VerifyRequest, conn: VerifyConnection): VerifyResult {
  if (hasStandardHeaders(req.headers)) return verifyStandard(req, conn)
  const auth = req.headers.authorization
  if (!auth) return { ok: false, reason: 'missing_header' }
  const m = /^Bearer[ \t]+(\S+)$/i.exec(auth)
  if (!m) return { ok: false, reason: 'bad_authorization' }
  const token = m[1] as string
  let ok = false
  for (const s of conn.secrets) if (safeEqual(token, s)) ok = true // no early exit: same work for every secret
  if (!ok) return { ok: false, reason: 'secret_mismatch' }
  const key = req.headers['idempotency-key']
  return { ok: true, deliveryKey: key ? `idem:${key.slice(0, 256)}` : `body:${sha256Hex(req.rawBody)}` }
}
