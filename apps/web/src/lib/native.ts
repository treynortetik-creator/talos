// Detects the Capacitor iOS shell (apps/mobile). Everything here is feature detection on globals the shell injects; in a
// normal browser or installed PWA nothing is present, every call is a no-op and the answer is 'web'.
// Deliberately separate from platform.ts (push, share, haptics): that adapter is owned elsewhere.

export type CapacitorPlatform = 'ios' | 'android' | 'web'

type CapacitorGlobal = {
  isNativePlatform?: () => boolean
  getPlatform?: () => string
}

function capacitorGlobal(g: unknown): CapacitorGlobal | null {
  if (typeof g !== 'object' || g === null) return null
  const cap = (g as { Capacitor?: unknown }).Capacitor
  return typeof cap === 'object' && cap !== null ? (cap as CapacitorGlobal) : null
}

/**
 * 'ios' | 'android' when running inside a Capacitor native shell, otherwise 'web'. Never throws, never loads
 * @capacitor/core, never touches the network. `scope` is injectable for tests; it defaults to globalThis.
 */
export function capacitorPlatform(scope: unknown = globalThis): CapacitorPlatform {
  try {
    const cap = capacitorGlobal(scope)
    if (!cap || typeof cap.isNativePlatform !== 'function' || !cap.isNativePlatform()) return 'web'
    const p = typeof cap.getPlatform === 'function' ? cap.getPlatform() : ''
    return p === 'ios' || p === 'android' ? p : 'web'
  } catch {
    return 'web'
  }
}

/** True when the primary pointer is a finger (phones, tablets). False where matchMedia is missing. */
export function coarsePointer(scope: unknown = globalThis): boolean {
  try {
    const mm = (scope as { matchMedia?: (q: string) => { matches: boolean } }).matchMedia
    return typeof mm === 'function' && mm.call(scope, '(pointer: coarse)').matches
  } catch {
    return false
  }
}

/**
 * True when the Capacitor Keyboard plugin is registered in this shell. Read from the global only: the page never imports
 * @capacitor/* and never calls the plugin (its `window` events are the whole interface).
 */
export function hasKeyboardPlugin(scope: unknown = globalThis): boolean {
  try {
    if (typeof scope !== 'object' || scope === null) return false
    const cap = (scope as { Capacitor?: { Plugins?: Record<string, unknown> } }).Capacitor
    return Boolean(cap?.Plugins?.Keyboard)
  } catch {
    return false
  }
}

/** True when `scope` is a top-level window (or a bare test object with no `top`). A child frame answers false. */
function isTopFrame(scope: unknown): boolean {
  try {
    if (typeof scope !== 'object' || scope === null) return false
    const top = (scope as { top?: unknown }).top
    return top === undefined || top === scope
  } catch {
    return false
  }
}

/**
 * True only in the Talos iPhone shell: Capacitor on iOS, seen from the top frame. A Capacitor Android web view is not this
 * shell (setup-code sign-in, the iPhone adapter and 'installed' are all iPhone-shell behaviour), and a child frame never
 * counts, even if a Capacitor global somehow reached it.
 */
export function isNativeShell(scope: unknown = globalThis): boolean {
  return capacitorPlatform(scope) === 'ios' && isTopFrame(scope)
}

/** One file the shell's TalosPicker plugin hands back. */
export type NativePickedFile = { name: string; mime: string; base64: string }
/** The iPhone shell's own pickers (apps/mobile TalosPicker.swift). Each resolves `{ files }`; a dismissed picker gives []. */
export type NativePicker = {
  pickPhotos: () => Promise<{ files: NativePickedFile[] }>
  takePhoto: () => Promise<{ files: NativePickedFile[] }>
  pickFiles: () => Promise<{ files: NativePickedFile[] }>
}

/** The shell's TalosPicker plugin, or null outside the shell (or in a shell build without it). */
export function nativePicker(scope: unknown = globalThis): NativePicker | null {
  try {
    if (!isNativeShell(scope)) return null
    const p = (scope as { Capacitor?: { Plugins?: { TalosPicker?: NativePicker } } }).Capacitor?.Plugins?.TalosPicker
    return p && typeof p.pickPhotos === 'function' ? p : null
  } catch {
    return null
  }
}

/**
 * True in iPhone/iPad Safari (or a Home Screen app) that is not the Talos shell. There iOS puts its own sheet (Photo Library /
 * Take Photo / Choose File) on every file input, so the + button skips our menu and lets that sheet be the one menu.
 * iPadOS reports a Mac user agent, hence the touch-points check.
 */
export function isIosWeb(scope: unknown = globalThis): boolean {
  try {
    if (isNativeShell(scope)) return false
    const nav = (scope as { navigator?: { userAgent?: string; maxTouchPoints?: number } }).navigator
    const ua = nav?.userAgent ?? ''
    const ios = /iPhone|iPad|iPod/.test(ua) || (/Macintosh/.test(ua) && (nav?.maxTouchPoints ?? 0) > 1)
    return ios && coarsePointer(scope)
  } catch {
    return false
  }
}
