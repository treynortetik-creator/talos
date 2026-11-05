import { z } from 'zod'
import { APP_TOOL_INPUT_MAX, APP_TOOL_RESULT_MAX, AppCsp, jcsAtMost, McpCallToolResult } from './apps.ts'
import {
  CardId,
  ConnId,
  DeviceId,
  EventId,
  HttpsUrl,
  IntegrationId,
  IsoTs,
  MediaId,
  MsgId,
  ThreadId,
  ViewId,
  VoiceId,
} from './ids.ts'
import { MessageRef } from './memory.ts'
import { ShareContent } from './share.ts'
import { ThreadSessionMode, ThreadSessionOpts } from './thread-sessions.ts'

/** Thread colour palette keys the app ships (docs/THREADS.md). The schema accepts any short key; see `Thread.color`. */
export const THREAD_COLORS = [
  'red',
  'orange',
  'yellow',
  'lime',
  'mint',
  'cyan',
  'blue',
  'violet',
  'magenta',
  'pink',
] as const
export type ThreadColorKey = (typeof THREAD_COLORS)[number]
export const ThreadColor = z.string().regex(/^[a-z]{1,16}$/)
export const THREAD_TOPIC_MAX = 200
/** Bridge feature: it keeps `Thread.color` and `Thread.topic` and tells the agent about thread edits (docs/THREADS.md). */
export const THREADS_FEATURE = 'threads/2'

export const Thread = z.object({
  id: ThreadId,
  name: z.string().min(1).max(40),
  icon: z.string().max(16).optional(), // an icon key (THREAD_ICON_KEYS in the web app) or, in older configs, an emoji
  /** A palette key (`orange`, `pink`, ...). Free-form on the wire so a newer app can add colours; unknown keys render default. */
  color: ThreadColor.optional(),
  /** "What goes here": one line the agent reads (`list_threads`) to decide what to post in this thread. */
  topic: z.string().max(THREAD_TOPIC_MAX).optional(),
  kind: z.enum(['fixed', 'agent', 'system']), // fixed = owner config; agent = created by the agent; system = inbox
  order: z.number().int().default(0), // sidebar position; a hand-written config without it keeps file order
  notify: z.enum(['all', 'needs_you', 'off']).default('all'),
  voice_context: z.enum(['none', 'recent']).default('recent'), // may live calls seed recent messages to the voice model (6.2)?
  archived: z.boolean().default(false),
  created_at: IsoTs,
  /** Option C (docs/OPTION-C.md): `dedicated` = this thread's own worker session. Absent = `shared`. */
  session: ThreadSessionMode.optional().catch(undefined),
  session_opts: ThreadSessionOpts.optional().catch(undefined),
})

export const AttachmentRef = z.object({
  media_id: MediaId,
  kind: z.enum(['image', 'audio', 'voice_note', 'video', 'file', 'html']),
  role: z.enum(['attachment', 'voice_reply']).default('attachment'),
  mime: z.string().max(100),
  name: z.string().max(200),
  size: z
    .number()
    .int()
    .max(50 * 1024 * 1024),
  sha256: z.string().regex(/^[0-9a-f]{64}$/), // bridge verifies downloaded bytes against this
  duration_ms: z.number().int().optional(),
  width: z.number().int().optional(),
  height: z.number().int().optional(),
  waveform: z.string().max(128).optional(), // base64 of 64 peak bytes (0-255)
})

/**
 * AttachmentRef as it appears inside a signed (owner) frame: same fields, `role` required, no defaults.
 * Owner-frame schemas must not rewrite the raw object (3.5 "raw JSON in, raw JSON out").
 */
export const OwnerAttachmentRef = AttachmentRef.extend({ role: z.enum(['attachment', 'voice_reply']) }).strict()

/**
 * One shown MCP app view (a `Message` of kind `app` carries it). Not strict: a newer bridge may add fields. The page
 * is the pinned HTML (`/media/:id/app`); the result is inline up to 128 KiB, else JSON media, never both.
 */
