// Pure helpers shared by the service worker and the tests. The service worker never needs message text: the push
// payload only ever carries fixed templates (spec 3.7).
import { PushPayload, type PushPayloadT } from '@talos-app/protocol'

export type ShownNotification = {
  title: string
  options: {
    body: string
    tag?: string
    renotify?: boolean
    icon: string
    badge: string
    data: { navigate: string; kind: PushPayloadT['talos']['kind']; thread_id?: string; card_id?: string }
  }
  badge?: number
}

export function parsePush(raw: unknown): PushPayloadT | null {
  const res = PushPayload.safeParse(raw)
  return res.success ? res.data : null
}

export function notificationFromPayload(p: PushPayloadT): ShownNotification {
  const n = p.notification
  return {
    title: n.title,
    options: {
      body: n.body,
      ...(n.tag ? { tag: n.tag } : {}),
      ...(n.tag && n.renotify ? { renotify: true } : {}),
      icon: '/brand/talos/talos-icon-192.png',
      badge: '/brand/talos/talos-icon-192.png' /* TODO(assets): badge-96.png once the Codex set lands */,
      data: {
        navigate: n.navigate,
        kind: p.talos.kind,
        ...(p.talos.thread_id ? { thread_id: p.talos.thread_id } : {}),
        ...(p.talos.card_id ? { card_id: p.talos.card_id } : {}),
      },
    },
    ...(n.app_badge !== undefined ? { badge: n.app_badge } : {}),
  }
}

/** What a push that is not a valid PushPayload shows: fixed text, never anything from the payload. */
export function fallbackNotification(): ShownNotification {
  return {
    title: 'Talos',
    options: {
      body: 'You have an update.',
      tag: 'talos-update',
      icon: '/brand/talos/talos-icon-192.png',
      badge: '/brand/talos/talos-icon-192.png',
      data: { navigate: '/', kind: 'system' },
    },
  }
}

/** The notification for any push body. Browsers can revoke a subscription whose pushes show nothing, so never skip. */
export function notificationForPush(raw: unknown): ShownNotification {
  const payload = parsePush(raw)
  return payload ? notificationFromPayload(payload) : fallbackNotification()
}

/** Only in-scope, same-origin paths are ever opened from a notification click. Anything else falls back to `/`. */
export function safeNavigateTarget(raw: unknown, origin: string): string {
  if (typeof raw !== 'string' || !raw.startsWith('/') || raw.startsWith('//') || raw.includes('\\')) return '/'
  try {
    const u = new URL(raw, origin)
    return u.origin === origin ? `${u.pathname}${u.search}${u.hash}` : '/'
  } catch {
    return '/'
  }
}

/**
 * True when the owner is looking at the thread this push is about: a visible, focused window of this app sits on
 * `/t/<thread_id>`. The push still has to be shown (browsers revoke a subscription whose pushes show nothing), so the
 * service worker shows it silently and closes it again. A payload without a thread id (Apple pushes name only General and
 * Inbox; any other thread is an opaque reference) never matches.
 */
export function viewingPushThread(
  raw: unknown,
  windows: ReadonlyArray<{ url: string; visibilityState?: string; focused?: boolean }>,
  origin: string,
): boolean {
  const threadId = parsePush(raw)?.talos.thread_id
  if (!threadId) return false
  return windows.some((w) => {
    if (w.visibilityState !== 'visible' || w.focused !== true) return false
    try {
      const u = new URL(w.url)
      return u.origin === origin && u.pathname === `/t/${threadId}`
    } catch {
      return false
    }
  })
}
