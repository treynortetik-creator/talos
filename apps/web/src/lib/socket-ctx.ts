// What the parts of the socket client share (socketClient.ts builds it once, in createSocketClient). The settings and the
// stores are plain fields; a variable that changes over time (the socket, the epoch, the queues) is a field of this object
// and is always read as `c.name`, so every part sees its current value. A function that another part calls is listed here
// with its signature and filled in by the part that defines it, when that part is created.
import type {
  AttachmentRefT,
  CardT,
  DeviceKey,
  Frame,
  FrameOf,
  MessageT,
  OwnerAttachmentRef,
} from '@talos-app/protocol'
import { createStore, type StoreApi } from 'zustand/vanilla'
import {
  type ClientState,
  initialClientState,
  type SendResult,
  type TalosClientError,
  type UploadMeta,
} from './client.ts'
import { type ConnectionMeta, createMetaStore } from './connectionMeta.ts'
import { createHttp } from './http.ts'
import type {
  InboxPatch,
  OutboxEntry,
  OutboxKind,
  Pending,
  PendingVoice,
  SocketClient,
  SocketClientOptions,
} from './socket-types.ts'
import type { Storage } from './storage.ts'
import type { createUnknownNotes } from './unknownFrames.ts'

export type SocketCtx = {
  opts: SocketClientOptions
  storage: Storage
  now: () => number
  /** The time owner frames are signed with: ours, moved by what `ready` taught us about the relay's clock. */
  signedTs: () => string
  isOnline: () => boolean
  isVisible: () => boolean
  WS: typeof WebSocket | undefined
  http: ReturnType<typeof createHttp>
  cacheLimit: number
  info: { version: string; standalone: boolean; platform: string }
  rnd: () => number
  baseMs: number
  maxMs: number
  voiceRetryMs: number
  store: StoreApi<ClientState>
  meta: ReturnType<typeof createMetaStore>
  set: (fn: (s: ClientState) => Partial<ClientState>) => void
  setMeta: (p: Partial<ConnectionMeta>) => void

  listeners: Map<string, Set<(f: never) => void>>
  pending: Map<string, Pending>
  historyWaiters: Map<string, (p: FrameOf<'history.page'>) => void>
  /** request_id -> the thread a signed history request asked about, for the life of its wait. */
  historyAsked: Map<string, string>
  historyErrors: Map<string, (e: TalosClientError) => void>
  configWaiters: Map<
    string,
    {
      baseRev: number
      resolve: () => void
      reject: (e: TalosClientError) => void
      timer: ReturnType<typeof setTimeout>
    }
  >
  settleConfig: (id: string, err?: TalosClientError) => boolean
  contextRequests: Set<string>
  historyGen: Map<string, number>
  latestRequests: Set<string>
  queueKeptAt: Map<number, boolean>
  entryLocks: Map<string, Promise<unknown>>
  discarding: Set<string>
  writtenOn: Map<string, number>
  uploadFailures: Map<string, { connection: number; count: number; round: number }>
  inboxInFlight: Map<string, { eventId: string; patch: InboxPatch }>
  /**
   * Signed `media.fetch` frames sent (frame id -> media id), so the Mac's refusal of one is not shown as a failed message
   * and can tell the file's chip at once that it will not come.
   */
  mediaFetchIds: Map<string, string>
  /** Message ids the relay reported as never taken by the Mac (receipt `not_delivered`, or `ready.not_delivered`). */
  lostIds: Set<string>

  /**
   * The relay's clock minus ours, learned from each `ready`. Owner frames are signed with the corrected time, so a phone
   * clock minutes off still lands inside the Mac's read window (now + 2 min / now - 5 min). Under 30 s is round-trip noise
   * and ignored; the offset is clamped to an hour (MAX_CLOCK_OFFSET_MS).
   */
  clockOffset: number
  resetGen: number
  key: DeviceKey | null
  ws: WebSocket | null
  ready: boolean
  closed: boolean
  epoch: number
  started: boolean
  attempt: number
  retryTimer: ReturnType<typeof setTimeout> | null
  pingTimer: ReturnType<typeof setInterval> | null
  lastPong: number
  pongs: number
  voiceRetryTimer: ReturnType<typeof setTimeout> | null
  outbox: OutboxEntry[]
  outboxOrder: number
  inboxQueue: Map<string, InboxPatch>
  voiceQueue: PendingVoice[]
  flushing: boolean
  flushAgain: boolean
  connection: number
  round: number
  saveTimer: ReturnType<typeof setTimeout> | null
  probing: boolean
  wakeTimer: ReturnType<typeof setTimeout> | null
  lastReportAt: number
  client: SocketClient

  // socket-state.ts
  emit: (type: string, frame: Record<string, unknown>) => void
  rowsOf: (messages: Record<string, MessageT[]>, threadId: string) => MessageT[]
  upsertMessage: (m: MessageT) => void
  patchMessage: (id: string, fn: (m: MessageT) => MessageT) => void
  upsertCard: (card: CardT) => void
  withSeq: (m: MessageT, frame: { relay?: { seq: number } }) => MessageT
  bumpSeq: (frame: { relay?: { seq: number } }) => void
  bumpUnread: (threadId: string) => void
  refreshQueued: () => void
  markFailed: (clientMsgId: string, kind: 'retry' | 'final') => void
  clearFailed: (clientMsgId: string) => void
  onPageHide: () => void
  onHiddenFlush: () => void
  // socket-dispatch.ts
  dispatch: (frame: Frame, isCatchup?: boolean) => void
  addSystemRow: (text: string, id: string, threadId?: string) => void
  noteUnknown: ReturnType<typeof createUnknownNotes>
  // socket-inbox.ts
  applyInboxPatch: (eventId: string, patch: InboxPatch) => void
  saveInboxQueue: () => void
  flushInbox: () => void
  inboxSettled: (frameId: string, keep?: boolean) => boolean
  // socket-outbox-queue.ts
  loadOutbox: (deviceId?: string) => Promise<void>
  noticeRemoved: (n: number) => void
  dropFromOutbox: (frameId: string) => Promise<void>
  dropVoiceAsks: () => Promise<void>
  onAcked: (frameId: string) => Promise<void>
  withEntryLock: <T>(clientMsgId: string, fn: () => Promise<T>) => Promise<T>
  signedAtOf: (bytes: string) => number
  markWritten: (e: OutboxEntry, began: number) => Promise<OutboxEntry>
  holdsForVoice: (e: { kind: OutboxKind; threadId: string; order: number }) => boolean
  // socket-outbox-send.ts
  sendEntry: (clientMsgId: string, began: number, restartOf?: (cur: OutboxEntry) => boolean) => Promise<boolean>
  sendFailed: (e: OutboxEntry, err: unknown) => void
  holdAsAmbiguous: (e: OutboxEntry) => void
  mayAlreadyBeDelivered: (e: OutboxEntry) => boolean
  // socket-outbox-flush.ts
  scheduleFlushRetry: () => void
  flushOutbox: () => Promise<void>
  // socket-outbox-enqueue.ts
  signAndStore: (
    kind: OutboxKind,
    threadId: string,
    clientMsgId: string,
    fields: Record<string, unknown>,
    order?: number,
  ) => Promise<OutboxEntry>
  ensureKey: () => Promise<DeviceKey>
  ownerAttachment: (a: AttachmentRefT) => ReturnType<typeof OwnerAttachmentRef.parse>
  sendState: () => SendResult['state']
  enqueue: (
    kind: OutboxKind,
    threadId: string,
    clientMsgId: string,
    fields: Record<string, unknown>,
  ) => Promise<SendResult>
  // socket-connection.ts
  canSend: () => boolean
  send: (fields: Record<string, unknown>) => void
  connect: () => void
  stopPing: () => void
  rejectAllPending: (err: Error) => void
  // socket-requests.ts
  requestHistory: (
    fields: Record<string, unknown>,
    timeoutMs: number,
    timeoutText: string,
    keepOutOfTimeline: boolean,
  ) => Promise<FrameOf<'history.page'>>
  flushMediaFetches: () => void
  fetchMediaSigned: (mediaId: string) => Promise<void>
  sendAndWait: (frame: Record<string, unknown>, timeoutMs?: number) => Promise<number | undefined>
  askRead: (
    frame: Record<string, unknown>,
    answer: 'memory.listing' | 'memory.file' | 'memory.results' | 'speak.result',
    timeoutMs?: number,
  ) => Promise<Record<string, unknown>>
  // socket-upload.ts
  uploadMediaNow: (blob: Blob, m: UploadMeta) => Promise<AttachmentRefT>
  // socket-lifecycle.ts
  onOnline: () => void
  onOffline: () => void
  onVisibility: () => void
  onActivity: () => void
}

