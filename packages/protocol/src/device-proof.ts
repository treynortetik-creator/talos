// Proof that a caller of POST /api/auth/device/verify holds the device's PRIVATE key (WP-N0 review F1).
//
// Setup-code sessions carry no passkey, so nothing else ties an already-pinned device to the person re-enrolling it. A device
// id and public JWK are not secret (GET /api/devices lists them), so when a session presents a device that is already pinned
// the relay hands out a fresh nonce (409 `device_proof_required`, bound to that session and device, single use, 2 minutes) and
// the device signs it:
//
//   signing input = "talos-device-proof/v1\n" + nonce + "\n" + code_id + "\n" + device_id
//   sig           = base64url of the raw IEEE P1363 ECDSA-SHA256 signature (64 bytes), same key and format as owner frames.
import { b64urlDecode, b64urlEncode, utf8 } from './encoding.ts'
import type { JwkP256T } from './models.ts'
import { deviceIdFromSpki, importDevicePublicKey } from './owner-sig.ts'

const subtle = () => globalThis.crypto.subtle
const SIGN_ALG = { name: 'ECDSA', hash: 'SHA-256' } as const

export const DEVICE_PROOF_DOMAIN = 'talos-device-proof/v1'
export const DEVICE_PROOF_TTL_MS = 120_000
export const DEVICE_PROOF_NONCE_RE = /^[A-Za-z0-9_-]{43}$/

/**
 * Sign-in (POST /api/auth/login/verify) reuses the same proof. The nonce is the WebAuthn login challenge the passkey just
 * signed (relay-made, single use, so it is fresh), and the `code_id` slot carries this label, which names the passkey the
 * sign-in used. An enrollment proof can never pass as a sign-in proof or the other way round, and a proof made for one
 * passkey is useless under another.
 */
export function loginProofCodeId(credentialId: string): string {
  return `login:${credentialId}`
}

/**
 * A signed-in browser can also prove its device key without signing out and in again (POST /api/auth/device/prove), so a
 * browser that is already open upgrades in place. The nonce is a relay-made challenge bound to that session and device
 * (single use), and this label sits in the `code_id` slot. It differs from the sign-in and enrollment labels, so none of the
 * three proofs can stand in for another.
 */
export const SESSION_PROOF_CODE_ID = 'session-prove'

export function deviceProofInput(nonce: string, codeId: string, deviceId: string): string {
  return `${DEVICE_PROOF_DOMAIN}\n${nonce}\n${codeId}\n${deviceId}`
}

/** `privateKey` is the (non-extractable) device key. Returns the 86-char base64url signature. */
export async function signDeviceProof(
  privateKey: CryptoKey,
  args: { nonce: string; codeId: string; deviceId: string },
): Promise<string> {
  const sig = new Uint8Array(
    await subtle().sign(SIGN_ALG, privateKey, utf8(deviceProofInput(args.nonce, args.codeId, args.deviceId))),
  )
  if (sig.length !== 64) throw new Error('unexpected signature length')
  return b64urlEncode(sig)
}

/** Never throws. Also checks that `deviceId` is the id of `pubkey`. */
export async function verifyDeviceProof(
  pubkey: JwkP256T,
  args: { nonce: string; codeId: string; deviceId: string; sig: string },
): Promise<boolean> {
  try {
    if (args.sig.length !== 86) return false
    const sig = b64urlDecode(args.sig)
    if (sig.length !== 64) return false
    const key = await importDevicePublicKey(pubkey)
    const spki = new Uint8Array(await subtle().exportKey('spki', key))
    if (deviceIdFromSpki(spki) !== args.deviceId) return false
    return await subtle().verify(SIGN_ALG, key, sig, utf8(deviceProofInput(args.nonce, args.codeId, args.deviceId)))
  } catch {
    return false
  }
}
