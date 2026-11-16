// A scratch "remote", a pushing clone and a stand-in main checkout for the personal-data watch tests
// (check-ref-personal.test.ts, personal-watch.test.ts). The value in the fake private list is invented; it is in no real list.
import { execFileSync, spawnSync } from 'node:child_process'
import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect } from 'vitest'

export const here = dirname(fileURLToPath(import.meta.url))
export const FAKE = 'Quillmoor Ventures'
export const RULES = '# fake private list for the test\n.\ti\tquillmoor[ -]ventures\n'
export const RULE = '[personal-denylist.txt rule line 2]'
const SCRIPTS = ['check-no-personal.sh', 'denylist.generic.txt', 'check-ref-personal.sh', 'personal-watch.sh']

export function setup() {
  const root = mkdtempSync(join(tmpdir(), 'pwatch-'))
  const tmp = join(root, 'tmp')
  const home = join(root, 'home')
  mkdirSync(tmp)
  mkdirSync(home)
  const env: Record<string, string> = {
    HOME: home,
    TMPDIR: tmp,
    PATH: process.env.PATH ?? '/usr/bin:/bin',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_AUTHOR_NAME: 'Alex Example',
    GIT_AUTHOR_EMAIL: 'alex@example.com',
    GIT_COMMITTER_NAME: 'Alex Example',
    GIT_COMMITTER_EMAIL: 'alex@example.com',
  }
  // the caller's locale reaches the scripts, so the suite can be run under LANG=en_US.UTF-8 as well as C
  for (const k of ['LANG', 'LC_ALL', 'LC_CTYPE'] as const) {
    const v = process.env[k]
    if (v) env[k] = v
  }
  const git = (cwd: string, ...args: string[]) =>
    execFileSync('git', ['-c', 'init.defaultBranch=main', '-c', 'protocol.file.allow=always', ...args], {
      cwd,
      env,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim()
  const gitIn = (cwd: string, input: Buffer | string, ...args: string[]) =>
    execFileSync('git', args, { cwd, env, input, encoding: 'utf8' }).trim()
  const remote = join(root, 'remote.git')
  git(root, 'init', '--bare', '-q', remote)
  const dev = join(root, 'dev')
  git(root, 'clone', '-q', remote, dev)
  const commit = (files: Record<string, string | Buffer>, msg = 'change', remove: string[] = []) => {
    for (const [p, c] of Object.entries(files)) {
      mkdirSync(dirname(join(dev, p)), { recursive: true })
      writeFileSync(join(dev, p), c)
    }
    for (const p of remove) git(dev, 'rm', '-q', p)
    git(dev, 'add', '-A')
    git(dev, 'commit', '-q', '-m', msg)
    return git(dev, 'rev-parse', 'HEAD')
  }
  const push = (spec = 'HEAD:main', ...extra: string[]) => git(dev, 'push', '-q', ...extra, 'origin', spec)
  commit({ 'README.md': 'hello\n', 'src/a.ts': 'export const a = 1\n' }, 'start')
  push()
  // the owner's main checkout: holds the scripts and the (fake) private list; it must never change
  const owner = join(root, 'owner')
  git(root, 'clone', '-q', remote, owner)
  mkdirSync(join(owner, 'scripts'))
  for (const f of SCRIPTS) copyFileSync(join(here, f), join(owner, 'scripts', f))
  const rules = join(owner, 'scripts', 'personal-denylist.txt')
  writeFileSync(rules, RULES)
  writeFileSync(join(owner, '.git', 'info', 'exclude'), 'scripts/\n')
  const cache = join(home, '.cache', 'talos-personal-watch')
  return { root, tmp, home, env, git, gitIn, remote, dev, owner, rules, cache, commit, push }
}
export type Env = ReturnType<typeof setup>

export function snapshot(e: Env) {
  // the index time is read first, and status runs without optional locks, so the snapshot itself never rewrites the index
  const index = statSync(join(e.owner, '.git', 'index')).mtimeMs
  const g = (...a: string[]) => e.git(e.owner, '--no-optional-locks', ...a)
  return {
    index,
    head: g('rev-parse', 'HEAD'),
    refs: g('for-each-ref'),
    status: g('status', '--porcelain', '--untracked-files=all'),
  }
}

export function checkRef(e: Env, args: string[], extra: Record<string, string> = {}, cwd = e.owner) {
  e.git(e.owner, 'fetch', '-q', '--prune', '--tags', 'origin')
  const r = spawnSync('bash', [join(cwd, 'scripts', 'check-ref-personal.sh'), ...args], {
    cwd,
    env: { ...e.env, ...extra },
    encoding: 'utf8',
  })
  return { code: r.status, out: r.stdout, err: r.stderr }
}

export function watch(e: Env, extra: string[] = [], env: Record<string, string> = {}) {
  const r = spawnSync(
    'bash',
    [join(e.owner, 'scripts', 'personal-watch.sh'), '--rules', e.rules, '--remote', e.remote, '--once', ...extra],
    { cwd: e.root, env: { ...e.env, ...env }, encoding: 'utf8' },
  )
  return { code: r.status, out: r.stdout, err: r.stderr }
}

export const hits = (out: string) => out.split('\n').filter((l) => l.startsWith('personal-watch: HIT '))
export const s12 = (sha: string) => sha.slice(0, 12)
export const noValue = (s: string) => expect(s.toLowerCase()).not.toMatch(/quillmoor/)
export const tmpEmpty = (e: Env) => expect(readdirSync(e.tmp)).toEqual([])

// every file under the cache folder except the git clone itself, as text
export function stateText(e: Env): string {
  const out: string[] = []
  const walk = (d: string) => {
    for (const f of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, f.name)
      if (f.isDirectory()) {
        if (p !== join(e.cache, 'repo')) walk(p)
      } else out.push(`${p}\n${readFileSync(p, 'latin1')}`)
    }
  }
  walk(e.cache)
  return out.join('\n')
}
