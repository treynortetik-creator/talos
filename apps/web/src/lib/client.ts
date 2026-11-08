// The one interface the UI uses to talk to the app's state and to the relay. Seam: frozen after WP0 (WP8 may edit).
//   WP6 implements `socketClient` (hello/ready, replay, signed-bytes outbox, reconnect, history paging).
//   `lib/fakeClient.ts` is an in-memory implementation seeded from fixtures; WP4 and WP7 build against it, and WP6
//   uses it until its socket client lands (`VITE_FAKE=1`).
// Components never import a client directly: they call `useTalos(selector)` and `useTalosClient()`.
import type {
  AgentConfigT,
  AttachmentRefT,
  CardActionT,
  CardT,
  ErrorCodeT,
  FrameOf,
  FrameType,
  InboxItemT,
  MessageT,
  PresenceT,
  RouteReq,
  RouteRes,
  ThreadStatusT,
  ThreadT,
} from '@talos-app/protocol'
import { createContext, createElement, type ReactNode, useContext } from 'react'
import { type StoreApi, useStore } from 'zustand'
import { initialSchedulesSlice, type SchedulesClient, type SchedulesSlice } from './schedulesClient.ts'
import type { MemoryClient, SearchClient, SpeakClient } from './v2Client.ts'

/** Rejections the relay or the Mac would send as `error{code}`; clients and the fake throw this. */
/** `onProgress` gets 0..1 as bytes go out; `signal` cancels the upload. Both optional. */
export type UploadMeta = {
  name: string
  durationMs?: number
  waveform?: string
  onProgress?: (fraction: number) => void
  signal?: AbortSignal
}

export class TalosClientError extends Error {
  readonly code: ErrorCodeT
  /** Per-field errors (`schedule_invalid`), so a form can show each under its field. */
  readonly fields: Array<{ path: string; message: string }> | undefined
  constructor(code: ErrorCodeT, message?: string, fields?: Array<{ path: string; message: string }>) {
    super(message ?? code)
    this.name = 'TalosClientError'
    this.code = code
    this.fields = fields
  }
}

/** Thrown before anything left the phone (offline, device not confirmed yet): nothing can have arrived, so a retry is safe. */
export class NotSentError extends TalosClientError {}

export type ConnectionState = 'connecting' | 'online' | 'offline' | 'unreachable'

/** Thrown when a signed request left the phone and no answer came (a timeout, a dropped socket): it may have run. */
export class NoAnswerError extends TalosClientError {}

export type CatchupSummary = {
  since_seq: number
  threads: Array<{ thread_id: string; unread: number; last_ts: string | null; needs_you: boolean }>
  open_cards: number
  overnight?: { counts: Record<string, number> }
}

/** Everything the UI renders from. Immutable: every change produces a new object (and new arrays where changed). */
export type ClientState = {
  connection: ConnectionState
  /** True once the device key has been pinned on the Mac; owner frames are held locally until then. */
  devicePinned: boolean
  deviceId: string | null
  presence: PresenceT
  config: AgentConfigT | null
  threads: ThreadT[]
  /** Messages per thread, oldest first. */
  messages: Record<string, MessageT[]>
  unread: Record<string, number>
  /** The relay's read mark per thread (`ready.read_upto`, then what this device marked). Absent from an older relay. */
  readUpto?: Record<string, number>
  statuses: Record<string, ThreadStatusT>
  cards: CardT[]
  inbox: InboxItemT[]
  catchup: CatchupSummary | null
  lastSeq: number
  /** The relay's newest seq at the last `ready` (0 before one). `lastSeq` stays 0 on a device that has not caught up. */
  serverSeq?: number
  /** The last inbox load skipped items ("Some mail was skipped: more than 200 messages arrived at once"). */
  inboxTruncated: boolean
  /** Schedules tab state (docs/SCHEDULES.md S5). */
  schedules: SchedulesSlice
  /** What the RELAY supports (`ready.features`, e.g. 'health/1', 'share/1'); bridge features live on `presence.features`. */
  relayFeatures: string[]
  /** Counts the `ready` frames applied. A screen that must not decide on a cached snapshot waits for it to move. */
  readySeq?: number
  /** MCP Apps: the last durable `app.update` per view id (superseded / closed / revoked). Persisted with the cache. */
  appStates: Record<string, { state: 'superseded' | 'closed' | 'revoked'; reason?: string }>
}

