// The owner tapping Run on a script block.
// Handlers of the Inbound class (inbound.ts), which forwards to them. Dispatch and the first trust checks are in inbound.ts;
// some handlers here run their own seen-id, age or card-state checks, so read both when auditing trust.
import { runBlockKey } from '@talos-app/protocol'
import { clockMeta } from './clock-meta.ts'
import { postSystemNotice, type threadRef } from './context.ts'
import type { Inbound } from './inbound.ts'
import type { Item, Of } from './inbound-shared.ts'
import { textNotification } from './notify.ts'
import { runCheck } from './run.ts'

export const runsFrames = {
  /**
   * The owner's tap on Run (`intent: 'run'`, inside the signature). Checked here (run.ts); a refusal is a plain line in the
   * thread and the agent hears nothing. A Run that passes is marked seen BEFORE the agent is told, so a crash or a failed
   * hand-over loses it (the owner asks the agent to post the script again, a new block) and a replay never runs it twice.
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
    // the block, the message and the frame, all before the agent hears of it
    ctx.store.markSeen(runBlockKey(check.block), now, 'run')
    ctx.store.markSeen(f.client_msg_id, now, 'run')
    ctx.store.markSeen(it.frame.id, now, 'run')
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
    ctx.store.kvSet('last_owner_ts', f.ts)
    this.afterOwnerNotify(thread.id, f.client_msg_id)
    this.done(it, [f.client_msg_id])
  },
}
