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
    expect(c.iso()).toBe('2026-10-28T00:00:01.100Z')
  })
})
