import { createHash, createHmac, hkdfSync, randomBytes } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { hkdfSha256, hmacSha256, jcs, sha256, sha256Hex, toHex, utf8 } from '../src/index.ts'

describe('jcs (RFC 8785)', () => {
  it('sorts keys by UTF-16 code unit (RFC 8785 3.2.3)', () => {
    const input = {
      '\u20ac': 'Euro Sign',
      '\r': 'Carriage Return',
      '\ufb33': 'Hebrew Letter Dalet With Dagesh',
      '1': 'One',
      '\ud83d\ude00': 'Emoji: Grinning Face',
      '\u0080': 'Control',
      '\u00f6': 'Latin Small Letter O With Diaeresis',
    }
    const order = ['\r', '1', '\u0080', '\u00f6', '\u20ac', '\ud83d\ude00', '\ufb33'] as const
    const expected = `{${order.map((k) => `${JSON.stringify(k)}:${JSON.stringify(input[k])}`).join(',')}}`
    expect(jcs(input)).toBe(expected)
  })

  it('matches the RFC 8785 3.2.2 example', () => {
    const input = JSON.parse(
      '{"numbers":[333333333.33333329,1E30,4.50,2e-3,0.000000000000000000000000001],"string":"\\u20ac$\\u000F\\u000aA\'\\u0042\\u0022\\u005c\\\\\\"\\/","literals":[null,true,false]}',
    )
    expect(jcs(input)).toBe(
      '{"literals":[null,true,false],"numbers":[333333333.3333333,1e+30,4.5,0.002,1e-27],"string":"\u20ac$\\u000f\\nA\'B\\"\\\\\\\\\\"/"}',
    )
  })

  it('serializes numbers per ECMAScript (RFC 8785 appendix B samples)', () => {
    expect(jcs([0, -0, 1e21, 1e-7, 0.000001, 4.5, 123456789012345680000])).toBe(
      '[0,0,1e+21,1e-7,0.000001,4.5,123456789012345680000]',
    )
  })

  it('is insensitive to key insertion order and whitespace', () => {
    expect(jcs({ b: 1, a: [1, { d: 1, c: 2 }] })).toBe(jcs(JSON.parse('{ "a": [1, {"c":2, "d":1}], "b": 1 }')))
  })

  it('throws on non-serializable input', () => {
    expect(() => jcs(undefined)).toThrow()
  })
})

describe('sha256 / hmac / hkdf match node:crypto', () => {
  it('sha256 on known and random inputs', () => {
    expect(sha256Hex('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad')
    expect(sha256Hex('')).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855')
    for (const n of [1, 55, 56, 63, 64, 65, 119, 120, 1000, 100_000]) {
      const b = randomBytes(n)
      expect(toHex(sha256(b))).toBe(createHash('sha256').update(b).digest('hex'))
    }
  })
  it('hmac-sha256 incl. long keys', () => {
    for (const kl of [0, 7, 32, 64, 65, 200]) {
      const key = randomBytes(kl)
      const msg = randomBytes(300)
      expect(toHex(hmacSha256(key, msg))).toBe(createHmac('sha256', key).update(msg).digest('hex'))
    }
  })
  it('hkdf-sha256 incl. empty salt (RFC 5869)', () => {
    for (const salt of [new Uint8Array(0), randomBytes(16)]) {
      const ikm = randomBytes(26)
      const info = utf8('talos-enroll-auth/v1')
      const expected = Buffer.from(hkdfSync('sha256', ikm, salt, info, 42)).toString('hex')
      expect(toHex(hkdfSha256(ikm, salt, info, 42))).toBe(expected)
    }
  })
})
