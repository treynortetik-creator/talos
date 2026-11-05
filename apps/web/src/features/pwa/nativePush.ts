// Native push for the iPhone app (IOS-SPEC WP-I5): the state the Settings row shows, and the three things it can do. The
// state is read from two places that can each disagree with the other (iOS holds the permission, the relay holds the
// token) and the row says what is actually true, including "Needs setup" when push cannot work yet.
//
//   permission is asked ONLY from a tap (`enableNativePush`). Opening the app never prompts: if iOS already says
//   "granted" and the relay knows this phone, the token is refreshed quietly (`refreshNativeOnOpen`).
import {
  type ApnsEnvT,
  type ApnsStatusT,
  GRANT_MAX_LIFETIME_MS,
  GRANT_RENEW_BEFORE_MS,
  GRANT_SCOPES,
} from '@talos-app/protocol'
import { create } from 'zustand'
import { type TalosClient, TalosClientError } from '../../lib/client.ts'
import { createHttp, type Http, HttpError } from '../../lib/http.ts'
import { isNativeShell } from '../../lib/native.ts'
import {
  clearNativeGrant,
  NativePushError,
  nativeGrantSupported,
  nativeKeys,
  nativePermission,
  nativePushAvailable,
  nativeStatus,
  registerNative,
  storeNativeGrant,
  unregisterNative,
} from '../../lib/nativePush.ts'
import {
  choice,
  choiceGeneration,
  grantStored,
  resetNativeChoicesForTests,
  setChoice,
  setGrantStored,
  setTextChoice,
  textChoice,
} from './nativeChoice.ts'

export type NativePushView =
  | { kind: 'hidden' }
  | { kind: 'checking' }
  /** Push cannot work yet. `why` says what is missing, in words the row can show. */
  | { kind: 'needs_setup'; why: 'build' | 'server' | 'capability' }
  | { kind: 'off' }
  | { kind: 'blocked' }
  | { kind: 'on' }
  | { kind: 'error'; message: string }

/** Whether this phone can show message text and quick actions: the relay holds a current grant for it. Null = not known. */
type State = {
  view: NativePushView
  busy: boolean
  note: string | null
  /** Text is on only when the owner chose it, this phone holds the keys, and the relay holds the grant. Null = not known. */
  rich: boolean | null
  /** The owner's choice is "no text" but the relay still holds a grant: taking it back has not reached the server yet. */
  pendingRevoke: boolean
}
export const useNativePush = create<State>(() => ({
  view: isNativeShell() ? { kind: 'checking' } : { kind: 'hidden' },
  busy: false,
  note: null,
  rich: null,
  pendingRevoke: false,
}))

const set = (p: Partial<State>) => useNativePush.setState(p)

/** Bumped by every tap that changes the owner's choice; an in-flight refresh that started before it must not post. */
let epoch = 0
/** A registration failed because this build has no push capability. Stays until the page reloads (a rebuilt app) or a token arrives. */
let capabilityMissing = false
const defaultHttp = createHttp()

function nonce(): string {
  const b = new Uint8Array(18)
  crypto.getRandomValues(b)
  return btoa(String.fromCharCode(...b))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '')
}

type Deps = { client: TalosClient; http?: Http; scope?: unknown; now?: () => Date }

async function postSigned(
  d: Deps,
  body: { op: 'register'; token: string; env: ApnsEnvT } | { op: 'unregister' },
): Promise<void> {
  const frame = await d.client.signOwnerFrame({
    v: 1,
    type: 'push.apns',
    ...body,
    ts: (d.now?.() ?? new Date()).toISOString(),
    nonce: nonce(),
  })
  await (d.http ?? defaultHttp).json('POST', '/api/push/apns', frame)
}

type GrantStatus = { registered: boolean; exp?: string }

/**
 * Makes this phone's notification grant: the shell makes (or returns) its two public keys, the device key signs them, the
 * relay accepts the grant, and only then is the grant handed back to the shell. A shell without the call, or any failure,
 * leaves notifications as the fixed phrase; it never fails Turn on. Returns whether the phone now has a grant.
 */
