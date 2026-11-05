// Card checks the relay makes before it forwards a `card.resolve` to the bridge (spec 3.4, 10.4). The Mac stays the
// authority (4.5); these checks stop replays, stale and tampered resolves early and give the app a precise error.
import {
  bindingFrom,
  type CardT,
  checkEditAllowed,
  type ErrorCodeT,
  editedHash,
  type FrameOf,
  payloadHash,
  validateCard,
} from '@talos-app/protocol'
import type { Clock } from '../services.ts'
import type { Store } from './store.ts'

export type ResolveCheck = { ok: true; card: CardT } | { ok: false; code: ErrorCodeT; message: string; expired?: CardT }

export function checkResolve(store: Store, clock: Clock, frame: FrameOf<'card.resolve'>): ResolveCheck {
  const card = store.getCard(frame.card_id)
  if (!card) return { ok: false, code: 'card_not_pending', message: 'unknown card' }
  if (card.state === 'expired') return { ok: false, code: 'card_expired', message: 'card expired' }
  if (card.state !== 'pending') return { ok: false, code: 'card_not_pending', message: `card is ${card.state}` }
  if (Date.parse(card.expires_at) <= clock.now()) {
    return { ok: false, code: 'card_expired', message: 'card expired', expired: card }
  }
  if (frame.payload_hash !== card.payload_hash) {
    return { ok: false, code: 'card_hash_mismatch', message: 'the card changed since it was rendered' }
  }
  if (frame.edited) {
    if (frame.action !== 'primary')
      return { ok: false, code: 'card_edit_forbidden', message: 'edits only apply to the primary action' }
    const binding = bindingFrom(card)
    const allowed = checkEditAllowed(binding, frame.edited)
    if (!allowed.ok) return { ok: false, code: 'card_edit_forbidden', message: allowed.reason }
    if (frame.edited_hash !== editedHash(binding, frame.edited)) {
      return { ok: false, code: 'card_hash_mismatch', message: 'edited_hash does not match the edits' }
    }
  }
  return { ok: true, card }
}

/** Integrity of a card the bridge creates: the rules the schema cannot express, and a correct payload_hash. */
export function checkNewCard(card: CardT): string | null {
  if (card.state !== 'pending') return 'a new card must be pending'
  const issues = validateCard(card)
  if (issues.length > 0) return issues.join(', ')
  if (card.payload_hash !== payloadHash(bindingFrom(card))) return 'payload_hash does not match the card'
  return null
}
