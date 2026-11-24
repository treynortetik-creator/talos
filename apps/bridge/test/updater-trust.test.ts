// Updater trust: the checkout is a folder an agent can write to (.git/config, hooks, refs), so the bridge's own update, rollback,
// good-start record and version read run git as the updater's tool: no fsmonitor program, no hook, nothing from the caller's
// GIT_* variables, and a branch with commits of its own is not pulled. Real git in throwaway repositories whose config and hooks
// would leave a file in a marker folder if git ever ran them; pnpm is a recorder. Nothing here touches the checkout the test runs from.
import { afterEach, describe, expect, test } from 'bun:test'
import {
  appendFileSync,
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { runCli } from '../src/cli.ts'
import { recordHealthyStart } from '../src/good-starts.ts'
import { runCommand } from '../src/run-command.ts'
import { UPDATER_GIT_OPTS_LEN, updaterGitArgv, updaterGitEnv } from '../src/updater-git.ts'
import { resolveVersion } from '../src/version.ts'
import { tempHome } from './helpers.ts'

// the test's own git is hardened too (arming a repository must not make the test's reads write marks) and never sees a hostile GIT_*
const sh = (cwd: string, ...a: string[]) => {
  const r = Bun.spawnSync(
    [
      'git',
      '-c',
      'core.fsmonitor=',
      '-c',
      'core.hooksPath=/dev/null',
      '-c',
      'user.email=t@e.x',
      '-c',
      'user.name=t',
      '-c',
      'commit.gpgsign=false',
      ...a,
    ],
    {
      cwd,
      stdout: 'pipe',
      stderr: 'pipe',
      env: Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('GIT_'))),
    },
  )
  if (r.exitCode !== 0) throw new Error(`git ${a.join(' ')}: ${r.stderr.toString()}`)
  return r.stdout.toString().trim()
}

/** A bare origin and a clone of it (the install) with two commits on main, shaped like the talos-app checkout. */
function world() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'talos-trust-')))
  const origin = join(root, 'origin.git')
  const seed = join(root, 'seed')
  const install = join(root, 'install')
  mkdirSync(seed)
  sh(seed, 'init', '-q', '-b', 'main')
  mkdirSync(join(seed, 'apps', 'bridge', 'src'), { recursive: true })
  writeFileSync(join(seed, 'apps', 'bridge', 'package.json'), '{"name":"x","version":"0.0.0"}')
  writeFileSync(join(seed, 'apps', 'bridge', 'src', 'version.ts'), '// stand-in')
  sh(seed, 'add', '.')
  sh(seed, 'commit', '-q', '-m', 'one')
  sh(root, 'clone', '-q', '--bare', seed, origin)
  sh(root, 'clone', '-q', origin, install)
  const push = (name: string) => {
    writeFileSync(join(seed, name), name)
    sh(seed, 'add', '.')
    sh(seed, 'commit', '-q', '-m', name)
    sh(seed, 'push', '-q', origin, 'HEAD:main')
  }
  const localCommit = (name: string) => {
    writeFileSync(join(install, name), name)
    sh(install, 'add', '.')
    sh(install, 'commit', '-q', '-m', name)
    return sh(install, 'rev-parse', 'HEAD')
  }
  return { root, install, origin, push, localCommit, head: () => sh(install, 'rev-parse', 'HEAD') }
}

