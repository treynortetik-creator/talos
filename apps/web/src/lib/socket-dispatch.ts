// Frame dispatch: one parsed relay frame goes to its handler (socket-frames-*.ts), then to the listeners. Also the
// system rows and the stored-owner-frame helper those handlers reach.
import { type AttachmentRefT, type Frame, type MessageT, parseFrame } from '@talos-app/protocol'
import type { SocketCtx } from './socket-ctx.ts'
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
import { createUnknownNotes } from './unknownFrames.ts'

export function createSocketDispatch(c: SocketCtx) {
  const {
    configWaiters,
    contextRequests,
    historyAsked,
    historyErrors,
    historyGen,
    historyWaiters,
    latestRequests,
    lostIds,
    mediaFetchIds,
    now,
    pending,
    set,
    settleConfig,
    store,
  } = c

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
    c.upsertMessage({
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
      if (seq !== undefined) c.patchMessage(id, (m) => ({ ...m, seq }))
      return
    }
    const isVoice = raw.type === 'voice_note'
    c.upsertMessage({
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
    patchMessage: c.patchMessage,
    upsertMessage: c.upsertMessage,
    upsertCard: c.upsertCard,
    withSeq: c.withSeq,
    bumpSeq: c.bumpSeq,
    bumpUnread: c.bumpUnread,
    findMessage,
    clearFailed: c.clearFailed,
    markFailed: c.markFailed,
    addSystemRow,
    emit: c.emit,
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
    inboxSettled: c.inboxSettled,
    onAcked: c.onAcked,
    dropFromOutbox: c.dropFromOutbox,
    flushOutbox: c.flushOutbox,
    dispatch,
    send: c.send,
    isRecord,
    applyStoredOwnerFrame,
    noteUnknown,
    getKey: () => c.key,
    getOutbox: () => c.outbox,
    getResetGen: () => c.resetGen,
    bumpResetGen: () => {
      c.resetGen++
    },
  }

  function dispatch(frame: Frame, isCatchup = false) {
    if (frame.type === 'voice.state' && frame.state === 'ended') void c.dropVoiceAsks()
    applyFrame(frame, isCatchup)
    c.emit(frame.type, frame as unknown as Record<string, unknown>)
  }

  c.addSystemRow = addSystemRow
  c.dispatch = dispatch
  c.noteUnknown = noteUnknown
}
