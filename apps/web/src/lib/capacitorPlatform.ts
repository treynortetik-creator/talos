// The Platform adapter for the Capacitor iPhone shell (apps/mobile, IOS-SPEC WP-W1/WP-I4). Spreads webPlatform and
// overrides only what the shell does better: haptics (the native Taptic Engine), the audio session (AVAudioSession via
// the shell's TalosAudio plugin) and installState (a shell is never "add to Home Screen first").
//
// The page is served by the relay, so it cannot import @capacitor/*: the shell injects `window.Capacitor`, whose
// `Plugins` proxy carries every native plugin. Every call is feature-detected, fire-and-forget and never throws; a
// missing plugin (older shell build) is a no-op. The shell's bridge guard (I14) drops these calls from any frame that is
// not the relay's own top frame, so nothing here widens what an agent page can do.
import { isNativeShell } from './native.ts'
import {
  type AudioSessionType,
  type HapticKind,
  type MediaHandlers,
  type MediaPosition,
  type Platform,
  setPlatform,
  webPlatform,
} from './platform.ts'

type PluginMethod = (options?: Record<string, unknown>) => Promise<unknown> | undefined
type PluginMap = Record<string, Record<string, PluginMethod> | undefined>

function plugins(scope: unknown): PluginMap | null {
  try {
    const cap = (scope as { Capacitor?: { Plugins?: unknown } } | null | undefined)?.Capacitor
    const p = cap?.Plugins
    return typeof p === 'object' && p !== null ? (p as PluginMap) : null
  } catch {
    return null
  }
}

function call(scope: unknown, plugin: string, method: string, options?: Record<string, unknown>): void {
  try {
    const fn = plugins(scope)?.[plugin]?.[method]
    if (typeof fn !== 'function') return
    const result = fn.call(plugins(scope)?.[plugin], options)
    if (result && typeof (result as Promise<unknown>).catch === 'function')
      void (result as Promise<unknown>).catch(() => {})
  } catch {
    /* a native call must never break the page */
  }
}

/** Haptics: @capacitor/haptics' styles and notification types. */
export function hapticCall(kind: HapticKind): { method: 'impact' | 'notification'; options: Record<string, unknown> } {
  if (kind === 'success') return { method: 'notification', options: { type: 'SUCCESS' } }
  if (kind === 'error') return { method: 'notification', options: { type: 'ERROR' } }
  return { method: 'impact', options: { style: 'LIGHT' } }
}

/** V3's three session types onto TalosAudio modes: while listening/speaking, while recording, and idle. */
export function audioMode(type: AudioSessionType): 'playback' | 'paused' | 'record' | 'idle' {
  return type === 'play-and-record'
    ? 'record'
    : type === 'playback'
      ? 'playback'
      : type === 'paused'
        ? 'paused'
        : 'idle'
}

/** A native Now Playing command and the page's own MediaSession can both deliver one tap; the second one inside this window is dropped. */
export const COMMAND_DEDUPE_MS = 250
const NATIVE_ACTIONS = new Set(['play', 'pause', 'seekbackward', 'seekforward', 'nexttrack', 'previoustrack', 'seekto'])

type Listener = { remove?: () => unknown }

/**
 * The lock screen and Control Center (audit D37). The page's own `navigator.mediaSession` is kept (WebKit may or may not
 * publish it from inside the shell, #124), and the TalosAudio plugin writes MPNowPlayingInfoCenter and listens on
 * MPRemoteCommandCenter as well. Both feed one set of handlers; a tap that arrives by both routes runs once.
 */
function createMediaSession(scope: unknown): Platform['mediaSession'] {
  let handlers: MediaHandlers = {}
  let listening = false
  let last: MediaPosition | null = null
  // Whose position `last` is. A new title (Drive after a report, a different clip) starts from nothing, never from the old scrubber.
  let lastKey: string | null = null
  const lastFire = new Map<string, { at: number; via: 'web' | 'native' }>()

  const fire = (action: string, via: 'web' | 'native', seconds?: number) => {
    const seen = lastFire.get(action)
    const now = Date.now()
    if (seen && seen.via !== via && now - seen.at < COMMAND_DEDUPE_MS) return
    lastFire.set(action, { at: now, via })
    try {
      if (action === 'seekto') {
        if (typeof seconds === 'number' && Number.isFinite(seconds) && seconds >= 0) handlers.seekto?.(seconds)
      } else (handlers[action as Exclude<keyof MediaHandlers, 'seekto'>] as (() => void) | undefined)?.()
    } catch {
      /* a handler must not break the native callback */
    }
  }

  const listen = () => {
    if (listening) return
    const plugin = plugins(scope)?.TalosAudio as unknown as
      | { addListener?: (e: string, cb: (d: unknown) => void) => Promise<Listener> | Listener | undefined }
      | undefined
    if (typeof plugin?.addListener !== 'function') return
    try {
      const handle = plugin.addListener('remoteCommand', (d) => {
        const data = (d ?? {}) as { action?: unknown; position?: unknown }
        if (typeof data.action !== 'string' || !NATIVE_ACTIONS.has(data.action)) return
        fire(data.action, 'native', typeof data.position === 'number' ? data.position : undefined)
      })
      listening = true
      if (handle && typeof (handle as Promise<Listener>).catch === 'function')
        void (handle as Promise<Listener>).catch(() => {
          listening = false
        })
    } catch {
      /* an older shell without the event: the page's own session still works */
    }
  }

  return {
    set(meta, h) {
      handlers = h
      const key = `${meta.title}\u0000${meta.artist}`
      if (key !== lastKey) {
        last = null
        lastKey = key
      }
      const web: MediaHandlers = {}
      for (const [action, fn] of Object.entries(h)) {
        if (typeof fn !== 'function') continue
        if (action === 'seekto') web.seekto = (t) => fire('seekto', 'web', t)
        else (web as Record<string, () => void>)[action] = () => fire(action, 'web')
      }
      webPlatform.mediaSession.set(meta, web)
      listen()
      call(scope, 'TalosAudio', 'setNowPlaying', {
        title: meta.title,
        artist: meta.artist,
        // A clip's place survives a re-set (every play re-sets the session); a new clip's first `position()` replaces it.
        ...(last ? { duration: last.duration, position: last.position, rate: last.rate } : { position: 0, rate: 1 }),
        actions: Object.keys(web),
      })
    },
    position(state) {
      last = state
      webPlatform.mediaSession.position?.(state)
      call(scope, 'TalosAudio', 'updateNowPlaying', { ...state })
    },
    clear() {
      handlers = {}
      last = null
      lastKey = null
      webPlatform.mediaSession.clear()
      call(scope, 'TalosAudio', 'clearNowPlaying')
    },
  }
}

export function createCapacitorPlatform(scope: unknown = globalThis): Platform {
  return {
    ...webPlatform,
    haptic(kind) {
      const { method, options } = hapticCall(kind)
      call(scope, 'Haptics', method, options)
    },
    // The shell is the installed app: the enroll page must not tell it to add itself to the Home Screen.
    installState: () => 'installed',
    audioSession: {
      set(type) {
        webPlatform.audioSession.set(type)
        call(scope, 'TalosAudio', 'setMode', { mode: audioMode(type) })
      },
    },
    mediaSession: createMediaSession(scope),
  }
}

/** Call once at start-up (main.tsx). Does nothing outside the native shell. */
export function installNativePlatform(scope: unknown = globalThis): boolean {
  if (!isNativeShell(scope)) return false
  setPlatform(createCapacitorPlatform(scope))
  return true
}
