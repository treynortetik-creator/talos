// specHash (spec-hash.ts) against the shared vectors (fixtures/spec-hash/vectors.json), which the Mac's twin reads too; and the
// two WorkerLaunched fields that keep it.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { jcs, SPEC_HASH_PATTERN, specHash, WorkerLaunched } from '../src/index.ts'

const DOC = JSON.parse(readFileSync(join(import.meta.dirname, '../fixtures/spec-hash/vectors.json'), 'utf8')) as {
  vectors: Array<{
    name: string
    input: Record<string, unknown>
    jcs: string
    hash: string
    undefined_paths?: Array<Array<string | number>>
  }>
  must_throw: Array<{
    name: string
    input: Record<string, unknown>
    replace?: { path: string[]; with: 'NaN' | 'Infinity' }
  }>
}

/** A deep copy of `o` with `value` put at `path` (keys and array indexes). */
function put(o: Record<string, unknown>, path: Array<string | number>, value: unknown): Record<string, unknown> {
  const copy = structuredClone(o)
  let at: Record<string | number, unknown> = copy
  for (const k of path.slice(0, -1)) at = at[k] as Record<string | number, unknown>
  at[path[path.length - 1] as string | number] = value
  return copy
}

describe('specHash: the shared vectors', () => {
  it('has the vectors the procedure names', () => {
    expect(DOC.vectors.length).toBeGreaterThanOrEqual(17)
    expect(DOC.must_throw.length).toBeGreaterThanOrEqual(4)
  })
  for (const m of DOC.must_throw)
    it(`refuses: ${m.name}`, () => {
      const input = m.replace
        ? put(m.input, m.replace.path, m.replace.with === 'NaN' ? Number.NaN : Number.POSITIVE_INFINITY)
        : m.input
      expect(() => specHash(input)).toThrow()
    })
  for (const v of DOC.vectors)
    it(v.name, () => {
      let input: Record<string, unknown> = v.input
      for (const p of v.undefined_paths ?? []) input = put(input, p, undefined)
      expect(jcs(v.input)).toBe(v.jcs)
      expect(specHash(input)).toBe(v.hash)
      expect(v.hash).toMatch(SPEC_HASH_PATTERN)
    })
  it('argv order, an env value and a file’s bytes each change the hash; the vectors that differ only there differ', () => {
    const byName = Object.fromEntries(DOC.vectors.map((v) => [v.name, v.hash]))
    const base = byName['a typical thread launch']
    for (const n of ['argv order kept', 'one env value changed', "one file's bytes changed"])
      expect(byName[n]).not.toBe(base)
    expect(byName['an absent key is left out']).toBe(byName.minimal)
  })
})

describe('specHash: input', () => {
  it('throws on an object that is not plain JSON, and keeps a __proto__ key as the own key JSON.parse makes (Fable R1-2)', () => {
    const a = { v: 1, argv: [], env: {}, files: {} }
    for (const bad of [new Date(0), new Map(), new Set(), Object(1), { [Symbol('s')]: 1 }, 10n])
      expect(() => specHash({ ...a, x: bad as unknown })).toThrow()
    const withProto = JSON.parse('{"v":1,"argv":[],"env":{},"files":{},"__proto__":{"x":1}}')
    expect(specHash(withProto)).not.toBe(specHash(a))
    expect(jcs(withProto)).toBe('{"__proto__":{"x":1},"argv":[],"env":{},"files":{},"v":1}')
  })
  it('leaves out an absent key at any depth; keeps null; throws on what is not JSON', () => {
    const a = { v: 1, argv: [], env: {}, files: {} }
    expect(specHash({ ...a, x: undefined, env: { A: '1', B: undefined } as Record<string, unknown> })).toBe(
      specHash({ ...a, env: { A: '1' } }),
    )
    expect(specHash({ ...a, x: null })).not.toBe(specHash(a))
    expect(() => specHash({ ...a, x: Number.NaN })).toThrow()
    expect(() => specHash({ ...a, x: () => 1 })).toThrow()
  })
})

describe('WorkerLaunched: spec_hash and update_tried_hash', () => {
  const base = { cwd: '/home/alex/work', mcp_allow: [] }
  const h = `sha256:${'a'.repeat(64)}`
  it('are optional; a value that is not a hash reads as missing, never a parse failure', () => {
    expect(WorkerLaunched.parse(base).spec_hash).toBeUndefined()
    const both = WorkerLaunched.parse({ ...base, spec_hash: h, update_tried_hash: h })
    expect(both).toMatchObject({ spec_hash: h, update_tried_hash: h })
    for (const bad of ['sha256:ABC', `sha256:${'a'.repeat(63)}`, `md5:${'a'.repeat(64)}`, 7, null]) {
      const r = WorkerLaunched.safeParse({ ...base, spec_hash: bad, update_tried_hash: bad })
      expect(r.success, String(bad)).toBe(true)
      expect(r.data?.spec_hash, String(bad)).toBeUndefined()
    }
  })

  it('instructions_hash: optional, kept when it is a hash, missing when it is not; the rest of the record still reads', () => {
    expect(WorkerLaunched.parse(base).instructions_hash).toBeUndefined()
    expect(WorkerLaunched.parse({ ...base, spec_hash: h, instructions_hash: h }).instructions_hash).toBe(h)
    for (const bad of ['sha256:ABC', `sha256:${'b'.repeat(65)}`, 'x', 0, null, {}]) {
      const r = WorkerLaunched.safeParse({ ...base, spec_hash: h, instructions_hash: bad })
      expect(r.success, String(bad)).toBe(true)
      expect(r.data?.instructions_hash, String(bad)).toBeUndefined()
      expect(r.data?.spec_hash).toBe(h)
    }
  })
})
