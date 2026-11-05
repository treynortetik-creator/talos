// Regression tests for the faster local CI. Each test pins one bug that was found and fixed. Same approach
// as pre-push.test.ts: a temp repo, a bare origin, a real `git push`, the real hook and installer.
import { execFileSync, spawnSync } from 'node:child_process'
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, describe, expect, it, vi } from 'vitest'

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = join(here, '..')
vi.setConfig({ testTimeout: 60_000 })
const dirs: string[] = []
afterAll(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

function setup() {
  const T = mkdtempSync(join(tmpdir(), 'ppr-'))
  dirs.push(T)
  const clone = join(T, 'clone')
  const log = join(T, 'calls.log')
  const env = {
    ...process.env,
    CALLS: log,
    TALOS_CI_NESTED: '0',
    TALOS_NO_HOOKS: '0',
    TALOS_PERSONAL_SCAN: 'stop', // the hard stop going public turns on; a test that wants the warning clears it
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_SYSTEM: '/dev/null',
    GIT_AUTHOR_NAME: 't',
    GIT_AUTHOR_EMAIL: 't@example.com',
    GIT_COMMITTER_NAME: 't',
    GIT_COMMITTER_EMAIL: 't@example.com',
  }
  const ok = (cwd: string, ...a: string[]) => {
    const r = spawnSync('git', a, { cwd, env, encoding: 'utf8' })
    if (r.status !== 0) throw new Error(`git ${a.join(' ')}: ${r.stderr}`)
    return r.stdout.trim()
  }
  mkdirSync(clone)
  ok(clone, 'init', '-q', '-b', 'main')
  mkdirSync(join(clone, 'scripts'))
  for (const f of ['pre-push.sh', 'install-hooks.sh', 'check-no-personal.sh', 'denylist.generic.txt'])
    cpSync(join(here, f), join(clone, 'scripts', f))
  cpSync(join(repoRoot, '.githooks'), join(clone, '.githooks'), { recursive: true })
  const put = (file: string, text = 'x\n') => {
    mkdirSync(dirname(join(clone, file)), { recursive: true })
    writeFileSync(join(clone, file), text)
  }
  put('apps/web/tsconfig.json', '{}\n')
  put('apps/web/src/a.ts')
  put('.gitignore', 'node_modules\n')
  ok(clone, 'add', '-A')
  ok(clone, 'commit', '-qm', 'base')
  const origin = join(T, 'origin.git')
  ok(T, 'clone', '-q', '--bare', clone, origin)
  ok(clone, 'remote', 'add', 'origin', origin)
  ok(clone, 'fetch', '-q', 'origin')
  ok(clone, 'checkout', '-qb', 'feat')
  const install = () => spawnSync('bash', ['scripts/install-hooks.sh'], { cwd: clone, env, encoding: 'utf8' })
  const change = (f: string, t: string) => {
    put(f, t)
    ok(clone, 'add', '-A')
    ok(clone, 'commit', '-qm', 'change')
  }
  return { T, clone, env, install, change, log }
}

describe('review #96: pre-push hook', () => {
  // scripts/pre-push.sh:34. On this Mac node and pnpm live under ~/.nvm, so a launchd job or a GUI git client has neither. The
  // biome stand-in execs node the way the real pnpm shim does. A tool that can't start is not a code problem.
  it('with no node or pnpm on PATH it says so and lets the push go, like a missing node_modules', () => {
    const r = setup()
    r.install()
    r.change('apps/web/src/b.ts', 'y\n')
    const biome = join(r.clone, 'node_modules/.bin/biome')
    mkdirSync(dirname(biome), { recursive: true })
    writeFileSync(biome, '#!/bin/sh\nexec node "$0" "$@"\n')
    chmodSync(biome, 0o755)
    const safe = join(r.T, 'safe-bin') // a PATH with what the hook needs and no node or pnpm
    mkdirSync(safe)
    for (const t of [
      'git',
      'bash',
      'sh',
      'env',
      'mktemp',
      'rm',
      'cat',
      'cut',
      'xargs',
      'sleep',
      'dirname',
      'sed',
      'uname',
      'tr', // the personal-data check also needs these
      'grep',
      'sort',
      'wc',
      'awk',
      'mv',
      'basename',
      'mkdir',
      'find',
    ]) {
      symlinkSync(execFileSync('sh', ['-c', `command -v ${t}`], { encoding: 'utf8' }).trim(), join(safe, t))
    }
    const p = spawnSync('git', ['push', '-q', 'origin', 'HEAD:refs/heads/feat'], {
      cwd: r.clone,
      env: { ...r.env, PATH: safe },
      encoding: 'utf8',
    })
    expect(p.stderr).not.toContain('pre-push: fix the above')
    expect(p.status).toBe(0)
  })
})

describe('review #96: install-hooks', () => {
  // scripts/install-hooks.sh:10. core.hooksPath replaces .git/hooks as a whole, so an existing hook just stops, with no word.
  it('a hook already in .git/hooks still runs after pnpm install', () => {
    const r = setup()
    const hook = join(r.clone, '.git/hooks/pre-commit')
    writeFileSync(hook, '#!/bin/sh\necho "secret scanner ran" >> "$CALLS"\n')
    chmodSync(hook, 0o755)
    r.install()
    r.change('apps/web/src/b.ts', 'y\n')
    expect(existsSync(r.log) ? readFileSync(r.log, 'utf8') : '').toContain('secret scanner ran')
  })
})

describe('review #96: pre-push.test.ts itself', () => {
  // scripts/pre-push.test.ts:191. Real pushes under Vitest's default 5 s: the ci-local suites and test-parallel set their own
  // limit, this one has none, and line 200 asserts under 30 s, which the 5 s limit reaches first on a loaded Mac.
  it('sets a suite timeout, like the ci-local suites', () => {
    expect(readFileSync(join(here, 'pre-push.test.ts'), 'utf8')).toMatch(/testTimeout:\s*\d/)
  })
})
