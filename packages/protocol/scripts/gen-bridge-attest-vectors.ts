// Writes fixtures/bridge-attest/vectors.json (BYOR phase 4, docs/specs/BYOR-phase4-frame.md §8): the attest and rotation
// certificate bytes, and answers the phone's check must pass, re-pin or fail, read by test/bridge-attest.test.ts and the
// iPhone app's Swift twin. Ed25519 is deterministic and the seeds are fixed TEST values, so the file is exactly reproducible:
// `--check` compares a fresh run with the committed file byte for byte.
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  ATTEST_BODY_MAX,
  type AttestVerdict,
  attestBytes,
  certBytes,
  checkAttest,
  fpOfRaw,
  type RotationCertT,
  signAttest,
  signRotationCert,
} from '../src/bridge-attest.ts'
import { b64urlEncode } from '../src/encoding.ts'

const out = join(dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'bridge-attest', 'vectors.json')
const subtle = globalThis.crypto.subtle
const hex = (b: Uint8Array) => Buffer.from(b).toString('hex')

type Key = { name: string; seed: Uint8Array; priv: CryptoKey; raw: Uint8Array; pub: string; fp: string }
async function key(name: string, fill: number): Promise<Key> {
  const seed = new Uint8Array(32).fill(fill)
  // PKCS8 for an Ed25519 seed: the fixed 16-byte prefix, then the 32 seed bytes
  const pkcs8 = new Uint8Array([0x30, 0x2e, 2, 1, 0, 0x30, 5, 6, 3, 0x2b, 0x65, 0x70, 4, 0x22, 4, 0x20, ...seed])
  const priv = await subtle.importKey('pkcs8', pkcs8, { name: 'Ed25519' }, true, ['sign'])
  const jwk = await subtle.exportKey('jwk', priv)
  const raw = new Uint8Array(Buffer.from(jwk.x as string, 'base64url'))
  return { name, seed, priv, raw, pub: b64urlEncode(raw), fp: fpOfRaw(raw) }
}

const NONCE = b64urlEncode(Uint8Array.from({ length: 32 }, (_, i) => i))
const OTHER_NONCE = b64urlEncode(Uint8Array.from({ length: 32 }, (_, i) => 255 - i))
const ORIGIN = 'https://relay.example.com:8443'
const RELAY_ID = 'r_abcdefghijklmnopqrst'
const OTHER_RELAY_ID = 'r_tsrqponmlkjihgfedcba'
const L = (1n << 252n) + 27742317777372353535851937790883648493n
const IDENTITY = new Uint8Array([1, ...new Array(31).fill(0)])
const ORDER8 = new Uint8Array(Buffer.from('26e8958fc2b227b045c3f489f2ef98f0d5dfac05d3c63339b13802886d53fc05', 'hex'))
const Y_IS_P = new Uint8Array([0xed, ...new Array(30).fill(0xff), 0x7f]) // p = 2^255 - 19, little-endian
const NOT_ON_CURVE = new Uint8Array([2, ...new Array(31).fill(0)]) // y = 2: (y^2 - 1)/(d y^2 + 1) is not a square mod p

/** The same base64url text with its last character's two spare bits set: the same bytes, not the canonical text. */
function nonCanonical(b64: string): string {
  const A = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_'
  return b64.slice(0, 42) + (A[A.indexOf(b64[42] as string) | 1] as string)
}

/** The same 64-byte signature text with its last character's four spare bits set: the same bytes, not the canonical text. */
function nonCanonical86(b64: string): string {
  const A = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_'
  return b64.slice(0, 85) + (A[A.indexOf(b64[85] as string) | 1] as string)
}

type Case = {
  /** the body's bytes when they are not plain UTF-8 text of `body` */
  raw?: Uint8Array
  name: string
  context: 'pair' | 'reconnect'
  pinned_fp: string
  body: string
  nonce?: string
  expect: AttestVerdict
}
const pass: AttestVerdict = { verdict: 'pass' }
const failed = (reason: string) => ({ verdict: 'fail', reason }) as AttestVerdict

