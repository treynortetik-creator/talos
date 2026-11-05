import { describe, expect, it } from 'vitest'
import { followsInsert } from '../../src/features/composer/followInsert.ts'

const ta = (value: string, start = value.length, end = start) => ({ value, selectionStart: start, selectionEnd: end })

describe('followsInsert', () => {
  it('follows text added with the caret at the end', () => {
    expect(followsInsert(ta('abc def'), 'abc', 'abc def')).toBe(true)
  })
  it('does not follow an edit with the caret in the middle', () => {
    expect(followsInsert(ta('abc def', 2), 'abc', 'abc def')).toBe(false)
  })
  it('does not follow a selection that runs to the end', () => {
    expect(followsInsert(ta('abc def', 0, 7), 'abc', 'abc def')).toBe(false)
  })
  it('follows a shorter replacement when the caret ends at the end (paste over a selection)', () => {
    expect(followsInsert(ta('word'), 'a long long text', 'word')).toBe(true)
  })
  it('does not follow a deletion with the caret elsewhere, or no change', () => {
    expect(followsInsert(ta('ab', 1), 'abc', 'ab')).toBe(false)
    expect(followsInsert(ta('abc'), 'abc', 'abc')).toBe(false)
  })
  it('does not follow when the element and the state disagree', () => {
    expect(followsInsert(ta('other'), 'a', 'abc')).toBe(false)
  })
})
