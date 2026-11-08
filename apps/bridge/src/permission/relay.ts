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
  PERMISSION_MIN_CLIENT_VERSION,
  PermissionRequestParams,
  type PermissionVerdictT,
  permissionCardAllowsPrimary,
  permissionVerdictFor,
} from '@talos-app/protocol'
import type { LedgerRow } from '../cards-ledger.ts'
import type { BridgeContext } from '../context.ts'
import { cardCreateFrame, cardUpdateFrame } from '../frames-out.ts'
import { assertFrameFits } from '../transport.ts'
import { type Explainer, type ExplainRequest, explainRequestOf, explainToCard } from './explainer.ts'
import { renderHookCall } from './hook-render.ts'

export type VerdictSender = (verdict: PermissionVerdictT) => Promise<void>
/** `hook`: raised for a PermissionRequest hook (kit/hooks/permission-relay.py), answered to that hook and not over MCP. */
type Pending = { card: CardT; requestId: string; hook?: true }

/**
 * A prompt a PermissionRequest hook reports. `thread` is a PROVEN worker thread (hub/server.ts), absent for the main session;
 * `pid` and `cwd` are what a main-session hook says about itself (shown on its card, never trusted for anything else).
 */
export type HookRequest = { thread?: string; tool_name: string; tool_input: unknown; pid?: number; cwd?: string }
/** `allow` and `deny` are only ever the owner's signed answer to the card; everything else is `none` (leave the prompt alone). */
export type HookDecision = { decision: 'allow' | 'deny' | 'none'; reason: string }

/**
 * How long a main-session hook request waits to see whether the channel relay carries the same prompt (it then answers it, and a
 * second card would be a double). Claude Code starts both at the same moment, so the twin is normally there already.
 */
const HOOK_RELAY_GRACE_MS = 1_500
/**
 * Backstop only: Claude Code ends the hook when the prompt is answered at the Mac or blocked by its own countdown, and the hook's
 * socket closing closes the card. This covers a hook that is somehow neither answered nor ended.
 */
const HOOK_MAX_WAIT_MS = 3_700_000
const HOOK_MAX_OPEN = 16
const RECENT_RELAY_MS = 15_000
const ID_LETTERS = 'abcdefghijkmnopqrstuvwxyz' // a-z without `l`, like PermissionRequestId

/**
 * A preview in one comparable form. Whitespace runs become ONE space (never nothing: `rm -rf a b` is not `rm -rf ab`). A preview
 * that is JSON is re-serialised first, so the relay's spacing between keys and values does not matter; one that is not (cut, or
 * reshaped) stays as text and so matches nothing.
 */
const normPreview = (s: string): string => {
  let t = s
  try {
    t = JSON.stringify(JSON.parse(s))
  } catch {
    // not JSON: compared as text
  }
  return t.replace(/\s+/g, ' ').trim()
}

export type PreCheck =
  | { handled: false }
  | { handled: true; ok: true }
  | { handled: true; ok: false; code: ErrorCodeT; reason: string }

export type ResolveOutcome = { ok: true } | { ok: false; code: ErrorCodeT; reason: string }

export class PermissionRelay {
  private readonly ids = new OpenPermissionIds()
  private readonly pending = new Map<string, Pending>()
  /** Hook cards still waiting: cardId -> settle (false when the hook is already known to be gone). */
  private readonly hookWaiters = new Map<string, (d: HookDecision) => boolean>()
  private hookInFlight = 0
  private recentRelay: { tool: string; json: string; at: number }[] = []
  private sessionPids = new Set<number>()
  private readonly graceWake = new Set<() => void>()
  private hookGraceMs = HOOK_RELAY_GRACE_MS
  private hookMaxWaitMs = HOOK_MAX_WAIT_MS
  private sender: VerdictSender | undefined
  private clientVersion: () => string | undefined = () => undefined
  private otherChannels: string[] = []
  private explainer: Explainer | undefined

  constructor(private readonly ctx: BridgeContext) {}

  setSender(fn: VerdictSender) {
    this.sender = fn
  }
  setClientVersion(fn: () => string | undefined) {
    this.clientVersion = fn
  }

  /** The plain explanation of each card (explainer.ts); none: cards are exactly as they were, with no `explain` field. */
  setExplainer(e: Explainer | undefined) {
    this.explainer = e
  }

