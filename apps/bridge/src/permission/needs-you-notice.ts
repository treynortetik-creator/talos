// The "waiting on you" notice for the gaps that have no card (docs/CLAUDE-CODE.md C3.10): the kit's Notification hook tells the hub a KIND (today only
// ask, an elicitation dialog) and who it is; this posts ONE fixed sentence with an Open terminal action in that thread. At most one per kind per thread per ten minutes
// (the kv key is set before the post, so a slow send or a second hook at the same moment never repeats it). Nothing the session sent is shown.
import type { NeedsYouKindT } from '@talos-app/protocol'
import { type BridgeContext, postSystemNotice, threadRef } from '../context.ts'
import { NEEDS_YOU_NOTICE } from './needs-you-words.ts'

export const NEEDS_YOU_REPEAT_MS = 10 * 60_000

export type NeedsYouResult = 'told' | 'dup' | 'no_thread' | 'failed'

export class NeedsYouNotices {
  constructor(private readonly ctx: BridgeContext) {}

  /** `thread`: the dedicated thread the proven session serves; none means the main session (the default thread, whose terminal tab is Main's). */
  async tell(kind: NeedsYouKindT, thread?: string): Promise<NeedsYouResult> {
    const { ctx } = this
    const where = thread ?? ctx.config.config.default_thread
    if (!ctx.config.thread(where)) return 'no_thread'
    const key = `needs_notice:${kind}:${where}`
    const now = ctx.clock.now()
    const last = Number(ctx.store.kvGet(key) ?? Number.NaN)
    if (Number.isFinite(last) && now - last < NEEDS_YOU_REPEAT_MS) return 'dup'
    ctx.store.kvSet(key, String(now)) // BEFORE the post
    try {
      await postSystemNotice(
        ctx,
        thread === undefined ? NEEDS_YOU_NOTICE.askMain : NEEDS_YOU_NOTICE[kind](threadRef(ctx, where).name),
        {
          thread: threadRef(ctx, where),
          actions: [{ kind: 'open_terminal', thread: thread ?? 'main' }],
        },
      )
    } catch (e) {
      ctx.log.warn('needs-you notice not posted', { error: (e as Error).message })
      return 'failed'
    }
    return 'told'
  }
}
