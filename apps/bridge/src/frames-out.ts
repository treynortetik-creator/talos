// Builders for frames the bridge sends. Every one is parsed by the protocol schema in tests (contract: "every frame a
// component emits parses with parseFrame and matches its direction union").
import {
  type AgentsSnapshotT,
  type AppErrorCodeT,
  type CardT,
  type ErrorCodeT,
  type Frame,
  type MessageT,
  newUlid,
  type SessionInventoryT,
  type SessionStateT,
  type ThreadT,
  wireSessionState,
  withLegacyMirror,
} from '@talos-app/protocol'

type Of<T extends Frame['type']> = Extract<Frame, { type: T }>
const env = (now: number) => ({ v: 1 as const, id: newUlid(), ts: new Date(now).toISOString() })

export const replyFrame = (
  now: number,
  message: MessageT,
  extra: { speak?: string; voice_delegation_id?: string; silent?: boolean } = {},
): Of<'reply'> => ({
  ...env(now),
  type: 'reply',
  message,
  ...(extra.speak ? { speak: extra.speak } : {}),
  ...(extra.voice_delegation_id ? { voice_delegation_id: extra.voice_delegation_id } : {}),
  ...(extra.silent ? { silent: true } : {}),
})

export const ackFrame = (now: number, ref: string, stage: 'delivered' | 'consumed'): Of<'ack'> => ({
  ...env(now),
  type: 'ack',
  ref,
  stage,
})

export const errorFrame = (
  now: number,
  code: Of<'error'>['code'],
  message: string,
  ref?: string,
  fields?: Array<{ path: string; message: string }>,
): Of<'error'> => ({
  ...env(now),
  type: 'error',
  code,
  message: message.slice(0, 500),
  ...(ref ? { ref } : {}),
  ...(fields?.length
    ? { fields: fields.slice(0, 20).map((f) => ({ path: f.path.slice(0, 80), message: f.message.slice(0, 200) })) }
    : {}),
})

export const receiptFrame = (now: number, messageId: string, state: 'delivered' | 'seen'): Of<'receipt'> => ({
  ...env(now),
  type: 'receipt',
  message_id: messageId,
  state,
})

export const statusFrame = (
  now: number,
  threadId: string,
  state: 'idle' | 'working' | 'needs_you',
  label?: string,
): Of<'status'> => ({
  ...env(now),
  type: 'status',
  thread_id: threadId,
  state,
  since: new Date(now).toISOString(),
  ...(label ? { label } : {}),
})

export const cardCreateFrame = (now: number, card: CardT): Of<'card.create'> => ({
  ...env(now),
  type: 'card.create',
  card,
})

export const cardUpdateFrame = (
  now: number,
  a: {
    card_id: string
    state: CardT['state']
    resolution?: CardT['resolution']
    result?: CardT['result']
    reason?: string
  },
): Of<'card.update'> => ({
  ...env(now),
  type: 'card.update',
  card_id: a.card_id,
  state: a.state,
  ...(a.resolution ? { resolution: a.resolution } : {}),
  ...(a.result ? { result: a.result } : {}),
  ...(a.reason ? { reason: a.reason } : {}),
})

export const transcriptFrame = (
  now: number,
  messageId: string,
  text: string,
  engine: string,
  status: 'pending' | 'done' | 'failed',
): Of<'transcript'> => ({
  ...env(now),
  type: 'transcript',
  message_id: messageId,
  text,
  engine: engine.slice(0, 40),
  status,
})

export const threadUpsertFrame = (now: number, thread: ThreadT): Of<'thread.upsert'> => ({
  ...env(now),
  type: 'thread.upsert',
  thread,
})
export const threadArchiveFrame = (now: number, thread_id: string): Of<'thread.archive'> => ({
  ...env(now),
  type: 'thread.archive',
  thread_id,
})

export const configSyncFrame = (
  now: number,
  config: Of<'config.sync'>['config'],
  applied?: string,
): Of<'config.sync'> => ({
  ...env(now),
  type: 'config.sync',
  config: withLegacyMirror(config), // R1-1: an older app/relay requires a top-level mirror; drop after the next release
  rev: config.rev,
  ...(applied ? { applied } : {}),
})

export const inboxUpdateFrame = (
  now: number,
  a: { event_id: string; state?: 'done'; priority?: 'high' | 'normal' | 'low'; agent_summary?: string },
): Of<'inbox.update'> => ({ ...env(now), type: 'inbox.update', ...a })

export const voiceProgressFrame = (
  now: number,
  delegationId: string,
  text: string,
  say: boolean,
): Of<'voice.progress'> => ({
  ...env(now),
  type: 'voice.progress',
  voice_delegation_id: delegationId,
  text: text.slice(0, 2000),
  say,
})

export const devicePinnedFrame = (
  now: number,
  deviceId: string,
  ok: boolean,
  reason?: Of<'device.pinned'>['reason'],
): Of<'device.pinned'> => ({
  ...env(now),
  type: 'device.pinned',
  device_id: deviceId,
  ok,
  ...(reason ? { reason } : {}),
})

