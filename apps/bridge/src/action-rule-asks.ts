// The kit's "ask first" rules on the phone (kit/hooks/action-rules.py; audit item 28, Pantheon 2026-11-15). An ask rule (push to
// main, a deploy, a publish, a send through a connector...) used to be approved by `action-rules.py approve`, which a session can
// run itself; the approval was a file it could also write. Now, with a Talos app on the machine, the approval is the owner's own
// signed tap on a card that shows the exact call, and it lives HERE, in this process, never in a file:
//   - `approve` asks over the hub socket (`ask_rule`): this raises one "Allow once: <rule>" card per call (asking again waits on
//     the same card) and answers when the owner taps. The card stays open if the asker gives up waiting.
//   - the PreToolUse check asks over the hub socket (`rule_take`) and is let through only when an approval for exactly this call,
//     from this same session, is here; it is used up by that one call.
//   - "Always allow <kind>" works as on the agent's own send cards (always-allow.ts): a rule of a send kind the owner always allows
//     is approved at once with a line in the thread, and the card's "Always allow" button adds the kind, from the signed tap only.
//     The kind is the BRIDGE's call, never the asker's (Delphi's review): only a starter rule in SHIPPED_ASK_RULES has one, and
//     only for a call every matching starter rule gives that same kind. A rule of the owner's file, or a rule id put on another call, is no
//     kind, so a card.
// The call is bound by its exact text: a Bash command and its folder, or any other tool's whole input (its description aside).
// Nothing a session sends can approve: an approval is made only in onResolved(), after inbound checked the owner's signature and
// the ledger, or by an always-allow the owner set. A restart forgets every approval (fail closed: the action asks again).
import { createHash } from 'node:crypto'
import {
  bindingFrom,
  Card,
  type CardBinding,
  type CardT,
  newId,
  payloadHash,
  permissionCallTail,
  permissionVisibleText,
  type SendKind,
  validateCard,
  visibleText,
} from '@talos-app/protocol'
import { addFromOwnerTap, allowWithoutCard, alwaysAllowedNow } from './always-allow.ts'
import type { LedgerRow } from './cards-ledger.ts'
import { type BridgeContext, defaultThreadRef } from './context.ts'
import { cardCreateFrame, cardUpdateFrame } from './frames-out.ts'
import { foldWhitespace } from './permission/hook-render.ts'
import { assertFrameFits } from './transport.ts'

/** An approval is good for one use, this long after the tap (the kit's old default). */
export const RULE_APPROVAL_MS = 15 * 60_000
/** An unanswered card lives an hour. */
export const RULE_CARD_EXPIRY_MS = 3600_000
/** At most this many "Allow once" cards wait at once; a session asking for more is told to wait. */
export const RULE_MAX_PENDING = 8
const MAX_BODY = 20_000

export const RULE_TEXT = {
  title: (rule: string) => `Allow once: ${rule}`.slice(0, 120),
  summary: (why: string) => (why.trim() || 'One of your "ask me first" rules stopped this.').slice(0, 280),
  warning: 'Runs exactly this, once. Anything else asks again.',
  allowed: 'Allowed once. Your agent can run it now.',
  used: 'Allowed once. The bridge restarted before it was used, so your agent has to ask again.',
} as const

/** Who asks: `thread` for a thread session the hub proved, absent for the main session. */
export type RuleCall = {
  thread?: string
  rule: string
  tool_name: string
  tool_input: unknown
  cwd?: string
}
export type RuleAsk = RuleCall & { why?: string }

/**
 * Every "ask" rule of kit/hooks/action-rules.yaml as shipped, in its order, with its send kind or null (a test keeps the two the
 * same). `send` is email for a mail tool, else message. The owner's own rules file is never read for this: a session can write
 * to it.
 */
