// The router's side of "a thread session stopped on an error": builds the card (ctx.sessionErrors) and the transcript watch from the
// router's own pieces, so router.ts only constructs it and ticks it.
import { claudeConfigDir } from '../claude-dir.ts'
import type { BridgeContext } from '../context.ts'
import type { Notification } from '../notify.ts'
import type { WorkersReader } from '../worker/files.ts'
import { SupersededByMain, type WorkerStore } from '../worker/store.ts'
import { SessionErrorCards } from './session-error-cards.ts'
import { lastRecordUuid, SessionErrorWatch, SINCE_SLACK_MS } from './session-error-watch.ts'
import { turnEndedSince } from './update-resend.ts'

export function wireSessionErrors(
  ctx: BridgeContext,
  deps: {
    held(id: string): Notification | undefined
    store: () => WorkerStore
    /** The router's own decision for a message: where it would go now. */
    decide(n: Notification): { to: string }
    /** The router's own route: it hands the message to the thread's session, or to main. */
    routeRaw(n: Notification, supersedes?: string): Promise<void>
    workers: () => WorkersReader
  },
): SessionErrorWatch {
  const claudeDir = () => {
    try {
      return claudeConfigDir(ctx.env.userHome, ctx.env.claudeConfigDir)
    } catch {
      return undefined // a CLAUDE_CONFIG_DIR that is not absolute: nothing to read
    }
  }
  ctx.sessionErrors = new SessionErrorCards(ctx, {
    held: deps.held,
    workers: deps.workers,
    latest: (thread) =>
      deps
        .store()
        .latestRoutes(thread, 1)
        .map((r) => ({ id: r.message_id, at: r.woke_at, n: r.notification })),
    wouldGoToWorker: (n) => deps.decide(n).to === 'worker',
    claimedBy: (id) => deps.store().claimedBy(id),
    copyHeld: (id) => deps.store().route(id) !== undefined,
    // `queued` only when this id was not held before and the thread's own session holds it now; otherwise `main` (the router gave it to main)
    route: async (n, supersedes) => {
      const id = n.meta.message_id ?? ''
      const store = deps.store()
      if (!id || store.route(id)) return 'refused'
      try {
        // the router retires `supersedes` in the SAME transaction that queues the copy, so a crash cannot leave the original retired and no copy
        await deps.routeRaw(n, supersedes)
      } catch (e) {
        if (e instanceof SupersededByMain) return 'answered'
        // it threw AFTER queueing (the copy is held, and the original retired with it): nothing to undo or repeat
        if (store.route(id) === undefined && store.claimedBy(id) === undefined) throw e
      }
      if (store.route(id) !== undefined && store.claimedBy(id) !== 'main') return 'queued'
      // the router handed it to main (with a claim, or, when the thread stopped being its own between its two decisions, without one): retire the
      // original too, after the fact (a crash here can only leave a duplicate, never a loss)
      const thread = supersedes === undefined ? undefined : store.route(supersedes)?.thread_id
      if (supersedes !== undefined && thread !== undefined) store.supersede(supersedes, thread, ctx.clock.now())
      return 'main'
    },
    lastRecord: (cwd, session) => {
      const dir = claudeDir()
      return dir ? lastRecordUuid(dir, cwd, session) : undefined
    },
  })
  return new SessionErrorWatch({
    claudeDir,
    now: () => ctx.clock.now(),
    sinceMs: ctx.clock.now() - SINCE_SLACK_MS,
    seen: (key) => ctx.store.kvGet(key) !== undefined,
    mark: (key) => ctx.store.kvSet(key, String(ctx.clock.now())),
    ownerEndedSince: (thread, at) => turnEndedSince(ctx, thread, at),
    raise: async (e) => void (await ctx.sessionErrors?.raise(e)),
    warn: (msg, f) => ctx.log.warn(msg, f),
  })
}
