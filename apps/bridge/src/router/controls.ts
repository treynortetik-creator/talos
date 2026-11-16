// `thread.session.control` (docs/OPTION-C.md): park, resume, restart or start fresh one thread's own session. The hub
// only checks and passes it on as a wake file (session-control.ts, shared with the main session's `thread_session` tool);
// the desktop supervisor does the work. The result is recorded like a session.control result (same frame, same replay
// rule), so a relay replay never runs it twice.
import type { Frame } from '@talos-app/protocol'
import type { BridgeContext } from '../context.ts'
import { RESET_REFUSAL, signedBeforeReset } from '../history-recover.ts'
import { WorkersReader } from '../worker/files.ts'
import { controlThreadSession } from './session-control.ts'

type Of<T extends Frame['type']> = Extract<Frame, { type: T }>

/** Cancels of a pending wake still running, by control id: a replay while the first is at the scheduler joins it. */
const cancelling = new Set<string>()

export function onThreadSessionControl(
  ctx: BridgeContext,
  f: Of<'thread.session.control'>,
  finish: () => void,
  workers: WorkersReader = new WorkersReader(ctx.paths.home),
): void {
  if (ctx.session.hasResult(f.control_id)) ctx.session.resend(f.control_id)
  else if (f.action === 'cancel_wake') {
    if (signedBeforeReset(ctx.store, f.ts)) ctx.session.recordResult(f.control_id, RESET_REFUSAL)
    else {
      // a replay while the first is still at the scheduler: the first records the result
      if (cancelling.has(f.control_id)) {
        finish()
        return
      }
      // consumed only once the result is recorded, so a crash mid-cancel is replayed, not lost
      void cancelWake(ctx, f).finally(finish)
      return
    }
  } else
    ctx.session.recordResult(
      f.control_id,
      signedBeforeReset(ctx.store, f.ts)
        ? RESET_REFUSAL
        : controlThreadSession(ctx, { thread_id: f.thread_id, action: f.action, by: 'owner' }, workers),
    )
  finish()
}

/**
 * The owner's Cancel on a pending wake (docs/OPTION-C.md "Wake me"): the owner may cancel any wake. It deletes the scheduler's
 * job, so it waits on the schedule queue; the result is recorded (and sent) when that is done, success or not.
 */
async function cancelWake(ctx: BridgeContext, f: Of<'thread.session.control'>) {
  cancelling.add(f.control_id)
  try {
    const r = ctx.schedules
      ? await ctx.schedules.wakeMe.cancel(f.wake_id, 'owner')
      : { ok: false, text: 'Schedules are not running on the main bridge, so the wake could not be cancelled.' }
    ctx.session.recordResult(f.control_id, { ok: r.ok, text: r.text })
  } catch (e) {
    ctx.session.recordResult(f.control_id, {
      ok: false,
      text: `The wake could not be cancelled: ${(e as Error).message}`.slice(0, 300),
    })
  } finally {
    cancelling.delete(f.control_id)
  }
}