export const SHIPPED_ASK_RULES: readonly {
  id: string
  kind: SendKind | 'send' | null
  tool: string
  command?: string
}[] = [
  {
    id: 'github-repo-public-or-delete',
    kind: null,
    tool: 'Bash',
    command:
      '(?:^|[;&|(\\n`])\\s*(?:sudo\\s+|env\\s+[^\\s=]+=\\S*\\s+|time\\s+|exec\\s+|command\\s+|[A-Za-z_][A-Za-z0-9_]*=[^\\s;&|(]*\\s+)*gh\\s+(?:repo\\s+(?:edit\\b[^\\n;&|]{0,2000}--visibility[\\s=]+public|create\\b[^\\n;&|]{0,2000}--public|delete)|api\\b(?:[^\\n;&|]{0,2000}(?:private=[\'"]?false|visibility=[\'"]?public)|(?=[^\\n;&|]{0,2000}(?:-X|--method)[\\s=]*[\'"]?[Dd][Ee][Ll][Ee][Tt][Ee]\\b)(?=[^\\n;&|]{0,2000}repos/)))',
  },
  {
    id: 'github-account',
    kind: null,
    tool: 'Bash',
    command:
      '(?:^|[;&|(\\n`])\\s*(?:sudo\\s+|env\\s+[^\\s=]+=\\S*\\s+|time\\s+|exec\\s+)*gh\\s+auth\\s+(?:switch|login|refresh|logout)\\b',
  },
  {
    id: 'push-to-main',
    kind: 'push',
    tool: 'Bash',
    command:
      '(?:^|[;&|(\\n`])\\s*(?:sudo\\s+|env\\s+[^\\s=]+=\\S*\\s+|time\\s+|exec\\s+)*git\\s+(?:-C\\s+\\S+\\s+)?push\\b[^;&|\\n]*(?<![\\w/.-])(?:main|master)(?![\\w.-])',
  },
  {
    id: 'deploy-or-publish',
    kind: 'deploy',
    tool: 'Bash',
    command:
      '(?:^|[;&|(\\n`])\\s*(?:sudo\\s+|env\\s+[^\\s=]+=\\S*\\s+|time\\s+|exec\\s+)*(?:vercel\\s+(?:deploy|--prod)|netlify\\s+deploy|railway\\s+(?:up|deploy|redeploy)|fly(?:ctl)?\\s+deploy|wrangler\\s+(?:deploy|publish)|firebase\\s+deploy|heroku\\s+(?:release|deploy)|terraform\\s+apply|kubectl\\s+(?:apply|delete)|(?:npm|pnpm|yarn)\\s+publish|twine\\s+upload|cargo\\s+publish|gem\\s+push|docker\\s+push)\\b',
  },
  {
    id: 'github-release-or-public',
    kind: 'publish',
    tool: 'Bash',
    command:
      '(?:^|[;&|(\\n`])\\s*(?:sudo\\s+|env\\s+[^\\s=]+=\\S*\\s+|time\\s+|exec\\s+)*gh\\s+release\\s+(?:create|delete|edit)',
  },
  {
    id: 'destructive-via-connector',
    kind: null,
    tool: 'mcp__.*__[A-Za-z_]*(?:publish|share(?!d_drives?(?:_metadata)?$)|trash|delete|schedule)[A-Za-z_]*',
  },
  {
    id: 'send-or-publish-via-connector',
    kind: 'send',
    tool: 'mcp__.*__[A-Za-z_]*(?:send|reply|forward|post_)[A-Za-z_]*',
  },
]

const matchesRule = (r: (typeof SHIPPED_ASK_RULES)[number], tool: string, command: unknown): boolean => {
  try {
    if (!new RegExp(`^(?:${r.tool})$`).test(tool)) return false
    // the COMMAND alone, never the folder (Delphi 2026-11-15: a folder named "a;git push origin main" must not make a call look
    // like a push); the folder is in the approval's key all the same
    if (r.command !== undefined) return typeof command === 'string' && new RegExp(r.command).test(command)
    return true
  } catch {
    return false
  }
}

/**
 * The send kind of this call, decided here, never by the asker (Delphi 2026-11-15). The named rule must be a shipped ask rule
 * with a kind that matches the call, AND every shipped ask rule that matches the call must have that same kind (one exception: a push chained with a deploy is the deploy): the hook stops at
 * the first rule that matches, so `git push origin main && gh repo delete x` is named push-to-main, and a repository delete
 * riding on a deploy must still be a card. Anything else is null: a card.
 */
export function ruleKindOf(c: RuleCall): SendKind | null {
  const named = SHIPPED_ASK_RULES.find((x) => x.id === c.rule)
  if (!named?.kind) return null
  const command = (c.tool_input as { command?: unknown } | null)?.command
  if (!matchesRule(named, c.tool_name, command)) return null
  const kindOf = (k: SendKind | 'send'): SendKind =>
    k === 'send' ? (/mail/i.test(c.tool_name) ? 'email' : 'message') : k
  const kinds = new Set<SendKind>()
  for (const r of SHIPPED_ASK_RULES) {
    if (!matchesRule(r, c.tool_name, command)) continue
    if (!r.kind) return null
    kinds.add(kindOf(r.kind))
  }
  // a push chained with a deploy is the deploy (the stricter: a push grant alone never covers it, a deploy grant covers both)
  if (kinds.size === 2 && kinds.has('push') && kinds.has('deploy')) return 'deploy'
  const want = kindOf(named.kind)
  return kinds.size === 1 && kinds.has(want) ? want : null
}
/** `allow` and `deny` come only from the owner's signed tap (or a kind he always allows); everything else is `none`. */
export type RuleAnswer = { decision: 'allow' | 'deny' | 'none'; reason: string }