export const historyPageFrame = (
  now: number,
  a: {
    request_id: string
    thread_id: string
    messages: MessageT[]
    has_more: boolean
    has_newer?: boolean
    anchor_id?: string
  },
): Of<'history.page'> => ({ ...env(now), type: 'history.page', ...a })

/** The answers to the signed v2 reads (docs/V2-FEATURES.md V1.3): routed by request_id, never stored. */
type ReadAnswer = 'search.results' | 'memory.listing' | 'memory.file' | 'memory.results' | 'speak.result'
export const readAnswerFrame = <T extends ReadAnswer>(
  now: number,
  type: T,
  requestId: string,
  body: Omit<Of<T>, 'v' | 'id' | 'ts' | 'type' | 'relay' | 'request_id'>,
): Of<T> => ({ ...env(now), type, request_id: requestId, ...body }) as unknown as Of<T>

/** C2.5: what the mod reported, relayed to the app (ephemeral: the relay keeps the last one for `ready`). */
/** Capabilities limited to SESSION_CAPABILITIES_V1: an older app or relay refuses a state with one it doesn't know. */
export const sessionStateFrame = (now: number, state: SessionStateT): Of<'session.state'> => ({
  ...env(now),
  type: 'session.state',
  state: wireSessionState(state),
})
/** docs/SUBAGENTS.md: the agents panel snapshot (ephemeral; already trimmed under AGENT_LIMITS.frameBytes). */
export const sessionAgentsFrame = (now: number, agents: AgentsSnapshotT): Of<'session.agents'> => ({
  ...env(now),
  type: 'session.agents',
  agents,
})
export const sessionInventoryFrame = (now: number, inventory: SessionInventoryT): Of<'session.inventory'> => ({
  ...env(now),
  type: 'session.inventory',
  inventory,
})

/** C2.5: the outcome of a `session.control` (durable; a replayed control gets the stored one back). */
export const sessionControlResultFrame = (
  now: number,
  r: { control_id: string; ok: boolean; code?: ErrorCodeT; text: string },
): Of<'session.control.result'> => ({
  ...env(now),
  type: 'session.control.result',
  control_id: r.control_id,
  ok: r.ok,
  ...(r.code ? { code: r.code } : {}),
  text: r.text,
  at: new Date(now).toISOString(),
})

// ---- Schedules (docs/SCHEDULES.md S2.2): none of these is durable; the relay never stores or buffers them. -------

/** ack{ref} with no seq and no stage (the relay forwards it to the sending socket). */
export const scheduleAckFrame = (now: number, ref: string): Of<'ack'> => ({ ...env(now), type: 'ack', ref })

export const schedulesSnapshotFrame = (
  now: number,
  requestId: string,
  snapshot: Of<'schedules.snapshot'>['snapshot'],
): Of<'schedules.snapshot'> => ({ ...env(now), type: 'schedules.snapshot', request_id: requestId, snapshot })

export const scheduleDetailFrame = (
  now: number,
  requestId: string,
  detail: Of<'schedule.detail'>['detail'],
  report: Of<'schedule.detail'>['report'],
): Of<'schedule.detail'> => ({ ...env(now), type: 'schedule.detail', request_id: requestId, detail, report })

export const scheduleStatusFrame = (
  now: number,
  a: Pick<Of<'schedule.status'>, 'health' | 'changed' | 'removed' | 'alert'>,
): Of<'schedule.status'> => ({ ...env(now), type: 'schedule.status', ...a })

// ---- MCP apps (MCP-APPS-SPEC M3.4) ------------------------------------------------------------------------------------

export const appResponseFrame = (
  now: number,
  r: {
    view_id: string
    request_id: string
    state: 'pending_card' | 'done' | 'failed'
    card_id?: string
    result?: Of<'app.response'>['result']
    result_media?: Of<'app.response'>['result_media']
    error?: { code: AppErrorCodeT; message: string }
  },
): Of<'app.response'> =>
  ({
    ...env(now),
    type: 'app.response',
    view_id: r.view_id,
    request_id: r.request_id,
    state: r.state,
    ...(r.card_id ? { card_id: r.card_id } : {}),
    ...(r.result ? { result: r.result } : {}),
    ...(r.result_media ? { result_media: r.result_media } : {}),
    ...(r.error ? { error: { code: r.error.code, message: r.error.message.slice(0, 200) } } : {}),
  }) as Of<'app.response'>

export const appUpdateFrame = (
  now: number,
  u: { view_id: string; thread_id: string; state: 'superseded' | 'closed' | 'revoked'; reason?: string },
): Of<'app.update'> => ({
  ...env(now),
  type: 'app.update',
  view_id: u.view_id,
  thread_id: u.thread_id,
  state: u.state,
  ...(u.reason ? { reason: u.reason.slice(0, 200) } : {}),
})

/** The answer to a `heartbeat.test` (docs/HEARTBEAT.md "In the app"). The relay routes it to the asking socket by request_id. */
export const heartbeatTestResultFrame = (
  now: number,
  requestId: string,
  result: Record<string, unknown>,
): Of<'heartbeat.test_result'> => ({ ...env(now), type: 'heartbeat.test_result', request_id: requestId, result })
