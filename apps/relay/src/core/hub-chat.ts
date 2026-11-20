// Owner messages from an app.
// Handlers of the Hub class (hub.ts), which forwards to them. Dispatch and the first trust checks (session, pairing,
// schema) are in hub-app-conn.ts and hub-app-frames.ts; some handlers here run their own device, seen-id, step-up
// or card-state checks, so read both when auditing trust.
import type { FrameOf, MessageT } from '@talos-app/protocol'
import type { AppConn, HubDeps } from './hub.ts'
import type { StoredFrame } from './store.ts'
import { mkFrame } from './util.ts'

/** What the chat handlers use of Hub, and nothing else. Hub builds it in its constructor. */
export type ChatCtx = {
  d: HubDeps
  ownerDeviceOk(a: AppConn, deviceId: string, frameId: string): boolean
  acceptOwner(
    a: AppConn,
    frame: { id: string; type: string },
    raw: Record<string, unknown>,
    threadId: string | null,
    extraKeys?: string[],
    alsoWrite?: () => void,
  ): StoredFrame | null
  sendApp(a: AppConn, frame: Record<string, unknown>): void
  fanOut(frame: Record<string, unknown>, onlyDeviceId?: string, except?: string): void
}

export const chatFrames = {
  /** The `message` frame: the signature-device check, the duplicate check, then stored and queued. The `case` of that name in Hub.onAppFrameBuiltin. */
  onOwnerMessage(this: ChatCtx, a: AppConn, frame: FrameOf<'message'>, raw: Record<string, unknown>) {
    const store = this.d.store
    if (!this.ownerDeviceOk(a, frame.device_id, frame.id)) return
    // The owner just sent something from this screen: someone is here, whatever the client sends about activity.
    a.activeAt = this.d.clock.now()
    const dup = store.seen(`of:${frame.id}`) ?? store.seen(`cm:${frame.client_msg_id}`)
    if (dup !== undefined) return this.sendApp(a, mkFrame(this.d.clock, 'ack', { ref: frame.id, seq: dup }))
    const stamped = this.acceptOwner(a, frame, raw, frame.thread_id, [`cm:${frame.client_msg_id}`])
    if (!stamped) return
    const message: MessageT = {
      id: frame.client_msg_id,
      thread_id: frame.thread_id,
      seq: stamped.relay.seq,
      author: 'owner',
      kind: 'text',
      format: 'plain',
      attachments: frame.attachments,
      via: 'app',
      receipt: 'sent',
      created_at: stamped.relay.received_at,
      text: frame.text,
      ...(frame.reply_to ? { reply_to: frame.reply_to } : {}),
      ...(frame.refs ? { refs: frame.refs } : {}),
      ...(frame.share_content ? { share_content: frame.share_content } : {}),
    }
    this.fanOut(mkFrame(this.d.clock, 'message.stored', { client_msg_id: frame.client_msg_id, message }))
    return
  },
}
