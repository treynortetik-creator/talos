// The cards a FakeRelay carries, with the relay's own rules about them (core/cards.ts checkResolve, core/hub.ts
// rollbackRejectedResolve and expireCard). An entry stays after the card is decided, like the real store, so a late
// resolve is told why it is refused.
import { bindingFrom, type CardT, type FrameOf, payloadHash, validateCard } from '@talos-app/protocol'

type Held = { card: CardT } & Pick<CardT, 'state'> & Partial<Pick<CardT, 'resolution' | 'result'>>

export type ResolveRefusal = { code: string; message: string; expired?: CardT }

/** Errors from the Mac that mean it did not act on a card.resolve (hub.ts: the card goes back to pending). */
export const RESOLVE_REFUSALS = ['sig_invalid', 'device_not_pinned', 'unauthorized', 'bad_frame']

export class RelayCards {
  private cards = new Map<string, Held>()

  constructor(private readonly clock: () => number) {}

  /** A stored card (a card.create is an upsert, like `putCard`). */
  put(card: CardT) {
    this.cards.set(card.id, { card, state: card.state })
  }

  get(id: string): Held | undefined {
    return this.cards.get(id)
  }

  /** The Mac's card.update is the card's new state (hub.ts setCardState). False when the card is unknown. */
  update(id: string, patch: Pick<Held, 'state'> & Partial<Pick<CardT, 'resolution' | 'result'>>): boolean {
    const held = this.cards.get(id)
    if (!held) return false
    held.state = patch.state
    if (patch.resolution) held.resolution = patch.resolution
    if (patch.result) held.result = patch.result
    return true
  }

  /**
   * The checks after step-up, in the real order: expired by state, not pending, expired by the clock, then the hash. A card
   * that lapsed by the clock is marked expired here and handed back so the caller can tell the apps.
   */
  checkResolve(frame: FrameOf<'card.resolve'>): ResolveRefusal | null {
    const held = this.cards.get(frame.card_id)
    if (!held) return { code: 'card_not_pending', message: 'unknown card' }
    if (held.state === 'expired') return { code: 'card_expired', message: 'card expired' }
    if (held.state !== 'pending') return { code: 'card_not_pending', message: `card is ${held.state}` }
    if (Date.parse(held.card.expires_at) <= this.clock()) {
      return { code: 'card_expired', message: 'card expired', expired: held.card }
    }
    if (frame.payload_hash !== held.card.payload_hash)
      return { code: 'card_hash_mismatch', message: 'the card changed since it was rendered' }
    return null
  }

  /** A card past its expiry is expired once. True when this call did it, so the apps are told once. */
  expire(id: string): boolean {
    const held = this.cards.get(id)
    if (held?.state !== 'pending') return false
    held.state = 'expired'
    return true
  }

  /**
   * The Mac refused a card.resolve before acting on it. Only a card that is `resolved` with no resolution and no result is
   * touched (a card the Mac did decide is left alone); one past its expiry goes expired instead. Returns the card.update
   * the relay would stamp and fan out, or null when nothing changed.
   */
  rollbackRejected(cardId: string, reason: string): Record<string, unknown> | null {
    const held = this.cards.get(cardId)
    if (held?.state !== 'resolved' || held.resolution || held.result) return null
    const expired = Date.parse(held.card.expires_at) <= this.clock()
    held.state = expired ? 'expired' : 'pending'
    return { card_id: cardId, state: held.state, reason: expired ? 'expired' : reason }
  }
}

/** The relay's integrity check on a card the Mac creates (core/cards.ts checkNewCard). */
export function cardProblem(card: CardT): string | null {
  if (card.state !== 'pending') return 'a new card must be pending'
  const issues = validateCard(card)
  if (issues.length > 0) return issues.join(', ')
  if (card.payload_hash !== payloadHash(bindingFrom(card))) return 'payload_hash does not match the card'
  return null
}
