// The iPhone shell's push plugin (apps/mobile `TalosPush`, IOS-SPEC WP-I5). Feature-detected on the globals the shell
// injects: a browser, the Home Screen app, or an older shell build answers "no plugin" and nothing is called. Everything
// the plugin hands back is validated here, because it crosses from native code into the page.
//
// The plugin never talks to the relay and never receives a relay address: it asks iOS for permission and a token, and
// reports taps on a notification. The page signs and sends the registration.
import { APNS_ENVS, type ApnsEnvT, ApnsToken, NativeNavigate, RawP256 } from '@talos-app/protocol'
import { createHttp } from './http.ts'
import { isNativeShell } from './native.ts'

type Method = (options?: Record<string, unknown>) => Promise<unknown>
type Listener = (event: unknown) => void
type Plugin = Partial<Record<'getStatus' | 'register' | 'unregister', Method>> & {
  addListener?: (event: string, cb: Listener) => Promise<{ remove?: () => unknown }> | { remove?: () => unknown }
}

function plugin(scope: unknown): Plugin | null {
  try {
    const p = (scope as { Capacitor?: { Plugins?: { TalosPush?: unknown } } } | null | undefined)?.Capacitor?.Plugins
      ?.TalosPush
    return typeof p === 'object' && p !== null ? (p as Plugin) : null
  } catch {
    return null
  }
}

/** True inside the iPhone shell, when this build of the shell has the push plugin. */
export function nativePushAvailable(scope: unknown = globalThis): boolean {
  return isNativeShell(scope) && plugin(scope) !== null
}

export type NativePermission = 'granted' | 'denied' | 'prompt'
/** Why `register` did not produce a token. `unavailable` = this build has no push capability (a free Apple account). */
export type NativePushFailure = 'denied' | 'unavailable' | 'prompt' | 'timeout' | 'failed' | 'invalid' | 'missing'

export class NativePushError extends Error {
  readonly code: NativePushFailure
  constructor(code: NativePushFailure) {
    super(code)
    this.name = 'NativePushError'
    this.code = code
  }
}

const FAILURES = new Set<NativePushFailure>(['denied', 'unavailable', 'prompt', 'timeout', 'failed'])
const CARD_PATH = /^\/card\/c_[0-9A-HJKMNP-TV-Z]{26}$/

/**
 * What iOS holds for this app: the notification permission (anything unexpected reads as 'prompt', never as granted) and
 * whether this build can get a token at all (`capable: false` = it was signed without the push capability; an older shell
 * that does not say reads as capable, and the register call finds out).
 */
export async function nativeStatus(
  scope: unknown = globalThis,
): Promise<{ permission: NativePermission; capable: boolean }> {
  try {
    const p = plugin(scope)
    if (!nativePushAvailable(scope) || !p?.getStatus) throw new NativePushError('missing')
    const r = (await p.getStatus()) as { permission?: unknown; capable?: unknown } | null
    return {
      permission: r?.permission === 'granted' || r?.permission === 'denied' ? r.permission : 'prompt',
      capable: r?.capable !== false,
    }
  } catch (e) {
    if (e instanceof NativePushError) throw e
    return { permission: 'prompt', capable: true }
  }
}

export async function nativePermission(scope: unknown = globalThis): Promise<NativePermission> {
  return (await nativeStatus(scope)).permission
}

/**
 * Asks iOS for a token. `prompt: true` may show the permission dialog and must only come from a tap; `prompt: false`
 * only refreshes a grant the owner already gave. Throws NativePushError, never anything else.
 */
export async function registerNative(
  opts: { prompt: boolean },
  scope: unknown = globalThis,
): Promise<{ token: string; env: ApnsEnvT }> {
  const p = plugin(scope)
  if (!nativePushAvailable(scope) || !p?.register) throw new NativePushError('missing')
  let r: unknown
  try {
    r = await p.register({ prompt: opts.prompt })
  } catch (e) {
    const code = String((e as { code?: unknown; message?: unknown } | null)?.code ?? (e as Error | null)?.message ?? '')
    throw new NativePushError(FAILURES.has(code as NativePushFailure) ? (code as NativePushFailure) : 'invalid')
  }
  const token = ApnsToken.safeParse((r as { token?: unknown } | null)?.token)
  const env = (r as { env?: unknown } | null)?.env
  if (!token.success || !APNS_ENVS.includes(env as ApnsEnvT)) throw new NativePushError('invalid')
  return { token: token.data, env: env as ApnsEnvT }
}