/** The keys, certificates and signatures the cases are built from. */
async function context() {
  const k0 = await key('k0', 1)
  const k1 = await key('k1', 2)
  const k2 = await key('k2', 3) // the bridge's current key
  const kx = await key('kx', 9) // someone else's
  const cert = async (from: Key, to: Key, relayId = RELAY_ID, signer = from): Promise<RotationCertT> => ({
    relay_id: relayId,
    old_pubkey: from.pub,
    new_pubkey: to.pub,
    sig: await signRotationCert(signer.priv, relayId, from.fp, to.fp),
  })
  const c01 = await cert(k0, k1)
  const c12 = await cert(k1, k2)
  const c10 = await cert(k1, k0)
  const sig2 = await signAttest(k2.priv, NONCE, ORIGIN, k2.fp)
  const answer = (o: { pubkey?: string; sig?: string; chain?: unknown[] }) =>
    JSON.stringify({ pubkey: o.pubkey ?? k2.pub, sig: o.sig ?? sig2, chain: o.chain ?? [] })

  const flipped = (() => {
    const b = Buffer.from(sig2, 'base64url')
    b[10] = (b[10] as number) ^ 1
    return b64urlEncode(new Uint8Array(b))
  })()
  const highS = (() => {
    const b = new Uint8Array(Buffer.from(sig2, 'base64url'))
    let s = 0n
    for (let i = 63; i >= 32; i--) s = (s << 8n) | BigInt(b[i] as number)
    let t = s + L // the same point equation holds for S + L; only the canonical S < L is the signature
    for (let i = 32; i < 64; i++) {
      b[i] = Number(t & 0xffn)
      t >>= 8n
    }
    return b64urlEncode(b)
  })()

  return { k0, k1, k2, kx, cert, c01, c12, c10, sig2, answer, flipped, highS }
}
type Ctx = Awaited<ReturnType<typeof context>>