const markDirs: string[] = []
/** Makes `dir` leave a file in a fresh marker folder when git runs its fsmonitor or one of its hooks; returns the folder. */
function arm(dir: string, via: 'hooks' | 'config' | 'hookspath' = 'hooks'): string {
  const marks = realpathSync(mkdtempSync(join(tmpdir(), 'talos-marks-')))
  markDirs.push(marks)
  const fsm = join(marks, '..', `fsm-${marks.split('/').pop()}.sh`)
  // a well-formed answer (a token, no changed paths): an unhardened git that runs it still reads the status as clean
  writeFileSync(fsm, `#!/bin/sh\ntouch "${marks}/fsmonitor"\nprintf 'x\\000'\n`)
  chmodSync(fsm, 0o755)
  if (via === 'config') sh(dir, 'config', 'core.fsmonitor', fsm)
  let hooks = join(dir, '.git', 'hooks')
  if (via === 'hookspath') {
    hooks = join(marks, 'hp')
    mkdirSync(hooks)
    sh(dir, 'config', 'core.hooksPath', hooks)
  }
  for (const h of [
    'post-checkout',
    'post-merge',
    'post-commit',
    'post-rewrite',
    'reference-transaction',
    'pre-auto-gc',
  ]) {
    const p = join(hooks, h)
    writeFileSync(p, `#!/bin/sh\ntouch "${marks}/${h}"\nexit 0\n`)
    chmodSync(p, 0o755)
  }
  return marks
}
const marked = (marks: string) => readdirSync(marks).filter((n) => n !== 'hp')

/** The git of a command goes through the real runner, with whatever extra arguments the code under test passes it (an environment). */
function realGit(pnpmCode = 0) {
  const calls: string[][] = []
  const run = (cmd: string[], cwd: string, ...rest: unknown[]) => {
    calls.push(cmd)
    if (cmd[0] === 'git') return (runCommand as (...a: unknown[]) => { code: number; out: string })(cmd, cwd, ...rest)
    if (cmd[0] === process.execPath) return { code: 0, out: '' }
    return { code: pnpmCode, out: '' }
  }
  return { calls, run }
}

function updateHarness(repoDir: string) {
  const g = realGit()
  const out: string[] = []
  const err: string[] = []
  const io = {
    out: (l: string) => out.push(l),
    err: (l: string) => err.push(l),
    prompt: async () => '',
    sleep: async () => {},
    now: () => Date.now(),
  }
  const home = tempHome()
  const run = () => runCli(['update'], io, { TALOS_APP_HOME: home }, { update: { repoDir, run: g.run } })
  return { ...g, out, err, run }
}

function rollbackHarness(repoDir: string, home: string) {
  const g = realGit()
  const out: string[] = []
  const err: string[] = []
  const io = {
    out: (l: string) => out.push(l),
    err: (l: string) => err.push(l),
    prompt: async () => 'y',
    sleep: async () => {},
    now: () => Date.now(),
  }
  const run = () =>
    runCli(
      ['rollback', '--yes', '--skip-data-check'],
      io,
      { TALOS_APP_HOME: home },
      { rollback: { repoDir, run: g.run } },
    )
  return { ...g, out, err, run }
}

const saved: Record<string, string | undefined> = {}
function setEnv(vars: Record<string, string>) {
  for (const [k, v] of Object.entries(vars)) {
    saved[k] = process.env[k]
    process.env[k] = v
  }
}
afterEach(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k]
    else process.env[k] = v
  }
  for (const k of Object.keys(saved)) delete saved[k]
})

/** Variables that would steer an unhardened git somewhere else: another repository, a fake git helper, a rewritten remote. */
function hostileEnv(root: string, origin: string): Record<string, string> {
  const decoy = join(root, 'decoy')
  mkdirSync(decoy)
  sh(decoy, 'init', '-q', '-b', 'main')
  const bin = join(root, 'evil-exec')
  mkdirSync(bin)
  writeFileSync(join(bin, 'git-upload-pack'), `#!/bin/sh\ntouch "${root}/exec-path-ran"\nexit 1\n`)
  chmodSync(join(bin, 'git-upload-pack'), 0o755)
  return {
    GIT_DIR: join(decoy, '.git'),
    GIT_WORK_TREE: decoy,
    GIT_EXEC_PATH: bin,
    GIT_CONFIG_COUNT: '1',
    GIT_CONFIG_KEY_0: `url.file:///nonexistent/.insteadOf`,
    GIT_CONFIG_VALUE_0: origin,
  }
}

