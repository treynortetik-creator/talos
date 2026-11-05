// Read state follows the notifications. A thread read here (or on another device, via the relay's read mark) leaves no
// "New reply" in the tray, a card decided anywhere leaves no "Needs you", and the app icon's number follows the open
// cards and unread. sw.ts already closes a banner whose thread is on screen as it arrives; this covers everything that happens after.
//
// Two triggers. A live change (unread going from something to 0, a card leaving pending) closes at once. And every time the
// relay's snapshot arrives (`ready`) the tray is reconciled against it: a phone that slept while the thread was read
// elsewhere never saw the transition (the read mark is not replayed, and the snapshot's 0 equals what it already held), and
// a lookup that failed earlier gets another go.
//
// Two stores of delivered notifications, two keys:
//  * Web push (the service worker): tags are `thread:<id>` and `card:<id>`; closed through the registration.
//  * The iPhone shell (APNs): Apple only sees `thread:general` / `thread:inbox` for the built-in threads and
//    `thread:<opaque ref>` for every other (relay `forApple`), so a named thread is cleared by its ref, which the relay tells a
//    signed-in session. Cards keep `card:<id>`.
//
// The badge is open cards plus unread, archived threads and threads set to off left out (`appBadgeCount`, the same number
// the iPhone icon and the relay's pushes use; owner call O21).
import type { TalosClient } from '../../lib/client.ts'
import { appleThreadKey, clearNativeDelivered, nativePushAvailable, retryNativeViewing } from '../../lib/nativePush.ts'
import { useSession } from '../auth/session.ts'
import { appBadgeCount } from '../native/badge.ts'

type Notif = { tag?: string; close: () => void }
const FIXED_THREADS = ['general', 'inbox']
type Scope = {
  navigator?: {
    serviceWorker?: { getRegistration?: () => Promise<{ getNotifications?: () => Promise<Notif[]> } | undefined> }
    setAppBadge?: (n?: number) => Promise<void>
    clearAppBadge?: () => Promise<void>
  }
}

/** Closes every shown web-push notification whose tag is in `tags`. Never throws: no service worker is a normal answer. */
export async function closeWebNotifications(tags: readonly string[], scope: unknown = globalThis): Promise<number> {
  if (tags.length === 0) return 0
  try {
    const reg = await (scope as Scope).navigator?.serviceWorker?.getRegistration?.()
    const shown = (await reg?.getNotifications?.()) ?? []
    let closed = 0
    for (const n of shown)
      if (n.tag && tags.includes(n.tag)) {
        n.close()
        closed++
      }
    return closed
  } catch {
    return 0
  }
}

/** Closes every shown web-push notification for which `stale(tag)` says so. Never throws. */
export async function closeWebWhere(stale: (tag: string) => boolean, scope: unknown = globalThis): Promise<number> {
  try {
    const reg = await (scope as Scope).navigator?.serviceWorker?.getRegistration?.()
    const shown = (await reg?.getNotifications?.()) ?? []
    let closed = 0
    for (const n of shown)
      if (n.tag && stale(n.tag)) {
        n.close()
        closed++
      }
    return closed
  } catch {
    return 0
  }
}

/** Sets (or clears, at 0) the installed web app's icon number. A browser tab or an engine without the API does nothing. */
export function setWebBadge(count: number, scope: unknown = globalThis): void {
  try {
    const nav = (scope as Scope).navigator
    if (!nav) return
    const done = count > 0 ? nav.setAppBadge?.(count) : nav.clearAppBadge?.()
    void Promise.resolve(done).catch(() => {})
  } catch {
    /* a badge must never break the page */
  }
}

export function startReadSync(
  client: TalosClient,
  scope: unknown = globalThis,
  now: () => number = Date.now,
  keyFor: typeof appleThreadKey = appleThreadKey,
  retryViewing: (scope: unknown) => void = retryNativeViewing,
): () => void {
  const live = () => useSession.getState().status === 'authed'
  let prevUnread = client.store.getState().unread
  let prevCards = client.store.getState().cards
  let pending = new Set(prevCards.filter((c) => c.state === 'pending').map((c) => c.id))
  let lastBadge = -1
  let prevReady = client.store.getState().readySeq

  const clear = (threads: string[], cards: string[], nativeOnly = false) => {
    if (!live() || (threads.length === 0 && cards.length === 0)) return
    const cardTags = cards.map((id) => `card:${id}`)
    if (!nativeOnly) void closeWebNotifications([...threads.map((t) => `thread:${t}`), ...cardTags], scope)
    if (!nativePushAvailable(scope)) return
    // the iPhone's copies are keyed by what Apple saw; a thread whose key cannot be learned is skipped, not guessed
    void Promise.all(threads.map((t) => keyFor(t))).then((keys) => {
      const tags = [...keys.filter((k): k is string => k !== null).map((k) => `thread:${k}`), ...cardTags]
      clearNativeDelivered(tags, scope)
    })
  }

  // The relay's snapshot is the truth about what is read and what is pending: anything in the tray it contradicts goes.
  const reconcile = (s: ReturnType<TalosClient['store']['getState']>) => {
    if (!live()) return
    const unread = (t: string) => s.unread[t] ?? 0
    const pendingNow = new Set(s.cards.filter((c) => c.state === 'pending').map((c) => c.id))
    void closeWebWhere((tag) => {
      if (tag.startsWith('thread:')) return unread(tag.slice(7)) === 0
      if (tag.startsWith('card:')) return !pendingNow.has(tag.slice(5))
      return false
    }, scope)
    // The iPhone's tray cannot be listed, so ask for every thread that is read (the keys are cached after the first answer).
    const ids = new Set([...FIXED_THREADS, ...s.threads.map((t) => t.id), ...Object.keys(s.unread)])
    clear([...ids].filter((t) => unread(t) === 0).slice(0, 50), [], true)
    retryViewing(scope)
  }

  const sync = () => {
    const s = client.store.getState()
    const status = useSession.getState().status
    let read: string[] = []
    let resolved: string[] = []
    if (s.unread !== prevUnread) {
      read = Object.keys(prevUnread).filter((t) => (prevUnread[t] ?? 0) > 0 && (s.unread[t] ?? 0) === 0)
      prevUnread = s.unread
    }
    if (s.cards !== prevCards) {
      prevCards = s.cards
      const nowPending = new Set(s.cards.filter((c) => c.state === 'pending').map((c) => c.id))
      resolved = [...pending].filter((id) => !nowPending.has(id))
      pending = nowPending
    }
    clear(read, resolved)
    if (s.readySeq !== prevReady) {
      prevReady = s.readySeq
      if (s.readySeq !== undefined) reconcile(s)
    }
    // Only signed out clears. While the session is still loading, or the socket has not yet answered with the relay's
    // snapshot, the card list is empty rather than known: leave the icon alone, so opening the app never wipes a right number.
    if (status === 'anon') {
      setBadge(0)
      return
    }
    if (status !== 'authed' || s.connection !== 'online' || s.readySeq === undefined) return
    setBadge(appBadgeCount(s, now()))
  }

  const setBadge = (badge: number) => {
    if (badge !== lastBadge) {
      lastBadge = badge
      setWebBadge(badge, scope)
    }
  }

  sync()
  const offStore = client.store.subscribe(sync)
  const offSession = useSession.subscribe(sync)
  return () => {
    offStore()
    offSession()
  }
}
