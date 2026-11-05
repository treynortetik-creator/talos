// Bridge authentication (spec 5.4): Ed25519 over a relay challenge (WebSocket) or over a canonical request string
// (HTTP). WebCrypto Ed25519 is available in Node 24, Bun and current browsers.
import { b64urlDecode, b64urlEncode, randomBytes, utf8 } from './encoding.ts'
import { sha256Hex } from './hash.ts'

const subtle = () => globalThis.crypto.subtle

export const BRIDGE_WS_DOMAIN = 'talos-relay/v1'
export const BRIDGE_HTTP_DOMAIN = 'talos-bridge-http/v1'
export const BRIDGE_ROTATE_DOMAIN = 'talos-rotate/v1'
export const BRIDGE_HTTP_SKEW_S = 120
export const BRIDGE_NONCE_TTL_S = 600

export type BridgeKeyPair = {
  privateKey: CryptoKey
  /** Raw 32-byte public key, base64url (the value of the relay's BRIDGE_PUBKEY). */
  publicKeyB64: string
  keyId: string
  /** PKCS8 private key, base64url, for the 0600 key file on the Mac. */
  privateKeyPkcs8B64: string
}

/** First 16 hex chars of sha256(raw public key). */
export function bridgeKeyId(rawPublicKey: Uint8Array): string {
  return sha256Hex(rawPublicKey).slice(0, 16)
}

export async function generateBridgeKey(): Promise<BridgeKeyPair> {
  const pair = (await subtle().generateKey({ name: 'Ed25519' }, true, ['sign', 'verify'])) as CryptoKeyPair
  const raw = new Uint8Array(await subtle().exportKey('raw', pair.publicKey))
  const pkcs8 = new Uint8Array(await subtle().exportKey('pkcs8', pair.privateKey))
  return {
    privateKey: pair.privateKey,
    publicKeyB64: b64urlEncode(raw),
    keyId: bridgeKeyId(raw),
    privateKeyPkcs8B64: b64urlEncode(pkcs8),
  }
}

export async function importBridgePrivateKey(pkcs8B64: string): Promise<CryptoKey> {
  return subtle().importKey('pkcs8', b64urlDecode(pkcs8B64), { name: 'Ed25519' }, false, ['sign'])
}

export async function importBridgePublicKey(rawB64: string): Promise<CryptoKey> {
  const raw = b64urlDecode(rawB64)
  if (raw.length !== 32) throw new Error('bridge public key must be 32 raw bytes')
  return subtle().importKey('raw', raw, { name: 'Ed25519' }, true, ['verify'])
}

async function signString(privateKey: CryptoKey, s: string): Promise<string> {
  return b64urlEncode(new Uint8Array(await subtle().sign({ name: 'Ed25519' }, privateKey, utf8(s))))
}

async function verifyString(publicKeyB64: string, s: string, sigB64: string): Promise<boolean> {
  try {
    const sig = b64urlDecode(sigB64)
    if (sig.length !== 64) return false
    const key = await importBridgePublicKey(publicKeyB64)
    return await subtle().verify({ name: 'Ed25519' }, key, sig, utf8(s))
  } catch {
    return false
  }
}

// ---- WebSocket challenge ----------------------------------------------------------------------------------------

export function newChallengeNonce(): string {
  return b64urlEncode(randomBytes(32))
}

export function challengeString(c: { nonce: string; relay_host: string; server_time: number }): string {
  return `${BRIDGE_WS_DOMAIN}\n${c.nonce}\n${c.relay_host}\n${c.server_time}`
}

export function signChallenge(privateKey: CryptoKey, c: { nonce: string; relay_host: string; server_time: number }) {
  return signString(privateKey, challengeString(c))
}

export function verifyChallenge(
  publicKeyB64: string,
  c: { nonce: string; relay_host: string; server_time: number },
  sigB64: string,
): Promise<boolean> {
  return verifyString(publicKeyB64, challengeString(c), sigB64)
}

// ---- HTTP -------------------------------------------------------------------------------------------------------

export function bridgeHttpString(r: {
  method: string
  pathWithQuery: string
  ts: number
  nonce: string
  body: Uint8Array | string
  /** The body's SHA-256 (lowercase hex) when the caller already has it. Used instead of `body`, so a signature can be checked before the body is read. */
  bodySha256?: string
}): string {
  return [
    BRIDGE_HTTP_DOMAIN,
    r.method.toUpperCase(),
    r.pathWithQuery,
    String(r.ts),
    r.nonce,
    r.bodySha256 ?? sha256Hex(r.body),
  ].join('\n')
}

