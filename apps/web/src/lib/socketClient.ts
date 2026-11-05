// The real TalosClient: WebSocket to the relay (cookie auth), hello/ready, catch-up, signed-bytes outbox, reconnect
// backoff, history paging. Every owner frame is signed over the RAW object (spec 3.5) with explicit empty arrays and the
// exact bytes that were signed are what goes on the wire, now or after a reconnect.
import { startAuthentication } from '@simplewebauthn/browser'
import {
  type AgentConfigT,
  type AttachmentRefT,
  type CardT,
  type DeviceKey,
  type ErrorCodeT,
  FORM_SENDABLE_TYPES,
  type Frame,
  type FrameOf,
  type InboxItemT,
  type MessageT,
  newId,
  newUlid,
  ORIGINAL_TS_FEATURE,
  OwnerAttachmentRef,
  ownValue,
  parseFrame,
  RUN_MAX_AGE_MS,
  routes,
  signOwnerFrame,
  textTypeOfFile,
} from '@talos-app/protocol'
import { createStore } from 'zustand/vanilla'
import {
  type CardResolveInput,
  type ClientState,
  initialClientState,
  NoAnswerError,
  NotSentError,
  type SendResult,
  type TalosApi,
  type TalosClient,
  TalosClientError,
  type UploadMeta,
  type VoiceAskArgs,
} from './client.ts'
import { type ConnectionMeta, createMetaStore } from './connectionMeta.ts'
import { deleteDeviceKey, ensureDeviceKey, loadDeviceKey } from './deviceKey.ts'
import { createHttp, endReasonOf, type FetchLike, HttpError } from './http.ts'
import { PasskeyUnavailableError, passkeyBlock, prewarmPasskeyGate, shellPasskeyDeclined } from './passkeyGate.ts'
import { onAppUpdate, onCardCreate, onCardUpdate, onInboxItem, onInboxUpdate } from './socket-frames-cards.ts'
import { onCatchupBatch, onCatchupReset, onCatchupSummary, onHistoryPage, onReady } from './socket-frames-catchup.ts'
import { onMessageStored, onReceipt, onReply, onTranscript } from './socket-frames-chat.ts'
import type { FrameContext } from './socket-frames-context.ts'
import { onAck, onDevicePinned, onError } from './socket-frames-delivery.ts'
import {
  onConfigSync,
  onPresence,
  onStatus,
  onThreadArchive,
  onThreadRead,
  onThreadUnread,
  onThreadUpsert,
} from './socket-frames-threads.ts'
import { createSocketMemory } from './socketMemory.ts'
import { createSocketSchedules, NO_ANSWER_MS } from './socketSchedules.ts'
import { createSocketSearch } from './socketSearch.ts'
import { createSocketSpeak } from './socketSpeak.ts'
import type { Storage } from './storage.ts'
import { createUnknownNotes, unknownOfFrame, unknownOfOpenCards } from './unknownFrames.ts'
import { signedFor } from './unsent.ts'

/** Re-sign a queued frame once it is this old: the Mac's own limit is 8 days, and this leaves two days to get it there. */
const RESIGN_AFTER_MS = 6 * 24 * 3600_000
/** The relay's default for how long it keeps uploaded media (BUFFER_DAYS). A voice note signed longer ago than this may point at media it has deleted. */
const MEDIA_KEPT_MS = 7 * 24 * 3600_000

/** A queued voice note that waited so long that the recording it points at is probably gone from the relay. */
class MediaGoneError extends Error {}
/** A Run (a message with `intent: 'run'`, protocol run.ts) that waited in the queue longer than a day: the tap approved a script for that moment, so it is not sent. */
class RunStaleError extends Error {
  /** The frame was written to a socket before: the Mac may have it, and may have run it. */
  constructor(readonly written: boolean) {
    super('run stale')
  }
}
/**
 * How long the relay and the Mac remember a message id (about 8 days; this leaves a day to spare). Past it, a message that
 * was written to a socket but never acked cannot be told from one the Mac already has, so it is not sent again on its own.
 */
const DEDUPE_WINDOW_MS = 7 * 24 * 3600_000

export type OutboxKind = 'message' | 'voice_note' | 'voice.ask'
export type OutboxEntry = {
  /** Frame id (also the storage key). */
  id: string
  order: number
  kind: OutboxKind
  clientMsgId: string
  threadId: string
  /** The signed frame exactly as serialized. Resent unchanged. */
  bytes: string
  /**
   * When it was first written to a socket. `null`: never written. Absent (an entry saved by an older build): treated as
   * written, because that build did not say. Saved before the write, so a crash in between counts as written too.
   */
  writtenAt?: number | null
}
export type PendingVoice = {
  clientMsgId: string
  threadId: string
  mime: string
  name: string
  durationMs?: number
  waveform?: string
  blob: Blob
  order: number
  /** The device key that was signed in when it was queued; a note from another identity is never sent by this one. */
  deviceId?: string
  /** When it was recorded, so the row it gets back after a restart sits where it belongs. */
  createdAt?: string
}

export type SocketClientOptions = {
  storage: Storage
  /** `wss://host/ws`; default derives from `location`. */
  wsUrl?: string
  fetchImpl?: FetchLike
  WebSocketImpl?: typeof WebSocket
  clientInfo?: { version: string; standalone: boolean; platform: string }
  /** Backoff: base ms, max ms, jitter 0..1 (random source injectable for tests). */
  backoff?: { baseMs?: number; maxMs?: number; random?: () => number }
  isVisible?: () => boolean
  /** How long a queued voice note waits before its upload is tried again (default 10 s). */
  voiceRetryMs?: number
  isOnline?: () => boolean
  now?: () => number
  /** Persisted render cache cap per thread. */
  cacheLimit?: number
}

export interface SocketClient extends TalosClient {
  readonly meta: ReturnType<typeof createMetaStore>
  /** Loads the cache and the device key, then connects (when a key exists). */
  start(opts?: { pinned?: boolean }): Promise<void>
  /**
   * Creates the device key if this storage jar has none. Used by enrollment. `replace` throws the stored key away and
   * makes a new one: for a device the Mac revoked, whose old key the relay will never accept again.
   */
  ensureDevice(opts?: { replace?: boolean }): Promise<DeviceKey>
  deviceKey(): Promise<DeviceKey | null>
  setPinned(pinned: boolean): void
  /** Stores an offline voice note (blob kept in IndexedDB); it is uploaded and signed when the connection is back. */
  queueVoiceNote(args: {
    threadId: string
    blob: Blob
    durationMs?: number
    waveform?: string
    name: string
  }): Promise<SendResult>
  /** Number of signed owner frames waiting for a connection or a pin. */
  outboxSize(): number
  /** Resends a failed owner message with the identical signed bytes. */
  retryMessage(clientMsgId: string): void
  /** Removes a message that never reached the Mac (queued or failed): from the outbox, the timeline and the failed list. */
  discardMessage(clientMsgId: string): Promise<void>
  /** Asks the Mac to re-upload media older than the relay buffer (`media.fetch`); `media.ready` follows. */
  fetchMedia(mediaId: string): void
}

/** POST with upload progress (fetch has none). Resolves a Response so the caller handles it like a fetch. */
function xhrUpload(
  url: string,
  headers: Record<string, string>,
  body: Uint8Array,
  onProgress: (fraction: number) => void,
  signal?: AbortSignal,
): Promise<Response> {
  return new Promise((resolve, reject) => {
    const x = new XMLHttpRequest()
    x.open('POST', url)
    x.withCredentials = true
    for (const [k, v] of Object.entries(headers)) x.setRequestHeader(k, v)
    x.upload.onprogress = (e) => {
      if (e.lengthComputable && e.total > 0) onProgress(Math.min(1, e.loaded / e.total))
    }
    x.onload = () => {
      onProgress(1)
      resolve(new Response(x.responseText, { status: x.status, headers: { 'Content-Type': 'application/json' } }))
    }
    x.onerror = () => reject(new TypeError('Network error'))
    x.onabort = () => reject(new TalosClientError('internal', 'Cancelled'))
    signal?.addEventListener('abort', () => x.abort(), { once: true })
    x.send(body as unknown as XMLHttpRequestBodyInit)
  })
}

const SNAPSHOT = 'snapshot'
const APP_REQUEST_SETTLE_MS = 5_000
const INBOX_QUEUE = 'inbox-queue'
const HISTORY_PAGE = 50
const REQUEST_TIMEOUT_MS = 12_000
/** The most the relay's `ready.ts` may move the clock we sign with (an hour: a phone further off than that is wrong, not skewed). */
const MAX_CLOCK_OFFSET_MS = 3600_000
/** The relay's upload cap (core/index.ts): bigger files are refused before they are read into memory. */
export const MAX_UPLOAD_BYTES = 50 * 1024 * 1024
/** The protocol's cap on one message's text (`frames.ts` message.text, `models.ts` Message.text). */
export const MAX_MESSAGE_CHARS = 32_000
/** The relay closes the socket (1009) on a frame over this; a signed frame past it is never sent (it would loop forever). */
const MAX_SIGNED_FRAME_BYTES = 256 * 1024
const utf8 = new TextEncoder()
/** The relay counts bytes on the wire (UTF-8), not UTF-16 units: a CJK character is 1 unit and 3 bytes. */
function overFrameLimit(frame: string): boolean {
  if (frame.length > MAX_SIGNED_FRAME_BYTES) return true // a unit is at least one byte
  if (frame.length * 3 <= MAX_SIGNED_FRAME_BYTES) return false // and at most three
  return utf8.encode(frame).length > MAX_SIGNED_FRAME_BYTES
}
/** After the app comes back to the front: how long a ping may go unanswered before the socket is called dead. */
const WAKE_PROBE_MS = 2_500
const TERMINAL_UPLOAD = new Set([400, 413, 415])
/**
 * How many uploads of one voice note may fail in a row, on one connection that stays up, before it is shown as failed.
 * Every try starts with a live, confirmed socket, so a failure is the upload path itself (the relay answered the socket and
 * refused the upload, a daily upload limit, a recording that cannot be read), not a lost connection: a dropped socket
 * does not count, and a new connection starts the count again. Nothing the relay sends says how long such a refusal lasts
 * (its 429 has no Retry-After), so this is a judgement: one failure may be a blip, a second one a coincidence, a third
 * is a pattern. With the default 10 s between tries that is about 20 s of waiting before the text behind it is released.
 */
const VOICE_UPLOAD_TRIES = 3

type Pending = {
  resolve: (seq: number | undefined) => void
  reject: (e: Error) => void
  timer: ReturnType<typeof setTimeout>
}

/** How long a config.patch waits for the Mac to apply it after the relay stored it. */
const CONFIG_APPLY_MS = 20_000

/**
 * Events that mean a person is at the screen. The relay counts a visible client as present for 60 s after its last report.
 * `scroll` is deliberately absent: the timeline sets scrollTop itself on every new row, so a scroll event cannot tell a
 * person from the app and an idle screen would keep muting pushes. Wheel and touch already cover a person scrolling.
 */
const ACTIVITY_EVENTS = ['pointerdown', 'pointermove', 'keydown', 'touchstart', 'wheel'] as const
/** At most one activity report per this long (well inside the relay's 60 s presence window). */
const ACTIVITY_REPORT_MS = 15_000

