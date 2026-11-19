// BYOR phase 4 (docs/specs/BYOR-phase4-frame.md §3, §6): the Mac signs a phone's nonce together with the relay origin and its own
// key's fingerprint, so a phone can tell that the owner's Mac answers behind the origin it paired with. Answered on the socket
// the request came in on (relay-client.ts), never queued, retried or put in the outbox: a request that cannot be answered now
// is simply not answered, and the phone says "unverified". Only the key the bridge holds NOW signs; the .prev/.next keys a
// socket may dial with never do.
import { existsSync, readFileSync } from 'node:fs'
import {
  ATTEST_CHAIN_MAX,
  b64urlDecode,
  type Frame,
  fpOfRaw,
  isCanonicalB64_32,
  newUlid,
  RotationCert,
  type RotationCertT,
  signAttest,
  signRotationCert,
} from '@talos-app/protocol'
import type { BridgePaths } from './config.ts'
import { writeJsonAtomic } from './fsutil.ts'
import type { KeyMaterial } from './keys.ts'

const NONCE = /^[A-Za-z0-9_-]{43}$/
/** How many request ids are remembered: enough that a resend of a recent one is never answered twice. */
const SEEN_MAX = 64
/**
 * At most one signature a second, with a burst of 5: the relay's public bucket (burst 2) and paired bucket (burst 3) both
 * feed this one, so a stranger at the public rate can never leave the owner's phone with nothing to sign with.
 */
const REFILL_MS = 1000
const BURST = 5

export type AttestResponse = Extract<Frame, { type: 'attest.response' }>

const fpOfB64 = (pub: string): string | null => {
  if (!isCanonicalB64_32(pub)) return null
  return fpOfRaw(b64urlDecode(pub))
}

// ---- the certificates a rotation leaves ---------------------------------------------------------------------------------

/** The certificates in bridge.rotations.json; a missing or damaged file, or an entry of the wrong shape, reads as none. */
export function readRotations(path: string): RotationCertT[] {
  if (!existsSync(path)) return []
  try {
    const v = JSON.parse(readFileSync(path, 'utf8')) as unknown
    if (!Array.isArray(v)) return []
    const out: RotationCertT[] = []
    for (const e of v) {
      const r = RotationCert.safeParse(e)
      if (!r.success) return [] // one bad entry: trust none of the file, the phone then asks to pair again
      out.push(r.data)
    }
    return out
  } catch {
    return []
  }
}

/**
 * Why `rotate` must not touch the file: it exists but cannot be read, is not JSON, or has an entry of the wrong shape (the
 * answer path reads that as "no certificates"; a rotation would write over it and lose the earlier ones). Null = fine or absent.
 */
export function rotationsProblem(path: string): string | null {
  if (!existsSync(path)) return null
  try {
    const v = JSON.parse(readFileSync(path, 'utf8')) as unknown
    if (Array.isArray(v) && v.every((e) => RotationCert.safeParse(e).success)) return null
  } catch {
    // falls through
  }
  return `${path} exists but is not a list of rotation certificates`
}

/** Appends a certificate (0600, atomic). False, and nothing written, when one for the same new key is already there. */
export function appendRotation(path: string, cert: RotationCertT): boolean {
  const have = readRotations(path)
  if (have.some((c) => c.new_pubkey === cert.new_pubkey)) return false
  writeJsonAtomic(path, [...have, cert], 0o600, { durable: true })
  return true
}

/**
 * Signs, with the OLD key, that `newPubkey` follows it at this relay, and keeps the certificate. Called by `rotate` BEFORE
 * the relay is asked to switch, so the answer a phone gets right after the switch already carries it. False when the file
 * already holds one for this new key (a bridge.key.next an earlier try left).
 */
export async function certifyRotation(
  p: Pick<BridgePaths, 'bridgeRotations'>,
  relayId: string,
  oldKey: KeyMaterial,
  newPubkey: string,
): Promise<boolean> {
  const oldFp = fpOfB64(oldKey.publicKeyB64)
  const newFp = fpOfB64(newPubkey)
  if (!oldFp || !newFp) throw new Error('a bridge key is not 32 canonical bytes')
  const sig = await signRotationCert(oldKey.privateKey, relayId, oldFp, newFp)
  return appendRotation(p.bridgeRotations, {
    relay_id: relayId,
    old_pubkey: oldKey.publicKeyB64,
    new_pubkey: newPubkey,
    sig,
  })
}