export async function registerNativeGrant(d: Deps, stillOnIn: () => boolean = () => true): Promise<boolean> {
  const scope = d.scope ?? globalThis
  // Sign-out or a revoke while the relay was taking the grant ends the attempt, whoever asked for it.
  const gen = choiceGeneration()
  const stillOn = () => stillOnIn() && gen === choiceGeneration()
  try {
    const keys = await nativeKeys(scope)
    if (!keys || !stillOn()) return false
    const now = (d.now?.() ?? new Date()).getTime()
    const frame = await d.client.signOwnerFrame({
      v: 1,
      type: 'native.grant',
      enc_pub: keys.encPub,
      act_pub: keys.actPub,
      scopes: [...GRANT_SCOPES],
      ts: new Date(now).toISOString(),
      exp: new Date(now + GRANT_MAX_LIFETIME_MS).toISOString(),
      nonce: nonce(),
    })
    if (!stillOn()) return false
    await (d.http ?? defaultHttp).json('POST', '/api/push/grant', frame)
    if (!stillOn()) {
      // Turn off ran while the relay was taking the grant. Its revoke may already have been sent, so take this one back too
      // and keep the keys off the phone.
      await revokeNativeGrant(d)
      return false
    }
    try {
      await storeNativeGrant(JSON.stringify(frame), scope)
    } catch {
      // The relay accepted a grant the phone could not keep: it could never open anything, and the relay would go on
      // sealing text for keys that are not there. Take it back rather than leave the two sides disagreeing.
      await revokeNativeGrant(d)
      return false
    }
    setGrantStored(true)
    return true
  } catch {
    return false
  }
}

/**
 * Takes the grant away, on this phone first (so nothing more can be signed) and then at the relay. Returns whether the
 * relay confirmed; false means the phone is clear but the server still holds the grant, and `reconcileGrant` retries on
 * every open until it is gone.
 */
async function revokeNativeGrant(d: Deps): Promise<boolean> {
  if (!nativeGrantSupported(d.scope ?? globalThis)) return true // an older shell never made one
  await clearNativeGrant(d.scope ?? globalThis)
  setGrantStored(false)
  try {
    const frame = await d.client.signOwnerFrame({
      v: 1,
      type: 'native.grant.revoke',
      ts: (d.now?.() ?? new Date()).toISOString(),
      nonce: nonce(),
    })
    await (d.http ?? defaultHttp).json('POST', '/api/push/grant', frame)
    return true
  } catch {
    // Turn off must not fail on this. The phone can no longer open or sign anything, the row says the server has not
    // confirmed, and the next open asks again; the grant also ends by its own date (30 days at most).
    return false
  }
}

/**
 * The owner's choice is "no text" (never tapped, tapped off, signed out, blocked, or page storage cleared) but the relay
 * still holds a grant for this phone: take it back. Quiet; any failure is retried on the next open. Returns whether the
 * relay still holds one afterwards.
 */
async function reconcileGrant(d: Deps, st: GrantStatus, started: number): Promise<boolean> {
  if (!st.registered) return false
  if (textChoice() === 'on') return true // the owner wants text; renewing it is `renewNativeGrant`'s job
  if (epoch !== started || useNativePush.getState().busy) return true // a tap is changing it right now
  const ok = await revokeNativeGrant(d)
  return !ok
}

/** Renews a grant that is missing or has less than 20 days left. Quiet; run after a token refresh on open. */
async function renewNativeGrant(d: Deps, stillOn: () => boolean): Promise<void> {
  if (!nativeGrantSupported(d.scope ?? globalThis)) return
  // Text was never turned on, or was turned off: a missing grant is the owner's answer, not a fault to repair.
  if (textChoice() !== 'on') return
  const st = await (d.http ?? defaultHttp).get<GrantStatus>('/api/push/grant').catch(() => null)
  if (!st) return
  const left = st.registered && st.exp ? Date.parse(st.exp) - (d.now?.() ?? new Date()).getTime() : 0
  // The relay's grant is only good if this phone still holds the keys that go with it (idle expiry and sign-out empty the
  // Keychain while the relay keeps its copy).
  if (left >= GRANT_RENEW_BEFORE_MS && grantStored()) {
    set({ rich: true })
    return
  }
  const rich = await registerNativeGrant(d, () => stillOn() && textChoice() === 'on')
  // A Turn off during the renewal owns the row; do not write a stale answer over it.
  if (stillOn()) set({ rich, pendingRevoke: false })
}

