// A clock that steps backwards (NTP correction, a restored VM) must not stall token buckets: found by the e2e suite, where
// the relay clock is moved back 20 minutes and every app frame then sat in the queue until the clock caught up.
import { describe, expect, it } from 'vitest'
import { FrameBudget, RateLimiter } from '../../src/auth/limits.ts'

function clock(start = 1_000_000_000_000) {
  const c = { t: start, now: () => c.t, setTimeout: () => 0, clearTimeout: () => {} }
  return c
}

describe('token buckets and a backwards clock', () => {
  it('the per-socket frame budget keeps working after the clock steps back', () => {
    const c = clock()
    const b = new FrameBudget(c)
    for (let i = 0; i < 60; i++) expect(b.allow()).toBe(true)
    expect(b.allow()).toBe(false)
    c.t -= 20 * 60_000
    expect(b.allow()).toBe(false) // nothing was refilled by going backwards...
    c.t += 1000
    expect(b.allow()).toBe(true) // ...and one second later it refills normally
  })

  it('a rate-limit bucket refills at its normal pace after a backwards step', () => {
    const c = clock()
    const r = new RateLimiter(c)
    for (let i = 0; i < 10; i++) expect(r.take('auth', 'ip').ok).toBe(true)
    expect(r.take('auth', 'ip').ok).toBe(false) // empty: 10 per minute
    c.t -= 20 * 60_000
    expect(r.take('auth', 'ip').ok).toBe(false)
    c.t += 7000 // seven seconds later, one token (10 per 60 s) is back
    expect(r.take('auth', 'ip').ok).toBe(true)
  })
})