export const AppView = z
  .object({
    view_id: ViewId,
    thread_id: ThreadId,
    label: z.string().min(1).max(60), // the owner's label from the catalog
    server: z.string().min(1).max(120), // display-escaped
    tool: z.string().min(1).max(128),
    resource_uri: z.string().startsWith('ui://').max(2000),
    approval_key: z.string().regex(/^[0-9a-f]{64}$/),
    page: AttachmentRef, // kind 'html'
    csp: AppCsp,
    prefers_border: z.boolean().optional(),
    tool_input: z.record(z.string(), z.unknown()).refine(jcsAtMost(APP_TOOL_INPUT_MAX), 'tool_input too large'),
    tool_result: McpCallToolResult.refine(jcsAtMost(APP_TOOL_RESULT_MAX), 'tool_result too large').optional(),
    tool_result_media: AttachmentRef.optional(),
    calls_until: IsoTs, // shown_at + 24 h
    shown_at: IsoTs,
  })
  .refine((v) => (v.tool_result === undefined) !== (v.tool_result_media === undefined), {
    message: 'exactly one of tool_result and tool_result_media',
  })
  .refine((v) => v.page.kind === 'html', { message: 'page must be an html attachment' })
export type AppViewT = z.infer<typeof AppView>

export const Message = z.object({
  id: MsgId,
  thread_id: ThreadId,
  seq: z.number().int().optional(), // seq assigned by relay
  // 'hook' + kind 'event' = an integration event row (7.1). 'app' = an MCP app view or its echo row (bridge-minted only).
  author: z.enum(['owner', 'agent', 'system', 'hook', 'app']),
  kind: z.enum(['text', 'voice_note', 'file', 'event', 'card', 'call_record', 'voice_turn', 'app']),
  text: z.string().max(32_000).optional(),
  format: z.enum(['markdown', 'plain']).default('plain'),
  reply_to: MsgId.optional(),
  attachments: z.array(AttachmentRef).max(10).default([]),
  transcript: z
    .object({ text: z.string(), engine: z.string().max(40), status: z.enum(['pending', 'done', 'failed']) })
    .optional(),
  event_id: EventId.optional(),
  card_id: CardId.optional(),
  // 'share' = a row from share-to-Talos (docs/V2-FEATURES.md V4.3)
  via: z.enum(['app', 'voice', 'headless', 'hook', 'share']).default('app'),
  call: z.object({ voice_session_id: VoiceId, duration_s: z.number().int(), delegations: z.number().int() }).optional(),
  // 'not_delivered' (D38): the relay gave up on a message the Mac never took. An unknown value reads as no receipt.
  receipt: z.enum(['sent', 'delivered', 'seen', 'not_delivered']).optional().catch(undefined),
  created_at: IsoTs,
  edited_at: IsoTs.optional(),
  /** Notes the owner attached from the memory browser (docs/V2-FEATURES.md V5.3). */
  refs: z.array(MessageRef).max(5).optional(),
  /** Shared material (either share path). Always wrapped external by the bridge; never part of `text` (V4.7). */
  share_content: ShareContent.optional(),
  /** Which share link a token share arrived through ("iPhone"), for "Shared via {label}". Set by the relay only. */
  share_label: z.string().min(1).max(40).optional(),
  /**
   * MCP app view (kind `app`). A view that fails to parse reads as absent: the row degrades to "can't show this app",
   * it does not take the frame down. `appMessageProblem` is the mint-time check that the pair is consistent.
   */
  app: AppView.optional().catch(undefined),
  /** The view an echo row (author `app`, kind `text`) belongs to. */
  app_view_id: ViewId.optional(),
  /**
   * A hand-off between Talos sessions (system rows the live bridge writes). The label ("Talos → Trip lead: TASK") is data
   * here, not part of `text`, so the body cannot imitate it. An unreadable value reads as absent.
   */
  handoff: z
    .object({ label: z.string().min(1).max(160), type: z.enum(['TASK', 'RESULT', 'BLOCK']) })
    .optional()
    .catch(undefined),
})

/**
 * Every card kind, in wire order, with who may mint it: 'agent' kinds come from the agent's `card` tool (and headless
 * `POST /bridge/post`; an allowlist, so a new kind is refused until it is listed as 'agent'), 'bridge' kinds only from the
 * live bridge's own data (a scheduler record, a Claude Code permission request, a settings proposal). This is the one list:
 * the two arrays below, the `Card.kind` enum and the app's labels and icons all follow it.
 */
