// After the pointer's Enter (enter-check.ts): the shared vectors (apps/desktop/Tests/Fixtures/enter-detection-vectors.json), which
// the Mac reads too.
import { describe, expect, it } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { checkEnter, enterNeedsSlowLook } from '../../src/supervisor/enter-check.ts'

const DOC = JSON.parse(
  readFileSync(join(import.meta.dir, '../../../desktop/Tests/Fixtures/enter-detection-vectors.json'), 'utf8'),
) as {
  vectors: Array<{
    name: string
    pre: string[] | null
    after: string[] | null
    later: string[] | null
    latest?: string[] | null
    flagged: boolean
    why: string | null
    classes: Record<string, string>
  }>
}

describe('after the pointer’s Enter: the shared vectors', () => {
  it.each(DOC.vectors.map((v) => [v.name, v] as const))('%s', (_n, v) => {
    const c = checkEnter(v.pre, v.after, v.later, 'latest' in v ? v.latest : undefined)
    // the third look is taken exactly when the second still shows our line
    expect(enterNeedsSlowLook(v.later)).toBe('latest' in v)
    expect(c.classes).toEqual(v.classes as never)
    expect(c.flagged).toBe(v.flagged)
    expect(c.why).toBe(v.why as never)
  })
})
