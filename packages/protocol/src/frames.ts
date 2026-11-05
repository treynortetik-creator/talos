import { z } from 'zod'
import { AppErrorCode } from './app-host.ts'
import { APP_MESSAGE_TEXT_MAX, APP_TOOL_INPUT_MAX, APP_TOOL_RESULT_MAX, jcsAtMost, McpCallToolResult } from './apps.ts'
import { AgentConfig } from './config.ts'
import { ErrorCode, MAX_FRAME_BYTES, MAX_FRAME_BYTES_UNAUTH } from './errors.ts'
import { MAX_QUERY_CHARS, MAX_QUERY_TERMS } from './fts-query.ts'
import { HealthBeat } from './health.ts'
import {
  AppRequestId,
  CardId,
  DeviceId,
  IntegrationId,
  IsoTs,
  MediaId,
  MemoryPath,
  MemoryRootId,
  MsgId,
  PageCursor,
  Sha256Ref,
  ShareTokenId,
  ThreadId,
  Ulid,
  ViewId,
  VoiceId,
} from './ids.ts'
import { MemoryEntry, MemoryHit, MemoryLink, MemoryRootInfo, MemoryTreePath, MessageRef } from './memory.ts'
import {
  AttachmentRef,
  Card,
  InboxItem,
  JwkP256,
  Message,
  NormalizedEvent,
  OwnerAttachmentRef,
  Presence,
  Thread,
  ThreadStatus,
} from './models.ts'
import { Problem } from './problems.ts'
import { NativeActWire } from './push-rich.ts'
import { RunBlockRef } from './run.ts'
import {
  RunId,
  SCHEDULE_CONTROL_NEEDS_ID,
  ScheduleChange,
  ScheduleControlAction,
  ScheduleDetail,
  ScheduleId,
  ScheduleReport,
  SchedulerHealth,
  ScheduleStatusAlert,
  ScheduleStatusChange,
} from './schedules.ts'
import { SearchFilters, SearchHit, SearchIndexState, SearchSort } from './search.ts'
import {
  CommandName,
  MAX_CONTROL_ARGS,
  SessionControlAction,
  SessionInventory,
  SessionListItem,
  SessionState,
  SpawnKind,
} from './session.ts'
import { CappedAgentsSnapshot } from './session-agents.ts'
import { PHONE_PATCH_ENTRIES, SESSION_STEPUP_TOP_FIELDS } from './settings-table.ts'
import { ShareContent } from './share.ts'
import { StepupAssertion } from './stepup.ts'
import { ThreadSessionStateItem, WorkersStatus } from './thread-sessions.ts'

// ---- envelope -------------------------------------------------------------------------------------------------

/** Added by the relay on the way through (sequence number and receive time). Never covered by a signature. */
export const RelayMeta = z.object({ seq: z.number().int(), received_at: IsoTs })

const envelope = {
  v: z.literal(1),
  id: Ulid,
  ts: IsoTs,
  relay: RelayMeta.optional(),
}

/** 86 base64url chars = 64 raw IEEE P1363 bytes. DER signatures are longer and rejected. */
export const Osig = z.string().regex(/^[A-Za-z0-9_-]{86}$/)

function frame<T extends string, S extends z.ZodRawShape>(type: T, shape: S) {
  return z.object({ ...envelope, type: z.literal(type), ...shape })
}

/** Owner (signed) frames: strict, and no `.default()` anywhere inside (3.5 raw-JSON rule). */
function ownerFrame<T extends string, S extends z.ZodRawShape>(type: T, shape: S) {
  return z.strictObject({ ...envelope, type: z.literal(type), ...shape, device_id: DeviceId, osig: Osig })
}

// Sha256Ref lives in ids.ts (exported; SCHEDULES S2.1) so schedules.ts can use it without an import cycle.

// ---- connection ------------------------------------------------------------------------------------------------

export const ChallengeFrame = frame('challenge', {
  nonce: z.string().regex(/^[A-Za-z0-9_-]{43}$/), // 32 bytes base64url
  server_time: z.number().int(),
  relay_host: z.string().min(1).max(255),
  protocol: z.literal(1),
})

export const HelloBridgeFrame = frame('hello', {
  role: z.literal('bridge'),
  key_id: z.string().regex(/^[0-9a-f]{16}$/),
  sig: z.string().regex(/^[A-Za-z0-9_-]{86}$/), // Ed25519, 64 bytes
  client: z.object({
    name: z.string().max(60),
    version: z.string().max(40),
    /** Optional capabilities, e.g. 'schedules/1' (docs/SCHEDULES.md S1.5). The relay echoes them in `presence`. */
    features: z.array(z.string().max(40)).max(20).optional(),
  }),
  agent_config_rev: z.number().int().nonnegative(),
})

export const HelloAppFrame = frame('hello', {
  role: z.literal('app'),
  device_id: DeviceId,
  last_seq: z.number().int().nonnegative(), // 0 = fresh
  visible: z.boolean(),
  client: z.object({ version: z.string().max(40), standalone: z.boolean(), platform: z.string().max(40) }),
})

/**
 * An array where one item this build cannot read is dropped and the rest survive. A new card or message kind must never
 * be the reason a whole `ready` or history page is lost (an older app meets the next kind exactly like this).
 */
function tolerantArray<T extends z.ZodType>(item: T) {
  return z.array(z.unknown()).transform((xs) =>
    xs.flatMap((x) => {
      const r = item.safeParse(x)
      return r.success ? [r.data as z.output<T>] : []
    }),
  )
}

export const ReadyFrame = frame('ready', {
  session_id: z.string().min(1).max(64),
  policy: z.object({ max_frame_bytes: z.number().int(), ping_ms: z.number().int() }),
  server_seq: z.number().int().nonnegative(),
  presence: Presence,
  // app only
  agent_config: AgentConfig.optional(),
  threads: z.array(Thread).optional(),
  open_cards: tolerantArray(Card).optional(),
  unread: z.record(ThreadId, z.number().int().nonnegative()).optional(),
  /**
   * Per thread, the relay's read mark (`thread.read` up_to_seq). Unread counts only some events (a silent reply is stored
   * and shown but never counted), so "the first unread message" is the first counting row above this seq, never a count
   * taken from the end. A relay from before this field omits it; the app then falls back to the count.
   */
  read_upto: z.record(z.string().max(80), z.number().int().nonnegative()).optional().catch(undefined),
  /**
   * Messages the relay dropped at the end of its buffer window without the Mac ever taking them (receipt `not_delivered`),
   * newest first, for 7 days after. A device that was away when the live receipt went out learns here.
   */
  not_delivered: z.array(MsgId).max(200).optional().catch(undefined),
  statuses: z.array(ThreadStatus).optional(),
  /** What the RELAY supports (e.g. 'schedules/1'). The bridge mints no schedule card until this lists it (S1.5). */
  features: z.array(z.string().max(40)).max(20).optional(),
  // app only, docs/CLAUDE-CODE.md C2.5: the last session.state / session.inventory / session.list the relay saw
  session_state: SessionState.optional(),
  session_inventory: SessionInventory.optional(),
  session_list: z.array(SessionListItem).max(200).optional(),
  // app only, docs/OPTION-C.md 9: the last workers.status the relay saw
  workers_status: WorkersStatus.optional().catch(undefined), // never the reason a whole `ready` is dropped
  /** app only, docs/OPTION-C.md 9.3: each thread session's last session.state (main's stays in session_state). */
  thread_session_states: z.array(ThreadSessionStateItem).max(40).optional().catch(undefined),
  /** docs/SUBAGENTS.md: the last session.agents snapshot, kept in relay memory only. */
  session_agents: CappedAgentsSnapshot.optional(),
})

