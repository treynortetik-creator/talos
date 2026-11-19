// BYOR phase 4: the attest and rotation-certificate bytes, and the phone's check over the shared vectors
// (fixtures/bridge-attest/vectors.json, which the iPhone app's Swift twin runs too), plus the file's freshness.
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { describe, expect, test } from 'vitest'
import {
  type AttestVerdict,
  attestBytes,
  certBytes,
  checkAttest,
  isCanonicalB64_32,
  parseStrictJson,
} from '../src/index.ts'

const dir = new URL('../', import.meta.url)
const v = JSON.parse(readFileSync(new URL('fixtures/bridge-attest/vectors.json', dir), 'utf8')) as {
  nonce: string
  origin: string
  relay_id: string
  keys: Record<string, { seed_hex: string; pubkey: string; fp: string }>
  attest_bytes_hex: string
  attest_sig: string
  cert_bytes_hex: string
  cert_sig: string
  cases: {
    name: string
    context: 'pair' | 'reconnect'
    pinned_fp: string
    body?: string
    body_hex: string
    expect: AttestVerdict
  }[]
}

describe('attest bytes', () => {
  test('the attest bytes are the tag, nonce, origin and fp as text, LF only, no trailing LF', () => {
    const want = `talos-bridge-attest/v1\n${v.nonce}\n${v.origin}\n${v.keys.k2?.fp}`
    expect(Buffer.from(attestBytes(v.nonce, v.origin, v.keys.k2?.fp as string)).toString('utf8')).toBe(want)
    expect(Buffer.from(v.attest_bytes_hex, 'hex').toString('utf8')).toBe(want)
  })
  test('the certificate bytes are the tag, relay_id, old fp and new fp as text', () => {
    const want = `talos-rotate-cert/v1\n${v.relay_id}\n${v.keys.k0?.fp}\n${v.keys.k1?.fp}`
    expect(Buffer.from(certBytes(v.relay_id, v.keys.k0?.fp as string, v.keys.k1?.fp as string)).toString('utf8')).toBe(
      want,
    )
    expect(Buffer.from(v.cert_bytes_hex, 'hex').toString('utf8')).toBe(want)
  })
  test('each fp is base64url of the sha256 of the raw key (checked with node:crypto)', () => {
    for (const k of Object.values(v.keys))
      expect(k.fp).toBe(createHash('sha256').update(Buffer.from(k.pubkey, 'base64url')).digest('base64url'))
  })
  test('the top-level signatures verify with node:crypto', async () => {
    const { createPublicKey, verify } = await import('node:crypto')
    const pub = (b64: string) => createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x: b64 }, format: 'jwk' })
    expect(
      verify(
        null,
        Buffer.from(v.attest_bytes_hex, 'hex'),
        pub(v.keys.k2?.pubkey as string),
        Buffer.from(v.attest_sig, 'base64url'),
      ),
    ).toBe(true)
    expect(
      verify(
        null,
        Buffer.from(v.cert_bytes_hex, 'hex'),
        pub(v.keys.k0?.pubkey as string),
        Buffer.from(v.cert_sig, 'base64url'),
      ),
    ).toBe(true)
  })
  test('a canonical 32-byte base64url text has a last character whose two spare bits are 0', () => {
    expect(isCanonicalB64_32('A'.repeat(43))).toBe(true)
    expect(isCanonicalB64_32(`${'A'.repeat(42)}B`)).toBe(false)
    expect(isCanonicalB64_32(`${'A'.repeat(42)}E`)).toBe(true)
    expect(isCanonicalB64_32(`${'A'.repeat(42)}_`)).toBe(false)
    expect(isCanonicalB64_32('A'.repeat(42))).toBe(false)
    for (const k of Object.values(v.keys)) expect(isCanonicalB64_32(k.fp) && isCanonicalB64_32(k.pubkey)).toBe(true)
  })
})

describe('strict JSON depth', () => {
  test('16 levels parse, 17 do not', () => {
    expect(parseStrictJson(`${'['.repeat(16)}${']'.repeat(16)}`)).toBeDefined()
    expect(parseStrictJson(`${'['.repeat(17)}${']'.repeat(17)}`)).toBeUndefined()
    expect(parseStrictJson(`${'[{"a":'.repeat(8)}1${'}]'.repeat(8)}`)).toBeDefined()
    expect(parseStrictJson(`${'[{"a":'.repeat(8)}[1]${'}]'.repeat(8)}`)).toBeUndefined()
  })
})

describe('bridge-attest vectors', () => {
  test('there are cases, each named once, every verdict and reason present', () => {
    expect(new Set(v.cases.map((c) => c.name)).size).toBe(v.cases.length)
    const kinds = new Set(v.cases.map((c) => (c.expect.verdict === 'fail' ? c.expect.reason : c.expect.verdict)))
    for (const k of ['pass', 'repin', 'bad_shape', 'bad_key', 'bad_sig', 'bad_chain', 'wrong_fp', 'repin_at_pair'])
      expect(kinds).toContain(k)
  })
  test.each(v.cases)('$name', async (c) => {
    const got = await checkAttest({
      body: new Uint8Array(Buffer.from(c.body_hex, 'hex')),
      nonce: v.nonce,
      origin: v.origin,
      relayId: v.relay_id,
      pinnedFp: c.pinned_fp,
      context: c.context,
    })
    expect(got).toEqual(c.expect)
  })
  test('a case with body text has the same bytes as its body_hex', () => {
    for (const c of v.cases)
      if (c.body !== undefined) expect(Buffer.from(c.body, 'utf8').toString('hex'), c.name).toBe(c.body_hex)
  })
  // the generator checks every case as it writes; under Bun too, whose WebCrypto accepts what Node refuses (a small-order
  // key with S = 0): the check must decide by itself, not by the library
  test('every case comes out as written under Bun as well', () => {
    execFileSync('bun', ['scripts/gen-bridge-attest-vectors.ts', '--check'], {
      cwd: new URL('.', dir).pathname,
      stdio: 'pipe',
    })
  })
  test('the committed file is what the generator writes', () => {
    execFileSync(
      process.execPath,
      [
        '--disable-warning=ExperimentalWarning',
        '--experimental-transform-types',
        'scripts/gen-bridge-attest-vectors.ts',
        '--check',
      ],
      { cwd: new URL('.', dir).pathname, stdio: 'pipe' },
    )
  })
})
