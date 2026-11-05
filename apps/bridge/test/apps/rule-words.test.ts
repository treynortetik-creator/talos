import { describe, expect, it } from 'bun:test'
import { ruleWords } from '../../src/apps/approval.ts'

describe('ruleWords', () => {
  it('a local write says it asks each time, with a card, and never that a tap alone is enough', () => {
    const w = ruleWords({ read_only: false, destructive: false, open_world: false })
    expect(w).toContain('asks you each time')
    expect(w).toContain('card')
    expect(w).not.toContain('tap alone')
  })
  it('a read-only tool runs without a tap, and a destructive one asks each time', () => {
    expect(ruleWords({ read_only: true, destructive: false })).toBe('runs without a tap (server says read-only)')
    expect(ruleWords({ read_only: false, destructive: true })).toContain('asks you each time')
  })
})
