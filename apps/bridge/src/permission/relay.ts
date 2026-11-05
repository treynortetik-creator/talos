// Permission prompts on the phone (docs/CLAUDE-CODE.md C3.2-C3.5). Claude Code relays a tool approval prompt to this
// bridge; the bridge turns it into a `kind:'permission'` card and answers with a verdict ONLY after an owner-signed
// `card.resolve` passes the SPEC 4.5 ledger checks and the card itself still shows the whole call.
//
// Fail closed everywhere: an unreadable request, a failed card send, a restart, a stale or unsigned frame, a closed or
// repeated id, a hidden part or an old Claude Code all end with NO verdict, so the prompt stays open at the Mac. The only
// message this module ever sends to Claude Code with `allow` is the one at the end of `onResolved`, and only on the path
// where permissionVerdictFor() said so.
import {
  type CardT,
  composePermissionCard,
  type ErrorCodeT,
  newId,
  OpenPermissionIds,
  PermissionRequestParams,
  type PermissionVerdictT,
  permissionCardAllowsPrimary,
  permissionVerdictFor,
} from '@talos-app/protocol'
import type { LedgerRow } from '../cards-ledger.ts'
import type { BridgeContext } from '../context.ts'
import { cardCreateFrame, cardUpdateFrame } from '../frames-out.ts'
import { assertFrameFits } from '../transport.ts'

export type VerdictSender = (verdict: PermissionVerdictT) => Promise<void>
type Pending = { card: CardT; requestId: string }

export type PreCheck =
  | { handled: false }
  | { handled: true; ok: true }
  | { handled: true; ok: false; code: ErrorCodeT; reason: string }

export type ResolveOutcome = { ok: true } | { ok: false; code: ErrorCodeT; reason: string }

export class PermissionRelay {
  private readonly ids = new OpenPermissionIds()
  private readonly pending = new Map<string, Pending>()
  private sender: VerdictSender | undefined
  private clientVersion: () => string | undefined = () => undefined
  private otherChannels: string[] = []

  constructor(private readonly ctx: BridgeContext) {}

  setSender(fn: VerdictSender) {
    this.sender = fn
  }
  setClientVersion(fn: () => string | undefined) {
    this.clientVersion = fn
  }

  /** Other loaded channels that can also answer a prompt; each card says so in one line (C3.5). Never blocks. */
  setOtherChannels(names: string[]) {
    this.otherChannels = names
  }

  private declaredAtStart: boolean | undefined

  /**
   * server.ts calls this once, with what it told Claude Code at start. Claude Code only sends prompts to a server that
   * declared `claude/channel/permission`, and cannot be asked again, so a relay turned on later does not work until restart.
   * Not called (tests, headless): the relay then follows the saved setting alone.
   */
  markDeclared(declared: boolean) {
    this.declaredAtStart = declared
  }

  /** What was declared at start; undefined when nothing was recorded. */
  get declared(): boolean | undefined {
    return this.declaredAtStart
  }

  /** What the owner saved (`permission_relay`), live. */
  get configured(): boolean {
    return this.ctx.config.config.permission_relay === true
  }

  /** The owner turned the relay on after this session started: it cannot work until the session restarts. */
  get needsRestart(): boolean {
    return this.ctx.mode === 'live' && this.configured && this.declaredAtStart === false
  }

  /** The relay works only for a live bridge that declared it at start AND whose owner still has it on. */
  get enabled(): boolean {
    return this.ctx.mode === 'live' && this.configured && this.declaredAtStart !== false
  }

  /** The owner turned the relay off: every open permission card closes and can send nothing. Cheap; safe to call often. */
  reconcile(): void {
    if (this.enabled || this.ctx.mode !== 'live') return
    for (const row of this.ctx.ledger.list('pending'))
      if (row.binding.kind === 'permission') this.closeCard(row, 'relay_off')
    this.closeAll()
  }

  /** Cards still `pending` in the ledger from an earlier process: their request ids died with it. Fails closed. */
  sweepStale(): void {
    for (const row of this.ctx.ledger.list('pending')) {
      if (row.binding.kind !== 'permission' || this.pending.has(row.id)) continue
      this.closeCard(row, 'session_ended')
    }
  }

  /** Claude Code opened a prompt (`notifications/claude/channel/permission_request`). Never throws. */
  async onRequest(params: unknown): Promise<void> {
    const { ctx } = this
    let cardId: string | undefined
    let requestId: string | undefined
    try {
      if (!this.enabled) return ctx.log.warn('permission_request ignored: the relay is off')
      const parsed = PermissionRequestParams.safeParse(params)
      if (!parsed.success) return ctx.log.warn('permission_request ignored: not in the documented format')
      const request = parsed.data
      requestId = request.request_id
      const { repeated } = this.ids.add(request.request_id)
      const nowMs = ctx.clock.now()
      const card = composePermissionCard({
        request,
        card_id: newId('c'),
        thread_id: ctx.config.config.default_thread,
        now: nowMs,
        repeated,
        ...(this.otherChannels.length > 0 ? { other_channels: this.otherChannels } : {}),
        ...(this.clientVersion() !== undefined ? { client_version: this.clientVersion() as string } : {}),
      })
      cardId = card.id
      const frame = cardCreateFrame(nowMs, card)
      assertFrameFits(frame)
      ctx.ledger.create(card)
      this.pending.set(card.id, { card, requestId: request.request_id })
      try {
        await ctx.transport.sendDurable(frame)
      } catch (e) {
        // the app will never see it: nothing may answer it, and the prompt stays open at the Mac
        this.drop(card.id, request.request_id)
        ctx.ledger.expire(card.id)
        throw e
      }
      ctx.expiry?.sync()
    } catch (e) {
      if (requestId && !cardId) this.ids.close(requestId)
      ctx.log.warn('permission_request not turned into a card', { error: (e as Error).message })
    }
  }

