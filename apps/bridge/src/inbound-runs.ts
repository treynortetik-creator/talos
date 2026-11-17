// The owner tapping Run on a script block.
// Handlers of the Inbound class (inbound.ts), which forwards to them. Dispatch and the first trust checks are in inbound.ts;
// some handlers here run their own seen-id, age or card-state checks, so read both when auditing trust.
import { clockMeta } from './clock-meta.ts'
import { postSystemNotice, type threadRef } from './context.ts'
import type { Inbound } from './inbound.ts'
import { bumpLastOwnerTs } from './inbound-messages.ts'
import type { Item, Of } from './inbound-shared.ts'
import { textNotification } from './notify.ts'
import { runCheck } from './run.ts'
import { isStopping } from './stopping.ts'

export const runsFrames = {
  /**
   * The owner's tap on Run (`intent: 'run'`, inside the signature). Checked here (run.ts); a refusal is a plain line in the
   * thread and the agent hears nothing. A Run that passes is marked seen BEFORE the agent is told, so a crash or a failed
   * hand-over loses it (the owner taps Run again) and a replay of the same tap never runs it twice.
   */
  async onRun(this: Inbound, it: Item, f: Of<'message'>, thread: ReturnType<typeof threadRef>) {
    const { ctx } = this
    this.record(this.messageRow(it, f))
    const check = runCheck(ctx, f)
    if ('line' in check) {
      ctx.log.security('run refused', { id: f.id, thread_id: f.thread_id, reason: check.line })
      await postSystemNotice(ctx, check.line, { thread })
      return this.done(it, [f.client_msg_id], 'rejected:run')
    }
    const now = ctx.clock.now()
    // the message and the frame, before the agent hears of it
    ctx.store.markSeen(f.client_msg_id, now, 'run')
    ctx.store.markSeen(it.frame.id, now, 'run')
    try {
      await ctx.emit(
        textNotification({
          thread,
          messageId: f.client_msg_id,
          ts: f.ts,
          text: f.text,
          run: true,
          clock: clockMeta(ctx, thread.id, f.ts, f.client_msg_id),
        }),
      )
    } catch (e) {
      // A bridge that began to stop refused the hand-over: nothing ran and nothing was told, so the tap is not spent. It goes
      // back to unseen and the relay's replay gives it to the next bridge once. Any other failure is the loss described above.
      if (isStopping(e)) {
        ctx.store.unmarkSeen(f.client_msg_id)
        ctx.store.unmarkSeen(it.frame.id)
      }
      throw e
    }
    bumpLastOwnerTs(ctx, f.ts)
    this.afterOwnerNotify(thread.id, f.client_msg_id)
    this.done(it, [f.client_msg_id])
  },
}