export type CardResolveInput = {
  action: Exclude<CardActionT, 'expired'>
  /** Hash the UI recomputed from what it rendered (8.4). Never pass the card's own payload_hash. */
  payloadHash: string
  edited?: { fields: Array<{ key: string; value: string }>; body?: string }
  editedHash?: string
  /** Revise note. */
  note?: string
  /** Which button of a dialog card, as its index in the card's options. */
  choice?: number
  /** From `stepup()` for risk:'high' cards. */
  stepupToken?: string
}

export type VoiceAskArgs = {
  voiceSessionId: string
  delegationId: string
  threadId: string
  /** Exactly what the owner said; the frame is signed over it. */
  question: string
  transcriptTail: Array<{ who: 'owner' | 'agent'; text: string }>
}

/** Typed HTTP API (spec 3.8). Every shape comes from the route table in `@talos-app/protocol`. */
export interface TalosApi {
  catalog(): Promise<RouteRes<'catalog'>>
  connections: {
    list(): Promise<RouteRes<'connectionsList'>>
    create(body: RouteReq<'connectionCreate'>): Promise<RouteRes<'connectionCreate'>>
    get(id: string): Promise<RouteRes<'connectionGet'>>
    patch(id: string, body: RouteReq<'connectionPatch'>): Promise<RouteRes<'connectionPatch'>>
    delete(id: string): Promise<void>
    rotate(id: string): Promise<RouteRes<'connectionRotate'>>
    test(id: string): Promise<RouteRes<'connectionTest'>>
    credentials(id: string, fields: Record<string, string>): Promise<RouteRes<'connectionCredentials'>>
    deliveries(id: string): Promise<RouteRes<'connectionDeliveries'>>
  }
  /** `GET /api/inbox?tab=`. Also refreshes `ClientState.inbox` and `inboxTruncated`. */
  inbox(tab: 'priority' | 'other'): Promise<RouteRes<'inboxList'>>
}

export type SendResult = { clientMsgId: string; state: 'sent' | 'queued' | 'held_unpinned' }

export interface TalosClient {
  /** zustand vanilla store; `useTalos` subscribes through it. */
  readonly store: StoreApi<ClientState>