describe('talos-app update on a checkout the agent can write to', () => {
  test("pulls without running the checkout's hooks (.git/hooks)", async () => {
    const w = world()
    const before = w.head()
    w.push('two')
    const marks = arm(w.install, 'hooks')
    const h = updateHarness(w.install)
    expect(await h.run()).toBe(0)
    expect(h.err).toEqual([])
    expect(w.head()).not.toBe(before)
    expect(marked(marks)).toEqual([])
  })

  for (const via of ['config', 'hookspath'] as const) {
    test(`a config that names a monitor or a hooks folder is refused, and nothing it names runs (${via})`, async () => {
      const w = world()
      const before = w.head()
      w.push('two')
      const marks = arm(w.install, via)
      const h = updateHarness(w.install)
      expect(await h.run()).toBe(1)
      expect(h.err.join('\n')).toContain('not a plain git clone')
      expect(h.calls.some((c) => c.includes('pull'))).toBe(false)
      expect(w.head()).toBe(before)
      expect(marked(marks)).toEqual([])
    })
  }

  test('GIT_DIR, GIT_EXEC_PATH and GIT_CONFIG_* in the caller environment are ignored', async () => {
    const w = world()
    const before = w.head()
    w.push('two')
    setEnv(hostileEnv(w.root, w.origin))
    const h = updateHarness(w.install)
    expect(await h.run()).toBe(0)
    expect(h.out[0]).toContain('updated:')
    expect(w.head()).not.toBe(before)
    expect(existsSync(join(w.root, 'exec-path-ran'))).toBe(false)
  })

  test('a branch with commits of its own is refused before anything is pulled', async () => {
    const w = world()
    const mine = w.localCommit('mine')
    const h = updateHarness(w.install)
    expect(await h.run()).toBe(1)
    expect(h.err.join('\n')).toContain('commits that are not on its remote branch')
    expect(h.calls.some((c) => c.includes('pull'))).toBe(false)
    expect(h.calls.some((c) => c[0] === 'pnpm')).toBe(false)
    expect(w.head()).toBe(mine)
  })

  test('a branch level with its remote, or behind it, is not refused', async () => {
    const w = world()
    const h = updateHarness(w.install)
    expect(await h.run()).toBe(0)
    w.push('two')
    expect(await updateHarness(w.install).run()).toBe(0)
  })
})

describe('talos-app rollback on a checkout the agent can write to', () => {
  const recorded = (w: ReturnType<typeof world>) => {
    const first = w.head()
    const home = tempHome()
    writeFileSync(
      join(home, 'good-starts.json'),
      JSON.stringify({ v: 1, starts: [{ commit: first, repo: w.install, recorded_at: '2026-01-01T00:00:00.000Z' }] }),
    )
    w.localCommit('two')
    return { first, home }
  }
  test("goes back without running the checkout's hooks (.git/hooks)", async () => {
    const w = world()
    const { first, home } = recorded(w)
    const marks = arm(w.install, 'hooks')
    const h = rollbackHarness(w.install, home)
    expect(await h.run()).toBe(0)
    expect(h.err).toEqual([])
    expect(w.head()).toBe(first)
    expect(marked(marks)).toEqual([])
  })

  for (const via of ['config', 'hookspath'] as const) {
    test(`a config that names a monitor or a hooks folder is refused, and nothing it names runs (${via})`, async () => {
      const w = world()
      const { home } = recorded(w)
      const before = w.head()
      const marks = arm(w.install, via)
      const h = rollbackHarness(w.install, home)
      expect(await h.run()).toBe(1)
      expect(h.err.join('\n')).toContain('not a plain git clone')
      expect(w.head()).toBe(before)
      expect(marked(marks)).toEqual([])
    })
  }

  test('GIT_DIR in the caller environment is ignored', async () => {
    const w = world()
    const first = w.head()
    const home = tempHome()
    writeFileSync(
      join(home, 'good-starts.json'),
      JSON.stringify({ v: 1, starts: [{ commit: first, repo: w.install, recorded_at: '2026-01-01T00:00:00.000Z' }] }),
    )
    w.localCommit('two')
    setEnv(hostileEnv(w.root, w.origin))
    const h = rollbackHarness(w.install, home)
    expect(await h.run()).toBe(0)
    expect(w.head()).toBe(first)
  })
})