export const PingFrame = frame('ping', { nonce: z.string().max(64) })
export const PongFrame = frame('pong', { nonce: z.string().max(64) })

/**
 * Two-stage acknowledgement (bridge hop, relay->bridge frames that become channel notifications):
 *   stage 'delivered' (default, also when `stage` is absent): the receiver has the frame and stored it durably.
 *   stage 'consumed': the bridge pushed it into the Claude session as a channel notification (or rejected it, after
 *   sending `error`).
 * The relay keeps a bridge-bound consumable frame in its replay buffer until it is `consumed`, and on every bridge hello
 * re-sends all unconsumed ones in `relay.seq` order. The bridge dedupes on `id` when it notifies.
 */
export const AckStage = z.enum(['delivered', 'consumed'])
export const AckFrame = frame('ack', { ref: Ulid, seq: z.number().int().optional(), stage: AckStage.optional() })

/**
 * bridge -> relay, optional hint: "re-send these unconsumed frame ids". The relay re-sends the ones it still holds (in
 * `relay.seq` order, original bytes) and ignores unknown ids. Not required for correctness: the relay already re-sends
 * everything unconsumed on hello.
 */
export const ReplayRequestFrame = frame('replay.request', { ids: z.array(Ulid).min(1).max(200) })

export const ErrorFrame = frame('error', {
  ref: Ulid.optional(),
  code: ErrorCode,
  message: z.string().max(500), // safe, no secrets
  /** Per-field errors so a form can show each under its field (docs/SCHEDULES.md S2.2). */
  fields: z
    .array(z.strictObject({ path: z.string().max(80), message: z.string().max(200) }))
    .max(20)
    .optional(),
})

// ---- messaging --------------------------------------------------------------------------------------------------

export const MessageFrame = ownerFrame('message', {
  thread_id: ThreadId,
  client_msg_id: MsgId,
  text: z.string().max(32_000),
  reply_to: MsgId.optional(),
  attachments: z.array(OwnerAttachmentRef).max(10),
  /** `run` is the owner's tap on a Run button (see `run.ts`); only a Mac that lists `run/1` accepts it. */
  intent: z.enum(['what_did_i_miss', 'run']).optional(),
  /** The block a Run is for (`run.ts`); the Mac refuses a Run without it. */
  run_block: RunBlockRef.optional(),
  /** When the words were first written, on a frame signed again because it waited too long (`original-ts/1`). */
  original_ts: IsoTs.optional(),
  /** Memory notes for [Ask {agent}] (docs/V2-FEATURES.md V5.3); only when the bridge advertises `memory/1`. */
  refs: z.array(MessageRef).max(5).optional(),
  /** The shared material from the signed `/share` page (V4.3). `text` is then the typed note ONLY. */
  share_content: ShareContent.optional(),
})

export const VoiceNoteFrame = ownerFrame('voice_note', {
  thread_id: ThreadId,
  client_msg_id: MsgId,
  attachment: OwnerAttachmentRef,
  /** As on `message`. */
  original_ts: IsoTs.optional(),
})

export const MessageStoredFrame = frame('message.stored', { client_msg_id: MsgId, message: Message })

export const TranscriptFrame = frame('transcript', {
  message_id: MsgId,
  text: z.string(),
  engine: z.string().max(40),
  status: z.enum(['pending', 'done', 'failed']),
})

export const ReplyFrame = frame('reply', {
  message: Message,
  speak: z.string().max(600).optional(),
  voice_delegation_id: z.string().optional(),
  silent: z.boolean().optional(),
})

/**
 * `not_delivered` (D38): the relay dropped the message at the end of its buffer window and the Mac never took it. It is
 * relay-sent only; the bridge reports `delivered` and `seen`.
 */
export const ReceiptFrame = frame('receipt', {
  message_id: MsgId,
  state: z.enum(['delivered', 'seen', 'not_delivered']),
})

/** `ThreadStatus` fields sit directly on the frame. */
export const StatusFrame = frame('status', ThreadStatus.shape)
/** `Presence` fields sit directly on the frame. */
export const PresenceFrame = frame('presence', Presence.shape)

// ---- cards ------------------------------------------------------------------------------------------------------

export const CardCreateFrame = frame('card.create', { card: Card })

export const CardResolveFrame = ownerFrame('card.resolve', {
  card_id: CardId,
  action: z.enum(['primary', 'kill', 'revise']),
  payload_hash: Sha256Ref, // recomputed by the app from what it rendered (8.4)
  edited: z
    .strictObject({
      fields: z.array(z.strictObject({ key: z.string().max(40), value: z.string().max(20_000) })),
      body: z.string().max(20_000).optional(),
    })
    .optional(),
  edited_hash: Sha256Ref.optional(),
  note: z.string().max(2000).optional(), // revise text
  stepup_token: z.string().max(200).optional(), // relay-checked, stripped before forwarding, not signed
  /** Raw WebAuthn assertion, verified by the BRIDGE (docs/CLAUDE-CODE.md C3.6). Signed; the relay never strips it. */
  stepup: StepupAssertion.optional(),
})

export const CardUpdateFrame = frame('card.update', {
  card_id: CardId,
  state: Card.shape.state,
  resolution: Card.shape.resolution,
  result: Card.shape.result,
  reason: z.string().max(80).optional(), // expired, mac_offline_too_long, hash_mismatch, ...
})

// ---- hooks and inbox --------------------------------------------------------------------------------------------

export const HookEventFrame = frame('hook.event', {
  event: NormalizedEvent,
  delivery: z.enum(['live', 'backlog']),
})

export const HookDigestFrame = frame('hook.digest', {
  window: z.object({ start: IsoTs, end: IsoTs }),
  threads: z.array(z.object({ thread_id: ThreadId, counts: z.partialRecord(IntegrationId, z.number().int()) })),
  events: z.array(NormalizedEvent).max(200),
})

export const InboxItemFrame = frame('inbox.item', { item: InboxItem })

export const InboxUpdateFrame = frame('inbox.update', {
  event_id: z.string(),
  state: InboxItem.shape.state.optional(),
  snooze_until: IsoTs.optional(),
  priority: z.enum(['high', 'normal', 'low']).optional(),
  agent_summary: z.string().max(140).optional(),
  card_id: CardId.optional(),
})

// ---- threads and config -----------------------------------------------------------------------------------------

export const ThreadUpsertFrame = frame('thread.upsert', { thread: Thread })
export const ThreadArchiveFrame = frame('thread.archive', { thread_id: ThreadId })
export const ThreadReadFrame = frame('thread.read', { thread_id: ThreadId, up_to_seq: z.number().int() })
/**
 * Mark unread (D36). The app sends only `thread_id`; the relay lowers its read mark (it never lowered before: `thread.read`
 * is a max) and answers EVERY device, the sender included, with the same frame carrying the truth. `up_to_seq` is the new
 * read mark (absent when the thread has no counting row left in the buffer: the relay then keeps a manual flag), `count`
 * is the unread count the relay now holds for the thread.
 */
