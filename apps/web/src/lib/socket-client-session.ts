// The client methods that start, stop and re-enroll it.
import { type ClientState, NoAnswerError, TalosClientError } from './client.ts'
import { deleteDeviceKey, loadDeviceKey } from './deviceKey.ts'
import { prewarmPasskeyGate } from './passkeyGate.ts'
import { ACTIVITY_EVENTS, SNAPSHOT } from './socket-constants.ts'
import type { SocketCtx } from './socket-ctx.ts'
import { pickSnapshot } from './socket-state.ts'
import type { OutboxEntry, SocketClient } from './socket-types.ts'

export function createClientSession(
  c: SocketCtx,
): Pick<SocketClient, 'start' | 'ensureDevice' | 'deviceKey' | 'setPinned' | 'reconnect' | 'close'> {
  const { WS, configWaiters, isOnline, queueKeptAt, set, setMeta, settleConfig, storage, uploadFailures, writtenOn } = c
  return {
    async start(o) {
      if (c.started) {
        // Called again after a re-login: the socket that an auth close (4401/4403) ended is not coming back by itself.
        if (!c.closed && c.key && !c.ws) {
          if (c.retryTimer) clearTimeout(c.retryTimer)
          c.retryTimer = null
          c.attempt = 0
          setMeta({ authFailed: false, authReason: null })
          if (o?.pinned !== undefined) set(() => ({ devicePinned: o.pinned as boolean }))
          c.connect()
        }
        return
      }
      c.started = true
      c.closed = false
      try {
        const snap = await storage.get<Partial<ClientState>>('cache', SNAPSHOT)
        if (snap && !c.closed) set(() => ({ ...pickSnapshot(snap), connection: 'connecting' }))
      } catch {}
      try {
        c.key = await loadDeviceKey(storage)
        await c.loadOutbox(c.key?.deviceId)
      } catch (e) {
        c.started = false // storage failed: a later start() must try again, not return early
        throw e
      }
      // close() ran while those awaits were pending (sign-out, 401): do not bring listeners or a socket back.
      if (c.closed) return
      set(() => ({ deviceId: c.key?.deviceId ?? null, ...(o?.pinned !== undefined ? { devicePinned: o.pinned } : {}) }))
      if (typeof window !== 'undefined') {
        window.addEventListener('online', c.onOnline)
        window.addEventListener('offline', c.onOffline)
        document.addEventListener('visibilitychange', c.onVisibility)
        window.addEventListener('pagehide', c.onPageHide)
        document.addEventListener('visibilitychange', c.onHiddenFlush)
        for (const ev of ACTIVITY_EVENTS) window.addEventListener(ev, c.onActivity, { passive: true, capture: true })
      }
      if (!isOnline()) setMeta({ networkOffline: true })
      c.connect()
      prewarmPasskeyGate() // so the first Approve tap does not wait on the AASA lookup before the passkey prompt
    },
    async ensureDevice(opts) {
      if (opts?.replace) {
        // A replaced key means the old one was revoked: what it signed or queued is never sent, whatever else happened first.
        // Count what is waiting in storage (this client may not have started and loaded it yet) so the owner can be told.
        const waiting =
          (await storage.all<OutboxEntry>('outbox').catch(() => [] as OutboxEntry[])).filter(
            (x) => x.kind !== 'voice.ask',
          ).length + (await storage.all('blobs').catch(() => [])).length
        await deleteDeviceKey(storage)
        c.key = null
        c.outbox = []
        c.voiceQueue = []
        // A failed wipe is not swallowed: the old key's queue must not stay behind to be loaded by the next start.
        await storage.clear('outbox')
        await storage.clear('blobs')
        c.refreshQueued()
        if (waiting > 0) c.noticeRemoved(waiting)
      }
      return c.ensureKey()
    },
    async deviceKey() {
      c.key ??= await loadDeviceKey(storage)
      return c.key
    },
    setPinned(pinned) {
      set(() => ({ devicePinned: pinned }))
      if (pinned) {
        void c.flushOutbox()
        c.flushMediaFetches()
      }
    },

    reconnect() {
      if (c.closed) return
      if (c.retryTimer) clearTimeout(c.retryTimer)
      c.retryTimer = null
      c.attempt = 0
      if (c.ws && c.ws.readyState !== WS?.CLOSED) {
        try {
          c.ws.close()
        } catch {}
        c.ws = null
      }
      c.connect()
    },
    close(closeOpts) {
      c.closed = true
      queueKeptAt.set(c.epoch, closeOpts?.keepQueue === true)
      c.epoch++
      c.started = false
      // The key is re-read from storage by the next start() or deviceKey(): a caller that deleted it (revoke) must not
      // see this stale copy, and a 401 flag from the session that just ended must not outlive it.
      c.key = null
      setMeta({ authFailed: false, authReason: null })
      if (c.retryTimer) clearTimeout(c.retryTimer)
      // A snapshot still waiting to be written must not land after a sign-out has emptied the cache.
      if (c.saveTimer) clearTimeout(c.saveTimer)
      c.saveTimer = null
      c.stopPing()
      if (c.wakeTimer) clearTimeout(c.wakeTimer)
      if (c.voiceRetryTimer) clearTimeout(c.voiceRetryTimer)
      c.voiceRetryTimer = null
      uploadFailures.clear()
      writtenOn.clear()
      c.rejectAllPending(new NoAnswerError('internal', 'Closed'))
      for (const id of [...configWaiters.keys()]) settleConfig(id, new TalosClientError('internal', 'Closed'))
      if (typeof window !== 'undefined') {
        window.removeEventListener('online', c.onOnline)
        window.removeEventListener('offline', c.onOffline)
        document.removeEventListener('visibilitychange', c.onVisibility)
        window.removeEventListener('pagehide', c.onPageHide)
        document.removeEventListener('visibilitychange', c.onHiddenFlush)
        for (const ev of ACTIVITY_EVENTS) window.removeEventListener(ev, c.onActivity, { capture: true })
      }
      const s = c.ws
      c.ws = null
      s?.close()
    },
  }
}
