// The ONLY place that touches push, share, external links, haptics or install state (spec builder rule 9). A native
// iPhone wrapper (Phase 2) swaps this adapter and nothing else. Seam: ownership passes to WP6.
import { HttpsUrl } from '@talos-app/protocol'

export type PushPermission = 'granted' | 'denied' | 'default' | 'unsupported'
export type InstallState = 'installed' | 'browser' | 'unknown'
export type HapticKind = 'light' | 'success' | 'error'

/** The JSON a PushSubscription serializes to; what POST /api/push/subscribe takes. */
export type PushSubscriptionJson = {
  endpoint: string
  expirationTime?: number | null
  keys: { p256dh: string; auth: string }
}

export interface Platform {
  push: {
    permission(): PushPermission
    /** Call from a tap handler: it may show the permission prompt. Resolves null when denied or unsupported. */
    subscribe(vapidPublicKey: string): Promise<PushSubscriptionJson | null>
    unsubscribe(): Promise<void>
    /** Re-registers an existing grant on every open (no prompt). Resolves null unless permission is already granted. */
    resubscribe(vapidPublicKey: string): Promise<PushSubscriptionJson | null>
  }
  /** Clipboard access for the setup link (Copy / Paste). Read may be refused; callers fall back to a text field. */
  clipboard: {
    write(text: string): Promise<boolean>
    read(): Promise<string | null>
  }
  isIos(): boolean
  share(data: { title?: string; text?: string; url?: string }): Promise<'shared' | 'copied' | 'unsupported'>
  /** http(s) only. Opens outside the app (a new browsing context with no opener). */
  openExternal(url: string): boolean
  haptic(kind: HapticKind): void
  installState(): InstallState
  /** Driving mode (docs/V2-FEATURES.md V4.1-V4.2). Each adapter is a no-op where the API is missing. */
  audioSession: {
    /** `navigator.audioSession.type`: 'playback' while listening, 'play-and-record' while recording a voice note. */
    set(type: AudioSessionType): void
  }
  wakeLock: {
    /** Holds the screen awake. Resolves a release function (a no-op when unsupported or refused). */
    acquire(): Promise<() => void>
  }
  mediaSession: {
    /** Lock-screen metadata and transport handlers; call `clear()` to remove them. */
    set(meta: { title: string; artist: string }, handlers: MediaHandlers): void
    /**
     * Where the clip is, for the lock-screen scrubber and play/pause button (audit D37). Seconds; `rate` 0 means paused,
     * anything above is the playback speed. Ignored when no session is set, so a late tick never revives a cleared one. Optional: an adapter without it just has no scrubber.
     */
    position?(state: MediaPosition): void
    clear(): void
  }
  speech: {
    /** The phone's own voice (`speechSynthesis`). False when unsupported. */
    speak(text: string): boolean
    cancel(): void
    /** True while the phone's voice is reading something. Optional: adapters without it count as speaking. */
    speaking?(): boolean
  }
}

/** `paused`: a clip is loaded and stopped. The route stays held, not mixing, so iOS keeps Talos as the Now Playing app (a mixing session is not eligible) and the lock screen's Play still reaches it. */
export type AudioSessionType = 'playback' | 'paused' | 'play-and-record' | 'auto'
export type MediaHandlers = Partial<
  Record<'play' | 'pause' | 'nexttrack' | 'previoustrack' | 'seekbackward' | 'seekforward', () => void>
> & {
  /** The lock-screen scrubber: jump to this many seconds. */
  seekto?: (seconds: number) => void
}
export type MediaPosition = { duration: number; position: number; rate: number }

function urlBase64ToBytes(b64: string): Uint8Array<ArrayBuffer> {
  const pad = '='.repeat((4 - (b64.length % 4)) % 4)
  const raw = atob((b64 + pad).replace(/-/g, '+').replace(/_/g, '/'))
  return Uint8Array.from(raw, (c) => c.charCodeAt(0))
}

