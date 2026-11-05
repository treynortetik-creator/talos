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