  /**
   * Before the ledger sees a `card.resolve` for a permission card: a PRIMARY on a card that cannot allow, or on a closed id,
   * is refused WITHOUT touching the ledger, so the card stays as it was.
   */
  precheck(cardId: string, action: 'primary' | 'kill' | 'revise'): PreCheck {
    const row = this.ctx.ledger.get(cardId)
    if (row?.binding.kind !== 'permission') return { handled: false }
    const p = this.pending.get(cardId)
    // relay switched off (config): open cards can no longer send anything (CC-C1-REVIEW F5)
    if (!this.enabled || !p || !this.ids.isOpen(p.requestId)) {
      if (row.state === 'pending') this.closeCard(row, 'permission_closed')
      return {
        handled: true,
        ok: false,
        code: 'permission_closed',
        reason: 'The prompt is closed; answer it at the Mac.',
      }
    }
    if (action === 'primary' && !permissionCardAllowsPrimary(p.card))
      return {
        handled: true,
        ok: false,
        code: 'permission_hidden',
        reason: 'Part of this call is hidden; answer it at the Mac.',
      }
    return { handled: true, ok: true }
  }

  /**
   * After the ledger accepted an owner-signed resolve. Sends the verdict, then closes the id (one verdict per id). Returns
   * `ok: false` when the verdict did not reach Claude Code (the card shows "failed"): the caller owes a tap from a
   * notification a refusal, because the relay told the phone "done" when it queued the tap.
   */
  async onResolved(row: LedgerRow, action: 'primary' | 'kill' | 'revise'): Promise<ResolveOutcome> {
    const { ctx } = this
    const p = this.pending.get(row.id)
    const fail = (reason: string, code: ErrorCodeT): ResolveOutcome => {
      ctx.ledger.finish(row.id, false)
      ctx.transport
        .sendDurable(
          cardUpdateFrame(ctx.clock.now(), {
            card_id: row.id,
            state: 'failed',
            reason,
            result: {
              ok: false,
              text: 'Not sent to Claude Code. Answer at the Mac.',
              at: new Date(ctx.clock.now()).toISOString(),
            },
          }),
        )
        .catch((e) => ctx.log.warn('card.update not sent', { error: (e as Error).message }))
      return { ok: false, code, reason: 'Not sent to Claude Code. Answer at the Mac.' }
    }
    if (!p) return fail('permission_closed', 'permission_closed')
    if (!this.enabled) {
      this.drop(row.id, p.requestId)
      return fail('relay_off', 'permission_closed')
    }
    const v = permissionVerdictFor(p.card, action, this.ids.isOpen)
    this.drop(row.id, p.requestId) // the id closes before sending: a second resolve can never make a second verdict
    if (!v.ok) return fail(v.code, v.code)
    if (!this.sender) return fail('no_channel', 'permission_closed')
    try {
      await this.sender(v.verdict)
    } catch (e) {
      ctx.log.warn('permission verdict not sent', { error: (e as Error).message })
      return fail('send_failed', 'internal')
    }
    if (v.verdict.behavior !== 'allow') return { ok: true } // a deny has no result to report: the inbound pipeline closes it `done`, like any killed card
    ctx.ledger.finish(row.id, true)
    ctx.transport
      .sendDurable(
        cardUpdateFrame(ctx.clock.now(), {
          card_id: row.id,
          state: 'done',
          result: { ok: true, text: 'Sent to Claude Code', at: new Date(ctx.clock.now()).toISOString() },
        }),
      )
      .catch((e) => ctx.log.warn('card.update not sent', { error: (e as Error).message }))
    return { ok: true }
  }

  /** The card expired or went away: its id can no longer be answered from here. */
  onCardGone(cardId: string): void {
    const p = this.pending.get(cardId)
    if (p) this.drop(cardId, p.requestId)
  }

  private drop(cardId: string, requestId: string) {
    this.pending.delete(cardId)
    this.ids.close(requestId)
  }

  private closeCard(row: LedgerRow, reason: string) {
    const { ctx } = this
    const p = this.pending.get(row.id)
    if (p) this.drop(row.id, p.requestId)
    if (!ctx.ledger.expire(row.id)) return
    ctx.expiry?.cancel(row.id)
    ctx.transport
      .sendDurable(cardUpdateFrame(ctx.clock.now(), { card_id: row.id, state: 'expired', reason }))
      .catch((e) => ctx.log.warn('card.update not sent', { error: (e as Error).message }))
  }

  /** This process stopped being the live bridge (superseded, stopping): no pending prompt can be answered from here. */
  closeAll(): void {
    for (const [cardId, p] of [...this.pending]) this.drop(cardId, p.requestId)
  }

  get openCount(): number {
    return this.ids.size
  }
}
