// The owner tapping Run on a script block.
// Handlers of the Inbound class (inbound.ts), which forwards to them. Dispatch and the first trust checks are in inbound.ts;
// some handlers here run their own seen-id, age or card-state checks, so read both when auditing trust.
import { isPaneRun, parseRun } from '@talos-app/protocol'
import { clockMeta } from './clock-meta.ts'
import { postSystemNotice, type threadRef } from './context.ts'
import type { Inbound } from './inbound.ts'
import { bumpLastOwnerTs } from './inbound-messages.ts'
import type { Item, Of } from './inbound-shared.ts'
import { textNotification } from './notify.ts'
import { PANE_APP_CLOSED, paneFailLine, sendPaneRun } from './pane-run.ts'
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
    // a message that names a place to run but is not a Run is refused, never read as plain text and never routed
    if (f.intent !== 'run') {
      const line = 'That message was not run: it asked for the terminal pane but is not a Run. Nothing was run.'
      ctx.log.security('run refused', { id: f.id, thread_id: f.thread_id, reason: line })
      await postSystemNotice(ctx, line, { thread })
      return this.done(it, [f.client_msg_id], 'rejected:run')
    }
    // `run_where` is read by the schema (anything but `pane` never gets here as a message) and counts only on a Run
    const forPane = isPaneRun(f)
    const check = runCheck(ctx, f, forPane)
    if ('line' in check) {
      ctx.log.security('run refused', { id: f.id, thread_id: f.thread_id, reason: check.line })
      await postSystemNotice(ctx, check.line, { thread })
      return this.done(it, [f.client_msg_id], 'rejected:run')
    }
    const now = ctx.clock.now()
    // the message and the frame, before the agent hears of it
    ctx.store.markSeen(f.client_msg_id, now, 'run')
    ctx.store.markSeen(it.frame.id, now, 'run')
    if (forPane) return runsFrames.runInPane.call(this, it, f, thread)
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

  /**
   * A pane Run, after the same checks and the same once-only mark as any Run. The agent is not told: the script goes to the Mac
   * app, which runs it in the owner's own shell only if the owner's own click in the app's window vouched for this exact message id.
   * Whatever the app says short of ok is a line in the thread. Nothing is re-routed to the agent and nothing is tried twice.
   */
  async runInPane(this: Inbound, it: Item, f: Of<'message'>, thread: ReturnType<typeof threadRef>) {
    const { ctx } = this
    const shape = parseRun(f.text) // runCheck read it already; a second read is how this gets the script
    // Routed only while the Mac app's run channel is there (`run-pane/1` listed, or a fresh look finds it). Never handed to the agent.
    const up = await ctx.paneRun?.check()
    const r = !up
      ? ({ ok: false, why: PANE_APP_CLOSED } as const)
      : shape.ok
        ? await sendPaneRun(ctx, { thread_id: f.thread_id, script: shape.script, client_msg_id: f.client_msg_id })
        : ({ ok: false, why: 'the script could not be read' } as const)
    if (!r.ok) {
      ctx.log.security('pane run not delivered', { id: f.id, thread_id: f.thread_id, reason: r.why })
      await postSystemNotice(ctx, paneFailLine(r.why, 'unsure' in r && r.unsure === true), { thread })
    }
    bumpLastOwnerTs(ctx, f.ts)
    this.done(it, [f.client_msg_id], r.ok ? undefined : 'rejected:run')
  },
}