/** The settings, the stores and the starting value of every variable. The parts then fill in their functions. */
export function createSocketCtx(opts: SocketClientOptions): SocketCtx {
  const { storage } = opts
  const now = opts.now ?? Date.now
  const store = createStore<ClientState>(() => initialClientState())
  const meta = createMetaStore()
  const configWaiters: SocketCtx['configWaiters'] = new Map()
  const c = {
    opts,
    storage,
    now,
    isOnline: opts.isOnline ?? (() => (typeof navigator === 'undefined' ? true : navigator.onLine)),
    isVisible: opts.isVisible ?? (() => (typeof document === 'undefined' ? true : !document.hidden)),
    WS: opts.WebSocketImpl ?? (typeof WebSocket === 'undefined' ? undefined : WebSocket),
    http: createHttp(opts.fetchImpl),
    cacheLimit: opts.cacheLimit ?? 200,
    info: opts.clientInfo ?? { version: '0.0.0', standalone: false, platform: 'web' },
    rnd: opts.backoff?.random ?? Math.random,
    baseMs: opts.backoff?.baseMs ?? 1000,
    maxMs: opts.backoff?.maxMs ?? 30_000,
    voiceRetryMs: opts.voiceRetryMs ?? 10_000,
    store,
    meta,
    set: (fn: (s: ClientState) => Partial<ClientState>) => store.setState((s) => ({ ...s, ...fn(s) })),
    setMeta: (p: Partial<ConnectionMeta>) => meta.setState((m) => ({ ...m, ...p })),
    listeners: new Map(),
    pending: new Map(),
    historyWaiters: new Map(),
    historyAsked: new Map(),
    historyErrors: new Map(),
    configWaiters,
    contextRequests: new Set(),
    historyGen: new Map(),
    latestRequests: new Set(),
    queueKeptAt: new Map(),
    entryLocks: new Map(),
    discarding: new Set(),
    writtenOn: new Map(),
    uploadFailures: new Map(),
    inboxInFlight: new Map(),
    mediaFetchIds: new Map(),
    lostIds: new Set(),
    clockOffset: 0,
    resetGen: 0,
    key: null,
    ws: null,
    ready: false,
    closed: false,
    epoch: 0,
    started: false,
    attempt: 0,
    retryTimer: null,
    pingTimer: null,
    lastPong: 0,
    pongs: 0,
    voiceRetryTimer: null,
    outbox: [],
    outboxOrder: 0,
    inboxQueue: new Map(),
    voiceQueue: [],
    flushing: false,
    flushAgain: false,
    connection: 0,
    round: 0,
    saveTimer: null,
    probing: false,
    wakeTimer: null,
    lastReportAt: 0,
  } as unknown as SocketCtx
  c.signedTs = () => new Date(c.now() + c.clockOffset).toISOString()
  c.settleConfig = (id, err) => {
    const w = configWaiters.get(id)
    if (!w) return false
    clearTimeout(w.timer)
    configWaiters.delete(id)
    if (err) w.reject(err)
    else w.resolve()
    return true
  }
  return c
}