/**
 * The one rule for "iOS says notifications are blocked", shared by the Settings row and the open-time refresh. The owner's text
 * choice ends and the phone's keys go, whether or not the relay can be reached (re-allowing notifications and tapping Turn on
 * must not bring text back). If the relay still holds this phone's token it is told to forget it and the grant is taken back.
 * Quiet: a failure here is retried by the next open.
 */
async function denyLocally(d: Deps): Promise<void> {
  setTextChoice('off')
  if (nativeGrantSupported(d.scope ?? globalThis)) {
    await clearNativeGrant(d.scope ?? globalThis).catch(() => {})
    setGrantStored(false)
  }
}
async function enforceDenied(d: Deps, registered: boolean, started: number): Promise<void> {
  await denyLocally(d)
  if (epoch !== started) return
  try {
    // A grant can outlive the token (the relay dropped the token, the grant stayed): ask, and take it back if it is there.
    if (nativeGrantSupported(d.scope ?? globalThis)) {
      const g = await (d.http ?? defaultHttp).get<GrantStatus>('/api/push/grant').catch(() => null)
      if ((g ? g.registered : registered) && epoch === started) await revokeNativeGrant(d)
    }
    if (registered && epoch === started) {
      setChoice('off')
      await postSigned(d, { op: 'unregister' })
    }
  } catch {
    /* the next open asks again */
  }
}

/** Words for a relay refusal, so the row can tell the owner what to do. */
function describeFailure(e: unknown): NativePushView {
  if (e instanceof HttpError) {
    const code = (e.body as { error?: string } | undefined)?.error
    if (e.status === 409 && code === 'not_configured') return { kind: 'needs_setup', why: 'server' }
    if (e.status === 400 && code === 'stale')
      return { kind: 'error', message: "This phone's clock is off. Set date and time to automatic, then try again." }
    if (e.status === 403 || e.status === 401)
      return { kind: 'error', message: 'Your Mac has not confirmed this phone yet.' }
  }
  if (e instanceof TalosClientError && e.code === 'rate_limited')
    return { kind: 'error', message: 'Too many tries. Wait a few minutes.' }
  return { kind: 'error', message: "Couldn't reach your server. Try again." }
}

/** Reads the truth: shell plugin, relay configuration, iOS permission, and whether the relay has this phone's token. */
export async function refreshNativePush(d: Deps): Promise<NativePushView> {
  const scope = d.scope ?? globalThis
  const started = epoch
  let view: NativePushView
  let deniedRegistered: boolean | null = null
  if (!isNativeShell(scope)) view = { kind: 'hidden' }
  else if (!nativePushAvailable(scope)) view = { kind: 'needs_setup', why: 'build' }
  else if (capabilityMissing) view = { kind: 'needs_setup', why: 'capability' }
  else {
    try {
      const st = await (d.http ?? defaultHttp).get<ApnsStatusT>('/api/push/apns')
      if (!st.configured) view = { kind: 'needs_setup', why: 'server' }
      else {
        const { permission: perm, capable } = await nativeStatus(scope)
        if (capable && perm === 'denied') deniedRegistered = st.registered
        view = !capable
          ? { kind: 'needs_setup', why: 'capability' }
          : perm === 'denied'
            ? { kind: 'blocked' }
            : perm === 'granted' && st.registered
              ? { kind: 'on' }
              : { kind: 'off' }
      }
    } catch (e) {
      view = e instanceof HttpError && e.status === 404 ? { kind: 'needs_setup', why: 'server' } : describeFailure(e)
      // A status check that failed is "couldn't check", never a guess in either direction.
      if (view.kind === 'error') view = { kind: 'error', message: "Couldn't check notifications. Try again." }
    }
  }
  // A note belongs to the view it was written under ("Notifications are on." must not sit under Blocked).
  useNativePush.setState((s) => ({ view, ...(s.view.kind !== view.kind ? { note: null } : {}) }))
  // Blocked: the text choice ends here too, not only on an open (a block seen only by this row must still end it).
  if (deniedRegistered !== null) await enforceDenied(d, deniedRegistered, started)
  // Text in the notification needs a grant at the relay; whether it has one is a separate fact from "push is on".
  if (view.kind === 'on' && nativeGrantSupported(scope)) {
    const st = await (d.http ?? defaultHttp).get<GrantStatus>('/api/push/grant').catch(() => null)
    if (!st) set({ rich: null, pendingRevoke: false })
    else {
      const wanted = textChoice() === 'on' && grantStored()
      // Both sides must agree before the row says text is on; if the owner said no and the server still has one, say so.
      set({ rich: wanted && st.registered, pendingRevoke: !wanted && st.registered })
    }
  } else set({ rich: null, pendingRevoke: false })
  return view
}

