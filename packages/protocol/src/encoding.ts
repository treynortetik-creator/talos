// Small, dependency-free byte helpers shared by the signature code. Isomorphic (browser, Node, Bun).

/** Uint8Array backed by a plain ArrayBuffer (what WebCrypto accepts as BufferSource under TS 6). */
export type Bytes = Uint8Array<ArrayBuffer>

const enc = new TextEncoder()
const dec = new TextDecoder()

export function utf8(s: string): Bytes {
  return enc.encode(s)
}
export function fromUtf8(b: Uint8Array): string {
  return dec.decode(b)
}

export function toHex(b: Uint8Array): string {
  let s = ''
  for (const x of b) s += x.toString(16).padStart(2, '0')
  return s
}
export function fromHex(h: string): Bytes {
  if (h.length % 2 !== 0 || /[^0-9a-f]/i.test(h)) throw new Error('bad hex')
  const out = new Uint8Array(h.length / 2)
  for (let i = 0; i < out.length; i++) out[i] = Number.parseInt(h.slice(i * 2, i * 2 + 2), 16)
  return out
}

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_'

/** base64url without padding. */
export function b64urlEncode(b: Uint8Array): string {
  let out = ''
  let i = 0
  for (; i + 2 < b.length; i += 3) {
    const n = ((b[i] as number) << 16) | ((b[i + 1] as number) << 8) | (b[i + 2] as number)
    out += B64[(n >> 18) & 63] + B64[(n >> 12) & 63] + B64[(n >> 6) & 63] + B64[n & 63]
  }
  const rem = b.length - i
  if (rem === 1) {
    const n = (b[i] as number) << 16
    out += B64[(n >> 18) & 63] + B64[(n >> 12) & 63]
  } else if (rem === 2) {
    const n = ((b[i] as number) << 16) | ((b[i + 1] as number) << 8)
    out += B64[(n >> 18) & 63] + B64[(n >> 12) & 63] + B64[(n >> 6) & 63]
  }
  return out
}

/** Strict base64url decode (no padding, no standard-alphabet characters). Throws on bad input. */
export function b64urlDecode(s: string): Bytes {
  if (/[^A-Za-z0-9_-]/.test(s) || s.length % 4 === 1) throw new Error('bad base64url')
  const out = new Uint8Array(Math.floor((s.length * 3) / 4))
  let acc = 0
  let bits = 0
  let o = 0
  for (const ch of s) {
    acc = (acc << 6) | B64.indexOf(ch)
    bits += 6
    if (bits >= 8) {
      bits -= 8
      out[o++] = (acc >> bits) & 0xff
    }
  }
  return out
}

const B32_LOWER = 'abcdefghijklmnopqrstuvwxyz234567'

/** RFC 4648 base32, lowercase, no padding. */
export function base32LowerEncode(b: Uint8Array): string {
  let out = ''
  let acc = 0
  let bits = 0
  for (const x of b) {
    acc = (acc << 8) | x
    bits += 8
    while (bits >= 5) {
      bits -= 5
      out += B32_LOWER[(acc >> bits) & 31]
    }
    acc &= (1 << bits) - 1
  }
  if (bits > 0) out += B32_LOWER[(acc << (5 - bits)) & 31]
  return out
}

/** Decodes lowercase RFC 4648 base32; trailing partial bits are dropped. Throws on bad characters. */
export function base32LowerDecode(s: string): Bytes {
  const out: number[] = []
  let acc = 0
  let bits = 0
  for (const ch of s) {
    const v = B32_LOWER.indexOf(ch)
    if (v < 0) throw new Error('bad base32')
    acc = (acc << 5) | v
    bits += 5
    if (bits >= 8) {
      bits -= 8
      out.push((acc >> bits) & 0xff)
      acc &= (1 << bits) - 1
    }
  }
  return Uint8Array.from(out)
}

export const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'

/**
 * Crockford base32 of a byte array, uppercase, right-aligned like a ULID (leading pad bits are zero), so 16 bytes give
 * 26 characters whose first character is 0-7.
 */
export function crockfordEncode(b: Uint8Array): string {
  const bits = b.length * 8
  const chars = Math.ceil(bits / 5)
  let acc = 0
  let have = chars * 5 - bits // leading zero bits
  let out = ''
  for (const x of b) {
    acc = (acc << 8) | x
    have += 8
    while (have >= 5) {
      have -= 5
      out += CROCKFORD[(acc >> have) & 31]
    }
    acc &= (1 << have) - 1
  }
  return out
}

/** Constant-time (length-independent early exit only on length) byte comparison. */
export function timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= (a[i] as number) ^ (b[i] as number)
  return diff === 0
}

export function concat(...parts: Uint8Array[]): Bytes {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0))
  let o = 0
  for (const p of parts) {
    out.set(p, o)
    o += p.length
  }
  return out
}

export function randomBytes(n: number): Bytes {
  const out = new Uint8Array(n)
  globalThis.crypto.getRandomValues(out)
  return out
}
