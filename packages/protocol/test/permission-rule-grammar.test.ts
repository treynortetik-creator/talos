// The grammar a thread folder's carried permission rules are held to (permissionRuleProblem), against shared vectors: a rule that
// fails it refuses the thread session's start (never dropped). Every rule real Claude Code 2.1.322 skipped (with a start-blocking
// dialog) fails it.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { permissionRuleProblem } from '../src/thread-folder-settings.ts'

const vectors = JSON.parse(readFileSync(join(__dirname, '..', 'fixtures', 'permission-rule-grammar.json'), 'utf8')) as {
  cases: Array<{ rule: string; carried: boolean; claude_code_2_1_322?: string }>
}

describe('permissionRuleProblem', () => {
  it('every vector: carried, or refuses the start', () => {
    expect(vectors.cases.length).toBeGreaterThanOrEqual(20)
    for (const c of vectors.cases)
      expect(permissionRuleProblem(c.rule) === null, JSON.stringify(c.rule)).toBe(c.carried)
  })
  it('everything Claude Code skipped or found no tool for is not carried', () => {
    for (const c of vectors.cases.filter((v) => v.claude_code_2_1_322 && v.claude_code_2_1_322 !== 'not_skipped'))
      expect(c.carried, c.rule).toBe(false)
  })
  it('the line and paragraph separators and DEL are control characters here too; over 1000 characters is not carried', () => {
    const cp = (n: number) => String.fromCodePoint(n)
    for (const r of [
      `Bash(a${cp(0x2028)}b)`,
      `Bash(a${cp(0x2029)}b)`,
      `Bash(a${cp(0x7f)}b)`,
      `Bash(a${cp(9)}b)`,
      `Bash(${'x'.repeat(1000)})`,
    ])
      expect(permissionRuleProblem(r), JSON.stringify(r)).not.toBeNull()
  })
})
