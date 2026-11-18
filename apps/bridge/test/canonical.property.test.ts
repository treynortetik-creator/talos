// Property tests (fast-check) for the bridge's `canonicalJson` (src/mod/canonical.ts), pinned against protocol `jcs`.
// Relation pinned: for any value without lone surrogates, NaN/Infinity, undefined or -0, canonicalJson(v) === jcs(v).
// Differences that exist by design/accident and are pinned below: canonicalJson ESCAPES lone surrogates (\udXXX) where jcs
// THROWS; canonicalJson turns NaN/Infinity into null where jcs throws; undefined members are dropped in both.
import { describe, expect, test } from 'bun:test'
import { jcs } from '@talos-app/protocol'
import fc from 'fast-check'
import { canonicalJson } from '../src/mod/canonical.ts'

/** Lone surrogates replaced by U+FFFD (String.prototype.toWellFormed is not in this build's lib). */
const wf = (s: string) => s.replace(/[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/g, '\ufffd')

const SEED = 20261118
const wellFormed = fc.oneof(
  fc.string({ unit: 'binary', maxLength: 12 }).map((s) => wf(s)),
  fc.string({ unit: 'grapheme', maxLength: 8 }),
  fc.constantFrom(' ', ' ', '\u{1F600}', '\u0000', '\u{10FFFF}', '"\\/', ''),
)
const num = fc.oneof(
  fc.double({ noNaN: true, noDefaultInfinity: true }),
  fc.constantFrom(-0, 1e21, 1e-7, 5e-324, Number.MAX_VALUE, 2 ** 53),
)

type Tree = null | boolean | number | string | Tree[] | { entries: Array<[string, Tree]>; seed: number }
const trees = (str: fc.Arbitrary<string>): fc.Arbitrary<Tree> =>
  fc.letrec<{ t: Tree }>((tie) => ({
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
const put = (o: Record<string, unknown>, k: string, value: unknown) =>
  Object.defineProperty(o, k, { value, enumerable: true, writable: true, configurable: true })
function build(t: Tree, perm: number): unknown {
  if (t === null || typeof t !== 'object') return t
  if (Array.isArray(t)) return t.map((x) => build(x, perm))
  const o: Record<string, unknown> = {}
  for (const [k, v] of perm === 0 ? t.entries : shuffled(t.entries, t.seed + perm)) put(o, k, build(v, perm))
  return o
}
/** Same tree with -0 turned into 0. */
const noNegZero = (v: unknown): unknown => {
  if (typeof v === 'number') return v === 0 ? 0 : v
  if (Array.isArray(v)) return v.map(noNegZero)
  if (v !== null && typeof v === 'object') {
    const o: Record<string, unknown> = {}
    for (const k of Object.keys(v)) put(o, k, noNegZero((v as Record<string, unknown>)[k]))
    return o
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

describe('canonicalJson properties', () => {
  test('(d a/b) round trip and idempotent, fc.jsonValue and unicode trees', () => {
    for (const arb of [fc.jsonValue().map((v) => v as unknown), trees(wellFormed).map((t) => build(t, 0))]) {
      fc.assert(
        fc.property(arb, (v) => {
          const s = canonicalJson(v)
          expect(canonicalJson(JSON.parse(s))).toBe(s)
          expect(JSON.parse(s)).toEqual(noNegZero(JSON.parse(JSON.stringify(v))))
        }),
        { seed: SEED, numRuns: 300 },
      )
    }
  })

  test('(d c) key order at every level does not change the output', () => {
    fc.assert(
      fc.property(trees(wellFormed), fc.integer({ min: 1, max: 1000 }), (t, perm) => {
        expect(canonicalJson(build(t, perm))).toBe(canonicalJson(build(t, 0)))
      }),
      { seed: SEED + 1, numRuns: 400 },
    )
  })

  test('(e) equals jcs for well-formed JSON (no undefined, NaN, lone surrogate); -0 prints as 0 in both', () => {
    for (const arb of [fc.jsonValue().map((v) => v as unknown), trees(wellFormed).map((t) => build(t, 0))]) {
      fc.assert(
        fc.property(arb, (v) => {
          expect(canonicalJson(v)).toBe(jcs(v))
        }),
        { seed: SEED + 2, numRuns: 400 },
      )
    }
  })

  test('undefined members are dropped, undefined array items become null (like JSON.stringify)', () => {
    fc.assert(
      fc.property(trees(wellFormed), (t) => {
        const v = build(t, 0)
        expect(canonicalJson({ a: v, u: undefined })).toBe(canonicalJson({ a: v }))
        expect(canonicalJson([undefined, v])).toBe(canonicalJson([null, v]))
        expect(canonicalJson({ a: v, u: undefined })).toBe(jcs({ a: v }))
      }),
      { seed: SEED + 3, numRuns: 200 },
    )
  })

  test('lone surrogates: canonicalJson escapes them (valid JSON, round-trips) while jcs throws', () => {
    const lone = fc.integer({ min: 0xd800, max: 0xdfff }).map((c) => String.fromCharCode(c))
    fc.assert(
      fc.property(wellFormed, lone, wellFormed, (a, l, b) => {
        const s = `${a}x${l}x${b}`
        for (const v of [s, [s], { [s]: s }]) {
          expect(() => jcs(v)).toThrow()
          const out = canonicalJson(v)
          expect(out).toContain('\\ud')
          expect(canonicalJson(JSON.parse(out))).toBe(out)
        }
        expect(JSON.parse(canonicalJson(s))).toBe(s)
      }),
      { seed: SEED + 4, numRuns: 200 },
    )
  })

  test('(d c3) key order equals an independently written UTF-16 code unit order, and jcs agrees', () => {
    fc.assert(
      fc.property(keyedObject, ({ o, expected }) => {
        expect(canonicalJson(o)).toBe(expected)
        expect(jcs(o)).toBe(expected)
      }),
      { seed: SEED + 6, numRuns: 1000 },
    )
  })
})
