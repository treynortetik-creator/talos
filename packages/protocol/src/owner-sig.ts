// Owner signatures (decision 0002, spec 3.5). WebCrypto only, so the same code runs in browsers, Node and Bun.
//
//   signing input = "talos-owner/v1\n" + device_id + "\n" + sha256Hex(jcs(frame without osig, relay, stepup_token))
//   osig          = base64url of the raw IEEE P1363 ECDSA-SHA256 signature (64 bytes); DER is rejected.
//
// RAW JSON RULE: signOwnerFrame/verifyOwnerFrame take the object exactly as serialized / JSON.parse'd. Never pass a
// zod-parsed value: zod defaults rewrite objects (`.default([])` turns `{}` into `{"a":[]}`) and break the hash.
import { jcs } from './canonical.ts'
import { b64urlDecode, b64urlEncode, base32LowerEncode, utf8 } from './encoding.ts'
import { sha256, sha256Hex } from './hash.ts'
import type { JwkP256T } from './models.ts'

const subtle = () => globalThis.crypto.subtle
const ALG = { name: 'ECDSA', namedCurve: 'P-256' } as const
const SIGN_ALG = { name: 'ECDSA', hash: 'SHA-256' } as const

export const OWNER_SIG_DOMAIN = 'talos-owner/v1'
/** Fields that are not covered by the signature. */
export const UNSIGNED_FIELDS = ['osig', 'relay', 'stepup_token'] as const

export type DeviceKey = {
  /** Non-extractable; store the CryptoKey itself in IndexedDB. */
  privateKey: CryptoKey
  publicKey: CryptoKey
  publicJwk: JwkP256T
  deviceId: string
}

/** `d_` + first 20 chars of lowercase base32(sha256(spki)). */
export function deviceIdFromSpki(spki: Uint8Array): string {
  return `d_${base32LowerEncode(sha256(spki)).slice(0, 20)}`
}

export function toPublicJwk(jwk: JsonWebKey): JwkP256T {
  if (jwk.kty !== 'EC' || jwk.crv !== 'P-256' || !jwk.x || !jwk.y) throw new Error('not a P-256 public JWK')
  return { kty: 'EC', crv: 'P-256', x: jwk.x, y: jwk.y }
}

export async function deviceIdFromJwk(jwk: JwkP256T): Promise<string> {
  const key = await importDevicePublicKey(jwk)
  return deviceIdFromSpki(new Uint8Array(await subtle().exportKey('spki', key)))
}

export async function importDevicePublicKey(jwk: JwkP256T): Promise<CryptoKey> {
  return subtle().importKey('jwk', { ...toPublicJwk(jwk), ext: true }, ALG, true, ['verify'])
}

/** Creates a device key: private key non-extractable, public key always exportable. */
export async function createDeviceKey(): Promise<DeviceKey> {
  const pair = await subtle().generateKey(ALG, false, ['sign', 'verify'])
  const publicJwk = toPublicJwk(await subtle().exportKey('jwk', pair.publicKey))
  const spki = new Uint8Array(await subtle().exportKey('spki', pair.publicKey))
  return { privateKey: pair.privateKey, publicKey: pair.publicKey, publicJwk, deviceId: deviceIdFromSpki(spki) }
}

/**
 * Test helper (extractable key you can persist to JSON). Production code must use createDeviceKey().
 */
export async function createExtractableDeviceKeyForTests(): Promise<DeviceKey & { privateJwk: JsonWebKey }> {
  const pair = await subtle().generateKey(ALG, true, ['sign', 'verify'])
  const privateJwk = await subtle().exportKey('jwk', pair.privateKey)
  const publicJwk = toPublicJwk(await subtle().exportKey('jwk', pair.publicKey))
  const spki = new Uint8Array(await subtle().exportKey('spki', pair.publicKey))
  return {
    privateKey: pair.privateKey,
    publicKey: pair.publicKey,
    publicJwk,
    deviceId: deviceIdFromSpki(spki),
    privateJwk,
  }
}

