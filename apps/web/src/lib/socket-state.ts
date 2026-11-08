// Shared state helpers for the socket client: the persisted render cache (snapshot and its debounced save), and the small store writers every other part uses.

import { type AgentConfigT, type CardT, type MessageT, ownValue } from '@talos-app/protocol'
import type { ClientState } from './client.ts'
import { SNAPSHOT } from './socket-constants.ts'
import type { SocketCtx } from './socket-ctx.ts'

export function pickSnapshot(snap: Partial<ClientState>): Partial<ClientState> {
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

export function createSocketState(c: SocketCtx) {
  const { cacheLimit, listeners, meta, set, setMeta, storage, store } = c

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
    if (c.closed || c.saveTimer) return
    c.saveTimer = setTimeout(() => {
      c.saveTimer = null
      if (c.closed) return
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
    if (c.closed || !c.saveTimer) return
    clearTimeout(c.saveTimer)
    c.saveTimer = null
    writeSnapshot(true)
  }
  const onPageHide = () => flushSave()
  const onHiddenFlush = () => {
    if (document.visibilityState === 'hidden') flushSave()
  }
  store.subscribe(scheduleSave)

  // ---- state helpers -------------------------------------------------------------------------------------------
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
      ...c.outbox.filter((e) => e.kind !== 'voice.ask').map((e) => e.clientMsgId),
      ...c.voiceQueue.map((v) => v.clientMsgId),
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

  c.bumpSeq = bumpSeq
  c.bumpUnread = bumpUnread
  c.clearFailed = clearFailed
  c.emit = emit
  c.markFailed = markFailed
  c.onHiddenFlush = onHiddenFlush
  c.onPageHide = onPageHide
  c.patchMessage = patchMessage
  c.refreshQueued = refreshQueued
  c.rowsOf = rowsOf
  c.upsertCard = upsertCard
  c.upsertMessage = upsertMessage
  c.withSeq = withSeq
}
