// The pre-push hook and the gate it hands over to (scripts/gate.sh), for real: a temp repo, a bare origin, a real `git push`,
// the real hook, gate and installer, with stand-ins for biome, pnpm and bun that write down what they were asked to do.
// A check that only lives in a doc gets skipped, so what matters here is that `pnpm install` turns it on for every worktree and that a failing check really stops the push.

import { spawn, spawnSync } from 'node:child_process'
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, describe, expect, it, vi } from 'vitest'
import { t as scaled } from '../packages/testkit/src/time-factor.ts'
import { fakeTool } from './fake-tool'

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = join(here, '..')
vi.setConfig({ testTimeout: scaled(60_000), hookTimeout: scaled(60_000) }) // real git pushes, beside other suites on a loaded Mac
const dirs: string[] = []
afterAll(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

function setup() {
  const T = mkdtempSync(join(tmpdir(), 'pp-'))
  dirs.push(T)
  const clone = join(T, 'clone')
  const log = join(T, 'calls.log')
  const bin = join(T, 'bin')
  const env = {
    ...process.env,
    PATH: `${bin}:${process.env.PATH}`,
    CALLS: log,
    TALOS_CI_CACHE: join(T, 'cache'), // the log of fast-gate fallbacks goes here, never to the real ~/.cache/talos-ci
    TALOS_CI_NESTED: '0',
    TALOS_NO_HOOKS: '0',
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_SYSTEM: '/dev/null',
    GIT_AUTHOR_NAME: 't',
    GIT_AUTHOR_EMAIL: 't@example.com',
    GIT_COMMITTER_NAME: 't',
    GIT_COMMITTER_EMAIL: 't@example.com',
  }
  const git = (cwd: string, ...a: string[]) => spawnSync('git', a, { cwd, env, encoding: 'utf8' })
  const ok = (cwd: string, ...a: string[]) => {
    const r = git(cwd, ...a)
    if (r.status !== 0) throw new Error(`git ${a.join(' ')}: ${r.stderr}`)
    return r.stdout.trim()
  }
  mkdirSync(bin)
  const stub = (path: string, body: string) => {
    mkdirSync(dirname(path), { recursive: true })
    fakeTool(dirname(path), basename(path), `#!/bin/sh\n${body}\n`)
  }
  // pnpm: the typecheck stand-in; biome: lives in node_modules like the real one. FAIL=<tool> turns it red.
  stub(join(bin, 'pnpm'), 'echo "pnpm $*" >> "$CALLS"; [ "$FAIL" = pnpm ] && exit 1; exit 0')
  // bun: the bridge suite's stand-in (the gate runs it in apps/bridge)
  // the gate asks every bun its version and its SQLite's first (named at the top of each run): answered, not logged
  stub(
    join(bin, 'bun'),
    'case "$1" in --version) echo 1.4.4; exit 0 ;; -e) echo 3.45.0; exit 0 ;; esac; echo "bun $*" >> "$CALLS"; [ "$FAIL" = bun ] && exit 1; exit 0',
  )
  mkdirSync(clone)
  ok(clone, 'init', '-q', '-b', 'main')
  for (const f of [
    'pre-push.sh',
    'verified-trailer.sh',
    'gate.sh',
    'talos-machine.sh',
    'path-fold.sh',
    'install-hooks.sh',
    'check-no-personal.sh',
    'denylist.generic.txt',
  ]) {
    mkdirSync(join(clone, 'scripts'), { recursive: true })
    cpSync(join(here, f), join(clone, 'scripts', f))
  }
  cpSync(join(here, 'gate'), join(clone, 'scripts/gate'), { recursive: true })
  cpSync(join(repoRoot, '.githooks'), join(clone, '.githooks'), { recursive: true })
  const put = (file: string, text = 'x\n') => {
    mkdirSync(dirname(join(clone, file)), { recursive: true })
    writeFileSync(join(clone, file), text)
  }
  // no e2e package: the gate's e2e step (gate.test.ts) would need Playwright in this clone
  for (const p of ['apps/web', 'apps/relay', 'packages/protocol']) put(`${p}/tsconfig.json`, '{}\n')
  put('apps/web/src/a.ts')
  put('apps/bridge/package.json', '{}\n') // the gate runs the bridge suite in there
  put('docs/a.md')
  put('.gitignore', 'node_modules\n')
  ok(clone, 'add', '-A')
  ok(clone, 'commit', '-qm', 'base')
  const origin = join(T, 'origin.git')
  ok(T, 'clone', '-q', '--bare', clone, origin)
  ok(clone, 'remote', 'add', 'origin', origin)
  ok(clone, 'fetch', '-q', 'origin')
  ok(clone, 'checkout', '-qb', 'feat')
  stub(join(clone, 'node_modules/.bin/biome'), 'echo "biome $*" >> "$CALLS"; [ "$FAIL" = biome ] && exit 1; exit 0')
  const install = (e: Record<string, string> = {}) =>
    spawnSync('bash', ['scripts/install-hooks.sh'], { cwd: clone, env: { ...env, ...e }, encoding: 'utf8' })
  const change = (files: Record<string, string>, remove: string[] = []) => {
    for (const [f, t] of Object.entries(files)) put(f, t)
    for (const f of remove) rmSync(join(clone, f))
    ok(clone, 'add', '-A')
    ok(clone, 'commit', '-qm', 'change')
  }
  const push = (e: Record<string, string> = {}, ...a: string[]) => {
    rmSync(log, { force: true })
    const r = spawnSync('git', ['push', '-q', 'origin', ...(a.length ? a : ['HEAD:refs/heads/feat'])], {
      cwd: clone,
      env: { ...env, ...e },
      encoding: 'utf8',
    })
    return { code: r.status, err: r.stderr }
  }
  const calls = () => (existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n') : [])
  return { T, clone, origin, env, git, ok, install, change, push, calls, stub }
}

// What the gate was asked to run, in order: the stand-ins write one line per call.
const TYPECHECK = 'pnpm -s typecheck'
const LINT = 'biome check .'
const SIZE = 'pnpm exec vitest run --project scripts scripts/size-budget.test.ts'

describe('pre-push hook', () => {
  it('`pnpm install` turns it on, and a failing check stops the push', () => {
    const r = setup()
    r.change({ 'apps/web/src/b.ts': 'y\n' })
    expect(r.push({}).code).toBe(0) // before the install: no hook
    expect(r.calls()).toEqual([])

    expect(r.install().status).toBe(0)
    r.change({ 'apps/web/src/b.ts': 'z\n' })
    const biome = r.push({ FAIL: 'biome' })
    expect(biome.code).not.toBe(0)
    expect(biome.err).toContain('gate: REFUSED: lint failed')
    expect(r.ok(r.origin, 'rev-parse', 'feat')).not.toBe(r.ok(r.clone, 'rev-parse', 'HEAD')) // it did not get there

    const tsc = r.push({ FAIL: 'pnpm' })
    expect(tsc.code).not.toBe(0)
    expect(tsc.err).toContain('gate: REFUSED: typecheck failed')
    const p = r.push({})
    expect(p.code, p.err).toBe(0)
    expect(p.err).toContain('gate: passed')
    expect(r.ok(r.origin, 'rev-parse', 'feat')).toBe(r.ok(r.clone, 'rev-parse', 'HEAD'))
  })

  it('runs the whole gate in order: typecheck, lint, personal, size, then the suites the push touches', () => {
    const r = setup()
    r.install()
    r.change({ 'apps/web/src/with space.ts': 'y\n', 'apps/web/src/b.ts': 'y\n' }, ['apps/web/src/a.ts'])
    const p = r.push()
    expect(p.code, p.err).toBe(0)
    expect(r.calls()).toEqual([
      TYPECHECK,
      LINT,
      SIZE,
      // the changed files that still exist, whatever their names; a deleted one is not passed on
      'pnpm exec vitest related --run apps/web/src/b.ts apps/web/src/with space.ts',
      // and the deleted one runs its app's whole project (a test may read it by path)
      'pnpm exec vitest run --project web',
    ])
    expect(p.err).toContain('gate: personal ok')
  })

  it('a failing size budget or touched suite stops the push too', () => {
    const r = setup()
    r.install()
    r.change({ 'apps/web/src/b.ts': 'y\n' })
    r.stub(join(r.T, 'bin', 'pnpm'), 'echo "pnpm $*" >> "$CALLS"; case "$*" in *size-budget*) exit 1 ;; esac; exit 0')
    const size = r.push()
    expect(size.code).not.toBe(0)
    expect(size.err).toContain('gate: REFUSED: size failed')
    r.stub(join(r.T, 'bin', 'pnpm'), 'echo "pnpm $*" >> "$CALLS"; case "$*" in *related*) exit 1 ;; esac; exit 0')
    const suite = r.push()
    expect(suite.code).not.toBe(0)
    expect(suite.err).toContain('gate: REFUSED: tests (vitest related) failed')
  })

  it('a worktree added later has it too, without an install of its own', () => {
    const r = setup()
    r.install()
    const wt = join(r.T, 'wt')
    r.ok(r.clone, 'worktree', 'add', '-q', '-b', 'other', wt, 'HEAD')
    r.stub(join(wt, 'node_modules/.bin/biome'), 'echo "biome $*" >> "$CALLS"; exit 1')
    mkdirSync(join(wt, 'apps/web/src'), { recursive: true })
    writeFileSync(join(wt, 'apps/web/src/c.ts'), 'c\n')
    r.ok(wt, 'add', '-A')
    r.ok(wt, 'commit', '-qm', 'c')
    const p = r.git(join(wt, 'apps'), 'push', '-q', 'origin', 'HEAD:refs/heads/other') // from a subfolder, too
    expect(p.status).not.toBe(0)
    expect(p.stderr).toContain('gate: REFUSED: lint failed')
    expect(r.calls()).toContain(LINT)
  })

  it("the suites never see git's hook variables: their own temp repos must not read this one", () => {
    const r = setup()
    r.install()
    const wt = join(r.T, 'wt3')
    r.ok(r.clone, 'worktree', 'add', '-q', '-b', 'other3', wt, 'HEAD') // git exports GIT_DIR to a linked worktree's hook
    r.stub(join(wt, 'node_modules/.bin/biome'), 'exit 0')
    r.stub(join(r.T, 'bin', 'pnpm'), 'env | grep -E "^GIT_(DIR|WORK_TREE|INDEX_FILE)=" >> "$CALLS"; exit 0')
    mkdirSync(join(wt, 'apps/web/src'), { recursive: true })
    writeFileSync(join(wt, 'apps/web/src/d.ts'), 'd\n')
    r.ok(wt, 'add', '-A')
    r.ok(wt, 'commit', '-qm', 'd')
    const p = r.git(wt, 'push', '-q', 'origin', 'HEAD:refs/heads/other3')
    expect(p.status, p.stderr).toBe(0)
    expect(p.stderr).toContain('gate: passed')
    expect(r.calls().filter(Boolean)).toEqual([])
  })

  // Sample values are assembled at run time so this file itself holds nothing the personal-data scan would flag.
  const bad = ['jo.smith', '@', 'gmail.com'].join('')

  it('the personal-data check runs first and stops the push, before biome or tsc are asked anything', () => {
    const r = setup()
    r.install()
    r.change({ 'docs/a.md': `write to ${bad}\n` })
    const p = r.push()
    expect(p.code).not.toBe(0)
    expect(p.err).toContain('check-no-personal: FAILED')
    expect(p.err).toContain('the personal-data check failed')
    expect(r.calls()).toEqual([])
    expect(r.git(r.origin, 'rev-parse', '--verify', '-q', 'feat').status).not.toBe(0) // it did not get there
    // A later commit that removes the value is not enough, the bad one is still in the push: it has to be taken out.
    r.change({ 'docs/a.md': 'fixed\n' })
    expect(r.push().code).not.toBe(0)
    r.ok(r.clone, 'reset', '-q', '--hard', 'HEAD~2')
    r.change({ 'docs/a.md': 'fixed\n' })
    expect(r.push().code).toBe(0)
  })

  it('a hit already on main is not blamed on this push, but the tree check still refuses it: main must be clean', () => {
    const r = setup()
    r.install()
    r.ok(r.origin, 'update-ref', 'refs/heads/main', r.ok(r.clone, 'rev-parse', 'main'))
    r.change({ 'docs/old.md': `write to ${bad}\n` })
    r.ok(r.clone, 'update-ref', 'refs/remotes/origin/main', 'HEAD') // pretend that commit already reached origin/main
    r.change({ 'apps/web/src/b.ts': 'y\n' })
    const p = r.push()
    expect(p.code).not.toBe(0)
    expect(p.err).not.toContain('the personal-data check failed on commit') // the range scan skips main's commits
    expect(p.err).toContain('gate: REFUSED: personal failed')
    expect(p.err).toContain('docs/old.md')
    expect(p.err).not.toContain(bad) // named by file and line, never printed
  })

  it('there is no warning-only mode: TALOS_PERSONAL_SCAN=warn still stops the push', () => {
    const r = setup()
    r.install()
    r.change({ 'docs/a.md': `write to ${bad}\n` })
    const p = r.push({ TALOS_PERSONAL_SCAN: 'warn' })
    expect(p.code).not.toBe(0)
    expect(p.err).toContain('docs/a.md:1')
    expect(p.err).not.toContain('the push goes on')
    expect(p.err).not.toContain(bad)
  })

  it('a push is stopped for personal data even with no node_modules', () => {
    const r = setup()
    r.install()
    rmSync(join(r.clone, 'node_modules'), { recursive: true })
    r.change({ 'docs/a.md': `write to ${bad}\n` })
    const p = r.push()
    expect(p.code).not.toBe(0)
    expect(p.err).toContain('check-no-personal: FAILED')
  })

  it('a missing check script stops the push; it is not read as a pass', () => {
    const r = setup()
    r.install()
    r.change({}, ['scripts/check-no-personal.sh'])
    const p = r.push()
    expect(p.code).not.toBe(0)
    expect(p.err).toContain('check-no-personal.sh is missing')
  })

  it("a worktree runs the owner's private list from the main checkout, where the gitignored file lives", () => {
    const secret = 'zq-private-marker-77'
    const r = setup()
    r.install()
    // The private list exists only in the main checkout, gitignored, like the real one.
    writeFileSync(join(r.clone, 'scripts/personal-denylist.txt'), `.*\t-\t${secret}\n`)
    r.ok(r.clone, 'checkout', '-q', 'main')
    const wt = join(r.T, 'wt2')
    r.ok(r.clone, 'worktree', 'add', '-q', '-b', 'other2', wt, 'HEAD')
    expect(existsSync(join(wt, 'scripts/personal-denylist.txt'))).toBe(false)
    r.stub(join(wt, 'node_modules/.bin/biome'), 'exit 0')
    mkdirSync(join(wt, 'docs'), { recursive: true })
    writeFileSync(join(wt, 'docs/n.md'), `notes ${secret}\n`)
    r.ok(wt, 'add', '-A')
    r.ok(wt, 'commit', '-qm', 'n')
    const p = r.git(wt, 'push', '-q', 'origin', 'HEAD:refs/heads/other2')
    expect(p.status).not.toBe(0)
    expect(p.stderr).toContain('personal-denylist.txt rule line')
    expect(p.stderr).not.toContain(secret) // the hit is named by file and line, never printed
    // Without the list anywhere, the hook and the gate say only the generic rules ran, instead of implying more.
    rmSync(join(r.clone, 'scripts/personal-denylist.txt'))
    const q = r.git(wt, 'push', '-q', 'origin', 'HEAD:refs/heads/other2')
    expect(q.status, q.stderr).toBe(0)
    expect(q.stderr).toContain('only the generic personal-data rules ran')
    expect(q.stderr).toContain('gate: no private list')
  })

  it('a docs-only push runs no suite; a protocol change runs the whole bridge suite', () => {
    const r = setup()
    r.install()
    r.change({ 'docs/a.md': 'more\n' })
    const docs = r.push()
    expect(docs.code, docs.err).toBe(0)
    expect(r.calls()).toEqual([TYPECHECK, LINT, SIZE])
    expect(docs.err).toContain('no test suite is touched')

    r.change({ 'packages/protocol/src/x.ts': 'y\n' })
    expect(r.push().code).toBe(0)
    expect(r.calls()).toEqual([
      TYPECHECK,
      LINT,
      SIZE,
      'pnpm exec vitest related --run packages/protocol/src/x.ts',
      'bun run scripts/test-parallel.ts',
    ])
  })

  // the PATH below keeps /usr/bin and /bin for git and the shell: a machine with a system bun there (Arch's package) cannot hide it
  it.skipIf(existsSync('/usr/bin/bun') || existsSync('/bin/bun'))(
    'bridge tests need bun: without it the push is refused, not waved through (skipped where bun is in /usr/bin or /bin)',
    () => {
      const r = setup()
      r.install()
      r.change({ 'apps/bridge/test/x.test.ts': 'y\n' })
      const PATH = `${join(r.T, 'bin')}:${dirname(process.execPath)}:/usr/bin:/bin`
      rmSync(join(r.T, 'bin', 'bun'))
      const p = r.push({ PATH })
      expect(p.code).not.toBe(0)
      expect(p.err).toContain('gate: REFUSED: no bun on PATH')
    },
  )

  it('a push it cannot place at all runs the full gate, it does not wave it through', () => {
    const r = setup()
    r.install()
    r.change({ 'apps/web/src/b.ts': 'y\n' })
    r.ok(r.clone, 'update-ref', '-d', 'refs/remotes/origin/main') // no origin/main to diff against
    expect(r.push().code).toBe(0)
    expect(r.calls()).toEqual([TYPECHECK, LINT, SIZE, 'pnpm exec vitest run', 'bun run scripts/test-parallel.ts'])
  })

  // the installer tests with a corepack pnpm first on PATH: a step of the plan for a change that plans root-install.test.ts, and a
  // Mac's (the stand-in script writes down that it ran; uname says which machine this is)
  const corepackPush = (os: string) => {
    const r = setup()
    r.install()
    r.stub(join(r.T, 'bin/uname'), `[ "$1" = -s ] && { echo ${os}; exit 0; }\nexec /usr/bin/uname "$@"`)
    r.change({
      'scripts/corepack-install-tests.sh': '#!/bin/sh\necho "corepack-install" >> "$CALLS"\n',
      'scripts/root-install.test.ts': 'x\n',
    })
    return { r, p: r.push() }
  }

  it('a change that plans the root installer test also runs it with a corepack pnpm first on PATH, on a Mac', () => {
    const { r, p } = corepackPush('Darwin')
    expect(p.code, p.err).toBe(0)
    expect(r.calls().at(-1)).toBe('corepack-install')
  })

  it('and off a Mac says it skipped that step, and does not need corepack', () => {
    const { r, p } = corepackPush('Linux')
    expect(p.code, p.err).toBe(0)
    expect(r.calls()).not.toContain('corepack-install')
    expect(p.err).toContain('skipped, they run on a Mac only')
  })

  it('a second push runs only the suites of what is new since the first', () => {
    const r = setup()
    r.install()
    r.change({ 'apps/web/src/b.ts': 'y\n' })
    expect(r.push().code).toBe(0)
    r.change({ 'apps/relay/src/r.ts': 'y\n' })
    expect(r.push().code).toBe(0)
    expect(r.calls().at(-1)).toBe('pnpm exec vitest related --run apps/relay/src/r.ts')
  })

  it("a push that only deletes a file still runs the type check, and that app's whole Vitest project", () => {
    const r = setup()
    r.install()
    r.change({}, ['apps/web/src/a.ts'])
    expect(r.push().code).toBe(0)
    expect(r.calls()).toEqual([TYPECHECK, LINT, SIZE, 'pnpm exec vitest run --project web'])
  })

  it("files on disk that aren't what is being pushed refuse the push", () => {
    const r = setup()
    r.install()
    r.change({ 'apps/web/src/b.ts': 'committed\n' })
    writeFileSync(join(r.clone, 'apps/web/src/b.ts'), 'edited, not committed\n')
    const p = r.push()
    expect(p.code).not.toBe(0)
    expect(p.err).toContain("REFUSED: the files on disk aren't what you are pushing")
    expect(r.calls()).toEqual([])
  })

  it('with a lockfile newer than node_modules it refuses and asks for an install instead of blaming the code', () => {
    const r = setup()
    r.install()
    writeFileSync(join(r.clone, 'node_modules/.modules.yaml'), '')
    const old = new Date('2020-01-01T00:00:00Z')
    utimesSync(join(r.clone, 'node_modules/.modules.yaml'), old, old)
    r.change({ 'pnpm-lock.yaml': 'y\n' })
    const p = r.push({ FAIL: 'pnpm' })
    expect(p.code).not.toBe(0)
    expect(p.err).toContain('run pnpm install')
    expect(r.calls()).toEqual([])
  })

  it('a lockfile only rewritten by a rebase (newer, same content as installed) is not refused', () => {
    const r = setup()
    r.install()
    writeFileSync(join(r.clone, 'node_modules/.modules.yaml'), '')
    const old = new Date('2020-01-01T00:00:00Z')
    utimesSync(join(r.clone, 'node_modules/.modules.yaml'), old, old)
    mkdirSync(join(r.clone, 'node_modules/.pnpm'), { recursive: true })
    writeFileSync(join(r.clone, 'node_modules/.pnpm/lock.yaml'), 'y\n') // what pnpm installed from
    r.change({ 'pnpm-lock.yaml': 'y\n' })
    const p = r.push()
    expect(p.err).not.toContain('pnpm-lock.yaml is newer than node_modules')
  })

  it('with no node_modules it refuses: a gate that cannot run is not a pass', () => {
    const r = setup()
    r.install()
    r.change({ 'apps/web/src/b.ts': 'y\n' })
    rmSync(join(r.clone, 'node_modules'), { recursive: true })
    const p = r.push()
    expect(p.code).not.toBe(0)
    expect(p.err).toContain('gate: REFUSED: no node_modules here: run pnpm install')
  })

  it('Ctrl-C stops the gate and leaves no temp file', async () => {
    const r = setup()
    r.install()
    r.change({ 'apps/web/src/b.ts': 'y\n' })
    r.stub(join(r.T, 'bin', 'pnpm'), 'echo "$$" > "$CALLS.pid"; exec sleep 60')
    const tmp = join(r.T, 'tmp')
    mkdirSync(tmp)
    const lsha = r.ok(r.clone, 'rev-parse', 'HEAD')
    // its own process group, as a terminal's Ctrl-C reaches the hook and what it runs
    const hook = spawn('bash', ['scripts/pre-push.sh'], {
      cwd: r.clone,
      env: { ...r.env, TMPDIR: tmp },
      detached: true,
    })
    hook.stdin.end(`refs/heads/feat ${lsha} refs/heads/feat ${'0'.repeat(40)}\n`)
    const code = new Promise<number | null>((res) => hook.on('exit', (c) => res(c)))
    const pidFile = `${r.env.CALLS}.pid`
    await vi.waitUntil(() => existsSync(pidFile) && readFileSync(pidFile, 'utf8').trim() !== '', {
      timeout: 30_000,
      interval: 25,
    })
    const pid = readFileSync(pidFile, 'utf8').trim()
    process.kill(-(hook.pid as number), 'SIGINT')
    expect(await code).toBe(130)
    await vi.waitUntil(() => spawnSync('kill', ['-0', pid]).status !== 0, { timeout: 10_000, interval: 25 })
    expect(readdirSync(tmp)).toEqual([])
  })

  it('deleting a branch checks nothing', () => {
    const r = setup()
    r.install()
    r.change({ 'apps/web/src/b.ts': 'y\n' })
    expect(r.push().code).toBe(0)
    expect(r.push({ FAIL: 'biome' }, '--delete', 'feat').code).toBe(0)
    expect(r.calls()).toEqual([])
  })
})

describe('pre-push hook: a plain `git push` gates with the fast gate, as gate.sh --push does', () => {
  // a value the generic list flags, built at run time so this file holds nothing the scan would flag
  const HIT = ['/Us', 'ers/', 'jordan'].join('')
  /** setup() with the fast gate's files on main already (a change to them is itself a gate input), the hook installed, and
   * a bun stand-in that also writes down the list of bridge test files it was handed. */
  const fastSetup = () => {
    const r = setup()
    r.change({
      'scripts/gate-fast.sh': readFileSync(join(here, 'gate-fast.sh'), 'utf8'),
      'scripts/gate-fast-keepout.txt': readFileSync(join(here, 'gate-fast-keepout.txt'), 'utf8'),
      'scripts/gate-inputs.txt': readFileSync(join(here, 'gate-inputs.txt'), 'utf8'),
      'docs/protected-paths.txt': 'apps/bridge/src/keys.ts\n',
      'apps/bridge/src/x.ts': 'export const x = 1\n',
      'apps/bridge/test/x.test.ts': "import { x } from '../src/x.ts'\n",
    })
    r.ok(r.clone, 'push', '-q', 'origin', 'HEAD:main') // before the install: no hook
    r.install()
    r.stub(
      join(r.T, 'bin', 'bun'),
      'case "$1" in --version) echo 1.4.4; exit 0 ;; -e) echo 3.45.0; exit 0 ;; esac; echo "bun $*" >> "$CALLS"; for a in "$@"; do [ -f "$a" ] && cat "$a" >> "$CALLS"; done; exit 0',
    )
    return r
  }

  it('a change on the fast gate runs it and says so; GATE_FULL=1 (the hook takes no flags) runs the full gate', () => {
    const r = fastSetup()
    r.change({ 'apps/bridge/src/x.ts': 'export const x = 2\n' })
    const fast = r.push()
    expect(fast.code, fast.err).toBe(0)
    expect(fast.err).toContain('pre-push: the fast gate where this change allows it (GATE_FULL=1 for the full gate)')
    expect(fast.err).toContain('gate: fast gate:')
    expect(fast.err).toContain('gate: personal (this change only')
    expect(r.calls().some((c) => c.startsWith('bun run scripts/test-parallel.ts --jobs 2 --files '))).toBe(true)
    expect(r.calls()).toContain('test/x.test.ts') // the list it was handed, relative to apps/bridge
    r.change({ 'apps/bridge/src/x.ts': 'export const x = 3\n' })
    const full = r.push({ GATE_FULL: '1' })
    expect(full.code, full.err).toBe(0)
    expect(full.err).toContain('pre-push: the full gate (GATE_FULL=1)')
    expect(full.err).not.toContain('gate: fast gate')
    expect(full.err).toContain('gate: tests (the whole bridge suite)')
    expect(r.calls()).toContain('bun run scripts/test-parallel.ts')
  })

  it('the same fallback rules as gate.sh --fast: a gate input, or a keep-out path, runs the full gate and says why', () => {
    for (const [file, why] of [
      ['scripts/new-tool.sh', 'scripts/new-tool.sh is a gate input'],
      ['packages/protocol/src/x.ts', 'packages/protocol/src/x.ts is on the keep-out list'],
    ]) {
      const r = fastSetup()
      r.change({ [file]: 'y\n' })
      const p = r.push()
      expect(p.code, p.err).toBe(0)
      expect(p.err).toContain(`gate: full gate, not the fast one: ${why}`)
      expect(p.err).not.toContain('gate: fast gate:')
    }
  })

  it('a push of scripts/*.test.ts only is fast, though scripts/ is a gate input', () => {
    const r = fastSetup()
    r.change({ 'scripts/x.test.ts': 'export {}\n' })
    const p = r.push()
    expect(p.code, p.err).toBe(0)
    expect(p.err).toContain('gate: fast gate:')
    expect(p.err).not.toContain('full gate, not the fast one')
    expect(r.calls()).toContain('pnpm exec vitest related --run scripts/x.test.ts')
  })

  it("the range is the one git hands the hook: the remote's old tip to the pushed tip", () => {
    const r = fastSetup()
    r.change({ 'docs/a.md': `old ${HIT}/x\n` })
    expect(r.push({}, '--no-verify', 'HEAD:refs/heads/feat').code).toBe(0) // an old hit already on the remote branch, the owner's own override
    r.change({ 'docs/b.md': 'clean\n' })
    const p = r.push()
    expect(p.code, p.err).toBe(0) // only the new commit is scanned, by the hook and by the fast gate
    expect(p.err).toContain('gate: personal (this change only')
    r.change({ 'docs/c.md': 'clean\n' })
    const full = r.push({ GATE_FULL: '1' })
    expect(full.code).not.toBe(0) // the full gate scans the tree, old hit and all
    expect(full.err).toContain('gate: REFUSED: personal failed')
  })

  it('a new branch is measured from its merge base with origin/main: every commit on it counts', () => {
    const r = fastSetup()
    r.change({ 'apps/bridge/src/x.ts': 'export const x = 4\n' })
    r.change({ 'docs/a.md': 'more\n' })
    const p = r.push({}, 'HEAD:refs/heads/brand-new')
    expect(p.code, p.err).toBe(0)
    expect(p.err).toContain('gate: fast gate:')
    expect(r.calls()).toContain('test/x.test.ts') // the first commit's file, two commits back
  })

  it('a hit in a commit of the push still stops a fast push', () => {
    const r = fastSetup()
    r.change({ 'docs/a.md': `write to ${HIT}/x\n` })
    const p = r.push()
    expect(p.code).not.toBe(0)
    expect(p.err).toContain('docs/a.md:1')
  })
})

describe('install-hooks', () => {
  it('leaves CI, a checkout that opted out and a hooksPath someone set alone', () => {
    const hooksPath = (r: ReturnType<typeof setup>) => r.git(r.clone, 'config', '--get', 'core.hooksPath').stdout.trim()
    const r = setup()
    r.install({ TALOS_CI_NESTED: '1' })
    expect(hooksPath(r)).toBe('')
    r.install({ TALOS_NO_HOOKS: '1' })
    expect(hooksPath(r)).toBe('')
    r.ok(r.clone, 'config', 'core.hooksPath', 'mine')
    r.install()
    expect(hooksPath(r)).toBe('mine')
  })

  it('stays off for good with git config talos.nohooks, across later installs', () => {
    const r = setup()
    r.ok(r.clone, 'config', 'talos.nohooks', 'true')
    r.install()
    expect(r.git(r.clone, 'config', '--get', 'core.hooksPath').stdout.trim()).toBe('')
  })

  it('a copy unpacked inside another repo leaves that repo alone', () => {
    const r = setup()
    const outer = join(r.T, 'dotfiles')
    mkdirSync(join(outer, 'talos/scripts'), { recursive: true })
    r.ok(outer, 'init', '-q')
    cpSync(join(here, 'install-hooks.sh'), join(outer, 'talos/scripts/install-hooks.sh'))
    const i = spawnSync('bash', ['scripts/install-hooks.sh'], {
      cwd: join(outer, 'talos'),
      env: r.env,
      encoding: 'utf8',
    })
    expect(i.status).toBe(0)
    expect(r.git(outer, 'config', '--get', 'core.hooksPath').stdout.trim()).toBe('')
  })

  it('is quiet outside a git checkout: a Docker build has no .git and no scripts/', () => {
    const d = mkdtempSync(join(tmpdir(), 'pp-'))
    dirs.push(d)
    const r = spawnSync('bash', [join(here, 'install-hooks.sh')], {
      cwd: d,
      env: { ...process.env, TALOS_CI_NESTED: '0', TALOS_NO_HOOKS: '0' },
      encoding: 'utf8',
    })
    expect(r.status).toBe(0)
    expect(r.stdout).toBe('')
    const pkg = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8')) as { scripts: { prepare: string } }
    expect(spawnSync('sh', ['-c', pkg.scripts.prepare], { cwd: d }).status).toBe(0)
  })
})

// The "Verified:" trailer check (scripts/verified-trailer.sh), as pre-push.sh runs it. Observe is the default and never refuses.
describe('pre-push hook: the Verified: trailer', () => {
  const commit = (r: ReturnType<typeof setup>, msg: string, n: string) => {
    mkdirSync(join(r.clone, 'docs'), { recursive: true })
    writeFileSync(join(r.clone, 'docs', `${n}.md`), `${n}\n`)
    r.ok(r.clone, 'add', '-A')
    r.ok(r.clone, 'commit', '-qm', msg)
  }
  const logOf = (r: ReturnType<typeof setup>) => {
    const f = join(
      r.ok(r.clone, 'rev-parse', '--git-common-dir').replace(/^(?!\/)/, `${r.clone}/`),
      'talos-verified-trailer.log',
    )
    return existsSync(f) ? readFileSync(f, 'utf8') : ''
  }

  it('observe (the default): a commit with no trailer is logged and said on stderr, and the push goes through', () => {
    const r = setup()
    r.install()
    commit(r, 'plain change', 'a')
    const p = r.push()
    expect(p.code, p.err).toBe(0)
    expect(p.err).toContain('verified-trailer: commit')
    expect(p.err).toContain('has no Verified: trailer (plain change)')
    expect(logOf(r)).toMatch(/has no Verified: trailer \(plain change\)/)
    expect(r.ok(r.origin, 'rev-parse', 'feat')).toBe(r.ok(r.clone, 'rev-parse', 'HEAD')) // it got there
  })

  it('a real trailer and "none - reason" (hyphen or em dash) pass without a line; a bare "none" is logged', () => {
    const r = setup()
    r.install()
    commit(r, 'one\n\nVerified: web fake mode, themes all; evidence <root>/abc1234/', 'a')
    commit(r, 'two\n\nVerified: none \u2014 docs only, nothing to drive', 'b')
    commit(r, 'three\n\nVerified: none - a rename the compiler checks', 'c')
    const ok = r.push()
    expect(ok.code, ok.err).toBe(0)
    expect(ok.err).not.toContain('verified-trailer:')
    commit(r, 'four\n\nVerified: none', 'd')
    const bare = r.push()
    expect(bare.code, bare.err).toBe(0)
    expect(bare.err).toContain('unusable Verified: trailer "none"')
  })

  it('off says nothing; the setting also reads from git config', () => {
    const r = setup()
    r.install()
    commit(r, 'plain', 'a')
    const off = r.push({ TALOS_VERIFIED_TRAILER: 'off' })
    expect(off.code, off.err).toBe(0)
    expect(off.err).not.toContain('verified-trailer:')
    r.ok(r.clone, 'config', 'talos.verifiedTrailer', 'off')
    commit(r, 'plain 2', 'b')
    expect(r.push().err).not.toContain('verified-trailer:')
  })

  it('observe cannot fail the push: not when the script is gone, not on an unknown mode', () => {
    const r = setup()
    r.install()
    commit(r, 'plain', 'a')
    rmSync(join(r.clone, 'scripts/verified-trailer.sh'))
    r.ok(r.clone, 'add', '-A')
    r.ok(r.clone, 'commit', '-qm', 'drop the check')
    const gone = r.push()
    expect(gone.code, gone.err).toBe(0)
    expect(gone.err).toContain('verified-trailer.sh is missing')
    const bad = r.push({ TALOS_VERIFIED_TRAILER: 'banana' })
    expect(bad.code, bad.err).toBe(0)
    // ...but enforce with the script gone is a refusal: a check that cannot run does not pass
    commit(r, 'again', 'b')
    expect(r.push({ TALOS_VERIFIED_TRAILER: 'enforce' }).code).not.toBe(0)
  })

  it('enforce (written, not switched on) refuses a commit without it, and lets a verified one through', () => {
    const r = setup()
    r.install()
    commit(r, 'plain', 'a')
    const refused = r.push({ TALOS_VERIFIED_TRAILER: 'enforce' })
    expect(refused.code).not.toBe(0)
    expect(refused.err).toContain('REFUSED')
    expect(r.git(r.origin, 'rev-parse', '--verify', '-q', 'feat').status).not.toBe(0) // nothing arrived
    r.ok(r.clone, 'commit', '--amend', '-qm', 'plain\n\nVerified: none - test fixture')
    const passed = r.push({ TALOS_VERIFIED_TRAILER: 'enforce' })
    expect(passed.code, passed.err).toBe(0)
    expect(r.ok(r.origin, 'rev-parse', 'feat')).toBe(r.ok(r.clone, 'rev-parse', 'HEAD'))
  })
})
