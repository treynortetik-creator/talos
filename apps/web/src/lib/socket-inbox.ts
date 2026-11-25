// What the owner did that the relay must hear even when the socket was down at the time. The inbox change queue:
// Done/Snooze changes kept until the relay acks them, sent again on each `ready`, and taken back off the row when the
// relay refuses one. And the read marks: a thread read while the socket could not carry it, sent at the next `ready`.

import { type Frame, type FrameOf, type InboxItemT, newUlid, ownValue } from '@talos-app/protocol'
import { INBOX_QUEUE } from './socket-constants.ts'
import type { SocketCtx } from './socket-ctx.ts'
import type { InboxOutcome, InboxPatch } from './socket-types.ts'

export function createSocketInbox(c: SocketCtx) {
  const { inboxInFlight, now, set, storage, store } = c

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
    void storage.put('cache', INBOX_QUEUE, [...c.inboxQueue]).catch(() => {})
  }
  /**
   * Sends every queued inbox change that is not on the wire; an entry leaves the queue when the relay acks it or answers
   * with any error but `internal`. A change sent on a socket that was let go of counts as on the wire until that socket
   * has closed (or its grace is over): the answer may still be on its way there, and a second send would race it.
   */
  function flushInbox() {
    if (!c.canSend() || !c.ws) return
    const sock = c.ws
    for (const [eventId, patch] of c.inboxQueue) {
      if ([...inboxInFlight.values()].some((f) => f.patch === patch)) continue // already on the wire
      const id = newUlid()
      inboxInFlight.set(id, { eventId, patch, sock })
      sock.send(
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
  /**
   * Puts a row back to what it held before a change the relay refused. Only while the row still shows that change: one
   * that another device (or the Mac) has moved on since is left alone. After a reload the earlier state is not known,
   * and the row then waits for the next inbox load to correct it.
   */
  function takeBack(eventId: string, patch: InboxPatch) {
    const before = c.inboxBefore.get(eventId)
    if (!before) return
    set((st) => ({
      inbox: st.inbox.map((i): InboxItemT => {
        if (i.id !== eventId) return i
        if (patch.state && i.state !== patch.state) return i
        if (patch.snoozeUntil && i.snooze_until !== patch.snoozeUntil) return i
        const { snooze_until: _was, ...rest } = i
        return { ...rest, state: before.state, ...(before.snooze_until ? { snooze_until: before.snooze_until } : {}) }
      }),
    }))
  }
  /**
   * The relay answered a queued change. `retry`: it could not save it (worth another try), so the change stays queued
   * and goes out at the next flush. `refused`: it will never apply, so it leaves the queue and the row goes back.
   */
  function inboxSettled(frameId: string, outcome: InboxOutcome = 'acked'): boolean {
    const f = inboxInFlight.get(frameId)
    if (!f) return false
    inboxInFlight.delete(frameId)
    settle(f, outcome)
    // A socket kept open for its answers closes once the last one is in.
    if (f.sock !== c.ws && !onWire(f.sock)) {
      const timer = graceTimers.get(f.sock)
      if (timer) clearTimeout(timer)
      graceTimers.delete(f.sock)
      closeKept(f.sock)
    }
    return true
  }
  function settle(f: { eventId: string; patch: InboxPatch; sock: WebSocket | null }, outcome: InboxOutcome) {
    if (outcome === 'retry') {
      // Came on a socket let go of: the current one skipped it while it was on the wire there, so it goes out now. On the
      // current socket it waits for the next connection, not a resend loop.
      if (f.sock !== c.ws) flushInbox()
      return
    }
    // Only the change that was sent leaves the queue: a newer one for the same item stays.
    const newest = c.inboxQueue.get(f.eventId) === f.patch
    if (newest) {
      c.inboxQueue.delete(f.eventId)
      saveInboxQueue()
      if (outcome === 'refused') takeBack(f.eventId, f.patch)
      c.inboxBefore.delete(f.eventId)
    } else if (outcome === 'acked') {
      // A newer change waits on top of this one. The relay now holds this one, so that is what a refusal goes back to.
      const before = c.inboxBefore.get(f.eventId)
      if (before)
        c.inboxBefore.set(f.eventId, {
          state: f.patch.state ?? before.state,
          ...(f.patch.snoozeUntil
            ? { snooze_until: f.patch.snoozeUntil }
            : before.snooze_until
              ? { snooze_until: before.snooze_until }
              : {}),
        })
    }
  }

  /**
   * Changes sent on `sock` will not be answered now (it closed, or its grace is over): they go out again on the current
   * socket, once. A socket kept open for them is closed.
   */
  function releaseSocket(sock: WebSocket | null) {
    const timer = graceTimers.get(sock)
    if (timer) clearTimeout(timer)
    graceTimers.delete(sock)
    let released = false
    for (const [id, f] of inboxInFlight)
      if (f.sock === sock) {
        inboxInFlight.delete(id)
        released = true
      }
    closeKept(sock)
    if (released) flushInbox()
  }
  const onWire = (sock: WebSocket | null) => [...inboxInFlight.values()].some((f) => f.sock === sock)
  /** Sockets let go of but left open: inbox changes sent on them still wait for their answer there. */
  const keptOpen = new Set<WebSocket>()
  function closeKept(sock: WebSocket | null) {
    if (!sock || !keptOpen.delete(sock)) return
    try {
      sock.close()
    } catch {}
  }
  /**
   * `sock` stops being the current socket. While inbox changes sent on it are unanswered it is left open: a WebSocket
   * fires no message once close() is called, so closing it now would drop their answers, and each change would go out a
   * second time. It closes when the last one is answered, or when the grace ends (then they go out again, once). If the
   * relay or the network closes it first, its close event sends them again, once. False: nothing waits on it, close it.
   */
  function inboxLetGo(sock: WebSocket | null): boolean {
    if (!sock || !onWire(sock)) return false
    keptOpen.add(sock)
    inboxSocketGone(sock)
    return true
  }
  /** A frame on a socket let go of: only an answer to an inbox change sent there counts; the rest is the old link's. */
  function inboxAnswerOnOld(sock: WebSocket, frame: Frame) {
    if (frame.type !== 'ack' && frame.type !== 'error') return
    const ref = frame.ref
    if (typeof ref !== 'string' || inboxInFlight.get(ref)?.sock !== sock) return
    inboxSettled(ref, frame.type === 'ack' ? 'acked' : frame.code === 'internal' ? 'retry' : 'refused')
  }
  /**
   * `sock` is no longer the current socket. What was sent on it stays on the wire until it closes: frames the relay sent
   * before its close still arrive, an answer among them. A socket that never reports its close is given up after a
   * grace.
   */
  function inboxSocketGone(sock: WebSocket | null) {
    if (graceTimers.has(sock) || ![...inboxInFlight.values()].some((f) => f.sock === sock)) return
    graceTimers.set(
      sock,
      setTimeout(() => releaseSocket(sock), c.inboxAnswerGraceMs),
    )
  }
  const graceTimers = new Map<WebSocket | null, ReturnType<typeof setTimeout>>()
  function inboxForget() {
    for (const t of graceTimers.values()) clearTimeout(t)
    graceTimers.clear()
    inboxInFlight.clear()
    for (const s of [...keptOpen]) closeKept(s)
  }

  // ---- read marks ----------------------------------------------------------------------------------------------
  /**
   * Sends every waiting read mark. The relay does not answer one, and refuses an unpinned device's frames, so a mark
   * waits here until the Mac has pinned this device: sent before that it would be lost with nothing to say so.
   */
  function flushReads() {
    if (!c.canSend() || !store.getState().devicePinned) return
    for (const [threadId, q] of c.readQueue) c.send({ type: 'thread.read', thread_id: threadId, up_to_seq: q.upTo })
    c.readQueue.clear()
  }
  /**
   * The owner read `threadId` up to `upTo`, which cleared `cleared` unread here. `known` is the relay's mark for the
   * thread as this device last knew it, before this read (absent with an older relay). Goes out now, or at the next
   * `ready`.
   */
  function queueRead(threadId: string, upTo: number, cleared: number, known: number | undefined) {
    const q = c.readQueue.get(threadId)
    c.readQueue.set(threadId, {
      upTo: Math.max(q?.upTo ?? 0, upTo),
      cleared: (q?.cleared ?? 0) + Math.max(0, cleared),
      // the first read's: later ones saw this device's own, raised, mark
      ...(q ? (q.known !== undefined ? { known: q.known } : {}) : known !== undefined ? { known } : {}),
    })
    flushReads()
  }
  /**
   * The `ready` just applied gave the relay's counts and marks, from before it heard the marks still waiting here.
   *
   * A waiting mark is sent only when the relay's mark for the thread is exactly where this device last knew it: then
   * nobody else has spoken, the relay's count still holds the rows the owner read here, so those come off (what is
   * left arrived meanwhile) and the mark goes out. When the relay's mark has moved at all, another device spoke after
   * this one knew it, and the waiting mark is dropped with the relay's count and mark left as `ready` gave them:
   *  - at or past this mark: it read as far or further, nothing to add;
   *  - anywhere else (below what was known, or between that and this mark): a mark-unread puts the relay's mark just
   *    under the thread's newest row, which can be either side of what this device knew. Sending the read then would
   *    raise the mark and clear the unread the owner asked for on the other device. A partial read from another device
   *    looks the same and is treated the same; the cost is that the rows read here show as unread until the thread is
   *    opened again, and the relay's count, which other devices share, is never made wrong.
   * An older relay sends no marks: the mark is sent, as it always was when online.
   */
  function readsOnReady(frame: FrameOf<'ready'>) {
    // An unpinned device gets the handshake part of `ready` only (no counts, no marks): nothing to square yet.
    if (!store.getState().devicePinned) return
    for (const [threadId, q] of [...c.readQueue]) {
      const held = frame.read_upto ? (ownValue(frame.read_upto, threadId) ?? 0) : undefined
      if (held !== undefined && held !== (q.known ?? 0)) {
        c.readQueue.delete(threadId)
        continue
      }
      const theirs = frame.unread ? (ownValue(frame.unread, threadId) ?? 0) : undefined
      set((s) => ({
        ...(theirs !== undefined ? { unread: { ...s.unread, [threadId]: Math.max(0, theirs - q.cleared) } } : {}),
        ...(s.readUpto
          ? { readUpto: { ...s.readUpto, [threadId]: Math.max(ownValue(s.readUpto, threadId) ?? 0, q.upTo) } }
          : {}),
      }))
    }
    flushReads()
  }

  c.applyInboxPatch = applyInboxPatch
  c.flushInbox = flushInbox
  c.inboxSettled = inboxSettled
  c.inboxSocketGone = inboxSocketGone
  c.inboxSocketClosed = releaseSocket
  c.inboxLetGo = inboxLetGo
  c.inboxAnswerOnOld = inboxAnswerOnOld
  c.inboxForget = inboxForget
  c.saveInboxQueue = saveInboxQueue
  c.queueRead = queueRead
  c.flushReads = flushReads
  c.readsOnReady = readsOnReady
}