/**
 * The certificates from the oldest key to `currentPubkey`, walked BACKWARDS from it: the entry whose new key is the current
 * one, then the entry whose new key is that one's old key, and so on. Certs of tries that never became the key (not on this
 * walk) drop out. At most ATTEST_CHAIN_MAX, the newest ones; a loop in the file ends the walk.
 */
export function chainFrom(certs: readonly RotationCertT[], currentPubkey: string): RotationCertT[] {
  const out: RotationCertT[] = []
  const seen = new Set<string>()
  let want = fpOfB64(currentPubkey)
  while (want && out.length < ATTEST_CHAIN_MAX && !seen.has(want)) {
    seen.add(want)
    let hit: RotationCertT | undefined
    for (let i = certs.length - 1; i >= 0 && !hit; i--) {
      const c = certs[i] as RotationCertT
      if (fpOfB64(c.new_pubkey) === want) hit = c
    }
    if (!hit) break
    out.unshift(hit)
    want = fpOfB64(hit.old_pubkey)
  }
  return out
}

// ---- the answer -------------------------------------------------------------------------------------------------------------

export type AttestOptions = {
  /** The key the bridge authenticates with now (`Bridge.keyRef`), read at each request. */
  key: () => KeyMaterial | undefined
  /** The bridge's own configured relay URL; its origin is what is signed. */
  relayUrl: () => string | undefined
  rotationsPath: string
  now: () => number
}

export class AttestResponder {
  private readonly seen: string[] = []
  private tokens = BURST
  private at: number

  constructor(private readonly o: AttestOptions) {
    this.at = o.now()
  }

  /** The `attest.response` for this request, or null: a bad nonce, a repeat, over the limit, or no key or URL. */
  async answer(req: { id: string; nonce: string }): Promise<AttestResponse | null> {
    if (!NONCE.test(req.nonce)) return null
    if (this.seen.includes(req.id)) return null
    const key = this.o.key()
    const url = this.o.relayUrl()
    if (!key || !url) return null
    let origin: string
    try {
      origin = new URL(url).origin
    } catch {
      return null
    }
    const fp = fpOfB64(key.publicKeyB64)
    if (!fp) return null
    // the limit comes last among the cheap checks, and an id is remembered only once it is signed: a request the limit
    // dropped was never answered, so a resend of it may still be
    const now = this.o.now()
    this.tokens = Math.min(BURST, this.tokens + Math.max(0, now - this.at) / REFILL_MS)
    this.at = now
    if (this.tokens < 1) return null
    this.tokens -= 1
    this.seen.push(req.id)
    if (this.seen.length > SEEN_MAX) this.seen.shift()
    const sig = await signAttest(key.privateKey, req.nonce, origin, fp)
    return {
      v: 1,
      type: 'attest.response',
      id: newUlid(),
      ts: new Date(now).toISOString(),
      ref: req.id,
      pubkey: key.publicKeyB64,
      sig,
      chain: chainFrom(readRotations(this.o.rotationsPath), key.publicKeyB64),
    }
  }
}

/**
 * The relay client's `onAttest`: one responder for the life of the bridge, so its limit and its memory of ids last. `key` is the
 * CURRENT key (Bridge.keyRef), never the .prev/.next fallbacks the socket may dial with.
 */
export function attestHandler(
  key: () => KeyMaterial | undefined,
  relayUrl: string | undefined,
  p: Pick<BridgePaths, 'bridgeRotations'>,
  clock: { now(): number },
): (req: { id: string; nonce: string }) => Promise<AttestResponse | null> {
  const r = new AttestResponder({
    key,
    relayUrl: () => relayUrl,
    rotationsPath: p.bridgeRotations,
    now: () => clock.now(),
  })
  return (req) => r.answer(req)
}