/** Turn on starts with no grant anywhere: keys off the phone always, and the relay's copy revoked if it has one (or we cannot tell). */
async function dropGrantForTurnOn(d: Deps): Promise<void> {
  const scope = d.scope ?? globalThis
  if (!nativeGrantSupported(scope)) return
  const st = await (d.http ?? defaultHttp).get<GrantStatus>('/api/push/grant').catch(() => null)
  if (grantStored() || st === null || st.registered) await revokeNativeGrant(d)
  else await clearNativeGrant(scope).catch(() => {})
}

/** Tap handler for "Turn on". The only place that can show the iOS permission dialog. */
export async function enableNativePush(d: Deps): Promise<void> {
  if (useNativePush.getState().busy) return
  set({ busy: true, note: null })
  epoch++
  try {
    // Turn on starts from the fixed phrase, always: text is a separate tap. A leftover 'on' must not come back with it.
    setTextChoice('off')
    // ...and any grant still alive from before (the relay kept one, or the phone still holds keys) is taken back first:
    // otherwise the relay would go on sealing text for a row that says fixed phrase. A relay that cannot be reached leaves
    // `pendingRevoke` on the row and the next open asks again.
    await dropGrantForTurnOn(d)
    const { token, env } = await registerNative({ prompt: true }, d.scope ?? globalThis)
    capabilityMissing = false
    await postSigned(d, { op: 'register', token, env })
    setChoice('on')
    // Turn on never makes a grant. Message text and the Reply / Approve buttons start when the owner taps "Show message text"
    // (`setNativeText`); until then every notification is the fixed phrase, for a new phone, for Turn off then on, and for a
    // phone that had notifications on before this feature.
    await refreshNativePush(d)
    set({ note: 'Notifications are on.' })
  } catch (e) {
    if (e instanceof NativePushError) {
      if (e.code === 'denied') set({ view: { kind: 'blocked' } })
      else if (e.code === 'unavailable') {
        capabilityMissing = true
        set({ view: { kind: 'needs_setup', why: 'capability' } })
      } else if (e.code === 'missing') set({ view: { kind: 'needs_setup', why: 'build' } })
      else set({ view: { kind: 'error', message: "Couldn't turn notifications on. Try again." } })
    } else set({ view: describeFailure(e) })
  } finally {
    set({ busy: false })
  }
}

/**
 * The "message text" switch, separate from Turn off. Off: the grant is taken away on the phone first (nothing more can be
 * signed or opened) and then at the relay, and notifications keep working as the fixed phrase. On: a new grant, made now,
 * from a tap. Either way the choice is remembered, so opening the app never flips it back.
 */
export async function setNativeText(d: Deps, on: boolean): Promise<void> {
  if (useNativePush.getState().busy) return
  set({ busy: true, note: null })
  epoch++ // an open-time renewal that is mid-flight must not bring a grant back
  try {
    if (on) {
      const ok = await registerNativeGrant(d)
      if (ok) setTextChoice('on')
      set({
        rich: ok,
        ...(ok ? { pendingRevoke: false } : {}),
        note: ok ? 'Message text is on.' : "Couldn't turn on message text. Notifications still work.",
      })
    } else {
      setTextChoice('off')
      const gone = await revokeNativeGrant(d)
      set({
        rich: false,
        pendingRevoke: !gone,
        note: gone
          ? 'Notifications now show a fixed phrase.'
          : "Message text is off on this phone. Your server hasn't confirmed yet; Talos will keep trying.",
      })
    }
  } finally {
    set({ busy: false })
  }
}

