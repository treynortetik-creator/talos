// `resetWords` (features/session/logic.ts) says when the weekly usage limit resets: a time for today, a weekday "within the
// week", else a date. "Within the week" is measured in milliseconds (< 7 days), so a reset 6 days 23 hours away, which falls on
// the SAME weekday as today, reads "resets Wed" on a Wednesday. The weekly window is seven days long, so this is the label for
// the rest of the day right after every reset.
// Run with TZ=Asia/Kolkata (or any zone where 08:00-09:00 on these dates is one calendar day works).
import { describe, expect, it } from 'vitest'
import { resetWords } from '../../src/features/session/logic.ts'

describe('the weekly reset label, six days and 23 hours ahead', () => {
  it('does not name only the weekday when that weekday is today', () => {
    const now = new Date(2026, 9, 28, 9, 0, 0) // Wed Oct 28 2026, 09:00 local
    const reset = new Date(2026, 10, 4, 8, 0, 0) // Wed Nov 4 2026, 08:00 local
    const todayName = now.toLocaleDateString([], { weekday: 'short' })
    expect(reset.toLocaleDateString([], { weekday: 'short' })).toBe(todayName) // same weekday, a week apart
    // expected: "resets Nov 4" (the form already used from 7 days out), never a bare "resets Wed" on a Wednesday
    expect(resetWords(reset.toISOString(), now.getTime())).not.toBe(`resets ${todayName}`)
  })

  it('control: six days ahead names the weekday, which is not today', () => {
    const now = new Date(2026, 9, 28, 9, 0, 0)
    const reset = new Date(2026, 10, 3, 9, 0, 0)
    expect(resetWords(reset.toISOString(), now.getTime())).toBe('resets Tue')
  })
})
