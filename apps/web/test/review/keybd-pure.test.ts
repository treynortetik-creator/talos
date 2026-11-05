// Phone composer regression tests: pure logic. Each test pins a bug that was found and fixed.
// The three BUG-1 cases (a panned visual viewport read as no keyboard) are gone with the pin they tested.
import { describe, expect, it } from 'vitest'
import { newArrivals, seenOf } from '../../src/features/threads/jumpToLatest.ts'

describe('newArrivals on a thread with no seq yet', () => {
  const card = (key: string) => ({ key, author: undefined, seq: undefined })
  it('BUG-9: history loaded into a thread of seq-less rows is not news', () => {
    const before = [card('card_a'), card('card_b')]
    const after = [{ key: 'old_1', author: 'agent', seq: 10 }, { key: 'old_2', author: 'agent', seq: 11 }, ...before]
    expect(newArrivals(seenOf(before), after)).toBe(0)
  })
})