export const ThreadUnreadFrame = frame('thread.unread', {
  thread_id: ThreadId,
  up_to_seq: z.number().int().nonnegative().optional().catch(undefined),
  count: z.number().int().nonnegative().optional().catch(undefined),
})

export const ConfigSyncFrame = frame('config.sync', {
  config: AgentConfig,
  rev: z.number().int().nonnegative(),
  /** The `config.patch` id this sync applies, so the app that sent it knows the Mac saved it (docs/THREADS.md). */
  applied: z.string().min(1).max(64).optional(),
})

export const ConfigPatchFrame = ownerFrame('config.patch', {
  base_rev: z.number().int().nonnegative(),
  patch: z.record(z.string(), z.unknown()), // RFC 7386 JSON merge patch
  stepup_token: z.string().max(200).optional(),
})

/**
 * Fields the bridge accepts in a `config.patch` (3.4 allowlist). Anything else -> `config_field_forbidden`. Read from the
 * settings table (`settings-table.ts`), where each setting says whether the phone may change it.
 */
export const CONFIG_PATCH_ALLOWLIST: readonly string[] = PHONE_PATCH_ENTRIES

/** Top-level config fields whose change needs step-up `config:session` (they decide who can approve tool calls). */
export const CONFIG_SESSION_STEPUP_FIELDS: readonly string[] = SESSION_STEPUP_TOP_FIELDS

// ---- catch-up and history ---------------------------------------------------------------------------------------

export const CatchupBatchFrame = frame('catchup.batch', {
  from_seq: z.number().int(),
  to_seq: z.number().int(),
  frames: z.array(z.looseObject({ type: z.string() })).max(200), // stored frames, each parsed by the app with parseFrame
  more: z.boolean(),
})
export const CatchupResetFrame = frame('catchup.reset', { min_seq: z.number().int() })
export const CatchupRequestFrame = frame('catchup.request', { since_seq: z.number().int().nonnegative() })
export const CatchupSummaryFrame = frame('catchup.summary', {
  since_seq: z.number().int(),
  threads: z.array(
    z.object({ thread_id: ThreadId, unread: z.number().int(), last_ts: IsoTs.nullable(), needs_you: z.boolean() }),
  ),
  open_cards: z.number().int(),
  overnight: z.object({ counts: z.record(z.string(), z.number().int()) }).optional(),
})

export const HistoryRequestFrame = frame('history.request', {
  request_id: z.string().min(1).max(64),
  thread_id: ThreadId,
  before_seq: z.number().int().optional(),
  before_ts: IsoTs.optional(),
  // The search context view (docs/V2-FEATURES.md V3.2): at most one of these; the bridge pages on `ord`. Any of them
  // sends the request to the Mac (an `around_id` inside the relay's buffer may be served from it while the Mac is off).
  before_id: MsgId.optional(),
  after_id: MsgId.optional(),
  around_id: MsgId.optional(),
  limit: z.number().int().min(1).max(100),
  // Signed reads: the Mac serves a page only for a request the pinned owner device signed (docs/PROTOCOL.md "Signed
  // history reads"). Optional on the wire so an old app's unsigned request still parses and is answered with an
  // "update the app" error rather than dropped; the signature is checked on the RAW JSON like every owner frame.
  device_id: DeviceId.optional(),
  osig: Osig.optional(),
}).superRefine((f, ctx) => {
  const n = [f.before_id, f.after_id, f.around_id].filter((x) => x !== undefined).length
  if (n > 1)
    ctx.addIssue({ code: 'custom', path: ['around_id'], message: 'at most one of before_id, after_id, around_id' })
})
/** What the Mac answers (`error{code:'sig_invalid'}`) to an unsigned `history.request`, so an old app can say why. */
export const HISTORY_UPDATE_APP_MESSAGE = 'Update the Talos app to page through history.'
/** history.request keys that only the Mac can answer (the relay forwards them). */
export const HISTORY_ID_KEYS = ['before_id', 'after_id', 'around_id'] as const
export const HistoryPageFrame = frame('history.page', {
  request_id: z.string().min(1).max(64),
  thread_id: ThreadId,
  messages: tolerantArray(Message),
  has_more: z.boolean(),
  unavailable: z.literal('mac_offline').optional(),
  /** Context view paging (V3.2): newer messages remain after this page. */
  has_newer: z.boolean().optional(),
  /** The `around_id` echoed. */
  anchor_id: MsgId.optional(),
})

/**
 * Asks the Mac to re-upload a file older than the relay's buffer. A signed read like `history.request`: the Mac
 * re-uploads only for a request a pinned owner device signed (docs/PROTOCOL.md "Signed history reads"). `device_id` and
 * `osig` are optional on the wire so an old app's unsigned frame still parses and is refused with an "update the app"
 * error rather than dropped; the signature is checked on the RAW JSON.
 */
export const MediaFetchFrame = frame('media.fetch', {
  media_id: MediaId,
  device_id: DeviceId.optional(),
  osig: Osig.optional(),
})
/** What the Mac answers to an unsigned `media.fetch`, so an old app can say why. */
export const MEDIA_FETCH_UPDATE_APP_MESSAGE = 'Update the Talos app to load older files.'
export const MediaReadyFrame = frame('media.ready', { media_id: MediaId })
export const VisibilityFrame = frame('visibility', { state: z.enum(['visible', 'hidden']) })

// ---- voice ------------------------------------------------------------------------------------------------------

export const VoiceStateFrame = frame('voice.state', {
  voice_session_id: VoiceId,
  state: z.enum(['connecting', 'live', 'delegating', 'ended']),
  reason: z.string().max(200).optional(),
})

export const VoiceAskFrame = ownerFrame('voice.ask', {
  voice_session_id: VoiceId,
  delegation_id: z.string(),
  thread_id: ThreadId,
  question: z.string().max(4000),
  transcript_tail: z.array(z.strictObject({ who: z.enum(['owner', 'agent']), text: z.string() })).max(20),
})

export const VoiceProgressFrame = frame('voice.progress', {
  voice_delegation_id: z.string(),
  text: z.string().max(2000),
  say: z.boolean(),
})

export const VoiceEndedFrame = frame('voice.ended', {
  voice_session_id: VoiceId,
  thread_id: ThreadId,
  duration_s: z.number().int(),
  transcript: z.array(z.object({ who: z.enum(['owner', 'agent']), text: z.string(), at: IsoTs })),
})

// ---- devices ----------------------------------------------------------------------------------------------------

export const DeviceEnrolledFrame = frame('device.enrolled', {
  device: z.object({ id: DeviceId, name: z.string().max(80), pubkey_jwk: JwkP256 }),
  binding: z.string().min(1).max(200),
  code_id: z.string().min(1).max(64),
  credential_id: z.string().min(1).max(512),
  /** The passkey's COSE public key (base64url), covered by `binding` (docs/CLAUDE-CODE.md C3.6). */
  credential_public_key: z
    .string()
    .regex(/^[A-Za-z0-9_-]{16,2048}$/)
    .optional(),
})
export const DevicePinnedFrame = frame('device.pinned', {
  device_id: DeviceId,
  ok: z.boolean(),
  reason: z.enum(['declined', 'bad_binding', 'code_unknown', 'revoked']).optional(),
})
export const DeviceRevokedFrame = frame('device.revoked', { device_id: DeviceId })

