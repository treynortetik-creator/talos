// How the live bridge wires the wake piece (main-wake/service.ts) to the rest of itself. Moved out of Bridge's constructor unchanged:
// building MainWake, the Inbox line for a bug wake it gave up, the owner-report wake that ProblemService calls, and the poll's retry.
import type { Database } from 'bun:sqlite'
import type { Clock } from '../clock.ts'
import { type BridgeContext, defaultThreadRef, postSystemNotice, threadRef } from '../context.ts'
import type { Logger } from '../log.ts'
import { bugReportNotification } from '../notify.ts'
import { MainWake } from './service.ts'

/** The Inbox thread when this install has one, else the default thread: where the bridge's own notices go. */
export const inboxRef = (ctx: BridgeContext) =>
  ctx.config.thread('inbox') ? threadRef(ctx, 'inbox') : defaultThreadRef(ctx)

/** Wakes Main on the bridge's own account (a bug report, a failed job): written down first, so a restart keeps them. */
export function makeMainWake(ctx: BridgeContext, db: Database, clock: Clock, log: Logger): MainWake {
  return new MainWake({
    db,
    now: () => clock.now(),
    emit: (n) => ctx.emit(n),
    log,
    closing: () => ctx.closing === true,
    // a bug report Main never took: one line in the Inbox, so the owner's report is not lost without a word
    onGiveUp: (key, n) => {
      const id = n.meta.report_id
      if (!key.startsWith('bug:') || !id) return
      void postSystemNotice(
        ctx,
        `Bug report ${id} could not be handed to Main after several tries. Read it with: talos-app errors show ${id}`,
        { thread: inboxRef(ctx) },
      ).catch((e) => log.warn('bug report give-up line not posted', { error: (e as Error).message }))
    },
  })
}

/** The owner's own report wakes Main once; the key is the report, so a re-queue says nothing more. For ProblemService's `wake`. */
export function bugReportWake(ctx: BridgeContext, clock: Clock) {
  return async ({ fingerprint, summary }: { fingerprint: string; summary: string }): Promise<void> => {
    const id = fingerprint.slice(0, 12)
    await ctx.mainWake?.fire(
      `bug:${fingerprint}`,
      bugReportNotification({
        thread: inboxRef(ctx),
        reportId: id,
        summary,
        ts: new Date(clock.now()).toISOString(),
        id: `bug-${id}`,
      }),
    )
  }
}

/** The bridge's poll: a wake it decided on but could not hand to Main (the channel refused, or it stopped first) is sent again. */
export async function retryMainWake(ctx: BridgeContext, log: Logger): Promise<void> {
  await ctx.mainWake?.tick().catch((e) => log.warn('main wake retry failed', { error: (e as Error).message }))
}
