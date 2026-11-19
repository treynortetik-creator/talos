// BYOR phase 4 (docs/specs/BYOR-phase4-frame.md §3, §6): the bridge signs a fresh nonce from the phone together with the relay
// origin and its own key's fingerprint, so a phone can tell that the owner's Mac answers behind the origin it paired with. A
// rotation is carried by certificates the OLD key signs. checkAttest is the phone's check, in its one order; the iPhone app's
// Swift twin runs the same vectors (fixtures/bridge-attest/vectors.json).
import { type Bytes, b64urlDecode, b64urlEncode, utf8 } from './encoding.ts'
import { sha256 } from './hash.ts'

const subtle = () => globalThis.crypto.subtle

/** `hello.client.features` entry: a bridge that lists this answers `attest.request`. */
export const ATTEST_FEATURE = 'attest/1'
export const BRIDGE_ATTEST_DOMAIN = 'talos-bridge-attest/v1'
export const ROTATE_CERT_DOMAIN = 'talos-rotate-cert/v1'
/** The most rotation certificates an answer carries; more is a bad chain. */
export const ATTEST_CHAIN_MAX = 8
/** The most bytes of an answer body the phone reads; more is a bad shape. */
export const ATTEST_BODY_MAX = 8192
/** The deepest nesting of objects and arrays an answer may have (a valid one is 3 deep). */
export const JSON_DEPTH_MAX = 16

const B64_43 = /^[A-Za-z0-9_-]{43}$/
const B64_86 = /^[A-Za-z0-9_-]{86}$/
const RELAY_ID = /^r_[a-z2-7]{20}$/
/** The group order L of Ed25519: a signature whose S is not below it is refused, whatever a library would accept. */
const ED25519_L = (1n << 252n) + 27742317777372353535851937790883648493n

/**
 * 32 bytes are 43 base64url characters whose last one carries only 4 bits: its low 2 bits must be 0. Any other last
 * character decodes to the same bytes, so it is not THE text of a fingerprint, and fingerprints are compared as text.
 */
export function isCanonicalB64_32(s: string): boolean {
  if (!B64_43.test(s)) return false
  const i = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_'.indexOf(s[42] as string)
  return (i & 3) === 0
}

const PRINTABLE = /^[\x21-\x7e]+$/

/**
 * The signed bytes of an attest: UTF-8, LF only, no trailing LF; nonce and fp are their base64url TEXT. The fields are
 * checked here, not trusted to callers: a newline inside one would let two different inputs give the same bytes.
 */
export function attestBytes(nonce: string, origin: string, fp: string): Bytes {
  if (!B64_43.test(nonce) || !B64_43.test(fp) || !PRINTABLE.test(origin)) throw new Error('bad attest field')
  return utf8(`${BRIDGE_ATTEST_DOMAIN}\n${nonce}\n${origin}\n${fp}`)
}

/** The signed bytes of a rotation certificate (signed by the OLD key): all text, each field checked. */
export function certBytes(relayId: string, oldFp: string, newFp: string): Bytes {
  if (!RELAY_ID.test(relayId) || !B64_43.test(oldFp) || !B64_43.test(newFp)) throw new Error('bad certificate field')
  return utf8(`${ROTATE_CERT_DOMAIN}\n${relayId}\n${oldFp}\n${newFp}`)
}

/** base64url(sha256(raw 32-byte key)), as the setup link's `fp`. */
export const fpOfRaw = (raw: Uint8Array): string => b64urlEncode(sha256(raw))

export async function signAttest(privateKey: CryptoKey, nonce: string, origin: string, fp: string): Promise<string> {
  return b64urlEncode(
    new Uint8Array(await subtle().sign({ name: 'Ed25519' }, privateKey, attestBytes(nonce, origin, fp))),
  )
}

export async function signRotationCert(
  oldPrivateKey: CryptoKey,
  relayId: string,
  oldFp: string,
  newFp: string,
): Promise<string> {
  return b64urlEncode(
    new Uint8Array(await subtle().sign({ name: 'Ed25519' }, oldPrivateKey, certBytes(relayId, oldFp, newFp))),
  )
}

export type RotationCertT = { relay_id: string; old_pubkey: string; new_pubkey: string; sig: string }
export type AttestAnswer = { pubkey: string; sig: string; chain: RotationCertT[] }
export type AttestReason = 'bad_shape' | 'bad_key' | 'bad_sig' | 'bad_chain' | 'wrong_fp' | 'repin_at_pair'
export type AttestVerdict =
  | { verdict: 'pass' }
  | { verdict: 'repin'; new_fp: string }
  | { verdict: 'fail'; reason: AttestReason }

