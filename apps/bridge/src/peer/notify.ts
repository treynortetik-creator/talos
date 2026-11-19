// The channel note for a message from a linked agent: outside data (trust=external), wrapped, never the owner's word.
import { PEER_TEXT_MAX_BYTES, type PeerMessageT, wrapExternal } from '@talos-app/protocol'
import { cleanMeta, type Notification, type ThreadRef } from '../notify.ts'

export function peerMessageNotification(a: {
  thread: ThreadRef
  /** The name of the connection (the receiver's own), never the sender's claim. */
  peer: string
  msg: PeerMessageT
  /** The chain this Mac computed. */
  chain: number
  ts: string
}): Notification {
  const { msg, peer } = a
  const lead = `From ${peer} (${msg.label ?? 'message'}): `
  return {
    content: wrapExternal(`${lead}${msg.text}`, {
      source: `Linked agent (${peer})`,
      from: peer,
      maxChars: PEER_TEXT_MAX_BYTES + 200,
    }),
    meta: cleanMeta({
      chat_id: a.thread.id,
      thread_id: a.thread.id,
      thread_name: a.thread.name,
      message_id: msg.id,
      ts: a.ts,
      kind: 'peer_message',
      trust: 'external',
      peer,
      label: msg.label,
      peer_msg_id: msg.id,
      in_reply_to: msg.in_reply_to,
      chain: a.chain,
      // anything that arrives from a peer is work a peer asked for: the sender's own flag is not read
      from_peer_task: 'true',
    }),
  }
}
