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
  InboxItemT,
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
import { DIAL_GIVE_UP_MS, HANDSHAKE_GIVE_UP_MS, INBOX_ANSWER_GRACE_MS, WAKE_PROBE_MS } from './socket-constants.ts'
import type {
  InboxOutcome,
  InboxPatch,
  OutboxEntry,
  OutboxKind,
  Pending,
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
  flushRetryMs: number
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
  wipeListeners: Set<() => void>
  /**
   * Inbox changes sent and not yet answered (frame id -> change), with the socket each went out on. An entry stays
   * while its socket can still deliver the answer, so a reconnect does not send the change a second time.
   */
  inboxInFlight: Map<string, { eventId: string; patch: InboxPatch; sock: WebSocket | null }>
  /**
   * Signed `media.fetch` frames sent (frame id -> media id), so the Mac's refusal of one is not shown as a failed message
   * and can tell the file's chip at once that it will not come.
   */
  mediaFetchIds: Map<string, string>
  /** Message ids the relay reported as never taken by the Mac (receipt `not_delivered`, or `ready.not_delivered`). */
  lostIds: Set<string>
  /**
   * Messages the relay acked on this run (frame id -> its row), newest last, at most ACKED_REFS_MAX. The
   * signed frame is dropped at the ack, so this is the only way a later refusal by the Mac (`error{ref}`) finds its row.
   */
  ackedRefs: Map<string, { clientMsgId: string; threadId: string }>

  /**
   * The relay's clock minus ours, learned from each `ready`. Owner frames are signed with the corrected time, so a phone
   * clock minutes off still lands inside the Mac's read window (now + 2 min / now - 5 min). Under 30 s is round-trip noise
   * and ignored; the offset is clamped to an hour (MAX_CLOCK_OFFSET_MS).
   */
  clockOffset: number
  resetGen: number
  /**
   * Catch-up paging. `open` from a page that says more are coming until the page that says none are (or the next `ready`).
   * A seq that arrives outside those pages meanwhile (a live frame, a newest-history page) sits above pages not fetched
   * yet, so it waits in `held` and `lastSeq` stays at the last page: a drop mid-way then resumes from there.
   */
  seqHold: { open: boolean; held: number }
  key: DeviceKey | null
  ws: WebSocket | null
  ready: boolean
  closed: boolean
  epoch: number
  started: boolean
  attempt: number
  /** Until this time (ms) a relay restart (close 1012) is being waited out: retries use a short fixed delay. 0 = not in one. */
  restartUntil: number
  retryTimer: ReturnType<typeof setTimeout> | null
  pingTimer: ReturnType<typeof setInterval> | null
  lastPong: number
  pongs: number
  flushRetryTimer: ReturnType<typeof setTimeout> | null
  outbox: OutboxEntry[]
  outboxOrder: number
  inboxQueue: Map<string, InboxPatch>
  /** What an inbox row held before the changes still queued for it, so a change the relay refuses can be taken back. */
  inboxBefore: Map<string, { state: InboxItemT['state']; snooze_until?: string }>
  /**
   * Read marks made while the socket could not carry them, per thread: how far the owner read, and how many unread the
   * mark cleared here, and the relay's mark as this device knew it before. Sent at the next `ready` (once this device
   * is pinned) unless the relay's mark has moved since; the relay's count in that `ready` predates them.
   */
  readQueue: Map<string, { upTo: number; cleared: number; known?: number }>
  /** Per thread, the seqs of the rows this device counted (or would count) as unread, for a read mark that stops short. */
  unreadSeqs: Map<string, Set<number>>
  flushing: boolean
  flushAgain: boolean
  connection: number
  saveTimer: ReturnType<typeof setTimeout> | null
  probing: boolean
  /** The probe of the live socket (a ping asked, its pong not yet back): while set, a new trigger joins it instead of asking again. */
  wakeTimer: ReturnType<typeof setTimeout> | null
  /** The nonce the pending probe's pong must carry. Null when no probe is pending. */
  probeNonce: string | null
  /** Starts over the reconnect backoff when this socket has stayed up STABLE_MS. */
  stableTimer: ReturnType<typeof setTimeout> | null
  /** The nonce and send time of the latest keepalive ping, and the send and arrival time of the last one answered. */
  keepaliveNonce: string | null
  keepaliveSentAt: number
  answeredPingAt: number
  answeredAt: number
  /** How long the page-back probe waits for its pong (WAKE_PROBE_MS; shorter in tests). */
  wakeProbeMs: number
  /** How long a dial may take from the start to `ready` before the client gives up on it (HANDSHAKE_GIVE_UP_MS; shorter in tests). */
  handshakeGiveUpMs: number
  /** How long a dial must have run before a page-back trigger may replace it (DIAL_GIVE_UP_MS). */
  dialGiveUpMs: number
  /** The handshake timer of the current dial: from the dial start until `ready`, cleared by every way the socket ends. */
  dialTimer: ReturnType<typeof setTimeout> | null
  /** The relay's ping interval for this link (ms): a link that answered within 2.5 of them is alive (the keepalive's own measure). */
  pingMs: number
  /** When a trigger last dialled at once with no socket (ms): coming back to the page does it at most once per EAGER_DIAL_MS. */
  lastEagerDialAt: number
  /** When the current socket was dialled (ms): a dial that is still not up after the probe window is replaced on a trigger. */
  dialAt: number
  inboxAnswerGraceMs: number
  /** Ends the inbox changes' wait on sockets let go of (client.close()). */
  inboxForget: () => void
  lastReportAt: number
  /**
   * Where the last pointermove was on the screen. A pointermove at the same spot is not a person: Chromium fires one when the
   * page reflows under a cursor that has not moved (new messages, a card appearing). Null until one is seen, and again
   * after the page was hidden.
   */
  lastPointer: { x: number; y: number } | null
  client: SocketClient

  // socket-state.ts
  emit: (type: string, frame: Record<string, unknown>, meta?: { catchup?: boolean }) => void
  rowsOf: (messages: Record<string, MessageT[]>, threadId: string) => MessageT[]
  upsertMessage: (m: MessageT) => void
  patchMessage: (id: string, fn: (m: MessageT) => MessageT) => void
  upsertCard: (card: CardT) => void
  withSeq: (m: MessageT, frame: { relay?: { seq: number } }) => MessageT
  bumpSeq: (frame: { relay?: { seq: number } }) => void
  advanceSeq: (seq: number) => void
  holdSeq: (open: boolean) => void
  bumpUnread: (threadId: string, seq?: number) => void
  noteUnreadSeq: (threadId: string, seq: number | undefined) => void
  forgetUnreadSeqs: (threadId: string, upTo: number) => number
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
  inboxSettled: (frameId: string, outcome?: InboxOutcome) => boolean
  inboxSocketGone: (sock: WebSocket | null) => void
  inboxSocketClosed: (sock: WebSocket) => void
  /** Lets go of `sock`, keeping it open while inbox changes sent on it wait for their answer; false: close it now. */
  inboxLetGo: (sock: WebSocket | null) => boolean
  /** A frame on a socket that was let go of: only an answer to an inbox change sent there is read. */
  inboxAnswerOnOld: (sock: WebSocket, frame: Frame) => void
  queueRead: (threadId: string, upTo: number, cleared: number, known: number | undefined) => void
  flushReads: () => void
  /** After a `ready` is applied: squares the read marks still waiting with the relay's counts, then sends them. */
  readsOnReady: (frame: FrameOf<'ready'>) => void
  // socket-outbox-queue.ts
  loadOutbox: (deviceId?: string) => Promise<void>
  noticeRemoved: (n: number) => void
  dropFromOutbox: (frameId: string) => Promise<void>
  onAcked: (frameId: string) => Promise<void>
  withEntryLock: <T>(clientMsgId: string, fn: () => Promise<T>) => Promise<T>
  signedAtOf: (bytes: string) => number
  markWritten: (e: OutboxEntry, began: number) => Promise<OutboxEntry>
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
  socketGone: (sock: WebSocket | null) => void
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
    answer:
      | 'memory.listing'
      | 'memory.file'
      | 'memory.results'
      | 'memory.graph_result'
      | 'speak.result'
      | 'fs.listing'
      | 'files.listing'
      | 'files.file'
      | 'bug.context_result'
      | 'agents_md.file'
      | 'files.put_result'
      | 'files.sent_list'
      | 'memory.folders_result',
    timeoutMs?: number,
  ) => Promise<Record<string, unknown>>
  // socket-upload.ts
  uploadMediaNow: (blob: Blob, m: UploadMeta) => Promise<AttachmentRefT>
  // socket-lifecycle.ts
  onOnline: () => void
  onOffline: () => void
  onVisibility: () => void
  onActivity: (e?: Event) => void
  onFocus: () => void
  onPageShow: (e?: Event) => void
  /** Ends the probe and the stable timer of the socket that is going (socket-connection.ts). */
  clearLinkTimers: () => void
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
    flushRetryMs: opts.flushRetryMs ?? 10_000,
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
    wipeListeners: new Set(),
    inboxInFlight: new Map(),
    mediaFetchIds: new Map(),
    lostIds: new Set(),
    ackedRefs: new Map(),
    clockOffset: 0,
    resetGen: 0,
    seqHold: { open: false, held: 0 },
    key: null,
    ws: null,
    ready: false,
    closed: false,
    epoch: 0,
    started: false,
    attempt: 0,
    restartUntil: 0,
    retryTimer: null,
    pingTimer: null,
    lastPong: 0,
    pongs: 0,
    flushRetryTimer: null,
    outbox: [],
    outboxOrder: 0,
    inboxQueue: new Map(),
    inboxBefore: new Map(),
    readQueue: new Map(),
    unreadSeqs: new Map(),
    flushing: false,
    flushAgain: false,
    connection: 0,
    saveTimer: null,
    probing: false,
    wakeTimer: null,
    probeNonce: null,
    stableTimer: null,
    dialAt: 0,
    pingMs: 25_000,
    keepaliveNonce: null,
    keepaliveSentAt: 0,
    answeredPingAt: 0,
    answeredAt: 0,
    wakeProbeMs: opts.wakeProbeMs ?? WAKE_PROBE_MS,
    handshakeGiveUpMs: opts.handshakeGiveUpMs ?? HANDSHAKE_GIVE_UP_MS,
    dialGiveUpMs: opts.dialGiveUpMs ?? DIAL_GIVE_UP_MS,
    dialTimer: null,
    lastEagerDialAt: 0,
    inboxAnswerGraceMs: opts.inboxAnswerGraceMs ?? INBOX_ANSWER_GRACE_MS,
    lastReportAt: 0,
    lastPointer: null,
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