  /**
   * Starts the explanation of a card that is already on its way to the phone, and sends it as a card.update when it is ready.
   * Never awaited by the caller, never throws, never touches the verdict: an answer before it arrives works as it always did,
   * and an explanation for a card that has been answered, closed or dropped in the meantime is not sent.
   */
  private explainCard(cardId: string, req: ExplainRequest) {
    const { explainer, ctx } = this
    if (!explainer) return
    void (async () => {
      const explain = await explainToCard(explainer, req)
      if (!this.pending.has(cardId) || ctx.ledger.get(cardId)?.state !== 'pending') return
      await ctx.transport.sendDurable(cardUpdateFrame(ctx.clock.now(), { card_id: cardId, state: 'pending', explain }))
    })().catch((e) => ctx.log.warn('card explanation not sent', { error: (e as Error).message }))
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

  /** The ancestors of this bridge. The Claude Code it is the channel of is one of them: only its hook can have a relay twin. */
  setSessionPids(pids: readonly number[]) {
    this.sessionPids = new Set(pids)
  }

  /** Test seam: the two hook timings. */
  setHookTimings(t: { graceMs?: number; maxWaitMs?: number }) {
    if (t.graceMs !== undefined) this.hookGraceMs = t.graceMs
    if (t.maxWaitMs !== undefined) this.hookMaxWaitMs = t.maxWaitMs
  }

  /**
   * Hook cards need only the owner's switch and a live bridge: they answer over the hub socket, not over the MCP channel, so
   * "declared at start" does not matter. A worker session, which never declares the relay, is covered by this.
   */
  get hookEnabled(): boolean {
    return this.ctx.mode === 'live' && this.configured
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
    if (this.ctx.mode !== 'live') return
    const relayOff = !this.enabled
    const hookOff = !this.hookEnabled
    if (!relayOff && !hookOff) return
    for (const row of this.ctx.ledger.list('pending')) {
      if (row.binding.kind !== 'permission') continue
      const isHook = this.pending.get(row.id)?.hook === true
      if (isHook ? hookOff : relayOff) this.closeCard(row, 'relay_off')
    }
    if (relayOff) for (const [cardId, p] of [...this.pending]) if (!p.hook) this.drop(cardId, p.requestId)
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
        ...(this.explainer ? { explain: true } : {}),
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
      this.explainCard(card.id, explainRequestOf(request.tool_name, request.input_preview, request.description))
      // only a relay card that exists AND offers Allow can stand in for a hook's: a deny-only card leaves the owner no way to approve
      if (permissionCardAllowsPrimary(card)) this.noteRelayRequest(request.tool_name, request.input_preview)
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
    if (!(p?.hook ? this.hookEnabled : this.enabled) || !p || !this.ids.isOpen(p.requestId)) {
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
    if (!(p.hook ? this.hookEnabled : this.enabled)) {
      this.drop(row.id, p.requestId, 'relay_off')
      return fail('relay_off', 'permission_closed')
    }
    const v = permissionVerdictFor(p.card, action, this.ids.isOpen)
    // a hook's waiter is taken before the drop: the verdict below is its answer, the drop would otherwise answer "none"
    const waiter = p.hook ? this.takeWaiter(row.id) : undefined
    this.drop(row.id, p.requestId) // the id closes before sending: a second resolve can never make a second verdict
    if (!v.ok) {
      waiter?.({ decision: 'none', reason: v.code })
      return fail(v.code, v.code)
    }
    if (p.hook) {
      // the owner's signed answer, to the hook that asked; false when that hook is already known to be gone
      if (!waiter?.({ decision: v.verdict.behavior, reason: 'owner' })) return fail('send_failed', 'internal')
    } else {
      if (!this.sender) return fail('no_channel', 'permission_closed')
      try {
        await this.sender(v.verdict)
      } catch (e) {
        ctx.log.warn('permission verdict not sent', { error: (e as Error).message })
        return fail('send_failed', 'internal')
      }
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
    if (p) this.drop(cardId, p.requestId, 'card_gone')
  }

  private drop(cardId: string, requestId: string, reason = 'closed') {
    this.pending.delete(cardId)
    this.ids.close(requestId)
    this.takeWaiter(cardId)?.({ decision: 'none', reason }) // a hook still waiting is told "no decision": it never reads as an answer
  }

  private takeWaiter(cardId: string): ((d: HookDecision) => boolean) | undefined {
    const w = this.hookWaiters.get(cardId)
    this.hookWaiters.delete(cardId)
    return w
  }

  private closeCard(row: LedgerRow, reason: string) {
    const { ctx } = this
    const p = this.pending.get(row.id)
    if (p) this.drop(row.id, p.requestId, reason)
    if (!ctx.ledger.expire(row.id)) return
    ctx.expiry?.cancel(row.id)
    ctx.transport
      .sendDurable(cardUpdateFrame(ctx.clock.now(), { card_id: row.id, state: 'expired', reason }))
      .catch((e) => ctx.log.warn('card.update not sent', { error: (e as Error).message }))
  }

  /** This process stopped being the live bridge (superseded, stopping): no pending prompt can be answered from here. */
  closeAll(): void {
    this.explainer?.close?.() // a CLI still running for an explanation dies with this bridge
    for (const [cardId, p] of [...this.pending]) this.drop(cardId, p.requestId, 'bridge_stopped')
  }

  get openCount(): number {
    return this.ids.size
  }

  // ---- PermissionRequest hook path ------------------------------------------------------------------------------------

  private noteRelayRequest(tool: string, preview: string) {
    const now = this.ctx.clock.now()
    this.recentRelay = this.recentRelay.filter((r) => now - r.at < RECENT_RELAY_MS).slice(-49)
    this.recentRelay.push({ tool, json: normPreview(preview), at: now })
    for (const wake of [...this.graceWake]) wake()
  }

  /**
   * Takes the relay card that stands in for this hook call, if one exists. Exact only: the same tool and the same whole input
   * once whitespace is folded. A preview Claude Code cut or reshaped is NOT a twin: a second card is a nuisance, a missing one
   * leaves the owner with a prompt on the Mac and nothing on the phone.
   */
  private takeRelayTwin(tool: string, json: string): boolean {
    const now = this.ctx.clock.now()
    this.recentRelay = this.recentRelay.filter((r) => now - r.at < RECENT_RELAY_MS)
    const want = normPreview(json)
    const i = this.recentRelay.findIndex((r) => r.tool === tool && r.json === want)
    if (i < 0) return false
    this.recentRelay.splice(i, 1)
    return true
  }

  private waitForRelayTwin(tool: string, json: string, signal: AbortSignal): Promise<boolean> {
    if (this.takeRelayTwin(tool, json)) return Promise.resolve(true)
    return new Promise<boolean>((resolve) => {
      let timer: unknown
      const end = (v: boolean) => {
        this.graceWake.delete(check)
        this.ctx.clock.clearTimeout(timer)
        signal.removeEventListener('abort', onAbort)
        resolve(v)
      }
      const check = () => {
        if (this.takeRelayTwin(tool, json)) end(true)
      }
      const onAbort = () => end(false)
      this.graceWake.add(check)
      signal.addEventListener('abort', onAbort, { once: true })
      timer = this.ctx.clock.setTimeout(() => end(false), this.hookGraceMs)
    })
  }

  private mintRequestId(): string | undefined {
    for (let i = 0; i < 50; i++) {
      const b = crypto.getRandomValues(new Uint8Array(5))
      const id = Array.from(b, (x) => ID_LETTERS[x % ID_LETTERS.length]).join('')
      if (!this.ids.hasSeen(id)) return id
    }
    return undefined
  }

  /**
   * A PermissionRequest hook reports a prompt Claude Code is showing at the Mac. Turns it into the same permission card the
   * relay raises (same composer, same ledger checks, same step-up for a risky tool) and resolves with the owner's answer.
   * `allow` or `deny` only ever come from an owner-signed card.resolve; a closed hook, a timeout, a switched-off relay, a
   * refused or hidden call, a failed send and a restart are all `none`, so the prompt stays at the Mac. Never throws.
   * Every request gets its own card and its own answer: one Allow releases exactly one hook.
   */
  async onHookRequest(req: HookRequest, signal: AbortSignal): Promise<HookDecision> {
    if (!this.hookEnabled) return { decision: 'none', reason: 'relay_off' }
    if (signal.aborted) return { decision: 'none', reason: 'hook_gone' }
    if (this.hookInFlight >= HOOK_MAX_OPEN) return { decision: 'none', reason: 'busy' }
    this.hookInFlight++
    try {
      return await this.runHook(req, signal)
    } catch (e) {
      this.ctx.log.warn('permission hook request failed', { error: (e as Error).message })
      return { decision: 'none', reason: 'internal' }
    } finally {
      this.hookInFlight--
    }
  }

  private async runHook(req: HookRequest, signal: AbortSignal): Promise<HookDecision> {
    const { ctx } = this
    const none = (reason: string): HookDecision => ({ decision: 'none', reason })
    const call = renderHookCall(req.tool_name, req.tool_input)
    if (!call) return none('unreadable')
    // Only the session this bridge is the channel of can have a relay twin: Claude Code sends that session's prompt to the
    // channel too. A twin means the relay card answers it; a second card would be a double.
    const mainSession = req.thread === undefined && req.pid !== undefined && this.sessionPids.has(req.pid)
    const relayMayCarry = mainSession && this.enabled
    if (relayMayCarry && (await this.waitForRelayTwin(req.tool_name, call.json, signal)))
      return none('relay_carries_it')
    if (signal.aborted) return none('hook_gone')
    if (!this.hookEnabled) return none('relay_off')
    const requestId = this.mintRequestId()
    if (!requestId) return none('internal')
    // a request with no proof says who it claims to be, so the owner can see who is asking
    const who =
      req.thread === undefined && req.pid !== undefined
        ? `[asked by pid ${req.pid}${req.cwd ? ` in ${req.cwd}` : ''}]`
        : ''
    const request = {
      request_id: requestId,
      tool_name: req.tool_name,
      description: [call.description, who].filter(Boolean).join(' '),
      input_preview: call.preview,
    }
    if (!PermissionRequestParams.safeParse(request).success) return none('unreadable')
    const nowMs = ctx.clock.now()
    // The hook's call is rendered here from the raw input, whole, so Claude Code's own cut-and-redact markers do not apply:
    // the version floor that guards a relayed preview is met by construction.
    const card = composePermissionCard({
      request,
      card_id: newId('c'),
      thread_id: req.thread ?? ctx.config.config.default_thread,
      now: nowMs,
      client_version: PERMISSION_MIN_CLIENT_VERSION,
      ...(this.explainer ? { explain: true } : {}),
      // the relay may be asking the same thing in a card of its own (its preview did not match exactly): say so, keep Allow
      ...(relayMayCarry ? { other_channels: ['Another card for this call'] } : {}),
    })
    this.ids.add(requestId)
    const frame = cardCreateFrame(nowMs, card)
    assertFrameFits(frame)
    ctx.ledger.create(card)
    this.pending.set(card.id, { card, requestId, hook: true })
    const answer = new Promise<HookDecision>((resolve) => {
      let timer: unknown
      let done = false
      const onAbort = () => this.closeHookCard(card.id, 'hook_gone')
      const settle = (d: HookDecision): boolean => {
        if (done) return false
        done = true
        ctx.clock.clearTimeout(timer)
        signal.removeEventListener('abort', onAbort)
        resolve(d)
        return !signal.aborted
      }
      this.hookWaiters.set(card.id, settle)
      signal.addEventListener('abort', onAbort, { once: true })
      timer = ctx.clock.setTimeout(() => this.closeHookCard(card.id, 'timeout'), this.hookMaxWaitMs)
    })
    try {
      await ctx.transport.sendDurable(frame)
    } catch (e) {
      // the app will never see it: nothing may answer it, and the prompt stays at the Mac
      this.drop(card.id, requestId, 'send_failed')
      ctx.ledger.expire(card.id)
      ctx.log.warn('permission hook card not sent', { error: (e as Error).message })
      return answer
    }
    ctx.expiry?.sync()
    // the model gets the command and Claude's own description, not the "asked by pid" note the bridge adds above
    const own =
      typeof (req.tool_input as { description?: unknown } | null)?.description === 'string'
        ? (req.tool_input as { description: string }).description
        : ''
    this.explainCard(card.id, explainRequestOf(req.tool_name, call.json, own))
    return answer
  }

  /** The hook gave up, died or ran out of time: the card closes on the phone and can answer nothing. */
  private closeHookCard(cardId: string, reason: string) {
    const row = this.ctx.ledger.get(cardId)
    if (row && row.state === 'pending') this.closeCard(row, reason)
    else {
      const p = this.pending.get(cardId)
      if (p) this.drop(cardId, p.requestId, reason)
    }
  }
}