/** JSON with every object's keys in order, so the same input always hashes the same. */
function canonical(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(canonical)
  if (v && typeof v === 'object')
    return Object.fromEntries(
      Object.keys(v as Record<string, unknown>)
        .sort()
        .map((k) => [k, canonical((v as Record<string, unknown>)[k])]),
    )
  return v
}

/**
 * What the approval is bound to, and what the card shows: a Bash command as text, anything else as its whole input. `shown` is
 * drawn the way a permission card draws a call (docs/CLAUDE-CODE.md C3.9): space runs and line breaks folded to visible markers,
 * hidden and direction-changing characters as [U+XXXX], so the owner approves what he can see.
 */
export function ruleCallShape(tool: string, input: unknown): { bound: unknown; shown: string } | undefined {
  const i = (input && typeof input === 'object' && !Array.isArray(input) ? input : {}) as Record<string, unknown>
  if (tool === 'Bash') {
    if (typeof i.command !== 'string' || !i.command.trim()) return undefined
    // every field but Claude's description and the time limit: one that changes what runs (dangerouslyDisableSandbox, say)
    // is bound and shown, so a sandboxed yes never covers an unsandboxed call
    const { description: _d, timeout: _t, ...bound } = i
    const plain = Object.keys(bound).length === 1
    return {
      bound,
      shown: permissionVisibleText(foldWhitespace(plain ? i.command : JSON.stringify(canonical(bound)))),
    }
  }
  const { description: _d, ...rest } = i // Claude's own words about the call, not the call
  let shown: string
  try {
    shown = permissionVisibleText(foldWhitespace(JSON.stringify(canonical(rest))))
  } catch {
    return undefined
  }
  return { bound: rest, shown }
}

/** The approval's key: who asked, the rule, its kind (as decided here), the tool, the bound call and the folder. */
export function ruleCallKey(c: RuleCall): string | undefined {
  const shape = ruleCallShape(c.tool_name, c.tool_input)
  if (!shape) return undefined
  const text = JSON.stringify(
    canonical({
      who: c.thread ?? '',
      rule: c.rule,
      kind: ruleKindOf(c),
      tool: c.tool_name,
      call: shape.bound,
      cwd: c.cwd ?? '',
    }),
  )
  return createHash('sha256').update(text).digest('hex')
}

/** A card this file made. */
export function isRuleAskCard(binding: Pick<CardBinding, 'payload'>): boolean {
  const p = binding.payload as Record<string, unknown> | null | undefined
  return typeof p === 'object' && p !== null && typeof p.action_rule === 'object' && p.action_rule !== null
}

type RulePayload = { rule: string; key: string; kind: SendKind | null }
const payloadOf = (row: Pick<LedgerRow, 'binding'>): RulePayload | undefined =>
  isRuleAskCard(row.binding) ? (row.binding.payload as { action_rule: RulePayload }).action_rule : undefined

export class ActionRuleAsks {
  /** key -> until (epoch ms). One use each. */
  private readonly approvals = new Map<string, number>()
  /** key -> people waiting on its open card. */
  private readonly waiters = new Map<string, Set<(a: RuleAnswer) => void>>()
  /** key -> its open card. */
  private readonly cards = new Map<string, string>()

  constructor(private readonly ctx: BridgeContext) {}

  private live(): boolean {
    return this.ctx.mode === 'live' && !this.ctx.worker && !this.ctx.superseded
  }

  /**
   * The PreToolUse check: an approval for exactly this call is used up and let through; a rule of a send kind the owner always
   * allows goes through with its line in the thread (as the agent's own card does); anything else is `none`.
   */
  async take(c: RuleCall): Promise<RuleAnswer> {
    if (!this.live()) return { decision: 'none', reason: 'not_live' }
    const key = ruleCallKey(c)
    const shape = ruleCallShape(c.tool_name, c.tool_input)
    if (!key || !shape) return { decision: 'none', reason: 'unreadable' }
    const until = this.approvals.get(key)
    this.approvals.delete(key)
    if (until === undefined) {
      const kind = ruleKindOf(c)
      if (!kind || !alwaysAllowedNow(this.ctx, kind)) return { decision: 'none', reason: 'not_approved' }
      await this.allowAlways(c, kind, shape.shown)
      return { decision: 'allow', reason: 'always' }
    }
    if (this.ctx.clock.now() > until) return { decision: 'none', reason: 'expired' }
    this.ctx.log.info('action rule: used an approval', { rule: c.rule })
    return { decision: 'allow', reason: 'owner' }
  }

