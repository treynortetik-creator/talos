// Permission prompts on the phone (docs/CLAUDE-CODE.md C3.2-C3.5). Claude Code relays a tool approval prompt to this
// bridge; the bridge turns it into a `kind:'permission'` card and answers with a verdict ONLY after an owner-signed
// `card.resolve` passes the SPEC 4.5 ledger checks. A tap approves (the owner's rule, 2026-11-13): no step-up; a part of
// the call that is not shown, or an older Claude Code, is a note on the card, not a refusal.
//
// Fail closed where no answer can be delivered: an unreadable request, a failed card send, a restart, a stale or unsigned
// frame, a closed or repeated id all end with NO verdict, so the prompt stays open at the Mac. The only
// message this module ever sends to Claude Code with `allow` is the one at the end of `onResolved`, and only on the path
// where permissionVerdictFor() said so.

import { join } from 'node:path'
import {
  type CardT,
  cleanDenyNote,
  cleanSessionRules,
  composePermissionCard,
  type ErrorCodeT,
  newId,
  OpenPermissionIds,
  PERMISSION_MIN_CLIENT_VERSION,
  PERMISSION_OTHER_CHANNEL_NOTE,
  PERMISSION_REPEAT_WARNING,
  PermissionRequestParams,
  type PermissionVerdictT,
  permissionCardAllowsPrimary,
  permissionHiddenReasons,
  permissionVerdictFor,
  sessionRulesHash,
  validSessionOffer,
} from '@talos-app/protocol'
import type { LedgerRow } from '../cards-ledger.ts'
import type { BridgeContext } from '../context.ts'
import { cardCreateFrame, cardUpdateFrame } from '../frames-out.ts'
import { agentDirFromEnv } from '../last-good.ts'
import { say } from '../owner-words.ts'
import { assertFrameFits, type DurableResult } from '../transport.ts'
import { askRuleFiles, askRulesIn } from './ask-rules.ts'
import { askRuleMatches, BYPASS_MODE } from './ask-why.ts'
import { type Explainer, type ExplainRequest, explainRequestOf, explainToCard } from './explainer.ts'
import { agentFileWarning } from './frontmatter-risk.ts'
import { renderHookCall } from './hook-render.ts'
import { parseQuestions } from './question.ts'
import { ResultWatch, safeTranscriptPath } from './transcript-watch.ts'

export type VerdictSender = (verdict: PermissionVerdictT) => Promise<void>
/** `hook`: raised for a PermissionRequest hook (kit/hooks/permission-relay.py), answered to that hook and not over MCP. */
/** A channel request, as `onRequest` parsed it. */
type ChannelRequest = Parameters<typeof composePermissionCard>[0]['request']
/**
 * `paired`: for a hook card that took the place of a channel card, the channel request it stands in for. If the hook ends with no
 * answer (it died, was ended, timed out, or its card could not be sent) the prompt is still open at Claude Code, so that channel card is
 * raised again (`drop`).
 */
type Pending = {
  card: CardT
  requestId: string
  hook?: true
  mismatch?: boolean
  paired?: ChannelRequest
  /** The exact-call watch of this card (`watchResult`); a channel card raised again takes it over from its hook card. */
  armed?: ResultWatch
  /** Set on a channel card a hook's id was attached to (route H2): tool + input. A second request with that key ends the watch (see `seen`). */
  carriedKey?: string
}

/**
 * A prompt a PermissionRequest hook reports. `thread` is a PROVEN worker thread (hub/server.ts), absent for the main session;
 * `pid` and `cwd` are what a main-session hook says about itself (shown on its card, never trusted for anything else).
 */
