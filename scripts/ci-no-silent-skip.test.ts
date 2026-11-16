// scripts/ci-no-silent-skip.ts: a file counts as run when any of its tests was not skipped.
import { describe, expect, it } from 'vitest'
import { counts } from './ci-no-silent-skip'

const mod = (states: string[]) =>
  ({ children: { allTests: () => states.map((s) => ({ result: () => ({ state: s }) }))[Symbol.iterator]() } }) as never

describe('no-silent-skip counts', () => {
  it('every test skipped: none ran', () => {
    expect(counts(mod(['skipped', 'skipped']))).toEqual({ all: 2, ran: 0 })
  })
  it('a passed or failed test counts as ran', () => {
    expect(counts(mod(['skipped', 'passed', 'failed']))).toEqual({ all: 3, ran: 2 })
  })
  it('a file with no tests at all: none ran', () => {
    expect(counts(mod([]))).toEqual({ all: 0, ran: 0 })
  })
})
