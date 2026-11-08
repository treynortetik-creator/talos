// A frame that does not parse is one of two things: a peer built from a NEWER protocol (a frame type, field or enum value
// this build has never heard of) or a broken one. Both are refused, but only the first is worth telling the owner about:
// "update me". This tells them apart without reading the frame's content. Every side that drops a frame uses it, so the
// web, the Mac's bridge and the tests agree on what "newer" means.
import type { z } from 'zod'
import { type Direction, frameSchemas, isFrameFor } from './frames.ts'
import { PROTOCOL_VERSION } from './version.ts'

/** A type name as a peer would write it. Anything else is junk, not a newer version, and is never repeated back. */
const TYPE_NAME = /^[a-z_][a-z0-9_.]{0,63}$/

export type Unparsed =
  /** A frame type this build does not list. */
  | { kind: 'unknown_type'; type: string }
  /** A type this build lists, refused only for an unlisted field or enum/literal value. */
  | { kind: 'newer_shape'; type: string }
  /** Anything else: junk, a missing or wrong-typed field, the wrong direction. No note. */
  | { kind: 'broken' }

/** The keys a schema can carry, through unions, optionals and pipes. */
function keysOf(schema: unknown, seen = new Set<unknown>()): Set<string> {
  const out = new Set<string>()
  if (typeof schema !== 'object' || schema === null || seen.has(schema)) return out
  seen.add(schema)
  const def = (schema as { _zod?: { def?: Record<string, unknown> } })._zod?.def
  if (!def) return out
  if (def.shape && typeof def.shape === 'object') for (const k of Object.keys(def.shape)) out.add(k)
  const kids = [...(Array.isArray(def.options) ? def.options : []), def.innerType, def.in, def.out, def.left, def.right]
  for (const kid of kids) for (const k of keysOf(kid, seen)) out.add(k)
  return out
}

/** A key that carries a signature (`osig`, `asig`, `sig`, `owner_sig`...). */
const SIG_KEY = /(^|_)[a-z]?sig$/

/**
 * Frame types that carry a signature, read from the schemas themselves so a signed frame added later is covered with no
 * list to keep. A refused signed frame is a security matter (a forged or tampered frame), never "your app is out of date".
 */
export const SIGNED_FRAME_TYPES: ReadonlySet<string> = new Set(
  Object.entries(frameSchemas)
    .filter(([, schema]) => [...keysOf(schema)].some((k) => SIG_KEY.test(k)))
    .map(([type]) => type),
)

/** True when the raw frame names a type that carries a signature, or has a signature field of its own. */
export function looksSigned(raw: unknown): boolean {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return false
  const type = (raw as { type?: unknown }).type
  if (typeof type === 'string' && SIGNED_FRAME_TYPES.has(type)) return true
  return Object.keys(raw).some((k) => SIG_KEY.test(k))
}

function valueAt(raw: unknown, path: readonly PropertyKey[]): unknown {
  let cur = raw
  for (const k of path) {
    if (typeof cur !== 'object' || cur === null || !Object.hasOwn(cur, k)) return undefined
    cur = (cur as Record<PropertyKey, unknown>)[k]
  }
  return cur
}

/**
 * True when every issue is "a key I do not know" or "a value I do not list", so a newer build could have caused all of
 * them. The value has to be PRESENT and of the right kind (a string for an enum, a number above ours for `v`): a missing,
 * null or wrong-typed value is a broken frame, even though zod reports it as an unlisted value too.
 */
function onlyNewerFaults(issues: readonly z.core.$ZodIssue[], raw: unknown): boolean {
  return (
    issues.length > 0 &&
    issues.every((i) => {
      if (i.code === 'unrecognized_keys') return true
      if (i.code === 'invalid_value') {
        const got = valueAt(raw, i.path)
        if (i.path.length === 1 && i.path[0] === 'v') return typeof got === 'number' && got > PROTOCOL_VERSION
        return typeof got === 'string'
      }
      if (i.code === 'invalid_union') {
        // A discriminated union that finds no branch for a string tag: a variant added later.
        if (i.errors.length === 0) return typeof valueAt(raw, i.path) === 'string'
        // A plain union passes if any branch fits, so it is a newer shape if some branch fails by newer faults alone.
        return i.errors.some((branch) => onlyNewerFaults(branch, raw))
      }
      return false
    })
  )
}

/** Why a raw frame from `direction`'s sender did not parse (call it only after `parseFrame` said no). */
export function classifyUnparsed(raw: unknown, direction: Direction): Unparsed {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return { kind: 'broken' }
  const type = (raw as { type?: unknown }).type
  if (typeof type !== 'string' || !TYPE_NAME.test(type)) return { kind: 'broken' }
  if (!Object.hasOwn(frameSchemas, type)) return { kind: 'unknown_type', type }
  if (!isFrameFor(direction, { type })) return { kind: 'broken' }
  const res = (frameSchemas[type as keyof typeof frameSchemas] as z.ZodType).safeParse(raw)
  if (res.success) return { kind: 'broken' }
  return onlyNewerFaults(res.error.issues, raw) ? { kind: 'newer_shape', type } : { kind: 'broken' }
}
