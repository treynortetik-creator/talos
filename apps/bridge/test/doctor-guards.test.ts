// talos-app doctor's guard-timeout row: ok with none (or no file), a warning with the count and hooks for timeouts in the last 7 days.
import { afterEach, describe, expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { actionRulesUnreadableCheck, guardTimeoutsCheck } from '../src/doctor-guards.ts'
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

describe('doctor: unreadable action rules', () => {
  const urow = (file: string, daysAgo: number) =>
    JSON.stringify({
      at: new Date(NOW - daysAgo * 86400_000).toISOString(),
      file,
      path: `/x/${file}/action-rules.yaml`,
      error: 'line 3: cannot read',
      unattended: false,
    })
  const withLog = (lines: string[] | undefined) => {
    const env = { XDG_STATE_HOME: dir('talos-doc-ur-state-'), XDG_CONFIG_HOME: dir('talos-doc-ur-cfg-') }
    const agent = agentDir()
    const state = dirname(gazetteerPath(agent, env))
    mkdirSync(state, { recursive: true })
    if (lines) writeFileSync(join(state, 'action-rules-unreadable.jsonl'), `${lines.join('\n')}\n`)
    return { agent, env, state }
  }

  test('no file: ok', () => {
    const { agent, env } = withLog(undefined)
    expect(actionRulesUnreadableCheck(agent, NOW, env)?.level).toBe('ok')
  })

  test('not a Talos agent folder: no row', () => {
    expect(
      actionRulesUnreadableCheck(dir('talos-doc-ur-plain-'), NOW, { XDG_STATE_HOME: dir('talos-doc-ur-state-') }),
    ).toBeUndefined()
  })

  test('only old rows: ok', () => {
    const { agent, env } = withLog([urow('shipped', 30), 'not json'])
    expect(actionRulesUnreadableCheck(agent, NOW, env)?.level).toBe('ok')
  })

  test('a recent shipped row: a warning, every call asked or was refused', () => {
    const { agent, env } = withLog([urow('shipped', 1), urow('shipped', 2)])
    const c = actionRulesUnreadableCheck(agent, NOW, env)
    expect(c?.level).toBe('warn')
    expect(c?.detail).toContain('shipped')
    expect(c?.detail).toContain('asked or was refused')
  })

  test('a recent row of the owner’s own file: the same stop, not a skip', () => {
    const { agent, env } = withLog([urow('user', 1), urow('user', 3)])
    const c = actionRulesUnreadableCheck(agent, NOW, env)
    expect(c?.level).toBe('warn')
    expect(c?.detail).toContain('your rules file')
    expect(c?.detail).toContain('asked or was refused')
    expect(c?.detail).not.toContain('skipped')
  })

  describe('with the real hook', () => {
    const HOOKS = join(import.meta.dir, '..', '..', '..', 'kit', 'hooks')
    const realAgent = () => {
      const agent = realpathSync(dir('talos-doc-ur-real-')) // the kit names its state folder from the real path
      mkdirSync(join(agent, 'hooks'))
      for (const f of readdirSync(HOOKS).filter((n) => /\.(py|yaml)$/.test(n)))
        copyFileSync(join(HOOKS, f), join(agent, 'hooks', f))
      return agent
    }
    const setup = (rules: string) => {
      const cfg = dir('talos-doc-ur-cfg-')
      mkdirSync(join(cfg, 'talos'))
      writeFileSync(join(cfg, 'talos', 'action-rules.yaml'), rules)
      return { agent: realAgent(), env: { XDG_STATE_HOME: dir('talos-doc-ur-state-'), XDG_CONFIG_HOME: cfg } }
    }
    const check = (agent: string, env: Record<string, string>) =>
      spawnSync('python3', [join(agent, 'hooks', 'action-rules.py'), 'check'], {
        encoding: 'utf8',
        cwd: agent,
        input: JSON.stringify({ tool_name: 'Bash', cwd: '/srv/app', tool_input: { command: 'npm publish' } }),
        env: { PATH: process.env.PATH ?? '', HOME: dir('talos-doc-ur-home-'), CLAUDE_PROJECT_DIR: agent, ...env },
      })

    test('good files: ok', () => {
      const { agent, env } = setup('rules:\n  - id: mine\n    decision: never\n    tool: Bash\n    command: "zzz"\n')
      expect(actionRulesUnreadableCheck(agent, NOW, env)?.level).toBe('ok')
    })

    test('a broken file of the owner’s is a warning that names the line, found by reading it, with no log needed', () => {
      const { agent, env } = setup('rules:\n  this is not a rule\n')
      const c = actionRulesUnreadableCheck(agent, NOW, env)
      expect(c?.level).toBe('warn')
      expect(c?.detail).toContain('right now')
      expect(c?.detail).toContain('your rules')
      expect(c?.detail).toContain('line 2')
    })

    test('guard switched off and a broken file: the hook answers as before ({} = allow, nothing asked, nothing logged); only doctor warns', () => {
      const { agent, env } = setup('rules:\n  this is not a rule\n')
      const state = dirname(gazetteerPath(agent, env))
      mkdirSync(state, { recursive: true })
      writeFileSync(join(state, 'action-rules.off'), '')
      const r = check(agent, env)
      expect(r.status).toBe(0)
      expect(r.stdout.trim()).toBe('{}')
      expect(existsSync(join(state, 'action-rules-unreadable.jsonl'))).toBe(false)
      const c = actionRulesUnreadableCheck(agent, NOW, env)
      expect(c?.level).toBe('warn')
      expect(c?.detail).toContain('line 2')
      // switched on again: the same file now stops (asks), and the log shows it
      rmSync(join(state, 'action-rules.off'))
      expect(check(agent, env).stdout).toContain('"ask"')
      expect(existsSync(join(state, 'action-rules-unreadable.jsonl'))).toBe(true)
    })
  })
})