describe('the record of healthy starts and the version, on a checkout the agent can write to', () => {
  test('recordHealthyStart runs no hook', () => {
    const w = world()
    const started = w.head()
    const marks = arm(w.install, 'hooks')
    const home = tempHome()
    const r = recordHealthyStart({
      file: join(home, 'good-starts.json'),
      repoDir: w.install,
      started: started.slice(0, 7),
    })
    expect(r).toEqual({ ok: true })
    expect(marked(marks)).toEqual([])
  })

  test('recordHealthyStart ignores GIT_DIR in the caller environment', () => {
    const w = world()
    const started = w.head()
    setEnv(hostileEnv(w.root, w.origin))
    const home = tempHome()
    const r = recordHealthyStart({
      file: join(home, 'good-starts.json'),
      repoDir: w.install,
      started: started.slice(0, 7),
    })
    expect(r).toEqual({ ok: true })
  })

  test('resolveVersion runs no hook', () => {
    const w = world()
    const marks = arm(w.install, 'hooks')
    const r = resolveVersion(w.install, { env: {} })
    expect(r.commit).toBe(w.head().slice(0, 7))
    expect(marked(marks)).toEqual([])
  })

  for (const via of ['config', 'hookspath'] as const) {
    test(`a config naming a monitor or a hooks folder: no start is recorded and nothing it names runs, not even for the version (${via})`, () => {
      const w = world()
      const started = w.head().slice(0, 7)
      const marks = arm(w.install, via)
      const r = recordHealthyStart({ file: join(tempHome(), 'good-starts.json'), repoDir: w.install, started })
      expect(r.ok).toBe(false)
      // the version is only read, and by the hardened git: nothing the config names runs
      expect(resolveVersion(w.install, { env: {} }).commit).toBe(w.head().slice(0, 7))
      expect(marked(marks)).toEqual([])
    })
  }

  test('resolveVersion ignores GIT_DIR in the caller environment', () => {
    const w = world()
    setEnv(hostileEnv(w.root, w.origin))
    expect(resolveVersion(w.install, { env: {} }).commit).toBe(w.head().slice(0, 7))
  })
})

