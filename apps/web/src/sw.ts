/// <reference lib="webworker" />
// Service worker: precache the app shell, show pushes from PushPayload, open in-scope URLs on click, set the badge.
import { appCsp } from '@talos-app/protocol'
import { addPlugins, cleanupOutdatedCaches, matchPrecache, precacheAndRoute } from 'workbox-precaching'
import { notificationForPush, safeNavigateTarget, viewingPushThread } from './features/pwa/pushLogic.ts'
import { SHARE_TARGET_PATH } from './features/share/material.ts'
import { handleShareTarget, idbPendingStore } from './features/share/shareTarget.ts'

declare const self: ServiceWorkerGlobalScope & {
  __WB_MANIFEST: Array<string | { url: string; revision: string | null }>
}

// The precached shell carries whatever CSP the relay sent when it was installed, so the worker sets the policy itself. The
// policy is compiled into sw.js: a relay policy change changes the worker and forces a reinstall. Production only: the vite
// dev server's react-refresh preamble is inline script, which this policy would block.
const stampPolicy = import.meta.env.PROD

// Rebuilt from the body rather than copied: a shell stored after a redirect has an empty address and is flagged redirected,
// which a copy keeps (and a navigation refuses) and which must never push the start offline.
async function withPolicy(res: Response): Promise<Response> {
  if (!stampPolicy) return res
  const headers = new Headers(res.headers)
  headers.set('Content-Security-Policy', appCsp(self.location.origin))
  return new Response(await res.clone().blob(), { status: res.status, statusText: res.statusText, headers })
}

// precacheAndRoute registers its own fetch listener before the one below, so it answers '/', '/index.html' and '/?utm_*' itself.
// Every HTML response it serves from the cache is stamped here, whichever listener asks.
addPlugins([
  {
    cachedResponseWillBeUsed: async ({ cachedResponse }) =>
      cachedResponse && (cachedResponse.headers.get('content-type') ?? '').includes('text/html')
        ? withPolicy(cachedResponse)
        : cachedResponse,
  },
])
precacheAndRoute(self.__WB_MANIFEST)
cleanupOutdatedCaches()

self.addEventListener('install', () => void self.skipWaiting())
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()))

// SPA navigations are served the precached shell (offline start). API, media and the socket are never intercepted.
self.addEventListener('fetch', (event) => {
  const req = event.request
  const url = new URL(req.url)
  // Share to Talos (Android and desktop Chrome): the manifest share_target POSTs here. Keep the material (files too) in
  // IndexedDB for 24 h and answer 303 /share?pending=<id>; the relay never sees the files (docs/V2-FEATURES.md V4.3).
  if (req.method === 'POST' && url.origin === self.location.origin && url.pathname === SHARE_TARGET_PATH) {
    event.respondWith(handleShareTarget(req, { store: idbPendingStore(), now: () => Date.now() }))
    return
  }
  if (req.mode !== 'navigate') return
  if (url.origin !== self.location.origin || /^\/(api|media|hook|bridge|ws|healthz)(\/|$)/.test(url.pathname)) return
  // Other SPA routes: the precached shell, stamped (the precache route above answers the shell's own addresses).
  event.respondWith(
    (async () => {
      const shell = (await matchPrecache('/index.html')) ?? (await matchPrecache('index.html'))
      if (!shell) return fetch(req)
      return withPolicy(shell)
    })(),
  )
})

self.addEventListener('push', (event) => {
  let json: unknown = null
  try {
    json = event.data?.json()
  } catch {
    json = null
  }
  const n = notificationForPush(json)
  event.waitUntil(
    (async () => {
      const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true })
      const seen = viewingPushThread(json, windows as unknown as WindowClient[], self.location.origin)
      await self.registration.showNotification(n.title, { ...n.options, ...(seen ? { silent: true } : {}) })
      // The owner is already looking at this thread: the reply is on screen, so the banner goes away at once.
      if (seen) for (const shown of await self.registration.getNotifications({ tag: n.options.tag })) shown.close()
      if (n.badge !== undefined) {
        const nav = self.navigator as Navigator & {
          setAppBadge?: (n?: number) => Promise<void>
          clearAppBadge?: () => Promise<void>
        }
        if (n.badge > 0) await nav.setAppBadge?.(n.badge).catch(() => {})
        else await nav.clearAppBadge?.().catch(() => {})
      }
    })(),
  )
})

self.addEventListener('notificationclick', (event) => {
  event.notification.close()
  const target = safeNavigateTarget(
    (event.notification.data as { navigate?: unknown } | null)?.navigate,
    self.location.origin,
  )
  event.waitUntil(
    (async () => {
      const all = await self.clients.matchAll({ type: 'window', includeUncontrolled: true })
      const existing = all.find((c) => new URL(c.url).origin === self.location.origin)
      if (existing) {
        await existing.focus()
        existing.postMessage({ type: 'talos:navigate', url: target })
        return
      }
      await self.clients.openWindow(target)
    })(),
  )
})