export async function unregisterNative(scope: unknown = globalThis): Promise<void> {
  try {
    await plugin(scope)?.unregister?.()
  } catch {
    /* the relay forgetting the token is what stops pushes; iOS can keep its copy */
  }
}

/**
 * Taps on a notification (or on its Open / Approve button). The path is the in-app path the relay put in the payload; it
 * is validated like every path a shell may hand the page, and anything else is dropped. `Approve` opens the card armed (in memory, not in the URL):
 * Face ID still comes first for a high-risk card, and nothing is approved by the link itself.
 */
export function onNativePushAction(
  nav: (path: string, opts?: { arm?: string }) => void,
  scope: unknown = globalThis,
): () => void {
  try {
    const p = plugin(scope)
    if (!nativePushAvailable(scope) || typeof p?.addListener !== 'function') return () => {}
    let removed = false
    let handle: { remove?: () => unknown } | null = null
    const attach = p.addListener('action', (event) => {
      const e = event as { navigate?: unknown; action?: unknown } | null
      const path = NativeNavigate.shape.path.safeParse(e?.navigate)
      if (!path.success) return
      // Approve on a card opens that card armed: a high-risk card starts its normal Approve flow, which asks for
      // Face ID before anything is sent; any other card is shown with its button focused. Nothing approves by itself.
      // Only a bare /card/<id> path can be armed. Open, and every other path, never is.
      // The arm travels in memory (the second argument), never in the URL: a link in agent text cannot carry it.
      if (e?.action === 'approve' && CARD_PATH.test(path.data))
        nav(path.data, { arm: path.data.slice('/card/'.length) })
      else nav(path.data)
    })
    void Promise.resolve(attach)
      .then((h) => {
        handle = h ?? null
        if (removed) void handle?.remove?.()
      })
      .catch(() => {})
    return () => {
      removed = true
      try {
        void handle?.remove?.()
      } catch {
        /* nothing to remove */
      }
    }
  } catch {
    return () => {}
  }
}

/** The app icon's number: what is waiting on the owner. Fire and forget; iOS ignores it without the Badge permission. */
export function setNativeBadge(count: number, scope: unknown = globalThis): void {
  try {
    const p = plugin(scope) as { setBadge?: Method } | null
    if (!nativePushAvailable(scope) || !p?.setBadge) return
    void Promise.resolve(p.setBadge({ count: Math.max(0, Math.min(99_999, Math.trunc(count))) })).catch(() => {})
  } catch {
    /* a native call must never break the page */
  }
}

// Apple only ever sees `thread:general` / `thread:inbox` for the two built-in threads and `thread:<opaque ref>` for every
// other (`forApple`, relay push.ts). So everything the phone does with a delivered notification, silencing it on screen
// or clearing it once read, is keyed on that ref, which the relay hands to a signed-in session.
const APPLE_NAMED = new Set(['general', 'inbox'])
const refs = new Map<string, string>()
const REF = /^r_[A-Za-z0-9_-]{16}$/

type RefFetcher = (thread: string) => Promise<unknown>
const fetchThreadRef: RefFetcher = async (thread) =>
  createHttp().get(`/api/push/thread-ref/${encodeURIComponent(thread)}`)

/**
 * The key Apple's notifications carry for a thread (`thread:<key>`): the id itself for General and Inbox, the relay's
 * opaque ref for any other thread, or null when it cannot be learned (signed out, offline, a thread the relay does not
 * know). Cached after the first answer; a failure is never cached, so the next call asks again.
 */
export async function appleThreadKey(thread: string, fetchRef: RefFetcher = fetchThreadRef): Promise<string | null> {
  if (APPLE_NAMED.has(thread)) return thread
  const have = refs.get(thread)
  if (have) return have
  try {
    const r = (await fetchRef(thread)) as { ref?: unknown } | null
    if (typeof r?.ref !== 'string' || !REF.test(r.ref)) return null
    refs.set(thread, r.ref)
    return r.ref
  } catch {
    return null
  }
}

let viewingSeq = 0
/** The named thread on screen whose ref lookup failed: asked again when the socket next answers (`retryNativeViewing`). */
let unresolvedViewing: string | null = null