export type HookRequest = {
  thread?: string
  tool_name: string
  tool_input: unknown
  pid?: number
  cwd?: string
  /** The session's permission mode as the hook's input names it (`permission_mode`); used only for the "why it asked" line. */
  mode?: string
  /** The rule Claude Code offered for "Allow for this session", as the hook kept it (checked again by `cleanSessionRules` when the card is made). */
  suggest?: { rules: unknown }
  /**
   * The call this prompt is for, when the hook tied it to exactly ONE PreToolUse record of its own session: the call's tool_use id, the
   * session, the subagent (when the call is a subagent's) and the transcript path the hook was given. `watchResult` reads the transcript.
   */
  session_id?: string
  tool_use_id?: string
  agent_id?: string
  transcript_path?: string
}
/** `allow` and `deny` are only ever the owner's signed answer to the card; everything else is `none` (leave the prompt alone). */
export type HookDecision = {
  decision: 'allow' | 'deny' | 'answer' | 'none'
  reason: string
  /** With `answer` only (an AskUserQuestion, permission/question.ts): the question text to its answer, which the hook hands back as `updatedInput.answers`. */
  answers?: Record<string, string>
  /** The owner's own words with a `deny` (cleaned, capped): signed in the card.resolve, so no program wrote them. Never logged. */
  note?: string
  /** With an `allow` only: the owner's signed tap chose "Allow for this session". The hook prints its own stored rule; nothing here names one. */
  session?: true
  /** With `session`: the hash the owner signed, which the hook compares with its own stored rules. */
  session_hash?: string
}

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
/** How often a hook card's transcript is looked at for its call's result. */
const RESULT_WATCH_MS = 1_000
/** A hook with a known call id ended with no word: how long, in steps, its call's result is looked for before the channel card is raised again. */
const RERAISE_LOOK_MS = 500
const RERAISE_STEP_MS = 100
/** Why a hook card closed with no answer from the owner (relay.ts `drop`): the prompt is still open, so a channel card it replaced comes back. */
const HOOK_ENDED_UNANSWERED = new Set(['hook_gone', 'timeout', 'send_failed'])
/** What a card shows of the description whole (protocol permission.ts MAX_SHOWN). */
const MAX_CARD_DESCRIPTION = 19_000
/** What the session is told when a change to agent files is too long for a card (the hub keeps the first 120 characters). */
export const TOO_LONG_AGENT_CHANGE =
  'This change to a Claude agent, skill or command file is too long to show the owner on a card, and it changes settings the owner must see. Make it as smaller edits.'
const RECENT_RELAY_MS = 15_000
/** How long a channel request is remembered in `seen`: far longer than any card send can wait (an 8 s ack plus the HTTP fallback), so a held send never loses its own entry. */
const SEEN_KEEP_MS = 120_000
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

/** A relay card that can stand in for a hook's. `sent` settles once the send is over: true when it went, false when it threw. */
type RelayNote = {
  tool: string
  json: string
  at: number
  sent: Promise<boolean>
  cardId: string
  params: ChannelRequest
}
/** A Main-session hook card with a session offer that no relay card has been paired with yet (a relay request for the same call is then not made). */
type HookOffer = { tool: string; json: string; at: number }

export class PermissionRelay {
  private readonly ids = new OpenPermissionIds()
  private readonly pending = new Map<string, Pending>()
  /** Hook cards still waiting: cardId -> settle (false when the hook is already known to be gone). */
  private readonly hookWaiters = new Map<string, (d: HookDecision) => boolean>()
  private hookInFlight = 0
  private recentRelay: RelayNote[] = []
  /** Open hook cards (cardId) that won over the channel's card and wait for a channel request that is not here yet. */
  private readonly hookOffers = new Map<string, HookOffer>()
  private sessionPids = new Set<number>()
  private readonly graceWake = new Set<() => void>()
  private hookGraceMs = HOOK_RELAY_GRACE_MS
  private hookMaxWaitMs = HOOK_MAX_WAIT_MS
  /** How often the transcript is looked at for a hook card whose call is known (one lstat, plus the appended bytes). */
  private watchMs = RESULT_WATCH_MS
  private reraiseLookMs = RERAISE_LOOK_MS
  /** Channel cards waiting out the look before they are raised again (`raiseAgain`): their timers, so a stop can cancel them. */
  private readonly looking = new Map<object, unknown>()
  /**
   * Every channel request of the last `RECENT_RELAY_MS`, by tool and input, taken by a hook or not (`recentRelay` loses a note when a hook takes it).
   * A hook's id may go on a channel card only when exactly ONE request with that tool and input was seen: with two, which hook belongs to
   * which card is a guess (arrival order, not identity), and a wrong guess would close a card whose prompt is still open.
   */
  private seen: { tool: string; json: string; at: number }[] = []
  /** Hook cards whose exact call is watched for a result (`watchResult`): cardId -> its timer. Only while the card is pending. */
  private readonly watches = new Map<string, unknown>()
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

  /** The ask rules in the agent folder's and the user's settings files (an agent may edit its own, by the owner's rule, so they are not proof the owner wrote them), for the "why it asked" line (default: the agent folder's and the user's settings files). */
  setAskRuleSource(fn: () => string[]) {
    this.askRules = fn
  }
  private askRules: () => string[] = () => {
    const agentDir = agentDirFromEnv(process.env)
    if (!agentDir) return []
    return askRuleFiles(agentDir, this.ctx.env.claudeConfigDir).flatMap(askRulesIn)
  }

