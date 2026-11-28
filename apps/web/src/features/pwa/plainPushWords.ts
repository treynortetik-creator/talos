// The words for "Why was that push plain?": one short line under the iPhone notifications row. Every reason code the relay or
// the phone can report (PLAIN_PUSH_REASONS, packages/protocol) has its own sentence here, and this is the only file that holds them.
import { PHONE_PLAIN_REASONS, type PhonePlainReasonT, type PlainPushReasonT } from '@talos-app/protocol'
import type { PhonePlain } from '../../lib/nativePush.ts'

export const LAST_PUSH_SHOWED_TEXT = 'Last push showed its text.'
const PLAIN = 'Last push was plain'

/** What each cause reads like after "Last push was plain: ". Short, and in the owner's words. */
export const PLAIN_PUSH_WORDS: Record<PlainPushReasonT, string> = {
  no_grant: 'message text is off for this phone.',
  grant_expired: "this phone's permission to show text ran out. Open Talos to renew it.",
  grant_bad: "your relay's key for this phone is not usable. Turn text off and on again.",
  seal_failed: 'your relay could not prepare the message text.',
  too_big: 'the message was too long to send with its text.',
  grant_changed: 'the text setting changed while it was sending.',
  phone_no_key: 'this phone has no key to open the message. Turn text off and on again.',
  phone_open_failed: "this phone couldn't open the message.",
  phone_timed_out: 'this phone took too long to open the message.',
}

const isReason = (r: unknown): r is PlainPushReasonT => typeof r === 'string' && r in PLAIN_PUSH_WORDS
const plain = (reason: unknown) => (isReason(reason) ? `${PLAIN}: ${PLAIN_PUSH_WORDS[reason]}` : `${PLAIN}.`)

/**
 * The line for the last message push, or null when there has been none. The relay says how the push left. If it left with its
 * text and the phone reports that it could not open THAT push's seal (same id), the phone's reason is the one. A phone report
 * about any other push is not about this one, so it is ignored. With no relay row at all, a phone report stands alone.
 */
export function lastPushLine(
  last: { rich: boolean; reason?: string; id?: string; at: string } | null | undefined,
  reported: PhonePlain | null,
): string | null {
  const phone = reported && PHONE_PLAIN_REASONS.includes(reported.reason as PhonePlainReasonT) ? reported : null
  if (!last) return phone ? plain(phone.reason) : null
  if (!last.rich) return plain(last.reason)
  return phone && last.id !== undefined && phone.id === last.id ? plain(phone.reason) : LAST_PUSH_SHOWED_TEXT
}
