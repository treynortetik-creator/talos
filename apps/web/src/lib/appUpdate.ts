// A newer build of the web app is out, and this page is still running the old one. The service worker answers every
// navigation from its precache, so a cold start (a reboot, a relaunch of the Mac app) renders the build cached last time; the
// new worker installs and takes over a moment later, but the page already running keeps its old code until it reloads.
// Two signs: the server's version (/api/me, built with this web app in the same image) differing from this bundle's, which
// asks the worker to look for the new build; and a new worker taking control of a page that already had one. A reload is
// only worth making once the new build is what a load gets: after that hand-over, or on a page no worker serves. Then it
// happens at a safe moment, once per new version, or the owner taps "Update ready" (features/pwa/UpdateReady.tsx); that
// line shows only once a reload would load the new build, and not again for a version a reload already came back from.
import { create } from 'zustand'

export const RUNNING_VERSION: string = import.meta.env.VITE_APP_VERSION ?? '0.0.0'
/** When this page loaded (wall clock: a performance clock can stand still while the Mac sleeps). */
export const LOADED_AT = Date.now()
/** A page this young has shown nothing worth keeping: reload at once (the cold start case). */
export const COLD_START_MS = 15_000
const RELOADED_KEY = 'talos.updateReloadedFor'
const UPDATE_EVERY_MS = 60_000

type AppUpdate = {
  ready: boolean
  /** The new worker controls this page: a reload now loads the new build. */
  handedOver: boolean
  /** The version the server runs, when that is how it was seen. */
  target: string | null
  /** First seen during the cold start: the reload stays allowed when the new worker comes in later (a slow install). */
  cold: boolean
}
export const useAppUpdate = create<AppUpdate>(() => ({ ready: false, handedOver: false, target: null, cold: false }))
const inColdStart = () => Date.now() - LOADED_AT < COLD_START_MS

// ---- asking the worker to look (features/pwa/register.ts sets it; throttled) ----------------------------------------
let updater: (() => void) | null = null
let lastAsk = 0
let pendingAsk = false // asked before the worker was registered: asked again once it is
export function setWorkerUpdater(fn: (() => void) | null): void {
  updater = fn
  if (fn && pendingAsk) {
    pendingAsk = false
    lastAsk = Date.now()
    fn()
  }
}
/** `force`: now, whatever the last ask (the server just said a newer build is out). */
export function askWorkerForUpdate(now = Date.now(), force = false): void {
  if (!updater) {
    pendingAsk = true
    return
  }
  if (!force && now - lastAsk < UPDATE_EVERY_MS) return
  lastAsk = now
  // a worker that cannot be asked (a register() that gave nothing: red main 2026-11-14) never throws into a caller, so the
  // relay's version read that follows the ask always runs
  try {
    updater()
  } catch {}
}

const unknownVersion = (v: string) => v === '' || v === '0.0.0' || v === 'dev' || v === 'test'

/** The server's version (/api/me at sign-in, /healthz while open): a real version that is not this bundle's means this page is out of date. */
export function noteServerVersion(server: string | undefined | null, running = RUNNING_VERSION): void {
  if (!server || unknownVersion(server) || unknownVersion(running) || server === running) return
  if (!useAppUpdate.getState().ready || useAppUpdate.getState().target !== server)
    useAppUpdate.setState({ ready: true, target: server, cold: useAppUpdate.getState().cold || inColdStart() })
  askWorkerForUpdate(Date.now(), true) // at once: the new build has to be installed before a reload helps
}

// ---- the relay's version, read again while the page stays open ------------------------------------------------------
// /api/me is read at sign-in only, and the iPhone app has no service worker (WKWebView without app-bound domains): an app
// kept open never learned of a new build until it was relaunched (2026-11-14). /healthz is public, cheap and carries the
// same version, so it is read again each time the page comes to the front and every minute while it stays there.
/** How often a page that stays in front reads the relay's version. */
export const VERSION_CHECK_EVERY_MS = 60_000
/** At most one read every half minute, however the page is woken (under the interval, so no tick is skipped). */
const VERSION_CHECK_MIN_GAP_MS = 30_000
let lastVersionCheck = Number.NEGATIVE_INFINITY

/** Reads the relay's version and passes it on (noteServerVersion). A failed or odd answer changes nothing. */
export async function checkServerVersion(
  o: { now?: number; fetch?: typeof fetch; running?: string } = {},
): Promise<void> {
  const now = o.now ?? Date.now()
  if (now - lastVersionCheck < VERSION_CHECK_MIN_GAP_MS) return
  lastVersionCheck = now
  try {
    const res = await (o.fetch ?? globalThis.fetch)('/healthz', {
      cache: 'no-store',
      ...(typeof AbortSignal.timeout === 'function' ? { signal: AbortSignal.timeout(10_000) } : {}),
    })
    if (!res.ok) return
    const body = (await res.json()) as { version?: unknown }
    if (typeof body?.version === 'string') noteServerVersion(body.version, o.running ?? RUNNING_VERSION)
  } catch {
    // offline or the relay restarting: the next read tries again
  }
}

