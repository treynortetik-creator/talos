// Settings -> Health: "offline since 9:00 PM" and "up since 2:02 PM" are a bare clock time (`clockTime`), whatever the day. A Mac
// that went offline three days ago reads exactly like one that went offline this evening (the row is already red: > 12 h).
// The text compares two days at the same clock time, so it holds in any browser zone; run as written, or with TZ=Asia/Kolkata.
import { describe, expect, it } from 'vitest'
import { healthRows } from '../../src/features/health/rows.ts'
import { statusOf } from '../health/status.ts'

const detail = (id: 'bridge' | 'relay', over: Parameters<typeof statusOf>[0]) =>
  healthRows(statusOf(over), { scheduler: undefined }).find((r) => r.id === id)?.detail

describe('Health rows that name a past time', () => {
  it('a Mac offline for three days does not read the same as one offline for an hour', () => {
    // statusOf() is "now" = 2026-10-29T20:00Z
    const hourAgo = '2026-10-29T19:00:00.000Z'
    const threeDaysAgo = '2026-10-26T19:00:00.000Z'
    const recent = detail('bridge', { bridge: { online: false, last_seen: hourAgo, down_since: hourAgo } })
    const old = detail('bridge', { bridge: { online: false, last_seen: threeDaysAgo, down_since: threeDaysAgo } })
    expect(recent).toMatch(/^offline since /)
    // expected: the older one carries its day ("offline since Mon 12:00 PM", "offline 3 d")
    expect(old).not.toBe(recent)
  })

  it('a relay up for a month does not read the same as one restarted today', () => {
    const today = detail('relay', { relay: { version: '0.4.1', up_since: '2026-10-29T14:02:00.000Z' } })
    const lastMonth = detail('relay', { relay: { version: '0.4.1', up_since: '2026-09-29T14:02:00.000Z' } })
    expect(lastMonth).not.toBe(today)
  })
})