export const CARD_KIND_MINTER = {
  email: 'agent',
  message: 'agent',
  deploy: 'agent',
  publish: 'agent',
  purchase: 'agent',
  decision: 'agent',
  generic: 'agent',
  schedule: 'bridge',
  permission: 'bridge',
  app_action: 'bridge',
  config: 'bridge', // an agent-proposed settings change the bridge applies on approval (docs/SETTINGS O1); relay feature config-propose/1
} as const satisfies Record<string, 'agent' | 'bridge'>

export type CardKind = keyof typeof CARD_KIND_MINTER
export type AgentCardKind = { [K in CardKind]: (typeof CARD_KIND_MINTER)[K] extends 'agent' ? K : never }[CardKind]
export type BridgeOnlyCardKind = Exclude<CardKind, AgentCardKind>

/** Every card kind, in wire order. */
export const CARD_KINDS = Object.keys(CARD_KIND_MINTER) as [CardKind, ...CardKind[]]

/** Card kinds the agent's `card` tool (and headless `POST /bridge/post`) may mint. An allowlist: a new kind is refused. */
export const AGENT_CARD_KINDS = CARD_KINDS.filter((k) => CARD_KIND_MINTER[k] === 'agent') as readonly AgentCardKind[]
/** Card kinds only the live bridge mints, from its own data (a scheduler record, a Claude Code permission request). */
export const BRIDGE_ONLY_CARD_KINDS = CARD_KINDS.filter(
  (k) => CARD_KIND_MINTER[k] === 'bridge',
) as readonly BridgeOnlyCardKind[]
export function isAgentCardKind(kind: unknown): kind is AgentCardKind {
  return typeof kind === 'string' && (AGENT_CARD_KINDS as readonly string[]).includes(kind)
}

export const CardAction = z.enum(['primary', 'kill', 'revise', 'expired']) // 'expired' only ever set by bridge/relay

export const CardField = z.object({
  key: z.string().max(40),
  label: z.string().max(40),
  value: z.string().max(20_000),
  editable: z.boolean().default(false),
  multiline: z.boolean().default(false),
})

export const Card = z.object({
  id: CardId,
  thread_id: ThreadId,
  // The kinds are CARD_KIND_MINTER; the agent's `card` tool takes AGENT_CARD_KINDS only.
  kind: z.enum(CARD_KINDS),
  title: z.string().max(120),
  summary: z.string().max(280).optional(),
  destination: z.array(z.object({ label: z.string().max(20), value: z.string().max(500) })).max(6), // >=1 unless kind=decision|generic
  body: z.string().max(20_000).optional(),
  body_format: z.enum(['markdown', 'plain']).default('plain'),
  fields: z.array(CardField).max(12).default([]),
  attachments: z.array(AttachmentRef).max(10).default([]),
  warning: z.string().max(160).optional(), // e.g. "Goes outside this app. Can't be unsent."
  primary_label: z.string().max(32), // "Send", "Deploy to prod", "Pay $40", "Approve"
  kill_label: z.string().max(32), // must name the target: "Kill draft", "Kill deploy"
  allow_edit: z.boolean().default(true),
  allow_revise: z.boolean().default(true),
  risk: z.enum(['low', 'high']), // high = leaves the app / irreversible / spends / deletes -> step-up
  origin: z.enum(['chat', 'background']),
  payload: z.unknown().optional(), // agent's opaque data; <=64 KiB after JCS
  payload_hash: z.string().regex(/^sha256:[0-9a-f]{64}$/), // = payloadHash(CardBinding)
  state: z.enum(['pending', 'resolved', 'done', 'failed', 'expired', 'superseded']),
  resolution: z
    .object({
      action: CardAction,
      at: IsoTs,
      edited: z.boolean(),
      payload_hash: z.string(),
      note: z.string().max(2000).optional(),
      /**
       * When the Mac took the decision. `at` is the owner's signed tap, which a Mac asleep at the time sees hours later;
       * this is the Mac's own clock at that moment, so "how long has it been running" is measured from here. Absent from
       * an older Mac: readers fall back to `at`.
       */
      taken_at: IsoTs.optional().catch(undefined),
    })
    .optional(),
  /**
   * `ran: false` = the Mac knows nothing ran (the request was gone, Apps were off), so "ask the agent to retry" is wrong.
   * `ran: 'unknown'` = the Mac stopped while handing the decision to the agent and cannot say: check before asking again.
   * Anything else a reader does not know reads as unset.
   */
  result: z
    .object({
      ok: z.boolean(),
      text: z.string().max(500),
      at: IsoTs,
      ran: z
        .union([z.boolean(), z.literal('unknown')])
        .optional()
        .catch(undefined),
    })
    .optional(),
  related_event_id: z.string().optional(),
  supersedes: CardId.optional(),
  created_at: IsoTs,
  expires_at: IsoTs,
})

