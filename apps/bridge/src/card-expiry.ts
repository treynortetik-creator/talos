// Card expiry (spec 4.5): at `expires_at` a pending card becomes `expired`, the agent hears `card_action=expired`, and the
// app gets `card.update`. Timers live in the live bridge; headless processes only write the ledger, so the live bridge
// re-syncs its timers from the ledger on every poll.
import { type BridgeContext, threadRef } from './context.ts'
import { cardUpdateFrame } from './frames-out.ts'
import { cardActionNotification } from './notify.ts'

const MAX_TIMER_MS = 2 ** 31 - 1

export class CardExpiry {
  private timers = new Map<string, unknown>()

  constructor(private readonly ctx: BridgeContext) {}

  /** Makes sure every pending card has a timer; cards already past due expire now. */
  sync() {
    const now = this.ctx.clock.now()
    for (const row of this.ctx.ledger.list('pending')) {
      const due = Date.parse(row.expires_at) - now
      if (due <= 0) {
        this.expireQuietly(row.id)
      } else if (!this.timers.has(row.id)) {
        this.timers.set(
          row.id,
          this.ctx.clock.setTimeout(() => this.expireQuietly(row.id), Math.min(due, MAX_TIMER_MS)),
        )
      }
    }
  }

  /** For timers and sweeps, which nobody awaits: a failure (closed channel, busy database) is logged, never floated. */
  private expireQuietly(id: string) {
    this.expire(id, 'expired').catch((e) =>
      this.ctx.log.warn('card expiry failed', { id, error: (e as Error).message }),
    )
  }

  cancel(id: string) {
    const t = this.timers.get(id)
    if (t !== undefined) this.ctx.clock.clearTimeout(t)
    this.timers.delete(id)
  }

  cancelAll() {
    for (const id of [...this.timers.keys()]) this.cancel(id)
  }

  /** pending -> expired exactly once, whoever gets there first (timer, late resolve, or startup sweep). */
  async expire(id: string, reason: string) {
    this.cancel(id)
    const { ctx } = this
    // the late-resolve path already flipped the state itself and calls announce() directly
    if (!ctx.ledger.expire(id)) return
    await this.announce(id, reason)
  }

  async announce(id: string, reason: string) {
    const { ctx } = this
    const row = ctx.ledger.get(id)
    if (!row) return
    const now = ctx.clock.now()
    ctx.permission.onCardGone(id)
    ctx.schedules?.forgetCard(id) // a schedule card's proposer row has no reader left
    ctx.transport
      .sendDurable(cardUpdateFrame(now, { card_id: id, state: 'expired', reason }))
      .catch((e) => ctx.log.warn('card.update not sent', { error: (e as Error).message }))
    if (row.binding.kind === 'permission') return // the agent never hears about a permission card
    if (row.binding.kind === 'dialog') return ctx.dialogs?.onCardExpired(row) // nor about a dialog card: the owner gets the one thread line
    // MCP apps: the app hears `card_expired`; a bridge-run card never involved the agent
    if (row.binding.kind === 'app_action' && ctx.apps && (await ctx.apps.onCardExpired(row)) === 'quiet') return
    await ctx.emit(
      cardActionNotification({
        thread: threadRef(ctx, row.thread_id),
        card: { id, title: row.binding.title, primary_label: row.binding.primary_label },
        action: 'expired',
        ts: new Date(now).toISOString(),
      }),
    )
  }
}
