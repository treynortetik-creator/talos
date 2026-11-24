// Claude Code matches a file path in a permission rule with Read( ) for every file-reading tool and Edit( ) for every
// file-writing one, and nothing else: in 2.1.39 the file tools ask only for "Read" and "Edit" rules (its "read" and "edit"
// kinds), and 2.1.322 says so at every start: Write( ) and NotebookEdit( ) "never matches, use Edit( )", Glob( ) "use Read( )",
// Grep( ) never matches, MultiEdit "matches no known tool". The thread-session and lead settings carried those dead rows, ~820
// warning lines a start on Dante's Mac (2026-11-19). They now carry Read( ) and Edit( ) path rules only, on the same paths.
//
// test/fixtures/path-rules-before.json is what every generator gave before the change, on the inputs in path-rules-inputs.ts.
// Pantheon's condition: no fenced path may lose its cover. So the old output is checked first (every path behind a Grep/Glob
// row had a Read row, and every path behind a Write/NotebookEdit/MultiEdit row had an Edit row), then the new output must name
// exactly the old Read and Edit paths.
import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { HOOK_MATCHER } from '../src/guards/install.ts'
import { allPathRules } from './path-rules-inputs.ts'

const before = JSON.parse(readFileSync(join(import.meta.dir, 'fixtures', 'path-rules-before.json'), 'utf8')) as Record<
  string,
  string[]
>

const READS = new Set(['Read', 'Grep', 'Glob'])
const WRITES = new Set(['Edit', 'Write', 'NotebookEdit', 'MultiEdit'])
/** `Tool(/abs...)` (a file path rule) as [tool, path]; anything else (Bash, MCP, a bare tool name) is not one. */
const pathRule = (r: string): [string, string] | undefined => {
  const m = /^([A-Za-z]+)\((\/.*)\)$/.exec(r)
  return m && (READS.has(m[1] as string) || WRITES.has(m[1] as string)) ? [m[1] as string, m[2] as string] : undefined
}
const paths = (rules: string[], tools: Set<string>) =>
  new Set(rules.map(pathRule).flatMap((p) => (p && tools.has(p[0]) ? [p[1]] : [])))
const sorted = (s: Set<string>) => [...s].sort()

describe('the rules before the change (the fixture): no dead row stood alone', () => {
  test('there is something to check: each generator gave path rules', () => {
    for (const [name, rules] of Object.entries(before))
      if (name !== 'settingsFileRulesAsk')
        expect(
          rules.some((r) => pathRule(r)),
          name,
        ).toBe(true)
  })

  test('every path behind a Grep( ) or Glob( ) row had a Read( ) row: dropping them narrows nothing', () => {
    for (const [name, rules] of Object.entries(before)) {
      const read = paths(rules, new Set(['Read']))
      for (const p of paths(rules, new Set(['Grep', 'Glob']))) expect(read.has(p), `${name}: ${p}`).toBe(true)
    }
  })

  test('every path behind a Write( ), NotebookEdit( ) or MultiEdit( ) row had an Edit( ) row', () => {
    for (const [name, rules] of Object.entries(before)) {
      const edit = paths(rules, new Set(['Edit']))
      for (const p of paths(rules, new Set(['Write', 'NotebookEdit', 'MultiEdit'])))
        expect(edit.has(p), `${name}: ${p}`).toBe(true)
    }
  })
})

describe('the rules now: Read( ) and Edit( ) path rules only, on exactly the old paths', () => {
  const now = allPathRules()

  test('no Grep, Glob, Write, NotebookEdit or MultiEdit path rule is left', () => {
    for (const [name, rules] of Object.entries(now)) {
      const dead = rules.filter((r) => {
        const p = pathRule(r)
        return p && p[0] !== 'Read' && p[0] !== 'Edit'
      })
      expect(dead, name).toEqual([])
    }
  })

  test('the Read paths are the old read paths, and the Edit paths the old write paths, generator by generator', () => {
    expect(Object.keys(now).sort()).toEqual(Object.keys(before).sort())
    for (const name of Object.keys(before)) {
      const b = before[name] as string[]
      const n = now[name] as string[]
      expect(sorted(paths(n, new Set(['Read']))), `${name} read`).toEqual(sorted(paths(b, READS)))
      // The one pattern changed on purpose, after the fixture was taken (not rewritten history): the state file's deny was
      // `<file>/**`, which Claude Code 2.1.330 reads as a deny of the file itself too (its Edit was refused); it is `<file>/*`,
      // the children only. The fixture keeps the old text; only this generator's expected paths are mapped.
      const write = [...paths(b, WRITES)].map((p) => (name === 'stateFileDenyRules' ? p.replace(/\/\*\*$/, '/*') : p))
      expect(sorted(paths(n, new Set(['Edit']))), `${name} write`).toEqual(sorted(new Set(write)))
    }
  })

  test('every rule that is not a file path rule is as it was, in order', () => {
    for (const name of Object.keys(before)) {
      const keep = (rules: string[]) => rules.filter((r) => !pathRule(r))
      expect(keep(now[name] as string[]), name).toEqual(keep(before[name] as string[]))
    }
  })

  test('the guard hook still runs on every tool that writes a file: it is the real guard, and tool names are not rules', () => {
    expect(HOOK_MATCHER.split('|').sort()).toEqual(['Bash', 'Edit', 'MultiEdit', 'NotebookEdit', 'Write'])
  })
})
