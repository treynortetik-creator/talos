import { describe, expect, it } from 'vitest'
import { isIanaZone, isQuiet, localMinutes, nextQuietEnd } from '../src/index.ts'

const D = (s: string) => new Date(s)

describe('isQuiet', () => {
  it('null window is never quiet', () => {
    expect(isQuiet(D('2026-10-28T03:00:00Z'), null, 'UTC')).toBe(false)
  })
  it('start == end means off', () => {
    expect(isQuiet(D('2026-10-28T03:00:00Z'), { start: '08:00', end: '08:00' }, 'UTC')).toBe(false)
  })
  it('same-day window in UTC (end exclusive)', () => {
    const qw = { start: '09:00', end: '17:00' }
    expect(isQuiet(D('2026-10-28T08:59:00Z'), qw, 'UTC')).toBe(false)
    expect(isQuiet(D('2026-10-28T09:00:00Z'), qw, 'UTC')).toBe(true)
    expect(isQuiet(D('2026-10-28T16:59:59Z'), qw, 'UTC')).toBe(true)
    expect(isQuiet(D('2026-10-28T17:00:00Z'), qw, 'UTC')).toBe(false)
  })
  it('window that wraps midnight', () => {
    const qw = { start: '22:00', end: '06:00' }
    expect(isQuiet(D('2026-10-28T21:59:00Z'), qw, 'UTC')).toBe(false)
    expect(isQuiet(D('2026-10-28T22:00:00Z'), qw, 'UTC')).toBe(true)
    expect(isQuiet(D('2026-10-28T23:59:00Z'), qw, 'UTC')).toBe(true)
    expect(isQuiet(D('2026-10-29T00:00:00Z'), qw, 'UTC')).toBe(true)
    expect(isQuiet(D('2026-10-29T05:59:00Z'), qw, 'UTC')).toBe(true)
    expect(isQuiet(D('2026-10-29T06:00:00Z'), qw, 'UTC')).toBe(false)
  })
  it('uses the zone, not UTC (America/New_York, EDT then EST)', () => {
    const qw = { start: '22:00', end: '06:00' }
    // 2026-10-28 is EDT (UTC-4): 02:30Z = 22:30 local
    expect(isQuiet(D('2026-10-28T02:30:00Z'), qw, 'America/New_York')).toBe(true)
    expect(isQuiet(D('2026-10-28T12:00:00Z'), qw, 'America/New_York')).toBe(false)
    // 2026-11-10 is EST (UTC-5): 02:30Z = 21:30 local
    expect(isQuiet(D('2026-11-10T02:30:00Z'), qw, 'America/New_York')).toBe(false)
    expect(isQuiet(D('2026-11-10T03:30:00Z'), qw, 'America/New_York')).toBe(true)
  })
  it('is DST-safe across the autumn fall-back (Europe/Berlin, 2026-10-25)', () => {
    const qw = { start: '22:00', end: '06:00' }
    // 04:59Z on 10-25 is 06:59 CET... check both sides of the 03:00 -> 02:00 repeat
    expect(localMinutes(D('2026-10-25T00:30:00Z'), 'Europe/Berlin')).toBe(2 * 60 + 30) // CEST
    expect(localMinutes(D('2026-10-25T01:30:00Z'), 'Europe/Berlin')).toBe(2 * 60 + 30) // CET, the repeated hour
    expect(isQuiet(D('2026-10-25T01:30:00Z'), qw, 'Europe/Berlin')).toBe(true)
    expect(isQuiet(D('2026-10-25T04:59:00Z'), qw, 'Europe/Berlin')).toBe(true) // 05:59 CET
    expect(isQuiet(D('2026-10-25T05:00:00Z'), qw, 'Europe/Berlin')).toBe(false) // 06:00 CET
  })
})

describe('nextQuietEnd', () => {
  it('returns `at` when not quiet', () => {
    const at = D('2026-10-28T12:00:00Z')
    expect(nextQuietEnd(at, { start: '22:00', end: '06:00' }, 'UTC')).toBe(at)
  })
  it('finds the end across midnight', () => {
    expect(nextQuietEnd(D('2026-10-28T23:10:30Z'), { start: '22:00', end: '06:00' }, 'UTC').toISOString()).toBe(
      '2026-10-29T06:00:00.000Z',
    )
    expect(nextQuietEnd(D('2026-10-29T01:00:00Z'), { start: '22:00', end: '06:00' }, 'UTC').toISOString()).toBe(
      '2026-10-29T06:00:00.000Z',
    )
  })
  it('works in a DST zone on the spring-forward night (America/New_York, 2027-03-14)', () => {
    // 22:00 EST 03-13 = 03:00Z 03-14; clocks jump 02:00 -> 03:00 EDT at 07:00Z; 06:00 EDT = 10:00Z
    const end = nextQuietEnd(D('2027-03-14T03:30:00Z'), { start: '22:00', end: '06:00' }, 'America/New_York')
    expect(end.toISOString()).toBe('2027-03-14T10:00:00.000Z')
  })
  it('resolves when the window end sits inside a DST gap (02:30 does not exist)', () => {
    const end = nextQuietEnd(D('2027-03-14T05:30:00Z'), { start: '22:00', end: '02:30' }, 'America/New_York')
    expect(isQuiet(end, { start: '22:00', end: '02:30' }, 'America/New_York')).toBe(false)
    expect(end.toISOString()).toBe('2027-03-14T07:00:00.000Z') // 03:00 EDT, the first minute after the gap
  })
})

describe('isIanaZone', () => {
  it('accepts real zones and rejects junk', () => {
    expect(isIanaZone('UTC')).toBe(true)
    expect(isIanaZone('Europe/Berlin')).toBe(true)
    expect(isIanaZone('America/New_York')).toBe(true)
    expect(isIanaZone('Mars/Olympus')).toBe(false)
    expect(isIanaZone('')).toBe(false)
  })
})