/** Pass, re-pin and the chain: the walk from the pinned key to the signing one. */
async function chainCases({ k0, k1, k2, kx, cert, c01, c12, c10, sig2, answer, flipped, highS }: Ctx): Promise<Case[]> {
  return [
    { name: 'the pinned key signs: pass', context: 'reconnect', pinned_fp: k2.fp, body: answer({}), expect: pass },
    { name: 'at pairing, the QR key signs: pass', context: 'pair', pinned_fp: k2.fp, body: answer({}), expect: pass },
    {
      name: 'a chain from the pinned key to the signing key: repin',
      context: 'reconnect',
      pinned_fp: k0.fp,
      body: answer({ chain: [c01, c12] }),
      expect: { verdict: 'repin', new_fp: k2.fp },
    },
    {
      name: 'the same valid chain at pairing: fail',
      context: 'pair',
      pinned_fp: k0.fp,
      body: answer({ chain: [c01, c12] }),
      expect: failed('repin_at_pair'),
    },
    {
      name: 'a chain that starts before the pinned key: skip to it, repin',
      context: 'reconnect',
      pinned_fp: k1.fp,
      body: answer({ chain: [c01, c12] }),
      expect: { verdict: 'repin', new_fp: k2.fp },
    },
    {
      name: 'a chain that starts after the pinned key',
      context: 'reconnect',
      pinned_fp: k0.fp,
      body: answer({ chain: [c12] }),
      expect: failed('bad_chain'),
    },
    {
      name: 'a chain with a gap (it ends before the signing key)',
      context: 'reconnect',
      pinned_fp: k0.fp,
      body: answer({ chain: [c01] }),
      expect: failed('bad_chain'),
    },
    {
      name: 'a chain that repeats a key',
      context: 'reconnect',
      pinned_fp: k0.fp,
      body: answer({ chain: [c01, c10, c01, c12] }),
      expect: failed('bad_chain'),
    },
    {
      name: 'a chain of 9 entries (7 skipped before the pinned key, then a good walk): the cap',
      context: 'reconnect',
      pinned_fp: k0.fp,
      body: answer({ chain: [c12, c12, c12, c12, c12, c12, c12, c01, c12] }),
      expect: failed('bad_chain'),
    },
    {
      name: 'the pinned key signs and the chain has 9 entries: the cap holds whoever signs',
      context: 'reconnect',
      pinned_fp: k2.fp,
      body: answer({ chain: [c01, c12, c01, c12, c01, c12, c01, c12, c01] }),
      expect: failed('bad_chain'),
    },
    {
      name: 'the pinned key signs: a chain that is not walked is not read',
      context: 'reconnect',
      pinned_fp: k2.fp,
      body: answer({ chain: [{ relay_id: 'nope', old_pubkey: 'x', new_pubkey: 'y', sig: 'z' }] }),
      expect: pass,
    },
    {
      name: 'an invalid entry before the pinned key is skipped, not read: repin',
      context: 'reconnect',
      pinned_fp: k0.fp,
      body: answer({
        chain: [{ relay_id: 'nope', old_pubkey: nonCanonical(kx.pub), new_pubkey: 'short', sig: 'x' }, c01, c12],
      }),
      expect: { verdict: 'repin', new_fp: k2.fp },
    },
    {
      name: 'a 31-byte key inside the walked chain',
      context: 'reconnect',
      pinned_fp: k0.fp,
      body: answer({ chain: [{ ...c01, new_pubkey: b64urlEncode(k1.raw.slice(0, 31)) }, c12] }),
      expect: failed('bad_chain'),
    },
    {
      name: 'a certificate for another relay',
      context: 'reconnect',
      pinned_fp: k0.fp,
      body: answer({ chain: [await cert(k0, k1, OTHER_RELAY_ID), c12] }),
      expect: failed('bad_chain'),
    },
    {
      name: 'a certificate signed by the new key, not the old',
      context: 'reconnect',
      pinned_fp: k0.fp,
      body: answer({ chain: [await cert(k0, k1, RELAY_ID, k1), c12] }),
      expect: failed('bad_chain'),
    },
    {
      name: "someone else's key with a chain that does not start at the pinned key",
      context: 'reconnect',
      pinned_fp: k0.fp,
      body: answer({ chain: [await cert(kx, k2)] }),
      expect: failed('bad_chain'),
    },
    {
      name: 'another key and no chain',
      context: 'reconnect',
      pinned_fp: k0.fp,
      body: answer({}),
      expect: failed('wrong_fp'),
    },
    {
      name: 'a pinned fp whose last character is not canonical',
      context: 'reconnect',
      pinned_fp: nonCanonical(k2.fp),
      body: answer({}),
      expect: failed('wrong_fp'),
    },
  ]
}