const P = (1n << 255n) - 19n
const D = ((-121665n * modPow(121666n, P - 2n)) % P) + P
function modPow(b: bigint, e: bigint): bigint {
  let r = 1n
  let x = ((b % P) + P) % P
  let n = e
  while (n > 0n) {
    if (n & 1n) r = (r * x) % P
    x = (x * x) % P
    n >>= 1n
  }
  return r
}
/** Whether y (below p, with its x sign bit) encodes a curve point: x^2 = (y^2 - 1) / (d y^2 + 1) must be a square mod p. */
function onCurve(y: bigint, sign: number): boolean {
  const u = (y * y - 1n + P) % P
  const v = (D * y * y + 1n) % P
  const x2 = (u * modPow(v, P - 2n)) % P
  if (x2 === 0n) return sign === 0 // x = 0 has no negative form
  return modPow(x2, (P - 1n) / 2n) === 1n
}
/** y of the two order-8 points (either x sign): with y = 0 (order 4), 1 (the identity) and p - 1 (order 2), all 8 small-order points. */
const SMALL_ORDER_Y = new Set([
  0n,
  1n,
  P - 1n,
  0x05fc536d880238b13933c6d305acdfd5f098eff289f4c345b027b2c28f95e826n,
  0x7a03ac9277fdc74ec6cc392cfa53202a0f67100d760b3cba4fd84d3d706a17c7n,
])

/**
 * The raw 32 bytes of a canonical base64url key that is a usable Ed25519 public key, or null: not a non-canonical encoding
 * (y >= p), a point on the curve (decided here, not by whether a library's key constructor throws) and not one of the 8
 * small-order points, whatever a library would accept (Bun's WebCrypto takes the identity
 * point with S = 0 as a valid signature of anything).
 */
function key32(b64: string): Bytes | null {
  if (!isCanonicalB64_32(b64)) return null
  const raw = b64urlDecode(b64)
  if (raw.length !== 32) return null
  let y = 0n
  for (let i = 31; i >= 0; i--) y = (y << 8n) | BigInt((raw[i] as number) & (i === 31 ? 0x7f : 0xff))
  if (y >= P || SMALL_ORDER_Y.has(y) || !onCurve(y, (raw[31] as number) >> 7)) return null
  return raw
}

async function verify(raw: Bytes, sigB64: string, msg: Bytes): Promise<boolean> {
  if (!B64_86.test(sigB64)) return false
  const sig = b64urlDecode(sigB64)
  if (sig.length !== 64 || b64urlEncode(sig) !== sigB64) return false
  let s = 0n
  for (let i = 63; i >= 32; i--) s = (s << 8n) | BigInt(sig[i] as number) // S is the little-endian second half
  if (s >= ED25519_L) return false
  try {
    const key = await subtle().importKey('raw', raw, { name: 'Ed25519' }, false, ['verify'])
    return await subtle().verify({ name: 'Ed25519' }, key, sig, msg)
  } catch {
    return false
  }
}

/**
 * Strict JSON (RFC 8259) that also refuses a repeated key in any object, so every implementation reads one value per key
 * (JSON.parse keeps the last, others keep the first or refuse). Returns undefined for anything that is not exactly that.
 */
export function parseStrictJson(text: string): unknown {
  let i = 0
  const ws = () => {
    while (i < text.length && ' \t\n\r'.includes(text[i] as string)) i++
  }
  const fail = (): never => {
    throw new Error('bad json')
  }
  const str = (): string => {
    if (text[i] !== '"') fail()
    i++
    let out = ''
    for (;;) {
      if (i >= text.length) fail()
      const c = text[i++] as string
      // a lone UTF-16 surrogate (from a \\u escape) is not text: Foundation refuses it, so this does too
      if (c === '"')
        return /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(out) ? fail() : out
      if (c < ' ') fail()
      if (c !== '\\') {
        out += c
        continue
      }
      const e = text[i++]
      const simple: Record<string, string> = {
        '"': '"',
        '\\': '\\',
        '/': '/',
        b: '\b',
        f: '\f',
        n: '\n',
        r: '\r',
        t: '\t',
      }
      if (e !== undefined && e in simple) out += simple[e]
      else if (e === 'u' && /^[0-9a-fA-F]{4}$/.test(text.slice(i, i + 4))) {
        out += String.fromCharCode(Number.parseInt(text.slice(i, i + 4), 16))
        i += 4
      } else fail()
    }
  }
  let depth = 0
  const value = (): unknown => {
    ws()
    const c = text[i]
    if (c === '{' || c === '[') {
      // a valid answer is 3 deep; past JSON_DEPTH_MAX is refused, the same everywhere (runtimes differ at thousands)
      if (++depth > JSON_DEPTH_MAX) fail()
    }
    if (c === '{') {
      i++
      const o: Record<string, unknown> = Object.create(null)
      ws()
      if (text[i] === '}') {
        i++
        depth--
        return o
      }
      for (;;) {
        ws()
        const k = str()
        if (Object.hasOwn(o, k)) fail()
        ws()
        if (text[i++] !== ':') fail()
        o[k] = value()
        ws()
        const d = text[i++]
        if (d === '}') {
          depth--
          return o
        }
        if (d !== ',') fail()
      }
    }
    if (c === '[') {
      i++
      const a: unknown[] = []
      ws()
      if (text[i] === ']') {
        i++
        depth--
        return a
      }
      for (;;) {
        a.push(value())
        ws()
        const d = text[i++]
        if (d === ']') {
          depth--
          return a
        }
        if (d !== ',') fail()
      }
    }
    if (c === '"') return str()
    const lit = /^(?:true|false|null|-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?)/.exec(text.slice(i))
    if (!lit) fail()
    i += (lit as RegExpExecArray)[0].length
    const t = (lit as RegExpExecArray)[0]
    return t === 'true' ? true : t === 'false' ? false : t === 'null' ? null : Number(t)
  }
  try {
    const v = value()
    ws()
    return i === text.length ? v : undefined
  } catch {
    return undefined
  }
}

