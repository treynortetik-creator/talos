// WebAuthn calls (SimpleWebAuthn browser) against the relay's auth routes, and the two halves of enrollment (5.3).
import { startAuthentication, startRegistration } from '@simplewebauthn/browser'
import {
  bindingMac,
  type DeviceKey,
  deriveEnrollAuth,
  deriveEnrollBind,
  enrollAuthHash,
  enrollCodeId,
  fingerprintWords,
  loginProofCodeId,
  normalizeEnrollCode,
  routes,
  SESSION_PROOF_CODE_ID,
  signDeviceProof,
} from '@talos-app/protocol'
import { loadDeviceKey } from '../../lib/deviceKey.ts'
import { createHttp, HttpError } from '../../lib/http.ts'
import { getShell, inShell } from '../../lib/native/shell.ts'
import type { SocketClient } from '../../lib/socketClient.ts'
import type { Storage } from '../../lib/storage.ts'
import { useSession } from './session.ts'

const http = createHttp()

type RegOpts = Parameters<typeof startRegistration>[0]['optionsJSON']
type AuthOpts = Parameters<typeof startAuthentication>[0]['optionsJSON']

export class EnrollError extends Error {
  readonly kind: 'expired' | 'cancelled' | 'failed' | 'invalid_link' | 'rate_limited'
  constructor(kind: EnrollError['kind'], message: string) {
    super(message)
    this.name = 'EnrollError'
    this.kind = kind
  }
}

export function parseSetupLink(input: string): string | null {
  const trimmed = input.trim()
  const hash = trimmed.includes('#') ? trimmed.slice(trimmed.lastIndexOf('#') + 1) : trimmed
  return normalizeEnrollCode(hash)
}

/**
 * An open browser proves its device key without signing out (the relay only asks for a proof at sign-in, and a browser that
 * stays signed in never signs in again). Run once per page load by the session gate. The relay answers `proven` when there
 * is nothing to do. Resolves true when the device is proven afterwards, false when it could not be (no key here, the key
 * is not the one this session is attached to, the network). A failure is returned, not thrown: the app works as before and
 * Settings shows "Key not verified" until a later load succeeds.
 */
export async function proveDeviceInPlace(storage: Storage): Promise<boolean> {
  try {
    const key = await loadDeviceKey(storage)
    if (!key) return false
    const opts = await http.json<{ challenge?: string; proven?: boolean }>('POST', routes.deviceProveOptions.path, {})
    if (opts.proven) return true
    if (!opts.challenge) return false
    const sig = await signDeviceProof(key.privateKey, {
      nonce: opts.challenge,
      codeId: SESSION_PROOF_CODE_ID,
      deviceId: key.deviceId,
    })
    await http.json('POST', routes.deviceProve.path, { nonce: opts.challenge, sig })
    return true
  } catch {
    return false
  }
}

/**
 * Signs in with the passkey. With `storage`, it also names the device key that lives in this storage jar, so the relay
 * attaches the session to the device the Mac already confirmed. Without it the new session has no device, and the app
 * waits forever for a confirmation nobody is going to give (audit D2).
 */
export async function signInWithPasskey(storage?: Storage): Promise<void> {
  const optionsJSON = await http.json<AuthOpts>('POST', routes.loginOptions.path, {})
  const response = await startAuthentication({ optionsJSON })
  const key = storage ? await loadDeviceKey(storage).catch(() => null) : null
  // Prove the device: sign the same challenge the passkey just signed, with the device key (the proof enrollment already
  // uses). A passkey alone, even a synced one, is then not enough to sign in as this device. If signing fails the request
  // goes without a proof, which the relay accepts only for a device that has never proved itself.
  const proof = key
    ? await signDeviceProof(key.privateKey, {
        nonce: optionsJSON.challenge,
        codeId: loginProofCodeId(response.id),
        deviceId: key.deviceId,
      })
        .then((sig) => ({ nonce: optionsJSON.challenge, sig }))
        .catch(() => null)
    : null
  await http.json('POST', routes.loginVerify.path, {
    response,
    ...(key ? { device_id: key.deviceId } : {}),
    ...(proof ? { device_proof: proof } : {}),
  })
  await useSession.getState().refresh()
}

function deviceName(): string {
  if (getShell()) return 'Mac app'
  const ua = navigator.userAgent
  if (/iPhone/.test(ua)) return 'iPhone (Home Screen)'
  if (/iPad/.test(ua)) return 'iPad (Home Screen)'
  if (/Android/.test(ua)) return 'Android phone'
  return 'Desktop browser'
}

const isDomError = (e: unknown, name: string) => e instanceof Error && e.name === name

