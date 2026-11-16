// apps/desktop/scripts/tests-green-stamp.sh: ci.sh exports this stamp after its green test.sh run, and guards-test.sh's control
// reuses that run only when the stamp it takes itself is the same. So the stamp must change with anything that could change the
// result (a commit, a tracked edit, an untracked file, the canary flag) and stay put for what cannot (ignored build output).

import { spawnSync } from 'node:child_process'
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, describe, expect, it } from 'vitest'
import { cleanEnv } from './ci-test-env'

const here = dirname(fileURLToPath(import.meta.url))
const source = join(here, '..', 'apps', 'desktop', 'scripts', 'tests-green-stamp.sh')
const dirs: string[] = []
afterAll(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

/** A clone with the script at its real place, one commit, `.build` ignored. */
function clone(git = true) {
  const d = mkdtempSync(join(tmpdir(), 'tgs-'))
  dirs.push(d)
  mkdirSync(join(d, 'apps', 'desktop', 'scripts'), { recursive: true })
  copyFileSync(source, join(d, 'apps', 'desktop', 'scripts', 'tests-green-stamp.sh'))
  writeFileSync(join(d, '.gitignore'), '.build/\n')
  writeFileSync(join(d, 'a.swift'), 'let a = 1\n')
  const g = (...args: string[]) =>
    spawnSync('git', ['-c', 'user.name=Alex Example', '-c', 'user.email=alex@example.com', ...args], { cwd: d })
  if (git) {
    g('init', '-q')
    g('add', '.')
    g('commit', '-qm', 'one')
  }
  const stamp = (env: Record<string, string> = {}) => {
    const e = { ...cleanEnv(), ...env }
    if (!('TALOS_CANARY_FAIL' in env)) delete e.TALOS_CANARY_FAIL
    return spawnSync('bash', [join(d, 'apps', 'desktop', 'scripts', 'tests-green-stamp.sh')], {
      encoding: 'utf8',
      env: e,
    })
  }
  return { d, g, stamp }
}

describe('tests-green-stamp.sh', () => {
  it('is the same for the same tree, and ignored build output does not change it', () => {
    const c = clone()
    const first = c.stamp()
    expect(first.status, first.stderr).toBe(0)
    expect(first.stdout.trim()).toMatch(/^[0-9a-f]{64}$/)
    mkdirSync(join(c.d, '.build'))
    writeFileSync(join(c.d, '.build', 'out.o'), 'built')
    expect(c.stamp().stdout).toBe(first.stdout)
  })

  it('changes with a tracked edit, an untracked file, a new commit and the canary flag', () => {
    const c = clone()
    const base = c.stamp().stdout
    expect(c.stamp({ TALOS_CANARY_FAIL: '1' }).stdout).not.toBe(base)
    writeFileSync(join(c.d, 'a.swift'), 'let a = 2\n')
    const edited = c.stamp().stdout
    expect(edited).not.toBe(base)
    writeFileSync(join(c.d, 'b.swift'), 'let b = 1\n')
    const untracked = c.stamp().stdout
    expect(untracked).not.toBe(edited)
    writeFileSync(join(c.d, 'b.swift'), 'let b = 2\n')
    expect(c.stamp().stdout).not.toBe(untracked)
    c.g('add', '.')
    c.g('commit', '-qm', 'two')
    expect(c.stamp().stdout).not.toBe(base)
  })

  it('prints nothing and fails outside a git checkout, so nothing is reused', () => {
    const r = clone(false).stamp()
    expect(r.status).not.toBe(0)
    expect(r.stdout).toBe('')
  })
})