// ---- schedules (docs/SCHEDULES.md S2.2) ------------------------------------------------------------------------
// None of these are durable or consumable: they need the Mac now, so the relay never stores or buffers them. With the
// Mac offline the relay answers error{ref, code:'mac_offline'} at once. Every signed one is answered by the bridge with
// ack{ref} (no seq) or error{ref, code, message, fields?}.

/**
 * `app_features`: what THIS app can read (`schedules/2`: several fire times, meta). The bridge sends a job that needs it only to
 * an app that said so; the relay's own feature list is for discovery, not for deciding what an app can parse. Absent = an app
 * from before it.
 */
export const AppReads = z.array(z.string().max(40)).max(10).optional()
export const SchedulesListFrame = ownerFrame('schedules.list', { request_id: Ulid, app_features: AppReads })
/** Routed only to the socket that asked (by request_id). */
// `snapshot` is checked here only for `protocol`; the app runs parseScheduleSnapshot() (protocol first, then the strict
// ScheduleSnapshot) so a newer bridge reads as "update the app", not as a bad frame (S1.5).
export const SchedulesSnapshotFrame = frame('schedules.snapshot', {
  request_id: Ulid,
  snapshot: z.looseObject({ protocol: z.number().int() }),
})
export const ScheduleGetFrame = ownerFrame('schedule.get', {
  request_id: Ulid,
  schedule_id: ScheduleId,
  report_run_id: RunId.nullable(),
  app_features: AppReads,
})
/** Not found is error{code:'schedule_not_found'}, never a detail. */
export const ScheduleDetailFrame = frame('schedule.detail', {
  request_id: Ulid,
  detail: ScheduleDetail,
  report: ScheduleReport.nullable(),
})
/** Writes nothing: the bridge validates and answers with a `card.create` (kind 'schedule'). */
export const SchedulePatchFrame = ownerFrame('schedule.patch', { change: ScheduleChange, thread_id: ThreadId })
export const ScheduleRunNowFrame = ownerFrame('schedule.run_now', {
  schedule_id: ScheduleId,
  again: z.boolean(),
  where: z.enum(['default', 'session']), // 'session' only for a non-restricted headless job (S5.3)
})
export const ScheduleControlFrame = ownerFrame('schedule.control', {
  action: ScheduleControlAction,
  schedule_id: ScheduleId.nullable(),
}).superRefine((f, ctx) => {
  const needs = (SCHEDULE_CONTROL_NEEDS_ID as readonly string[]).includes(f.action)
  if (needs && f.schedule_id === null)
    ctx.addIssue({ code: 'custom', path: ['schedule_id'], message: `${f.action} needs a schedule_id` })
  if (!needs && f.schedule_id !== null)
    ctx.addIssue({ code: 'custom', path: ['schedule_id'], message: `${f.action} takes schedule_id null` })
})
/** An invalidation signal, not data: ids and hashes only, never a name or prompt. Fanned out to every app socket. */
export const ScheduleStatusFrame = frame('schedule.status', {
  health: SchedulerHealth,
  changed: z.array(ScheduleStatusChange).max(200),
  removed: z.array(ScheduleId).max(200),
  alert: ScheduleStatusAlert.nullable(),
})

// ---- Heartbeat test run (docs/HEARTBEAT.md "In the app") ---------------------------------------------------------------
// Same rules as the schedule frames above: signed by the owner device, never stored or buffered by the relay, answered by a
// frame routed back to the asking socket, `mac_offline` at once with no Mac. The frame is read-tolerant on purpose: `config`
// is an open object and `window_h` any small whole number, because the relay is not the judge of either (the Mac is), and a
// closed list here would turn a newer app's frame away whole (the lesson of work.enabled). Gated by `HEARTBEAT_FEATURE`.
export const HeartbeatTestFrame = ownerFrame('heartbeat.test', {
  request_id: Ulid,
  config: z
    .record(z.string(), z.unknown())
    .refine((c) => new TextEncoder().encode(JSON.stringify(c)).length <= 8192, 'config is too big'),
  window_h: z.number().int().min(1).max(168),
  with_agent: z.boolean(),
})
/** `result` is read by the app with parseHeartbeatTestResult(); here it only has to be an object. Routed to the asking socket. */
export const HeartbeatTestResultFrame = frame('heartbeat.test_result', {
  request_id: Ulid,
  result: z.record(z.string(), z.unknown()),
})
/** The signed Heartbeat frame (app -> relay -> bridge). */
export const HEARTBEAT_OWNER_FRAME_TYPES = ['heartbeat.test'] as const
/** The answer (bridge -> relay -> app). */
export const HEARTBEAT_BRIDGE_FRAME_TYPES = ['heartbeat.test_result'] as const

/** The five signed schedule frames (app -> relay -> bridge). */
export const SCHEDULE_OWNER_FRAME_TYPES = [
  'schedules.list',
  'schedule.get',
  'schedule.patch',
  'schedule.run_now',
  'schedule.control',
] as const
/** The three bridge -> relay -> app schedule frames. */
export const SCHEDULE_BRIDGE_FRAME_TYPES = ['schedules.snapshot', 'schedule.detail', 'schedule.status'] as const

// ---- Claude Code session (docs/CLAUDE-CODE.md C2.5, C4.6) -------------------------------------------------------
// session.control and session.spawn are durable and consumable, with "consumed" meaning "the result was recorded" (in
// history.sqlite), not "pushed as a notification": a relay replay after a bridge restart then finds the id in the
// persisted seen-ids and re-sends the stored result instead of running twice (a history kept aside has no stored ids: the bridge then refuses a
// control signed before the reset, see history-recover.ts). They sit on their own lists
// (SESSION_CONSUMABLE_FRAME_TYPES, SESSION_DURABLE_FRAME_TYPES) until WP-C2/C3 implement that in the bridge and merge
// them into CONSUMABLE_FRAME_TYPES / DURABLE_FRAME_TYPES; until then the bridge and relay ignore them (fail closed).