/** Half 1 then half 2. Resolves with the new device id; the caller then waits for the Mac's y/N. */
export async function runEnrollment(
  code: string,
  client: SocketClient,
): Promise<{ deviceId: string; words: string[] }> {
  const normalized = normalizeEnrollCode(code)
  if (!normalized) throw new EnrollError('invalid_link', 'This setup link is not valid.')
  const codeAuth = deriveEnrollAuth(normalized)
  try {
    // A session that already exists (earlier passkey) skips registration entirely.
    let status = await useSession.getState().refresh()
    // A shell that kept the cookie of an EARLIER setup code (that code burned or expired, or the Mac said N or never
    // answered) is signed in but not pinned, and the relay pins a setup-code session only with the code that minted it.
    // Sending this new code on that old session is refused 410 and counts toward burning the new code, so trade the new
    // code for a fresh session first. A pinned session is left alone.
    const leftover = inShell() && status === 'authed' && useSession.getState().me?.device_pinned !== true
    if ((status !== 'authed' || leftover) && inShell()) {
      // A native shell cannot do passkeys in its web view: it trades the live setup code for an unpinned session
      // (WP-N0). The device key below and the Mac's `y` pin it, exactly as for a passkey session.
      await http.json('POST', routes.enrollSession.path, { code_auth: codeAuth })
      status = await useSession.getState().refresh()
      if (status !== 'authed') throw new EnrollError('failed', 'Could not sign in with the setup code.')
      // An earlier limited socket may still be open on the old session (it gets closed 4401 on its next ping and does not
      // retry): open a fresh one on the new session so a Mac `N` reaches the confirm screen.
      client.reconnect()
    } else if (status !== 'authed') {
      try {
        const optionsJSON = await http.json<RegOpts>('POST', routes.enrollOptions.path, { code_auth: codeAuth })
        let response: Awaited<ReturnType<typeof startRegistration>> | null = null
        try {
          response = await startRegistration({ optionsJSON })
        } catch (e) {
          // This keychain already holds the passkey (excludeCredentials): sign in with it instead.
          if (!isDomError(e, 'InvalidStateError')) throw e
        }
        if (response) {
          await http.json('POST', routes.enrollVerify.path, {
            code_auth: codeAuth,
            response,
            device_name: deviceName(),
          })
        } else {
          await signInWithPasskey()
        }
      } catch (e) {
        if (isDomError(e, 'NotAllowedError') || isDomError(e, 'AbortError'))
          throw new EnrollError('cancelled', 'Passkey cancelled.')
        throw e
      }
      status = await useSession.getState().refresh()
      if (status !== 'authed') throw new EnrollError('failed', 'Could not sign in after registering the passkey.')
    }
    const pinDevice = async (key: DeviceKey) => {
      const binding = bindingMac(deriveEnrollBind(normalized), key.deviceId, key.publicJwk)
      const payload = {
        device: { id: key.deviceId, name: deviceName(), pubkey_jwk: key.publicJwk },
        binding,
        code_auth: codeAuth,
      }
      try {
        await http.json('POST', routes.deviceVerify.path, payload)
      } catch (e) {
        // Signing in again on a device the Mac already pinned ("no re-pair", spec 5.2 step 5): the relay asks the device to
        // prove it holds the private key by signing a fresh nonce, then the same request goes again with the proof.
        const body =
          e instanceof HttpError && e.status === 409 ? (e.body as { error?: string; challenge?: string }) : null
        if (body?.error !== 'device_proof_required' || typeof body.challenge !== 'string') throw e
        const sig = await signDeviceProof(key.privateKey, {
          nonce: body.challenge,
          codeId: enrollCodeId(enrollAuthHash(codeAuth)),
          deviceId: key.deviceId,
        })
        await http.json('POST', routes.deviceVerify.path, { ...payload, proof: { nonce: body.challenge, sig } })
      }
    }
    let key = await client.ensureDevice()
    try {
      await pinDevice(key)
    } catch (e) {
      // The Mac revoked this browser's key, and the relay never accepts a revoked id again. Make a new key and ask once
      // more instead of looping on "HTTP 409" until the owner clears site data (audit D9).
      const revoked =
        e instanceof HttpError && e.status === 409 && (e.body as { error?: string } | null)?.error === 'device_revoked'
      if (!revoked) throw e
      key = await client.ensureDevice({ replace: true })
      await pinDevice(key)
    }
    return { deviceId: key.deviceId, words: [...fingerprintWords(key.deviceId)] }
  } catch (e) {
    if (e instanceof EnrollError) throw e
    if (e instanceof HttpError && (e.status === 401 || e.status === 403 || e.status === 404 || e.status === 410))
      throw new EnrollError('expired', 'This link expired.')
    if (e instanceof HttpError && e.status === 429) throw new EnrollError('rate_limited', 'Too many tries.')
    throw new EnrollError('failed', e instanceof Error ? e.message : 'Setup failed.')
  }
}
