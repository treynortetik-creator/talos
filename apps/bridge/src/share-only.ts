import type { MessageT } from '@talos-app/protocol'

/** True for an owner-row that holds shared material and none of the owner's own words (the one rule trust.ts and the clock share). */
export const isShareOnly = (m: Pick<MessageT, 'via' | 'share_content' | 'text'>): boolean =>
  m.via === 'share' || (m.share_content !== undefined && !(m.text ?? '').trim())