export const SessionStateFrame = frame('session.state', { state: SessionState })
export const SessionInventoryFrame = frame('session.inventory', { inventory: SessionInventory })
export const SessionControlFrame = ownerFrame('session.control', {
  control_id: Ulid,
  thread_id: ThreadId,
  action: SessionControlAction, // `action:'model'` was dropped in rev 2: a model switch is command 'model'
  turn_id: z.string().min(1).max(64).optional(), // required for stop: the turn the phone showed
  command: CommandName.optional(), // builtin name, only with action 'command'
  source: z.literal('builtin').optional(), // required with action 'command': controls are keyed on (source, name)
  args: z.string().max(MAX_CONTROL_ARGS).optional(),
  stepup: StepupAssertion.optional(),
  agent_id: z.string().min(1).max(80).optional(), // required for agent_stop: the row the phone showed (SUBAGENTS.md)
}).superRefine((f, ctx) => {
  if ((f.action === 'agent_stop') !== (f.agent_id !== undefined))
    ctx.addIssue({ code: 'custom', path: ['agent_id'], message: 'agent_stop needs agent_id; other actions none' })
  if (f.action === 'agent_stop' && f.args !== undefined)
    ctx.addIssue({ code: 'custom', path: ['args'], message: 'agent_stop takes no args' })
  if (f.action === 'stop' && f.turn_id === undefined)
    ctx.addIssue({ code: 'custom', path: ['turn_id'], message: 'stop needs the turn_id the phone showed' })
  if (f.action !== 'stop' && f.turn_id !== undefined)
    ctx.addIssue({ code: 'custom', path: ['turn_id'], message: 'only stop takes turn_id' })
  if (f.action === 'command' && f.command === undefined)
    ctx.addIssue({ code: 'custom', path: ['command'], message: 'command needs a command' })
  if (f.action !== 'command' && f.command !== undefined)
    ctx.addIssue({ code: 'custom', path: ['command'], message: 'only command takes command' })
  if ((f.action === 'command') !== (f.source !== undefined))
    ctx.addIssue({ code: 'custom', path: ['source'], message: "command takes source 'builtin'; other actions none" })
})
export const SessionControlResultFrame = frame('session.control.result', {
  control_id: Ulid,
  ok: z.boolean(),
  code: ErrorCode.optional(),
  text: z.string().max(4000), // plain
  at: IsoTs,
})
/**
 * docs/SUBAGENTS.md: the session's subagents, teammates, shells and monitors. Not durable: the relay keeps the last one
 * in memory for `ready.session_agents` and never stores, pushes or logs it. Over AGENT_LIMITS.frameBytes is refused.
 */
export const SessionAgentsFrame = frame('session.agents', { agents: CappedAgentsSnapshot })
export const SessionListFrame = frame('session.list', { sessions: z.array(SessionListItem).max(200), at: IsoTs })
export const SessionSpawnFrame = ownerFrame('session.spawn', {
  spawn_id: Ulid,
  thread_id: ThreadId,
  kind: SpawnKind,
  prompt: z.string().min(1).max(4000),
})

// ---- Option C: per-thread sessions (docs/OPTION-C.md 9.1) ------------------------------------------------------------
// `thread.session.control` follows `session.control`: signed, durable until the bridge records its result, answered with
// `session.control.result` under the same `control_id`. The relay only passes it through. `workers.status` follows
// `session.state`: not durable, the relay keeps the last one for `ready`.

export const ThreadSessionAction = z.enum(['park', 'resume', 'restart', 'fresh'])
export type ThreadSessionActionT = z.infer<typeof ThreadSessionAction>
export const ThreadSessionControlFrame = ownerFrame('thread.session.control', {
  control_id: Ulid,
  thread_id: ThreadId,
  action: ThreadSessionAction,
})
export const WorkersStatusFrame = frame('workers.status', { status: WorkersStatus })
export const THREAD_SESSION_OWNER_FRAME_TYPES = ['thread.session.control'] as const
export const THREAD_SESSION_BRIDGE_FRAME_TYPES = ['workers.status'] as const

// ---- Phone recovery -----------------------------------------------------------------------------------------------
// `agent.recover` is the owner's "restart the agent" from the phone. It follows
// `thread.session.control`: signed, durable until the bridge records its result, answered with `agent.recover.result`
// under the same `control_id`. No agent is involved: the bridge hands the request to the Mac app through a file.
// Putting back the last good setup is not a phone action: the Mac cannot tell a restore the phone asked for from one the
// agent asked for, so it is done at the Mac (menu and Terminal). An older app may still send `restore_last_good`. The
// frame's `action` therefore parses as any short string, so an old or unknown value reaches the relay and bridge, which
// refuse it in words (RECOVER_NEEDS_MAC_TEXT) instead of dropping the frame. `stepup_token` is still accepted from an
// old app and is stripped and ignored.

export const AgentRecoverAction = z.enum(['restart'])
export type AgentRecoverActionT = z.infer<typeof AgentRecoverAction>
export const RECOVER_NEEDS_MAC_TEXT =
  'This needs the Mac now. To put back the last good setup, use the Talos menu on your Mac: Restore last good setup.'
/** The bridge only knows the request file was written; the Mac app may still refuse it and sends no answer back. */
export const RECOVER_SENT_TEXT =
  'Sent to your Mac, where the Talos app decides. It skips the restart if you stopped the agent there, or did a phone restart in the last 2 minutes. Nothing happens if the app is not running.'
export const AgentRecoverFrame = ownerFrame('agent.recover', {
  control_id: Ulid,
  action: z.string().min(1).max(40), // 'restart'; anything else is refused by the receiver
  stepup_token: z.string().max(200).optional(), // old apps only: ignored and stripped, not signed
})
export const AgentRecoverResultFrame = frame('agent.recover.result', {
  control_id: Ulid,
  ok: z.boolean(),
  code: ErrorCode.optional(),
  text: z.string().max(4000), // plain
  at: IsoTs,
})
export const AGENT_RECOVER_OWNER_FRAME_TYPES = ['agent.recover'] as const
export const AGENT_RECOVER_BRIDGE_FRAME_TYPES = ['agent.recover.result'] as const
/** The file the bridge writes under $TALOS_APP_HOME for the Mac app (agent-request.json). */
export const AgentRequestFile = z.strictObject({
  v: z.literal(1),
  control_id: Ulid,
  action: AgentRecoverAction,
  ts: z.number().int().nonnegative(), // unix ms
})

/** The two signed session frames (app -> relay -> bridge). */
export const SESSION_OWNER_FRAME_TYPES = ['session.control', 'session.spawn'] as const
/** The bridge -> relay -> app session frames. The relay keeps the last state, inventory, list and agents for `ready`. */
export const SESSION_BRIDGE_FRAME_TYPES = [
  'session.state',
  'session.inventory',
  'session.control.result',
  'session.list',
  'session.agents',
] as const
export const SESSION_CONSUMABLE_FRAME_TYPES = ['session.control', 'session.spawn'] as const
export const SESSION_DURABLE_FRAME_TYPES = ['session.control', 'session.control.result', 'session.spawn'] as const

// ---- v2 features (docs/V2-FEATURES.md V1.3) -------------------------------------------------------------------------
// Search and memory frames follow the Schedules rules (SCHEDULES S2.2): not durable, not consumable, never stored by
// the relay, routed by request_id to the asking socket only (core/ephemeral.ts, 30 s), `mac_offline` at once with the Mac
// offline. Reads are signed: it costs nothing and stops a relay from reading files through the bridge.

/** 1-200 characters, at most 12 whitespace-separated terms. */
const SearchQ = z
  .string()
  .min(1)
  .max(MAX_QUERY_CHARS)
  .refine((q) => q.trim().split(/\s+/).filter(Boolean).length <= MAX_QUERY_TERMS, {
    message: `at most ${MAX_QUERY_TERMS} terms`,
  })

/** bridge -> relay, every 60 s and on any change; the relay keeps the last one. No content (V2.2). */
export const HealthBeatFrame = frame('health.beat', { beat: HealthBeat })

