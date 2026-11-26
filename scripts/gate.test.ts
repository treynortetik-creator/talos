// scripts/gate.sh, the one gate every push goes through. The pre-push tests run it for real behind the hook; this one checks
// what it picks to run (`--plan`, which runs nothing) from the changed paths, in a temp repo, and that it refuses when it has
// nothing to measure the change against.
import { spawnSync } from 'node:child_process'
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, describe, expect, it, vi } from 'vitest'
import { t as scaled } from '../packages/testkit/src/time-factor.ts'
import { gateTestEnv } from './gate-test-env'

const here = dirname(fileURLToPath(import.meta.url))
vi.setConfig({ testTimeout: scaled(30_000), hookTimeout: scaled(30_000) })
const dirs: string[] = []
afterAll(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

// nothing from a gate this may run inside (gate-test-env.ts): every spawn below starts from this one
const env = gateTestEnv({
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_SYSTEM: '/dev/null',
  GIT_AUTHOR_NAME: 't',
  GIT_AUTHOR_EMAIL: 't@example.com',
  GIT_COMMITTER_NAME: 't',
  GIT_COMMITTER_EMAIL: 't@example.com',
})

function repo() {
  const T = mkdtempSync(join(tmpdir(), 'gate-'))
  dirs.push(T)
  const git = (...a: string[]) => {
    const r = spawnSync('git', a, { cwd: T, env, encoding: 'utf8' })
    if (r.status !== 0) throw new Error(`git ${a.join(' ')}: ${r.stderr}`)
    return r.stdout.trim()
  }
  const put = (f: string, t = 'x\n') => {
    mkdirSync(dirname(join(T, f)), { recursive: true })
    writeFileSync(join(T, f), t)
  }
  git('init', '-q', '-b', 'main')
  mkdirSync(join(T, 'scripts'))
  cpSync(join(here, 'gate.sh'), join(T, 'scripts/gate.sh'))
  cpSync(join(here, 'gate'), join(T, 'scripts/gate'), { recursive: true })
  cpSync(join(here, 'talos-machine.sh'), join(T, 'scripts/talos-machine.sh'))
  put('docs/a.md')
  put('e2e/playwright.config.ts', 'export default {}\n') // the e2e package: --full runs it
  put('apps/web/playwright.config.ts', 'export default {}\n') // the web app's browser specs: --full runs them
  put('apps/web/src/a.ts')
  put('apps/bridge/src/notify.ts')
  put('apps/bridge/test/notify.test.ts', "import { x } from '../src/notify.ts'\n")
  put('apps/bridge/test/other.test.ts', "import { y } from '../src/other.ts'\n")
  put('scripts/thing.sh')
  put('scripts/old-client.sh') // the old-client step is there to run (it runs only when this file and e2e/ exist)
  put('scripts/thing.test.ts', "const script = 'scripts/thing.sh'\n")
  git('add', '-A')
  git('commit', '-qm', 'base')
  const base = git('rev-parse', 'HEAD')
  const commit = (files: Record<string, string>) => {
    for (const [f, t] of Object.entries(files)) put(f, t)
    git('add', '-A')
    git('commit', '-qm', 'change')
  }
  const gate = (...a: string[]) => spawnSync('bash', ['scripts/gate.sh', ...a], { cwd: T, env, encoding: 'utf8' })
  const plan = (...a: string[]) => {
    const r = gate('--plan', '--base', base, ...a)
    expect(r.status, r.stderr).toBe(0)
    return r.stdout.trim().split('\n')
  }
  return { T, git, put, commit, gate, plan, base }
}

const CHECKS = ['typecheck', 'lint', 'personal', 'size', 'timing']

describe('gate.sh picks the suites from the changed paths', () => {
  it('every gate runs the four checks; a docs-only change runs no suite', () => {
    const r = repo()
    expect(r.plan()).toEqual(CHECKS)
    r.commit({ 'docs/a.md': 'more\n' })
    expect(r.plan()).toEqual(CHECKS)
  })

  it('a module in a Vitest project goes to vitest related, one path per line, spaces and all', () => {
    const r = repo()
    r.commit({ 'apps/web/src/b.ts': 'y\n', 'apps/web/src/with space.ts': 'y\n' })
    expect(r.plan()).toEqual([...CHECKS, 'vitest', '\tapps/web/src/b.ts', '\tapps/web/src/with space.ts'])
  })

  it('anything under apps/bridge/ but a changed test file runs the whole bridge suite: its tests reach a file through others', () => {
    for (const f of [
      'apps/bridge/src/notify.ts', // imported by name by one test
      'apps/bridge/src/adopt.ts', // imported by name by none (it is reached through other modules)
      'apps/bridge/test/helpers/harness.ts', // a test helper
      'apps/bridge/src/data/table.json',
    ]) {
      const r = repo()
      r.commit({ [f]: 'changed\n' })
      expect(r.plan(), f).toEqual([...CHECKS, 'bun-all'])
    }
  })

  it('a deleted bridge file, or a deleted bridge test, runs the whole bridge suite', () => {
    for (const f of ['apps/bridge/src/notify.ts', 'apps/bridge/test/other.test.ts']) {
      const r = repo()
      r.git('rm', '-q', f)
      r.git('commit', '-qm', 'rm')
      expect(r.plan(), f).toEqual([...CHECKS, 'bun-all'])
    }
  })

  it('a fixture the bridge tests read (the Mac app fixtures, examples, the protocol fixtures) runs the whole bridge suite', () => {
    for (const f of [
      'apps/desktop/Tests/Fixtures/config/config.json',
      'examples/config.default.json',
      'packages/protocol/fixtures/frame.json',
    ]) {
      const r = repo()
      r.commit({ [f]: 'changed\n' })
      expect(r.plan(), f).toEqual([...CHECKS, 'bun-all'])
    }
  })

  it('what else the bridge tests read outside apps/bridge runs the whole bridge suite too, a deletion included', () => {
    for (const f of [
      'plugins/talos-app-mod/hooks/lib/x.ts',
      'packages/testkit/fixtures/a.json',
      'packages/protocol/test/support/h.ts',
      'apps/desktop/Resources/tmux.conf',
      'apps/desktop/Sources/TalosSupervisor/X.swift',
      'third_party/chronos/cli.ts',
      'docs/SETUP.md',
    ]) {
      const r = repo()
      r.commit({ [f]: 'changed\n' })
      expect(r.plan(), f).toContain('bun-all')
    }
    const del = repo()
    del.commit({ 'examples/a.json': 'x\n', 'packages/protocol/src/p.ts': 'x\n' })
    const base = del.git('rev-parse', 'HEAD')
    del.git('rm', '-q', 'examples/a.json', 'packages/protocol/src/p.ts')
    del.git('commit', '-qm', 'rm')
    const p = del.gate('--plan', '--base', base)
    expect(p.stdout.trim().split('\n')).toEqual([...CHECKS, 'bun-all'])
  })

  it('a nested bridge test runs itself; deleted, it runs the whole suite; a deleted pairing file still runs the pairing specs', () => {
    const r = repo()
    r.commit({ 'apps/bridge/test/sub/x.test.ts': 'x\n', 'apps/bridge/src/enroll-cli.ts': 'x\n' })
    const base = r.git('rev-parse', 'HEAD')
    r.commit({ 'apps/bridge/test/sub/x.test.ts': 'changed\n' })
    const one = r.gate('--plan', '--base', base)
    expect(one.stdout.trim().split('\n')).toEqual([...CHECKS, 'bun', '\tapps/bridge/test/sub/x.test.ts'])
    const base2 = r.git('rev-parse', 'HEAD')
    r.git('rm', '-q', 'apps/bridge/test/sub/x.test.ts', 'apps/bridge/src/enroll-cli.ts')
    r.git('commit', '-qm', 'rm')
    const gone = r.gate('--plan', '--base', base2).stdout.trim().split('\n')
    expect(gone).toContain('bun-all')
    expect(gone).toContain('\ttests/01-enroll.spec.ts')
  })

  it('a changed bridge test runs itself only', () => {
    const r = repo()
    r.commit({ 'apps/bridge/test/other.test.ts': 'changed\n' })
    expect(r.plan()).toEqual([...CHECKS, 'bun', '\tapps/bridge/test/other.test.ts'])
  })

  it('on 4 cores or fewer, a whole bridge suite says how long it takes there and how to hand off', () => {
    const r = repo()
    r.commit({ 'apps/bridge/src/notify.ts': 'changed\n' })
    const at = (cores: string, extra: Record<string, string> = {}, ...a: string[]) =>
      spawnSync('bash', ['scripts/gate.sh', '--plan', '--base', r.base, ...a], {
        cwd: r.T,
        env: { ...env, TALOS_MACHINE: 'hestia', GATE_CORES: cores, ...extra },
        encoding: 'utf8',
      }).stderr
    expect(at('2')).toContain('the whole bridge suite runs for this change: about 30 minutes or more on 2 cores')
    expect(at('2')).toContain(
      'git push origin HEAD:refs/heads/handoff/hestia/<name>, then a machine with the private list runs scripts/gate.sh --push --from origin/handoff/hestia/<name>',
    )
    expect(at('4')).toContain('about 15 minutes or more on 4 cores')
    for (const quiet of [at('8'), at('0'), at('abc'), at('-3'), at('2', { GATE_LANDING_HANDOFF: '1' })])
      expect(quiet).not.toContain('the whole bridge suite runs')
    const words = repo()
    words.commit({ 'docs/a.md': 'changed\n' })
    const w = spawnSync('bash', ['scripts/gate.sh', '--plan', '--base', words.base], {
      cwd: words.T,
      env: { ...env, GATE_CORES: '2' },
      encoding: 'utf8',
    })
    expect(w.stderr).not.toContain('the whole bridge suite runs') // no bridge suite planned
  })

  it('the handoff hint names the branch after TALOS_MACHINE only, a fleet name; never the host name', () => {
    const r = repo()
    r.commit({ 'apps/bridge/src/notify.ts': 'changed\n' })
    const hint = (machine: string) =>
      spawnSync('bash', ['scripts/gate.sh', '--plan', '--base', r.base], {
        cwd: r.T,
        env: { ...env, TALOS_MACHINE: machine, GATE_CORES: '2' },
        encoding: 'utf8',
      }).stderr
    expect(hint('cyclops')).toContain('refs/heads/handoff/cyclops/<name>')
    for (const bad of ['', 'Someones-Air', 'cyclops lemnos', 'Cyclops']) {
      const out = hint(bad)
      expect(out, bad).not.toContain('refs/heads/handoff/')
      expect(out, bad).toContain('set TALOS_MACHINE to this machine')
    }
    expect(hint('Someones-Air')).not.toContain('Someones-Air') // the value (maybe a host name) is never repeated
  })

  it('the time factor counts performance cores where the machine has them (an 8-core M1 Air has 4)', () => {
    const r = repo()
    const bin = join(r.T, 'fakebin')
    mkdirSync(bin)
    const factor = (sysctl: string | null, all = 8) => {
      const s = join(bin, 'sysctl')
      if (sysctl === null)
        writeFileSync(s, '#!/bin/sh\nexit 1\n') // no performance levels (Linux, an Intel Mac)
      else writeFileSync(s, `#!/bin/sh\n[ "$2" = hw.perflevel0.physicalcpu ] && echo ${sysctl} && exit 0\nexit 1\n`)
      chmodSync(s, 0o755)
      const n = join(bin, 'nproc')
      writeFileSync(n, `#!/bin/sh\necho ${all}\n`)
      chmodSync(n, 0o755)
      const e: Record<string, string | undefined> = { ...env, PATH: `${bin}:${env.PATH}` }
      delete e.GATE_CORES
      delete e.TALOS_TEST_TIME_FACTOR
      const out = spawnSync('bash', ['scripts/gate.sh', '--plan', '--base', r.base], {
        cwd: r.T,
        env: e,
        encoding: 'utf8',
      })
      return /time factor: (\d+)/.exec(out.stderr)?.[1]
    }
    expect(factor('4')).toBe('3') // 4 performance cores: the small-machine factor
    expect(factor('4', 10)).toBe('1') // a base M5: 4 performance cores beside 6 efficiency ones, 10 in all: a fast machine
    expect(factor('12')).toBe('1') // a big Mac keeps factor 1
    expect(factor(null)).toBe('1') // no performance levels: nproc's 8
  })

  it('the gate runs from a sub-folder too (its scripts are named from the top)', () => {
    const r = repo()
    r.commit({ 'apps/bridge/src/notify.ts': 'changed\n' })
    const out = spawnSync('bash', ['../../scripts/gate.sh', '--plan', '--base', r.base], {
      cwd: join(r.T, 'apps/bridge'),
      env: { ...env, TALOS_MACHINE: '', GATE_CORES: '2' },
      encoding: 'utf8',
    })
    expect(out.stderr).not.toContain('No such file')
    expect(out.stderr).toContain('set TALOS_MACHINE to this machine')
    expect(out.status).toBe(0)
  })

  it('Node: the .nvmrc major is used from Homebrew or nvm when the one on PATH differs; else one line says what to install', () => {
    const r = repo()
    r.put('.nvmrc', '999\n')
    const real = spawnSync('bash', ['-c', 'command -v node'], { env, encoding: 'utf8' }).stdout.trim()
    const run = (nvm?: string) => {
      const e: Record<string, string | undefined> = { ...env, NVM_DIR: nvm ?? join(r.T, 'no-nvm') }
      return spawnSync('bash', ['scripts/gate.sh', '--checks-only', '--base', r.base], {
        cwd: r.T,
        env: e,
        encoding: 'utf8',
      }).stderr
    }
    // none installed: refused, saying what to install
    expect(run()).toContain('this repo runs on Node 999 (.nvmrc)')
    expect(run()).toContain('brew install node@999, or nvm install 999')
    // an nvm Node 999 (a wrapper that reports 999 and is otherwise the real node): used for the run
    const dir = join(r.T, 'nvm', 'versions', 'node', 'v999.1.0', 'bin')
    mkdirSync(dir, { recursive: true })
    writeFileSync(
      join(dir, 'node'),
      `#!/bin/sh\ncase "$*" in *process.versions.node*) echo 999; exit 0 ;; esac\nexec ${real} "$@"\n`,
    )
    chmodSync(join(dir, 'node'), 0o755)
    const ok = run(join(r.T, 'nvm'))
    expect(ok).toContain(`using Node 999 from ${dir} for this run (.nvmrc)`)
    expect(ok).not.toContain('this repo runs on Node 999')
  })

  it('test-delta: the checks print one line with the tests the change adds, and a broken counter never fails the gate', () => {
    const r = repo()
    r.put('node_modules/.bin/biome', '#!/bin/sh\nexit 0\n')
    chmodSync(join(r.T, 'node_modules/.bin/biome'), 0o755)
    const bin = join(r.T, 'bin')
    mkdirSync(bin)
    writeFileSync(join(bin, 'pnpm'), '#!/bin/sh\nexit 0\n', { mode: 0o755 }) // the other steps are stand-ins
    for (const f of ['test-delta.ts', 'timing-lint.ts', 'check-no-personal.sh', 'denylist.generic.txt'])
      cpSync(join(here, f), join(r.T, 'scripts', f))
    r.put('.gitignore', 'node_modules\nbin\n')
    r.commit({ 'apps/bridge/test/a.test.ts': "it('one', () => {})\nit('two', () => {})\n" })
    const run = () =>
      spawnSync('bash', ['scripts/gate.sh', '--checks-only', '--base', r.base], {
        cwd: r.T,
        env: { ...env, PATH: `${bin}:${process.env.PATH}` },
        encoding: 'utf8',
      })
    const ok = run()
    expect(ok.stderr).toContain('gate: test-delta: net +2 (added 2, removed 0): unit +2 -0')
    expect(ok.status, ok.stderr).toBe(0)
    writeFileSync(join(r.T, 'scripts/test-delta.ts'), 'throw new Error("broken")\n')
    const broken = run()
    expect(broken.stderr).not.toContain('test-delta:')
    expect(broken.status, broken.stderr).toBe(0)
  })

  it("a gate run sweeps its $TMPDIR's old test folders once, first (tmp-sweep.sh); --plan touches nothing", () => {
    const r = repo()
    for (const f of ['tmp-sweep.sh', 'tmp-sweep-prefixes.txt']) cpSync(join(here, f), join(r.T, 'scripts', f))
    const tmp = join(r.T, 'tmp')
    const old = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000)
    for (const n of ['talos-bridge-test-aaaaaa', 'other-aaaaaa']) {
      mkdirSync(join(tmp, n), { recursive: true })
      utimesSync(join(tmp, n), old, old)
    }
    const run = (...a: string[]) =>
      spawnSync('bash', ['scripts/gate.sh', ...a, '--base', r.base], {
        cwd: r.T,
        env: { ...env, TMPDIR: tmp },
        encoding: 'utf8',
      })
    run('--plan')
    run('--in-heavy-lock') // the suites' second pass: the run outside it swept already
    expect(readdirSync(tmp).sort()).toEqual(['other-aaaaaa', 'talos-bridge-test-aaaaaa'])
    expect(run('--checks-only').stderr).toContain('gate: removed 1 test folders older than a day from')
    expect(readdirSync(tmp)).toEqual(['other-aaaaaa'])
  })

  it('a protocol or testkit change runs the whole bridge suite, which imports them everywhere', () => {
    const r = repo()
    r.commit({ 'packages/testkit/src/clock.ts': 'y\n' })
    expect(r.plan()).toEqual([...CHECKS, 'vitest', '\tpackages/testkit/src/clock.ts', 'bun-all'])
  })

  it('a shell script runs the tests that name it', () => {
    const r = repo()
    r.commit({ 'scripts/thing.sh': 'y\n' })
    expect(r.plan()).toEqual([...CHECKS, 'vitest', '\tscripts/thing.test.ts'])
  })

  it('a kit/ change, or a script, runs the tests that list its folder (found by grep, not by a list), and no others', () => {
    const r = repo()
    // a test that reads kit/scripts by listing it, one that hashes kit/ as a tree, and one that names kit/ only in passing
    r.put('scripts/kit-scan.test.ts', "const all = readdirSync(join(ROOT, 'kit/scripts'))\n")
    r.put('scripts/kit-tree.test.ts', "git(['ls-tree', '-r', 'HEAD', '--', 'kit'])\n")
    r.commit({ 'scripts/other.test.ts': "const p = join(ROOT, 'kit/SOURCE')\n" })
    const tests = r.git('rev-parse', 'HEAD') // the change is measured from here: the tests are not part of it
    r.commit({ 'kit/scripts/install.sh': 'y\n' })
    expect(r.plan('--base', tests)).toEqual([
      ...CHECKS,
      'vitest',
      '\tscripts/kit-scan.test.ts',
      '\tscripts/kit-tree.test.ts',
      'bun-all', // the bridge tests read kit/ too
    ])
    r.commit({ 'kit/agents/reviewer.md': 'z\n' }) // not code, still read by the tree test
    expect(r.plan('--base', r.git('rev-parse', 'HEAD~1'))).toEqual([
      ...CHECKS,
      'vitest',
      '\tscripts/kit-tree.test.ts',
      'bun-all',
    ])
  })

  it('an apps/windows script: a test that lists a top-level folder like apps is not pulled in; one for its own folder is', () => {
    const r = repo()
    // a bridge test that lists files and names 'apps' (to build a path), and one that lists apps/windows/distro itself
    r.put('apps/bridge/test/tools.test.ts', "const all = readdirSync(join(ROOT, 'apps'))\n")
    r.put('scripts/distro-scan.test.ts', "for (const f of readdirSync(join(ROOT, 'apps/windows/distro'))) check(f)\n")
    r.put('scripts/windows-scan.test.ts', "git(['ls-files', '--', 'apps/windows'])\n")
    r.git('add', '-A')
    r.git('commit', '-qm', 'tests')
    const tests = r.git('rev-parse', 'HEAD')
    r.commit({ 'apps/windows/distro/talos-wsl.sh': 'y\n' })
    const p = spawnSync('bash', ['scripts/gate.sh', '--plan', '--base', tests], { cwd: r.T, env, encoding: 'utf8' })
    expect(p.stdout.trim().split('\n')).toEqual([
      ...CHECKS,
      'vitest',
      '\tscripts/distro-scan.test.ts',
      '\tscripts/windows-scan.test.ts',
    ])
    // --plan says which folder each was picked for
    expect(p.stderr).toContain('scripts/distro-scan.test.ts <- apps/windows/distro')
    expect(p.stderr).toContain('scripts/windows-scan.test.ts <- apps/windows')
    expect(p.stderr).not.toContain('apps/bridge/test/tools.test.ts')
  })

  it('a test file that matches a `// gate-reads:` line runs that guard, a deleted one too; * takes / as well', () => {
    const r = repo()
    r.put('scripts/scan.test.ts', "// gate-reads: apps/web/test/*.test.ts *.spec.ts\nconst all = walk('test')\n")
    r.commit({ 'scripts/other.test.ts': "const s = '// gate-reads: apps/relay/*'\n" }) // only a line of its own counts
    const tests = r.git('rev-parse', 'HEAD')
    r.commit({ 'apps/web/test/deep/a.test.ts': 'x\n', 'apps/relay/test/b.test.ts': 'x\n' })
    const p = spawnSync('bash', ['scripts/gate.sh', '--plan', '--base', tests], { cwd: r.T, env, encoding: 'utf8' })
    expect(p.stdout.trim().split('\n')).toEqual([
      ...CHECKS,
      'vitest',
      '\tapps/relay/test/b.test.ts',
      '\tapps/web/test/deep/a.test.ts',
      '\tscripts/scan.test.ts',
    ])
    expect(p.stderr).toContain('scripts/scan.test.ts <- apps/web/test/deep/a.test.ts (reads it)')
    const before = r.git('rev-parse', 'HEAD')
    r.git('rm', '-q', 'apps/web/test/deep/a.test.ts')
    r.git('commit', '-qm', 'rm')
    expect(r.plan('--base', before)).toEqual([...CHECKS, 'vitest', '\tscripts/scan.test.ts', 'vitest-project', '\tweb'])
  })

  it('a changed or deleted test file runs the tests that open it by name: a doc test cites the titles of relay tests (bc69061a)', () => {
    const r = repo()
    r.put('apps/relay/test/auth/pair-fixture.test.ts', "it('minted', () => {})\n")
    r.put(
      'scripts/security-doc.test.ts',
      "const relayTest = (n: string) => read(join(root, 'apps/relay/test/auth', n))\nrelayTest('pair-fixture.test.ts')\n",
    )
    r.put('scripts/other-doc.test.ts', "relayTest('another.test.ts')\n") // names a different test
    r.git('add', '-A')
    r.git('commit', '-qm', 'tests')
    const tests = r.git('rev-parse', 'HEAD')
    r.commit({ 'apps/relay/test/auth/pair-fixture.test.ts': "it('minted, renamed', () => {})\n" })
    const p = spawnSync('bash', ['scripts/gate.sh', '--plan', '--base', tests], { cwd: r.T, env, encoding: 'utf8' })
    expect(p.stdout.trim().split('\n')).toEqual([
      ...CHECKS,
      'vitest',
      '\tapps/relay/test/auth/pair-fixture.test.ts',
      '\tscripts/security-doc.test.ts',
    ])
    expect(p.stderr).toContain('scripts/security-doc.test.ts <- apps/relay/test/auth/pair-fixture.test.ts (names it)')
    // a deleted test: the doc test still cites it, so it runs (and goes red)
    const before = r.git('rev-parse', 'HEAD')
    r.git('rm', '-q', 'apps/relay/test/auth/pair-fixture.test.ts')
    r.git('commit', '-qm', 'rm')
    expect(r.plan('--base', before)).toEqual([
      ...CHECKS,
      'vitest',
      '\tscripts/security-doc.test.ts',
      'vitest-project',
      '\trelay',
    ])
  })

  it('install.sh is read by name too, a deleted one included: the tests that name it run', () => {
    const r = repo()
    r.put('install.sh', '#!/bin/sh\n')
    r.put('scripts/uses-install.test.ts', "const s = join(root, 'install.sh')\n")
    r.git('add', '-A')
    r.git('commit', '-qm', 'tests')
    const before = r.git('rev-parse', 'HEAD')
    r.git('rm', '-q', 'install.sh')
    r.git('commit', '-qm', 'rm')
    expect(r.plan('--base', before)).toEqual([...CHECKS, 'vitest', '\tscripts/uses-install.test.ts'])
  })

  it("the repository's guards over test files run when a test file they read changes: the ci-requires guard for a bridge test", () => {
    const r = repo()
    // the guards as they are in this repository, so what each declares is what is checked
    const guards = [
      'scripts/test-parallel.test.ts', // the ci-requires headers, and bun's own list of the bridge's test files
      'apps/bridge/test/install-sandbox.test.ts', // no bridge test runs install.sh outside a temp folder
      'scripts/ci-local-check-titan.test.ts', // the macOS-only list against every test file check runs
      'scripts/spec-skip-lint.test.ts', // no *.spec.ts skips by machine
      'scripts/ci-flake-reporters.test.ts', // no *.spec.ts replaces its project's launchOptions without the flag
      'scripts/ci-affected.test.ts', // ci-affected.sh lists what the install and kit tests import
    ]
    for (const g of guards) r.put(g, readFileSync(join(here, '..', g), 'utf8'))
    r.put('apps/bridge/test/supervisor/cli.test.ts')
    r.put('apps/bridge/test-contract/a.contract.vitest.ts')
    r.put('packages/protocol/test/p.test.ts')
    r.put('e2e/tests/02-chat.spec.ts')
    r.commit({ 'scripts/root-install.test.ts': 'x\n' })
    const titan = '\tscripts/ci-local-check-titan.test.ts'
    const planAfter = (files: Record<string, string>) => {
      const base = r.git('rev-parse', 'HEAD')
      r.commit(files)
      return r.plan('--base', base)
    }
    expect(planAfter({ 'apps/bridge/test/supervisor/cli.test.ts': 'tmux\n' })).toEqual([
      ...CHECKS,
      'vitest',
      titan,
      '\tscripts/test-parallel.test.ts',
      'bun',
      '\tapps/bridge/test/install-sandbox.test.ts',
      '\tapps/bridge/test/supervisor/cli.test.ts',
    ])
    expect(planAfter({ 'apps/bridge/test/new.test.ts': 'x\n' })).toEqual([
      ...CHECKS,
      'vitest',
      titan,
      '\tscripts/test-parallel.test.ts',
      'bun',
      '\tapps/bridge/test/install-sandbox.test.ts',
      '\tapps/bridge/test/new.test.ts',
    ])
    expect(planAfter({ 'apps/bridge/test-contract/a.contract.vitest.ts': 'y\n' })).toEqual([
      ...CHECKS,
      'vitest',
      titan,
      'bun-all',
    ])
    expect(planAfter({ 'packages/protocol/test/p.test.ts': 'y\n' })).toEqual([
      ...CHECKS,
      'vitest',
      '\tpackages/protocol/test/p.test.ts',
      titan,
    ])
    expect(planAfter({ 'e2e/tests/02-chat.spec.ts': 'y\n' })).toEqual([
      ...CHECKS,
      'vitest',
      '\tscripts/ci-flake-reporters.test.ts',
      '\tscripts/spec-skip-lint.test.ts',
      'e2e',
      '\ttests/02-chat.spec.ts',
    ])
    expect(planAfter({ 'scripts/root-install.test.ts': 'y\n' })).toEqual([
      ...CHECKS,
      'vitest',
      '\tscripts/ci-affected.test.ts',
      titan,
      '\tscripts/root-install.test.ts',
      'corepack-install',
    ])
    // deleted: the ci-requires guard still runs (its list of exceptions names files that must exist)
    const base = r.git('rev-parse', 'HEAD')
    r.git('rm', '-q', 'apps/bridge/test/supervisor/cli.test.ts')
    r.git('commit', '-qm', 'rm')
    expect(r.plan('--base', base)).toEqual([...CHECKS, 'vitest', titan, '\tscripts/test-parallel.test.ts', 'bun-all'])
  })

  it('counts uncommitted and untracked files too: the gate checks what is on disk', () => {
    const r = repo()
    r.put('apps/web/src/a.ts', 'edited\n')
    r.put('apps/web/src/new.ts', 'new\n')
    expect(r.plan()).toEqual([...CHECKS, 'vitest', '\tapps/web/src/a.ts', '\tapps/web/src/new.ts'])
  })

  it('a deleted file is not handed to vitest related; in a Vitest app its whole project runs (a test may read it by path)', () => {
    const r = repo()
    r.git('rm', '-q', 'apps/web/src/a.ts')
    r.git('commit', '-qm', 'rm')
    expect(r.plan()).toEqual([...CHECKS, 'vitest-project', '\tweb'])
    const two = repo()
    two.commit({ 'apps/relay/src/r.ts': 'x\n', 'apps/mobile/src/m.ts': 'x\n', 'apps/web/src/b.ts': 'x\n' })
    const base = two.git('rev-parse', 'HEAD')
    two.git('rm', '-q', 'apps/relay/src/r.ts', 'apps/mobile/src/m.ts', 'apps/web/src/b.ts', 'apps/web/src/a.ts')
    two.git('commit', '-qm', 'rm')
    const p = two.gate('--plan', '--base', base)
    expect(p.stdout.trim().split('\n')).toEqual([...CHECKS, 'vitest-project', '\tmobile', '\trelay', '\tweb']) // each once
    const docs = repo()
    docs.git('rm', '-q', 'docs/a.md')
    docs.git('commit', '-qm', 'rm')
    expect(docs.plan()).toEqual(CHECKS) // not in a Vitest app
  })

  it('an e2e spec runs itself; a change to what every spec runs on (the harness, the config) runs them all', () => {
    const r = repo()
    r.commit({ 'e2e/tests/02-chat.spec.ts': 'x\n', 'e2e/tests/journeys/edit-approve.spec.ts': 'x\n' })
    expect(r.plan()).toEqual([...CHECKS, 'e2e', '\ttests/02-chat.spec.ts', '\ttests/journeys/edit-approve.spec.ts'])
    const s = repo()
    s.commit({ 'e2e/harness/stack.ts': 'x\n' })
    expect(s.plan()).toEqual([...CHECKS, 'e2e-all', 'old-client'])
    const t = repo()
    t.commit({ 'e2e/README.md': 'x\n' })
    expect(t.plan()).toEqual(CHECKS) // words only
  })

  it('a change on the pairing path (enroll CLI, web pages, relay auth) also runs the pairing e2e specs', () => {
    const pairing = ['\ttests/01-enroll.spec.ts', '\ttests/08-devices.spec.ts', '\ttests/12-device-proof.spec.ts']
    for (const f of [
      'apps/bridge/src/enroll-cli.ts',
      'apps/bridge/src/enrollment.ts',
      'apps/bridge/src/cli-main.ts',
      'apps/web/src/features/auth/EnrollPage.tsx',
      'apps/relay/src/auth/index.ts',
      'apps/bridge/src/enroll-files.ts',
      'apps/web/src/lib/deviceKey.ts',
      'packages/protocol/src/device-proof.ts',
    ]) {
      const r = repo()
      r.commit({ [f]: 'x\n' })
      const plan = r.plan()
      expect(plan, f).toContain('e2e')
      for (const spec of pairing) expect(plan, f).toContain(spec)
    }
    // two pairing files in one change: each spec once
    const both = repo()
    both.commit({ 'apps/bridge/src/enroll-cli.ts': 'x\n', 'apps/relay/src/auth/index.ts': 'x\n' })
    for (const spec of pairing)
      expect(
        both.plan().filter((l) => l === spec),
        spec,
      ).toHaveLength(1)
    const other = repo()
    other.commit({ 'apps/bridge/src/memory/x.ts': 'x\n' })
    expect(other.plan()).not.toContain('e2e') // not every bridge change
  })

  /** A repo whose tests read some words and assets, and the commit to measure from. */
  const withReaders = () => {
    const r = repo()
    r.commit({
      'apps/web/test/docs.test.ts': "const page = readFileSync('docs/GUIDE.md', 'utf8')\n",
      'apps/web/test/doc.test.tsx': "const page = 'docs/GUIDE.md'\n",
      'scripts/setup.test.ts': "const doc = join(root, 'docs', 'GUIDE.md')\n",
      'apps/bridge/test/icon.test.ts': "const icon = 'apps/web/public/icon.png'\n",
      // near misses: another file whose name holds this one, and a dot that is not a dot
      'apps/web/test/near.test.ts': "const a = 'docs/GUIDE.mdx'\nconst b = 'docs/GUIDExmd'\n",
      'scripts/odd.test.ts': "const odd = 'docs/my [1] page.md'\n",
      'docs/GUIDE.md': 'words\n',
      'docs/OTHER.md': 'words\n',
      'docs/my [1] page.md': 'words\n',
      'apps/web/public/icon.png': 'png\n',
    })
    const base = r.git('rev-parse', 'HEAD')
    const plan = (...a: string[]) => {
      const p = r.gate('--plan', '--base', base, ...a)
      expect(p.status, p.stderr).toBe(0)
      return { out: p.stdout.trim().split('\n'), why: p.stderr }
    }
    return { r, plan }
  }

  it('a words or asset file plans the tests that name it, by path or by file name in quotes, and no near miss', () => {
    const { r, plan } = withReaders()
    r.commit({ 'docs/GUIDE.md': 'more words\n' })
    const doc = plan()
    expect(doc.out).toEqual([
      ...CHECKS,
      'vitest',
      '\tapps/web/test/doc.test.tsx', // a .tsx test reads it too
      '\tapps/web/test/docs.test.ts',
      '\tscripts/setup.test.ts', // by its file name in quotes
    ])
    expect(doc.why).toContain('apps/web/test/docs.test.ts <- docs/GUIDE.md (names it)')
  })

  it('an asset a bridge test names runs that test under bun', () => {
    const { r, plan } = withReaders()
    r.commit({ 'apps/web/public/icon.png': 'png 2\n' })
    expect(plan().out).toEqual([...CHECKS, 'bun', '\tapps/bridge/test/icon.test.ts'])
  })

  it('a deleted or renamed doc still runs its readers', () => {
    const { r, plan } = withReaders()
    r.git('mv', 'docs/GUIDE.md', 'docs/MOVED.md')
    r.git('commit', '-qm', 'mv')
    expect(plan().out).toContain('\tapps/web/test/docs.test.ts')
  })

  it('a name with a space and brackets is found; a doc no reader names plans nothing', () => {
    const { r, plan } = withReaders()
    r.commit({ 'docs/my [1] page.md': 'more\n' })
    expect(plan().out).toEqual([...CHECKS, 'vitest', '\tscripts/odd.test.ts'])
    const other = withReaders()
    other.r.commit({ 'docs/OTHER.md': 'more\n' })
    expect(other.plan().out).toEqual(CHECKS)
  })

  it('--checks-only plans no readers and no whole project', () => {
    const { r, plan } = withReaders()
    r.git('rm', '-q', 'docs/GUIDE.md', 'apps/web/src/a.ts')
    r.git('commit', '-qm', 'rm')
    expect(plan().out).toContain('vitest-project')
    expect(plan('--checks-only').out).toEqual(CHECKS)
  })

  it('a doc no test names still runs no suite', () => {
    const r = repo()
    r.commit({ 'docs/a.md': 'changed\n', 'docs/new page.md': 'x\n' })
    expect(r.plan()).toEqual(CHECKS)
  })

  it("the web app's browser specs: a feature's own, a changed spec itself, and a smoke set for shared code", () => {
    const r = repo()
    r.commit({
      'apps/web/test/help/help.spec.ts': 'x\n',
      'apps/web/test/threads/threads.spec.ts': 'x\n',
      'apps/web/test/home/home.spec.ts': 'x\n',
      'apps/web/test/shell/shell.spec.ts': 'x\n',
      'apps/web/test/themes/themes.spec.ts': 'x\n',
      'apps/web/test/cards/cards.spec.ts': 'x\n',
      'apps/web/test/cards/setup.spec.ts': 'x\n',
      'apps/web/test/helpers/fixtures.ts': 'x\n',
      'apps/web/test/help/support.ts': 'x\n',
      'apps/web/test/help/unit.test.ts': 'x\n',
      'apps/web/src/router.tsx': 'x\n',
      'apps/web/src/features/help/HelpAbout.tsx': 'x\n',
      'apps/web/src/features/cards/Card.tsx': 'x\n',
      'apps/web/src/features/nospecs/X.tsx': 'x\n',
      'apps/web/src/features/contracts.ts': 'x\n',
      'apps/web/src/ui/Button.tsx': 'x\n',
      'apps/web/src/theme/tokens.css': 'x\n',
      'apps/web/src/Shell.tsx': 'x\n',
      'apps/web/public/icon.png': 'x\n',
    })
    const base = r.git('rev-parse', 'HEAD')
    const run = (files: Record<string, string | null>, env2: Record<string, string> = {}) => {
      for (const [f, t] of Object.entries(files)) if (t === null) r.git('rm', '-q', f)
      r.commit(Object.fromEntries(Object.entries(files).filter(([, t]) => t !== null)) as Record<string, string>)
      const p = spawnSync('bash', ['scripts/gate.sh', '--plan', '--base', base], {
        cwd: r.T,
        env: { ...env, ...env2 },
        encoding: 'utf8',
      })
      r.git('reset', '-q', '--hard', base)
      return p
    }
    // the tab-indented lines under one heading of the plan, up to the next heading
    const under = (out: string[], heading: string) => {
      const i = out.indexOf(heading)
      if (i < 0) return []
      const rest = out.slice(i + 1)
      const end = rest.findIndex((l) => !l.startsWith('\t'))
      return end < 0 ? rest : rest.slice(0, end)
    }
    const web = (files: Record<string, string | null>, env2: Record<string, string> = {}) =>
      under(run(files, env2).stdout.trim().split('\n'), 'web-specs')
    // the change's own specs, which also run on WebKit (the iphone project)
    const webkit = (files: Record<string, string | null>, env2: Record<string, string> = {}) =>
      under(run(files, env2).stdout.trim().split('\n'), 'web-specs-webkit')
    const SMOKE = ['\ttest/home/home.spec.ts', '\ttest/threads/threads.spec.ts'] // the smoke set's specs that exist here
    // WebKit: a changed spec and a feature's or spec folder's own specs; never the smoke set, never a wide change
    expect(webkit({ 'apps/web/test/help/help.spec.ts': 'y\n' })).toEqual(['\ttest/help/help.spec.ts'])
    expect(webkit({ 'apps/web/src/features/help/HelpAbout.tsx': 'y\n' })).toEqual(['\ttest/help/help.spec.ts'])
    expect(webkit({ 'apps/web/src/ui/Button.tsx': 'y\n' })).toEqual([]) // shared code: the smoke set, on Chromium only
    expect(webkit({ 'apps/web/src/features/cards/Card.tsx': 'y\n' })).toEqual([
      '\ttest/cards/cards.spec.ts',
      '\ttest/cards/setup.spec.ts',
    ])
    expect(
      webkit(
        { 'apps/web/src/features/help/HelpAbout.tsx': 'y\n', 'apps/web/src/features/cards/Card.tsx': 'y\n' },
        { WEB_SPECS_MAX: '2' },
      ),
    ).toEqual([]) // over the cap: CI runs every browser
    expect(web({ 'apps/web/src/features/help/HelpAbout.tsx': 'y\n' })).toEqual(['\ttest/help/help.spec.ts'])
    expect(web({ 'apps/web/src/features/help/HelpAbout.tsx': null })).toEqual(['\ttest/help/help.spec.ts']) // deleted too
    expect(web({ 'apps/web/test/help/help.spec.ts': 'y\n' })).toEqual(['\ttest/help/help.spec.ts'])
    expect(web({ 'apps/web/test/help/help.spec.ts': null })).toEqual([]) // a deleted spec runs nothing
    expect(web({ 'apps/web/src/features/cards/Card.tsx': 'y\n' })).toEqual([
      '\ttest/cards/cards.spec.ts',
      '\ttest/cards/setup.spec.ts',
    ])
    expect(web({ 'apps/web/src/Shell.tsx': 'y\n' })).toEqual([
      '\ttest/home/home.spec.ts',
      '\ttest/shell/shell.spec.ts',
      SMOKE[1],
    ])
    expect(web({ 'apps/web/src/theme/tokens.css': 'y\n' })).toEqual([
      SMOKE[0],
      '\ttest/themes/themes.spec.ts',
      SMOKE[1],
    ])
    // shared code, and a feature with no specs of its own: the smoke set
    for (const f of [
      'apps/web/src/ui/Button.tsx',
      'apps/web/src/features/contracts.ts',
      'apps/web/src/features/nospecs/X.tsx',
      'apps/web/test/helpers/fixtures.ts',
      'apps/web/public/icon.png',
    ])
      expect(web({ [f]: 'y\n' }), f).toEqual(SMOKE)
    expect(web({ 'apps/relay/src/r.ts': 'y\n' })).toEqual([]) // not the web app
    // a spec folder's support file: that folder's specs and the smoke set; a unit test there is not a browser spec
    expect(web({ 'apps/web/test/help/support.ts': 'y\n' })).toEqual(['\ttest/help/help.spec.ts', ...SMOKE])
    expect(web({ 'apps/web/test/help/unit.test.ts': 'y\n' })).toEqual([])
    // a new top-level file under src: the smoke set
    expect(web({ 'apps/web/src/router.tsx': 'y\n' })).toEqual(SMOKE)
    // a Shell change with no shell specs still runs the smoke set
    r.git('rm', '-q', '-r', 'apps/web/test/shell')
    r.git('commit', '-qm', 'no shell specs')
    const noShell = r.git('rev-parse', 'HEAD')
    r.commit({ 'apps/web/src/Shell.tsx': 'y\n' })
    const sh = r.gate('--plan', '--base', noShell).stdout.trim().split('\n')
    expect(sh.slice(sh.indexOf('web-specs') + 1).filter((l) => l.startsWith('\t'))).toEqual(SMOKE)
    r.git('reset', '-q', '--hard', base)
    // a change across more screens than WEB_SPECS_MAX: the smoke set, and a note
    const wide = run(
      { 'apps/web/src/features/help/HelpAbout.tsx': 'y\n', 'apps/web/src/features/cards/Card.tsx': 'y\n' },
      { WEB_SPECS_MAX: '2' },
    )
    expect(wide.stderr).toContain('this change touches 3 web browser specs: the gate runs the smoke set')
    const wideOut = wide.stdout.trim().split('\n')
    expect(wideOut.slice(wideOut.indexOf('web-specs') + 1).filter((l) => l.startsWith('\t'))).toEqual(SMOKE)
    // exactly at the cap is not over it; a cap that is not a number is the default, never off
    const atCap = run(
      { 'apps/web/src/features/help/HelpAbout.tsx': 'y\n', 'apps/web/src/features/cards/Card.tsx': 'y\n' },
      { WEB_SPECS_MAX: '3' },
    )
    expect(atCap.stderr).not.toContain('web browser specs: the gate runs the smoke set')
    const bad = run({ 'apps/web/src/features/help/HelpAbout.tsx': 'y\n' }, { WEB_SPECS_MAX: 'lots' })
    expect(bad.status).toBe(0)
    expect(bad.stderr).not.toContain('integer expression')
    // the plan lists it after e2e, the order it runs in; --checks-only plans none
    const order = run({ 'apps/web/src/ui/Button.tsx': 'y\n', 'e2e/tests/02-chat.spec.ts': 'y\n' })
      .stdout.trim()
      .split('\n')
    expect(order.indexOf('web-specs')).toBeGreaterThan(order.indexOf('e2e'))
    r.commit({ 'apps/web/src/ui/Button.tsx': 'z\n' })
    expect(r.gate('--plan', '--base', base, '--checks-only').stdout).not.toContain('web-specs')
  }, 60_000) // many whole fake gates: 34 s under load (2026-11-15)

  it("every spec in the gate's web smoke set exists in the web app (a rename would shrink it silently)", () => {
    const src = readFileSync(join(here, 'gate.sh'), 'utf8')
    const m = src.match(/^WEB_SMOKE="([^"]*)"/m)
    expect(m).not.toBeNull()
    const smoke = (m?.[1] ?? '').replace(/\\\n/g, ' ').split(/\s+/).filter(Boolean)
    expect(smoke.length).toBeGreaterThan(3)
    for (const s of smoke) expect(existsSync(join(here, '..', 'apps/web/test', s)), s).toBe(true)
  })

  it('--full runs every Vitest project, the whole bridge suite and every e2e spec', () => {
    const r = repo()
    expect(r.plan('--full')).toEqual([...CHECKS, 'vitest-all', 'bun-all', 'e2e-all', 'old-client', 'web-specs-all'])
  })

  it('what an older page meets (protocol, relay, the bridge hello and features, the old-client specs) runs the old-client step', () => {
    for (const f of [
      'packages/protocol/src/frames.ts',
      'apps/relay/src/core/hub.ts',
      'apps/bridge/src/handshake.ts',
      'apps/bridge/src/relay-client.ts',
      'apps/bridge/src/bridge.ts',
      'apps/bridge/src/frames-out.ts',
      'apps/relay/migrations/0042_x.sql',
      'e2e/tests/old-client/old-client.spec.ts',
      'scripts/web-bundle-manifest.mjs',
    ]) {
      const r = repo()
      r.commit({ [f]: 'x\n' })
      expect(r.plan(), f).toContain('old-client')
    }
    for (const f of ['apps/bridge/src/memory/x.ts', 'apps/web/src/b.ts', 'docs/a.md', 'e2e/tests/02-chat.spec.ts']) {
      const r = repo()
      r.commit({ [f]: 'changed\n' })
      expect(r.plan(), f).not.toContain('old-client')
    }
    // a checkout without the script (an older tree) has no such step
    const old = repo()
    old.git('rm', '-q', 'scripts/old-client.sh')
    old.commit({ 'apps/relay/src/core/hub.ts': 'x\n' })
    expect(old.plan()).not.toContain('old-client')
  })
})

