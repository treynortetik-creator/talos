// The client methods for the owner acting on what the agent sent: cards, config, inbox, read marks, history.

import { newUlid, ownValue, signOwnerFrame } from '@talos-app/protocol'
import { type CardResolveInput, TalosClientError } from './client.ts'
import { APP_REQUEST_SETTLE_MS, CONFIG_APPLY_MS, HISTORY_PAGE, REQUEST_TIMEOUT_MS } from './socket-constants.ts'
import type { SocketCtx } from './socket-ctx.ts'
import type { SocketClient } from './socket-types.ts'

export function createClientOwner(
  c: SocketCtx,
): Pick<
  SocketClient,
  | 'sendOwnerFrame'
  | 'sendAppRequest'
  | 'resolveCard'
  | 'patchConfig'
  | 'updateInbox'
  | 'markThreadUnread'
  | 'markThreadRead'
  | 'loadHistory'
  | 'uploadMedia'
  | 'signOwnerFrame'
> {
  const { configWaiters, pending, set, settleConfig, signedTs, store } = c
  return {
    // CC-C3: session.control. Never queued (the bridge refuses a stale control anyway).
    async sendOwnerFrame(frame) {
      await c.sendAndWait(frame)
    },
    // MCP Apps: the answer is an `app.response` frame, so this only waits for the relay to take the request.
    async sendAppRequest(frame) {
      if (!c.canSend()) throw new TalosClientError('mac_offline', "You're offline.")
      const k = await c.ensureKey()
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
          c.ws?.send(JSON.stringify(signed))
        } catch {
          clearTimeout(timer)
          pending.delete(id)
          reject(new TalosClientError('mac_offline', "You're offline."))
        }
      })
    },
    async resolveCard(cardId, input: CardResolveInput) {
      await c.sendAndWait({
        type: 'card.resolve',
        card_id: cardId,
        action: input.action,
        payload_hash: input.payloadHash,
        ...(input.edited ? { edited: input.edited } : {}),
        ...(input.editedHash ? { edited_hash: input.editedHash } : {}),
        ...(input.note ? { note: input.note } : {}),
        ...(input.choice !== undefined ? { choice: input.choice } : {}),
        ...(input.text !== undefined ? { text: input.text } : {}),
        // signed with the rest: only the owner's own tap can always-allow a kind
        ...(input.always ? { always: true } : {}),
        // signed with the rest: only the owner's own tap can allow a kind of call for the session
        ...(input.session ? { session: true, ...(input.sessionHash ? { session_hash: input.sessionHash } : {}) } : {}),
      })
    },
    async patchConfig(patch) {
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
        await c.sendAndWait({
          id,
          type: 'config.patch',
          base_rev: cfg.rev,
          patch,
        })
      } catch (e) {
        settleConfig(id, e instanceof TalosClientError ? e : new TalosClientError('internal', String(e)))
        throw e
      }
      await applied
    },
    async updateInbox(eventId, patch) {
      // What the row holds now, kept until the relay answers: a refused change goes back to it. With a change already
      // queued for this item the older note stands (it is what the relay last held).
      const row = store.getState().inbox.find((i) => i.id === eventId)
      if (row && !c.inboxQueue.has(eventId))
        c.inboxBefore.set(eventId, {
          state: row.state,
          ...(row.snooze_until ? { snooze_until: row.snooze_until } : {}),
        })
      c.applyInboxPatch(eventId, patch)
      // Queued, not fire-and-forget: offline, the change would show as done and then revert at the next `ready`.
      c.inboxQueue.set(eventId, { ...patch })
      c.saveInboxQueue()
      c.flushInbox()
    },
    markThreadUnread(threadId) {
      if (!c.canSend() || !store.getState().devicePinned) return false
      // Shown at once; the relay's `thread.unread` answer then sets the exact count and mark.
      set((s) => ({ unread: { ...s.unread, [threadId]: Math.max(1, ownValue(s.unread, threadId) ?? 0) } }))
      c.send({ type: 'thread.unread', thread_id: threadId })
      return true
    },
    markThreadRead(threadId, upToSeq, opts) {
      if (opts?.needConnection && (!c.canSend() || !store.getState().devicePinned)) return false
      const before = store.getState()
      const cleared = ownValue(before.unread, threadId) ?? 0
      if (cleared === 0) return true
      // The relay's mark as this device knows it, before it is raised here: what the next `ready` is checked against.
      const known = before.readUpto ? (ownValue(before.readUpto, threadId) ?? 0) : undefined
      set((s) => ({
        unread: { ...s.unread, [threadId]: 0 },
        ...(s.readUpto
          ? { readUpto: { ...s.readUpto, [threadId]: Math.max(ownValue(s.readUpto, threadId) ?? 0, upToSeq) } }
          : {}),
      }))
      c.forgetUnreadSeqs(threadId, upToSeq)
      // Queued, not fire-and-forget: with the socket down the mark would never reach the relay, and its next `ready`
      // would put the count back on a thread the owner has read.
      c.queueRead(threadId, upToSeq, cleared, known)
      return true
    },
    async loadHistory(threadId, beforeSeq) {
      if (!c.canSend() || !store.getState().devicePinned) return { hasMore: false, unavailable: 'mac_offline' as const }
      const gen = c.resetGen
      const page = await c.requestHistory(
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
      if (gen !== c.resetGen) return { hasMore: true, stale: true as const }
      return { hasMore: page.has_more, ...(page.unavailable ? { unavailable: page.unavailable } : {}) }
    },
    uploadMedia: c.uploadMediaNow,
    async signOwnerFrame(frame) {
      const k = await c.ensureKey()
      return signOwnerFrame({ ...frame, device_id: k.deviceId }, k.privateKey)
    },
  }
}
