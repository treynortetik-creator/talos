// The golden files may only be rewritten by a person on purpose. These tests drive the real mode switch the replay
// tests use, with the environment passed in, and the real merge that keeps sequences a filtered run did not play.
import { describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { goldenMode, goldenPath, readGolden, saveGolden } from './replay-harness.ts'

describe('goldenMode', () => {
  test('without UPDATE_GOLDEN the run compares', () => {
    expect(goldenMode({})).toBe('check')
    expect(goldenMode({ UPDATE_GOLDEN: '0', CI: '1' })).toBe('check')
  })
  test('UPDATE_GOLDEN=1 on a person machine records', () => {
    expect(goldenMode({ UPDATE_GOLDEN: '1' })).toBe('update')
    expect(goldenMode({ UPDATE_GOLDEN: '1', CI: '' })).toBe('update')
  })
  test('UPDATE_GOLDEN=1 with CI set is refused', () => {
    for (const ci of ['1', 'true', 'yes']) expect(() => goldenMode({ UPDATE_GOLDEN: '1', CI: ci })).toThrow(/CI/)
  })
})

describe('saveGolden', () => {
  test('keeps stored sequences that did not run, and replaces the ones that did', () => {
    const dir = mkdtempSync(join(tmpdir(), 'talos-golden-'))
    try {
      saveGolden('x', { a: 1, b: 2, c: 3 }, dir)
      saveGolden('x', { b: 'new' }, dir) // a filtered run that only played b
      expect(JSON.parse(readFileSync(goldenPath('x', dir), 'utf8'))).toEqual({ a: 1, b: 'new', c: 3 })
      expect(Object.keys(JSON.parse(readGolden('x', dir) as string))).toEqual(['a', 'b', 'c'])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