export const SearchQueryFrame = ownerFrame('search.query', {
  request_id: Ulid,
  q: SearchQ,
  filters: SearchFilters,
  sort: SearchSort,
  cursor: PageCursor.nullable(),
  limit: z.number().int().min(1).max(50),
})
/** Fit by encoded bytes like `history.page`. */
export const SearchResultsFrame = frame('search.results', {
  request_id: Ulid,
  hits: z.array(SearchHit).max(50),
  next_cursor: PageCursor.nullable(),
  total_estimate: z.number().int().min(0).max(1000),
  took_ms: z.number().int().min(0),
  index: SearchIndexState,
})

export const MemoryTreeFrame = ownerFrame('memory.tree', {
  request_id: Ulid,
  root_id: MemoryRootId.nullable(), // null = list the roots
  path: MemoryTreePath, // '' = top
  cursor: PageCursor.nullable(),
})
/** Entries: dirs first, then by name; added until the frame would pass MAX_FRAME_BYTES - 2 KiB, then `next_cursor`. */
export const MemoryListingFrame = frame('memory.listing', {
  request_id: Ulid,
  roots: z.array(MemoryRootInfo).max(20).optional(),
  root_id: MemoryRootId.optional(),
  path: MemoryTreePath.optional(),
  entries: z.array(MemoryEntry).max(20_000),
  next_cursor: PageCursor.nullable(),
})
export const MemoryReadFrame = ownerFrame('memory.read', {
  request_id: Ulid,
  root_id: MemoryRootId,
  path: MemoryPath,
  offset: z.number().int().min(0), // UTF-8 byte offset, 0 = start
})
/** Byte-fit; `text` cut on a UTF-8 code-point boundary; `links` on the first chunk only (<= 128 KiB, dropped first). */
export const MemoryFileFrame = frame('memory.file', {
  request_id: Ulid,
  root_id: MemoryRootId,
  path: MemoryPath,
  mime: z.string().max(100),
  text: z.string(),
  offset: z.number().int().min(0),
  next_offset: z.number().int().min(0).nullable(), // null = end
  size: z.number().int().min(0),
  mtime: IsoTs,
  sha256: z.string().regex(/^[0-9a-f]{64}$/), // the whole file
  links: z.array(MemoryLink).max(5000).optional(),
})
export const MemorySearchFrame = ownerFrame('memory.search', {
  request_id: Ulid,
  q: SearchQ,
  root_ids: z.array(MemoryRootId).max(20), // [] = all
  cursor: PageCursor.nullable(),
  limit: z.number().int().min(1).max(50),
})
/**
 * The play button on an agent message. Names the message, never carries text: the Mac reads its own stored copy. `fresh` is
 * true on the first ask of a tap (it forgets a remembered failure, so Retry really retries) and false on the follow-up asks
 * while the audio is being made. Answered by `speak.result` under the same `request_id`.
 */
export const SpeakRequestFrame = ownerFrame('speak.request', {
  request_id: Ulid,
  message_id: MsgId,
  thread_id: ThreadId,
  fresh: z.boolean(),
})
/**
 * `state` is 'ready' (`media` is the audio), 'working' (ask again) or 'failed' (`reason`, `message`). The state and reason
 * are open strings on purpose: a newer Mac's new value must degrade one button, not drop the frame. `chars` is how many
 * characters were read, `total_chars` how many the message had; `truncated` says the cap cut it. `wait_s` is how long the
 * Mac may take before it gives up (so the app's own clock outlasts it).
 */
export const SpeakResultFrame = frame('speak.result', {
  request_id: Ulid,
  state: z.string().min(1).max(20),
  media: AttachmentRef.optional(),
  reason: z.string().min(1).max(40).optional(),
  message: z.string().max(300).optional(),
  chars: z.number().int().min(0).optional(),
  total_chars: z.number().int().min(0).optional(),
  truncated: z.boolean().optional(),
  wait_s: z.number().int().min(0).max(3600).optional(),
})

export const MemoryResultsFrame = frame('memory.results', {
  request_id: Ulid,
  hits: z.array(MemoryHit).max(50),
  next_cursor: PageCursor.nullable(),
  index: SearchIndexState,
})

/**
 * relay -> bridge, durable and CONSUMABLE: a share from a Shortcut token (V4.3). The relay built `message` (author
 * owner, via share, thread inbox, `text` = the note or empty, `share_content`, attachments) and already stored it; the
 * bridge writes it to history.sqlite, files it, and notifies it as `trust=external`.
 */
export const ShareItemFrame = frame('share.item', {
  share_id: Ulid,
  token_id: ShareTokenId,
  token_label: z.string().min(1).max(40),
  message: Message,
})

/**
 * relay -> bridge, durable and CONSUMABLE: a problem report (docs/ERRORS.md). The relay checked the session, the size
 * and the rate; the Mac scrubs it again, files it and answers `consumed` only after the file is on disk. Held back by
 * the relay until the Mac's hello lists `problems/1`.
 */
export const ProblemItemFrame = frame('problem.item', { problem: Problem })

// ---- MCP apps (connector apps as live widgets) ------------------------------------------------------------------------
// Additive: no existing frame changed shape. `app.request` is signed by a pinned device (it proves "came through the
// owner's device", not "the owner meant it": the content is third-party code's, so the bridge treats every resulting
// notification as external). Neither request nor response is stored or replayed; `app.update` is durable.

const AppToolArguments = z.record(z.string(), z.unknown()).refine(jcsAtMost(APP_TOOL_INPUT_MAX), 'arguments too large')

export const AppRequestToolsCallFrame = ownerFrame('app.request', {
  thread_id: ThreadId,
  view_id: ViewId,
  request_id: AppRequestId,
  method: z.literal('tools/call'),
  tool_name: z.string().min(1).max(128), // the raw MCP tool name, never `mcp__server__tool`
  arguments: AppToolArguments,
  user_gesture: z.boolean(),
})
export const AppRequestUiMessageFrame = ownerFrame('app.request', {
  thread_id: ThreadId,
  view_id: ViewId,
  request_id: AppRequestId,
  method: z.literal('ui/message'),
  text: z.string().min(1).max(APP_MESSAGE_TEXT_MAX),
  user_gesture: z.boolean(),
  /** The owner tapped Send on a Talos chip showing this text. Part of the signed frame; without it the bridge refuses. */
  owner_confirmed: z.boolean().optional(),
})
export const AppRequestFrame = z.discriminatedUnion('method', [AppRequestToolsCallFrame, AppRequestUiMessageFrame])

export const AppResponseFrame = frame('app.response', {
  view_id: ViewId,
  request_id: AppRequestId,
  state: z.enum(['pending_card', 'done', 'failed']),
  card_id: CardId.optional(),
  result: McpCallToolResult.refine(jcsAtMost(APP_TOOL_RESULT_MAX), 'result too large').optional(),
  result_media: AttachmentRef.optional(),
  error: z.object({ code: AppErrorCode, message: z.string().max(200) }).optional(),
})
  .refine((f) => f.state !== 'failed' || f.error !== undefined, { message: 'failed needs error', path: ['error'] })
  .refine((f) => f.state !== 'pending_card' || f.card_id !== undefined, {
    message: 'pending_card needs card_id',
    path: ['card_id'],
  })
  .refine((f) => f.state === 'failed' || f.error === undefined, {
    message: 'only failed carries error',
    path: ['error'],
  })
  .refine((f) => f.result === undefined || f.result_media === undefined, {
    message: 'result or result_media, not both',
    path: ['result'],
  })

