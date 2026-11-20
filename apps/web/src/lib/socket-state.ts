// Shared state helpers for the socket client: the persisted render cache (snapshot and its debounced save), and the small store writers every other part uses.

import { type AgentConfigT, type CardT, type MessageT, ownValue } from '@talos-app/protocol'
import type { ClientState } from './client.ts'
import { SNAPSHOT, UNREAD_SEQ_THREADS, UNREAD_SEQS_PER_THREAD } from './socket-constants.ts'
import type { SocketCtx } from './socket-ctx.ts'
import { isUpdateNote } from './unknownFrames.ts'

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

/**
 * The parts of a saved render cache this build takes back, each only when it has the shape the screens read it with: a
 * list where a list is mapped over, a keyed object where one is looked up. A cache from another build, or a damaged one,
 * loses the part that is wrong and keeps the rest; the next `ready` and catch-up fill it in again.
 */
export function pickSnapshot(snap: Partial<ClientState>): Partial<ClientState> {
  const out: Partial<ClientState> = {}
  if (!isPlainObject(snap)) return out
  // fromEntries defines own keys, so a thread id such as `__proto__` in the cache cannot reach the prototype.
  if (isPlainObject(snap.messages))
    out.messages = Object.fromEntries(
      Object.entries(snap.messages)
        .filter(([, rows]) => Array.isArray(rows))
        // an update note is about the build that wrote it, not this one (unknownFrames.ts)
        .map(([t, rows]) => [t, (rows as MessageT[]).filter((m) => !isPlainObject(m) || !isUpdateNote(m))]),
    ) as ClientState['messages']
  if (Array.isArray(snap.threads)) out.threads = snap.threads
  if (isPlainObject(snap.config)) out.config = snap.config as AgentConfigT
  if (Array.isArray(snap.cards)) out.cards = snap.cards
  if (Array.isArray(snap.inbox)) out.inbox = snap.inbox
  if (isPlainObject(snap.unread))
    out.unread = Object.fromEntries(
      Object.entries(snap.unread).filter(([, n]) => Number.isInteger(n) && (n as number) >= 0),
    ) as ClientState['unread']
  if (isPlainObject(snap.statuses)) out.statuses = snap.statuses
  if (isPlainObject(snap.appStates)) out.appStates = snap.appStates
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
          // the undo point comes on a receipt or a history row: a copy without one (or with one unreadable) keeps it
          ...(m.undo ? {} : list[i]?.undo ? { undo: list[i]?.undo } : {}),
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
      // a card.create stored before the relay sent its own expiry (an older relay, a catch-up from before) keeps the one
      // this device already has
      const had = i >= 0 ? (s.cards[i] as CardT).relay_expires_at : undefined
      const next = had && !card.relay_expires_at ? { ...card, relay_expires_at: had } : card
      if (i >= 0) cards[i] = next
      else cards.push(next)
      return { cards }
    })
  /** The relay stamps `frame.relay.seq`, not `message.seq`: copy it so the timeline orders and marks read by it. */
  const withSeq = (m: MessageT, frame: { relay?: { seq: number } }): MessageT =>
    m.seq === undefined && frame.relay?.seq !== undefined ? { ...m, seq: frame.relay.seq } : m
  /**
   * `lastSeq` is what the next `hello` says this device has, so it may only move over ground with no hole below it.
   * While catch-up pages are still coming, a seq from anywhere else is above the pages not fetched yet: it is held, and
   * taken when the last page lands. If the link drops first it is forgotten, and the relay sends that frame again.
   */
  const advanceSeq = (seq: number) => {
    if (c.seqHold.open) {
      if (seq > c.seqHold.held) c.seqHold.held = seq
      return
    }
    if (seq > store.getState().lastSeq) set(() => ({ lastSeq: seq }))
  }
  /** `true` when a catch-up page says more follow; `false` at the last page (the held seq counts) and at each `ready`. */
  const holdSeq = (open: boolean) => {
    if (open) {
      c.seqHold.open = true // what is already held stays held through the pages in between
      return
    }
    const held = c.seqHold.held
    c.seqHold = { open: false, held: 0 }
    advanceSeq(held)
  }
  const bumpSeq = (frame: { relay?: { seq: number } }) => {
    const seq = frame.relay?.seq
    if (seq !== undefined) advanceSeq(seq)
  }
  // The rows behind a thread's unread count, by seq, for as long as this page lives. `thread.read` from another device
  // says how far it read; the rows above that are still unread, and this is how they are told apart.
  const noteUnreadSeq = (threadId: string, seq: number | undefined) => {
    // A row at or below the read mark is read already (a catch-up replays those too).
    if (seq === undefined || seq <= (ownValue(store.getState().readUpto ?? {}, threadId) ?? 0)) return
    let seqs = c.unreadSeqs.get(threadId)
    if (!seqs) {
      if (c.unreadSeqs.size >= UNREAD_SEQ_THREADS) return
      seqs = new Set()
      c.unreadSeqs.set(threadId, seqs)
    }
    seqs.add(seq)
    if (seqs.size > UNREAD_SEQS_PER_THREAD) seqs.delete(Math.min(...seqs))
  }
  const forgetUnreadSeqs = (threadId: string, upTo: number): number => {
    const seqs = c.unreadSeqs.get(threadId)
    if (!seqs) return 0
    for (const seq of seqs) if (seq <= upTo) seqs.delete(seq)
    if (seqs.size === 0) c.unreadSeqs.delete(threadId)
    return seqs.size
  }
  const bumpUnread = (threadId: string, seq?: number) => {
    noteUnreadSeq(threadId, seq)
    set((s) => ({ unread: { ...s.unread, [threadId]: (ownValue(s.unread, threadId) ?? 0) + 1 } }))
  }
  const setQueued = (ids: string[]) => setMeta({ queuedIds: ids })
  const refreshQueued = () => setQueued(c.outbox.map((e) => e.clientMsgId))

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

  c.advanceSeq = advanceSeq
  c.bumpSeq = bumpSeq
  c.holdSeq = holdSeq
  c.bumpUnread = bumpUnread
  c.noteUnreadSeq = noteUnreadSeq
  c.forgetUnreadSeqs = forgetUnreadSeqs
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