describe('gate.sh names Bun and its SQLite, and refuses a Bun below the floor', () => {
  /** A repo whose gate gets past its stand-ins to the Bun check: `bunVersion` is what the fake bun reports. */
  const run = (bunVersion: string | null, change: Record<string, string>) => {
    const r = repo()
    r.put('node_modules/.bin/biome', '#!/bin/sh\nexit 0\n')
    chmodSync(join(r.T, 'node_modules/.bin/biome'), 0o755)
    const bin = join(r.T, 'bin')
    mkdirSync(bin)
    writeFileSync(join(bin, 'pnpm'), '#!/bin/sh\necho "pnpm $*" >> "$0.log"\nexit 0\n', { mode: 0o755 })
    if (bunVersion !== null)
      writeFileSync(
        join(bin, 'bun'),
        `#!/bin/sh\ncase "$1" in --version) echo ${bunVersion} ;; -e) echo 3.99.1 ;; *) echo "bun $*" >> "$0.log" ;; esac\nexit 0\n`,
        { mode: 0o755 },
      )
    r.put('.gitignore', 'node_modules\nbin\n')
    r.commit(change)
    // PATH without any real bun: only the stand-in (or none). A folder that holds a real bun is not dropped (on Arch that is
    // /usr/bin, with bash and git in it): it is replaced by a folder of links to everything in it but bun.
    const path = [
      bin,
      ...(process.env.PATH ?? '').split(':').map((d, i) => {
        if (!d || !existsSync(join(d, 'bun'))) return d
        const mirror = join(bin, `path-${i}`) // inside bin: ignored, so the gate sees no new files
        mkdirSync(mirror)
        for (const name of readdirSync(d)) if (name !== 'bun') symlinkSync(join(d, name), join(mirror, name))
        return mirror
      }),
    ].join(':')
    const p = spawnSync('bash', ['scripts/gate.sh', '--base', r.base], {
      cwd: r.T,
      env: { ...env, PATH: path },
      encoding: 'utf8',
    })
    return { ...p, ran: existsSync(join(bin, 'pnpm.log')) }
  }
  const bridge = { 'apps/bridge/src/notify.ts': 'changed\n' }

  it('says which Bun and SQLite every run uses', () => {
    const p = run('1.4.4', { 'docs/a.md': 'changed\n' })
    expect(p.stderr).toContain('gate: bun 1.4.4, SQLite 3.99.1 (bun:sqlite)')
    expect(p.stderr).not.toContain('older than')
  })

  it('the floor itself and anything newer run the bridge tests', () => {
    for (const v of ['1.4.4', '1.4.5', '1.10.0', '2.0.0', '1.4.4-canary.3']) {
      const p = run(v, bridge)
      expect(p.stderr, v).toContain(`gate: bun ${v}, SQLite 3.99.1 (bun:sqlite)`)
      expect(p.stderr, v).not.toContain('older than 1.4.4')
    }
  }, 60_000) // five whole fake gates, about 6 s each on a busy Mac

  it('an older Bun refuses when the bridge tests would run, before any step runs', () => {
    for (const v of ['1.4.3', '1.3.11', '1.3.12', '1.3.10', '0.9', 'garbage']) {
      const p = run(v, bridge)
      expect(p.status, v).toBe(1)
      expect(p.stderr, v).toContain(`gate: REFUSED: bun ${v} is older than 1.4.4, the repo's floor`)
      expect(p.ran, v).toBe(false) // not even the type check ran
    }
  })

  it('an older Bun is named but not refused when no bridge test runs; no Bun at all is said too', () => {
    const old = run('1.3.11', { 'docs/a.md': 'changed\n' })
    expect(old.stderr).toContain('gate: bun 1.3.11, SQLite 3.99.1 (bun:sqlite)')
    expect(old.stderr).not.toContain('older than')
    expect(old.ran).toBe(true) // the gate went on to its steps
    expect(run(null, { 'docs/a.md': 'changed\n' }).stderr).toContain('gate: no bun on PATH')
  })
})

