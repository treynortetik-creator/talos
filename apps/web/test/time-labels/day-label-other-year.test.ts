// `dayLabel` (lib/format.ts) heads the days of a thread timeline and dates every search hit ("Tue, Oct 28 4:00 PM"). It never
// prints the year, so a hit from 2025 and one from 2026 on the same calendar day carry the same label; search reaches back
// through all history (features/search/SearchScreen.tsx:334, features/threads/ThreadSearch.tsx:179).
// Uses the browser's zone like the code does; the two instants are noon UTC, so any zone gives the same result.
import { describe, expect, it } from 'vitest'
import { dayLabel } from '../../src/lib/format.ts'

const NOW_MS = Date.parse('2026-10-28T16:00:00Z')

describe('the day label of an old message', () => {
  it('says the year when it is not this year', () => {
    // expected: "Tue, Oct 28, 2025" (or any form with the year)
    expect(dayLabel('2025-10-28T12:00:00Z', NOW_MS)).toContain('2025')
  })

  it('two messages a year apart do not get the same label', () => {
    // Oct 28 was a Wednesday in both 2015 and 2020
    expect(dayLabel('2020-10-28T12:00:00Z', NOW_MS)).not.toBe(dayLabel('2015-10-28T12:00:00Z', NOW_MS))
  })
})
