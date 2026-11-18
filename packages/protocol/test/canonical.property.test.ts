// Property tests (fast-check) for RFC 8785 canonicalisation: `jcs` in src/canonical.ts. Fixed seeds so a failure reproduces.
// Lone surrogates: `jcs` THROWS on them (the `canonicalize` library rejects ill-formed strings, RFC 8785 requires well-formed
// I-JSON); the bridge's `canonicalJson` (apps/bridge/test/canonical.property.test.ts) escapes them instead.
import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { jcs } from '../src/index.ts'

/** Lone surrogates replaced by U+FFFD (String.prototype.toWellFormed is not in this build's lib). */
const wf = (s: string) => s.replace(/[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/g, '\ufffd')

const SEED = 20261117

/** Any UTF-16 code unit string: astral pairs, U+2028/2029, controls and lone surrogates all occur. */
const anyUnits = fc.string({ unit: 'binary', maxLength: 12 })
/** Well-formed Unicode only (what I-JSON allows). */
const wellFormed = fc.oneof(
  fc.string({ unit: 'binary', maxLength: 12 }).map((s) => wf(s)),
  fc.string({ unit: 'grapheme', maxLength: 8 }),
  fc.constantFrom(' ', ' ', '\u{1F600}', '\u0000', '\u007f', '퟿', '\u{10FFFF}', '"\\/', ''),
)

const num = fc.oneof(
  fc.double({ noNaN: true, noDefaultInfinity: true }),
  fc.constantFrom(
    -0,
    0,
    1e21,
    1e-7,
    5e-324,
    -5e-324,
    Number.MAX_VALUE,
    -Number.MAX_VALUE,
    123456789012345680000,
    2 ** 53,
  ),
  fc.integer(),
)

type Tree = null | boolean | number | string | Tree[] | { entries: Array<[string, Tree]>; seed: number }

function trees(str: fc.Arbitrary<string>): fc.Arbitrary<Tree> {
  return fc.letrec<{ t: Tree }>((tie) => ({
    t: fc.oneof(
      { depthSize: 'small', maxDepth: 4 },
      fc.constant(null),
      fc.boolean(),
      num,
      str,
      fc.array(tie('t'), { maxLength: 4 }),
      fc.record({
        entries: fc.uniqueArray(fc.tuple(str, tie('t')), { maxLength: 5, selector: ([k]) => k }),
        seed: fc.nat(1_000_000),
      }),
    ),
  })).t
}

/** Deterministic Fisher-Yates driven by `seed`, so the permutation is part of the generated case. */
function shuffled<T>(xs: T[], seed: number): T[] {
  const a = xs.slice()
  let s = seed >>> 0 || 1
  for (let i = a.length - 1; i > 0; i--) {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0
    const j = s % (i + 1)
    ;[a[i], a[j]] = [a[j] as T, a[i] as T]
  }
  return a
}

function put(o: Record<string, unknown>, k: string, value: unknown): void {
  // defineProperty so a generated "__proto__" key is an own member, not a prototype assignment
  Object.defineProperty(o, k, { value, enumerable: true, writable: true, configurable: true })
}

/** Build a plain value; objects get their keys inserted in a permutation chosen by `perm` (0 = as generated). */
function build(t: Tree, perm: number): unknown {
  if (t === null || typeof t !== 'object') return t
  if (Array.isArray(t)) return t.map((x) => build(x, perm))
  const o: Record<string, unknown> = {}
  const entries = perm === 0 ? t.entries : shuffled(t.entries, t.seed + perm)
  for (const [k, v] of entries) put(o, k, build(v, perm))
  return o
}

/** -0 becomes 0 (RFC 8785 prints both as 0) so deep-equal compares what canonical JSON can express. */
function norm(v: unknown): unknown {
  if (typeof v === 'number') return v === 0 ? 0 : v
  if (Array.isArray(v)) return v.map(norm)
  if (v !== null && typeof v === 'object') {
    const out: Record<string, unknown> = {}
    for (const k of Object.keys(v)) put(out, k, norm((v as Record<string, unknown>)[k]))
    return out
  }
  return v
}

/** UTF-16 code unit order, written out by hand (not `.sort()`): the first differing unit decides, a prefix sorts first. */
function lessUnits(a: string, b: string): boolean {
  for (let i = 0; i < a.length && i < b.length; i++) {
    const d = a.charCodeAt(i) - b.charCodeAt(i)
    if (d !== 0) return d < 0
  }
  return a.length < b.length
}

/** Keys that tempt an implementation: integer-like ("10" before "9", "01", "1"), astral (code unit D83D, not code point 1F600), BMP above it. */
const awkwardKey = fc.oneof(
  fc.constantFrom(
    '10',
    '9',
    '1',
    '01',
    '2',
    '100',
    '0',
    '-1',
    '1.5',
    'a',
    'B',
    '\u{1F600}',
    '\uffff',
    '\ue000',
    '\ud7ff',
    '',
  ),
  fc.integer({ min: 0, max: 120 }).map(String),
  fc.string({ unit: fc.constantFrom('0', '1', '9', 'a', '\u{1F600}', '\uffff', '\u00e9'), maxLength: 3 }),
)
/** The object a distinct set of such keys gives, and the text RFC 8785 requires for it, written independently of any sort. */
const keyedObject = fc.uniqueArray(awkwardKey, { maxLength: 8 }).map((keys) => {
  const ordered: string[] = []
  for (const k of keys) {
    let i = ordered.length
    while (i > 0 && lessUnits(k, ordered[i - 1] as string)) i--
    ordered.splice(i, 0, k)
  }
  const o: Record<string, number> = {}
  for (const k of keys)
    Object.defineProperty(o, k, { value: k.length, enumerable: true, writable: true, configurable: true })
  return { o, expected: `{${ordered.map((k) => `${JSON.stringify(k)}:${k.length}`).join(',')}}` }
})

describe('jcs properties (RFC 8785)', () => {
  const jsonLike = fc.jsonValue().map((v) => v as unknown)
  const unicodeTree = trees(wellFormed).map((t) => build(t, 0))

  for (const [name, arb] of [
    ['fc.jsonValue', jsonLike],
    ['unicode trees with -0/1e21/tiny/huge doubles', unicodeTree],
  ] as const) {
    it(`(a) round trip, ${name}`, () => {
      fc.assert(
        fc.property(arb, (v) => {
          const s = jcs(v)
          expect(JSON.parse(s)).toEqual(norm(JSON.parse(JSON.stringify(v))))
          expect(jcs(JSON.parse(s))).toBe(s)
        }),
        { seed: SEED, numRuns: 300 },
      )
    })

    it(`(b) idempotent, ${name}`, () => {
      fc.assert(
        fc.property(arb, (v) => {
          const once = jcs(v)
          expect(jcs(JSON.parse(once))).toBe(once)
        }),
        { seed: SEED + 1, numRuns: 300 },
      )
    })
  }

  it('(c) key order at every level does not change the output', () => {
    fc.assert(
      fc.property(trees(wellFormed), fc.integer({ min: 1, max: 1000 }), (t, perm) => {
        expect(jcs(build(t, perm))).toBe(jcs(build(t, 0)))
      }),
      { seed: SEED + 2, numRuns: 400 },
    )
  })

  it('(c2) output keys are in UTF-16 code unit order at every level', () => {
    const check = (v: unknown): void => {
      if (Array.isArray(v)) v.forEach(check)
      else if (v !== null && typeof v === 'object') {
        const keys = Object.keys(v)
        expect(keys.filter((k) => !/^\d+$/.test(k))).toEqual(keys.filter((k) => !/^\d+$/.test(k)).sort())
        for (const k of keys) check((v as Record<string, unknown>)[k])
      }
    }
    fc.assert(
      fc.property(trees(wellFormed), (t) => {
        check(JSON.parse(jcs(build(t, 3))))
      }),
      { seed: SEED + 3, numRuns: 200 },
    )
  })

  it('lone surrogates: jcs refuses them, in a string, a key and an array', () => {
    const lone = fc.integer({ min: 0xd800, max: 0xdfff }).map((c) => String.fromCharCode(c))
    fc.assert(
      fc.property(anyUnits, lone, anyUnits, (a, l, b) => {
        // the "x" guards keep the lone unit from pairing with a neighbouring unit
        const s = `${wf(a)}x${l}x${wf(b)}`
        expect(() => jcs(s)).toThrow()
        expect(() => jcs({ [s]: 1 })).toThrow()
        expect(() => jcs([s])).toThrow()
      }),
      { seed: SEED + 4, numRuns: 200 },
    )
  })

  it('well-formed strings never throw, including astral, U+2028 and controls', () => {
    fc.assert(
      fc.property(wellFormed, (s) => {
        expect(JSON.parse(jcs(s))).toBe(s)
      }),
      { seed: SEED + 5, numRuns: 300 },
    )
  })

  it('(c3) key order equals an independently written UTF-16 code unit order (integer-like and astral keys)', () => {
    fc.assert(
      fc.property(keyedObject, ({ o, expected }) => {
        expect(jcs(o)).toBe(expected)
      }),
      { seed: SEED + 6, numRuns: 1000 },
    )
  })
})
