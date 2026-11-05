// Review fix #13: a sender-controlled timestamp must never produce an ISO string the protocol rejects.
import { IsoTs } from '@talos-app/protocol'
import { describe, expect, it } from 'vitest'
import { toIso } from '../src/generic/common.ts'

const FALLBACK = Date.parse('2026-10-28T12:00:00.000Z')

describe('toIso', () => {
  it.each([
    ['year 33658 in ms', 1e15],
    ['the largest JS date', 8.64e15],
    ['a far-future string', '+275760-09-13T00:00:00.000Z'],
    ['year 10000', 253402300800000],
    ['negative', -5],
  ])('%s falls back to a valid timestamp', (_name, v) => {
    const out = toIso(v, FALLBACK)
    expect(IsoTs.safeParse(out).success, out).toBe(true)
    expect(out).toBe('2026-10-28T12:00:00.000Z')
  })

  it('keeps ordinary values', () => {
    expect(toIso(1_700_000_000, FALLBACK)).toBe('2023-11-14T22:13:20.000Z')
    expect(toIso('2026-01-02T03:04:05Z', FALLBACK)).toBe('2026-01-02T03:04:05.000Z')
  })
})
