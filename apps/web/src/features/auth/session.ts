// Who is signed in. `GET /api/me` answers 401 when there is no session.
import type { RouteRes } from '@talos-app/protocol'
import { create } from 'zustand'
import { createHttp, endReasonOf, HttpError } from '../../lib/http.ts'
import { clearNativeGrant } from '../../lib/nativePush.ts'
import type { Storage } from '../../lib/storage.ts'
import { keepsUnsent, sharesStorage } from '../../lib/unsent.ts'
import { resetAgentDraft } from '../agent-config/draftStore.ts'
import { resetComposer } from '../composer/composerStore.ts'
import { forgetNativeChoices } from '../pwa/nativeChoice.ts'
import { clearRecent } from '../search/logic.ts'
import { audioDock } from '../threads/audioDock.ts'
import { resetSpeak } from '../threads/speak.ts'
import { clearThreadDescriptions } from '../threads/threadMeta.ts'

export type Me = RouteRes<'me'> & { vapid_public_key?: string }

export type SessionState = {
  status: 'loading' | 'anon' | 'authed' | 'error'
  me: Me | null
  /** True when `me` is the cached copy because /api/me could not be reached (offline or the server is down). */
  offline: boolean
  /**
   * Re-reads /api/me. With a `storage`, the last good answer is kept and used when the network is down. `stopClient`
   * runs before the 401 wipe so nothing can write the cache back.
   */
  refresh(storage?: Storage, stopClient?: (opts: { keepQueue: boolean }) => void): Promise<SessionState['status']>
  setAnon(): void
}

const http = createHttp()

// Everything the app keeps about the owner's conversations. NOT 'keys': the device key is what lets a signed-out device
// sign back in without a new pairing (audit D2), so only a revoke removes it.
const PRIVATE_STORES = ['cache', 'drafts', 'outbox', 'blobs', 'schedules', 'problems'] as const
/**
 * Queued messages and voice notes. Kept when a session only ran out of time (the relay says `expired`), sent after the owner
 * signs back in. They are stored as they are in the app's browser storage (IndexedDB): the signed message text and the raw
 * audio, NOT encrypted by Talos, readable by anything that can read this browser's storage on the device. Sign-out, revoke
 * and every other session end remove them, and so does "Discard" on the sign-in page.
 */
// Problem reports waiting to be sent follow the same rule: they may hold a screenshot the owner added.
const UNSENT_STORES: readonly string[] = ['outbox', 'blobs', 'problems']

const WIPE_PENDING = 'talos-app:wipe-pending'
const ls = (): globalThis.Storage | null => {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage
  } catch {
    return null
  }
}
/**
 * A wipe that did not finish. It is written before the wipe starts and removed only when it succeeded, so a failed clear
 * (or a page that died halfway) is retried at the next open instead of being forgotten. 'all' = sign-out or revoke;
 * 'keep' = a session that ran out of time (the queue stays).
 */
export function pendingWipe(): 'all' | 'keep' | null {
  try {
    const v = ls()?.getItem(WIPE_PENDING)
    return v === 'all' || v === 'keep' ? v : null
  } catch {
    return null
  }
}
/** Runs the wipe that was left unfinished. True when there is nothing left to do. */
export async function retryPendingWipe(storage: Storage): Promise<boolean> {
  const mode = pendingWipe()
  if (!mode) return true
  try {
    await clearLocalData(storage, { keepUnsent: mode === 'keep' })
    return true
  } catch {
    return false
  }
}

/**
 * What only this tab holds in memory: playing audio, read-aloud asks, an unsaved Settings > Agent draft, and what the
 * composer kept: words of a send that failed, a prefill, dropped files, attachments. It runs on every session end, because
 * nothing else can reach it: no queue removal, Discard or sign-out in another tab empties a tab's memory, so anything left
 * could go out later under a different device key or after the owner signed out elsewhere. Each is tried even if another
 * fails; the first failure is thrown afterwards.
 */
function resetTabMemory(): void {
  let failure: unknown
  // Audio keeps playing across routes now (D37): a signed-out phone must go quiet, and what was listened to goes with the chats.
  // Read aloud: asks still going to the Mac stop, and the notes and failures it kept for the previous owner's messages go.
  for (const reset of [() => audioDock.resetForSignOut(), resetSpeak, resetAgentDraft, resetComposer]) {
    try {
      reset()
    } catch (e) {
      failure ??= e
    }
  }
  if (failure) throw failure
}

/**
 * Empties the cached threads, drafts, queued messages, voice blobs and the remembered identity. Run on sign-out and on
 * revoke, so a signed-out phone or browser does not keep the owner's chats (audit D21). A session that merely expired
 * passes `keepUnsent` and keeps the queued messages and voice notes. Every store is tried even if one fails; the first
 * failure is thrown afterwards so a caller never reports a clean wipe that was not, and the wipe is marked unfinished
 * (see `pendingWipe`) until a later run succeeds.
 */
