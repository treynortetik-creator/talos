// Property tests (fast-check) for cutting text to a length: sanitizeExternal (the cut every card title, summary and quoted
// message goes through) and clipUnits. A cut at N UTF-16 units must never exceed N and never leave half of a surrogate pair,
// whatever well-formed text comes in, with an emoji at the cut point.
import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { clipUnits, sanitizeExternal } from '../src/index.ts'

const SEED = 20261121
const unit = fc.oneof(
  { weight: 5, arbitrary: fc.constantFrom('a', 'b', ' ', 'é', '字') },
  { weight: 3, arbitrary: fc.constantFrom('\u{1F600}', '\u{1F468}‍\u{1F469}', '\u{10FFFF}', '\u{1F1EB}\u{1F1F7}') },
)
const text = fc.array(unit, { maxLength: 80 }).map((u) => u.join(''))
const wellFormed = (s: string) => !/[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/.test(s)

describe('cutting text to a length', () => {
  it('clipUnits never exceeds its limit, never leaves half a pair, and is a prefix of the text', () => {
    fc.assert(
      fc.property(text, fc.integer({ min: 0, max: 90 }), (t, max) => {
        const out = clipUnits(t, max)
        expect(out.length).toBeLessThanOrEqual(max)
        expect(wellFormed(out)).toBe(true)
        expect(t.startsWith(out)).toBe(true)
        // it takes everything that fits: at most one unit (the other half of a pair) is given up
        expect(out.length).toBeGreaterThanOrEqual(Math.min(t.length, max - 1))
      }),
      { seed: SEED + 1, numRuns: 2000 },
    )
  })

  it('sanitizeExternal never exceeds its limit and never leaves half a pair', () => {
    fc.assert(
      fc.property(text, fc.integer({ min: 1, max: 90 }), (t, max) => {
        const out = sanitizeExternal(t, max)
        expect(out.length).toBeLessThanOrEqual(max)
        expect(wellFormed(out)).toBe(true)
      }),
      { seed: SEED, numRuns: 2000 },
    )
  })
})