  /**
   * `approve`: an approval for this call, from a kind the owner always allows or from his tap on the card raised here. Waits up
   * to waitMs (and while the asker is connected); the card stays open after that, and a tap still makes the approval.
   */
  async ask(c: RuleAsk, signal: AbortSignal, waitMs: number): Promise<RuleAnswer> {
    const { ctx } = this
    const none = (reason: string): RuleAnswer => ({ decision: 'none', reason })
    if (!this.live()) return none('not_live')
    const shape = ruleCallShape(c.tool_name, c.tool_input)
    const key = ruleCallKey(c)
    if (!shape || !key) return none('unreadable')
    const now = ctx.clock.now()
    const have = this.approvals.get(key)
    if (have !== undefined && have >= now) return { decision: 'allow', reason: 'already' }
    const kind = ruleKindOf(c)
    const thread = c.thread ?? defaultThreadRef(ctx).id
    if (kind && alwaysAllowedNow(ctx, kind)) {
      this.approvals.set(key, now + RULE_APPROVAL_MS)
      await this.allowAlways(c, kind, shape.shown)
      return { decision: 'allow', reason: 'always' }
    }
    // From here to the ledger write nothing awaits: two asks for one call make one card.
    const open = this.cards.get(key)
    if (!(open && ctx.ledger.get(open)?.state === 'pending')) {
      if (open) this.forget(key, none('closed'))
      if (shape.shown.length > MAX_BODY) return none('too_long')
      const pending = ctx.ledger.list('pending').filter((r) => r.actor === 'bridge' && isRuleAskCard(r.binding)).length
      if (pending >= RULE_MAX_PENDING) return none('busy')
      const card = this.card(c, key, kind, thread, shape.shown, now)
      if (typeof card === 'string') {
        ctx.log.warn('action rule card not drawn', { why: card })
        return none('unreadable')
      }
      const frame = cardCreateFrame(now, card)
      try {
        assertFrameFits(frame)
      } catch {
        return none('too_long')
      }
      ctx.ledger.create(card, 'bridge')
      this.cards.set(key, card.id)
      try {
        await ctx.transport.sendDurable(frame)
      } catch (e) {
        ctx.ledger.expire(card.id)
        this.forget(key, none('send_failed'))
        ctx.log.warn('action rule card not sent', { error: (e as Error).message })
        return none('send_failed')
      }
      ctx.expiry?.sync()
      ctx.log.info('action rule card posted', { card: card.id, rule: c.rule })
    }
    return this.wait(key, signal, waitMs)
  }

  private async allowAlways(c: RuleCall, kind: SendKind, shown: string): Promise<void> {
    this.ctx.log.info('action rule: always allowed', { rule: c.rule, kind })
    const thread = c.thread ?? defaultThreadRef(this.ctx).id
    await allowWithoutCard(this.ctx, { kind, title: `${c.rule}: ${shown}`, thread_id: thread, rule: c.rule })
  }

  private wait(key: string, signal: AbortSignal, waitMs: number): Promise<RuleAnswer> {
    const { ctx } = this
    return new Promise<RuleAnswer>((resolve) => {
      const set = this.waiters.get(key) ?? new Set()
      this.waiters.set(key, set)
      let timer: unknown
      const end = (a: RuleAnswer) => {
        set.delete(end)
        ctx.clock.clearTimeout(timer)
        signal.removeEventListener('abort', onAbort)
        resolve(a)
      }
      const onAbort = () => end({ decision: 'none', reason: 'gone' })
      set.add(end)
      if (signal.aborted) return onAbort()
      signal.addEventListener('abort', onAbort, { once: true })
      timer = ctx.clock.setTimeout(() => end({ decision: 'none', reason: 'waiting' }), waitMs)
    })
  }

  private forget(key: string, a: RuleAnswer) {
    this.cards.delete(key)
    const set = this.waiters.get(key)
    this.waiters.delete(key)
    for (const w of [...(set ?? [])]) w(a)
  }