export function createSocketClient(opts: SocketClientOptions): SocketClient {
  const { storage } = opts
  const now = opts.now ?? Date.now
  // The relay's clock minus ours, learned from each `ready`. Owner frames are signed with the corrected time, so a phone
  // clock minutes off still lands inside the Mac's read window (now + 2 min / now - 5 min). Under 30 s is round-trip noise
  // and ignored; the offset is clamped to an hour (MAX_CLOCK_OFFSET_MS). The Mac checks `ts` against its own clock, so the
  // window is the same width, but the relay picks where in it a signature falls: a request it holds can be delivered only
  // inside the window, so a lie moves WHEN a captured read is usable by at most that hour, never what it asks for.
  let clockOffset = 0
  /**
   * Signed `media.fetch` frames sent (frame id -> media id), so the Mac's refusal of one is not shown as a failed message
   * and can tell the file's chip at once that it will not come.
   */
  const mediaFetchIds = new Map<string, string>()
  const signedTs = () => new Date(now() + clockOffset).toISOString()
  const isOnline = opts.isOnline ?? (() => (typeof navigator === 'undefined' ? true : navigator.onLine))
  const isVisible = opts.isVisible ?? (() => (typeof document === 'undefined' ? true : !document.hidden))
  const WS = opts.WebSocketImpl ?? (typeof WebSocket === 'undefined' ? undefined : WebSocket)
  const http = createHttp(opts.fetchImpl)
  const cacheLimit = opts.cacheLimit ?? 200
  const info = opts.clientInfo ?? { version: '0.0.0', standalone: false, platform: 'web' }
  const rnd = opts.backoff?.random ?? Math.random
  const baseMs = opts.backoff?.baseMs ?? 1000
  const maxMs = opts.backoff?.maxMs ?? 30_000
  const voiceRetryMs = opts.voiceRetryMs ?? 10_000

  const store = createStore<ClientState>(() => initialClientState())
  const meta = createMetaStore()
  const set = (fn: (s: ClientState) => Partial<ClientState>) => store.setState((s) => ({ ...s, ...fn(s) }))
  const setMeta = (p: Partial<ConnectionMeta>) => meta.setState((m) => ({ ...m, ...p }))

  const listeners = new Map<string, Set<(f: never) => void>>()
  const pending = new Map<string, Pending>()
  const historyWaiters = new Map<string, (p: FrameOf<'history.page'>) => void>()
  /** request_id -> the thread a signed history request asked about, for the life of its wait. */
  const historyAsked = new Map<string, string>()
  // history.request frame id -> reject, so an `error{ref}` from the Mac ends the wait at once (signed history reads)
  const historyErrors = new Map<string, (e: TalosClientError) => void>()
  /**
   * `config.patch` waiting for the Mac (docs/THREADS.md). The relay acks a patch when it stores it; only the bridge's
   * `config.sync{applied: id}` means saved, and its `error{ref: id}` (config_conflict, bad_frame) means refused.
   */
  const configWaiters = new Map<
    string,
    {
      baseRev: number
      resolve: () => void
      reject: (e: TalosClientError) => void
      timer: ReturnType<typeof setTimeout>
    }
  >()
  const settleConfig = (id: string, err?: TalosClientError) => {
    const w = configWaiters.get(id)
    if (!w) return false
    clearTimeout(w.timer)
    configWaiters.delete(id)
    if (err) w.reject(err)
    else w.resolve()
    return true
  }
  // search context pages (V3.2): answered to the asker only, never merged into the live timeline
  const contextRequests = new Set<string>()
  // Bumped by every `catchup.reset`. A history request remembers the value it was sent under.
  let resetGen = 0
  const historyGen = new Map<string, number>()
  // Scroll-back requests with no `before_seq`: the newest page of a thread.
  const latestRequests = new Set<string>()
  let key: DeviceKey | null = null
  let ws: WebSocket | null = null
  let ready = false
  let closed = false
  /** Bumped by close(): work that began before a sign-out must not write the queue after it. */
  let epoch = 0
  /** For each epoch that close() ended: whether the unsent queue was meant to stay (an idle expiry) or go (a sign-out). */
  const queueKeptAt = new Map<number, boolean>()
  /** Serialises the work on one message (re-sign, mark, write to the socket, discard) so two of them cannot interleave. */
  const entryLocks = new Map<string, Promise<unknown>>()
  /** Messages the owner is discarding right now: they are not written to a socket even if a flush is half way through them. */
  const discarding = new Set<string>()
  let started = false
  let attempt = 0
  let retryTimer: ReturnType<typeof setTimeout> | null = null
  let pingTimer: ReturnType<typeof setInterval> | null = null
  let lastPong = 0
  let pongs = 0
  let voiceRetryTimer: ReturnType<typeof setTimeout> | null = null
  let outbox: OutboxEntry[] = []
  let outboxOrder = 0
  // Inbox Done/Snooze not yet acknowledged by the relay, newest per item; kept across reloads and sent on every `ready`.
  type InboxPatch = { state?: 'new' | 'read' | 'snoozed' | 'done'; snoozeUntil?: string }
  let inboxQueue = new Map<string, InboxPatch>()
  const inboxInFlight = new Map<string, { eventId: string; patch: InboxPatch }>()
  let voiceQueue: PendingVoice[] = []
  let flushing = false
  /** Something asked for a flush while one was running: it runs again when that one ends, so nothing queued meanwhile is missed. */
  let flushAgain = false
  /** Counts the sockets that reached `ready`: upload failures only add up within one of them. */
  let connection = 0
  /** Moves on with each timed retry and each new connection: a voice note is uploaded at most once per round, whoever asks for a flush. */
  let round = 0
  /** Messages written to the socket, by the connection they went out on: a second flush on the same connection does not write them again. */
  const writtenOn = new Map<string, number>()
  /** Voice notes whose upload failed: how many times in a row on `connection`, and in which `round` the last one was. */
  const uploadFailures = new Map<string, { connection: number; count: number; round: number }>()
  let saveTimer: ReturnType<typeof setTimeout> | null = null

  // ---- persistence of the render cache ------------------------------------------------------------------------
  const writeSnapshot = (sync = false) => {
    const s = store.getState()
    // fromEntries defines own keys, so a thread id such as `__proto__` cannot reach the prototype.
    const messages: Record<string, MessageT[]> = Object.fromEntries(
      Object.entries(s.messages).map(([t, list]) => [t, list.slice(-cacheLimit)]),
    )
    const body = {
      messages,
      threads: s.threads,
      config: s.config,
      cards: s.cards,
      inbox: s.inbox,
      unread: s.unread,
      statuses: s.statuses,
      appStates: s.appStates,
      lastSeq: s.lastSeq,
    }
    if (sync && storage.putSync) storage.putSync('cache', SNAPSHOT, body)
    else void storage.put('cache', SNAPSHOT, body).catch(() => {})
  }
  const scheduleSave = () => {
    // The store outlives close(): a state change after a sign-out or a 401 wipe must not write the chats back.
    if (closed || saveTimer) return
    saveTimer = setTimeout(() => {
      saveTimer = null
      if (closed) return
      writeSnapshot()
    }, 250)
  }
  /**
   * Write a pending snapshot now. The 250 ms timer is a debounce, not a promise: a reload, tab close or swipe-away inside
   * that window would lose the last change (a new row never saved, a Delete that the old snapshot then brings back).
   * Storage is IndexedDB, which has no synchronous write and drops requests issued while the page unloads (seen on a
   * Chromium reload), so `putSync` also leaves a localStorage copy that the next page's first read picks up.
   */
  const flushSave = () => {
    if (closed || !saveTimer) return
    clearTimeout(saveTimer)
    saveTimer = null
    writeSnapshot(true)
  }
  const onPageHide = () => flushSave()
  const onHiddenFlush = () => {
    if (document.visibilityState === 'hidden') flushSave()
  }
  store.subscribe(scheduleSave)

  // ---- state helpers -------------------------------------------------------------------------------------------
  /** Message ids the relay reported as never taken by the Mac (receipt `not_delivered`, or `ready.not_delivered`). */
  const lostIds = new Set<string>()
  const emit = (type: string, frame: Record<string, unknown>) => {
    for (const l of listeners.get(type) ?? []) (l as (f: unknown) => void)(frame)
  }
  /** A thread's rows. Own keys only: `constructor` or `__proto__` as a thread id must not find an inherited value. */
  const rowsOf = (messages: Record<string, MessageT[]>, threadId: string): MessageT[] =>
    Object.hasOwn(messages, threadId) ? (messages[threadId] as MessageT[]) : []
  const upsertMessage = (m: MessageT) =>
    set((s) => {
      const list = rowsOf(s.messages, m.thread_id)
      const i = list.findIndex((x) => x.id === m.id)
      let next: MessageT[]
      if (i >= 0) {
        next = list.slice()
        next[i] = {
          ...(list[i] as MessageT),
          ...m,
          ...(m.receipt ? {} : list[i]?.receipt ? { receipt: list[i]?.receipt } : {}),
        }
      } else {
        next = [...list, m]
        if (m.seq !== undefined)
          next.sort((a, b) => (a.seq ?? Number.MAX_SAFE_INTEGER) - (b.seq ?? Number.MAX_SAFE_INTEGER))
      }
      return { messages: { ...s.messages, [m.thread_id]: next } }
    })
  const patchMessage = (id: string, fn: (m: MessageT) => MessageT) =>
    set((s) => {
      for (const [t, list] of Object.entries(s.messages)) {
        const i = list.findIndex((m) => m.id === id)
        if (i >= 0) {
          const next = list.slice()
          next[i] = fn(list[i] as MessageT)
          return { messages: { ...s.messages, [t]: next } }
        }
      }
      return {}
    })
  const upsertCard = (card: CardT) =>
    set((s) => {
      const i = s.cards.findIndex((c) => c.id === card.id)
      const cards = s.cards.slice()
      if (i >= 0) cards[i] = card
      else cards.push(card)
      return { cards }
    })
  /** The relay stamps `frame.relay.seq`, not `message.seq`: copy it so the timeline orders and marks read by it. */
  const withSeq = (m: MessageT, frame: { relay?: { seq: number } }): MessageT =>
    m.seq === undefined && frame.relay?.seq !== undefined ? { ...m, seq: frame.relay.seq } : m
  const bumpSeq = (frame: { relay?: { seq: number } }) => {
    const seq = frame.relay?.seq
    if (seq !== undefined && seq > store.getState().lastSeq) set(() => ({ lastSeq: seq }))
  }
  const bumpUnread = (threadId: string) =>
    set((s) => ({ unread: { ...s.unread, [threadId]: (ownValue(s.unread, threadId) ?? 0) + 1 } }))
  const setQueued = (ids: string[]) => setMeta({ queuedIds: ids })
  const refreshQueued = () =>
    setQueued([
      ...outbox.filter((e) => e.kind !== 'voice.ask').map((e) => e.clientMsgId),
      ...voiceQueue.map((v) => v.clientMsgId),
    ])

  const markFailed = (clientMsgId: string, kind: 'retry' | 'final') => {
    setMeta({ failed: { ...meta.getState().failed, [clientMsgId]: kind } })
    refreshQueued()
  }
  const clearFailed = (clientMsgId: string) => {
    const cur = meta.getState().failed
    if (!(clientMsgId in cur)) return
    const { [clientMsgId]: _gone, ...rest } = cur
    setMeta({ failed: rest })
  }

  // ---- applying frames -----------------------------------------------------------------------------------------
  function applyFrame(frame: Frame, isCatchup = false) {
    switch (frame.type) {
      case 'ready':
        return onReady(frameCtx, frame)
      case 'message.stored':
        return onMessageStored(frameCtx, frame, isCatchup)
      case 'reply':
        return onReply(frameCtx, frame, isCatchup)
      case 'transcript':
        return onTranscript(frameCtx, frame)
      case 'receipt':
        return onReceipt(frameCtx, frame)
      case 'status':
        return onStatus(frameCtx, frame)
      case 'presence':
        return onPresence(frameCtx, frame)
      case 'card.create':
        return onCardCreate(frameCtx, frame)
      case 'card.update':
        return onCardUpdate(frameCtx, frame)
      case 'inbox.item':
        return onInboxItem(frameCtx, frame, isCatchup)
      case 'inbox.update':
        return onInboxUpdate(frameCtx, frame)
      case 'thread.upsert':
        return onThreadUpsert(frameCtx, frame)
      case 'thread.archive':
        return onThreadArchive(frameCtx, frame)
      case 'thread.read':
        return onThreadRead(frameCtx, frame)
      case 'thread.unread':
        return onThreadUnread(frameCtx, frame)
      case 'config.sync':
        return onConfigSync(frameCtx, frame)
      case 'catchup.batch':
        return onCatchupBatch(frameCtx, frame)
      case 'catchup.reset':
        return onCatchupReset(frameCtx, frame)
      case 'catchup.summary':
        return onCatchupSummary(frameCtx, frame)
      case 'history.page':
        return onHistoryPage(frameCtx, frame)
      case 'app.update':
        return onAppUpdate(frameCtx, frame)
      case 'device.pinned':
        return onDevicePinned(frameCtx, frame)
      case 'ack':
        return onAck(frameCtx, frame)
      case 'error':
        return onError(frameCtx, frame)
      default:
        return
    }
  }

  /** A frame type or card kind from a newer build: one plain note in the thread, never more than once (unknownFrames.ts). */
  const noteUnknown = createUnknownNotes(
    (text, id, threadId) => addSystemRow(text, id, threadId),
    // Only a thread in the thread list counts. A key that merely has rows may have come from a peer's invented id.
    (threadId) => store.getState().threads.some((t) => t.id === threadId),
  )

  function findMessage(id: string): MessageT | undefined {
    for (const list of Object.values(store.getState().messages)) {
      const m = list.find((x) => x.id === id)
      if (m) return m
    }
    return undefined
  }

  function addSystemRow(text: string, id: string, threadId?: string) {
    const thread = threadId ?? store.getState().config?.default_thread ?? 'general'
    upsertMessage({
      id: `m_${id}`,
      thread_id: thread,
      author: 'system',
      kind: 'text',
      text,
      format: 'plain',
      attachments: [],
      via: 'app',
      created_at: new Date(now()).toISOString(),
    })
  }

  /** A stored owner frame in a catch-up batch (this device's or another's) becomes an owner message. */
  function applyStoredOwnerFrame(raw: Record<string, unknown>) {
    // Validate against the app->relay schema first: a malformed or old-version frame is skipped, never rendered.
    const parsed = parseFrame(raw, { direction: 'app_to_relay' })
    if (!parsed.ok || (parsed.frame.type !== 'message' && parsed.frame.type !== 'voice_note')) return
    const seq = (raw.relay as { seq?: number } | undefined)?.seq
    const id = String(raw.client_msg_id)
    if (findMessage(id)) {
      if (seq !== undefined) patchMessage(id, (m) => ({ ...m, seq }))
      return
    }
    const isVoice = raw.type === 'voice_note'
    upsertMessage({
      id,
      thread_id: String(raw.thread_id),
      ...(seq !== undefined ? { seq } : {}),
      author: 'owner',
      kind: isVoice ? 'voice_note' : 'text',
      ...(isVoice ? {} : { text: String(raw.text ?? '') }),
      format: 'plain',
      attachments: (parsed.frame.type === 'voice_note'
        ? [parsed.frame.attachment]
        : parsed.frame.attachments) as AttachmentRefT[],
      via: 'app',
      created_at: typeof raw.ts === 'string' ? raw.ts : new Date(now()).toISOString(),
      receipt: 'sent',
    })
    if (seq !== undefined) set((s) => ({ lastSeq: Math.max(s.lastSeq, seq) }))
  }

  const isRecord = (v: unknown): v is Record<string, unknown> =>
    typeof v === 'object' && v !== null && !Array.isArray(v)

  /** What the frame handlers (socket-frames-*.ts) reach here. Built once. A `let` that is reassigned below is read through a function. */
  const frameCtx: FrameContext = {
    store,
    set,
    now,
    lostIds,
    patchMessage,
    upsertMessage,
    upsertCard,
    withSeq,
    bumpSeq,
    bumpUnread,
    findMessage,
    clearFailed,
    markFailed,
    addSystemRow,
    emit,
    settleConfig,
    configWaiters,
    mediaFetchIds,
    pending,
    historyGen,
    historyAsked,
    contextRequests,
    latestRequests,
    historyWaiters,
    historyErrors,
    inboxSettled,
    onAcked,
    dropFromOutbox,
    flushOutbox,
    dispatch,
    send,
    isRecord,
    applyStoredOwnerFrame,
    noteUnknown,
    getKey: () => key,
    getOutbox: () => outbox,
    getResetGen: () => resetGen,
    bumpResetGen: () => {
      resetGen++
    },
  }

  function dispatch(frame: Frame, isCatchup = false) {
    if (frame.type === 'voice.state' && frame.state === 'ended') void dropVoiceAsks()
    applyFrame(frame, isCatchup)
    emit(frame.type, frame as unknown as Record<string, unknown>)
  }

  // ---- outbox --------------------------------------------------------------------------------------------------
  /**
   * Reads the saved queue. With a known device, only what that device signed is kept: a different sign-in proves a
   * different identity, and its waiting messages are removed rather than sent as this one (the owner is told).
   */
  async function loadOutbox(deviceId?: string) {
    const stored = await storage.all<OutboxEntry>('outbox')
    // A voice.ask belongs to one live call and a reload ends the call: never resend one from a previous page load.
    for (const e of stored) if (e.kind === 'voice.ask') await storage.del('outbox', e.id)
    let foreign = 0
    const mine: OutboxEntry[] = []
    for (const e of stored) {
      if (e.kind === 'voice.ask') continue
      const who = signedFor(e.bytes)
      if (deviceId !== undefined && who !== null && who !== deviceId) {
        foreign++
        await storage.del('outbox', e.id)
        continue
      }
      mine.push(e)
    }
    outbox = mine.sort((a, b) => a.order - b.order)
    try {
      const q = await storage.get<Array<[string, InboxPatch]>>('cache', INBOX_QUEUE)
      inboxQueue = new Map(Array.isArray(q) ? q : [])
    } catch {}
    const blobs = (await storage.all<PendingVoice>('blobs')).sort((a, b) => a.order - b.order)
    voiceQueue = []
    for (const v of blobs) {
      if (deviceId !== undefined && v.deviceId !== undefined && v.deviceId !== deviceId) {
        foreign++
        await storage.del('blobs', v.clientMsgId)
        continue
      }
      voiceQueue.push(v)
    }
    outboxOrder = Math.max(0, ...outbox.map((e) => e.order), ...voiceQueue.map((v) => v.order))
    restoreRows()
    refreshQueued()
    if (foreign > 0) noticeRemoved(foreign)
  }
  /** Tells the owner that waiting messages were removed instead of sent (a different sign-in, or a revoked key). */
  function noticeRemoved(n: number) {
    addSystemRow(
      `${n === 1 ? '1 message that was waiting was' : `${n} messages that were waiting were`} removed and not sent: ${
        n === 1 ? 'it was' : 'they were'
      } queued under a sign-in that is no longer this one.`,
      newId('m'),
    )
  }
  /**
   * After a session expired the cached chats were cleared, but the queue was kept: give every waiting message and voice
   * note its row back, so the owner can see it, and tap to retry one that fails.
   */
  function restoreRows() {
    const have = (threadId: string, id: string) => rowsOf(store.getState().messages, threadId).some((m) => m.id === id)
    for (const e of outbox) {
      if (e.kind === 'voice.ask' || have(e.threadId, e.clientMsgId)) continue
      try {
        const f = JSON.parse(e.bytes) as Record<string, unknown>
        const created = typeof f.ts === 'string' ? f.ts : new Date(now()).toISOString()
        const base = {
          id: e.clientMsgId,
          thread_id: e.threadId,
          author: 'owner' as const,
          format: 'plain' as const,
          via: 'app' as const,
          created_at: created,
        }
        if (e.kind === 'message')
          upsertMessage({
            ...base,
            kind: 'text',
            text: typeof f.text === 'string' ? f.text : '',
            attachments: Array.isArray(f.attachments) ? (f.attachments as AttachmentRefT[]) : [],
            ...(typeof f.reply_to === 'string' ? { reply_to: f.reply_to } : {}),
          } as MessageT)
        else
          upsertMessage({
            ...base,
            kind: 'voice_note',
            attachments: f.attachment ? [f.attachment as AttachmentRefT] : [],
            transcript: { text: '', engine: '', status: 'pending' },
          } as MessageT)
      } catch {}
    }
    for (const v of voiceQueue) {
      if (have(v.threadId, v.clientMsgId)) continue
      upsertMessage({
        id: v.clientMsgId,
        thread_id: v.threadId,
        author: 'owner',
        kind: 'voice_note',
        format: 'plain',
        attachments: [],
        via: 'app',
        created_at: v.createdAt ?? new Date(now()).toISOString(),
      })
    }
  }
  async function dropFromOutbox(frameId: string) {
    const e = outbox.find((x) => x.id === frameId)
    if (!e) return
    outbox = outbox.filter((x) => x.id !== frameId)
    await storage.del('outbox', frameId)
    refreshQueued()
  }
  function applyInboxPatch(eventId: string, patch: InboxPatch) {
    set((st) => ({
      inbox: st.inbox.map(
        (i): InboxItemT =>
          i.id === eventId
            ? {
                ...i,
                ...(patch.state ? { state: patch.state } : {}),
                ...(patch.snoozeUntil ? { snooze_until: patch.snoozeUntil } : {}),
              }
            : i,
      ),
    }))
  }
  function saveInboxQueue() {
    void storage.put('cache', INBOX_QUEUE, [...inboxQueue]).catch(() => {})
  }
  /** Sends every queued inbox change; an entry leaves the queue when the relay acks it or answers with any error but `internal`. */
  function flushInbox() {
    if (!canSend()) return
    for (const [eventId, patch] of inboxQueue) {
      if ([...inboxInFlight.values()].some((f) => f.patch === patch)) continue // already on the wire
      const id = newUlid()
      inboxInFlight.set(id, { eventId, patch })
      ws?.send(
        JSON.stringify({
          v: 1,
          type: 'inbox.update',
          id,
          ts: new Date(now()).toISOString(),
          event_id: eventId,
          ...(patch.state ? { state: patch.state } : {}),
          ...(patch.snoozeUntil ? { snooze_until: patch.snoozeUntil } : {}),
        }),
      )
    }
  }
  /** `keep`: the relay could not save it (worth another try); the change stays queued and goes out at the next flush. */
  function inboxSettled(frameId: string, keep = false): boolean {
    const f = inboxInFlight.get(frameId)
    if (!f) return false
    inboxInFlight.delete(frameId)
    // Only the change that was sent leaves the queue: a newer one for the same item stays.
    if (!keep && inboxQueue.get(f.eventId) === f.patch) {
      inboxQueue.delete(f.eventId)
      saveInboxQueue()
    }
    return true
  }
  async function dropVoiceAsks() {
    for (const e of outbox.filter((x) => x.kind === 'voice.ask')) await dropFromOutbox(e.id)
  }
  async function onAcked(frameId: string) {
    if (inboxSettled(frameId)) return
    const e = outbox.find((x) => x.id === frameId)
    await dropFromOutbox(frameId)
    if (e) writtenOn.delete(e.clientMsgId)
    if (e && e.kind !== 'voice.ask') patchMessage(e.clientMsgId, (m) => (m.receipt ? m : { ...m, receipt: 'sent' }))
  }
  const canSend = () => ws?.readyState === WS?.OPEN && ready

  function withEntryLock<T>(clientMsgId: string, fn: () => Promise<T>): Promise<T> {
    const run = (entryLocks.get(clientMsgId) ?? Promise.resolve()).then(fn)
    const tail = run.then(
      () => {},
      () => {},
    )
    entryLocks.set(clientMsgId, tail)
    void tail.then(() => {
      if (entryLocks.get(clientMsgId) === tail) entryLocks.delete(clientMsgId)
    })
    return run
  }

  /** When an older build's frame was signed: the earliest it could have been written to a socket. NaN if unreadable. */
  function signedAtOf(bytes: string): number {
    try {
      return Date.parse(String((JSON.parse(bytes) as { ts?: unknown }).ts))
    } catch {
      return Number.NaN
    }
  }

  /**
   * Saves that this entry is about to be written to a socket, before it is. Throws if that cannot be saved (it is then not
   * sent). `began` is the epoch of the caller: a close() since then means nothing may be written, and one that lands during
   * the save takes the row back out only if the close was a sign-out.
   */
  async function markWritten(e: OutboxEntry, began: number): Promise<OutboxEntry> {
    if (e.kind === 'voice.ask' || typeof e.writtenAt === 'number') return e
    if (epoch !== began) throw new TalosClientError('internal', 'Signed out')
    // An older build did not record the write: count from the signing time (the earliest it could have happened), not from now.
    const legacy = e.writtenAt === undefined ? signedAtOf(e.bytes) : Number.NaN
    const next: OutboxEntry = { ...e, writtenAt: Number.isFinite(legacy) ? legacy : now() }
    await storage.put('outbox', next.id, next)
    if (epoch !== began) {
      // A sign-out takes the row back out; an expired session keeps it, as it was before this mark.
      if (queueKeptAt.get(began)) await storage.put('outbox', e.id, e).catch(() => {})
      else await storage.del('outbox', next.id).catch(() => {})
      throw new TalosClientError('internal', 'Signed out')
    }
    outbox = outbox.map((x) => (x.id === e.id ? next : x))
    return next
  }

  /**
   * A text or voice message waits for an earlier voice note in its thread that is not on the wire yet: still to upload, or
   * uploaded and signed but not written to the current connection (one written to a socket that has since dropped counts as
   * not written: it is sent again on this one, and what follows it waits for that). One that has failed (shown with Retry and Delete) no longer holds
   * anything back. A question in a live call is never held: it belongs to a call that is happening now.
   */
  const holdsForVoice = (e: { kind: OutboxKind; threadId: string; order: number }) =>
    e.kind !== 'voice.ask' &&
    (voiceQueue.some((v) => v.threadId === e.threadId && v.order < e.order && !meta.getState().failed[v.clientMsgId]) ||
      outbox.some(
        (o) =>
          o.kind === 'voice_note' &&
          o.threadId === e.threadId &&
          o.order < e.order &&
          writtenOn.get(o.clientMsgId) !== connection &&
          !meta.getState().failed[o.clientMsgId],
      ))

  /**
   * Signs again if old, saves the written mark and writes to the socket, as one step under the message's lock. Nothing is
   * written if the message was discarded or acked meanwhile. True when it went to the socket.
   */
  function sendEntry(clientMsgId: string, began: number, restartOf?: (cur: OutboxEntry) => boolean): Promise<boolean> {
    return withEntryLock(clientMsgId, async () => {
      // Another flush wrote it while this one waited for the lock: not a second time on the same socket (a tap on retry is the exception).
      if (!restartOf && writtenOn.get(clientMsgId) === connection) return true
      const cur = outbox.find((x) => x.clientMsgId === clientMsgId)
      if (epoch !== began || !cur || discarding.has(clientMsgId)) return false
      const fresh = await freshEntry(cur, restartOf?.(cur) ?? false, began)
      if (discarding.has(clientMsgId)) return false
      const marked = await markWritten(fresh, began)
      if (epoch !== began || !canSend() || discarding.has(clientMsgId)) return false
      ws?.send(marked.bytes)
      writtenOn.set(clientMsgId, connection)
      return true
    })
  }

  /** A send that could not be prepared: a voice note whose recording is gone cannot be fixed by trying again. */
  function sendFailed(e: OutboxEntry, err: unknown) {
    if (err instanceof MediaGoneError) {
      markFailed(e.clientMsgId, 'final')
      addSystemRow(
        'A voice note waited too long to send and its recording is no longer on the server. Discard it and record it again.',
        `media_gone_${e.clientMsgId}`,
        e.threadId,
      )
      return
    }
    if (err instanceof RunStaleError) {
      markFailed(e.clientMsgId, 'final')
      // A Run that was written to a socket before may have reached the Mac and run; one that never was did not.
      addSystemRow(
        err.written
          ? 'A Run waited more than a day and its delivery was never confirmed, so it may already have run. Check before you ask for it again.'
          : 'A Run waited more than a day and was not sent. If you still want it, ask your agent to post the script again.',
        `run_stale_${e.clientMsgId}`,
        e.threadId,
      )
      return
    }
    markFailed(e.clientMsgId, 'retry')
  }

  function holdAsAmbiguous(e: OutboxEntry) {
    markFailed(e.clientMsgId, 'retry')
    addSystemRow(
      'A message was not sent again on its own: it may already have been delivered, and Talos can no longer check. Tap it to send it again.',
      `ambiguous_${e.clientMsgId}`,
      e.threadId,
    )
  }

  /** True when this entry was written to a socket (or may have been) longer ago than the relay and the Mac remember ids. */
  function mayAlreadyBeDelivered(e: OutboxEntry): boolean {
    if (e.kind === 'voice.ask' || e.writtenAt === null) return false // never written: nothing can have been delivered
    // an older build did not record it: the signing time is the earliest it could have been written
    const wrote = e.writtenAt === undefined ? signedAtOf(e.bytes) : e.writtenAt
    return Number.isFinite(wrote) ? Date.parse(signedTs()) - wrote > DEDUPE_WINDOW_MS : true
  }

  /**
   * The Mac refuses a signature older than 8 days. A message that waited that long (a session that expired while the
   * phone sat idle, say) is signed again, with a new frame id and time but the same client message id, by the same device
   * key, before it is sent. The relay and the Mac both drop a repeat of a client message id, so a message the Mac already
   * has is not delivered twice. Anything younger goes out with its original bytes.
   */
  async function freshEntry(e: OutboxEntry, restart: boolean, began: number): Promise<OutboxEntry> {
    if (e.kind === 'voice.ask') return e
    let parsed: Record<string, unknown>
    try {
      parsed = JSON.parse(e.bytes) as Record<string, unknown>
    } catch {
      return e
    }
    const signedAt = typeof parsed.ts === 'string' ? Date.parse(parsed.ts) : Number.NaN
    // The recording was uploaded before this was first signed; the relay deletes media after BUFFER_DAYS, and sending it
    // would point the Mac at nothing. It is shown as failed instead. A note signed again has a new `ts`, so its age is
    // counted from `original_ts` (the first signing) when it has one, and this runs before the early return below.
    const firstSigned = typeof parsed.original_ts === 'string' ? Date.parse(parsed.original_ts) : Number.NaN
    const mediaAt = Number.isFinite(firstSigned) ? firstSigned : signedAt
    if (parsed.type === 'voice_note' && Number.isFinite(mediaAt) && Date.parse(signedTs()) - mediaAt >= MEDIA_KEPT_MS)
      throw new MediaGoneError()
    // Same clock-free rule: the age is the saved frame's own first signing time, so a reload cannot reset it.
    if (
      parsed.type === 'message' &&
      parsed.intent === 'run' &&
      Number.isFinite(mediaAt) &&
      Date.parse(signedTs()) - mediaAt >= RUN_MAX_AGE_MS
    )
      throw new RunStaleError(e.writtenAt !== null)
    if (!Number.isFinite(signedAt) || (!restart && Date.parse(signedTs()) - signedAt < RESIGN_AFTER_MS)) return e
    const k = await ensureKey()
    if (parsed.device_id !== k.deviceId) return e // another identity's frame is never signed as this one
    const { osig: _old, original_ts: firstWritten, ...rest } = parsed
    // The Mac reads `ts` as when this was signed. A Mac that lists the feature also gets when the words were first written
    // (kept through every later re-sign); an older one would refuse the unknown field, so it gets none.
    const original = typeof firstWritten === 'string' ? firstWritten : parsed.ts
    const tellsOriginal = store.getState().presence.features?.includes(ORIGINAL_TS_FEATURE)
    const signed = await signOwnerFrame(
      { ...rest, id: newUlid(), ts: signedTs(), ...(tellsOriginal ? { original_ts: original } : {}) } as never,
      k.privateKey,
    )
    // The dedupe memory counts from the first write, so a normal re-sign keeps it; the owner's tap on a message that may
    // already be delivered starts over (that memory is gone), as a message never written.
    const next: OutboxEntry = {
      ...e,
      id: (signed as { id: string }).id,
      bytes: JSON.stringify(signed),
      // an older build's entry keeps counting from when it was signed, not from this re-sign
      ...(restart ? { writtenAt: null } : e.writtenAt === undefined ? { writtenAt: signedAt } : {}),
    }
    if (epoch !== began) throw new TalosClientError('internal', 'Signed out')
    await storage.put('outbox', next.id, next) // the new row is saved before the old one goes
    if (epoch !== began) {
      // A sign-out drops the new row; an expired session keeps the message, so the new row replaces the old one.
      await storage.del('outbox', queueKeptAt.get(began) ? e.id : next.id).catch(() => {})
      throw new TalosClientError('internal', 'Signed out')
    }
    outbox = outbox.map((x) => (x.id === e.id ? next : x))
    await storage.del('outbox', e.id).catch(() => {})
    return next
  }

  /** A flush on a timer: a good socket may never reconnect, so a step that failed would otherwise wait for one. */
  function scheduleFlushRetry() {
    if (closed) return
    if (voiceRetryTimer) clearTimeout(voiceRetryTimer)
    voiceRetryTimer = setTimeout(() => {
      voiceRetryTimer = null
      round++
      void flushOutbox()
    }, voiceRetryMs)
  }

  /** The next voice note this flush has not looked at, that is not failed and was not already tried in this round. */
  const nextVoice = (seen: Set<string>) =>
    voiceQueue.find(
      (v) =>
        !seen.has(v.clientMsgId) &&
        !meta.getState().failed[v.clientMsgId] &&
        uploadFailures.get(v.clientMsgId)?.round !== round,
    )

  /** Notes an upload failure; true when it was the last try, and the note should be shown as failed. */
  function uploadFailed(clientMsgId: string, onConnection: number): boolean {
    const before = uploadFailures.get(clientMsgId)
    const count = (before?.connection === onConnection ? before.count : 0) + 1
    uploadFailures.set(clientMsgId, { connection: onConnection, count, round })
    return count >= VOICE_UPLOAD_TRIES
  }

  async function flushOutbox() {
    if (flushing) {
      flushAgain = true
      return
    }
    if (!canSend() || !store.getState().devicePinned) return
    flushing = true
    const began = epoch
    const onConnection = connection
    try {
      // Offline voice notes first need their upload and signature; they keep their place by `order`. The queue is read
      // again after each one, so a note queued while another uploads is picked up by this same flush.
      const seen = new Set<string>()
      for (let v = nextVoice(seen); v; v = nextVoice(seen)) {
        seen.add(v.clientMsgId)
        try {
          const att = await uploadMediaNow(v.blob, {
            name: v.name,
            ...(v.durationMs ? { durationMs: v.durationMs } : {}),
            ...(v.waveform ? { waveform: v.waveform } : {}),
          })
          if (epoch !== began) return // signed out during the upload: the queue is gone, write nothing
          const stored = await withEntryLock(v.clientMsgId, async () => {
            if (discarding.has(v.clientMsgId) || !voiceQueue.some((x) => x.clientMsgId === v.clientMsgId)) return false
            const signed = await signAndStore(
              'voice_note',
              v.threadId,
              v.clientMsgId,
              { attachment: ownerAttachment(att) },
              v.order,
            )
            if (epoch !== began) {
              // A close that keeps the queue landed while this was signed: the row would point at an upload the relay sweeps
              // after a week, and the recording is the only copy on this device. Drop the row and keep the recording; the
              // next sign-in uploads it again.
              await storage.del('outbox', signed.id).catch(() => {})
              return false
            }
            voiceQueue = voiceQueue.filter((x) => x.clientMsgId !== v.clientMsgId)
            await storage.del('blobs', v.clientMsgId)
            return true
          })
          uploadFailures.delete(v.clientMsgId)
          if (stored) patchMessage(v.clientMsgId, (m) => ({ ...m, attachments: [att] }))
        } catch (e) {
          if (epoch !== began) return
          if (e instanceof HttpError && TERMINAL_UPLOAD.has(e.status)) {
            // A permanent refusal (400/413/415): retrying can never work, so stop and say so.
            voiceQueue = voiceQueue.filter((x) => x.clientMsgId !== v.clientMsgId)
            uploadFailures.delete(v.clientMsgId)
            await storage.del('blobs', v.clientMsgId)
            markFailed(v.clientMsgId, 'final')
            continue
          }
          // Network error, 429, 5xx, a recording that cannot be read: this note waits for the next round (the next ready or
          // the timer below) and the others go on. Each try that ends with the socket still the same one counts; after
          // VOICE_UPLOAD_TRIES the note is shown as failed with Retry and Delete, keeping its recording, and the text
          // behind it is released.
          if (canSend() && connection === onConnection && uploadFailed(v.clientMsgId, onConnection))
            markFailed(v.clientMsgId, 'retry')
        }
      }
      refreshQueued()
      for (const e of outbox.slice().sort((a, b) => a.order - b.order)) {
        if (!canSend()) break
        if (meta.getState().failed[e.clientMsgId]) continue // waits for the owner's tap
        if (writtenOn.get(e.clientMsgId) === connection) continue // already on this connection, waiting for its ack
        // Behind a voice note in its thread that has not uploaded: it goes after it, in the order the owner made them.
        if (holdsForVoice(e)) continue
        // A frame the relay would drop the connection over (1009) is never sent: an old build could have stored one, and it
        // would otherwise reconnect-and-resend in a loop that blocks every message behind it.
        if (overFrameLimit(e.bytes)) {
          markFailed(e.clientMsgId, 'final')
          continue
        }
        // Written before, never acked, and old enough that the dedupe memory is gone: sending it again could reach the agent
        // twice, and not sending it would lose it. So it waits for the owner, who is told, and a tap sends it again.
        if (mayAlreadyBeDelivered(e)) {
          holdAsAmbiguous(e)
          continue
        }
        try {
          await sendEntry(e.clientMsgId, began)
        } catch (err) {
          if (epoch !== began) return
          sendFailed(e, err) // could not re-sign or save it: shown as failed, tap to try again
          continue
        }
        if (epoch !== began) return
      }
    } finally {
      flushing = false
      // A flush asked for while this one ran is for the connection that is current now, even if this one began before a
      // close and a start: it must not be dropped with the old epoch.
      if (flushAgain) {
        flushAgain = false
        void flushOutbox()
      } else if (
        epoch === began &&
        !voiceRetryTimer &&
        voiceQueue.some((v) => !meta.getState().failed[v.clientMsgId])
      ) {
        scheduleFlushRetry() // a note still to upload: the next ready may be far off
      }
    }
  }

  async function signAndStore(
    kind: OutboxKind,
    threadId: string,
    clientMsgId: string,
    fields: Record<string, unknown>,
    order = ++outboxOrder,
  ): Promise<OutboxEntry> {
    const began = epoch
    const k = await ensureKey()
    const frame = {
      v: 1,
      type: kind,
      id: newUlid(),
      ts: signedTs(),
      ...(kind === 'voice.ask' ? {} : { thread_id: threadId, client_msg_id: clientMsgId }),
      ...fields,
      device_id: k.deviceId,
    }
    const signed = await signOwnerFrame(frame, k.privateKey)
    const bytes = JSON.stringify(signed)
    if (overFrameLimit(bytes)) throw new TalosClientError('too_large', 'That is too big to send as a message.')
    // Signed out while this was being signed: nothing may be written to the queue after that. A close that keeps the queue
    // (an expiry) lets the row be saved: it is sent after the next sign-in.
    if (epoch !== began && !queueKeptAt.get(began)) throw new TalosClientError('internal', 'Signed out')
    const entry: OutboxEntry = { id: signed.id, order, kind, clientMsgId, threadId, bytes, writtenAt: null }
    // Written before it joins the in-memory queue: a frame that is not saved must not be sent later by a flush, or the
    // owner (told "couldn't send") would retry and the agent would get it twice.
    try {
      await storage.put('outbox', entry.id, entry)
    } catch (e) {
      await storage.del('outbox', entry.id).catch(() => {}) // a write that failed late must not come back after a reload
      throw e
    }
    if (epoch !== began) {
      // An expired session keeps the row: it is loaded and sent after the next sign-in (or removed there with a notice if
      // the device key changed), and the closed client reports it as queued (it cannot send). A sign-out's wipe may have
      // run before this write landed: take the row back out.
      if (queueKeptAt.get(began)) return entry
      await storage.del('outbox', entry.id).catch(() => {})
      throw new TalosClientError('internal', 'Signed out')
    }
    outbox.push(entry)
    outbox.sort((a, b) => a.order - b.order)
    refreshQueued()
    return entry
  }

  async function ensureKey(): Promise<DeviceKey> {
    key ??= await ensureDeviceKey(storage)
    set((s) => (s.deviceId === key?.deviceId ? {} : { deviceId: key?.deviceId ?? null }))
    return key
  }

  function ownerAttachment(a: AttachmentRefT) {
    return OwnerAttachmentRef.parse({
      media_id: a.media_id,
      kind: a.kind,
      role: a.role ?? 'attachment',
      mime: a.mime,
      name: a.name,
      size: a.size,
      sha256: a.sha256,
      ...(a.duration_ms !== undefined ? { duration_ms: a.duration_ms } : {}),
      ...(a.width !== undefined ? { width: a.width } : {}),
      ...(a.height !== undefined ? { height: a.height } : {}),
      ...(a.waveform !== undefined ? { waveform: a.waveform } : {}),
    })
  }

  function sendState(): SendResult['state'] {
    if (!store.getState().devicePinned) return 'held_unpinned'
    return canSend() ? 'sent' : 'queued'
  }

  async function enqueue(
    kind: OutboxKind,
    threadId: string,
    clientMsgId: string,
    fields: Record<string, unknown>,
  ): Promise<SendResult> {
    const began = epoch
    const entry = await signAndStore(kind, threadId, clientMsgId, fields)
    const state = sendState()
    if (state === 'sent') {
      // Behind a voice note that is not on the wire yet: it is queued, and the flush sends both in order.
      if (holdsForVoice(entry)) {
        void flushOutbox()
        return { clientMsgId, state: 'queued' }
      }
      try {
        if (!(await sendEntry(clientMsgId, began))) return { clientMsgId, state: 'queued' }
      } catch {
        // The entry is saved and queued; a write that could not be saved just means it goes out on a later flush.
        // Throwing here would tell the caller "not sent" about a message that will be sent.
        if (epoch === began) scheduleFlushRetry()
        return { clientMsgId, state: 'queued' }
      }
    }
    return { clientMsgId, state }
  }

  // ---- sockets -------------------------------------------------------------------------------------------------
  function send(fields: Record<string, unknown>) {
    if (!canSend()) return
    ws?.send(JSON.stringify({ v: 1, id: newUlid(), ts: new Date(now()).toISOString(), ...fields }))
  }

  function wsUrl(): string {
    if (opts.wsUrl) return opts.wsUrl
    const l = location
    return `${l.protocol === 'https:' ? 'wss:' : 'ws:'}//${l.host}/ws`
  }

  function connect() {
    if (closed || !WS || !key || ws) return
    if (!isOnline()) {
      set(() => ({ connection: 'offline' }))
      setMeta({ networkOffline: true })
      return
    }
    setMeta({ networkOffline: false, retryAt: null })
    set(() => ({ connection: 'connecting' }))
    const sock = new WS(wsUrl())
    ws = sock
    ready = false
    sock.onopen = () => {
      sock.send(
        JSON.stringify({
          v: 1,
          type: 'hello',
          id: newUlid(),
          ts: new Date(now()).toISOString(),
          role: 'app',
          device_id: key?.deviceId,
          last_seq: store.getState().lastSeq,
          visible: isVisible(),
          client: info,
        }),
      )
    }
    sock.onmessage = (ev) => {
      if (typeof ev.data !== 'string') return
      let raw: unknown
      try {
        raw = JSON.parse(ev.data)
      } catch {
        return
      }
      const res = parseFrame(raw, { direction: 'relay_to_app' })
      if (!res.ok) {
        noteUnknown(unknownOfFrame(raw))
        return
      }
      const frame = res.frame
      if (frame.type === 'ping') {
        send({ type: 'pong', nonce: frame.nonce })
        return
      }
      if (frame.type === 'pong') {
        lastPong = now()
        pongs++
        return
      }
      if (frame.type === 'ready') {
        const relayNow = Date.parse(frame.ts)
        if (Number.isFinite(relayNow)) {
          const off = relayNow - now()
          // Clamped: `ready.ts` is the relay's word, and the Mac's window is only 5 min wide, so a relay that lied about
          // the time could otherwise choose where inside the window (days ahead) a signature falls.
          clockOffset = Math.abs(off) < 30_000 ? 0 : Math.max(-MAX_CLOCK_OFFSET_MS, Math.min(MAX_CLOCK_OFFSET_MS, off))
        }
        ready = true
        connection++
        round++
        attempt = 0
        lastPong = now()
        set(() => ({ connection: 'online' }))
        setMeta({ retryAt: null, authFailed: false, authReason: null, lastCloseCode: null })
        dispatch(frame)
        // After dispatch: the frame's threads are stored, so a card in one of them is filed there on the first connect too.
        for (const u of unknownOfOpenCards(raw)) noteUnknown(u)
        inboxInFlight.clear() // a new connection: nothing sent on the old one will be answered
        for (const [eventId, patch] of inboxQueue) applyInboxPatch(eventId, patch) // the snapshot predates them
        startPing(frame.policy.ping_ms)
        void flushOutbox()
        flushInbox()
        flushMediaFetches()
        return
      }
      dispatch(frame)
    }
    sock.onclose = (ev) => {
      if (ws !== sock) return
      const wasReady = ready
      ws = null
      ready = false
      stopPing()
      inboxInFlight.clear()
      rejectAllPending(new NoAnswerError('internal', 'Connection lost'))
      if (closed) return
      setMeta({ lastCloseCode: ev.code })
      if (ev.code === 4401 || ev.code === 4403) {
        set(() => ({ connection: 'offline' }))
        setMeta({ authFailed: true, authReason: ev.reason ? ev.reason : null })
        return
      }
      scheduleReconnect()
      // An expired session is refused with HTTP 401 before the upgrade, which a browser only reports as close code 1006.
      if (!wasReady && attempt >= 2) void probeSession()
    }
    sock.onerror = () => {}
  }

  let probing = false
  /** After repeated refused connections, ask /api/me whether the session is gone; if so stop and flag authFailed. */
  async function probeSession() {
    if (probing) return
    probing = true
    try {
      await http.get('/api/me')
    } catch (e) {
      if (e instanceof HttpError && e.status === 401 && !closed) {
        if (retryTimer) clearTimeout(retryTimer)
        retryTimer = null
        set(() => ({ connection: 'offline' }))
        setMeta({ authFailed: true, authReason: endReasonOf(e.body), retryAt: null })
      }
    } finally {
      probing = false
    }
  }

  function startPing(ms: number) {
    stopPing()
    pingTimer = setInterval(() => {
      if (!canSend()) return
      if (now() - lastPong > ms * 2.5) {
        ws?.close()
        return
      }
      send({ type: 'ping', nonce: newId('m').slice(2, 14) })
    }, ms)
  }
  function stopPing() {
    if (pingTimer) clearInterval(pingTimer)
    pingTimer = null
  }

  function scheduleReconnect() {
    if (closed) return
    if (retryTimer) clearTimeout(retryTimer)
    if (!isOnline()) {
      set(() => ({ connection: 'offline' }))
      setMeta({ networkOffline: true, retryAt: null })
      return
    }
    set(() => ({ connection: 'unreachable' }))
    const delay = Math.min(maxMs, baseMs * 2 ** attempt) * (0.75 + rnd() * 0.5)
    attempt++
    setMeta({ retryAt: now() + delay })
    retryTimer = setTimeout(() => {
      retryTimer = null
      connect()
    }, delay)
  }

  function rejectAllPending(err: Error) {
    for (const [id, p] of pending) {
      clearTimeout(p.timer)
      p.reject(err)
      pending.delete(id)
    }
  }

  /**
   * Sends a signed `history.request` (scroll-back, "Show more", search context) and waits for its `history.page`. The Mac
   * serves history only for a request the pinned device signed, once; a fresh frame id every time, so a retry is a new
   * request. An `error{ref}` (the Mac says no, or "update the app") rejects at once. Never queued: offline, it fails.
   */
  async function requestHistory(
    fields: Record<string, unknown>,
    timeoutMs: number,
    timeoutText: string,
    keepOutOfTimeline: boolean,
  ): Promise<FrameOf<'history.page'>> {
    if (!canSend()) throw new TalosClientError('internal', "You're offline.")
    const k = await ensureKey()
    const id = newUlid()
    const rid = String(fields.request_id)
    const signed = await signOwnerFrame(
      { v: 1, id, ts: signedTs(), type: 'history.request', ...fields, device_id: k.deviceId },
      k.privateKey,
    )
    if (keepOutOfTimeline) contextRequests.add(rid)
    else {
      historyGen.set(rid, resetGen)
      if (fields.before_seq === undefined) latestRequests.add(rid)
    }
    historyAsked.set(rid, String(fields.thread_id))
    return await new Promise<FrameOf<'history.page'>>((resolve, reject) => {
      const done = () => {
        historyWaiters.delete(rid)
        historyGen.delete(rid)
        historyAsked.delete(rid)
        latestRequests.delete(rid)
        historyErrors.delete(id)
        // the id is kept for the session: a page from a slow Mac that lands after the timeout is still not merged
        if (contextRequests.size > 500) contextRequests.delete(contextRequests.values().next().value as string)
      }
      const timer = setTimeout(() => {
        done()
        reject(new TalosClientError('internal', timeoutText))
      }, timeoutMs)
      historyWaiters.set(rid, (p) => {
        clearTimeout(timer)
        done()
        resolve(p)
      })
      historyErrors.set(id, (e) => {
        clearTimeout(timer)
        done()
        reject(e)
      })
      if (!canSend()) {
        clearTimeout(timer)
        done()
        reject(new TalosClientError('internal', "You're offline."))
        return
      }
      ws?.send(JSON.stringify(signed))
    })
  }

  /** Files asked for while the socket was not ready: sent once it is (`flushMediaFetches`). */
  const pendingMediaFetch = new Set<string>()
  function flushMediaFetches() {
    if (!canSend() || !store.getState().devicePinned) return
    const ids = [...pendingMediaFetch]
    pendingMediaFetch.clear()
    for (const id of ids) void fetchMediaSigned(id)
  }

  /**
   * `media.fetch`: the Mac re-uploads an old file only for a request a pinned device signed, once (docs/PROTOCOL.md "Signed
   * history reads"). Fire and forget: the file arrives as `media.ready`; a refusal reaches `onFrame('error')` with the `media_id` (see `onMediaFetchFailed`) and never becomes a "failed its security check" row. Not durable: asked while offline or unpinned, it waits in
   * `pendingMediaFetch` for this connection only (never the outbox, never across a reload).
   */
  async function fetchMediaSigned(mediaId: string): Promise<void> {
    if (!canSend() || !store.getState().devicePinned) {
      // A chip that mounted from the cached snapshot asks before the socket is up (or the device pin is known). Remember
      // the ask, once per file, and send it when both are true; the chip's own 20 s clock just starts early.
      if (pendingMediaFetch.size < 100) pendingMediaFetch.add(mediaId)
      return
    }
    try {
      const k = await ensureKey()
      const id = newUlid()
      const signed = await signOwnerFrame(
        { v: 1, id, ts: signedTs(), type: 'media.fetch', media_id: mediaId, device_id: k.deviceId },
        k.privateKey,
      )
      mediaFetchIds.set(id, mediaId)
      if (mediaFetchIds.size > 500) mediaFetchIds.delete(mediaFetchIds.keys().next().value as string)
      if (canSend()) ws?.send(JSON.stringify(signed))
    } catch {
      /* no key or a closed socket: the next load error asks again */
    }
  }

  /** Sends a signed frame and waits for ack or error (card.resolve, config.patch: never queued). */
  async function sendAndWait(
    frame: Record<string, unknown>,
    timeoutMs = REQUEST_TIMEOUT_MS,
  ): Promise<number | undefined> {
    if (!canSend()) throw new NotSentError('internal', "You're offline.")
    const k = await ensureKey()
    if (!store.getState().devicePinned)
      throw new NotSentError('device_not_pinned', 'Waiting for your Mac to confirm this device.')
    const id = typeof frame.id === 'string' ? frame.id : newUlid()
    const signed = await signOwnerFrame({ v: 1, id, ts: signedTs(), ...frame, device_id: k.deviceId }, k.privateKey)
    return await new Promise<number | undefined>((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id)
        reject(new NoAnswerError('internal', 'The relay did not answer.'))
      }, timeoutMs)
      pending.set(id, { resolve, reject, timer })
      ws?.send(JSON.stringify(signed))
    })
  }

  /**
   * Signs and sends a read (docs/V2-FEATURES.md V1.3) and resolves with the answer frame that carries its `request_id`.
   * The relay never acks these: the answer, `error{ref}` (rejects) or 20 s of silence ends the wait.
   */
  async function askRead(
    frame: Record<string, unknown>,
    answer: 'memory.listing' | 'memory.file' | 'memory.results' | 'speak.result',
    timeoutMs = 20_000,
  ): Promise<Record<string, unknown>> {
    if (!canSend()) throw new TalosClientError('mac_offline', "You're offline.")
    const k = await ensureKey()
    if (!store.getState().devicePinned)
      throw new TalosClientError('device_not_pinned', 'Waiting for your Mac to confirm this device.')
    const id = newUlid()
    const signed = await signOwnerFrame({ v: 1, id, ts: signedTs(), ...frame, device_id: k.deviceId }, k.privateKey)
    return await new Promise((resolve, reject) => {
      let done = false
      let off: () => void = () => {}
      const finish = (fn: () => void) => {
        if (done) return
        done = true
        clearTimeout(timer)
        off()
        pending.delete(id)
        fn()
      }
      const timer = setTimeout(
        () => finish(() => reject(new TalosClientError('mac_offline', 'Your Mac did not answer.'))),
        timeoutMs,
      )
      off = client.onFrame(answer, (f) => {
        if ((f as Record<string, unknown>).request_id === frame.request_id)
          finish(() => resolve(f as unknown as Record<string, unknown>))
      })
      // an `error{ref: id}` lands on the pending map (see the `error` case in dispatch)
      pending.set(id, { resolve: () => {}, reject: (e) => finish(() => reject(e)), timer })
      ws?.send(JSON.stringify(signed))
    })
  }

  // ---- media -----------------------------------------------------------------------------------------------------
  async function uploadMediaNow(blob: Blob, m: UploadMeta): Promise<AttachmentRefT> {
    const began = epoch
    if (blob.size > MAX_UPLOAD_BYTES) throw new TalosClientError('too_large', 'Too big to send (max 50 MB).')
    const bytes = new Uint8Array(await blob.arrayBuffer())
    const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))
    const sha = Array.from(digest, (b) => b.toString(16).padStart(2, '0')).join('')
    // A text file cannot go up as text/plain: the relay refuses the types an HTML form can send. It goes as octet-stream
    // with its real type in a header, which the relay checks against its own list and stores.
    const textType = textTypeOfFile(m.name, blob.type)
    const headers: Record<string, string> = {
      'Content-Type':
        textType || FORM_SENDABLE_TYPES.test(blob.type)
          ? 'application/octet-stream'
          : blob.type || 'application/octet-stream',
      'X-Talos-Name': encodeURIComponent(m.name),
      'X-Talos-Sha256': sha,
      'X-Talos-CSRF': '1',
    }
    if (textType) headers['X-Talos-File-Type'] = textType
    if (m.durationMs) headers['X-Talos-Duration-Ms'] = String(Math.round(m.durationMs))
    if (m.signal?.aborted) throw new TalosClientError('internal', 'Cancelled')
    const res =
      m.onProgress && !opts.fetchImpl && typeof XMLHttpRequest !== 'undefined'
        ? await xhrUpload('/api/media', headers, bytes, m.onProgress, m.signal)
        : await (opts.fetchImpl ?? ((...a) => fetch(...a)))('/api/media', {
            method: 'POST',
            credentials: 'same-origin',
            headers,
            body: bytes,
            ...(m.signal ? { signal: m.signal } : {}),
          })
    if (!res.ok) {
      // Keep the server's reason (`{ error | message }`) so the composer can say why, e.g. a full disk.
      const body = await res.json().catch(() => undefined)
      // A 401 that answers after close() belongs to the session that ended: it must not sign out the next one.
      if (res.status === 401 && epoch === began && !closed) setMeta({ authFailed: true, authReason: endReasonOf(body) })
      throw new HttpError(res.status, undefined, body)
    }
    const ref = routes.mediaUpload.res.parse(await res.json())
    return { ...ref, ...(m.waveform ? { waveform: m.waveform } : {}) }
  }

  // ---- api -------------------------------------------------------------------------------------------------------
  const sub = (path: string, id: string) => path.replace(':id', encodeURIComponent(id))
  const api: TalosApi = {
    catalog: async () => routes.catalog.res.parse(await http.get(routes.catalog.path)),
    connections: {
      list: async () => routes.connectionsList.res.parse(await http.get(routes.connectionsList.path)),
      create: async (body) =>
        routes.connectionCreate.res.parse(await http.json('POST', routes.connectionCreate.path, body)),
      get: async (id) => routes.connectionGet.res.parse(await http.get(sub(routes.connectionGet.path, id))),
      patch: async (id, body) =>
        routes.connectionPatch.res.parse(await http.json('PATCH', sub(routes.connectionPatch.path, id), body)),
      delete: async (id) => void (await http.json('DELETE', sub(routes.connectionDelete.path, id))),
      rotate: async (id) =>
        routes.connectionRotate.res.parse(await http.json('POST', sub(routes.connectionRotate.path, id), {})),
      test: async (id) =>
        routes.connectionTest.res.parse(await http.json('POST', sub(routes.connectionTest.path, id), {})),
      credentials: async (id, fields) =>
        routes.connectionCredentials.res.parse(
          await http.json('POST', sub(routes.connectionCredentials.path, id), { fields }),
        ),
      deliveries: async (id) =>
        routes.connectionDeliveries.res.parse(await http.get(sub(routes.connectionDeliveries.path, id))),
    },
    inbox: async (tab) => {
      const res = routes.inboxList.res.parse(await http.get(`${routes.inboxList.path}?tab=${tab}`))
      set((s) => {
        const other = s.inbox.filter((i) => (i.priority !== 'low') !== (tab === 'priority'))
        return { inbox: [...res.items, ...other], inboxTruncated: Boolean(res.truncated) }
      })
      return res
    },
  }

  // ---- the client ------------------------------------------------------------------------------------------------
  const schedules = createSocketSchedules({
    // schedule frames get the Mac's 20 s (S2.2), not card.resolve's 12 s: the bridge acks a patch or a get after its adapter calls
    sendAndWait: (frame) => sendAndWait(frame, NO_ANSWER_MS),
    on: (type, cb) => client.onFrame(type, cb as never),
    getSlice: () => store.getState().schedules,
    setSlice: (next) => set((s) => ({ schedules: { ...s.schedules, ...next } })),
    features: () => store.getState().presence.features,
    relayFeatures: () => store.getState().relayFeatures,
    macOnline: () => store.getState().presence.bridge_online,
  })

  const memory = createSocketMemory({ ask: (frame, answer) => askRead(frame, answer) as never })
  const speak = createSocketSpeak({ ask: (frame) => askRead(frame, 'speak.result') })

  const search = createSocketSearch({
    sendAndWait: (frame, ms) => sendAndWait(frame, ms),
    on: (type, cb) => client.onFrame(type, cb as never),
    requestPage: (frame, ms) => {
      const { type: _type, ...fields } = frame
      return requestHistory(fields, ms, "Your Mac didn't answer.", true)
    },
    features: () => store.getState().presence.features,
    macOnline: () => store.getState().presence.bridge_online,
  })

  const client: SocketClient = {
    schedules,
    search,
    memory,
    speak,
    store,
    meta,
    api,
    async start(o) {
      if (started) {
        // Called again after a re-login: the socket that an auth close (4401/4403) ended is not coming back by itself.
        if (!closed && key && !ws) {
          if (retryTimer) clearTimeout(retryTimer)
          retryTimer = null
          attempt = 0
          setMeta({ authFailed: false, authReason: null })
          if (o?.pinned !== undefined) set(() => ({ devicePinned: o.pinned as boolean }))
          connect()
        }
        return
      }
      started = true
      closed = false
      try {
        const snap = await storage.get<Partial<ClientState>>('cache', SNAPSHOT)
        if (snap && !closed) set(() => ({ ...pickSnapshot(snap), connection: 'connecting' }))
      } catch {}
      try {
        key = await loadDeviceKey(storage)
        await loadOutbox(key?.deviceId)
      } catch (e) {
        started = false // storage failed: a later start() must try again, not return early
        throw e
      }
      // close() ran while those awaits were pending (sign-out, 401): do not bring listeners or a socket back.
      if (closed) return
      set(() => ({ deviceId: key?.deviceId ?? null, ...(o?.pinned !== undefined ? { devicePinned: o.pinned } : {}) }))
      if (typeof window !== 'undefined') {
        window.addEventListener('online', onOnline)
        window.addEventListener('offline', onOffline)
        document.addEventListener('visibilitychange', onVisibility)
        window.addEventListener('pagehide', onPageHide)
        document.addEventListener('visibilitychange', onHiddenFlush)
        for (const ev of ACTIVITY_EVENTS) window.addEventListener(ev, onActivity, { passive: true, capture: true })
      }
      if (!isOnline()) setMeta({ networkOffline: true })
      connect()
      prewarmPasskeyGate() // so the first Approve tap does not wait on the AASA lookup before the passkey prompt
    },
    async ensureDevice(opts) {
      if (opts?.replace) {
        // A replaced key means the old one was revoked: what it signed or queued is never sent, whatever else happened first.
        // Count what is waiting in storage (this client may not have started and loaded it yet) so the owner can be told.
        const waiting =
          (await storage.all<OutboxEntry>('outbox').catch(() => [] as OutboxEntry[])).filter(
            (x) => x.kind !== 'voice.ask',
          ).length + (await storage.all('blobs').catch(() => [])).length
        await deleteDeviceKey(storage)
        key = null
        outbox = []
        voiceQueue = []
        // A failed wipe is not swallowed: the old key's queue must not stay behind to be loaded by the next start.
        await storage.clear('outbox')
        await storage.clear('blobs')
        refreshQueued()
        if (waiting > 0) noticeRemoved(waiting)
      }
      return ensureKey()
    },
    async deviceKey() {
      key ??= await loadDeviceKey(storage)
      return key
    },
    setPinned(pinned) {
      set(() => ({ devicePinned: pinned }))
      if (pinned) {
        void flushOutbox()
        flushMediaFetches()
      }
    },
    outboxSize: () => outbox.length + voiceQueue.length,
    retryMessage(clientMsgId) {
      // A voice note that failed to upload: it starts over with a full set of tries.
      if (voiceQueue.some((x) => x.clientMsgId === clientMsgId)) {
        uploadFailures.delete(clientMsgId)
        clearFailed(clientMsgId)
        refreshQueued()
        void flushOutbox()
        return
      }
      const e = outbox.find((x) => x.clientMsgId === clientMsgId)
      if (!e) return
      if (overFrameLimit(e.bytes)) return // can never succeed: the owner can Edit or Delete it
      clearFailed(clientMsgId)
      refreshQueued()
      if (store.getState().devicePinned && canSend()) {
        const began = epoch
        // The owner's tap decides, even for one that may already be delivered: that one is signed again and sent.
        void sendEntry(clientMsgId, began, mayAlreadyBeDelivered).catch((err) => {
          if (epoch === began) sendFailed(e, err)
        })
      }
    },
    async discardMessage(clientMsgId) {
      // Flagged first, so a flush half way through this message writes nothing more; then it waits for that step to end.
      discarding.add(clientMsgId)
      try {
        await withEntryLock(clientMsgId, async () => {
          for (const e of outbox.filter((x) => x.clientMsgId === clientMsgId)) await dropFromOutbox(e.id)
          const v = voiceQueue.find((x) => x.clientMsgId === clientMsgId)
          if (v) {
            voiceQueue = voiceQueue.filter((x) => x.clientMsgId !== clientMsgId)
            uploadFailures.delete(clientMsgId)
            await storage.del('blobs', clientMsgId)
          }
        })
      } finally {
        discarding.delete(clientMsgId)
      }
      clearFailed(clientMsgId)
      set((st) => ({
        messages: Object.fromEntries(
          Object.entries(st.messages).map(([t, list]) => [t, list.filter((m) => m.id !== clientMsgId)]),
        ),
      }))
      refreshQueued()
      void flushOutbox() // what waited behind it can go
    },
    fetchMedia(mediaId) {
      void fetchMediaSigned(mediaId)
    },
    reportPresence() {
      onActivity()
    },
    onFrame(type, listener) {
      const s = listeners.get(type) ?? new Set()
      s.add(listener as never)
      listeners.set(type, s)
      return () => void s.delete(listener as never)
    },
    async sendMessage({ threadId, text, attachments = [], replyTo, intent, runBlock }) {
      // Checked before anything is stored: a retry of a message the protocol can never accept would fail forever.
      if (text.length > MAX_MESSAGE_CHARS)
        throw new TalosClientError(
          'too_large',
          `That message is ${text.length.toLocaleString('en-US')} characters. The limit is ${MAX_MESSAGE_CHARS.toLocaleString('en-US')}.`,
        )
      const clientMsgId = newId('m')
      const owned = attachments.map(ownerAttachment)
      upsertMessage({
        id: clientMsgId,
        thread_id: threadId,
        author: 'owner',
        kind: 'text',
        text,
        format: 'plain',
        attachments,
        ...(replyTo ? { reply_to: replyTo } : {}),
        via: 'app',
        created_at: new Date(now()).toISOString(),
      })
      const fields: Record<string, unknown> = { text, attachments: owned }
      if (replyTo) fields.reply_to = replyTo
      if (intent) fields.intent = intent
      if (runBlock) fields.run_block = runBlock
      try {
        return await enqueue('message', threadId, clientMsgId, fields)
      } catch (e) {
        // Nothing was queued: the row shown for it goes too, and the caller gets the words back.
        set((st) => ({
          messages: { ...st.messages, [threadId]: rowsOf(st.messages, threadId).filter((m) => m.id !== clientMsgId) },
        }))
        throw e
      }
    },
    async sendVoiceNote({ threadId, attachment }) {
      const clientMsgId = newId('m')
      upsertMessage({
        id: clientMsgId,
        thread_id: threadId,
        author: 'owner',
        kind: 'voice_note',
        format: 'plain',
        attachments: [attachment],
        transcript: { text: '', engine: '', status: 'pending' },
        via: 'app',
        created_at: new Date(now()).toISOString(),
      })
      try {
        return await enqueue('voice_note', threadId, clientMsgId, { attachment: ownerAttachment(attachment) })
      } catch (e) {
        // Nothing was queued: the row shown for it goes too, so there is no note that looks sent but is not.
        set((st) => ({
          messages: { ...st.messages, [threadId]: rowsOf(st.messages, threadId).filter((m) => m.id !== clientMsgId) },
        }))
        throw e
      }
    },
    async queueVoiceNote({ threadId, blob, durationMs, waveform, name }) {
      const clientMsgId = newId('m')
      const began = epoch
      const owner = await ensureKey()
      const entry: PendingVoice = {
        deviceId: owner.deviceId,
        createdAt: new Date(now()).toISOString(),
        clientMsgId,
        threadId,
        mime: blob.type,
        name,
        blob,
        order: ++outboxOrder,
        ...(durationMs ? { durationMs } : {}),
        ...(waveform ? { waveform } : {}),
      }
      // Saved before it joins the queue or shows a row: a recording that could not be saved says so (the caller sees the
      // throw) and never turns up later on its own.
      if (epoch !== began || (closed && !queueKeptAt.get(epoch - 1)))
        throw new TalosClientError('internal', 'Signed out')
      try {
        await storage.put('blobs', clientMsgId, entry)
      } catch (e) {
        await storage.del('blobs', clientMsgId).catch(() => {})
        throw e
      }
      if (epoch !== began) {
        await storage.del('blobs', clientMsgId).catch(() => {})
        throw new TalosClientError('internal', 'Signed out')
      }
      voiceQueue.push(entry)
      upsertMessage({
        id: clientMsgId,
        thread_id: threadId,
        author: 'owner',
        kind: 'voice_note',
        format: 'plain',
        attachments: [],
        via: 'app',
        created_at: new Date(now()).toISOString(),
      })
      refreshQueued()
      void flushOutbox()
      return { clientMsgId, state: sendState() }
    },
    async sendVoiceAsk(args: VoiceAskArgs) {
      return enqueue('voice.ask', args.threadId, args.delegationId, {
        voice_session_id: args.voiceSessionId,
        delegation_id: args.delegationId,
        thread_id: args.threadId,
        question: args.question,
        transcript_tail: args.transcriptTail,
      })
    },
    // CC-C3: session.control. Never queued (the bridge refuses a stale control anyway).
    async sendOwnerFrame(frame) {
      await sendAndWait(frame)
    },
    // MCP Apps: the answer is an `app.response` frame, so this only waits for the relay to take the request.
    async sendAppRequest(frame) {
      if (!canSend()) throw new TalosClientError('mac_offline', "You're offline.")
      const k = await ensureKey()
      if (!store.getState().devicePinned)
        throw new TalosClientError('device_not_pinned', 'Waiting for your Mac to confirm this device.')
      const id = newUlid()
      const signed = await signOwnerFrame({ v: 1, id, ts: signedTs(), ...frame, device_id: k.deviceId }, k.privateKey)
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(id)
          resolve()
        }, APP_REQUEST_SETTLE_MS)
        pending.set(id, { resolve: () => resolve(), reject, timer })
        try {
          ws?.send(JSON.stringify(signed))
        } catch {
          clearTimeout(timer)
          pending.delete(id)
          reject(new TalosClientError('mac_offline', "You're offline."))
        }
      })
    },
    async resolveCard(cardId, input: CardResolveInput) {
      await sendAndWait({
        type: 'card.resolve',
        card_id: cardId,
        action: input.action,
        payload_hash: input.payloadHash,
        ...(input.edited ? { edited: input.edited } : {}),
        ...(input.editedHash ? { edited_hash: input.editedHash } : {}),
        ...(input.note ? { note: input.note } : {}),
        // `stepup_token` is not covered by the signature (3.5); the relay checks it and strips it.
        ...(input.stepupToken ? { stepup_token: input.stepupToken } : {}),
      })
    },
    async patchConfig(patch, popts) {
      const cfg = store.getState().config
      if (!cfg) throw new TalosClientError('config_conflict', 'No config yet.')
      const id = newUlid()
      // registered before sending: the Mac's answer can overtake nothing, but must never find no waiter
      const applied = new Promise<void>((resolve, reject) => {
        const timer = setTimeout(
          () =>
            settleConfig(
              id,
              new TalosClientError(
                'mac_offline',
                "Your Mac hasn't confirmed this change yet. It applies when your Mac picks it up.",
              ),
            ),
          CONFIG_APPLY_MS,
        )
        configWaiters.set(id, { baseRev: cfg.rev, resolve, reject, timer })
      })
      applied.catch(() => {}) // observed below; never an unhandled rejection if the send itself fails first
      try {
        await sendAndWait({
          id,
          type: 'config.patch',
          base_rev: cfg.rev,
          patch,
          ...(popts?.stepupToken ? { stepup_token: popts.stepupToken } : {}),
        })
      } catch (e) {
        settleConfig(id, e instanceof TalosClientError ? e : new TalosClientError('internal', String(e)))
        throw e
      }
      await applied
    },
    async updateInbox(eventId, patch) {
      applyInboxPatch(eventId, patch)
      // Queued, not fire-and-forget: offline, the change would show as done and then revert at the next `ready`.
      inboxQueue.set(eventId, { ...patch })
      saveInboxQueue()
      flushInbox()
    },
    markThreadUnread(threadId) {
      if (!canSend() || !store.getState().devicePinned) return false
      // Shown at once; the relay's `thread.unread` answer then sets the exact count and mark.
      set((s) => ({ unread: { ...s.unread, [threadId]: Math.max(1, ownValue(s.unread, threadId) ?? 0) } }))
      send({ type: 'thread.unread', thread_id: threadId })
      return true
    },
    markThreadRead(threadId, upToSeq, opts) {
      if (opts?.needConnection && (!canSend() || !store.getState().devicePinned)) return false
      if ((ownValue(store.getState().unread, threadId) ?? 0) === 0) return true
      set((s) => ({
        unread: { ...s.unread, [threadId]: 0 },
        ...(s.readUpto
          ? { readUpto: { ...s.readUpto, [threadId]: Math.max(ownValue(s.readUpto, threadId) ?? 0, upToSeq) } }
          : {}),
      }))
      send({ type: 'thread.read', thread_id: threadId, up_to_seq: upToSeq })
      return true
    },
    async loadHistory(threadId, beforeSeq) {
      if (!canSend() || !store.getState().devicePinned) return { hasMore: false, unavailable: 'mac_offline' as const }
      const gen = resetGen
      const page = await requestHistory(
        {
          request_id: newUlid(),
          thread_id: threadId,
          limit: HISTORY_PAGE,
          ...(beforeSeq !== undefined ? { before_seq: beforeSeq } : {}),
        },
        REQUEST_TIMEOUT_MS,
        'History did not load.',
        false,
      )
      if (gen !== resetGen) return { hasMore: true, stale: true as const }
      return { hasMore: page.has_more, ...(page.unavailable ? { unavailable: page.unavailable } : {}) }
    },
    uploadMedia: uploadMediaNow,
    async stepup(purpose) {
      // The shell may have no passkeys (WP-I6): say so before a challenge is issued, never as a false "cancelled".
      const blocked = await passkeyBlock()
      if (blocked) throw new PasskeyUnavailableError(blocked)
      const optionsJSON = await http.json<Parameters<typeof startAuthentication>[0]['optionsJSON']>(
        'POST',
        routes.stepupOptions.path,
        { purpose },
      )
      let response: Awaited<ReturnType<typeof startAuthentication>>
      try {
        response = await startAuthentication({ optionsJSON })
      } catch (e) {
        if (shellPasskeyDeclined(e)) throw new PasskeyUnavailableError('shell_declined')
        throw e
      }
      const res = routes.stepupVerify.res.parse(
        await http.json('POST', routes.stepupVerify.path, { purpose, response }),
      )
      return res.stepup_token
    },
    async signOwnerFrame(frame) {
      const k = await ensureKey()
      return signOwnerFrame({ ...frame, device_id: k.deviceId }, k.privateKey)
    },
    reconnect() {
      if (closed) return
      if (retryTimer) clearTimeout(retryTimer)
      retryTimer = null
      attempt = 0
      if (ws && ws.readyState !== WS?.CLOSED) {
        try {
          ws.close()
        } catch {}
        ws = null
      }
      connect()
    },
    close(closeOpts) {
      closed = true
      queueKeptAt.set(epoch, closeOpts?.keepQueue === true)
      epoch++
      started = false
      // The key is re-read from storage by the next start() or deviceKey(): a caller that deleted it (revoke) must not
      // see this stale copy, and a 401 flag from the session that just ended must not outlive it.
      key = null
      setMeta({ authFailed: false, authReason: null })
      if (retryTimer) clearTimeout(retryTimer)
      // A snapshot still waiting to be written must not land after a sign-out has emptied the cache.
      if (saveTimer) clearTimeout(saveTimer)
      saveTimer = null
      stopPing()
      if (wakeTimer) clearTimeout(wakeTimer)
      if (voiceRetryTimer) clearTimeout(voiceRetryTimer)
      voiceRetryTimer = null
      uploadFailures.clear()
      writtenOn.clear()
      rejectAllPending(new NoAnswerError('internal', 'Closed'))
      for (const id of [...configWaiters.keys()]) settleConfig(id, new TalosClientError('internal', 'Closed'))
      if (typeof window !== 'undefined') {
        window.removeEventListener('online', onOnline)
        window.removeEventListener('offline', onOffline)
        document.removeEventListener('visibilitychange', onVisibility)
        window.removeEventListener('pagehide', onPageHide)
        document.removeEventListener('visibilitychange', onHiddenFlush)
        for (const ev of ACTIVITY_EVENTS) window.removeEventListener(ev, onActivity, { capture: true })
      }
      const s = ws
      ws = null
      s?.close()
    },
  }

  function onOnline() {
    setMeta({ networkOffline: false })
    client.reconnect()
  }
  function onOffline() {
    setMeta({ networkOffline: true })
    set(() => ({ connection: 'offline' }))
    // Close the zombie socket so sends queue now instead of claiming "sent" until the ping times out.
    if (retryTimer) clearTimeout(retryTimer)
    retryTimer = null
    const s = ws
    ws = null
    ready = false
    stopPing()
    rejectAllPending(new NoAnswerError('internal', 'Offline'))
    try {
      s?.close()
    } catch {}
  }
  let wakeTimer: ReturnType<typeof setTimeout> | null = null
  let lastReportAt = 0
  function onVisibility() {
    lastReportAt = now()
    send({ type: 'visibility', state: isVisible() ? 'visible' : 'hidden' })
    if (!isVisible() || closed) return
    // Coming back to the front: a phone that slept can hold a dead socket for ~25 s (until the next ping). Ask now, and
    // if nothing answers within a couple of seconds, drop it and reconnect. No socket and a retry pending: retry now.
    if (!ws) {
      // A session that was refused stays stopped: foregrounding must not start new refused attempts.
      if (meta.getState().authFailed) return
      if (retryTimer) clearTimeout(retryTimer)
      retryTimer = null
      attempt = 0
      connect()
      return
    }
    if (!canSend()) return
    const sock = ws
    const askedAt = pongs
    if (wakeTimer) clearTimeout(wakeTimer)
    send({ type: 'ping', nonce: newId('m').slice(2, 14) })
    wakeTimer = setTimeout(() => {
      wakeTimer = null
      if (ws !== sock || pongs > askedAt) return
      try {
        sock.close()
      } catch {}
      // A dead socket may not finish closing for a long time: run the close path ourselves (it ignores a later real one).
      sock.onclose?.({ code: 4000 } as CloseEvent)
    }, WAKE_PROBE_MS)
  }
  /** Pointer, key, touch or wheel while the screen is showing: tell the relay someone is here (at most once per ACTIVITY_REPORT_MS). */
  function onActivity() {
    if (!isVisible() || now() - lastReportAt < ACTIVITY_REPORT_MS) return
    // Only the presence frame: the wake probe in onVisibility is for coming back to the front, not for every tap.
    lastReportAt = now()
    send({ type: 'visibility', state: 'visible' })
  }

  return client
}

function pickSnapshot(snap: Partial<ClientState>): Partial<ClientState> {
  const out: Partial<ClientState> = {}
  if (snap.messages) out.messages = snap.messages
  if (snap.threads) out.threads = snap.threads
  if (snap.config) out.config = snap.config as AgentConfigT
  if (snap.cards) out.cards = snap.cards
  if (snap.inbox) out.inbox = snap.inbox
  if (snap.unread) out.unread = snap.unread
  if (snap.statuses) out.statuses = snap.statuses
  if (snap.appStates && typeof snap.appStates === 'object') out.appStates = snap.appStates
  if (typeof snap.lastSeq === 'number') out.lastSeq = snap.lastSeq
  return out
}

export type { ErrorCodeT }