export const AppUpdateFrame = frame('app.update', {
  view_id: ViewId,
  thread_id: ThreadId,
  state: z.enum(['superseded', 'closed', 'revoked']),
  reason: z.string().max(200).optional(),
})
export const APP_OWNER_FRAME_TYPES = ['app.request'] as const
export const APP_BRIDGE_FRAME_TYPES = ['app.response', 'app.update'] as const

/** The five signed read frames (app -> relay -> bridge), each answered on the bridge's readQueue. */
export const V2_READ_OWNER_FRAME_TYPES = [
  'search.query',
  'memory.tree',
  'memory.read',
  'memory.search',
  'speak.request',
] as const
/** The five bridge -> relay -> app answers, routed to the asking socket only. */
export const V2_READ_RESPONSE_FRAME_TYPES = [
  'search.results',
  'memory.listing',
  'memory.file',
  'memory.results',
  'speak.result',
] as const
/** Which answer each signed read expects (core/ephemeral.ts drops any other type for that request_id). */
export const V2_READ_RESPONSE_FOR = {
  'search.query': 'search.results',
  'memory.tree': 'memory.listing',
  'memory.read': 'memory.file',
  'memory.search': 'memory.results',
  'speak.request': 'speak.result',
} as const satisfies Record<(typeof V2_READ_OWNER_FRAME_TYPES)[number], (typeof V2_READ_RESPONSE_FRAME_TYPES)[number]>

// ---- registry ---------------------------------------------------------------------------------------------------

/** Every frame schema keyed by `type`. `hello` has two shapes, split by `role`. */
export const frameSchemas = {
  challenge: ChallengeFrame,
  hello: z.union([HelloBridgeFrame, HelloAppFrame]),
  ready: ReadyFrame,
  ping: PingFrame,
  pong: PongFrame,
  ack: AckFrame,
  'replay.request': ReplayRequestFrame,
  error: ErrorFrame,
  message: MessageFrame,
  voice_note: VoiceNoteFrame,
  'message.stored': MessageStoredFrame,
  transcript: TranscriptFrame,
  reply: ReplyFrame,
  receipt: ReceiptFrame,
  status: StatusFrame,
  presence: PresenceFrame,
  'card.create': CardCreateFrame,
  'card.resolve': CardResolveFrame,
  'card.update': CardUpdateFrame,
  'hook.event': HookEventFrame,
  'hook.digest': HookDigestFrame,
  'inbox.item': InboxItemFrame,
  'inbox.update': InboxUpdateFrame,
  'thread.upsert': ThreadUpsertFrame,
  'thread.archive': ThreadArchiveFrame,
  'thread.read': ThreadReadFrame,
  'thread.unread': ThreadUnreadFrame,
  'config.sync': ConfigSyncFrame,
  'config.patch': ConfigPatchFrame,
  'catchup.batch': CatchupBatchFrame,
  'catchup.reset': CatchupResetFrame,
  'catchup.request': CatchupRequestFrame,
  'catchup.summary': CatchupSummaryFrame,
  'history.request': HistoryRequestFrame,
  'history.page': HistoryPageFrame,
  'media.fetch': MediaFetchFrame,
  'media.ready': MediaReadyFrame,
  visibility: VisibilityFrame,
  'voice.state': VoiceStateFrame,
  'voice.ask': VoiceAskFrame,
  'voice.progress': VoiceProgressFrame,
  'voice.ended': VoiceEndedFrame,
  'device.enrolled': DeviceEnrolledFrame,
  'device.pinned': DevicePinnedFrame,
  'device.revoked': DeviceRevokedFrame,
  'schedules.list': SchedulesListFrame,
  'schedules.snapshot': SchedulesSnapshotFrame,
  'schedule.get': ScheduleGetFrame,
  'schedule.detail': ScheduleDetailFrame,
  'schedule.patch': SchedulePatchFrame,
  'schedule.run_now': ScheduleRunNowFrame,
  'schedule.control': ScheduleControlFrame,
  'schedule.status': ScheduleStatusFrame,
  'heartbeat.test': HeartbeatTestFrame,
  'heartbeat.test_result': HeartbeatTestResultFrame,
  'session.state': SessionStateFrame,
  'session.inventory': SessionInventoryFrame,
  'session.control': SessionControlFrame,
  'session.control.result': SessionControlResultFrame,
  'session.list': SessionListFrame,
  'session.spawn': SessionSpawnFrame,
  'thread.session.control': ThreadSessionControlFrame,
  'agent.recover': AgentRecoverFrame,
  'agent.recover.result': AgentRecoverResultFrame,
  'workers.status': WorkersStatusFrame,
  'session.agents': SessionAgentsFrame,
  'health.beat': HealthBeatFrame,
  'search.query': SearchQueryFrame,
  'search.results': SearchResultsFrame,
  'memory.tree': MemoryTreeFrame,
  'memory.listing': MemoryListingFrame,
  'memory.read': MemoryReadFrame,
  'memory.file': MemoryFileFrame,
  'memory.search': MemorySearchFrame,
  'memory.results': MemoryResultsFrame,
  'speak.request': SpeakRequestFrame,
  'speak.result': SpeakResultFrame,
  'share.item': ShareItemFrame,
  'problem.item': ProblemItemFrame,
  'native.act': NativeActWire,
  'app.request': AppRequestFrame,
  'app.response': AppResponseFrame,
  'app.update': AppUpdateFrame,
} as const

export type FrameType = keyof typeof frameSchemas
export const FRAME_TYPES = Object.keys(frameSchemas) as FrameType[]
export type FrameOf<T extends FrameType> = z.infer<(typeof frameSchemas)[T]>
export type Frame = { [K in FrameType]: FrameOf<K> }[FrameType]

/** Owner (signed) frame types. */
export const OWNER_FRAME_TYPES = [
  'message',
  'voice_note',
  'card.resolve',
  'config.patch',
  'voice.ask',
  ...SCHEDULE_OWNER_FRAME_TYPES,
  ...HEARTBEAT_OWNER_FRAME_TYPES,
  ...SESSION_OWNER_FRAME_TYPES,
  ...THREAD_SESSION_OWNER_FRAME_TYPES,
  ...AGENT_RECOVER_OWNER_FRAME_TYPES,
  ...V2_READ_OWNER_FRAME_TYPES,
  ...APP_OWNER_FRAME_TYPES,
] as const satisfies readonly FrameType[]

/** Frames that are stored durably and acked (3.4 "durable" column). */
export const DURABLE_FRAME_TYPES: readonly FrameType[] = [
  'message',
  'voice_note',
  'transcript',
  'reply',
  'card.create',
  'card.resolve',
  'card.update',
  'hook.event',
  'hook.digest',
  'inbox.item',
  'inbox.update',
  'thread.upsert',
  'thread.archive',
  'config.sync',
  'config.patch',
  'voice.ask',
  'voice.ended',
  'device.enrolled',
  'device.pinned',
  'device.revoked',
  'share.item',
  'problem.item',
  'native.act',
  'app.update',
]

