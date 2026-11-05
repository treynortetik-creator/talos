// Start-up and retention chores the Bridge runs against its context: heal card rows, tell the owner a damaged history was kept aside.
import type { BridgeContext } from './context.ts'
import { postSystemNotice } from './context.ts'
import { HISTORY_KEPT_ASIDE_KEY, historyKeptAsideText } from './history-recover.ts'

/** Heals ledger cards that never got their history row (see CardLedger.backfillRows). Best effort. */
export function backfillCardRows(ctx: BridgeContext) {
  try {
    // Same window the prune keeps (0 days keeps everything): never write back a row the prune just cut.
    const days = ctx.env.historyDays
    const since = days > 0 ? new Date(ctx.clock.now() - days * 24 * 3600_000).toISOString() : undefined
    const n = ctx.ledger.backfillRows(since)
    if (n > 0) ctx.log.info('card history rows backfilled', { cards: n })
  } catch (e) {
    ctx.log.warn('card row backfill failed', { error: (e as Error).message })
  }
}

/** The note is in kv until the thread has it, so a start that never reached the relay still tells the owner next time. */
export async function tellOwnerHistoryKeptAside(ctx: BridgeContext) {
  try {
    const name = ctx.store.kvGet(HISTORY_KEPT_ASIDE_KEY)
    if (!name) return
    await postSystemNotice(ctx, historyKeptAsideText(name), { toAgent: true })
    ctx.store.kvDelete(HISTORY_KEPT_ASIDE_KEY)
  } catch (e) {
    ctx.log.warn('history notice not posted', { error: (e as Error).message })
  }
}
