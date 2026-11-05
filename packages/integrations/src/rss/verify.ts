import type { VerifyResult } from '../types.ts'

/** RSS is poll-only; nothing may be POSTed to it. */
export function verifyRss(): VerifyResult {
  return { ok: false, reason: 'poll_only' }
}