export async function clearLocalData(storage: Storage, opts: { keepUnsent?: boolean } = {}): Promise<void> {
  let failure: unknown
  const mode = opts.keepUnsent ? 'keep' : 'all'
  try {
    if (pendingWipe() !== 'all') ls()?.setItem(WIPE_PENDING, mode)
  } catch {}
  try {
    resetTabMemory()
  } catch (e) {
    failure ??= e
  }
  for (const name of PRIVATE_STORES) {
    // An expired session keeps what the owner already sent but nothing has delivered yet; sign-out and revoke never do.
    if (opts.keepUnsent && UNSENT_STORES.includes(name)) continue
    try {
      await storage.clear(name)
    } catch (e) {
      failure ??= e
    }
  }
  // Typed searches and local thread notes live in localStorage, not the stores above.
  clearRecent()
  clearThreadDescriptions()
  // The notification keys and grant live in the iPhone Keychain, outside page storage: a signed-out phone must not keep them.
  void clearNativeGrant()
  // ...and the page's record of what the owner chose: message text is off again, so the next person to pair this phone (or the
  // same one) starts from the fixed phrase and has to tap to turn text on. The server's copy of the grant is taken back on the
  // next open (`reconcileGrant`).
  forgetNativeChoices()
  if (failure) throw failure
  try {
    // A 'keep' wipe finishing does not finish an 'all' wipe that was still owed.
    if (mode === 'all' || pendingWipe() !== 'all') ls()?.removeItem(WIPE_PENDING)
  } catch {}
}

/**
 * What to empty when a session ends, by the reason the relay gave. A tab whose device key the owner has since replaced
 * (`device_changed`), or whose session this browser has just signed in over (`signed_in_again`), shares the browser's
 * storage with the tab that did it: the chats, drafts and schedules in it are that tab's, so only this tab's memory is
 * reset. Every other end empties the stores too (see `clearLocalData`).
 */
export async function clearAfterSessionEnd(storage: Storage, reason: string | null): Promise<void> {
  if (sharesStorage(reason)) return resetTabMemory()
  await clearLocalData(storage, { keepUnsent: keepsUnsent(reason) })
}

const ME_KEY = 'me'
/** How long /api/me, and then the cached identity read, may take before the start counts them as unreachable. */
export const ME_WAIT_MS = 8000

export const useSession = create<SessionState>((set) => ({
  status: 'loading',
  me: null,
  offline: false,
  async refresh(storage, stopClient) {
    try {
      // A captive or half-dead network can leave the request hanging: treat ME_WAIT_MS as "unreachable".
      const me = await Promise.race([
        http.get<Me>('/api/me'),
        new Promise<never>((_, rej) => setTimeout(() => rej(new Error('timeout')), ME_WAIT_MS)),
      ])
      set({ status: 'authed', me, offline: false })
      void storage?.put('cache', ME_KEY, me).catch(() => {})
      return 'authed'
    } catch (e) {
      if (e instanceof HttpError && e.status === 401) {
        // Only a session that ran out of time keeps the queue; a revoke, a sign-out or a reason nobody gave wipes it.
        const reason = endReasonOf(e.body)
        const keep = keepsUnsent(reason)
        // Stop the socket client first: it keeps a debounced snapshot timer and flushes on pagehide, and either would
        // write the chats back into the cache this wipe is about to empty.
        try {
          stopClient?.({ keepQueue: keep })
        } catch {}
        set({ status: 'anon', me: null, offline: false })
        // A 401 at open (idle expiry, sign-out from another device, the Mac revoking this one) happens before any socket
        // exists, so the socket-side wipe never runs: empty the chats cached on this device here (audit D21).
        if (storage) void clearAfterSessionEnd(storage, reason).catch(() => {})
        return 'anon'
      }
      // Not a sign-out: the network or the server is down. Open the app on the last good identity so the shell, the
      // cached threads and the composer (outbox) work; the socket client reconnects when the network is back.
      // A storage that never answers must not hold the splash for ever: past the same limit it counts as having nothing cached.
      const cached = await Promise.race([
        storage?.get<Me>('cache', ME_KEY).catch(() => undefined),
        new Promise<undefined>((resolve) => setTimeout(resolve, ME_WAIT_MS)),
      ])
      if (cached) {
        set({ status: 'authed', me: cached, offline: true })
        return 'authed'
      }
      set({ status: 'error', offline: true })
      return 'error'
    }
  },
  setAnon() {
    set({ status: 'anon', me: null, offline: false })
  },
}))
