// The heartbeat's card limits (HB4). They key on the heartbeat's own THREAD, never on a run id or an origin the agent names: every
// card made in that thread is a heartbeat card. There is no list of such cards to keep; the pending ones are counted from the
// card ledger at the moment a card is made, in the same step that makes it.

/** Pending cards allowed at once in a heartbeat's thread. The next item becomes a plain line. */
export const MAX_PENDING_CARDS = 3
/** A card in a heartbeat's thread lives a day at most: it must not outlast the reason it was made. */
export const CARD_EXPIRY_S = 86_400
