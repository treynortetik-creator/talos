// Can this page run a passkey step-up RIGHT NOW? (IOS-SPEC WP-I6, audit O1.)
//
// A browser and the Home Screen app always can. The Mac app's web view never can. The iPhone app's web view can only when
// the app was built with the Associated Domains entitlement for this relay AND the relay serves an apple-app-site-
// association file naming the app. Without that, WebAuthn in the shell fails as a NotAllowedError, which looks exactly
// like the owner pressing Cancel. This module says the true thing instead, and says it before a challenge is burned.
//
// It changes nothing about the security model: no shortcut, no Face ID stand-in. It only decides whether to ask for the
// same passkey, or to tell the owner where to approve.

import { detectShell } from './native/detect.ts'
import { getShell } from './native/shell.ts'
import { isNativeShell } from './native.ts'

export type PasskeyBlock =
  /** The Mac app: its web view has no passkeys at all. */
  | 'mac_app'
  /** The iPhone app, and the relay does not (yet) link it for passkeys, or this web view has no WebAuthn. */
  | 'not_linked'
  /** The iPhone app, the relay says it is linked, and the passkey prompt still did not finish. */
  | 'shell_declined'

export const AASA_PATH = '/.well-known/apple-app-site-association'

export const PASSKEY_BLOCK_COPY: Record<PasskeyBlock, string> = {
  mac_app: 'Approve on your phone or in a browser.',
  not_linked: "This app can't use your passkey yet. Approve in Safari or the Home Screen app.",
  shell_declined:
    "The passkey prompt didn't finish. If you didn't cancel it, this app isn't linked to your relay for passkeys yet. Approve in Safari or the Home Screen app.",
}

export class PasskeyUnavailableError extends Error {
  readonly reason: PasskeyBlock
  constructor(reason: PasskeyBlock) {
    super(PASSKEY_BLOCK_COPY[reason])
    this.name = 'PasskeyUnavailableError'
    this.reason = reason
  }
}

/** The line to show for a step-up that could not run, or null when the error is something else. */
export const passkeyErrorCopy = (e: unknown): string | null =>
  e instanceof PasskeyUnavailableError ? PASSKEY_BLOCK_COPY[e.reason] : null

let linkedOnce = false
let inFlight: Promise<RelayLink> | null = null
/** Test seam: forget that the relay was seen serving the file. */
export function resetPasskeyGate(): void {
  linkedOnce = false
  inFlight = null
}

/**
 * What the relay's own AASA file says. 'unknown' is a relay or network that could not answer (offline, a 5xx during a
 * redeploy): that says nothing about the build, so it is never reported as "not linked". The next steps (the challenge
 * request, the prompt) then fail with their own truthful error.
 */
type RelayLink = 'linked' | 'not_linked' | 'unknown'

async function readRelayLink(fetchImpl: typeof fetch): Promise<RelayLink> {
  try {
    const res = await fetchImpl(AASA_PATH, { credentials: 'omit', cache: 'no-store', redirect: 'error' })
    if (res.status === 404) return 'not_linked'
    if (!res.ok) return 'unknown'
    const doc = (await res.json().catch(() => null)) as { webcredentials?: { apps?: unknown } } | null
    const apps = doc?.webcredentials?.apps
    return Array.isArray(apps) && apps.length > 0 ? 'linked' : 'not_linked'
  } catch {
    return 'unknown'
  }
}

function relayLink(fetchImpl: typeof fetch): Promise<RelayLink> | RelayLink {
  if (linkedOnce) return 'linked'
  if (inFlight) return inFlight
  const p = readRelayLink(fetchImpl).then((r) => {
    if (r === 'linked') linkedOnce = true
    return r
  })
  inFlight = p
  const clear = () => {
    if (inFlight === p) inFlight = null
  }
  p.then(clear, clear)
  return p
}

const hasWebAuthn = (scope: unknown) =>
  typeof (scope as { PublicKeyCredential?: unknown }).PublicKeyCredential !== 'undefined'

/**
 * Ask the relay about its AASA file ahead of any tap, so the Approve tap does not wait on this lookup before the passkey
 * prompt. WebKit only honours a passkey prompt that follows the tap closely; an extra round trip in between can cost the
 * gesture. Call once the client starts. Only a positive answer is kept, so it never throws and never blocks anything.
 */
export function prewarmPasskeyGate(opts: { scope?: unknown; fetchImpl?: typeof fetch } = {}): void {
  const scope = opts.scope ?? globalThis
  if (getShell() || detectShell(scope) === 'desktop' || !isNativeShell(scope) || !hasWebAuthn(scope)) return
  void relayLink(opts.fetchImpl ?? ((...a) => fetch(...a)))
}

/**
 * Why a passkey step-up cannot run here, or null when it can (or when we cannot tell, which is every browser, and an
 * unreachable relay). Only a positive answer is cached, so a relay that gets fixed starts working without a restart.
 */
export async function passkeyBlock(
  opts: { scope?: unknown; fetchImpl?: typeof fetch } = {},
): Promise<PasskeyBlock | null> {
  const scope = opts.scope ?? globalThis
  if (getShell() || detectShell(scope) === 'desktop') return 'mac_app'
  if (!isNativeShell(scope)) return null
  if (!hasWebAuthn(scope)) return 'not_linked'
  return (await relayLink(opts.fetchImpl ?? ((...a) => fetch(...a)))) === 'not_linked' ? 'not_linked' : null
}

/** In the iPhone shell, a passkey prompt that threw something the owner's own Cancel would also throw. */
export function shellPasskeyDeclined(e: unknown, scope: unknown = globalThis): boolean {
  if (!isNativeShell(scope) || !(e instanceof Error)) return false
  return e.name === 'NotAllowedError' || e.name === 'SecurityError' || e.name === 'NotSupportedError'
}
