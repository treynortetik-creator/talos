// What a recording really is, from its first bytes. The claimed content type only gets it through the door.
/** Picture and video brands that share the `ftyp` box with m4a. A phone photo is not a recording. */
const NOT_AUDIO_BRANDS = new Set([
  'heic',
  'heix',
  'heim',
  'heis',
  'hevc',
  'hevx',
  'hevm',
  'hevs',
  'mif1',
  'msf1',
  'avif',
  'avis',
  'crx ',
])

export type AudioKind = 'm4a' | 'wav' | 'webm' | 'mp3'

export function sniffAudio(b: Uint8Array): AudioKind | null {
  const at = (i: number, s: string) => s.split('').every((ch, k) => b[i + k] === ch.charCodeAt(0))
  if (b[0] === 0x1a && b[1] === 0x45 && b[2] === 0xdf && b[3] === 0xa3) return 'webm'
  if (at(0, 'RIFF') && at(8, 'WAVE')) return 'wav'
  if (at(4, 'ftyp')) {
    const brand = String.fromCharCode(b[8] ?? 0, b[9] ?? 0, b[10] ?? 0, b[11] ?? 0)
    return NOT_AUDIO_BRANDS.has(brand) ? null : 'm4a'
  }
  if (at(0, 'ID3')) return 'mp3'
  // A bare MPEG frame: eleven set bits, then a layer that is not "reserved".
  if (b[0] === 0xff && ((b[1] ?? 0) & 0xe0) === 0xe0 && ((b[1] ?? 0) & 0x06) !== 0) return 'mp3'
  return null
}
