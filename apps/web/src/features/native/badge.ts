// The iPhone app's icon badge follows open cards plus unread while signed in (archived threads and threads set to off left
// out), and clears on sign-out. The relay sets the same number in each push; this keeps it right between pushes (a card
// resolved on the Mac, a thread read). Owner call O21; the one function is `badgeCount` in the protocol package.
import { badgeCount } from '@talos-app/protocol'
import type { TalosClient } from '../../lib/client.ts'
import { nativePushAvailable, setNativeBadge } from '../../lib/nativePush.ts'
import { useSession } from '../auth/session.ts'

/**
 * What is waiting on the owner: open (pending, unexpired) cards plus unread, leaving out archived threads and threads set to
 * off. The one number every badge uses (iPhone icon, web app badge), computed by the same `badgeCount` the relay puts in
 * each push, so the icon does not jump when a push lands.
 */
export function appBadgeCount(
  s: Pick<ReturnType<TalosClient['store']['getState']>, 'cards' | 'unread' | 'threads'>,
  nowMs: number,
): number {
  return badgeCount(s, nowMs)
}

export function startNativeBadge(client: TalosClient, scope: unknown = globalThis, now: () => number = Date.now) {
  if (!nativePushAvailable(scope)) return () => {}
  let last = -1
  const sync = () => {
    const live = useSession.getState().status === 'authed'
    const count = live ? appBadgeCount(client.store.getState(), now()) : 0
    if (count === last) return
    last = count
    setNativeBadge(count, scope)
  }
  // iOS applies `aps.badge` while the page is suspended, so what Apple last set can differ from `last`. Coming back to the
  // front, send the number again whatever it was.
  const onVisible = () => {
    if (typeof document !== 'undefined' && document.visibilityState !== 'visible') return
    last = -1
    sync()
  }
  sync()
  const offStore = client.store.subscribe(sync)
  const offSession = useSession.subscribe(sync)
  if (typeof document !== 'undefined') document.addEventListener('visibilitychange', onVisible)
  return () => {
    offStore()
    offSession()
    if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', onVisible)
  }
}
