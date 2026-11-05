// Jump-to-latest bookkeeping: the new-message count and the labels.
import { describe, expect, it } from 'vitest'
import { isNearBottom, jumpLabel, newArrivals, seenOf } from '../../src/features/threads/jumpToLatest.ts'

// spec "o:c@7": owner row, key c, seq 7; no @ = no seq yet
const rows = (...specs: string[]) =>
  specs.map((sp) => {
    const m = /^(o:)?([^@]+)(?:@(\d+))?$/.exec(sp) as RegExpExecArray
    return { key: m[2] as string, author: m[1] ? 'owner' : 'agent', seq: m[3] ? Number(m[3]) : undefined }
  })
const known = (...specs: string[]) => seenOf(rows(...specs))

describe('newArrivals', () => {
  it('counts rows whose key and seq are new', () => {
    expect(newArrivals(known('a@1', 'b@2', 'c@3'), rows('a@1', 'b@2', 'c@3', 'd@4', 'e@5'))).toBe(2)
  })
  it("does not count the owner's own sends", () => {
    expect(newArrivals(known('a@1'), rows('a@1', 'o:d@2', 'e@3'))).toBe(1)
  })
  it('counts nothing when nothing arrived, or before anything was known', () => {
    expect(newArrivals(known('a@1', 'b@2'), rows('a@1', 'b@2'))).toBe(0)
    expect(newArrivals(null, rows('a@1', 'b@2'))).toBe(0)
  })
  it('counts nothing when older history was prepended', () => {
    expect(newArrivals(known('c@30', 'd@31'), rows('x@10', 'y@11', 'c@30', 'd@31'))).toBe(0)
  })
  it('counts a new row even when a local row (card, queued, no seq) sits after it', () => {
    expect(newArrivals(known('a@1', 'card1'), rows('a@1', 'b@2', 'card1'))).toBe(1)
  })
  it('a new row with no seq yet (an older peer, a card row) counts as incoming', () => {
    expect(newArrivals(known('a@1'), rows('a@1', 'card2'))).toBe(1)
  })
  it('a row the peer re-keyed counts once, not everything', () => {
    expect(newArrivals(known('a@1', 'b@2', 'c@3'), rows('a@1', 'b@2', 'c2@3'))).toBe(0)
  })
})

describe('jumpLabel', () => {
  it('says how many are new', () => {
    expect(jumpLabel(0)).toBe('Jump to latest message')
    expect(jumpLabel(1)).toBe('Jump to latest, 1 new message')
    expect(jumpLabel(7)).toBe('Jump to latest, 7 new messages')
  })
})

describe('isNearBottom', () => {
  const at = (left: number) => ({ scrollHeight: 1000, scrollTop: 600 - left, clientHeight: 400 })
  it('uses the scroll anchor threshold: fewer than 80 px left is the bottom', () => {
    expect(isNearBottom(at(0))).toBe(true)
    expect(isNearBottom(at(79))).toBe(true)
    expect(isNearBottom(at(80))).toBe(false)
    expect(isNearBottom(at(600))).toBe(false)
  })
})

describe('newArrivals on a thread of cards only (no seq known)', () => {
  const card = (key: string, at: number) => ({ key, author: undefined, seq: undefined, at })
  const msg = (key: string, seq: number, at: number) => ({ key, author: 'agent', seq, at })
  const before = [card('c1', 5000), card('c2', 6000)]
  it('older history is not news, whatever its seq', () => {
    expect(newArrivals(seenOf(before), [msg('o1', 10, 1000), msg('o2', 11, 2000), ...before])).toBe(0)
  })
  it('a message newer than everything known is news', () => {
    expect(newArrivals(seenOf(before), [msg('n1', 12, 9000), ...before])).toBe(1)
  })
  it('a seq with no usable time is not counted (cannot be told from history)', () => {
    expect(newArrivals(seenOf(before), [{ key: 'x', author: 'agent', seq: 3 }, ...before])).toBe(0)
  })
})

describe('newArrivals: seq-less history', () => {
  const at = (key: string, t: number, seq?: number) => ({ key, author: 'agent', seq, at: t })
  it('a seq-less row older than what is shown is history, not news', () => {
    const before = [at('a', 5000, 5), at('b', 6000, 6)]
    expect(newArrivals(seenOf(before), [at('old_card', 1000), ...before])).toBe(0)
  })
  it('a seq-less row newer than what is shown still counts', () => {
    const before = [at('a', 5000, 5)]
    expect(newArrivals(seenOf(before), [...before, at('new_card', 9000)])).toBe(1)
  })
})