/**
 * Relay->bridge frames the bridge turns into a Claude channel notification. These get the second ack stage
 * (`consumed`) and stay in the relay's replay buffer until it arrives.
 */
export const CONSUMABLE_FRAME_TYPES: readonly FrameType[] = [
  'message',
  'voice_note',
  'card.resolve',
  'hook.event',
  'hook.digest',
  'voice.ask',
  'voice.ended',
  'share.item',
  'problem.item',
  'native.act',
]

export type Direction = 'app_to_relay' | 'relay_to_app' | 'bridge_to_relay' | 'relay_to_bridge'

const COMMON: FrameType[] = ['ping', 'pong', 'error']

export const DIRECTION_TYPES: Record<Direction, readonly FrameType[]> = {
  app_to_relay: [
    ...COMMON,
    'hello',
    'message',
    'voice_note',
    'card.resolve',
    'inbox.update',
    'thread.read',
    'thread.unread',
    'config.patch',
    'catchup.request',
    'history.request',
    'media.fetch',
    'visibility',
    'voice.ask',
    ...SCHEDULE_OWNER_FRAME_TYPES,
    ...HEARTBEAT_OWNER_FRAME_TYPES,
    ...SESSION_OWNER_FRAME_TYPES,
    ...THREAD_SESSION_OWNER_FRAME_TYPES,
    ...AGENT_RECOVER_OWNER_FRAME_TYPES,
    ...V2_READ_OWNER_FRAME_TYPES,
    ...APP_OWNER_FRAME_TYPES,
  ],
  relay_to_app: [
    ...COMMON,
    'ready',
    'ack',
    'message.stored',
    'transcript',
    'reply',
    'receipt',
    'status',
    'presence',
    'card.create',
    'card.update',
    'inbox.item',
    'inbox.update',
    'thread.upsert',
    'thread.archive',
    'thread.read',
    'thread.unread',
    'config.sync',
    'catchup.batch',
    'catchup.reset',
    'catchup.summary',
    'history.page',
    'media.ready',
    'voice.state',
    'device.pinned',
    ...SCHEDULE_BRIDGE_FRAME_TYPES,
    ...HEARTBEAT_BRIDGE_FRAME_TYPES,
    ...SESSION_BRIDGE_FRAME_TYPES,
    ...THREAD_SESSION_BRIDGE_FRAME_TYPES,
    ...AGENT_RECOVER_BRIDGE_FRAME_TYPES,
    ...V2_READ_RESPONSE_FRAME_TYPES,
    ...APP_BRIDGE_FRAME_TYPES,
  ],
  bridge_to_relay: [
    ...COMMON,
    'hello',
    'ack',
    'replay.request',
    'transcript',
    'reply',
    'receipt',
    'status',
    'card.create',
    'card.update',
    'inbox.update',
    'thread.upsert',
    'thread.archive',
    'config.sync',
    'history.page',
    'voice.progress',
    'device.pinned',
    ...SCHEDULE_BRIDGE_FRAME_TYPES,
    ...HEARTBEAT_BRIDGE_FRAME_TYPES,
    ...SESSION_BRIDGE_FRAME_TYPES,
    ...THREAD_SESSION_BRIDGE_FRAME_TYPES,
    ...AGENT_RECOVER_BRIDGE_FRAME_TYPES,
    ...V2_READ_RESPONSE_FRAME_TYPES,
    ...APP_BRIDGE_FRAME_TYPES,
    'health.beat',
  ],
  relay_to_bridge: [
    ...COMMON,
    'challenge',
    'ready',
    'ack',
    'message',
    'voice_note',
    'card.resolve',
    'config.patch',
    'hook.event',
    'hook.digest',
    'history.request',
    'media.fetch',
    'voice.ask',
    'voice.ended',
    'device.enrolled',
    'device.revoked',
    ...SCHEDULE_OWNER_FRAME_TYPES,
    ...HEARTBEAT_OWNER_FRAME_TYPES,
    ...SESSION_OWNER_FRAME_TYPES,
    ...THREAD_SESSION_OWNER_FRAME_TYPES,
    ...AGENT_RECOVER_OWNER_FRAME_TYPES,
    ...V2_READ_OWNER_FRAME_TYPES,
    ...APP_OWNER_FRAME_TYPES,
    'share.item',
    'problem.item',
    'native.act',
  ],
}

export function isFrameFor(direction: Direction, frame: { type: string }): boolean {
  return (DIRECTION_TYPES[direction] as readonly string[]).includes(frame.type)
}

/** Direction unions (schema-level). `hello` resolves to the right role for the hop. */
function unionFor(direction: Direction) {
  const schemas = DIRECTION_TYPES[direction].map((t) => {
    if (t !== 'hello') return frameSchemas[t]
    return direction === 'app_to_relay' ? HelloAppFrame : HelloBridgeFrame
  })
  return z.union(schemas as unknown as [z.ZodType, z.ZodType, ...z.ZodType[]])
}
export const AppToRelay = unionFor('app_to_relay')
export const RelayToApp = unionFor('relay_to_app')
export const BridgeToRelay = unionFor('bridge_to_relay')
export const RelayToBridge = unionFor('relay_to_bridge')

export type ParseResult = { ok: true; frame: Frame } | { ok: false; code: 'bad_frame' | 'too_large'; message: string }

/** Parse one already-JSON-decoded frame. Unknown `type` is `bad_frame`, never a throw. */
export function parseFrame(input: unknown, opts: { direction?: Direction } = {}): ParseResult {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    return { ok: false, code: 'bad_frame', message: 'frame must be a JSON object' }
  }
  const type = (input as { type?: unknown }).type
  if (typeof type !== 'string' || !Object.hasOwn(frameSchemas, type)) {
    return { ok: false, code: 'bad_frame', message: 'unknown frame type' }
  }
  if (opts.direction && !isFrameFor(opts.direction, { type })) {
    return { ok: false, code: 'bad_frame', message: `frame type not allowed in ${opts.direction}` }
  }
  const schema = frameSchemas[type as FrameType] as z.ZodType
  const res = schema.safeParse(input)
  if (!res.success) {
    const first = res.error.issues[0]
    const where = first?.path.join('.') || '(root)'
    return { ok: false, code: 'bad_frame', message: `invalid ${type} frame at ${where}` }
  }
  return { ok: true, frame: res.data as Frame }
}

/** Size check + JSON decode + parseFrame for a WebSocket text message. */
export function parseFrameText(
  text: string,
  opts: { authenticated: boolean; direction?: Direction },
): ParseResult & { raw?: unknown } {
  const limit = opts.authenticated ? MAX_FRAME_BYTES : MAX_FRAME_BYTES_UNAUTH
  if (new TextEncoder().encode(text).length > limit) {
    return { ok: false, code: 'too_large', message: 'frame too large' }
  }
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    return { ok: false, code: 'bad_frame', message: 'not valid JSON' }
  }
  const res = parseFrame(raw, opts.direction ? { direction: opts.direction } : {})
  return { ...res, raw }
}