  private card(
    c: RuleAsk,
    key: string,
    kind: SendKind | null,
    thread: string,
    shown: string,
    now: number,
  ): CardT | string {
    const candidate = {
      id: newId('c'),
      thread_id: thread,
      kind: kind ?? ('generic' as const),
      title: visibleText(RULE_TEXT.title(c.rule)).slice(0, 120),
      summary: visibleText(RULE_TEXT.summary(c.why ?? '')).slice(0, 280),
      destination: [
        { label: 'Tool', value: permissionVisibleText(c.tool_name).slice(0, 500) },
        ...(c.cwd ? [{ label: 'Folder', value: permissionVisibleText(c.cwd).slice(0, 500) }] : []),
      ],
      body: shown,
      body_format: 'plain' as const,
      // the end of the call, pinned, as on a permission card: a long call cannot hide its last part below the fold
      fields: [{ key: 'ends_with', label: 'Ends with', value: permissionCallTail(shown), editable: false }],
      attachments: [],
      warning: RULE_TEXT.warning,
      primary_label: 'Allow once',
      kill_label: 'Deny',
      allow_edit: false,
      allow_revise: false,
      // a send kind: approved in the app only, never from a notification
      risk: kind ? ('high' as const) : ('low' as const),
      origin: 'background' as const,
      payload: { v: 1, action_rule: { rule: c.rule, key, kind } satisfies RulePayload },
      payload_hash: `sha256:${'0'.repeat(64)}`,
      state: 'pending' as const,
      created_at: new Date(now).toISOString(),
      expires_at: new Date(now + RULE_CARD_EXPIRY_MS).toISOString(),
    }
    const parsed = Card.safeParse(candidate)
    if (!parsed.success) return `bad card (${parsed.error.issues[0]?.path.join('.')})`
    const card: CardT = parsed.data
    const issues = validateCard(card)
    if (issues.length) return `bad card (${issues.join(', ')})`
    card.payload_hash = payloadHash(bindingFrom(card))
    return card
  }

  /**
   * The owner answered (inbound checked his signature and moved the ledger). The ONLY place an approval is made from a tap.
   * `always`: his signed "Always allow <kind>" tap (card.resolve only, never a notification).
   */
  async onResolved(row: LedgerRow, action: 'primary' | 'kill' | 'revise', always: boolean): Promise<void> {
    const { ctx } = this
    const p = payloadOf(row)
    if (!p) return
    if (action !== 'primary') {
      this.forget(p.key, { decision: 'deny', reason: 'owner' })
      return
    }
    // an approval only for a card this process raised: one from before a restart is ended in words (recover)
    if (this.cards.get(p.key) !== row.id) return this.end(row, false, RULE_TEXT.used)
    this.approvals.set(p.key, ctx.clock.now() + RULE_APPROVAL_MS)
    ctx.log.info('action rule: allowed once by the owner', { rule: p.rule })
    if (always && p.kind)
      await addFromOwnerTap(ctx, p.kind, row.thread_id).catch((e) =>
        ctx.log.warn('always allow not recorded', { card: row.id, error: (e as Error).message }),
      )
    this.forget(p.key, { decision: 'allow', reason: 'owner' })
    await this.end(row, true, RULE_TEXT.allowed)
  }

  /** The card expired or went away: whoever waits on it hears `none`. */
  onCardGone(cardId: string): void {
    for (const [key, id] of this.cards) if (id === cardId) this.forget(key, { decision: 'none', reason: 'expired' })
  }

  /** Once per process: cards from an earlier one can make no approval (it lived in that process). */
  recover(): Promise<void> {
    const { ctx } = this
    for (const r of ctx.ledger.list('pending'))
      if (r.actor === 'bridge' && isRuleAskCard(r.binding) && ctx.ledger.expire(r.id))
        void ctx.transport
          .sendDurable(
            cardUpdateFrame(ctx.clock.now(), { card_id: r.id, state: 'expired', reason: 'bridge_restarted' }),
          )
          .catch((e) => ctx.log.warn('card.update not sent', { error: (e as Error).message }))
    const rows = ctx.ledger
      .list('resolved')
      .filter((r) => r.actor === 'bridge' && isRuleAskCard(r.binding) && r.resolution?.action === 'primary')
    return Promise.all(rows.map((r) => this.end(r, false, RULE_TEXT.used))).then(() => {})
  }

  private async end(row: LedgerRow, ok: boolean, text: string): Promise<void> {
    const { ctx } = this
    ctx.ledger.finish(row.id, ok)
    await ctx.transport
      .sendDurable(
        cardUpdateFrame(ctx.clock.now(), {
          card_id: row.id,
          state: ok ? 'done' : 'failed',
          result: { ok, text, at: new Date(ctx.clock.now()).toISOString() },
        }),
      )
      .catch((e) => ctx.log.warn('card.update not sent', { error: (e as Error).message }))
  }
}