describe('a checkout whose own files steer git is refused by update, rollback and the start record', () => {
  /** Each makes the checkout something other than a plain clone. */
  const spoils: Array<[string, (w: ReturnType<typeof world>) => void]> = [
    [
      'a .git that is a gitdir file',
      (w) => {
        renameSync(join(w.install, '.git'), join(w.root, 'gd'))
        writeFileSync(join(w.install, '.git'), `gitdir: ${join(w.root, 'gd')}\n`)
      },
    ],
    [
      'a .git that is a symlink',
      (w) => {
        renameSync(join(w.install, '.git'), join(w.root, 'gd'))
        symlinkSync(join(w.root, 'gd'), join(w.install, '.git'))
      },
    ],
    ['core.sshCommand', (w) => void sh(w.install, 'config', 'core.sshCommand', '/tmp/x')],
    ['filter.x.smudge', (w) => void sh(w.install, 'config', 'filter.x.smudge', '/tmp/x')],
    ['alias.status', (w) => void sh(w.install, 'config', 'alias.status', '!/tmp/x')],
    ['include.path', (w) => void sh(w.install, 'config', 'include.path', '/tmp/x')],
    ['core.hooksPath elsewhere', (w) => void sh(w.install, 'config', 'core.hooksPath', '/tmp/hooks')],
    ...['info/attributes', 'info/grafts', 'shallow', 'objects/info/alternates', 'config.worktree', 'gitdir'].map(
      (f) =>
        [
          `.git/${f}`,
          (w: ReturnType<typeof world>) => {
            mkdirSync(dirname(join(w.install, '.git', f)), { recursive: true })
            writeFileSync(join(w.install, '.git', f), '')
          },
        ] as [string, (w: ReturnType<typeof world>) => void],
    ),
    [
      'a commondir that holds a forged graft (git reads the other folder)',
      (w) => {
        const first = w.head()
        const second = w.localCommit('forged')
        const common = join(w.root, 'common')
        cpSync(join(w.install, '.git'), common, { recursive: true })
        writeFileSync(join(common, 'info', 'grafts'), `${first} ${second}\n`)
        for (const n of readdirSync(join(w.install, '.git'))) {
          if (n !== 'HEAD' && n !== 'index') rmSync(join(w.install, '.git', n), { recursive: true, force: true })
        }
        writeFileSync(join(w.install, '.git', 'commondir'), `${common}\n`)
      },
    ],
    [
      'a refs/replace entry',
      (w) => {
        const first = w.head()
        sh(w.install, 'replace', '--force', first, w.head())
        mkdirSync(join(w.install, '.git', 'refs', 'replace'), { recursive: true })
        writeFileSync(join(w.install, '.git', 'refs', 'replace', first), `${first}\n`)
      },
    ],
    [
      'a packed refs/replace entry',
      (w) => appendFileSync(join(w.install, '.git', 'packed-refs'), `${w.head()} refs/replace/${w.head()}\n`),
    ],
  ]

  for (const [name, spoil] of spoils) {
    test(`${name}: update, rollback and the start record all refuse`, async () => {
      const w = world()
      const first = w.head()
      const home = tempHome()
      writeFileSync(
        join(home, 'good-starts.json'),
        JSON.stringify({ v: 1, starts: [{ commit: first, repo: w.install, recorded_at: '2026-01-01T00:00:00.000Z' }] }),
      )
      const second = w.localCommit('two')
      spoil(w)
      const u = updateHarness(w.install)
      expect(await u.run()).toBe(1)
      expect(u.err.join('\n')).toContain('not a plain git clone')
      expect(u.calls.some((c) => c.includes('pull'))).toBe(false)
      const rb = rollbackHarness(w.install, home)
      expect(await rb.run()).toBe(1)
      expect(rb.err.join('\n')).toContain('not a plain git clone')
      expect(
        recordHealthyStart({ file: join(home, 'x.json'), repoDir: w.install, started: second.slice(0, 7) }).ok,
      ).toBe(false)
    })
  }

  test("what a clone and a developer have is not refused: user.name, branch.*, the checkout's own .githooks", async () => {
    const w = world()
    sh(w.install, 'config', 'user.name', 'someone')
    sh(w.install, 'config', 'branch.main.rebase', 'false')
    sh(w.install, 'config', 'core.hooksPath', '.githooks')
    w.push('two')
    const u = updateHarness(w.install)
    expect(await u.run()).toBe(0)
    expect(resolveVersion(w.install, { env: {} }).commit).toBe(w.head().slice(0, 7))
  })
})

