import canonicalize from 'canonicalize'
import { sha256Hex } from './hash.ts'
import type { CardBinding } from './models.ts'

export { sha256Hex }

/** RFC 8785 JSON Canonicalization Scheme. Input must be plain JSON (no undefined at the top level). */
export function jcs(value: unknown): string {
  const out = canonicalize(value)
  if (out === undefined) throw new Error('jcs: value is not JSON-serializable')
  return out
}

/** `sha256:<hex>` over the JCS form of exactly what the owner sees and approves. */
export function payloadHash(binding: CardBinding | Record<string, unknown>): string {
  return `sha256:${sha256Hex(jcs(binding))}`
}
