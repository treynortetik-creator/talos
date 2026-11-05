// `card` and `card_result` (spec 4.4, 4.5). The binding goes into the Mac ledger BEFORE card.create is sent, so a
// resolve can never arrive for a card the ledger does not know.
import {
  AGENT_CARD_KINDS,
  bindingFrom,
  Card,
  type CardT,
  isAgentCardKind,
  newId,
  payloadHash,
  validateCard,
} from '@talos-app/protocol'
import { touchThread } from '../context.ts'
import { cardCreateFrame, cardUpdateFrame } from '../frames-out.ts'
import { assertFrameFits, type DurableResult, RelayRejectedError } from '../transport.ts'
import { mintRisk } from '../trust.ts'
import { fail, needStr, ok, str, type Tool, ToolError, threadArg, threadProps } from './common.ts'
import { uploadAll } from './send.ts'

// Owner call O2: a background card used to die unseen after 30 minutes. It now lives a day, like a chat card; the relay
// sends one reminder about an hour before it expires. (An app card's 10 minutes is a different thing: `APP_CARD_EXPIRY_MS`.)
const DEFAULT_EXPIRY_S = { background: 86_400, chat: 86_400 } as const
const MAX_EXPIRY_S = 604_800

export const card: Tool = {
  name: 'card',
  description:
    "Ask the owner to approve something before you do it. Anything that sends, posts, deploys, pays or deletes on the owner's behalf goes through a card first; act only on a card_action with action PRIMARY, exactly as approved, then call card_result.",
  inputSchema: {
    type: 'object',
    properties: {
      ...threadProps,
      kind: { type: 'string', enum: [...AGENT_CARD_KINDS] },
      title: { type: 'string', description: 'Up to 120 characters.' },
      primary_label: { type: 'string', description: 'The approve button, e.g. "Send", "Deploy to prod", "Pay $40".' },
      kill_label: { type: 'string', description: 'The kill button; must name the target, e.g. "Kill draft".' },
      risk: {
        type: 'string',
        enum: ['low', 'high'],
        description: 'high = leaves the app, irreversible, spends or deletes (the owner must re-authenticate).',
      },
      origin: { type: 'string', enum: ['chat', 'background'] },
      destination: {
        type: 'array',
        items: {
          type: 'object',
          properties: { label: { type: 'string' }, value: { type: 'string' } },
          required: ['label', 'value'],
        },
        description: 'Required unless kind is decision or generic.',
      },
      body: { type: 'string' },
      body_format: { type: 'string', enum: ['markdown', 'plain'] },
      fields: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            key: { type: 'string' },
            label: { type: 'string' },
            value: { type: 'string' },
            editable: { type: 'boolean' },
            multiline: { type: 'boolean' },
          },
          required: ['key', 'label', 'value'],
        },
      },
      attachments: { type: 'array', items: { type: 'string' }, description: 'Absolute paths.' },
      warning: { type: 'string', description: 'Up to 160 characters, e.g. "Goes outside this app. Can\'t be unsent."' },
      expires_in_s: { type: 'number', description: 'Default 86400 (one day) for background and chat; at most 604800.' },
      payload: { description: 'Your own opaque data, up to 64 KiB. Shown to the owner under Details.' },
      related_event_id: { type: 'string' },
      supersedes: { type: 'string', description: 'Card id this one replaces (after a revise).' },
      allow_edit: { type: 'boolean' },
      allow_revise: { type: 'boolean' },
    },
    required: ['kind', 'title', 'primary_label', 'kill_label', 'risk', 'origin'],
  },
  async handler(ctx, args) {
    try {
      // Only the bridge's schedule path mints kind:'schedule' (docs/SCHEDULES.md S6.1, S8.4); the agent uses schedule_propose.
      if (args.kind === 'schedule')
        throw new ToolError("kind 'schedule' cards come from the scheduler only: use schedule_propose, not card")
      // kind:'permission' cards come only from Claude Code's own permission prompts (docs/CLAUDE-CODE.md C3.2). An
      // allowlist, so a kind added to Card later is refused here until someone decides the agent may mint it.
      if (!isAgentCardKind(args.kind)) throw new ToolError(`kind must be one of ${AGENT_CARD_KINDS.join(', ')}`)
      const threadId = threadArg(ctx, args)
      const origin = args.origin
      if (origin !== 'chat' && origin !== 'background') throw new ToolError('origin must be chat or background')
      const nowMs = ctx.clock.now()
      const expiresIn = typeof args.expires_in_s === 'number' ? args.expires_in_s : DEFAULT_EXPIRY_S[origin]
      if (!(expiresIn >= 1) || expiresIn > MAX_EXPIRY_S)
        throw new ToolError(`expires_in_s must be between 1 and ${MAX_EXPIRY_S}`)
      const attachmentPaths = args.attachments
      if (
        attachmentPaths !== undefined &&
        (!Array.isArray(attachmentPaths) || attachmentPaths.some((p) => typeof p !== 'string'))
      )
        throw new ToolError('attachments must be an array of absolute paths')
      const attachments = await uploadAll(ctx, (attachmentPaths as string[] | undefined) ?? [])
      const candidate: Record<string, unknown> = {
        id: newId('c'),
        thread_id: threadId,
        kind: args.kind,
        title: args.title,
        destination: args.destination ?? [],
        body_format: args.body_format ?? 'plain',
        fields: args.fields ?? [],
        attachments,
        primary_label: args.primary_label,
        kill_label: args.kill_label,
        risk: mintRisk(ctx.config.config, String(args.kind), args.risk),
        origin,
        payload_hash: `sha256:${'0'.repeat(64)}`,
        state: 'pending',
        created_at: new Date(nowMs).toISOString(),
        expires_at: new Date(nowMs + expiresIn * 1000).toISOString(),
      }
      for (const k of [
        'body',
        'warning',
        'related_event_id',
        'payload',
        'supersedes',
        'allow_edit',
        'allow_revise',
      ] as const) {
        if (args[k] !== undefined) candidate[k] = args[k]
      }
      const parsed = Card.safeParse(candidate)
      if (!parsed.success) {
        const i = parsed.error.issues[0]
        throw new ToolError(`invalid card: ${i?.path.join('.') || '(root)'}: ${i?.message ?? 'invalid'}`)
      }
      const c: CardT = parsed.data
      const issues = validateCard(c)
      if (issues.length) throw new ToolError(`invalid card: ${issues.join(', ')}`)
      c.payload_hash = payloadHash(bindingFrom(c))
      const createFrame = cardCreateFrame(nowMs, c)
      assertFrameFits(createFrame) // a schema-valid card can still be over the relay's frame limit; refuse it up front
      ctx.ledger.create(c)
      let r: DurableResult
      try {
        r = await ctx.transport.sendDurable(createFrame)
      } catch (e) {
        if (e instanceof RelayRejectedError) {
          ctx.ledger.expire(c.id) // the relay will never show this card; do not leave a pending row with a timer
          ctx.expiry?.cancel(c.id)
        }
        throw e
      }
      if (c.supersedes && ctx.ledger.supersede(c.supersedes)) {
        ctx.expiry?.cancel(c.supersedes)
        ctx.transport
          .sendDurable(cardUpdateFrame(nowMs, { card_id: c.supersedes, state: 'superseded', reason: 'superseded' }))
          .catch((e) => ctx.log.warn('card.update not sent', { error: (e as Error).message }))
      }
      ctx.expiry?.sync()
      ctx.seen.answered(threadId) // a card is the agent answering with a question; D39 must not report it as lost
      const tail = r.state === 'acked' ? '' : ' (relay unreachable; queued)'
      return ok(`card ${c.id} pending, expires ${c.expires_at}, ${c.payload_hash}${tail}`)
    } catch (e) {
      return fail((e as Error).message)
    }
  },
}

