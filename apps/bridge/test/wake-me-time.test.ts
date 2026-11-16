// `wake_me` time and note handling (docs/OPTION-C.md "Wake me"): the asked time across midnight and both DST changes, rounding
// up to the minute (never early), and a hostile note made one visible line.
import { describe, expect, test } from 'bun:test'
import { cleanNote } from '../src/wake-me/service.ts'
import { askedInstant, instantsOf, wallOf } from '../src/wake-me/time.ts'

const NY = 'America/New_York'
const TOKYO = 'Asia/Tokyo'
const at = (iso: string) => Date.parse(iso)

describe('the asked instant', () => {
  test('in_minutes counts from now and rounds up to the next minute, across midnight', () => {
    const now = at('2026-10-05T03:59:30Z') // 23:59:30 EDT on the 4th
    const r = askedInstant({ inMinutes: 1 }, now, NY)
    expect(r).toEqual({ ok: true, ms: at('2026-10-05T04:01:00Z') })
    if (r.ok) expect(wallOf(r.ms, NY)).toBe('2026-10-05T00:01')
  })

  test('a local time is read in the scheduler zone; an offset or Z is an instant', () => {
    expect(askedInstant({ at: '2026-10-05T08:00' }, 0, NY)).toEqual({ ok: true, ms: at('2026-10-05T12:00:00Z') })
    expect(askedInstant({ at: '2026-10-05T08:00' }, 0, TOKYO)).toEqual({ ok: true, ms: at('2026-10-04T23:00:00Z') })
    expect(askedInstant({ at: '2026-10-05T08:00-07:00' }, 0, NY)).toEqual({ ok: true, ms: at('2026-10-05T15:00:00Z') })
    expect(askedInstant({ at: '2026-10-05T15:00:20Z' }, 0, NY)).toEqual({ ok: true, ms: at('2026-10-05T15:01:00Z') })
    expect(askedInstant({ at: '2026-10-05T08:00:01' }, 0, NY)).toEqual({ ok: true, ms: at('2026-10-05T12:01:00Z') })
  })

  test('spring forward: a time the clocks skip is refused in words', () => {
    expect(instantsOf('2026-03-08T02:30', NY)).toEqual([])
    const r = askedInstant({ at: '2026-03-08T02:30' }, 0, NY)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toContain('does not happen in America/New_York')
  })

  test('fall back: a time that happens twice is the first one, and the agent is told', () => {
    expect(instantsOf('2026-11-01T01:30', NY)).toEqual([at('2026-11-01T05:30:00Z'), at('2026-11-01T06:30:00Z')])
    const r = askedInstant({ at: '2026-11-01T01:30' }, 0, NY)
    expect(r).toMatchObject({ ok: true, ms: at('2026-11-01T05:30:00Z') })
    if (r.ok) expect(r.note).toContain('happens twice')
  })

  test('in_minutes across the fall-back hour lands on the real elapsed time, not the wall clock', () => {
    const now = at('2026-11-01T05:00:00Z') // 01:00 EDT
    const r = askedInstant({ inMinutes: 90 }, now, NY)
    expect(r).toEqual({ ok: true, ms: at('2026-11-01T06:30:00Z') }) // 01:30 EST, the second 01:30
  })

  test('bad shapes are refused', () => {
    for (const a of [
      {},
      { at: 'tomorrow' },
      { at: 5 },
      { inMinutes: 0 },
      { inMinutes: '5' },
      { at: 'x', inMinutes: 5 },
    ])
      expect(askedInstant(a, 0, NY).ok).toBe(false)
  })
})

describe('the note', () => {
  test('one visible line: newlines and tabs become spaces, hidden and bidi characters are shown as escapes', () => {
    const r = cleanNote(`Check\nthe\tbuild${String.fromCodePoint(0x202e)}evil${String.fromCodePoint(0x200b)}`)
    expect(r).toEqual({ ok: true, note: 'Check the build⟦U+202E⟧evil⟦U+200B⟧' })
  })

  test('280 characters fit; more, or more once escaped, are refused; empty is refused', () => {
    expect(cleanNote('a'.repeat(280)).ok).toBe(true)
    expect(cleanNote('a'.repeat(281)).ok).toBe(false)
    expect(cleanNote(String.fromCodePoint(0x200b).repeat(40)).ok).toBe(false) // 40 hidden characters show as 360
    expect(cleanNote('  \n\t ').ok).toBe(false)
    expect(cleanNote(undefined).ok).toBe(false)
  })
})