/**
 * Step 1: at most ATTEST_BODY_MAX bytes, strict UTF-8 with no byte-order mark, strict JSON with no repeated key, and
 * exactly {pubkey, sig, chain} with chain entries exactly the certificate's fields, all strings.
 */
function parseAnswer(body: Uint8Array): AttestAnswer | null {
  if (body.length > ATTEST_BODY_MAX) return null
  let text: string
  try {
    text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(body)
  } catch {
    return null
  }
  const v = parseStrictJson(text) // a BOM is kept by ignoreBOM, and is not JSON whitespace: refused here
  if (v === undefined) return null
  const exact = (o: unknown, keys: string[]): o is Record<string, unknown> =>
    typeof o === 'object' &&
    o !== null &&
    !Array.isArray(o) &&
    Object.keys(o).length === keys.length &&
    keys.every((k) => typeof (o as Record<string, unknown>)[k] !== 'undefined')
  if (!exact(v, ['pubkey', 'sig', 'chain'])) return null
  if (typeof v.pubkey !== 'string' || typeof v.sig !== 'string' || !Array.isArray(v.chain)) return null
  for (const e of v.chain)
    if (
      !exact(e, ['relay_id', 'old_pubkey', 'new_pubkey', 'sig']) ||
      !['relay_id', 'old_pubkey', 'new_pubkey', 'sig'].every((k) => typeof e[k] === 'string')
    )
      return null
  return v as AttestAnswer
}

/**
 * The phone's check of an attest answer, in the one order of the design note: (1) the body's size and shape; (2) the key
 * is 32 bytes and fp(K) its canonical text; (3) fp(K) is the pinned fp, or a rotation chain leads from the pinned fp to it;
 * (4) K's signature over attestBytes(nonce, origin, fp(K)). At pairing only a plain pass counts: a valid chain there fails.
 * `unverified` is not a verdict here: it is the phone's state when no answer comes back.
 */
export async function checkAttest(a: {
  /** The answer's raw bytes as received. */
  body: Uint8Array
  nonce: string
  origin: string
  relayId: string
  pinnedFp: string
  context: 'pair' | 'reconnect'
}): Promise<AttestVerdict> {
  // the phone's own inputs, not the answer's: a malformed one is the caller's bug, so it throws rather than giving a verdict
  if (!B64_43.test(a.nonce) || !PRINTABLE.test(a.origin) || !RELAY_ID.test(a.relayId))
    throw new Error('checkAttest: malformed nonce, origin or relay_id')
  const fail = (reason: AttestReason): AttestVerdict => ({ verdict: 'fail', reason })
  const ans = parseAnswer(a.body)
  if (!ans) return fail('bad_shape')
  const k = key32(ans.pubkey)
  if (!k) return fail('bad_key')
  const fpK = fpOfRaw(k)
  if (!isCanonicalB64_32(a.pinnedFp)) return fail('wrong_fp')
  // the cap holds whoever signs; the entries themselves are read only when the chain is walked
  if (ans.chain.length > ATTEST_CHAIN_MAX) return fail('bad_chain')

  let viaChain = false
  if (fpK !== a.pinnedFp) {
    if (ans.chain.length === 0) return fail('wrong_fp')
    // skip to the entry that starts at the pinned key (a phone pinned to a middle key): entries before it are not read at
    // all (a phone pinned later never needs them), then each from there must follow on
    const start = ans.chain.findIndex((e) => {
      const raw = key32(e.old_pubkey)
      return raw !== null && fpOfRaw(raw) === a.pinnedFp
    })
    if (start < 0) return fail('bad_chain')
    let current = a.pinnedFp
    const seen = new Set([current])
    for (const e of ans.chain.slice(start)) {
      const oldRaw = key32(e.old_pubkey)
      const newRaw = key32(e.new_pubkey)
      if (!oldRaw || !newRaw || !RELAY_ID.test(e.relay_id)) return fail('bad_chain')
      if (e.relay_id !== a.relayId || fpOfRaw(oldRaw) !== current) return fail('bad_chain')
      const next = fpOfRaw(newRaw)
      if (seen.has(next)) return fail('bad_chain')
      if (!(await verify(oldRaw, e.sig, certBytes(e.relay_id, current, next)))) return fail('bad_chain')
      seen.add(next)
      current = next
    }
    if (current !== fpK) return fail('bad_chain')
    viaChain = true
  }

  if (!(await verify(k, ans.sig, attestBytes(a.nonce, a.origin, fpK)))) return fail('bad_sig')
  if (!viaChain) return { verdict: 'pass' }
  return a.context === 'pair' ? fail('repin_at_pair') : { verdict: 'repin', new_fp: fpK }
}
