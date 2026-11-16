// A thread session's launch spec, hashed (restart-on-update; Delphi's design, the procedure Hestia's): when Talos updates, a
// session launched from an older spec is restarted once. Each supervisor builds the object from what its own launch actually
// used and compares the hash only with its own record (WorkerLaunched.spec_hash) on the same machine: the Mac and Linux share
// this procedure and its vectors (fixtures/spec-hash), never values.
//
// The object: { v: 1, argv, env, files }
// - argv: the command exactly as launched (the claude path, then the flags), order kept (an array is never sorted).
// - env: every variable the launcher SETS for the session (not the inherited environment), names and values: a changed value must
//   restart, and the hash shows none of them.
// - files: every file the launch writes for the session, by a stable name, each the sha256 hex of the exact bytes written.
// - Never in it: the nonce (its file and its variable), the session id, timestamps, or any other value that differs per launch;
//   each side names its exclusions in one constant.
// - A key whose value is absent is left out; null stays null; never undefined. Numbers and booleans as RFC 8785 writes them.
// spec_hash = "sha256:" + hex(sha256(JCS(object))), JCS over UTF-8.
import { z } from 'zod'
import { jcs, sha256Hex } from './canonical.ts'

/** A spec hash as WorkerLaunched keeps it. */
export const SPEC_HASH_PATTERN = /^sha256:[0-9a-f]{64}$/
export const SpecHash = z.string().regex(SPEC_HASH_PATTERN)

/** The object each supervisor builds from its own launch. */
export type LaunchSpecT = {
  v: 1
  argv: readonly string[]
  env: Readonly<Record<string, string>>
  files: Readonly<Record<string, string>>
}

/** A string RFC 8785 cannot write: a lone (unpaired) surrogate. */
const LONE_SURROGATE = /[\uD800-\uDFFF]/u

/**
 * Plain JSON with every absent (undefined) key left out at any depth (an absent array item reads as null, as JSON writes it).
 * Anything that is not plain JSON throws, never hashed as something else (Fable R1-2): a function, a symbol, a bigint, NaN or an
 * infinity, a lone surrogate in a string or a key, an object that is not a plain one (a Date, a Map, a Set, a boxed number), a
 * symbol key. A `__proto__` key is kept as the own key it is (JSON.parse makes one; jcs and the Mac's twin write it).
 */
function plain(value: unknown, at: string): unknown {
  const no = (why: string): never => {
    throw new Error(`specHash: ${at} ${why}`)
  }
  if (value === null || typeof value === 'boolean') return value
  if (typeof value === 'string') return LONE_SURROGATE.test(value) ? no('holds a lone surrogate') : value
  if (typeof value === 'number') return Number.isFinite(value) ? value : no('is not a finite number')
  if (Array.isArray(value)) return Array.from(value, (v, i) => plain(v === undefined ? null : v, `${at}[${i}]`))
  if (typeof value !== 'object') return no('is not JSON')
  const proto = Object.getPrototypeOf(value)
  if (proto !== Object.prototype && proto !== null) return no('is not a plain object')
  if (Object.getOwnPropertySymbols(value).length > 0) return no('has a symbol key')
  const out = Object.create(null) as Record<string, unknown> // `__proto__` stays an own key here
  for (const k of Object.keys(value)) {
    if (LONE_SURROGATE.test(k)) no('has a key with a lone surrogate')
    const v = (value as Record<string, unknown>)[k]
    if (v !== undefined) out[k] = plain(v, `${at}.${k}`)
  }
  return out
}

/** "sha256:" + hex over the JCS form of `spec` (a LaunchSpecT, or any JSON object for the shared vectors). */
export function specHash(spec: LaunchSpecT | Record<string, unknown>): string {
  return `sha256:${sha256Hex(jcs(plain(spec, 'spec')))}`
}
