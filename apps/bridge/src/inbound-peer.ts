// A `peer.message` frame: a message another install of the owner sent to this one (linked agents). The relay checked the
// signature, the body and the caps; this Mac checks that the connection is still its own, works out the chain from its own
// records, and hands the text to the main session as outside data. It approves nothing and wakes no phone.
import { PEER_CHAIN_MAX } from '@talos-app/protocol'
import { defaultThreadRef } from './context.ts'
import type { Inbound } from './inbound.ts'
import type { Item, Of } from './inbound-shared.ts'
import { peerMessageNotification } from './peer/notify.ts'
import { inboundPeerByConn } from './peer/records.ts'
import { glimpse } from './peer/service.ts'

export const peerFrames = {
  async onPeerMessage(this: Inbound, it: Item, f: Of<'peer.message'>) {
    const { ctx } = this
    const svc = ctx.peers
    const known = inboundPeerByConn(ctx.env.home, f.conn_id)
    // A revoke can leave a frame the Mac already had: consumed, never shown.
    if (!svc || !known) {
      ctx.log.info('peer message for a connection this install does not have; dropped', { conn: f.conn_id })
      return this.done(it)
    }
    const { msg } = f
    const peer = known.name
    const on = svc.ledger.get(msg.id)
    if (on && (on.dir !== 'in' || on.peer !== peer)) {
      // an id this install already has for another peer, or one of its own outbound ids: never a message, and it marks nothing
      ctx.log.warn('peer message id already used by another record; dropped', {
        peer,
        record_dir: on.dir,
        record_peer: on.peer,
      })
      return this.done(it)
    }
    const had = on
    if (had?.emitted) return this.done(it) // the same message again (a replay under a fresh frame id)
    const answered = msg.in_reply_to ? svc.ledger.find(msg.in_reply_to, 'out', peer) : undefined
    const chain = Math.max(msg.chain, answered ? answered.chain + 1 : 0)
    if (chain > PEER_CHAIN_MAX) {
      ctx.log.warn('peer message over the chain limit; dropped', { peer, chain })
      await svc.row(
        `A message from ${peer} was dropped: this exchange has gone back and forth too many times.`,
        undefined,
        `${peer} → Talos`,
      )
      return this.done(it)
    }
    if (!had)
      svc.ledger.record({
        id: msg.id,
        peer,
        dir: 'in',
        label: msg.label ?? null,
        chain,
        in_reply_to: msg.in_reply_to ?? null,
        at: ctx.clock.now(),
      })
    const thread = defaultThreadRef(ctx)
    await svc.row(
      `From ${peer}${msg.label ? ` (${msg.label})` : ''}: ${glimpse(msg.text)}`,
      msg.label,
      `${peer} → Talos`,
      thread,
    )
    await ctx.emit(peerMessageNotification({ thread, peer, msg, chain, ts: f.received_at }))
    svc.ledger.markEmitted(msg.id)
    this.done(it)
  },
}
