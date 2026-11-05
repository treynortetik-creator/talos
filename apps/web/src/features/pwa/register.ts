// Service worker registration and the notification-click bridge into the router.
import { startPendingSweep } from '../share/shareTarget.ts'

export async function registerServiceWorker(onNavigate: (url: string) => void): Promise<void> {
  if (typeof indexedDB !== 'undefined') startPendingSweep() // docs/V2-FEATURES.md V4.5: shared files live 24 h
  if (!('serviceWorker' in navigator)) return
  navigator.serviceWorker.addEventListener('message', (e: MessageEvent) => {
    const d = e.data as { type?: string; url?: unknown } | null
    if (d?.type === 'talos:navigate' && typeof d.url === 'string' && d.url.startsWith('/') && !d.url.startsWith('//'))
      onNavigate(d.url)
  })
  try {
    const dev = import.meta.env.DEV
    await navigator.serviceWorker.register(dev ? '/dev-sw.js?dev-sw' : '/sw.js', {
      scope: '/',
      type: dev ? 'module' : 'classic',
    })
  } catch {
    // Unsupported (private mode, WebKit without a secure context): the app works without it.
  }
}