describe('the version read does not run a filter the checkout names', () => {
  /** A checkout whose config has a clean filter, applied to every file by .git/info/attributes, and whose index is stat-dirty. */
  function filtered(extraKey: [string, string] = ['filter.x.clean', '']) {
    const w = world()
    const marks = realpathSync(mkdtempSync(join(tmpdir(), 'talos-marks-')))
    markDirs.push(marks)
    const script = join(marks, '..', `clean-${marks.split('/').pop()}.sh`)
    writeFileSync(script, `#!/bin/sh\ntouch "${marks}/filter"\ncat\n`)
    chmodSync(script, 0o755)
    sh(w.install, 'config', extraKey[0], extraKey[1] || script)
    mkdirSync(join(w.install, '.git', 'info'), { recursive: true })
    writeFileSync(join(w.install, '.git', 'info', 'attributes'), '* filter=x\n')
    // a tracked file touched after the commit: its stat differs from the index, so describe --dirty has to read its content
    const tracked = join(w.install, 'apps', 'bridge', 'package.json')
    writeFileSync(tracked, readFileSync(tracked))
    utimesSync(tracked, new Date(Date.now() + 5000), new Date(Date.now() + 5000))
    return { w, marks }
  }

  test('a filter.* key: the version still resolves, is never marked dirty, and the filter does not run', () => {
    const { w, marks } = filtered()
    const r = resolveVersion(w.install, { env: {} })
    expect(r.commit).toBe(w.head().slice(0, 7))
    expect(r.version.endsWith('-dirty')).toBe(false)
    expect(marked(marks)).toEqual([])
  })

  test('an include.path key does the same', () => {
    const { w, marks } = filtered(['include.path', '/tmp/not-there'])
    const r = resolveVersion(w.install, { env: {} })
    expect(r.commit).toBe(w.head().slice(0, 7))
    expect(r.version.endsWith('-dirty')).toBe(false)
    expect(marked(marks)).toEqual([])
  })

  test('a filter in .git/config.worktree (extensions.worktreeConfig) does not run either', () => {
    const w = world()
    const marks = realpathSync(mkdtempSync(join(tmpdir(), 'talos-marks-')))
    markDirs.push(marks)
    const script = join(marks, '..', `clean-${marks.split('/').pop()}.sh`)
    writeFileSync(script, `#!/bin/sh\ntouch "${marks}/filter"\ncat\n`)
    chmodSync(script, 0o755)
    sh(w.install, 'config', 'extensions.worktreeConfig', 'true')
    writeFileSync(join(w.install, '.git', 'config.worktree'), `[filter "x"]\n\tclean = ${script}\n`)
    mkdirSync(join(w.install, '.git', 'info'), { recursive: true })
    writeFileSync(join(w.install, '.git', 'info', 'attributes'), '* filter=x\n')
    const tracked = join(w.install, 'apps', 'bridge', 'package.json')
    writeFileSync(tracked, readFileSync(tracked))
    utimesSync(tracked, new Date(Date.now() + 5000), new Date(Date.now() + 5000))
    const r = resolveVersion(w.install, { env: {} })
    expect(r.commit).toBe(w.head().slice(0, 7))
    expect(r.version.endsWith('-dirty')).toBe(false)
    expect(marked(marks)).toEqual([])
  })

  test('with no filter or include in the config, a stat-dirty checkout is still read the usual way', () => {
    const w = world()
    const tracked = join(w.install, 'apps', 'bridge', 'package.json')
    writeFileSync(tracked, '{"name":"x","version":"0.0.1"}')
    expect(resolveVersion(w.install, { env: {} }).version.endsWith('-dirty')).toBe(true)
  })
})

describe('the updater git helper', () => {
  const repo = '/some/checkout'
  test('the command is git with the hardening options, the explicit git folder and work tree, then the arguments', () => {
    expect(updaterGitArgv(repo, 'status', '--porcelain')).toEqual([
      'git',
      '-c',
      'core.fsmonitor=',
      '-c',
      'core.hooksPath=/dev/null',
      '-c',
      'core.commitGraph=false',
      '-c',
      'safe.directory=/some/checkout',
      '--git-dir=/some/checkout/.git',
      '--work-tree=/some/checkout',
      'status',
      '--porcelain',
    ])
    expect(updaterGitArgv(repo, 'status')[UPDATER_GIT_OPTS_LEN + 1]).toBe('status')
  })

  test('the environment keeps only what git needs (the ssh agent and proxies too) and drops every GIT_* of the caller', () => {
    const env = updaterGitEnv({
      PATH: '/bin',
      HOME: '/h',
      LANG: 'C',
      TMPDIR: '/t',
      SSH_AUTH_SOCK: '/agent.sock',
      HTTPS_PROXY: 'http://p',
      GIT_DIR: '/x',
      GIT_WORK_TREE: '/x',
      GIT_EXEC_PATH: '/x',
      GIT_CONFIG_COUNT: '1',
      GIT_CONFIG_GLOBAL: '/x',
      GIT_NO_REPLACE_OBJECTS: '0',
      GIT_TERMINAL_PROMPT: '1',
      GIT_ASKPASS: '/x',
      ANTHROPIC_API_KEY: 'secret',
    })
    expect(env).toEqual({
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_TERMINAL_PROMPT: '0',
      GIT_OPTIONAL_LOCKS: '0',
      GIT_NO_REPLACE_OBJECTS: '1',
      PATH: '/bin',
      HOME: '/h',
      LANG: 'C',
      TMPDIR: '/t',
      SSH_AUTH_SOCK: '/agent.sock',
      HTTPS_PROXY: 'http://p',
    })
  })
})