/** Returns the `Authorization` header value: `TalosBridge key_id=<kid>,ts=<unix>,nonce=<b64url16>,sig=<b64url>`. */
export async function signBridgeHttp(args: {
  privateKey: CryptoKey
  keyId: string
  method: string
  pathWithQuery: string
  body?: Uint8Array | string
  ts?: number
  nonce?: string
}): Promise<string> {
  const ts = args.ts ?? Math.floor(Date.now() / 1000)
  const nonce = args.nonce ?? b64urlEncode(randomBytes(16))
  const sig = await signString(
    args.privateKey,
    bridgeHttpString({ method: args.method, pathWithQuery: args.pathWithQuery, ts, nonce, body: args.body ?? '' }),
  )
  return `TalosBridge key_id=${args.keyId},ts=${ts},nonce=${nonce},sig=${sig}`
}

export type ParsedBridgeAuth = { keyId: string; ts: number; nonce: string; sig: string }

export function parseBridgeAuthHeader(header: string): ParsedBridgeAuth | null {
  const m = /^TalosBridge (.+)$/.exec(header.trim())
  if (!m) return null
  const parts: Record<string, string> = {}
  for (const kv of (m[1] as string).split(',')) {
    const i = kv.indexOf('=')
    if (i < 0) return null
    parts[kv.slice(0, i).trim()] = kv.slice(i + 1).trim()
  }
  const { key_id, ts, nonce, sig } = parts
  if (!key_id || !ts || !nonce || !sig || !/^\d{1,12}$/.test(ts)) return null
  if (!/^[0-9a-f]{16}$/.test(key_id) || !/^[A-Za-z0-9_-]{16,64}$/.test(nonce)) return null
  return { keyId: key_id, ts: Number(ts), nonce, sig }
}

export type VerifyBridgeHttpResult =
  | { ok: true; keyId: string; nonce: string; ts: number }
  | { ok: false; reason: 'malformed' | 'unknown_key' | 'skew' | 'bad_signature' }

/**
 * Verifies the header against the request. The caller owns the nonce cache (reject a nonce seen in the last
 * BRIDGE_NONCE_TTL_S seconds) and passes every currently valid key (active + previous-within-5-min).
 */
export async function verifyBridgeHttp(args: {
  header: string
  method: string
  pathWithQuery: string
  body?: Uint8Array | string
  /** Check against this body hash (lowercase hex) instead of hashing `body`. */
  bodySha256?: string
  nowS: number
  keys: ReadonlyArray<{ keyId: string; publicKeyB64: string }>
}): Promise<VerifyBridgeHttpResult> {
  const p = parseBridgeAuthHeader(args.header)
  if (!p) return { ok: false, reason: 'malformed' }
  const key = args.keys.find((k) => k.keyId === p.keyId)
  if (!key) return { ok: false, reason: 'unknown_key' }
  if (Math.abs(args.nowS - p.ts) > BRIDGE_HTTP_SKEW_S) return { ok: false, reason: 'skew' }
  const s = bridgeHttpString({
    method: args.method,
    pathWithQuery: args.pathWithQuery,
    ts: p.ts,
    nonce: p.nonce,
    body: args.body ?? '',
    ...(args.bodySha256 !== undefined ? { bodySha256: args.bodySha256 } : {}),
  })
  return (await verifyString(key.publicKeyB64, s, p.sig))
    ? { ok: true, keyId: p.keyId, nonce: p.nonce, ts: p.ts }
    : { ok: false, reason: 'bad_signature' }
}

// ---- rotation ---------------------------------------------------------------------------------------------------

/** `sig_new` for POST /bridge/rotate: Ed25519 by the NEW key over "talos-rotate/v1\n<new_pubkey>\n<ts>". */
export function rotateString(newPubkeyB64: string, ts: number): string {
  return `${BRIDGE_ROTATE_DOMAIN}\n${newPubkeyB64}\n${ts}`
}
export function signRotation(newPrivateKey: CryptoKey, newPubkeyB64: string, ts: number) {
  return signString(newPrivateKey, rotateString(newPubkeyB64, ts))
}
export function verifyRotation(newPubkeyB64: string, ts: number, sigNew: string) {
  return verifyString(newPubkeyB64, rotateString(newPubkeyB64, ts), sigNew)
}
