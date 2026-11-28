// The router's side of the quiet-agent notice: builds the watch from the router's own pieces, and ticks it together with the session-error
// watch (session-error-wiring.ts), so router.ts holds one field and one tick for both.
import { newId, QUIET_LINES_FEATURE, sanitizePaneLines, type WorkersFileT } from '@talos-app/protocol'
import { type BridgeContext, postSystemNotice, threadRef } from '../context.ts'
import { quietLinesFrame } from '../frames-out.ts'
import type { WorkerStore } from '../worker/store.ts'
import { QuietWatch, quietKey } from './quiet-watch.ts'
import { QUIET } from './quiet-words.ts'
import { wireSessionErrors } from './session-error-wiring.ts'

export function wireQuiet(
  ctx: BridgeContext,
  store: () => WorkerStore,
  errorDeps: Parameters<typeof wireSessionErrors>[1],
): {
  tick(file: WorkersFileT | null, dedicated: (thread: string) => boolean): void
  quiet: QuietWatch
  /** From `ready.features`: the pane lines are sent only to a relay that lists them. */
  setRelayFeatures(features: readonly string[]): void
} {
  const errors = wireSessionErrors(ctx, errorDeps)
  let linesOk = false
  const quiet = new QuietWatch({
    now: () => ctx.clock.now(),
    store,
    seen: (key) => ctx.store.kvGet(key) !== undefined,
    mark: (key) => ctx.store.kvSet(key, String(ctx.clock.now())),
    post: async (where, session, lines) => {
      const id = newId('m')
      await postSystemNotice(ctx, QUIET.text(threadRef(ctx, session).name), {
        id,
        thread: threadRef(ctx, where),
        actions: [{ kind: 'open_terminal', thread: session }],
      })
      // the pane lines go in app only, in a frame of their own (never in the notice, which is stored and pushed), cleaned again here
      const shown = sanitizePaneLines(lines)
      if (linesOk && shown.length > 0)
        ctx.transport.sendEphemeral(quietLinesFrame(ctx.clock.now(), id, threadRef(ctx, where).id, shown))
    },
    warn: (msg, f) => ctx.log.warn(msg, f),
  })
  return {
    quiet,
    setRelayFeatures: (features) => {
      linesOk = features.includes(QUIET_LINES_FEATURE)
    },
    tick: (file, dedicated) => {
      errors.tick(file, dedicated)
      quiet.tick(file, dedicated)
    },
  }
}

/**
 * The "stopped before it answered" line for messages in `thread` (router.ts reportUnanswered). If the owner was already told one of them was quiet
 * (quiet-watch.ts) it says only what changed, naming the session's thread; otherwise it is the plain line it always was.
 */
export function unansweredLine(ctx: BridgeContext, store: WorkerStore, thread: string, ids: readonly string[]): string {
  if (!ids.some((id) => ctx.store.kvGet(quietKey(id)) !== undefined))
    return "This thread's session stopped before it answered. Send the message again to carry on."
  return QUIET.stoppedAfter(threadRef(ctx, store.route(ids[0] as string)?.thread_id ?? thread).name)
}
