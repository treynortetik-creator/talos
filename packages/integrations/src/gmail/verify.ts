// Gmail rides on the Standard Webhooks scheme (spec 7.2 `standard`).
import { verifyStandard } from '../standard-webhooks.ts'
import type { VerifyConnection, VerifyRequest, VerifyResult } from '../types.ts'

export function verifyGmail(req: VerifyRequest, conn: VerifyConnection): VerifyResult {
  return verifyStandard(req, conn)
}
