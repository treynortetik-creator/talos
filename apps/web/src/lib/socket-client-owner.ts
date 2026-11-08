// The client methods for the owner acting on what the agent sent: cards, config, inbox, read marks, history, step-up.

import { startAuthentication } from '@simplewebauthn/browser'
import { newUlid, ownValue, routes, signOwnerFrame } from '@talos-app/protocol'
import { type CardResolveInput, TalosClientError } from './client.ts'
import { PasskeyUnavailableError, passkeyBlock, shellPasskeyDeclined } from './passkeyGate.ts'
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
  | 'stepup'
  | 'signOwnerFrame'
> {
  const { configWaiters, http, pending, set, settleConfig, signedTs, store } = c
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
        await c.sendAndWait({
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
      if ((ownValue(store.getState().unread, threadId) ?? 0) === 0) return true
      set((s) => ({
        unread: { ...s.unread, [threadId]: 0 },
        ...(s.readUpto
          ? { readUpto: { ...s.readUpto, [threadId]: Math.max(ownValue(s.readUpto, threadId) ?? 0, upToSeq) } }
          : {}),
      }))
      c.send({ type: 'thread.read', thread_id: threadId, up_to_seq: upToSeq })
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
      const k = await c.ensureKey()
      return signOwnerFrame({ ...frame, device_id: k.deviceId }, k.privateKey)
    },
  }
}
