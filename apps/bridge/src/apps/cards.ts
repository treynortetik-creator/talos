// The `app_action` card (M4.4): built by the bridge, never by the agent, so the owner approves the app's exact arguments,
// bound by payloadHash. The card lives in the same ledger as every card; `actor` says who acts on PRIMARY.
import {
  APP_CARD_EXPIRY_MS,
  bindingFrom,
  Card,
  type CardT,
  newId,
  payloadHash,
  sanitizeExternal,
  validateCard,
} from '@talos-app/protocol'
import { z } from 'zod'
import type { BridgeContext } from '../context.ts'
import { cardCreateFrame } from '../frames-out.ts'
import { assertFrameFits } from '../transport.ts'
import { mintRisk } from '../trust.ts'

export const AppCardPayload = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('app_request'),
    executor: z.enum(['agent', 'bridge']),
    view_id: z.string(),
    request_id: z.string(),
    server: z.string(),
    tool: z.string(),
    arguments: z.record(z.string(), z.unknown()),
  }),
  z.object({
    kind: z.literal('app_show'),
    executor: z.literal('bridge'),
    thread_id: z.string(),
    capture_id: z.string(),
    caption: z.string().optional(),
  }),
])
export type AppCardPayloadT = z.infer<typeof AppCardPayload>

const clean = (s: string, max: number) =>
  sanitizeExternal(s, max)
    .replace(/[\r\n\t]+/g, ' ')
    .slice(0, max)

export type AppCardSpec = {
  threadId: string
  title: string
  destination: Array<{ label: string; value: string }>
  body: string
  warning: string
  primaryLabel: string
  killLabel: string
  risk: 'low' | 'high'
  payload: AppCardPayloadT
}

export async function sendAppCard(ctx: BridgeContext, s: AppCardSpec): Promise<CardT> {
  const nowMs = ctx.clock.now()
  const candidate: Record<string, unknown> = {
    id: newId('c'),
    thread_id: s.threadId,
    kind: 'app_action',
    title: clean(s.title, 120),
    destination: s.destination.map((d) => ({ label: clean(d.label, 20), value: clean(d.value, 500) })),
    body: s.body.slice(0, 20_000),
    body_format: 'plain',
    fields: [],
    attachments: [],
    warning: clean(s.warning, 160),
    primary_label: clean(s.primaryLabel, 32),
    kill_label: clean(s.killLabel, 32),
    allow_edit: false,
    allow_revise: false,
    risk: mintRisk(ctx.config.config, 'app_action', s.risk),
    origin: 'chat',
    payload: s.payload,
    payload_hash: `sha256:${'0'.repeat(64)}`,
    state: 'pending',
    created_at: new Date(nowMs).toISOString(),
    expires_at: new Date(nowMs + APP_CARD_EXPIRY_MS).toISOString(),
  }
  const parsed = Card.safeParse(candidate)
  if (!parsed.success) throw new Error(`invalid app card: ${parsed.error.issues[0]?.path.join('.')}`)
  const c: CardT = parsed.data
  const issues = validateCard(c)
  if (issues.length) throw new Error(`invalid app card: ${issues.join(', ')}`)
  c.payload_hash = payloadHash(bindingFrom(c))
  const frame = cardCreateFrame(nowMs, c)
  assertFrameFits(frame)
  const executor = s.payload.executor
  // executor 'bridge': PRIMARY is applied by the bridge itself (the agent never hears of it). 'agent': ordinary card_action.
  ctx.ledger.create(c, executor === 'bridge' ? 'bridge' : 'agent')
  try {
    await ctx.transport.sendDurable(frame)
  } catch (e) {
    ctx.ledger.expire(c.id)
    ctx.expiry?.cancel(c.id)
    throw e
  }
  ctx.expiry?.sync()
  return c
}

export function cardPayloadOf(binding: { payload?: unknown }): AppCardPayloadT | undefined {
  const r = AppCardPayload.safeParse(binding.payload)
  return r.success ? r.data : undefined
}

export const prettyArgs = (a: Record<string, unknown>): string => JSON.stringify(a, null, 2)