/** What the owner approves: everything the card renders, plus the opaque payload (shown under "Details"). */
export const CardBinding = Card.pick({
  id: true,
  thread_id: true,
  kind: true,
  title: true,
  summary: true,
  destination: true,
  body: true,
  body_format: true,
  warning: true,
  primary_label: true,
  kill_label: true,
  risk: true,
  origin: true,
  allow_edit: true,
  allow_revise: true,
  expires_at: true,
  payload: true,
}).extend({
  fields: z.array(CardField.pick({ key: true, label: true, value: true, editable: true, multiline: true })),
  attachments: z.array(AttachmentRef.pick({ media_id: true, kind: true, sha256: true, name: true, mime: true })),
})
export type CardBinding = z.infer<typeof CardBinding>
export type CardT = z.infer<typeof Card>

/**
 * Builds the binding from a card. Optional keys that are absent stay absent (JCS drops nothing, so `undefined` must
 * never be present: it would make the hash depend on how the card was constructed).
 */
export function bindingFrom(card: CardT): CardBinding {
  const b: Record<string, unknown> = {
    id: card.id,
    thread_id: card.thread_id,
    kind: card.kind,
    title: card.title,
    destination: card.destination,
    body_format: card.body_format,
    primary_label: card.primary_label,
    kill_label: card.kill_label,
    risk: card.risk,
    origin: card.origin,
    allow_edit: card.allow_edit,
    allow_revise: card.allow_revise,
    expires_at: card.expires_at,
    fields: card.fields.map((f) => ({
      key: f.key,
      label: f.label,
      value: f.value,
      editable: f.editable,
      multiline: f.multiline,
    })),
    attachments: card.attachments.map((a) => ({
      media_id: a.media_id,
      kind: a.kind,
      sha256: a.sha256,
      name: a.name,
      mime: a.mime,
    })),
  }
  if (card.summary !== undefined) b.summary = card.summary
  if (card.body !== undefined) b.body = card.body
  if (card.warning !== undefined) b.warning = card.warning
  if (card.payload !== undefined) b.payload = card.payload
  return b as CardBinding
}

/** The body is editable iff allow_edit && kind is email, message or publish. */
export function isBodyEditable(card: Pick<CardT, 'allow_edit' | 'kind'>): boolean {
  return card.allow_edit && (card.kind === 'email' || card.kind === 'message' || card.kind === 'publish')
}

export const NormalizedEvent = z.object({
  id: EventId,
  source: IntegrationId,
  connection: ConnId,
  kind: z.string().regex(/^[a-z_]+\.[a-z_]+$/), // 'slack.dm', 'github.review_requested', 'gmail.message', ...
  title: z.string().max(200),
  summary: z.string().max(280), // deterministic, no LLM
  url: HttpsUrl.optional(),
  actor: z.object({
    name: z.string().max(120).optional(),
    id: z.string().max(120).optional(),
    email: z.string().max(200).optional(),
  }),
  ts: IsoTs,
  thread: ThreadId,
  work: z.boolean(),
  priority: z.enum(['high', 'normal', 'low']),
  dedup_key: z.string().max(300),
  raw_ref: z.string().optional(), // raw payload stays on the relay (7 days); fetched via inbox_raw
})

