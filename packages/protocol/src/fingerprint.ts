import { base32LowerDecode } from './encoding.ts'
import { PGP_EVEN_WORDS, PGP_ODD_WORDS } from './pgp-words.ts'

/**
 * Four PGP words (32 bits) from the first four bytes of the device id's base32 body. Shown on the phone and at the
 * Mac's y/N pin prompt so the owner can confirm both sides see the same device. Even byte positions use the
 * two-syllable list, odd positions the three-syllable list.
 */
export function fingerprintWords(deviceId: string): [string, string, string, string] {
  const m = /^d_([a-z2-7]{20})$/.exec(deviceId)
  if (!m) throw new Error('invalid device id')
  const bytes = base32LowerDecode((m[1] as string).slice(0, 8)) // 8 chars = 40 bits = 5 bytes; first 4 used
  const w = (i: number) => (i % 2 === 0 ? PGP_EVEN_WORDS : PGP_ODD_WORDS)[bytes[i] as number] as string
  return [w(0), w(1), w(2), w(3)]
}
