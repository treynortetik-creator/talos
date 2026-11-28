// The thread's wake file, as the router writes it (a pure move out of router.ts, which has a size limit).
import type { BridgeContext } from '../context.ts'
import { writeWake } from '../worker/files.ts'
import type { WorkerStore } from '../worker/store.ts'

/** Writes the thread's wake file naming every message its worker has not claimed yet. */
export function writeThreadWake(
  ctx: BridgeContext,
  store: WorkerStore,
  thread: string,
  reason: 'message' | 'card_action',
) {
  const ids = store
    .unclaimed(thread)
    .map((r) => r.message_id)
    .slice(-50)
  if (!ids.length) return
  try {
    writeWake(
      ctx.paths.home,
      {
        v: 1,
        thread_id: thread,
        message_ids: ids,
        at: new Date(ctx.clock.now()).toISOString(),
        reason,
        action: 'pointer',
      },
      (msg, f) => ctx.log.warn(msg, f),
    )
  } catch (e) {
    ctx.log.warn('wake file not written', { thread, error: (e as Error).message })
  }
}
