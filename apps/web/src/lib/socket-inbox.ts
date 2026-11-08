// The inbox change queue: Done/Snooze changes kept until the relay acks them, and sent again on each `ready`.

import { type InboxItemT, newUlid } from '@talos-app/protocol'
import { INBOX_QUEUE } from './socket-constants.ts'
import type { SocketCtx } from './socket-ctx.ts'
import type { InboxPatch } from './socket-types.ts'

export function createSocketInbox(c: SocketCtx) {
  const { inboxInFlight, now, set, storage } = c

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
  /** Sends every queued inbox change; an entry leaves the queue when the relay acks it or answers with any error but `internal`. */
  function flushInbox() {
    if (!c.canSend()) return
    for (const [eventId, patch] of c.inboxQueue) {
      if ([...inboxInFlight.values()].some((f) => f.patch === patch)) continue // already on the wire
      const id = newUlid()
      inboxInFlight.set(id, { eventId, patch })
      c.ws?.send(
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
    if (!keep && c.inboxQueue.get(f.eventId) === f.patch) {
      c.inboxQueue.delete(f.eventId)
      saveInboxQueue()
    }
    return true
  }

  c.applyInboxPatch = applyInboxPatch
  c.flushInbox = flushInbox
  c.inboxSettled = inboxSettled
  c.saveInboxQueue = saveInboxQueue
}
