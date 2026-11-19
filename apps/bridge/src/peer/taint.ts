// The peer taint: while a message from a linked agent may still be what main is working on, main may send only back to that
// agent. A Run tap is an approval and a share with no typed words is outside material, so neither ends it. The bridge cannot see where a turn ends, so the taint ends only when the owner speaks to main (the same line
// noteOutsideText / ownerAskedAt draw in trust.ts). A card decision does not end it: it answers a card, it is not new words.
// Kept in kv so a restart does not forget it.
import type { BridgeContext } from '../context.ts'

const KEY = 'peer_taint'

export type PeerTaint = {
  /** The linked agents whose messages reached main since the owner last spoke to it. */
  peers: string[]
  /** The newest of those messages, and the chain this Mac computed for it. */
  last_msg_id: string
  chain: number
  at: number
}

export function readTaint(ctx: Pick<BridgeContext, 'store'>): PeerTaint | undefined {
  try {
    const v = JSON.parse(ctx.store.kvGet(KEY) ?? 'null') as Partial<PeerTaint> | null
    if (v && Array.isArray(v.peers) && v.peers.length > 0 && typeof v.last_msg_id === 'string')
      return {
        peers: v.peers.filter((p): p is string => typeof p === 'string'),
        last_msg_id: v.last_msg_id,
        chain: Number(v.chain) || 0,
        at: Number(v.at) || 0,
      }
  } catch {
    // unreadable: no taint is kept, the same as none
  }
  return undefined
}

/** Kinds that are the owner's own words to main: typed, spoken, a voice note, a file, a call, a Run tap, a backlog of them. */
const OWNER_WORDS = new Set(['text', 'voice_note', 'file', 'voice_delegation', 'backlog'])

/** Called for every notification handed to the main session. */
export function notePeerTaint(ctx: Pick<BridgeContext, 'store' | 'clock'>, n: { meta: Record<string, string> }): void {
  const { kind, trust, peer } = n.meta
  try {
    if (kind === 'peer_message' && peer) {
      const peers = new Set(readTaint(ctx)?.peers ?? [])
      peers.add(peer)
      const taint: PeerTaint = {
        peers: [...peers],
        last_msg_id: n.meta.peer_msg_id ?? '',
        chain: Number(n.meta.chain) || 0,
        at: ctx.clock.now(),
      }
      ctx.store.kvSet(KEY, JSON.stringify(taint))
    } else if (
      (trust === 'owner' || trust === 'owner_voice') &&
      OWNER_WORDS.has(kind ?? '') &&
      !n.meta.run &&
      n.meta.share_only !== 'true'
    ) {
      ctx.store.kvDelete(KEY)
    }
  } catch {
    // a store that refuses the write: the taint is judged on what was kept
  }
}
