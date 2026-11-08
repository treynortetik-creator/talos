// Request and answer over the socket: signed history reads, media fetches, and the signed frames that wait for an ack or an answer.

import { type FrameOf, newUlid, signOwnerFrame } from '@talos-app/protocol'
import { NoAnswerError, NotSentError, TalosClientError } from './client.ts'
import { REQUEST_TIMEOUT_MS } from './socket-constants.ts'
import type { SocketCtx } from './socket-ctx.ts'

export function createSocketRequests(c: SocketCtx) {
  const {
    contextRequests,
    historyAsked,
    historyErrors,
    historyGen,
    historyWaiters,
    latestRequests,
    mediaFetchIds,
    pending,
    signedTs,
    store,
  } = c

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
    if (!c.canSend()) throw new TalosClientError('internal', "You're offline.")
    const k = await c.ensureKey()
    const id = newUlid()
    const rid = String(fields.request_id)
    const signed = await signOwnerFrame(
      { v: 1, id, ts: signedTs(), type: 'history.request', ...fields, device_id: k.deviceId },
      k.privateKey,
    )
    if (keepOutOfTimeline) contextRequests.add(rid)
    else {
      historyGen.set(rid, c.resetGen)
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
      if (!c.canSend()) {
        clearTimeout(timer)
        done()
        reject(new TalosClientError('internal', "You're offline."))
        return
      }
      c.ws?.send(JSON.stringify(signed))
    })
  }

  /** Files asked for while the socket was not ready: sent once it is (`flushMediaFetches`). */
  const pendingMediaFetch = new Set<string>()
  function flushMediaFetches() {
    if (!c.canSend() || !store.getState().devicePinned) return
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
    if (!c.canSend() || !store.getState().devicePinned) {
      // A chip that mounted from the cached snapshot asks before the socket is up (or the device pin is known). Remember
      // the ask, once per file, and send it when both are true; the chip's own 20 s clock just starts early.
      if (pendingMediaFetch.size < 100) pendingMediaFetch.add(mediaId)
      return
    }
    try {
      const k = await c.ensureKey()
      const id = newUlid()
      const signed = await signOwnerFrame(
        { v: 1, id, ts: signedTs(), type: 'media.fetch', media_id: mediaId, device_id: k.deviceId },
        k.privateKey,
      )
      mediaFetchIds.set(id, mediaId)
      if (mediaFetchIds.size > 500) mediaFetchIds.delete(mediaFetchIds.keys().next().value as string)
      if (c.canSend()) c.ws?.send(JSON.stringify(signed))
    } catch {
      /* no key or a closed socket: the next load error asks again */
    }
  }

  /** Sends a signed frame and waits for ack or error (card.resolve, config.patch: never queued). */
  async function sendAndWait(
    frame: Record<string, unknown>,
    timeoutMs = REQUEST_TIMEOUT_MS,
  ): Promise<number | undefined> {
    if (!c.canSend()) throw new NotSentError('internal', "You're offline.")
    const k = await c.ensureKey()
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
      c.ws?.send(JSON.stringify(signed))
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
    if (!c.canSend()) throw new TalosClientError('mac_offline', "You're offline.")
    const k = await c.ensureKey()
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
      off = c.client.onFrame(answer, (f) => {
        if ((f as Record<string, unknown>).request_id === frame.request_id)
          finish(() => resolve(f as unknown as Record<string, unknown>))
      })
      // an `error{ref: id}` lands on the pending map (see the `error` case in dispatch)
      pending.set(id, { resolve: () => {}, reject: (e) => finish(() => reject(e)), timer })
      c.ws?.send(JSON.stringify(signed))
    })
  }

  c.askRead = askRead
  c.fetchMediaSigned = fetchMediaSigned
  c.flushMediaFetches = flushMediaFetches
  c.requestHistory = requestHistory
  c.sendAndWait = sendAndWait
}