export const InboxItem = NormalizedEvent.omit({ dedup_key: true, raw_ref: true }).extend({
  state: z.enum(['new', 'read', 'done', 'snoozed']),
  snooze_until: IsoTs.optional(),
  agent_summary: z.string().max(140).optional(), // set by the agent via inbox_triage
  card_id: CardId.optional(),
})

export const ThreadStatus = z.object({
  thread_id: ThreadId,
  state: z.enum(['idle', 'working', 'needs_you', 'on_call', 'queued']),
  label: z.string().max(80).optional(),
  since: IsoTs,
})

export const Presence = z.object({
  bridge_online: z.boolean(),
  last_seen: IsoTs.nullable(),
  queue_depth: z.number().int(),
  /** The connected bridge's `hello.client.features`, echoed by the relay (e.g. 'schedules/1'; docs/SCHEDULES.md S1.5). */
  features: z.array(z.string().max(40)).max(20).optional(),
  /**
   * When `features` was last heard from a live bridge. While the bridge is offline the relay keeps the LAST-KNOWN list,
   * so the app shows Search and Memory as "Needs your Mac" instead of hiding them (docs/V2-FEATURES.md V1).
   */
  features_at: IsoTs.optional(),
})

/** ECDSA P-256 public key as a JWK (device keys). */
export const JwkP256 = z.object({
  kty: z.literal('EC'),
  crv: z.literal('P-256'),
  x: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
  y: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
})

export const Device = z.object({
  id: DeviceId,
  name: z.string().min(1).max(80),
  pubkey_jwk: JwkP256,
  pinned: z.boolean(),
  revoked: z.boolean(),
  created_at: IsoTs,
  last_used_at: IsoTs.nullable(),
  /** True when another live device signs in with the same passkey, so revoking this device does not remove that passkey. Absent from older relays. */
  shared_passkey: z.boolean().optional(),
  /** When this device first proved its key at sign-in or enrollment; null until then. Absent from older relays. */
  login_proven_at: IsoTs.nullable().optional(),
})

export type ThreadT = z.infer<typeof Thread>
export type MessageT = z.infer<typeof Message>
export type AttachmentRefT = z.infer<typeof AttachmentRef>
export type NormalizedEventT = z.infer<typeof NormalizedEvent>
export type InboxItemT = z.infer<typeof InboxItem>
export type ThreadStatusT = z.infer<typeof ThreadStatus>
export type PresenceT = z.infer<typeof Presence>
export type DeviceT = z.infer<typeof Device>
export type JwkP256T = z.infer<typeof JwkP256>
export type CardActionT = z.infer<typeof CardAction>

/** True for any row that only the live bridge may mint: an app view, or an echo row of one. */
export function isAppMessage(m: Pick<MessageT, 'author' | 'kind'> & { app_view_id?: unknown; app?: unknown }): boolean {
  return m.author === 'app' || m.kind === 'app' || m.app_view_id !== undefined || m.app !== undefined
}

/**
 * Mint-time consistency of an app row (the schema alone cannot say: a bad `app` reads as absent so one broken view does
 * not drop a frame). A view row is kind `app`, author `app`, with `app`. An echo row is kind `text`, author `app`, with
 * `app_view_id` and no `app`. Anything else that touches app fields is a problem. Returns the first problem, or
 * `undefined` for a row that is not an app row or is a valid one.
 */
export function appMessageProblem(m: MessageT): string | undefined {
  if (!isAppMessage(m)) return undefined
  if (m.author !== 'app') return "app rows must have author 'app'"
  if (m.kind === 'app') {
    if (m.app === undefined) return "kind 'app' needs a valid app view"
    if (m.app_view_id !== undefined) return "kind 'app' takes app, not app_view_id"
    if (m.app.thread_id !== m.thread_id) return 'app view belongs to another thread'
    return undefined
  }
  if (m.kind === 'text') {
    if (m.app_view_id === undefined) return 'an app echo row needs app_view_id'
    if (m.app !== undefined) return 'an app echo row carries no app view'
    return undefined
  }
  return "app rows are kind 'app' or 'text'"
}
