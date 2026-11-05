// MIME sniffing from magic bytes (spec 5.4). The relay never trusts the uploader's Content-Type: a `.html` file
// claiming `image/png` is stored and served as HTML (an attachment, in a sandbox).

const startsWith = (b: Uint8Array, sig: number[], at = 0) => sig.every((v, i) => b[at + i] === v)
const ascii = (b: Uint8Array, from: number, to: number) => String.fromCharCode(...b.subarray(from, to))

function isMostlyText(b: Uint8Array): boolean {
  const n = Math.min(b.length, 4096)
  for (let i = 0; i < n; i++) {
    const c = b[i] as number
    if (c === 0) return false
    if (c < 9 || (c > 13 && c < 32)) return false
  }
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(b.subarray(0, n))
    return true
  } catch {
    // a multi-byte character may be cut at the 4096 boundary
    return n < b.length
  }
}

/**
 * @param claimed the uploader's Content-Type; only used to choose between audio and video for containers that can be
 *   either (WebM, MP4), never to widen what is served.
 */
export function sniffMime(bytes: Uint8Array, claimed = ''): string {
  const c = claimed.split(';')[0]?.trim().toLowerCase() ?? ''
  if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return 'image/png'
  if (startsWith(bytes, [0xff, 0xd8, 0xff])) return 'image/jpeg'
  if (ascii(bytes, 0, 6) === 'GIF87a' || ascii(bytes, 0, 6) === 'GIF89a') return 'image/gif'
  if (ascii(bytes, 0, 4) === 'RIFF') {
    const kind = ascii(bytes, 8, 12)
    if (kind === 'WEBP') return 'image/webp'
    if (kind === 'WAVE') return 'audio/wav'
    if (kind === 'AVI ') return 'video/x-msvideo'
  }
  if (ascii(bytes, 0, 5) === '%PDF-') return 'application/pdf'
  if (ascii(bytes, 0, 4) === 'OggS') return c.startsWith('video/') ? 'video/ogg' : 'audio/ogg'
  if (ascii(bytes, 0, 4) === 'fLaC') return 'audio/flac'
  if (ascii(bytes, 0, 3) === 'ID3' || (bytes[0] === 0xff && ((bytes[1] as number) & 0xe0) === 0xe0)) return 'audio/mpeg'
  if (startsWith(bytes, [0x1a, 0x45, 0xdf, 0xa3])) return c.startsWith('audio/') ? 'audio/webm' : 'video/webm'
  if (ascii(bytes, 4, 8) === 'ftyp') {
    const brand = ascii(bytes, 8, 12)
    if (brand === 'M4A ' || brand === 'M4B ' || c === 'audio/mp4' || c === 'audio/x-m4a') return 'audio/mp4'
    if (brand === 'qt  ') return 'video/quicktime'
    if (brand.startsWith('heic') || brand.startsWith('heix') || brand === 'mif1') return 'image/heic'
    return 'video/mp4'
  }
  if (ascii(bytes, 0, 4) === 'PK\x03\x04') return 'application/zip'
  if (isMostlyText(bytes)) {
    const head = new TextDecoder().decode(bytes.subarray(0, 2048)).replace(/^﻿/, '').trimStart().toLowerCase()
    if (/^<\?xml[\s\S]*?<svg[\s>]/.test(head) || /^<svg[\s>]/.test(head) || /^<!doctype svg/.test(head))
      return 'image/svg+xml'
    if (
      /^<!doctype html/.test(head) ||
      /^<(html|head|body|script|iframe|style|meta|link|a|div|p|img|h[1-6]|table|form|svg)[\s>/]/.test(head) ||
      /<script[\s>]/.test(head)
    )
      return 'text/html'
    if (head.startsWith('{') || head.startsWith('[')) return 'application/json'
    return 'text/plain'
  }
  return 'application/octet-stream'
}

/** Types shown inline; everything else, including SVG and HTML, is an attachment (spec 5.4). */
export function isInlineMime(mime: string): boolean {
  return (
    ['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'video/mp4', 'video/webm', 'application/pdf'].includes(
      mime,
    ) || mime.startsWith('audio/')
  )
}

export function kindForMime(mime: string): 'image' | 'voice_note' | 'video' | 'html' | 'file' {
  if (mime === 'text/html') return 'html'
  if (mime.startsWith('image/')) return 'image'
  if (mime.startsWith('audio/')) return 'voice_note'
  if (mime.startsWith('video/')) return 'video'
  return 'file'
}
