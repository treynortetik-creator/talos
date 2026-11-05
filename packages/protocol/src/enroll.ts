// Enrollment codes and the device binding (spec 3.5, 5.3, 4.10).
//   code        128-bit Crockford base32 (26 chars), generated on the Mac, shown in the link fragment only.
//   code_auth   HKDF-SHA256(code, salt "", info "talos-enroll-auth/v1", 32); opens registration at the relay.
//               The relay only ever stores sha256(code_auth).
//   code_bind   HKDF-SHA256(code, salt "", info "talos-enroll-bind/v1", 32); never leaves the phone except as
//   binding     HMAC-SHA256(code_bind, device_id + "\n" + jcs(pubkey_jwk)), recomputed by the Mac. With the passkey's
//               COSE public key (docs/CLAUDE-CODE.md C3.6) the input gains "\n" + credential_public_key, so a relay can
//               neither swap the key nor strip or add it: each changes the MAC input.
import { jcs } from './canonical.ts'
import {
  type Bytes,
  b64urlDecode,
  b64urlEncode,
  CROCKFORD,
  crockfordEncode,
  randomBytes,
  timingSafeEqual,
  utf8,
} from './encoding.ts'
import { hkdfSha256, hmacSha256, sha256Hex } from './hash.ts'
import type { JwkP256T } from './models.ts'
import { deviceIdFromJwk } from './owner-sig.ts'

export const ENROLL_AUTH_INFO = 'talos-enroll-auth/v1'
export const ENROLL_BIND_INFO = 'talos-enroll-bind/v1'
export const ENROLL_CODE_LENGTH = 26

export function newEnrollCode(): string {
  return crockfordEncode(randomBytes(16))
}

/** Uppercases, maps I/L to 1 and O to 0, strips hyphens and spaces. Returns null if the result is not a valid code. */
export function normalizeEnrollCode(input: string): string | null {
  const c = input.toUpperCase().replace(/[\s-]/g, '').replace(/[IL]/g, '1').replace(/O/g, '0')
  if (c.length !== ENROLL_CODE_LENGTH) return null
  for (const ch of c) if (!CROCKFORD.includes(ch)) return null
  if (CROCKFORD.indexOf(c[0] as string) > 7) return null // 26 chars = 130 bits; the top 2 bits of a 128-bit code are 0
  return c
}

function ikm(code: string): Bytes {
  const n = normalizeEnrollCode(code)
  if (!n) throw new Error('invalid enrollment code')
  return utf8(n)
}

/** base64url, sent to the relay as `code_auth`. */
export function deriveEnrollAuth(code: string): string {
  return b64urlEncode(hkdfSha256(ikm(code), new Uint8Array(0), utf8(ENROLL_AUTH_INFO), 32))
}

/** What the relay stores for a code: lowercase hex sha256 of the `code_auth` string (UTF-8 bytes). */
export function enrollAuthHash(codeAuth: string): string {
  return sha256Hex(codeAuth)
}

/** Stable id for a pending code, derivable by the Mac and the relay from the stored hash: first 16 hex chars. */
export function enrollCodeId(codeAuthHash: string): string {
  return codeAuthHash.slice(0, 16)
}

export function deriveEnrollBind(code: string): Bytes {
  return hkdfSha256(ikm(code), new Uint8Array(0), utf8(ENROLL_BIND_INFO), 32)
}

function bindingInput(deviceId: string, pubkeyJwk: JwkP256T, credentialPublicKey?: string): string {
  const base = `${deviceId}\n${jcs(pubkeyJwk)}`
  return credentialPublicKey === undefined ? base : `${base}\n${credentialPublicKey}`
}

/** base64url MAC binding a device id, its public key and (optionally) the passkey public key to the code. */
export function bindingMac(
  codeBind: Uint8Array,
  deviceId: string,
  pubkeyJwk: JwkP256T,
  credentialPublicKey?: string,
): string {
  return b64urlEncode(hmacSha256(codeBind, utf8(bindingInput(deviceId, pubkeyJwk, credentialPublicKey))))
}

export function verifyBinding(
  code: string,
  deviceId: string,
  pubkeyJwk: JwkP256T,
  binding: string,
  credentialPublicKey?: string,
): boolean {
  try {
    const expected = hmacSha256(deriveEnrollBind(code), utf8(bindingInput(deviceId, pubkeyJwk, credentialPublicKey)))
    return timingSafeEqual(expected, b64urlDecode(binding))
  } catch {
    return false
  }
}

/**
 * `verifyBinding` plus the check that `deviceId` really is the id of `pubkeyJwk` (the relay could otherwise pair a
 * valid binding with a device id of its choosing). Use this at the Mac when `device.enrolled` arrives.
 */
export async function verifyEnrollment(
  code: string,
  deviceId: string,
  pubkeyJwk: JwkP256T,
  binding: string,
  credentialPublicKey?: string,
): Promise<boolean> {
  try {
    if ((await deviceIdFromJwk(pubkeyJwk)) !== deviceId) return false
  } catch {
    return false
  }
  return verifyBinding(code, deviceId, pubkeyJwk, binding, credentialPublicKey)
}
