// Bridge Ed25519 key (spec 4.2, 4.10). `bridge.key` is JSON {v, pkcs8, public, key_id}, mode 0600. Rotation writes
// `bridge.key.next`, and on the relay's 200 renames current -> `.prev` and `.next` -> current.
import { existsSync, readFileSync, renameSync } from 'node:fs'
import { b64urlDecode, bridgeKeyId, generateBridgeKey, importBridgePrivateKey, signRotation } from '@talos-app/protocol'
import type { BridgePaths } from './config.ts'
import { writeJsonAtomic } from './fsutil.ts'

export type StoredKey = { v: 1; pkcs8: string; public: string; key_id: string }
export type KeyMaterial = { privateKey: CryptoKey; publicKeyB64: string; keyId: string }

export async function newStoredKey(): Promise<StoredKey> {
  const k = await generateBridgeKey()
  return { v: 1, pkcs8: k.privateKeyPkcs8B64, public: k.publicKeyB64, key_id: k.keyId }
}

export async function loadKeyFile(path: string): Promise<KeyMaterial | undefined> {
  if (!existsSync(path)) return undefined
  const s = JSON.parse(readFileSync(path, 'utf8')) as StoredKey
  if (s.v !== 1 || !s.pkcs8 || !s.public) throw new Error(`${path} is not a bridge key file`)
  if (bridgeKeyId(b64urlDecode(s.public)) !== s.key_id) throw new Error(`${path}: key_id does not match the public key`)
  return { privateKey: await importBridgePrivateKey(s.pkcs8), publicKeyB64: s.public, keyId: s.key_id }
}

export async function loadBridgeKey(p: BridgePaths): Promise<KeyMaterial> {
  const k = await loadKeyFile(p.bridgeKey)
  if (!k) throw new Error(`no bridge key at ${p.bridgeKey}; run: talos-app init --relay-url <url>`)
  return k
}

/** Creates bridge.key when missing. Never overwrites an existing key. Returns the public key. */
export async function ensureBridgeKey(p: BridgePaths): Promise<{ created: boolean; publicKeyB64: string }> {
  const existing = await loadKeyFile(p.bridgeKey)
  if (existing) return { created: false, publicKeyB64: existing.publicKeyB64 }
  const s = await newStoredKey()
  writeJsonAtomic(p.bridgeKey, s, 0o600)
  return { created: true, publicKeyB64: s.public }
}

export type PreparedRotation = { newPubkey: string; sigNew: string; ts: number }

/** Step 1 of rotation: write bridge.key.next and build the body for POST /bridge/rotate. */
export async function prepareRotation(p: BridgePaths, nowS: number): Promise<PreparedRotation> {
  const s = await newStoredKey()
  writeJsonAtomic(p.bridgeKeyNext, s, 0o600)
  const priv = await importBridgePrivateKey(s.pkcs8)
  return { newPubkey: s.public, sigNew: await signRotation(priv, s.public, nowS), ts: nowS }
}

/**
 * Step 2, after the relay answered 200: keep the old key as `.prev` (a copy, so there is never a moment without a
 * bridge.key), then atomically rename `.next` over it.
 */
export function commitRotation(p: BridgePaths): void {
  if (existsSync(p.bridgeKey)) {
    writeJsonAtomic(p.bridgeKeyPrev, JSON.parse(readFileSync(p.bridgeKey, 'utf8')), 0o600)
  }
  renameSync(p.bridgeKeyNext, p.bridgeKey)
}
