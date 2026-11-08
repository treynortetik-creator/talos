// Settings patches from the app.
// Handlers of the Inbound class (inbound.ts), which forwards to them. Dispatch and the first trust checks are in inbound.ts;
// some handlers here run their own seen-id, age or card-state checks, so read both when auditing trust.
import { defaultThreadRef } from './context.ts'
import { configSyncFrame } from './frames-out.ts'
import type { Inbound } from './inbound.ts'
import type { Item, Of } from './inbound-shared.ts'
import { systemNotification } from './notify.ts'
import { describeDefaultChange, describeThreadChanges } from './thread-changes.ts'
import { liveThreadIds, removeGoneInboxes } from './worker/inbox.ts'

export const configFrames = {
  async onConfigPatch(this: Inbound, it: Item, f: Of<'config.patch'>) {
    const { ctx } = this
    // the allowlist walks the RAW patch (what the owner signed); a zod copy could have dropped or moved keys
    const rawPatch = it.raw.patch
    if (typeof rawPatch !== 'object' || rawPatch === null || Array.isArray(rawPatch))
      return this.reject(it, 'bad_frame', 'patch must be an object')
    const before = ctx.config.config
    const r = ctx.config.applyPatch(f.base_rev, rawPatch as Record<string, unknown>, ctx.clock.now())
    if (!r.ok) {
      ctx.log.warn('config.patch rejected', { code: r.code })
      // a stale base_rev means the app is behind: send the current config so it refreshes before retrying
      if (r.code === 'config_conflict') this.fire(configSyncFrame(ctx.clock.now(), ctx.config.config))
      return this.reject(it, r.code, r.message)
    }
    this.fire(configSyncFrame(ctx.clock.now(), r.config, f.id))
    ctx.config.markSynced(r.config)
    ctx.permission.reconcile()
    ctx.log.info('config patched', { rev: r.config.rev })
    // a thread that was archived or deleted keeps no copies of the owner's files
    removeGoneInboxes(ctx.paths.inbox, liveThreadIds(r.config))
    // Thread edits change where the agent should post (docs/THREADS.md): tell it once, after the write.
    const told = [
      describeThreadChanges(before.threads, r.config.threads),
      describeDefaultChange(before.default_thread, r.config.default_thread, r.config.threads),
    ].filter((x): x is string => x !== null)
    if (told.length)
      await ctx
        .emit(
          systemNotification({
            thread: defaultThreadRef(ctx),
            text: told.join('\n'),
            ts: new Date(ctx.clock.now()).toISOString(),
            id: `threads-${r.config.rev}`,
          }),
        )
        .catch(() => {})
    this.done(it)
  },
}