/** The signature, the key and the body's shape. */
async function shapeCases({ k0, k1, k2, kx, cert, c01, c12, c10, sig2, answer, flipped, highS }: Ctx): Promise<Case[]> {
  return [
    {
      name: 'signed over another nonce',
      context: 'reconnect',
      pinned_fp: k2.fp,
      body: answer({ sig: await signAttest(k2.priv, OTHER_NONCE, ORIGIN, k2.fp) }),
      expect: failed('bad_sig'),
    },
    {
      name: 'signed over another origin',
      context: 'reconnect',
      pinned_fp: k2.fp,
      body: answer({ sig: await signAttest(k2.priv, NONCE, 'https://relay.example.com', k2.fp) }),
      expect: failed('bad_sig'),
    },
    {
      name: 'signed over another fp',
      context: 'reconnect',
      pinned_fp: k2.fp,
      body: answer({ sig: await signAttest(k2.priv, NONCE, ORIGIN, k1.fp) }),
      expect: failed('bad_sig'),
    },
    {
      name: 'signed under another tag',
      context: 'reconnect',
      pinned_fp: k2.fp,
      body: answer({
        sig: b64urlEncode(
          new Uint8Array(
            await subtle.sign(
              { name: 'Ed25519' },
              k2.priv,
              new TextEncoder().encode(`talos-relay/v1\n${NONCE}\n${ORIGIN}\n${k2.fp}`),
            ),
          ),
        ),
      }),
      expect: failed('bad_sig'),
    },
    {
      name: 'one signature bit flipped',
      context: 'reconnect',
      pinned_fp: k2.fp,
      body: answer({ sig: flipped }),
      expect: failed('bad_sig'),
    },
    {
      name: 'a short signature',
      context: 'reconnect',
      pinned_fp: k2.fp,
      body: answer({ sig: sig2.slice(0, 85) }),
      expect: failed('bad_sig'),
    },
    {
      name: 'a non-canonical S (S + L): Node, Bun and CryptoKit all refuse it; the check refuses S >= L itself too',
      context: 'reconnect',
      pinned_fp: k2.fp,
      body: answer({ sig: highS }),
      expect: failed('bad_sig'),
    },
    {
      name: 'a 31-byte key',
      context: 'reconnect',
      pinned_fp: k2.fp,
      body: answer({ pubkey: b64urlEncode(k2.raw.slice(0, 31)) }),
      expect: failed('bad_key'),
    },
    {
      name: 'a 33-byte key',
      context: 'reconnect',
      pinned_fp: k2.fp,
      body: answer({ pubkey: b64urlEncode(new Uint8Array([...k2.raw, 0])) }),
      expect: failed('bad_key'),
    },
    {
      name: 'a key whose last character is not canonical',
      context: 'reconnect',
      pinned_fp: k2.fp,
      body: answer({ pubkey: nonCanonical(k2.pub) }),
      expect: failed('bad_key'),
    },
    { name: 'not JSON', context: 'reconnect', pinned_fp: k2.fp, body: 'mac_offline', expect: failed('bad_shape') },
    { name: 'a JSON array', context: 'reconnect', pinned_fp: k2.fp, body: '[]', expect: failed('bad_shape') },
    {
      name: 'an extra field',
      context: 'reconnect',
      pinned_fp: k2.fp,
      body: JSON.stringify({ pubkey: k2.pub, sig: sig2, chain: [], note: 'x' }),
      expect: failed('bad_shape'),
    },
    {
      name: 'no chain field',
      context: 'reconnect',
      pinned_fp: k2.fp,
      body: JSON.stringify({ pubkey: k2.pub, sig: sig2 }),
      expect: failed('bad_shape'),
    },
    {
      name: 'a chain entry with an extra field',
      context: 'reconnect',
      pinned_fp: k0.fp,
      body: answer({ chain: [{ ...c01, x: 1 }, c12] }),
      expect: failed('bad_shape'),
    },
    {
      name: 'a body over 8 KB (whitespace padding, otherwise a pass)',
      context: 'reconnect',
      pinned_fp: k2.fp,
      body: answer({}) + ' '.repeat(ATTEST_BODY_MAX - answer({}).length + 1),
      expect: failed('bad_shape'),
    },
    {
      name: 'a body of exactly 8 KB (padding): pass',
      context: 'reconnect',
      pinned_fp: k2.fp,
      body: answer({}) + ' '.repeat(ATTEST_BODY_MAX - answer({}).length),
      expect: pass,
    },
    {
      name: 'the identity point as the key, R = identity and S = 0 (a library may accept it for any message)',
      context: 'reconnect',
      pinned_fp: fpOfRaw(IDENTITY),
      body: answer({
        pubkey: b64urlEncode(IDENTITY),
        sig: b64urlEncode(new Uint8Array([1, ...new Array(63).fill(0)])),
      }),
      expect: failed('bad_key'),
    },
    {
      name: 'a point of order 8 as the key',
      context: 'reconnect',
      pinned_fp: fpOfRaw(ORDER8),
      body: answer({ pubkey: b64urlEncode(ORDER8) }),
      expect: failed('bad_key'),
    },
    {
      name: 'a key whose y is not below p (a non-canonical encoding)',
      context: 'reconnect',
      pinned_fp: fpOfRaw(Y_IS_P),
      body: answer({ pubkey: b64urlEncode(Y_IS_P) }),
      expect: failed('bad_key'),
    },
    {
      name: 'a signature whose last character is not canonical',
      context: 'reconnect',
      pinned_fp: k2.fp,
      body: answer({ sig: nonCanonical86(sig2) }),
      expect: failed('bad_sig'),
    },
    {
      name: 'a repeated key (the good pubkey last)',
      context: 'reconnect',
      pinned_fp: k2.fp,
      body: `{"pubkey":"${kx.pub}","pubkey":"${k2.pub}","sig":"${sig2}","chain":[]}`,
      expect: failed('bad_shape'),
    },
    {
      name: 'a repeated key (the good pubkey first)',
      context: 'reconnect',
      pinned_fp: k2.fp,
      body: `{"pubkey":"${k2.pub}","pubkey":"${kx.pub}","sig":"${sig2}","chain":[]}`,
      expect: failed('bad_shape'),
    },
    {
      name: 'a byte-order mark before the JSON',
      context: 'reconnect',
      pinned_fp: k2.fp,
      body: `\ufeff${answer({})}`,
      expect: failed('bad_shape'),
    },
    {
      name: 'bytes that are not UTF-8',
      context: 'reconnect',
      pinned_fp: k2.fp,
      body: '',
      raw: new Uint8Array([...new TextEncoder().encode(answer({}).slice(0, -1)), 0xff, 0x7d]),
      expect: failed('bad_shape'),
    },
    {
      name: 'an escaped character in a value decodes to the same text: pass',
      context: 'reconnect',
      pinned_fp: k2.fp,
      body: answer({}).replace(`"${k2.pub}"`, `"\\u00${k2.pub.charCodeAt(0).toString(16)}${k2.pub.slice(1)}"`),
      expect: pass,
    },
  ]
}

