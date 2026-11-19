import { describe, expect, it } from 'vitest'
import { fakeClock } from '../src/index.ts'

describe('fakeClock', () => {
  it('fires timers in order as time advances, including timers they schedule', () => {
    const c = fakeClock('2026-10-28T00:00:00.000Z')
    const log: string[] = []
    c.setTimeout(() => {
      log.push('b')
      c.setTimeout(() => log.push('d'), 50)
    }, 200)
    c.setTimeout(() => log.push('a'), 100)
    const cancelled = c.setTimeout(() => log.push('x'), 150)
    c.clearTimeout(cancelled)
    c.advance(99)
    expect(log).toEqual([])
    c.advance(1)
    expect(log).toEqual(['a'])
    c.advance(1000)
    expect(log).toEqual(['a', 'b', 'd'])
    expect(c.pending).toBe(0)
    expect(c.fired).toBe(3)
    expect(c.iso()).toBe('2026-10-28T00:00:01.100Z')
  })

  it('set moves time without firing timers', () => {
    const c = fakeClock('2026-10-28T00:00:00.000Z')
    let ran = 0
    c.setTimeout(() => ran++, 100)
    c.set(c.now() + 1000)
    expect(ran).toBe(0)
    expect(c.fired).toBe(0)
    expect(c.pending).toBe(1)
  })

  it('jump moves time and fires each due timer once, late, as a machine waking from sleep: no replay of the days between', () => {
    const c = fakeClock('2026-10-28T00:00:00.000Z')
    let pings = 0
    const ping = () => {
      pings++
      c.setTimeout(ping, 5_000) // a repeating 5 s timer, as the hub's
    }
    c.setTimeout(ping, 5_000)
    const seen: number[] = []
    c.setTimeout(() => seen.push(c.now()), 3_600_000) // an hourly sweep: runs once, at the new time
    c.setTimeout(() => seen.push(-1), 9 * 86_400_000) // not due yet: does not run
    const DAYS_8 = 8 * 86_400_000
    c.jump(DAYS_8)
    expect(c.iso()).toBe('2026-11-05T00:00:00.000Z')
    expect(pings).toBe(1) // advance() would have fired it 138,240 times
    expect(seen).toEqual([c.now()]) // late, at the jump's end, not at its own hour
    expect(c.fired).toBe(2)
    expect(c.pending).toBe(2) // the ping, re-armed from now, and the 9-day timer
    c.advance(5_000)
    expect(pings).toBe(2) // the clock goes on as before after a jump
  })
})