/** Browser implementation. Stub-level: WP6 hardens it (service worker registration, re-subscribe on every open). */
export const webPlatform: Platform = {
  push: {
    permission() {
      if (typeof Notification === 'undefined' || !('serviceWorker' in navigator) || !('PushManager' in window))
        return 'unsupported'
      return Notification.permission
    },
    async subscribe(vapidPublicKey) {
      if (this.permission() === 'unsupported') return null
      const result = await Notification.requestPermission()
      if (result !== 'granted') return null
      const reg = await navigator.serviceWorker.ready
      const sub = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToBytes(vapidPublicKey),
      })
      return sub.toJSON() as PushSubscriptionJson
    },
    async unsubscribe() {
      if (this.permission() === 'unsupported') return
      const reg = await navigator.serviceWorker.ready
      await (await reg.pushManager.getSubscription())?.unsubscribe()
    },
    async resubscribe(vapidPublicKey) {
      if (this.permission() !== 'granted') return null
      try {
        const reg = await navigator.serviceWorker.ready
        const sub =
          (await reg.pushManager.getSubscription()) ??
          (await reg.pushManager.subscribe({
            userVisibleOnly: true,
            applicationServerKey: urlBase64ToBytes(vapidPublicKey),
          }))
        return sub.toJSON() as PushSubscriptionJson
      } catch {
        return null
      }
    },
  },
  clipboard: {
    async write(text) {
      try {
        await navigator.clipboard.writeText(text)
        return true
      } catch {
        return false
      }
    },
    async read() {
      try {
        return await navigator.clipboard.readText()
      } catch {
        return null
      }
    },
  },
  isIos() {
    if (typeof navigator === 'undefined') return false
    return (
      /iPhone|iPad|iPod/.test(navigator.userAgent) ||
      (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1)
    )
  },
  async share(data) {
    if (typeof navigator.share === 'function') {
      try {
        await navigator.share(data)
        return 'shared'
      } catch {
        return 'unsupported'
      }
    }
    const text = data.url ?? data.text
    if (text && navigator.clipboard) {
      await navigator.clipboard.writeText(text)
      return 'copied'
    }
    return 'unsupported'
  },
  openExternal(url) {
    if (/^mailto:/i.test(url)) {
      location.href = url
      return true
    }
    if (!HttpsUrl.safeParse(url).success) return false
    window.open(url, '_blank', 'noopener,noreferrer')
    return true
  },
  haptic(kind) {
    // iOS has no web vibration; Android gets a short tick on success-like moments only.
    if (kind !== 'error' && typeof navigator.vibrate === 'function') navigator.vibrate(10)
  },
  installState() {
    if (typeof window === 'undefined') return 'unknown'
    if (window.matchMedia?.('(display-mode: standalone)').matches) return 'installed'
    if ((navigator as Navigator & { standalone?: boolean }).standalone === true) return 'installed'
    return 'browser'
  },
  audioSession: {
    set(type) {
      try {
        const session = (navigator as unknown as { audioSession?: { type: string } }).audioSession
        if (session) session.type = type === 'paused' ? 'playback' : type
      } catch {
        /* not settable here */
      }
    },
  },
  wakeLock: {
    async acquire() {
      // Returns at once. A request that settles late (iOS can take seconds while the page settles) is released the
      // moment it lands if the caller has already let go, so no lock outlives the screen that asked for it.
      let released = false
      let lock: { release(): Promise<void> } | null = null
      try {
        const wl = (
          navigator as unknown as { wakeLock?: { request(t: 'screen'): Promise<{ release(): Promise<void> }> } }
        ).wakeLock
        wl?.request('screen').then(
          (l) => {
            if (released) void l.release().catch(() => {})
            else lock = l
          },
          () => {},
        )
      } catch {
        /* unsupported or refused */
      }
      return () => {
        released = true
        const l = lock
        lock = null
        if (l) void l.release().catch(() => {})
      }
    },
  },
  mediaSession: {
    set(meta, handlers) {
      const ms = (navigator as Navigator & { mediaSession?: MediaSession }).mediaSession
      if (!ms) return
      try {
        if (typeof MediaMetadata !== 'undefined') ms.metadata = new MediaMetadata(meta)
        for (const [action, fn] of Object.entries(handlers)) {
          try {
            if (action === 'seekto') {
              const seekTo = handlers.seekto
              ms.setActionHandler('seekto', seekTo ? (d) => typeof d.seekTime === 'number' && seekTo(d.seekTime) : null)
            } else ms.setActionHandler(action as MediaSessionAction, (fn as (() => void) | undefined) ?? null)
          } catch {
            /* action not supported here */
          }
        }
      } catch {
        /* ignore */
      }
    },
    position({ duration, position, rate }) {
      const ms = (navigator as Navigator & { mediaSession?: MediaSession }).mediaSession
      if (!ms?.metadata) return
      try {
        // setPositionState throws on an unknown length or a position past it: skip the scrubber, keep the session.
        if (Number.isFinite(duration) && duration > 0 && Number.isFinite(position)) {
          ms.setPositionState({
            duration,
            position: Math.max(0, Math.min(position, duration)),
            playbackRate: rate > 0 ? rate : 1,
          })
        }
        ms.playbackState = rate > 0 ? 'playing' : 'paused'
      } catch {
        /* ignore */
      }
    },
    clear() {
      const ms = (navigator as Navigator & { mediaSession?: MediaSession }).mediaSession
      if (!ms) return
      try {
        ms.metadata = null
        ms.playbackState = 'none'
        for (const a of [
          'play',
          'pause',
          'nexttrack',
          'previoustrack',
          'seekbackward',
          'seekforward',
          'seekto',
        ] as const)
          ms.setActionHandler(a, null)
      } catch {
        /* ignore */
      }
    },
  },
  speech: {
    speak(text) {
      try {
        if (typeof speechSynthesis === 'undefined' || typeof SpeechSynthesisUtterance === 'undefined') return false
        speechSynthesis.speak(new SpeechSynthesisUtterance(text))
        return true
      } catch {
        return false
      }
    },
    cancel() {
      try {
        if (typeof speechSynthesis !== 'undefined') speechSynthesis.cancel()
      } catch {
        /* ignore */
      }
    },
    speaking() {
      try {
        return typeof speechSynthesis !== 'undefined' && speechSynthesis.speaking
      } catch {
        return false
      }
    },
  },
}

let current: Platform = webPlatform
export const getPlatform = (): Platform => current
/** Tests and the native wrapper replace the adapter here. */
export function setPlatform(p: Platform): void {
  current = p
}