/** The cases the Swift twin's review asked for, where the two parsers or libraries could differ. */
async function moreCases({ k0, k1, k2, c01, c12, sig2, answer, flipped }: Ctx): Promise<Case[]> {
  const raw = (b: Uint8Array) => b64urlEncode(b)
  const idSig = b64urlEncode(new Uint8Array([1, ...new Array(63).fill(0)])) // R = identity, S = 0
  const toIdentity: RotationCertT = {
    relay_id: RELAY_ID,
    old_pubkey: k0.pub,
    new_pubkey: raw(IDENTITY),
    sig: await signRotationCert(k0.priv, RELAY_ID, k0.fp, fpOfRaw(IDENTITY)),
  }
  const fromIdentity: RotationCertT = { relay_id: RELAY_ID, old_pubkey: raw(IDENTITY), new_pubkey: k2.pub, sig: idSig }
  const sigWithS = (s: bigint) => {
    const b = new Uint8Array(Buffer.from(sig2, 'base64url'))
    let t = s
    for (let i = 32; i < 64; i++) {
      b[i] = Number(t & 0xffn)
      t >>= 8n
    }
    return b64urlEncode(b)
  }
  // nine keys and eight certificates, j0 -> j8: the longest chain there may be
  const js = await Promise.all(Array.from({ length: 9 }, (_, i) => key(`j${i}`, 20 + i)))
  const eight: RotationCertT[] = []
  for (let i = 0; i < 8; i++) {
    const [a, b] = [js[i] as Key, js[i + 1] as Key]
    eight.push({
      relay_id: RELAY_ID,
      old_pubkey: a.pub,
      new_pubkey: b.pub,
      sig: await signRotationCert(a.priv, RELAY_ID, a.fp, b.fp),
    })
  }
  const j8 = js[8] as Key
  const sig8 = await signAttest(j8.priv, NONCE, ORIGIN, j8.fp)
  const wide = (n: number) =>
    answer({ chain: [{ relay_id: '\u00e9'.repeat(n), old_pubkey: 'x', new_pubkey: 'y', sig: 'z' }] })
  const base = wide(0).length
  return [
    {
      name: 'a chain through the identity point, whose "signature" S = 0 a library may accept',
      context: 'reconnect',
      pinned_fp: k0.fp,
      body: answer({ chain: [toIdentity, fromIdentity] }),
      expect: failed('bad_chain'),
    },
    {
      name: 'a trailing comma in the object',
      context: 'reconnect',
      pinned_fp: k2.fp,
      body: `${answer({}).slice(0, -1)},}`,
      expect: failed('bad_shape'),
    },
    {
      name: 'a trailing comma in the chain array',
      context: 'reconnect',
      pinned_fp: k0.fp,
      body: answer({ chain: [c01, c12] }).replace(/\]\}$/, ',]}'),
      expect: failed('bad_shape'),
    },
    {
      name: 'a lone surrogate escape in a string',
      context: 'reconnect',
      pinned_fp: k2.fp,
      body: answer({}).replace(`"${sig2}"`, `"\\ud800${sig2.slice(1)}"`),
      expect: failed('bad_shape'),
    },
    {
      name: 'a number where a string belongs',
      context: 'reconnect',
      pinned_fp: k2.fp,
      body: `{"pubkey":123,"sig":"${sig2}","chain":[]}`,
      expect: failed('bad_shape'),
    },
    {
      name: 'the chain as an object',
      context: 'reconnect',
      pinned_fp: k2.fp,
      body: `{"pubkey":"${k2.pub}","sig":"${sig2}","chain":{}}`,
      expect: failed('bad_shape'),
    },
    {
      name: 'over 8192 bytes but under 8192 characters (2-byte characters in a chain that is not read)',
      context: 'reconnect',
      pinned_fp: k2.fp,
      body: wide(Math.floor((ATTEST_BODY_MAX - base) / 2) + 1),
      expect: failed('bad_shape'),
    },
    {
      name: 'the same with 2-byte characters, under 8192 bytes: pass',
      context: 'reconnect',
      pinned_fp: k2.fp,
      body: wide(Math.floor((ATTEST_BODY_MAX - base) / 2)),
      expect: pass,
    },
    {
      name: 'a 32-byte key that is not a curve point (y = 2): the check decides, not the library',
      context: 'reconnect',
      pinned_fp: fpOfRaw(NOT_ON_CURVE),
      body: answer({ pubkey: raw(NOT_ON_CURVE) }),
      expect: failed('bad_key'),
    },
    {
      name: 'S = L',
      context: 'reconnect',
      pinned_fp: k2.fp,
      body: answer({ sig: sigWithS(L) }),
      expect: failed('bad_sig'),
    },
    {
      name: 'a signature with = padding',
      context: 'reconnect',
      pinned_fp: k2.fp,
      body: answer({ sig: `${sig2}==` }),
      expect: failed('bad_sig'),
    },
    {
      name: 'a signature in the standard base64 alphabet',
      context: 'reconnect',
      pinned_fp: k2.fp,
      body: answer({ sig: `+${sig2.slice(1)}` }),
      expect: failed('bad_sig'),
    },
    {
      name: 'a non-canonical old key in the walked chain',
      context: 'reconnect',
      pinned_fp: k0.fp,
      body: answer({ chain: [{ ...c01, old_pubkey: nonCanonical(k0.pub) }, c12] }),
      expect: failed('bad_chain'),
    },
    {
      name: 'a non-canonical new key in the walked chain',
      context: 'reconnect',
      pinned_fp: k0.fp,
      body: answer({ chain: [{ ...c01, new_pubkey: nonCanonical(k1.pub) }, c12] }),
      expect: failed('bad_chain'),
    },
    {
      name: 'a malformed relay_id in the walked chain',
      context: 'reconnect',
      pinned_fp: k0.fp,
      body: answer({ chain: [{ ...c01, relay_id: 'R_ABCDEFGHIJKLMNOPQRST' }, c12] }),
      expect: failed('bad_chain'),
    },
    {
      name: 'two entries start at the pinned key and the first is broken',
      context: 'reconnect',
      pinned_fp: k0.fp,
      body: answer({ chain: [{ ...c01, sig: c12.sig }, c01, c12] }),
      expect: failed('bad_chain'),
    },
    {
      name: 'a valid chain of exactly 8: repin',
      context: 'reconnect',
      pinned_fp: (js[0] as Key).fp,
      body: JSON.stringify({ pubkey: j8.pub, sig: sig8, chain: eight }),
      expect: { verdict: 'repin', new_fp: j8.fp },
    },
    {
      name: 'nesting 5000 deep (past the depth cap of 16)',
      context: 'reconnect',
      pinned_fp: k2.fp,
      body: `{"pubkey":"${k2.pub}","sig":"${sig2}","chain":${'['.repeat(5000)}${']'.repeat(5000)}}`,
      expect: failed('bad_shape'),
    },
    {
      name: 'a valid chain and a bad attest signature at pairing: the signature, not repin_at_pair',
      context: 'pair',
      pinned_fp: k0.fp,
      body: answer({ sig: flipped, chain: [c01, c12] }),
      expect: failed('bad_sig'),
    },
  ]
}

