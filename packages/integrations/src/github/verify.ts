import type { VerifyResult } from '../types.ts'

/** Polled notifications never go through `verify`; a POST without `X-GitHub-Event` is not ours. */
export function verifyPollOnly(): VerifyResult {
  return { ok: false, reason: 'poll_only' }
}