  /** Signs (device key, raw JSON) and sends a `message`; queues signed bytes in the outbox while offline. */
  sendMessage(args: {
    threadId: string
    text: string
    attachments?: AttachmentRefT[]
    replyTo?: string
    intent?: 'what_did_i_miss' | 'run'
    /** With `intent: 'run'`: the block the tap is for (protocol `RunBlockRef`). The Mac allows each block one Run. */
    runBlock?: { message_id: string; index: number }
  }): Promise<SendResult>
  sendVoiceNote(args: { threadId: string; attachment: AttachmentRefT }): Promise<SendResult>
  /** Signs and sends a `voice.ask` (the owner speaking through the voice model; side effects only via a card). */
  sendVoiceAsk(args: VoiceAskArgs): Promise<SendResult>
  /**
   * Subscribes to a frame type as it arrives from the relay (`voice.state`, `reply` with `voice_delegation_id`,
   * `card.update`, ...). State-bearing frames also update `store`; this is for things the store does not keep.
   */
  onFrame<T extends FrameType>(type: T, listener: (frame: FrameOf<T>) => void): () => void
  readonly api: TalosApi
  /** Rejects with `TalosClientError` (`card_hash_mismatch`, `stepup_required`, `card_expired`, ...). */
  resolveCard(cardId: string, input: CardResolveInput): Promise<void>
  /** RFC 7386 merge patch against the current config rev. Rejects with `config_conflict` / `config_field_forbidden`. */
  patchConfig(patch: Record<string, unknown>, opts?: { stepupToken?: string }): Promise<void>
  updateInbox(eventId: string, patch: { state?: InboxItemT['state']; snoozeUntil?: string }): Promise<void>
  /**
   * Marks a thread read through the relay. With `needConnection` it does nothing and returns false when it could not be sent
   * (offline, or this device not pinned yet), so a row cannot look read while the relay still counts it unread. Without it
   * (reading a thread that is open) the badge clears at once and the mark goes out when the socket is back.
   */
  markThreadRead(threadId: string, upToSeq: number, opts?: { needConnection?: boolean }): boolean
  /**
   * Marks a thread unread (D36) through the relay, the only place the read mark can go down. False when it could not be
   * sent (offline, or this device is not pinned yet): nothing changes on screen then.
   */
  markThreadUnread(threadId: string): boolean
  /** Older messages from the relay buffer, or the Mac when beyond it. */
  /**
   * `stale`: the relay wiped the cache window while the request was out, so the page was dropped and the caller should ask
   * again from what it holds now.
   */
  loadHistory(
    threadId: string,
    beforeSeq?: number,
  ): Promise<{ hasMore: boolean; unavailable?: 'mac_offline'; stale?: true }>
  /** Uploads bytes to POST /api/media. `sha256` is the lowercase hex digest the bridge will verify. */
  uploadMedia(blob: Blob, meta: UploadMeta): Promise<AttachmentRefT>
  /** Passkey step-up; resolves a single-use token for `card:<id>`, `config:work` or `device:revoke`. */
  stepup(purpose: string): Promise<string>
  /** Signs a RAW object with the device key (adds device_id and osig). Pass every field, empty arrays included. */
  signOwnerFrame<T extends Record<string, unknown>>(frame: T): Promise<T & { device_id: string; osig: string }>
  /** Schedules (docs/SCHEDULES.md S5): the Schedules tab's calls to the Mac. */
  readonly schedules: SchedulesClient
  /** v2 search and memory seams (WP-V0). Optional until WP-V2 / WP-V5 land the socket versions; fakeClient has them. */
  readonly search?: SearchClient
  readonly memory?: MemoryClient
  /** Read aloud (the play button on an agent message). Absent on a client that cannot ask the Mac. */
  readonly speak?: SpeakClient
  /**
   * CC-C3: signs and sends a raw owner frame (`session.control`) and resolves on the relay's ack; rejects with
   * `TalosClientError`. Optional so older clients keep compiling; the answer arrives as `session.control.result`.
   */
  sendOwnerFrame?(frame: Record<string, unknown>): Promise<void>
  /**
   * MCP Apps: signs and sends an `app.request`. Never queued and never retried (a stale request is refused by the Mac).
   * Resolves once the relay took it (ack, or 5 s of silence: the answer is an `app.response` frame, not an ack); rejects
   * with `TalosClientError` when offline, not pinned, or the relay refuses it (`error{ref}`).
   */
  sendAppRequest?(frame: Record<string, unknown>): Promise<void>
  /**
   * Tells the relay a person is here while the screen shows (throttled, never while hidden). A live voice call needs no
   * touching, so it calls this on a timer to keep spoken answers from also buzzing the phone.
   */
  reportPresence?(): void
  /** Forces a reconnect attempt now ("Retry now"). */
  reconnect(): void
  /**
   * Stops the client. `keepQueue` says the session only ran out of time, so unsent messages stay in storage to go out after
   * sign-in; without it (a sign-out, a revoke, no reason given) a write still in flight takes its row back out.
   */
  close(opts?: { keepQueue?: boolean }): void
}

const ClientContext = createContext<TalosClient | null>(null)

export function ClientProvider({ client, children }: { client: TalosClient; children?: ReactNode }) {
  return createElement(ClientContext.Provider, { value: client }, children)
}

export function useTalosClient(): TalosClient {
  const client = useContext(ClientContext)
  if (!client) throw new Error('useTalosClient must be used inside <ClientProvider>')
  return client
}

/**
 * Select a slice of client state. Return primitives or existing references; a selector that builds a new array or
 * object on every call re-renders on every change (select the source and derive with useMemo instead).
 */
export function useTalos<T>(selector: (state: ClientState) => T): T {
  return useStore(useTalosClient().store, selector)
}

export const EMPTY_PRESENCE: PresenceT = { bridge_online: false, last_seen: null, queue_depth: 0 }

export function initialClientState(): ClientState {
  return {
    connection: 'connecting',
    devicePinned: false,
    deviceId: null,
    presence: EMPTY_PRESENCE,
    config: null,
    threads: [],
    messages: {},
    unread: {},
    statuses: {},
    cards: [],
    inbox: [],
    catchup: null,
    lastSeq: 0,
    inboxTruncated: false,
    schedules: initialSchedulesSlice(),
    relayFeatures: [],
    appStates: {},
  }
}