/**
 * A service worker taking control of this page: a load now gets what it serves, the newer build. On a page that already had
 * one that is an update. On a page that had none, the first claim is not: it serves the build this page already runs, so it
 * counts only when an update was already known (that worker came from the server that reported it). Either way the next
 * change on the same page is a real update.
 */
export function watchServiceWorker(
  sw: ServiceWorkerContainer | undefined = globalThis.navigator?.serviceWorker,
): () => void {
  if (!sw) return () => {}
  let had = !!sw.controller
  const on = () => {
    const first = !had
    had = true
    useAppUpdate.setState((s) => {
      if (!first) return { ready: true, handedOver: true, cold: s.cold || inColdStart() }
      return s.ready ? { handedOver: true, cold: s.cold || inColdStart() } : s
    })
  }
  sw.addEventListener('controllerchange', on)
  return () => sw.removeEventListener('controllerchange', on)
}

/** A reload would load the new build: the new worker took over, or no worker serves this page (the network does). */
export function reloadWouldHelp(sw: ServiceWorkerContainer | undefined = globalThis.navigator?.serviceWorker): boolean {
  return useAppUpdate.getState().handedOver || !sw?.controller
}

/**
 * Nothing on screen would be lost by a reload: the page is visible, not Settings (a form may be half changed), no dialog or
 * sheet is open, no text is typed into a field, nothing is held by the composer or in flight (`busy`: attachments, a quote,
 * words of a failed send, a send not yet acked, a card answer waiting).
 */
export function safeToReload(o: { busy: boolean; path: string }, doc: Document = document): boolean {
  if (o.busy || doc.visibilityState !== 'visible' || o.path.startsWith('/settings')) return false
  if (doc.querySelector('[role="dialog"], [role="alertdialog"]')) return false
  for (const el of doc.querySelectorAll<HTMLTextAreaElement | HTMLInputElement>(
    'textarea, input[type="text"], input[type="search"], input:not([type])',
  ))
    if (el.value.trim() !== '') return false
  for (const el of doc.querySelectorAll<HTMLElement>('[contenteditable="true"]'))
    if ((el.textContent ?? '').trim() !== '') return false
  return true
}

// after the hand-over a reload loads another build than before it: a claim made earlier must not use that one up
const reloadKey = (target: string | null) =>
  `${RUNNING_VERSION}>${target ?? 'worker'}${useAppUpdate.getState().handedOver ? '#new' : ''}`

/**
 * A reload toward this target was already made from this build and came back here, so another would bring back the same
 * build.
 */
export function reloadTried(target: string | null): boolean {
  try {
    return sessionStorage.getItem(RELOADED_KEY) === reloadKey(target)
  } catch {
    return false
  }
}

/**
 * One reload per new version, the owner's tap included (it records itself here too): a reload that comes back to the same
 * old build (a worker that has not caught up, a server that reports a version no build here carries) does not happen again
 * on its own for it. A claim made before the new worker took over is a different one from the claim after it (the old
 * worker answered the first reload); a hand-over happens once per page, so that cannot loop.
 */
export function claimAutoReload(target: string | null): boolean {
  // from this build to that one: the next deploy, in the same tab, is a new key
  const key = reloadKey(target)
  try {
    if (sessionStorage.getItem(RELOADED_KEY) === key) return false
    sessionStorage.setItem(RELOADED_KEY, key)
    return true
  } catch {
    return false // no storage: no way to stop a loop, so only the tap reloads
  }
}

// ---- idle, for a reload while the owner stays on the page ---------------------------------------------------------------
/** A reload found by the timer waits for this long with no touch, key or scroll, so it never takes the page from under a
 * reader (a return to the front or a cold start does not wait: nothing is being read then). */
export const IDLE_BEFORE_TIMER_RELOAD_MS = 30_000
let lastActivity = Date.now()
/** Notes a touch, key or scroll (UpdateReady listens). */
export function noteActivity(now = Date.now()): void {
  lastActivity = now
}
export const idleFor = (now = Date.now()): number => now - lastActivity

/** Tests only. */
export function resetAppUpdate(): void {
  useAppUpdate.setState({ ready: false, handedOver: false, target: null, cold: false })
  lastAsk = 0
  pendingAsk = false
  lastVersionCheck = Number.NEGATIVE_INFINITY
  lastActivity = Date.now()
  try {
    sessionStorage.removeItem(RELOADED_KEY)
  } catch {
    // nothing kept
  }
}
