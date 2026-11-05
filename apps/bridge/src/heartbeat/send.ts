// One plain heartbeat row: its history row and its frame (docs/HEARTBEAT.md).
import type { Frame, MessageT } from '@talos-app/protocol'
import type { BridgeContext } from '../context.ts'
import { replyFrame } from '../frames-out.ts'

/**
 * One row, idempotent on its message id: the history row is made first, then the frame goes through the outbox (which keeps it
 * until the relay acks, across reconnects). A message that already exists is never made or sent again. Throws when the frame
 * cannot be accepted (too big, refused); then no frame is kept, so the row is removed again: a row for a frame that never
 * arrives would be posted a second time, under a new id, by the retry. A frame that IS in the outbox is delivered whatever
 * this call saw, so it counts as sent and its row stays.
 */
export async function sendRow(
  ctx: Pick<BridgeContext, 'store' | 'transport' | 'log'>,
  p: { message_id: string; frame_id: string; thread_id: string; text: string; silent: boolean },
  nowMs: number,
) {
  if (ctx.store.getMessage(p.message_id)) return
  const message: MessageT = {
    id: p.message_id,
    thread_id: p.thread_id,
    author: 'system',
    kind: 'text',
    text: p.text,
    format: 'plain',
    attachments: [],
    via: 'app',
    created_at: new Date(nowMs).toISOString(),
    heartbeat: true,
  }
  ctx.store.addMessage(message)
  const frame = { ...replyFrame(nowMs, message, p.silent ? { silent: true } : {}), id: p.frame_id } as Frame
  try {
    const r = await ctx.transport.sendDurable(frame)
    if (r.state === 'acked' && r.seq !== undefined) ctx.store.setSeq(message.id, r.seq)
  } catch (e) {
    if (ctx.store.outboxGet(frame.id)) {
      ctx.log.warn('heartbeat post failed after its frame was kept; the outbox delivers it', {
        error: (e as Error).message,
      })
      return
    }
    ctx.store.deleteMessage(message.id)
    throw e
  }
}