export async function importDevicePrivateKey(privateJwk: JsonWebKey): Promise<CryptoKey> {
  return subtle().importKey('jwk', privateJwk, ALG, false, ['sign'])
}

/**
 * The canonical text the owner's signature commits to: the JCS form of the frame without `osig`, `relay` and `stepup_token`.
 * Built from the RAW frame (what was received), never from a parsed copy.
 */
export function ownerSignedString(frame: Record<string, unknown>): string {
  // fromEntries defines own properties, so an own `__proto__` key is signed like any other (assigning rest[k] = v would
  // set the prototype instead and leave that field outside the signature).
  const rest = Object.fromEntries(
    Object.entries(frame).filter(([k]) => !(UNSIGNED_FIELDS as readonly string[]).includes(k)),
  )
  return jcs(rest)
}

/** The exact string that is signed, from a device id and the canonical text above (`ownerSignedString`). */
export function ownerSigningInputFor(deviceId: string, signed: string): string {
  return `${OWNER_SIG_DOMAIN}\n${deviceId}\n${sha256Hex(signed)}`
}

/** The exact string that is signed. */
export function ownerSigningInput(frame: Record<string, unknown>): string {
  const deviceId = frame.device_id
  if (typeof deviceId !== 'string') throw new Error('owner frame has no device_id')
  return ownerSigningInputFor(deviceId, ownerSignedString(frame))
}

/** Returns a copy of `frame` with `osig` set. `frame` must be the raw object that will be serialized. */
export async function signOwnerFrame<T extends Record<string, unknown>>(
  frame: T,
  privateKey: CryptoKey,
): Promise<T & { osig: string }> {
  const sig = new Uint8Array(await subtle().sign(SIGN_ALG, privateKey, utf8(ownerSigningInput(frame))))
  if (sig.length !== 64) throw new Error('unexpected signature length')
  return { ...frame, osig: b64urlEncode(sig) }
}

/**
 * Verifies `osig` over the raw object. Also checks that `device_id` is the id of `pubkey` so a frame cannot claim a
 * different device. Returns false (never throws) for any malformed input, including DER signatures.
 */
export async function verifyOwnerFrame(frame: Record<string, unknown>, pubkey: JwkP256T | CryptoKey): Promise<boolean> {
  try {
    const osig = frame.osig
    if (typeof osig !== 'string' || osig.length !== 86) return false
    const sig = b64urlDecode(osig)
    if (sig.length !== 64) return false
    const key = 'kty' in pubkey ? await importDevicePublicKey(pubkey) : pubkey
    const spki = new Uint8Array(await subtle().exportKey('spki', key))
    if (deviceIdFromSpki(spki) !== frame.device_id) return false
    return await subtle().verify(SIGN_ALG, key, sig, utf8(ownerSigningInput(frame)))
  } catch {
    return false
  }
}

/**
 * Verifies `osig` over a canonical text that was kept as a string (`ownerSignedString` of the frame the owner signed), for a
 * reader that is handed the text and not the frame. `deviceId` must be the id of `pubkey`. Returns false (never throws).
 */
export async function verifyOwnerSignedString(
  signed: string,
  osig: string,
  deviceId: string,
  pubkey: JwkP256T | CryptoKey,
): Promise<boolean> {
  try {
    if (osig.length !== 86) return false
    const sig = b64urlDecode(osig)
    if (sig.length !== 64) return false
    const key = 'kty' in pubkey ? await importDevicePublicKey(pubkey) : pubkey
    const spki = new Uint8Array(await subtle().exportKey('spki', key))
    if (deviceIdFromSpki(spki) !== deviceId) return false
    return await subtle().verify(SIGN_ALG, key, sig, utf8(ownerSigningInputFor(deviceId, signed)))
  } catch {
    return false
  }
}