describe('gate.sh refuses rather than guess', () => {
  it('with no origin/main and no --base it refuses, and says how to go on', () => {
    const r = repo()
    const p = r.gate('--plan')
    expect(p.status).toBe(1)
    expect(p.stderr).toContain('gate: REFUSED: no base')
    expect(p.stderr).toContain('--full')
  })

  it('an e2e spec with no Playwright to run it refuses the gate, before any step runs', () => {
    const r = repo()
    // the gate's other needs are there (stand-ins), so the refusal is the e2e one
    r.put('node_modules/.bin/biome', '#!/bin/sh\nexit 0\n')
    chmodSync(join(r.T, 'node_modules/.bin/biome'), 0o755)
    const bin = join(r.T, 'bin')
    mkdirSync(bin)
    writeFileSync(join(bin, 'pnpm'), '#!/bin/sh\necho "pnpm $*" >> "$0.log"\nexit 0\n', { mode: 0o755 })
    r.put('.gitignore', 'node_modules\nbin\n')
    r.commit({ 'e2e/tests/02-chat.spec.ts': 'x\n', 'e2e/package.json': '{}\n' })
    const p = spawnSync('bash', ['scripts/gate.sh', '--base', r.base], {
      cwd: r.T,
      env: { ...env, PATH: `${bin}:${process.env.PATH}` },
      encoding: 'utf8',
    })
    expect(p.status).toBe(1)
    expect(p.stderr).toContain('gate: REFUSED: Playwright or its Chromium is not installed')
    expect(existsSync(join(bin, 'pnpm.log'))).toBe(false) // not even the type check ran
  })

  it('an unknown option is an error, not a gate that passed', () => {
    const r = repo()
    expect(r.gate('--fastest').status).toBe(64)
  })
})
