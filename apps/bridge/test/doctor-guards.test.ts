// talos-app doctor's guard-timeout row: ok with none (or no file), a warning with the count and hooks for timeouts in the last 7 days.
import { afterEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { guardTimeoutsCheck } from '../src/doctor-guards.ts'
import { gazetteerPath } from '../src/memory/reflex.ts'

const made: string[] = []
afterEach(() => {
  for (const d of made.splice(0)) rmSync(d, { recursive: true, force: true })
})
const dir = (p: string) => {
  const d = mkdtempSync(join(tmpdir(), p))
  made.push(d)
  return d
}
const agentDir = () => {
  const d = dir('talos-doc-gt-agent-')
  mkdirSync(join(d, 'hooks'))
  writeFileSync(join(d, 'hooks', '_talos_common.py'), '')
  return d
}
const NOW = Date.parse('2026-11-16T12:00:00Z')
const row = (hook: string, daysAgo: number) =>
  JSON.stringify({ at: new Date(NOW - daysAgo * 86400_000).toISOString(), hook, seconds: 20, unattended: false })

describe('doctor: guard timeouts', () => {
  test('no file: ok', () => {
    const env = { XDG_STATE_HOME: dir('talos-doc-gt-state-') }
    expect(guardTimeoutsCheck(agentDir(), NOW, env)?.level).toBe('ok')
  })

  test('not a Talos agent folder: no row', () => {
    expect(
      guardTimeoutsCheck(dir('talos-doc-gt-plain-'), NOW, { XDG_STATE_HOME: dir('talos-doc-gt-state-') }),
    ).toBeUndefined()
  })

  test('a file with no timeouts: ok', () => {
    const env = { XDG_STATE_HOME: dir('talos-doc-gt-state-') }
    const agent = agentDir()
    mkdirSync(dirname(gazetteerPath(agent, env)), { recursive: true })
    writeFileSync(join(dirname(gazetteerPath(agent, env)), 'guard-timeouts.jsonl'), '')
    expect(guardTimeoutsCheck(agent, NOW, env)?.level).toBe('ok')
  })

  test('two recent and one old: a warning with N=2 and the hooks', () => {
    const env = { XDG_STATE_HOME: dir('talos-doc-gt-state-') }
    const agent = agentDir()
    const state = dirname(gazetteerPath(agent, env))
    mkdirSync(state, { recursive: true })
    writeFileSync(
      join(state, 'guard-timeouts.jsonl'),
      `${[row('action-rules', 1), row('check-vault', 6), row('action-rules', 30), 'not json'].join('\n')}\n`,
    )
    const c = guardTimeoutsCheck(agent, NOW, env)
    expect(c?.level).toBe('warn')
    expect(c?.detail).toContain('guard timeouts in the last 7 days: 2 (hooks: action-rules, check-vault)')
  })
})