/**
 * The thread the page shows right now (null when none), so a push for it that arrives in the open app stays quiet.
 * A named thread is told to the shell by its ref (the only thing its notifications carry); until the ref is known nothing
 * is silenced, so the worst case is one banner, never a swallowed one.
 */
export function setNativeViewing(
  thread: string | null,
  scope: unknown = globalThis,
  fetchRef: RefFetcher = fetchThreadRef,
): void {
  const seq = ++viewingSeq
  try {
    const p = plugin(scope) as { setViewing?: Method } | null
    if (!nativePushAvailable(scope) || !p?.setViewing) return
    const tell = (key: string | null) => void Promise.resolve(p.setViewing?.({ thread: key })).catch(() => {})
    if (thread === null || APPLE_NAMED.has(thread)) {
      unresolvedViewing = null
      tell(thread)
      return
    }
    tell(null) // leaving the previous thread at once; the new one is told when its ref arrives
    unresolvedViewing = thread
    void appleThreadKey(thread, fetchRef).then((key) => {
      if (seq !== viewingSeq) return // the owner has moved on since asking: drop it
      if (key) {
        unresolvedViewing = null
        tell(key)
      }
      // no key (offline, cold start): `unresolvedViewing` stays, and the next ready asks again
    })
  } catch {
    /* a native call must never break the page */
  }
}

/** Asks again for the ref of a named thread on screen whose first lookup failed. A no-op when nothing is waiting. */
export function retryNativeViewing(scope: unknown = globalThis, fetchRef: RefFetcher = fetchThreadRef): void {
  if (unresolvedViewing !== null) setNativeViewing(unresolvedViewing, scope, fetchRef)
}

/**
 * Takes read notifications off the lock screen and Notification Center: every delivered one whose `thread-id` is in `tags`
 * (`thread:<key>` or `card:<id>`). Fire and forget; an older shell without the method does nothing.
 */
export function clearNativeDelivered(tags: readonly string[], scope: unknown = globalThis): void {
  try {
    const p = plugin(scope) as { clearDelivered?: Method } | null
    if (!nativePushAvailable(scope) || !p?.clearDelivered || tags.length === 0) return
    void Promise.resolve(p.clearDelivered({ tags: tags.slice(0, 50) })).catch(() => {})
  } catch {
    /* a native call must never break the page */
  }
}

/**
 * The two public keys the notification extension and the action signer use (docs/IOS-PUSH.md "Message text and quick
 * actions"). The shell makes them in the shared Keychain the first time and returns only the public halves. Null when this
 * build of the shell has no such call (an older app): notifications then stay the fixed phrase, nothing breaks.
 */
export async function nativeKeys(scope: unknown = globalThis): Promise<{ encPub: string; actPub: string } | null> {
  const p = plugin(scope) as { nativeKeys?: Method } | null
  if (!nativePushAvailable(scope) || typeof p?.nativeKeys !== 'function') return null
  const r = (await p.nativeKeys()) as { enc_pub?: unknown; act_pub?: unknown } | null
  const enc = RawP256.safeParse(r?.enc_pub)
  const act = RawP256.safeParse(r?.act_pub)
  if (!enc.success || !act.success) throw new NativePushError('invalid')
  return { encPub: enc.data, actPub: act.data }
}

/** True when this build of the shell can hold a grant at all (an older one cannot, so there is nothing to revoke). */
export function nativeGrantSupported(scope: unknown = globalThis): boolean {
  const p = plugin(scope) as { nativeKeys?: unknown } | null
  return nativePushAvailable(scope) && typeof p?.nativeKeys === 'function'
}

/** Hands the shell the grant the relay just accepted. The shell keeps it only if it names its own keys. */
export async function storeNativeGrant(grantJson: string, scope: unknown = globalThis): Promise<void> {
  const p = plugin(scope) as { storeGrant?: Method } | null
  if (!nativePushAvailable(scope) || typeof p?.storeGrant !== 'function') throw new NativePushError('missing')
  await p.storeGrant({ grant: grantJson })
}

/** Turn off or sign out: the shell deletes the grant and both private keys. Never throws; a shell without the call has none. */
export async function clearNativeGrant(scope: unknown = globalThis): Promise<void> {
  try {
    await (plugin(scope) as { clearGrant?: Method } | null)?.clearGrant?.()
  } catch {
    /* the relay no longer holds the grant either way */
  }
}