export const cardResult: Tool = {
  name: 'card_result',
  liveOnly: true,
  description: 'Report the outcome after acting on an approved card (card_action PRIMARY).',
  inputSchema: {
    type: 'object',
    properties: {
      card_id: { type: 'string' },
      ok: { type: 'boolean' },
      text: { type: 'string', description: 'What happened, up to 500 characters.' },
    },
    required: ['card_id', 'ok', 'text'],
  },
  async handler(ctx, args) {
    try {
      const id = needStr(args, 'card_id')
      if (typeof args.ok !== 'boolean') throw new ToolError('ok must be true or false')
      const text = (str(args.text) ?? '').slice(0, 500)
      const row = ctx.ledger.get(id)
      if (!row) throw new ToolError(`unknown card ${id}`)
      // A schedule card's outcome is the bridge's: it wrote (or failed to write) the job, and only it says what happened (S3.4)
      if (row.actor === 'bridge')
        throw new ToolError(`card ${id} is a scheduler card: the bridge reports its result, not you`)
      if (row.state !== 'resolved') throw new ToolError(`card ${id} is not awaiting a result (state: ${row.state})`)
      if (row.resolution?.action !== 'primary')
        throw new ToolError(`card ${id} was not approved; there is nothing to report`)
      const state = args.ok ? 'done' : 'failed'
      const update = cardUpdateFrame(ctx.clock.now(), {
        card_id: id,
        state,
        result: { ok: args.ok, text, at: new Date(ctx.clock.now()).toISOString() },
      })
      // A worker's frame can fail outright (hub down, and card.update has no HTTP path): send first, so a failure
      // leaves the card open and the result can be retried. The live bridge's outbox never loses it.
      if (ctx.worker) await ctx.transport.sendDurable(update)
      if (!ctx.ledger.finish(id, args.ok)) throw new ToolError(`card ${id} is not awaiting a result`)
      touchThread(ctx, row.thread_id)
      if (!ctx.worker) await ctx.transport.sendDurable(update)
      return ok(`card ${id} ${state}`)
    } catch (e) {
      return fail((e as Error).message)
    }
  },
}
