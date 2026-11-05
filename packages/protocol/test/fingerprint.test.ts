import { describe, expect, it } from 'vitest'
import { createDeviceKey, fingerprintWords, PGP_EVEN_WORDS, PGP_ODD_WORDS } from '../src/index.ts'

describe('fingerprintWords', () => {
  it('word lists are 256 distinct entries each, with the known anchors', () => {
    expect(PGP_EVEN_WORDS).toHaveLength(256)
    expect(PGP_ODD_WORDS).toHaveLength(256)
    expect(new Set([...PGP_EVEN_WORDS, ...PGP_ODD_WORDS]).size).toBe(512)
    expect(PGP_EVEN_WORDS[0]).toBe('aardvark')
    expect(PGP_ODD_WORDS[0]).toBe('adroitness')
    expect(PGP_EVEN_WORDS[255]).toBe('Zulu')
  })
  it('is stable: pinned vectors', () => {
    // base32 "aaaaaaaa" = bytes 00 00 00 00 -> even, odd, even, odd lists at index 0
    expect(fingerprintWords('d_aaaaaaaaaaaaaaaaaaaa')).toEqual(['aardvark', 'adroitness', 'aardvark', 'adroitness'])
    // base32 "77777777" = bytes ff ff ff ff
    expect(fingerprintWords('d_77777777777777777777')).toEqual(['Zulu', 'Yucatán', 'Zulu', 'Yucatán'])
    expect(fingerprintWords('d_k3j2h4g5f6d7s2a7q2w3')).toEqual(fingerprintWords('d_k3j2h4g5f6d7s2a7q2w3'))
  })
  it('returns four words and differs between devices', async () => {
    const a = fingerprintWords((await createDeviceKey()).deviceId)
    const b = fingerprintWords((await createDeviceKey()).deviceId)
    expect(a).toHaveLength(4)
    expect(a.join(' ')).not.toBe(b.join(' '))
  })
  it('rejects malformed ids', () => {
    expect(() => fingerprintWords('nope')).toThrow()
    expect(() => fingerprintWords('d_short')).toThrow()
  })
})