async function main() {
  const x = await context()
  const { k0, k1, k2, kx, c01, sig2 } = x
  const cases: Case[] = [...(await chainCases(x)), ...(await shapeCases(x)), ...(await moreCases(x))]

  // every case must come out as written before the file is written
  const bytesOf = (c: Case) => c.raw ?? new TextEncoder().encode(c.body)
  for (const c of cases) {
    const got = await checkAttest({
      body: bytesOf(c),
      nonce: c.nonce ?? NONCE,
      origin: ORIGIN,
      relayId: RELAY_ID,
      pinnedFp: c.pinned_fp,
      context: c.context,
    })
    if (JSON.stringify(got) !== JSON.stringify(c.expect))
      throw new Error(`${c.name}: expected ${JSON.stringify(c.expect)}, got ${JSON.stringify(got)}`)
  }

  const keys = Object.fromEntries(
    [k0, k1, k2, kx].map((k) => [k.name, { seed_hex: hex(k.seed), pubkey: k.pub, fp: k.fp }]),
  )
  const file = {
    _comment:
      'Made by packages/protocol/scripts/gen-bridge-attest-vectors.ts from fixed TEST seeds (never real keys). Read by packages/protocol/test/bridge-attest.test.ts (under Node and Bun) and the iPhone app (TalosRelayCore). Every case is checked with nonce, origin and relay_id below; body_hex is the answer as received (body, when present, is the same as text); verdicts are pass, repin (new_fp) or fail (reason). k2 is the bridge key that signs; k0 -> k1 -> k2 are its rotations.',
    nonce: NONCE,
    origin: ORIGIN,
    relay_id: RELAY_ID,
    keys,
    attest_bytes_hex: hex(attestBytes(NONCE, ORIGIN, k2.fp)),
    attest_sig: sig2,
    cert_bytes_hex: hex(certBytes(RELAY_ID, k0.fp, k1.fp)),
    cert_sig: c01.sig,
    cases: cases.map(({ nonce: _n, raw, body, ...c }) => ({
      ...c,
      ...(raw ? {} : { body }),
      body_hex: hex(raw ?? new TextEncoder().encode(body)),
    })),
  }
  const text = `${JSON.stringify(file, null, 2)}\n`
  if (process.argv.includes('--check')) {
    if (readFileSync(out, 'utf8') !== text)
      throw new Error('fixtures/bridge-attest/vectors.json is stale: run the generator')
    console.log('bridge-attest vectors: up to date')
  } else {
    writeFileSync(out, text)
    console.log(`wrote ${cases.length} cases`)
  }
}

await main()
