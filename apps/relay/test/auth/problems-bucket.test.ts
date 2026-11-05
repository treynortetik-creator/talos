import { PROBLEM_LIMITS } from '@talos-app/protocol'
import { describe, expect, it } from 'vitest'
import { LIMITS, RateLimiter } from '../../src/auth/limits.ts'

describe('the problems bucket', () => {
  it('matches the protocol number, is one budget for every caller, and refills over the hour', () => {
    expect(LIMITS.problems).toEqual([{ capacity: PROBLEM_LIMITS.perHour, windowMs: 3600_000 }])
    let now = 1_000_000
    const lim = new RateLimiter({ now: () => now } as never)
    for (let i = 0; i < PROBLEM_LIMITS.perHour; i++) expect(lim.take('problems', `ip-${i}`).ok).toBe(true) // other keys share it
    const over = lim.take('problems', 'ip-new')
    expect(over.ok).toBe(false)
    expect(over.ok === false && over.retryAfterS).toBeGreaterThan(0)
    now += 3600_000 / PROBLEM_LIMITS.perHour
    expect(lim.take('problems', 'ip-new').ok).toBe(true)
    expect(lim.take('problems', 'ip-new').ok).toBe(false)
  })
})