  /**
   * Why Claude Code asked, when that is KNOWN (ask-why.ts): this is the main session's own hook, it says it is in bypassPermissions,
   * and the call matches an ask rule in the owner's settings. Never throws; anything else is unset (no line on the card).
   */
  private askedWhy(req: HookRequest, mainSession: boolean): 'your_rule' | undefined {
    if (!mainSession || req.mode !== BYPASS_MODE) return undefined
    try {
      return askRuleMatches(this.askRules(), req.tool_name, req.tool_input) ? 'your_rule' : undefined
    } catch {
      return undefined
    }
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
      // The reason (a fixed set), the tool and the length only: never the call. An MCP tool's name carries a server name
      // the owner chose, so it is logged as `mcp`; a stop (the bridge shutting down) is not a failure worth a line.
      const explain = await explainToCard(explainer, req, (reason) => {
        if (reason === 'closed') return
        const tool = req.tool.startsWith('mcp__') ? 'mcp' : req.tool.slice(0, 40)
        ctx.log.warn('card explanation failed', { reason, tool, input_chars: req.input.length })
      })
      if (!this.pending.has(cardId) || ctx.ledger.get(cardId)?.state !== 'pending') return
      // a call the explainer says does not match what it claims takes no "for this session" tap (onResolved)
      const open = this.pending.get(cardId)
      if (open && explain.status === 'ready' && explain.mismatch) open.mismatch = true
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
  setHookTimings(t: {
    graceMs?: number
    maxWaitMs?: number
    watchMs?: number
    reraiseLookMs?: number
    questionUnblockMs?: number
  }) {
    if (t.questionUnblockMs !== undefined) this.ctx.questions?.setUnblockMs(t.questionUnblockMs)
    if (t.graceMs !== undefined) this.hookGraceMs = t.graceMs
    if (t.watchMs !== undefined) this.watchMs = t.watchMs
    if (t.reraiseLookMs !== undefined) this.reraiseLookMs = t.reraiseLookMs
    if (t.maxWaitMs !== undefined) this.hookMaxWaitMs = t.maxWaitMs
  }

  /**
   * Hook cards need only the owner's switch and a live bridge: they answer over the hub socket, not over the MCP channel, so
   * "declared at start" does not matter. A worker session, which never declares the relay, is covered by this.
   */
  get hookEnabled(): boolean {
    return this.ctx.mode === 'live' && !this.ctx.superseded && this.configured
  }

  /** The owner turned the relay on after this session started: it cannot work until the session restarts. */
  get needsRestart(): boolean {
    return this.ctx.mode === 'live' && this.configured && this.declaredAtStart === false
  }

  /** The relay works only for a live bridge that declared it at start AND whose owner still has it on. */
  get enabled(): boolean {
    return this.ctx.mode === 'live' && !this.ctx.superseded && this.configured && this.declaredAtStart !== false
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
  async onRequest(params: unknown, again = false, armed?: ResultWatch): Promise<void> {
    const { ctx } = this
    let cardId: string | undefined
    let requestId: string | undefined
    try {
      if (!this.enabled) return ctx.log.warn('permission_request ignored: the relay is off')
      const parsed = PermissionRequestParams.safeParse(params)
      if (!parsed.success) return ctx.log.warn('permission_request ignored: not in the documented format')
      const request = parsed.data
      requestId = request.request_id
      // `again`: the card of a prompt that is still open is being raised a second time (its hook card ended unanswered): the same id, not a repeat
      const repeated = again ? false : this.ids.hasSeen(request.request_id)
      if (!again) this.noteSeen(request.tool_name, request.input_preview)
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
      // only a relay card that offers Allow AND shows the whole call can stand in for a hook's: the hook renders the call whole
      // from the raw input, so where Claude Code's preview is cut or masked, the hook's card is the one that shows all of it.
      // It is noted BEFORE the send: a send can take far longer than the hook's grace, and the hook must find its twin meanwhile.
      const stands =
        permissionCardAllowsPrimary(card) &&
        (card.warning === undefined || PERMISSION_OTHER_CHANNEL_NOTE.test(card.warning)) &&
        permissionHiddenReasons(request).length === 0
      // A Main-session hook card with a session offer already carries this very call (it won, see runHook): no second card, and no
      // verdict is ever sent for this channel request, so Claude Code is answered once, by the hook.
      if (!again && stands && this.claimHookOffer(request)) {
        return ctx.log.debug('permission_request not made into a card: a hook card with a session offer carries it')
      }
      if (again) this.ids.reopen(request.request_id)
      else this.ids.add(request.request_id)
      cardId = card.id
      const frame = cardCreateFrame(nowMs, card)
      assertFrameFits(frame)
      ctx.ledger.create(card)
      this.pending.set(card.id, { card, requestId: request.request_id, ...(armed ? { armed } : {}) })
      if (armed) this.startWatch(card.id, armed) // the same exact call: its result closes this card too, however long it is open
      const note =
        stands && !again // a card raised again is nobody's twin: no hook can rightly take it
          ? this.noteRelayRequest(request.tool_name, request.input_preview, card.id, request)
          : undefined
      try {
        await ctx.transport.sendDurable(frame)
      } catch (e) {
        // the app will never see it: nothing may answer it, and the prompt stays open at the Mac
        // a hook that already took the twin sees `sent` false and raises its own card; otherwise no hook may take it later
        if (note) {
          this.recentRelay = this.recentRelay.filter((r) => r !== note.entry)
          note.settle(false)
        }
        this.drop(card.id, request.request_id)
        ctx.ledger.expire(card.id)
        throw e
      }
      // a relay card dropped while its send was out (closed, expired) answers nothing, so it never stands in for the hook's
      note?.settle(this.pending.has(card.id))
      ctx.expiry?.sync()
      this.explainCard(card.id, explainRequestOf(request.tool_name, request.input_preview, request.description))
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
    // a repeated id: its id was closed when it came again (an answer could reach the wrong prompt), but the prompt itself is
    // still open at the Mac. Say that, not "already answered or closed"; the card stays as it is
    // Allow or Deny alike sends nothing (either answer could reach the wrong prompt); Deny still clears the card from the phone
    if (p?.card.warning === PERMISSION_REPEAT_WARNING) {
      if (action === 'kill' && row.state === 'pending') this.closeCard(row, 'permission_repeat')
      return {
        handled: true,
        ok: false,
        code: 'permission_hidden',
        reason:
          action === 'kill'
            ? say({
                mac: "Cleared from here. Nothing was sent: Claude Code's prompt is still open at the Mac.",
                linux: "Cleared from here. Nothing was sent: Claude Code's prompt is still open at your computer.",
              })
            : PERMISSION_REPEAT_WARNING,
      }
    }
    // relay switched off (config): open cards can no longer send anything (CC-C1-REVIEW F5)
    if (!(p?.hook ? this.hookEnabled : this.enabled) || !p || !this.ids.isOpen(p.requestId)) {
      if (row.state === 'pending') this.closeCard(row, 'permission_closed')
      return {
        handled: true,
        ok: false,
        code: 'permission_closed',
        reason: 'That prompt was already answered or closed.',
      }
    }
    // the one card Allow is refused on: a repeated id (an answer could reach the wrong prompt); everything else is a note
    if (action === 'primary' && !permissionCardAllowsPrimary(p.card))
      return {
        handled: true,
        ok: false,
        code: 'permission_hidden',
        reason:
          p.card.warning === PERMISSION_REPEAT_WARNING
            ? PERMISSION_REPEAT_WARNING
            : "This card can't approve the call.",
      }
    return { handled: true, ok: true }
  }

  /**
   * After the ledger accepted an owner-signed resolve. Sends the verdict, then closes the id (one verdict per id). Returns
   * `ok: false` when the verdict did not reach Claude Code (the card shows "failed"): the caller owes a tap from a
   * notification a refusal, because the relay told the phone "done" when it queued the tap.
   */
  async onResolved(
    row: LedgerRow,
    action: 'primary' | 'kill' | 'revise',
    ownerNote?: string,
    session?: boolean,
    sessionHash?: string,
  ): Promise<ResolveOutcome> {
    const { ctx } = this
    const p = this.pending.get(row.id)
    // what the owner reads when the verdict did not get through: what happened, never "answer it at the Mac"
    const WHY: Record<string, string> = {
      permission_closed: 'Not sent: that prompt was already answered or closed.',
      relay_off: 'Not sent: permission prompts are switched off in Talos.',
      no_channel: 'Not sent: Claude Code is not connected to Talos right now (the session may have ended).',
      send_failed: 'Not sent: Claude Code did not take the answer (it may have answered or closed the prompt).',
      permission_hidden: `Not sent: ${PERMISSION_REPEAT_WARNING}`,
    }
    const fail = (reason: string, code: ErrorCodeT): ResolveOutcome => {
      const text = WHY[reason] ?? 'Not sent to Claude Code.'
      ctx.ledger.finish(row.id, false)
      ctx.transport
        .sendDurable(
          cardUpdateFrame(ctx.clock.now(), {
            card_id: row.id,
            state: 'failed',
            reason,
            result: { ok: false, text, at: new Date(ctx.clock.now()).toISOString() },
          }),
        )
        .catch((e) => ctx.log.warn('card.update not sent', { error: (e as Error).message }))
      return { ok: false, code, reason: text }
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
      // The owner's note goes only with a Deny to a hook (an Allow, and a channel relay verdict, have no room for words). Cleaned
      // here as well as by the caller; it is owner text going into the agent's context and is never logged.
      const note = v.verdict.behavior === 'deny' ? cleanDenyNote(ownerNote) : undefined
      // "For this session" counts only on an allow to a hook, on a card that offered it; anywhere else the tap is the plain answer it always was
      // and only when the rules the owner saw are the rules this bridge holds (a relay that rewrote the button leaves a hash that does not match), and the explainer did not call the call a mismatch
      const held = cleanSessionRules(p.card.session_allow?.rules)
      const forSession =
        session === true &&
        v.verdict.behavior === 'allow' &&
        held !== undefined &&
        !p.mismatch &&
        sessionHash !== undefined &&
        sessionHash === sessionRulesHash(held)
      if (
        !waiter?.({
          decision: v.verdict.behavior,
          reason: 'owner',
          ...(note ? { note } : {}),
          ...(forSession ? { session: true as const, session_hash: sessionHash } : {}),
        })
      )
        return fail('send_failed', 'internal')
    } else {
      if (!this.sender) return fail('no_channel', 'permission_closed')
      // a send that fails is tried again twice (a moment's hiccup on the channel), then said as failed, with why
      let sent = false
      for (let attempt = 0; attempt < 3 && !sent; attempt++) {
        try {
          if (attempt > 0) await new Promise((r) => setTimeout(r, 250 * attempt))
          if (!this.sender) return fail('no_channel', 'permission_closed')
          await this.sender(v.verdict)
          sent = true
        } catch (e) {
          ctx.log.warn('permission verdict not sent', { error: (e as Error).message, attempt })
        }
      }
      if (!sent) return fail('send_failed', 'internal')
    }
    this.unwatch(row.id) // answered: nothing is left to watch for
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
    const gone = this.pending.get(cardId)
    this.pending.delete(cardId)
    this.hookOffers.delete(cardId)
    this.unwatch(cardId)
    this.ids.close(requestId)
    this.takeWaiter(cardId)?.({ decision: 'none', reason }) // a hook still waiting is told "no decision": it never reads as an answer
    // A hook card that stood in for a channel card and ended with NO answer: the prompt is still open, so the channel card comes back
    // (never after an answer, a stop, or the relay being switched off: those do not come through these reasons)
    if (gone?.paired && HOOK_ENDED_UNANSWERED.has(reason)) this.raiseAgain(gone.paired, gone.armed)
  }

  /**
   * Claude Code stops the hook on No and on Esc and writes the call's result only a moment later. A hook that knew its call's id is
   * therefore looked for in small steps (never blocking) for a short while: a result found means the prompt is over and nothing is
   * raised; none within the window and the channel card comes back WITH the watch, which still closes it on the result. No id: at once.
   */
  private raiseAgain(params: ChannelRequest, armed: ResultWatch | undefined) {
    if (!armed) return void this.onRequest(params, true)
    const token = {}
    const t0 = this.ctx.clock.now()
    const look = () => {
      this.looking.delete(token)
      if (!this.enabled) return
      if (armed.poll()) return this.ctx.log.debug('hook ended unanswered, its call has a result: no card raised again')
      const left = this.reraiseLookMs - (this.ctx.clock.now() - t0)
      if (left <= 0) return void this.onRequest(params, true, armed)
      this.looking.set(token, this.ctx.clock.setTimeout(look, Math.min(RERAISE_STEP_MS, left)))
    }
    look()
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
    for (const timer of this.looking.values()) this.ctx.clock.clearTimeout(timer) // a card waiting to be raised again is not raised
    this.looking.clear()
    for (const [cardId, p] of [...this.pending]) this.drop(cardId, p.requestId, 'bridge_stopped')
  }

  get openCount(): number {
    return this.ids.size
  }

  // ---- PermissionRequest hook path ------------------------------------------------------------------------------------

  private noteRelayRequest(tool: string, preview: string, cardId: string, params: ChannelRequest) {
    const now = this.ctx.clock.now()
    let settle: (sent: boolean) => void = () => {}
    const sent = new Promise<boolean>((resolve) => {
      settle = resolve
    })
    const entry: RelayNote = { tool, json: normPreview(preview), at: now, sent, cardId, params }
    this.recentRelay = this.recentRelay.filter((r) => now - r.at < RECENT_RELAY_MS).slice(-49)
    this.recentRelay.push(entry)
    for (const wake of [...this.graceWake]) wake()
    return { entry, settle }
  }

  private noteSeen(tool: string, preview: string) {
    const now = this.ctx.clock.now()
    this.seen = this.seen.filter((r) => now - r.at < SEEN_KEEP_MS).slice(-399)
    this.seen.push({ tool, json: normPreview(preview), at: now })
    // a second request with the key of a card that already has an id attached: which card the id belongs to is now a guess, so the watch ends
    const key = `${tool}\0${normPreview(preview)}`
    if (this.seenCount(tool, preview, now) < 2) return
    for (const [cardId, p] of this.pending)
      if (p.carriedKey === key) {
        this.unwatch(cardId)
        delete p.armed
        delete p.carriedKey
      }
  }

  /** The requests with this tool and input within `RECENT_RELAY_MS` of `at`, before or after it (`at`: when the note in question was made). */
  private seenCount(tool: string, json: string, at: number): number {
    const want = normPreview(json)
    return this.seen.filter((r) => Math.abs(r.at - at) < RECENT_RELAY_MS && r.tool === tool && r.json === want).length
  }

  /** A relay request for this call, arriving after a hook card with a session offer: pairs with one such card (once) and answers true. */
  private claimHookOffer(request: ChannelRequest): boolean {
    const now = this.ctx.clock.now()
    const want = normPreview(request.input_preview)
    for (const [cardId, o] of [...this.hookOffers]) {
      if (now - o.at >= RECENT_RELAY_MS)
        this.hookOffers.delete(cardId) // as old as a twin may be: a later prompt is not this one
      else if (o.tool === request.tool_name && o.json === want) {
        this.hookOffers.delete(cardId)
        const hook = this.pending.get(cardId)
        if (!hook) continue
        hook.paired = request // if this hook ends unanswered, the channel card is made after all
        return true
      }
    }
    return false
  }

  /**
   * Takes the relay card that stands in for this hook call, if one exists. Exact only: the same tool and the same whole input
   * once whitespace is folded. A preview Claude Code cut or reshaped is NOT a twin: a second card is a nuisance, a missing one
   * leaves the owner with a prompt on the Mac and nothing on the phone.
   */
  private takeRelayTwin(tool: string, json: string): RelayNote | undefined {
    const now = this.ctx.clock.now()
    this.recentRelay = this.recentRelay.filter((r) => now - r.at < RECENT_RELAY_MS)
    const want = normPreview(json)
    const i = this.recentRelay.findIndex((r) => r.tool === tool && r.json === want)
    if (i < 0) return undefined
    return this.recentRelay.splice(i, 1)[0]
  }

  private waitForRelayTwin(tool: string, json: string, signal: AbortSignal): Promise<RelayNote | undefined> {
    const first = this.takeRelayTwin(tool, json)
    if (first) return Promise.resolve(first)
    return new Promise<RelayNote | undefined>((resolve) => {
      let timer: unknown
      const end = (v: RelayNote | undefined) => {
        this.graceWake.delete(check)
        this.ctx.clock.clearTimeout(timer)
        signal.removeEventListener('abort', onAbort)
        resolve(v)
      }
      const check = () => {
        const twin = this.takeRelayTwin(tool, json)
        if (twin) end(twin)
      }
      const onAbort = () => end(undefined)
      this.graceWake.add(check)
      signal.addEventListener('abort', onAbort, { once: true })
      timer = this.ctx.clock.setTimeout(() => end(undefined), this.hookGraceMs)
    })
  }

  private awaitSent(sent: Promise<boolean>, signal: AbortSignal): Promise<boolean> {
    if (signal.aborted) return Promise.resolve(false)
    return new Promise<boolean>((resolve) => {
      const onAbort = () => resolve(false)
      signal.addEventListener('abort', onAbort, { once: true })
      void sent.then((ok) => {
        signal.removeEventListener('abort', onAbort)
        resolve(ok)
      })
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
   * relay raises (same composer, same ledger checks, no step-up) and resolves with the owner's answer.
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
    // an open AskUserQuestion is mirrored as a card per question and answered through the hook (permission/question.ts); any other input shape is an ordinary prompt
    if (req.tool_name === 'AskUserQuestion' && ctx.questions) {
      const asked = parseQuestions(req.tool_input)
      if (asked) return ctx.questions.ask(req, asked, signal)
    }
    const call = renderHookCall(req.tool_name, req.tool_input)
    if (!call) return none('unreadable')
    // Only the session this bridge is the channel of can have a relay twin: Claude Code sends that session's prompt to the
    // channel too. A twin means the relay card answers it; a second card would be a double.
    const mainSession = req.thread === undefined && req.pid !== undefined && this.sessionPids.has(req.pid)
    const relayMayCarry = mainSession && this.enabled
    // A Main-session hook that carries a session offer WINS over the channel's card: the channel verdict has no field for a session
    // rule, so the owner must see the hook's card (with its third button) and answer through the hook. The same check the composer uses.
    const hookWins = relayMayCarry && validSessionOffer(req.tool_name, req.suggest?.rules) !== undefined
    let twinSent = false
    let twin: RelayNote | undefined
    let carrier: RelayNote | undefined
    if (hookWins) {
      twin = this.takeRelayTwin(req.tool_name, call.json) // no waiting: a twin that is not here yet is caught when it arrives (claimHookOffer)
    } else if (relayMayCarry) {
      const found = await this.waitForRelayTwin(req.tool_name, call.json, signal)
      // the relay card is noted before its send: the twin only carries the prompt once that send went. Held no longer than the
      // send itself (sendDurable's own bounds) or this hook's abort, whichever comes first; a failed send means no twin
      carrier = found
      if (found) twinSent = await this.awaitSent(found.sent, signal)
    }
    if (twinSent) {
      // The hook ends here, but its call's id is known: the channel card is the one the owner sees, so the call's result closes IT.
      // Only when the pairing was no guess (exactly one channel request had this tool and input in the window, counted NOW, so one that
      // came while the send was out counts too) and only while the card is still open.
      if (carrier && this.seenCount(req.tool_name, call.json, carrier.at) === 1 && this.pending.has(carrier.cardId)) {
        this.watchResult(carrier.cardId, req)
        const p = this.pending.get(carrier.cardId)
        if (p?.armed) p.carriedKey = `${req.tool_name}\0${normPreview(call.json)}`
      }
      return none('relay_carries_it')
    }
    if (signal.aborted) return none('hook_gone')
    if (!this.hookEnabled) return none('relay_off')
    const requestId = this.mintRequestId()
    if (!requestId) return none('internal')
    // a request with no proof says who it claims to be, so the owner can see who is asking
    const who =
      req.thread === undefined && req.pid !== undefined
        ? `[asked by pid ${req.pid}${req.cwd ? ` in ${req.cwd}` : ''}]`
        : ''
    // an edit of an agent, skill or command file (or a command naming one): the card says first what it could change, in the
    // description, which the card shows whole
    const found = agentFileWarning(req.tool_name, req.tool_input, req.cwd, [
      ...(ctx.env.claudeConfigDir ? [ctx.env.claudeConfigDir] : []),
      join(ctx.env.userHome, '.claude'),
    ])
    const careful = found.length > 0 ? `Careful: ${found.join('; ')}. ` : ''
    const shown = [call.description, who].filter(Boolean).join(' ')
    const request = {
      request_id: requestId,
      tool_name: req.tool_name,
      description: careful ? [...`${careful}${shown}`].slice(0, MAX_CARD_DESCRIPTION).join('') : shown,
      input_preview: call.preview,
    }
    if (!PermissionRequestParams.safeParse(request).success) return none('unreadable')
    // A call too long to show whole drops the description from its card, and the warning with it. A change that needs the warning
    // gets no card: it is refused, so the session makes smaller edits the owner can read.
    if (found.length > 0 && permissionHiddenReasons(request).includes('too_long'))
      return { decision: 'deny', reason: TOO_LONG_AGENT_CHANGE }
    const nowMs = ctx.clock.now()
    // The hook's call is rendered here from the raw input, whole, so Claude Code's own cut-and-redact markers do not apply:
    // the version floor that guards a relayed preview is met by construction.
    const card = composePermissionCard({
      request,
      card_id: newId('c'),
      thread_id: req.thread ?? ctx.config.config.default_thread,
      now: nowMs,
      client_version: PERMISSION_MIN_CLIENT_VERSION,
      deny_note: true, // this card's Deny goes to the hook, whose deny answer can carry the owner's words
      // a rule Claude Code offered, plain enough to show: the card offers "for this session" too (permission.ts refuses an offer it cannot show whole)
      ...(req.suggest ? { session_allow: req.suggest } : {}),
      ...(this.askedWhy(req, mainSession) ? { asked_why: 'your_rule' as const } : {}),
      ...(this.explainer ? { explain: true } : {}),
      // the relay may be asking the same thing in a card of its own (its preview did not match exactly): say so, keep Allow
      // (said unless this card took the twin: a channel request that comes later is not made into a card, but nothing says it will)
      ...(relayMayCarry && !twin ? { other_channels: ['Another card for this call'] } : {}),
    })
    this.ids.add(requestId)
    const frame = cardCreateFrame(nowMs, card)
    assertFrameFits(frame)
    ctx.ledger.create(card)
    this.pending.set(card.id, { card, requestId, hook: true })
    this.watchResult(card.id, req)
    if (hookWins && !twin)
      this.hookOffers.set(card.id, { tool: req.tool_name, json: normPreview(call.json), at: nowMs })
    const answer = new Promise<HookDecision>((resolve) => {
      let timer: unknown
      let done = false
      // `prompt_over`: the hook said it knew its prompt ended (hub/server.ts); anything else is a hook that vanished with no word
      const onAbort = () => this.closeHookCard(card.id, signal.reason === 'prompt_over' ? 'prompt_over' : 'hook_gone')
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
    // Not awaited: the send can take many seconds, and a tap, a timeout or the hook leaving must be heard meanwhile.
    // The send starts here, before runHook returns (the Promise executor runs at once, and a synchronous throw from it becomes a
    // rejection). A throw in the handlers is logged if the logger still works, never left unhandled.
    const quietly = (what: string, f: () => void) => {
      try {
        f()
      } catch (e) {
        try {
          ctx.log.warn(`permission hook card: ${what} failed`, { error: (e as Error).message })
        } catch {}
      }
    }
    void new Promise<DurableResult>((r) => r(ctx.transport.sendDurable(frame))).then(
      () =>
        quietly('posted', () => {
          ctx.expiry?.sync()
          // answered, closed or timed out while the send was out: nothing is left to explain, and the relay's card stays as it was
          if (!this.pending.has(card.id)) return
          if (twin) void this.replaceTwin(twin, card.id)
          // the model gets the command and Claude's own description, not the "asked by pid" note the bridge adds above
          const own =
            typeof (req.tool_input as { description?: unknown } | null)?.description === 'string'
              ? (req.tool_input as { description: string }).description
              : ''
          // only after the create frame is sent: the explanation's update refers to the card
          this.explainCard(card.id, explainRequestOf(req.tool_name, call.json, own))
        }),
      (e) => {
        // the app will never see it: nothing may answer it, and the prompt stays at the Mac. First, so the waiter is answered;
        // only while this card is still open (an answered or closed card has nothing left to drop)
        quietly('drop', () => {
          if (this.pending.get(card.id)) this.drop(card.id, requestId, 'send_failed')
        })
        // the relay card that was to be replaced is still the owner's way to answer: it stays, and can be paired with again
        if (twin) {
          const back = twin
          void back.sent.then((ok) => {
            if (ok) this.recentRelay.push(back)
          })
        }
        quietly('expire', () => {
          ctx.ledger.expire(card.id)
          ctx.log.warn('permission hook card not sent', { error: (e as Error).message })
        })
      },
    )
    return answer
  }

  /**
   * The hook's card is out: the relay's card for the same call (the twin, once its own send went) is replaced by it. Only while the
   * hook's card is still open and the relay's still pending; an answer already given to the relay's card stands.
   */
  private async replaceTwin(twin: RelayNote, hookCardId: string): Promise<void> {
    try {
      if (!(await twin.sent) || !this.pending.has(hookCardId)) return
      const row = this.ctx.ledger.get(twin.cardId)
      if (row && row.state === 'pending') {
        this.closeCard(row, 'replaced_by_hook')
        // if the hook now ends with no answer, this channel card is raised again
        const hook = this.pending.get(hookCardId)
        if (hook) hook.paired = twin.params
      }
    } catch (e) {
      this.ctx.log.warn('relay card not replaced', { error: (e as Error).message })
    }
  }

  /**
   * A hook card whose hook knew its call's exact tool_use id: watch the session's transcript for that id's tool_result. A result is
   * written only when the call has finished (answered Yes and run, answered No, interrupted), so the prompt cannot be open any more:
   * the card expires as `prompt_over`, the hook is released with none, and nothing is raised again (a replaced or claimed channel
   * card stays as it is). Only an exact id counts, only while the card is pending, only appended bytes are read, and there is no time
   * limit. No id, a path of the wrong shape, or no result: the card stays open.
   */
  private watchResult(cardId: string, req: HookRequest) {
    if (!req.tool_use_id) return
    const path = safeTranscriptPath(req.transcript_path, req.session_id, req.agent_id)
    if (!path) return
    const w = new ResultWatch(path, req.tool_use_id)
    const p = this.pending.get(cardId)
    if (p) p.armed = w
    this.startWatch(cardId, w)
  }

  /** Polls `w` while the card is pending; the result closes it as `prompt_over`. Ends with the card (drop), never by time. */
  private startWatch(cardId: string, w: ResultWatch) {
    this.unwatch(cardId) // one card never has two loops
    const tick = () => {
      if (!this.pending.has(cardId)) return this.unwatch(cardId)
      if (w.poll()) {
        this.unwatch(cardId)
        return this.closeHookCard(cardId, 'prompt_over')
      }
      this.watches.set(cardId, this.ctx.clock.setTimeout(tick, this.watchMs))
    }
    this.watches.set(cardId, this.ctx.clock.setTimeout(tick, this.watchMs))
  }

  private unwatch(cardId: string) {
    const timer = this.watches.get(cardId)
    if (timer === undefined) return
    this.watches.delete(cardId)
    this.ctx.clock.clearTimeout(timer)
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
