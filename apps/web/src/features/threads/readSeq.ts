import type { ClientState } from '../../lib/client.ts'

/**
 * The seq a "mark read" should carry. `lastSeq` is 0 on a device that has not caught up yet (a fresh pairing, a long
 * absence), and the relay only ever raises a read mark, so 0 would leave the unread in place: the relay's own newest seq
 * at the last `ready` stands in for it.
 */
export const readUpTo = (st: Pick<ClientState, 'lastSeq' | 'serverSeq'>): number =>
  Math.max(st.lastSeq, st.serverSeq ?? 0)
