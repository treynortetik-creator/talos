// sha256 for the C3.4 closer. `input_hash` is defined as sha256 over the call's input as compact JSON with every
// whitespace character removed: the bridge can recompute it from the relayed `input_preview` (which Claude Code
// whitespace-folds), so an unmodified preview matches and an elided or masked one simply does not (the card stays).

const HEX = '0123456789abcdef'

export async function sha256Hex(text: string): Promise<string> {
  const bytes = new TextEncoder().encode(text)
  const buf = await crypto.subtle.digest(
    'SHA-256',
    bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer,
  )
  let out = ''
  for (const b of new Uint8Array(buf)) out += HEX[b >> 4] + HEX[b & 15]
  return out
}

/** Compact JSON of `input` with all whitespace removed; `undefined` for something JSON cannot hold. */
export function foldedJson(input: unknown): string | undefined {
  try {
    const s = JSON.stringify(input)
    return typeof s === 'string' ? s.replace(/\s+/g, '') : undefined
  } catch {
    return undefined
  }
}

/** `sha256:<64 hex>` of foldedJson(input), or undefined when the input has no JSON form. */
export async function inputHash(input: unknown): Promise<string | undefined> {
  const folded = foldedJson(input)
  return folded === undefined ? undefined : `sha256:${await sha256Hex(folded)}`
}

/**
 * The byte string both ends MAC: JSON with keys sorted at every level, `undefined` members left out. A copy of the
 * bridge's `canonicalJson` (apps/bridge/src/mod/canonical.ts); a test pins the two together.
 */
export function canonicalJson(v: unknown): string {
  if (v === null || typeof v !== 'object') return JSON.stringify(v) ?? 'null'
  if (Array.isArray(v)) return `[${v.map((x) => canonicalJson(x === undefined ? null : x)).join(',')}]`
  const o = v as Record<string, unknown>
  const parts: string[] = []
  for (const k of Object.keys(o).sort()) {
    if (o[k] === undefined) continue
    parts.push(`${JSON.stringify(k)}:${canonicalJson(o[k])}`)
  }
  return `{${parts.join(',')}}`
}

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_'
function base64url(bytes: Uint8Array): string {
  let out = ''
  for (let i = 0; i < bytes.length; i += 3) {
    const n = ((bytes[i] ?? 0) << 16) | ((bytes[i + 1] ?? 0) << 8) | (bytes[i + 2] ?? 0)
    out += B64[(n >> 18) & 63] ?? ''
    out += B64[(n >> 12) & 63] ?? ''
    if (i + 1 < bytes.length) out += B64[(n >> 6) & 63] ?? ''
    if (i + 2 < bytes.length) out += B64[n & 63] ?? ''
  }
  return out
}

async function sha256Bytes(bytes: Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(
    await crypto.subtle.digest(
      'SHA-256',
      bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer,
    ),
  )
}

/**
 * HMAC-SHA256(key, message) as base64url: 43 characters, the shape of the protocol's `ModKey`. Built on `digest` (RFC 2104)
 * because the mod's environment has `crypto.subtle.digest` but not `importKey`/`sign`. Pinned to node's createHmac by a test.
 */
export async function hmacB64url(key: string, message: string): Promise<string> {
  const enc = new TextEncoder()
  let k: Uint8Array = enc.encode(key)
  if (k.length > 64) k = await sha256Bytes(k)
  const ipad = new Uint8Array(64).fill(0x36)
  const opad = new Uint8Array(64).fill(0x5c)
  for (let i = 0; i < k.length; i++) {
    ipad[i] = (ipad[i] ?? 0) ^ (k[i] ?? 0)
    opad[i] = (opad[i] ?? 0) ^ (k[i] ?? 0)
  }
  const m = enc.encode(message)
  const inner = await sha256Bytes(Uint8Array.from([...ipad, ...m]))
  return base64url(await sha256Bytes(Uint8Array.from([...opad, ...inner])))
}