export async function disableNativePush(d: Deps): Promise<void> {
  if (useNativePush.getState().busy) return
  set({ busy: true, note: null })
  epoch++
  setChoice('off')
  setTextChoice('off') // text is a separate opt-in: Turn on later starts from the fixed phrase again
  try {
    const gone = await revokeNativeGrant(d)
    await postSigned(d, { op: 'unregister' })
    await unregisterNative(d.scope ?? globalThis)
    set({ rich: false, pendingRevoke: !gone })
    await refreshNativePush(d)
    set({ note: 'Notifications are off.' })
  } catch (e) {
    set({ view: describeFailure(e) })
  } finally {
    set({ busy: false })
  }
}

/**
 * On every open, never prompting: if iOS already allows notifications and the relay knows this phone, hand the relay the
 * current token (iOS may have rotated it). Anything else does nothing.
 */
export async function refreshNativeOnOpen(d: Deps): Promise<void> {
  const scope = d.scope ?? globalThis
  if (!nativePushAvailable(scope)) return
  const started = epoch
  try {
    // The permission is read before the network, so an offline open still ends the text choice on a block.
    const perm = await nativePermission(scope)
    if (perm === 'denied') await denyLocally(d)
    const st = await (d.http ?? defaultHttp).get<ApnsStatusT>('/api/push/apns')
    if (!st.configured) return
    if (perm === 'denied') {
      // iOS notifications are off for Talos but the relay still holds a token: APNs would keep answering 200 and the
      // relay would think the phone was told. Tell it (M4). The owner's choice becomes 'off' until Turn on is tapped again.
      await enforceDenied(d, st.registered, started)
      return
    }
    // A "no text" choice the relay has not heard yet (offline when it was tapped, signed out, storage cleared): say it again.
    if (nativeGrantSupported(scope)) {
      const g = await (d.http ?? defaultHttp).get<GrantStatus>('/api/push/grant').catch(() => null)
      if (g) {
        const held = await reconcileGrant(d, g, started)
        set({ pendingRevoke: held && textChoice() !== 'on' })
      }
    }
    // Only a phone the owner turned on (or the relay still holds, after cleared page storage), and not off since. The relay forgetting the token (Apple's 410 after a rotation)
    // is not a reason to stay silent (M1).
    // Cleared page storage (no recorded choice) must not silence a phone the relay still holds; an explicit 'off' always wins.
    const chosen = choice()
    if (perm !== 'granted' || chosen === 'off' || (chosen === null && !st.registered)) return
    const { token, env } = await registerNative({ prompt: false }, scope)
    // Turn off (or on) while iOS was thinking wins: do not post a token the owner just withdrew (L4).
    if (epoch !== started || choice() === 'off') return
    await postSigned(d, { op: 'register', token, env })
    const stillOn = () => epoch === started && choice() !== 'off'
    if (stillOn()) await renewNativeGrant(d, stillOn)
  } catch {
    /* quiet by design: Settings shows the truth when the owner looks */
  }
}

/** Tests only: forget what this page load remembered. */
export function resetNativePushForTests(): void {
  epoch = 0
  capabilityMissing = false
  resetNativeChoicesForTests()
}

/**
 * Re-checks when the app comes back to the front, at most once every 5 minutes: a suspended app that resumes is not a cold
 * start, and iOS may have rotated the token or the owner changed the permission while it slept (review R10). `push_apns`
 * allows 60 registrations an hour per IP; this spends at most 12 an hour, and the open-time refresh runs once per page load
 * (not per route change or `me` re-read).
 */
export function startNativeResume(
  d: Deps,
  opts: { now?: () => number; every?: number; onChange?: () => void } = {},
): () => void {
  if (typeof document === 'undefined') return () => {}
  const now = opts.now ?? Date.now
  const every = opts.every ?? 5 * 60_000
  let last = now()
  const on = () => {
    if (document.visibilityState !== 'visible' || now() - last < every) return
    last = now()
    void refreshNativeOnOpen(d).then(() => opts.onChange?.())
  }
  document.addEventListener('visibilitychange', on)
  return () => document.removeEventListener('visibilitychange', on)
}
