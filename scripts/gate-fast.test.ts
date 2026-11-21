// scripts/gate.sh --fast: the pre-push gate that CI backs up. Of the bridge tests it runs the changed ones, the ones whose own
// quoted relative paths name a changed bridge file (direct importers only), and the guards that read it; no e2e or old-client
// step, and of the browser specs only the changed spec files (scripts/gate-web-specs.test.ts); no heavy lock unless it has
// such a spec. Anything on the keep-out list, or anything the scan cannot follow, runs the full gate
// and says why. Every --plan here also goes through the node second count, which must agree or the gate refuses.
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

// the log of fallbacks (<cache>/logs/fast-fallbacks.tsv) goes to a folder of this file's own, never the real ~/.cache/talos-ci
const CACHE = mkdtempSync(join(tmpdir(), 'gate-fast-cache-'))
dirs.push(CACHE)
const FALLBACKS = join(CACHE, 'logs/fast-fallbacks.tsv')

const env = gateTestEnv({
  TALOS_CI_CACHE: CACHE,
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_SYSTEM: '/dev/null',
  GIT_AUTHOR_NAME: 't',
  GIT_AUTHOR_EMAIL: 't@example.com',
  GIT_COMMITTER_NAME: 't',
  GIT_COMMITTER_EMAIL: 't@example.com',
})

const CHECKS = ['typecheck', 'lint', 'personal', 'size', 'timing']

function repo() {
  const T = mkdtempSync(join(tmpdir(), 'gate-fast-'))
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
  for (const f of [
    'gate.sh',
    'gate-fast.sh',
    'talos-machine.sh',
    'gate-inputs.txt',
    'gate-fast-keepout.txt',
    'check-no-personal.sh',
    'denylist.generic.txt',
  ])
    cpSync(join(here, f), join(T, 'scripts', f))
  cpSync(join(here, 'gate'), join(T, 'scripts/gate'), { recursive: true })
  put('docs/protected-paths.txt', 'apps/bridge/src/keys.ts\napps/web/src/lib/sec\n')
  put('docs/a.md')
  put('e2e/playwright.config.ts', 'export default {}\n')
  put('scripts/old-client.sh')
  put('apps/web/playwright.config.ts', 'export default {}\n')
  put('apps/web/test/threads/threads.spec.ts') // the smoke set
  put('apps/web/src/a.ts')
  // the bridge: a -> b, and tests that import each in the ways bridge tests do
  put('apps/bridge/src/a.ts', "export { b } from './b.ts'\n")
  put('apps/bridge/src/b.ts', 'export const b = 1\n')
  put('apps/bridge/src/c.ts', 'export const c = 1\n')
  put('apps/bridge/src/data/table.json', '{}\n')
  put('apps/bridge/src/handshake.ts', 'export const h = 1\n') // the old-client step runs for it in the planned gate
  put('apps/bridge/src/platform.ts', 'export const p = 1\n')
  put('apps/bridge/test/preload.ts', "import { p } from '../src/platform.ts'\n")
  put('apps/bridge/test/a.test.ts', "import { b } from '../src/a.ts'\n")
  put('apps/bridge/test/b.test.ts', "import { b } from '../src/b.ts'\n")
  put('apps/bridge/test/dyn.test.ts', "it('x', async () => { const { c } = await import('../src/c.ts') })\n")
  put('apps/bridge/test/deep/spawn.test.ts', "const s = resolve(import.meta.dir, '../../src/c.ts')\n")
  put('apps/bridge/test/near.test.ts', "import { x } from '../src/cc.ts'\nconst s = 'c.ts'\n") // names c.ts, not ../src/c.ts
  put('apps/bridge/test/helpers.ts', "import { a } from '../src/a.ts'\n")
  put('apps/bridge/test/uses-helpers.test.ts', "import { h } from './helpers.ts'\n")
  put('apps/bridge/test/guard-reader.test.ts', '// gate-reads: apps/bridge/src/c.ts\nconst all = 1\n')
  git('add', '-A')
  git('commit', '-qm', 'base')
  const base = git('rev-parse', 'HEAD')
  const commit = (files: Record<string, string>) => {
    for (const [f, t] of Object.entries(files)) put(f, t)
    git('add', '-A')
    git('commit', '-qm', 'change')
  }
  const plan = (...a: string[]) => {
    const r = spawnSync('bash', ['scripts/gate.sh', '--plan', '--base', base, ...a], { cwd: T, env, encoding: 'utf8' })
    expect(r.stderr).not.toContain('plan-check:') // the second count agreed
    expect(r.status, r.stderr).toBe(0)
    return { lines: r.stdout.trim().split('\n'), err: r.stderr }
  }
  return { T, git, put, commit, plan, base }
}

/** The first line of a --plan --fast: "fast", or "full-gate: <why>". */
const choice = (r: ReturnType<typeof repo>, files: Record<string, string>) => {
  r.commit(files)
  return r.plan('--fast').lines[0]
}

describe('gate.sh --fast: which bridge tests it picks', () => {
  it('a changed bridge module runs the tests that import it themselves, and not one more step', () => {
    const r = repo()
    r.commit({ 'apps/bridge/src/b.ts': 'export const b = 2\n' })
    expect(r.plan('--fast').lines).toEqual(['fast', ...CHECKS, 'bun', '\tapps/bridge/test/b.test.ts'])
    // the planned gate, for the same change, runs the whole suite
    expect(r.plan().lines).toEqual([...CHECKS, 'bun-all'])
  })

  it('direct only: a -> b -> test is not followed, and a helper that imports the module does not bring its importers', () => {
    const r = repo()
    r.commit({ 'apps/bridge/src/b.ts': 'export const b = 3\n' })
    const p = r.plan('--fast').lines
    expect(p).not.toContain('\tapps/bridge/test/a.test.ts') // imports a.ts, which re-exports b.ts
    expect(p).not.toContain('\tapps/bridge/test/uses-helpers.test.ts')
  })

  it('a dynamic import, a relative path string (as resolve(import.meta.dir, ...) takes) and a gate-reads guard count; a bare file name does not', () => {
    const r = repo()
    r.commit({ 'apps/bridge/src/c.ts': 'export const c = 2\n' })
    expect(r.plan('--fast').lines).toEqual([
      'fast',
      ...CHECKS,
      'bun',
      '\tapps/bridge/test/deep/spawn.test.ts',
      '\tapps/bridge/test/dyn.test.ts',
      '\tapps/bridge/test/guard-reader.test.ts',
    ])
  })

  it('a changed test helper runs the files that import that helper; a changed test runs itself', () => {
    const r = repo()
    r.commit({ 'apps/bridge/test/helpers.ts': "import { a } from '../src/a.ts'\nexport const h = 1\n" })
    expect(r.plan('--fast').lines).toEqual(['fast', ...CHECKS, 'bun', '\tapps/bridge/test/uses-helpers.test.ts'])
    const t = repo()
    t.commit({ 'apps/bridge/test/b.test.ts': "import { b } from '../src/b.ts'\n// more\n" })
    expect(t.plan('--fast').lines).toEqual(['fast', ...CHECKS, 'bun', '\tapps/bridge/test/b.test.ts'])
  })

  it('no e2e or old-client step, and no browser spec for a source change: those are CI after the push', () => {
    const r = repo()
    r.commit({
      'apps/bridge/src/handshake.ts': 'export const h = 2\n',
      'apps/web/src/a.ts': 'y\n',
      'e2e/tests/x.spec.ts': 'y\n',
    })
    const planned = r.plan().lines
    expect(planned).toContain('old-client')
    expect(planned).toContain('web-specs')
    expect(planned).toContain('e2e')
    expect(r.plan('--fast').lines).toEqual(['fast', ...CHECKS, 'vitest', '\tapps/web/src/a.ts'])
  })

  it('a protected path is that file or folder only, not a longer name beside it', () => {
    const r = repo()
    expect(choice(r, { 'apps/web/src/lib/sec2.ts': 'x\n', 'apps/bridge/src/keys.tsx': 'x\n' })).toBe('fast')
  })

  it('a docs-only change is fast and runs no suite; --full and --checks-only are not fast at all', () => {
    const r = repo()
    r.commit({ 'docs/a.md': 'more\n' })
    expect(r.plan('--fast').lines).toEqual(['fast', ...CHECKS])
    expect(r.plan('--fast', '--checks-only').lines).toEqual(CHECKS)
    expect(r.plan('--fast', '--full').lines[0]).toBe('typecheck')
  })
})

describe('gate.sh --fast falls back to the full gate, and says why', () => {
  const cases: [string, Record<string, string>, string][] = [
    ['a gate input', { 'scripts/new-tool.sh': '#\n' }, 'is a gate input'],
    ['a package.json', { 'apps/bridge/package.json': '{}\n' }, 'is a gate input'],
    ['a lock file', { 'apps/x/bun.lock': 'x\n' }, 'keep-out list'],
    ['a tsconfig', { 'apps/web/tsconfig.json': '{}\n' }, 'is a gate input'],
    ['the protocol', { 'packages/protocol/src/frames.ts': 'x\n' }, 'keep-out list'],
    ['a bridge guard', { 'apps/bridge/src/guards/hook.ts': 'x\n' }, 'keep-out list'],
    ['a Mac guard', { 'apps/desktop/Sources/TalosDesktopCore/KeyGuard.swift': 'x\n' }, 'keep-out list'],
    ['the plugin hook', { 'plugins/talos-app-mod/hooks/lib/x.ts': 'x\n' }, 'keep-out list'],
    ['relay auth', { 'apps/relay/src/auth/core.ts': 'x\n' }, 'keep-out list'],
    ['the bug inbox', { 'apps/relay/src/core/bug-reports.ts': 'x\n' }, 'keep-out list'],
    ['the body guard', { 'apps/relay/src/core/body-guard.ts': 'x\n' }, 'keep-out list'],
    ['the pairing path', { 'apps/bridge/src/enroll-cli.ts': 'x\n' }, 'keep-out list'],
    ['a protected path', { 'apps/bridge/src/keys.ts': 'x\n' }, 'protected path'],
    ['a protected folder', { 'apps/web/src/lib/sec/x/y.ts': 'x\n' }, 'protected path'],
    ['bridge data', { 'apps/bridge/src/data/table.json': '{"a":1}\n' }, 'no import names'],
    ['the bridge outside src and test', { 'apps/bridge/test-contract/a.ts': 'x\n' }, 'outside apps/bridge/src'],
    ['what the bridge reads elsewhere', { 'packages/testkit/src/fake.ts': 'x\n' }, 'the import scan does not follow'],
    ['a module the preload loads', { 'apps/bridge/src/platform.ts': 'export const p = 2\n' }, 'test preload'],
  ]
  it.each(cases)('%s', (_name, files, why) => {
    const r = repo()
    const c = choice(r, files)
    expect(c.startsWith('full-gate: '), c).toBe(true)
    expect(c).toContain(why)
    // and the plan is the full gate's own, step for step
    const full = r.plan().lines
    expect(r.plan('--fast').lines.slice(1)).toEqual(full)
  })

  it('a deleted bridge file: the scan cannot follow a file that is gone', () => {
    for (const f of ['apps/bridge/src/c.ts', 'apps/bridge/test/b.test.ts']) {
      const r = repo()
      r.git('rm', '-q', f)
      r.git('commit', '-qm', 'rm')
      const p = r.plan('--fast').lines
      expect(p[0]).toBe(`full-gate: ${f} is deleted, and the import scan cannot follow a file that is gone`)
      expect(p).toContain('bun-all')
    }
  })

  it('more than 60 selected bridge test files', () => {
    const r = repo()
    const many: Record<string, string> = {}
    for (let i = 0; i < 61; i++) many[`apps/bridge/test/m${i}.test.ts`] = "import { b } from '../src/b.ts'\n"
    r.commit(many)
    const tests = r.git('rev-parse', 'HEAD')
    r.commit({ 'apps/bridge/src/b.ts': 'export const b = 9\n' })
    const p = spawnSync('bash', ['scripts/gate.sh', '--plan', '--fast', '--base', tests], {
      cwd: r.T,
      env,
      encoding: 'utf8',
    })
    expect(p.stderr).not.toContain('plan-check:')
    expect(p.stdout.split('\n')[0]).toBe('full-gate: it selects 62 bridge test files, more than 60')
  })

  it('a keep-out list missing or empty at the base is never read as an empty list', () => {
    for (const [what, text] of [
      ['missing', null],
      ['empty', '# only a comment\n\n'],
    ] as const) {
      const r = repo()
      if (text === null) rmSync(join(r.T, 'scripts/gate-fast-keepout.txt'))
      else r.put('scripts/gate-fast-keepout.txt', text)
      r.git('add', '-A')
      r.git('commit', '-qm', 'list')
      const base = r.git('rev-parse', 'HEAD')
      r.commit({ 'apps/bridge/src/b.ts': 'export const b = 6\n' })
      const p = spawnSync('bash', ['scripts/gate.sh', '--plan', '--fast', '--base', base], {
        cwd: r.T,
        env,
        encoding: 'utf8',
      })
      expect(p.stderr, what).not.toContain('plan-check:')
      expect(p.stdout.split('\n')[0], what).toBe(
        'full-gate: scripts/gate-fast-keepout.txt is missing or empty at the base, so the keep-out list cannot be read',
      )
    }
  })

  it("the lists are the base's: a change that empties the keep-out list is still kept out by it", () => {
    const r = repo()
    // (a change to the list is a gate input too: here the protocol file sorts first, so its own reason is the one given)
    r.commit({ 'packages/protocol/src/frames.ts': 'x\n', 'scripts/gate-fast-keepout.txt': '# none\n' })
    expect(r.plan('--fast').lines[0]).toBe(
      'full-gate: packages/protocol/src/frames.ts is on the keep-out list (scripts/gate-fast-keepout.txt)',
    )
  })

  it("gate-inputs.txt and the protected paths are the base's too", () => {
    const r = repo()
    const inputs = readFileSync(join(r.T, 'scripts/gate-inputs.txt'), 'utf8').replace('^scripts/\n', '')
    r.commit({ 'scripts/gate-inputs.txt': inputs, 'scripts/aaa.sh': 'x\n' })
    expect(r.plan('--fast').lines[0]).toBe('full-gate: scripts/aaa.sh is a gate input (scripts/gate-inputs.txt)')
    const p = repo()
    p.commit({ 'docs/protected-paths.txt': '# none\n', 'apps/bridge/src/keys.ts': 'x\n' })
    expect(p.plan('--fast').lines[0]).toBe(
      'full-gate: apps/bridge/src/keys.ts is a protected path (docs/protected-paths.txt)',
    )
  })

  it('a copy of the gate without scripts/gate-fast.sh is never fast, and both counts agree', () => {
    const r = repo()
    rmSync(join(r.T, 'scripts/gate-fast.sh'))
    r.commit({ 'apps/bridge/src/b.ts': 'export const b = 7\n' })
    expect(r.plan('--fast').lines).toEqual(['full-gate: scripts/gate-fast.sh is missing', ...CHECKS, 'bun-all'])
  })

  it('lists written with CRLF, padding or a trailing / still match', () => {
    const r = repo()
    r.put('docs/protected-paths.txt', 'apps/bridge/src/keys.ts \r\n  apps/web/src/lib/sec/\r\n')
    r.put('scripts/gate-fast-keepout.txt', '# x\r\n ^packages/protocol/ \r\n')
    r.git('add', '-A')
    r.git('commit', '-qm', 'crlf')
    const base = r.git('rev-parse', 'HEAD')
    for (const [f, why] of [
      ['apps/bridge/src/keys.ts', 'protected path'],
      ['apps/web/src/lib/sec/x.ts', 'protected path'],
      ['packages/protocol/src/frames.ts', 'keep-out list'],
    ]) {
      r.commit({ [f]: `${f}\n` })
      const p = spawnSync('bash', ['scripts/gate.sh', '--plan', '--fast', '--base', base], {
        cwd: r.T,
        env,
        encoding: 'utf8',
      })
      expect(p.stderr, f).not.toContain('plan-check:')
      expect(p.stdout.split('\n')[0], f).toContain(why)
      r.git('reset', '-q', '--hard', base)
    }
  })

  it('the keep-out list covers every path of the pairing rule (the planned gate runs e2e for them; the fast gate does not)', () => {
    const r = repo()
    for (const f of [
      'apps/bridge/src/enroll.ts',
      'apps/bridge/src/enroll/x.ts',
      'apps/bridge/src/enrollment.ts',
      'apps/bridge/src/devices.ts',
      'apps/bridge/src/cli-main.ts',
      'apps/bridge/src/cli.ts',
      'apps/bridge/src/relay-http.ts',
      'apps/web/src/features/auth/a.ts',
      'apps/web/src/lib/deviceKey.ts',
      'apps/relay/src/auth/a.ts',
      'packages/protocol/src/enroll.ts',
      'packages/protocol/src/device-proof.ts',
    ]) {
      const base = r.git('rev-parse', 'HEAD')
      r.commit({ [f]: `${f} 2\n` })
      const p = spawnSync('bash', ['scripts/gate.sh', '--plan', '--fast', '--base', base], {
        cwd: r.T,
        env,
        encoding: 'utf8',
      })
      expect(p.stdout.split('\n')[0].startsWith('full-gate: '), `${f}: ${p.stdout}`).toBe(true)
    }
  })
})

describe('gate.sh --fast: the node second count makes the same choice, or the gate refuses', () => {
  it('a fast plan the shell got wrong is refused', () => {
    const r = repo()
    // the shell's scan made to miss the direct importers: the second count still finds them
    const gate = readFileSync(join(r.T, 'scripts/gate-fast.sh'), 'utf8')
    const broken = gate.replace('names_file "$t" "$f" && bun+=("$t")', ': names_file "$t" "$f"')
    expect(broken).not.toBe(gate)
    r.commit({ 'scripts/gate-fast.sh': broken }) // into the base: the change below is the bridge file only
    r.commit({ 'apps/bridge/src/b.ts': 'export const b = 4\n' })
    const p = spawnSync('bash', ['scripts/gate.sh', '--plan', '--fast', '--base', r.git('rev-parse', 'HEAD~1')], {
      cwd: r.T,
      env,
      encoding: 'utf8',
    })
    expect(p.status).toBe(1)
    expect(p.stderr).toContain('plan-check: BUN is missing apps/bridge/test/b.test.ts')
  })

  it('a fast choice the shell made where the second count would not is refused', () => {
    const r = repo()
    const gate = readFileSync(join(r.T, 'scripts/gate-fast.sh'), 'utf8')
    // the shell made blind to the keep-out list
    const broken = gate.replace('fast_off "$f is on the keep-out list', 'true || fast_off "$f is on the keep-out list')
    expect(broken).not.toBe(gate)
    r.commit({ 'scripts/gate-fast.sh': broken })
    r.commit({ 'packages/protocol/src/frames.ts': 'x\n' })
    const p = spawnSync('bash', ['scripts/gate.sh', '--plan', '--fast', '--base', r.git('rev-parse', 'HEAD~1')], {
      cwd: r.T,
      env,
      encoding: 'utf8',
    })
    expect(p.status).toBe(1)
    expect(p.stderr).toContain('plan-check: FAST')
  })
})

describe('gate.sh --fast runs without the heavy lock', () => {
  it('its suites run straight (a heavy-lock.sh that is there is never called), the bridge files through test-parallel', () => {
    const r = repo()
    r.put('node_modules/.bin/biome', '#!/bin/sh\nexit 0\n')
    chmodSync(join(r.T, 'node_modules/.bin/biome'), 0o755)
    const bin = join(r.T, 'bin')
    mkdirSync(bin)
    writeFileSync(join(bin, 'pnpm'), '#!/bin/sh\necho "pnpm $*" >> "$0.log"\nexit 0\n', { mode: 0o755 })
    writeFileSync(
      join(bin, 'bun'),
      '#!/bin/sh\ncase "$1" in --version) echo 1.4.4 ;; -e) echo 3.99.1 ;; *) echo "bun $*" >> "$0.log"; for a in "$@"; do [ -f "$a" ] && cat "$a" >> "$0.log"; done ;; esac\nexit 0\n',
      { mode: 0o755 },
    )
    r.put('scripts/heavy-lock.sh', 'echo called > "$(dirname "$0")/../lock.log"\nexit 75\n')
    r.commit({ '.gitignore': 'node_modules\nbin\nlock.log\n' })
    const base = r.git('rev-parse', 'HEAD')
    r.commit({ 'apps/bridge/src/b.ts': 'export const b = 5\n' })
    const path = [bin, ...(process.env.PATH ?? '').split(':').filter((d) => !existsSync(join(d, 'bun')))].join(':')
    const run = (...a: string[]) =>
      spawnSync('bash', ['scripts/gate.sh', '--base', base, ...a], {
        cwd: r.T,
        env: { ...env, PATH: path },
        encoding: 'utf8',
      })
    const fast = run('--fast')
    expect(fast.status, fast.stderr).toBe(0)
    expect(fast.stderr).toContain('gate: fast gate:')
    expect(fast.stderr).toContain('no heavy lock')
    expect(existsSync(join(r.T, 'lock.log'))).toBe(false)
    const bun = readFileSync(join(bin, 'bun.log'), 'utf8')
    expect(bun).toContain('bun run scripts/test-parallel.ts --jobs 2 --files')
    expect(bun).toContain('test/b.test.ts') // the list it was handed, relative to apps/bridge
    // the planned gate, for the same change, asks for the lock (and is refused it here)
    const planned = run()
    expect(planned.status).toBe(1)
    expect(existsSync(join(r.T, 'lock.log'))).toBe(true)
  })
})

describe('gate.sh --fast: a change to only test files is fast, whatever the gate-inputs rule or the keep-out list say of the folder', () => {
  const planOf = (r: ReturnType<typeof repo>, base: string) =>
    spawnSync('bash', ['scripts/gate.sh', '--plan', '--fast', '--base', base], { cwd: r.T, env, encoding: 'utf8' })
  const fastOnly = (r: ReturnType<typeof repo>, ...tests: string[]) =>
    expect(r.plan('--fast').lines).toEqual([
      'fast',
      ...CHECKS,
      ...(tests.length ? ['vitest'] : []),
      ...tests.map((t) => `\t${t}`),
    ])

  it("a test file under scripts/ runs fast with vitest on that file and no more, the gate's own tests included", () => {
    const r = repo()
    r.commit({ 'scripts/x.test.ts': 'export {}\n' })
    fastOnly(r, 'scripts/x.test.ts')
    const g = repo()
    g.commit({
      'scripts/gate.test.ts': 'export {}\n',
      'scripts/pre-push.test.ts': 'export {}\n',
      'scripts/sub/y.test.ts': 'export {}\n',
    })
    fastOnly(g, 'scripts/gate.test.ts', 'scripts/pre-push.test.ts', 'scripts/sub/y.test.ts')
  })

  it('tests under guard, protocol and auth paths are fast: the keep-out list is for the code, not its tests', () => {
    const r = repo()
    r.commit({
      'apps/bridge/test/guards.test.ts': 'export {}\n', // a bridge test runs itself
      'packages/protocol/test/frames.test.ts': 'export {}\n',
      'apps/relay/test/auth/passkey.spec.ts': 'export {}\n',
      'apps/relay/src/auth/core.test.ts': 'export {}\n',
      'apps/web/src/features/auth/x.test.tsx': 'export {}\n',
      'plugins/talos-app-mod/hooks/x.test.ts': 'export {}\n',
    })
    const p = r.plan('--fast').lines
    expect(p[0]).toBe('fast')
    expect(p).toContain('\tapps/bridge/test/guards.test.ts')
    expect(p).toContain('\tpackages/protocol/test/frames.test.ts')
    expect(p).toContain('\tapps/relay/src/auth/core.test.ts')
  })

  it('a Swift file under a Tests/ folder is fast (Swift is the Mac and iPhone jobs, not this gate); its fixtures are not', () => {
    const r = repo()
    r.commit({
      'apps/desktop/Tests/TalosDesktopCoreTests/KeyGuardTests.swift': 'x\n',
      'apps/mobile/ios/BridgeGuard/Tests/BridgeGuardTests/A.swift': 'x\n',
    })
    fastOnly(r)
    const f = repo()
    expect(choice(f, { 'apps/desktop/Tests/Fixtures/real-1/pane.txt': 'x\n' })).toContain('the bridge tests read')
  })

  it("the gate's own code, and test helpers that are not test files, stay full", () => {
    for (const other of [
      'scripts/new-tool.sh',
      'scripts/root-install-harness.ts',
      'scripts/gate-inputs.txt',
      'apps/bridge/src/guards/hook.ts',
      'packages/protocol/test/support/x.ts',
    ]) {
      const r = repo()
      const c = choice(r, { 'scripts/x.test.ts': 'export {}\n', [other]: `${other} 2\n` })
      expect(c.startsWith('full-gate: '), other).toBe(true)
      expect(c, other).toContain(other)
    }
  })

  it('only a test file that is a regular file and still there: nothing odd gets the carve-out', () => {
    const odd: [string, Record<string, string>][] = [
      ['a helper, not a test', { 'scripts/x.ts': 'x\n' }],
      ['an extension that is not listed', { 'scripts/x.test.mts': 'x\n' }],
      ['a name another input line also matches', { 'scripts/tsconfig.test.ts': 'x\n' }],
      ['a name in another case', { 'scripts/x.TEST.ts': 'x\n' }],
      ['a Swift file outside a Tests/ folder', { 'apps/desktop/Sources/TalosDesktopCore/KeyGuard.swift': 'x\n' }],
      ['a test file in the gate-inputs lines other than scripts/', { '.github/workflows/x.test.ts': 'x\n' }],
    ]
    for (const [what, files] of odd) {
      const r = repo()
      expect(choice(r, files).startsWith('full-gate: '), what).toBe(true)
    }
    const link = repo()
    symlinkSync('gate.sh', join(link.T, 'scripts/y.test.ts'))
    expect(choice(link, {}).startsWith('full-gate: '), 'a link').toBe(true)
    const gone = repo()
    gone.commit({ 'scripts/z.test.ts': 'x\n' })
    const base = gone.git('rev-parse', 'HEAD')
    gone.git('rm', '-q', 'scripts/z.test.ts')
    gone.git('commit', '-qm', 'rm')
    const p = planOf(gone, base)
    expect(p.stderr).not.toContain('plan-check:')
    expect(p.stdout.split('\n')[0]).toBe('full-gate: scripts/z.test.ts is a gate input (scripts/gate-inputs.txt)')
  })

  it('the protected paths still apply to a test file', () => {
    const p = repo()
    p.put('docs/protected-paths.txt', 'scripts/p.test.ts\n')
    p.git('add', '-A')
    p.git('commit', '-qm', 'protect')
    const base = p.git('rev-parse', 'HEAD')
    p.commit({ 'scripts/p.test.ts': 'x\n' })
    const o = planOf(p, base)
    expect(o.stderr).not.toContain('plan-check:')
    expect(o.stdout.split('\n')[0]).toContain('protected path')
  })

  it("the carve-out is read from the base's list: one with no exact ^scripts/ line has none", () => {
    const r = repo()
    const inputs = readFileSync(join(r.T, 'scripts/gate-inputs.txt'), 'utf8').replace('^scripts/\n', '^scripts/.*\n')
    r.put('scripts/gate-inputs.txt', inputs)
    r.git('add', '-A')
    r.git('commit', '-qm', 'list')
    const base = r.git('rev-parse', 'HEAD')
    r.commit({ 'scripts/x.test.ts': 'x\n' })
    const p = planOf(r, base)
    expect(p.stderr).not.toContain('plan-check:')
    expect(p.stdout.split('\n')[0]).toBe('full-gate: scripts/x.test.ts is a gate input (scripts/gate-inputs.txt)')
  })

  it('both counts make the carve-out: a shell that never makes it, or always makes it, is refused', () => {
    const never = (g: string) => g.replace('gate_test_file "$f" "$ins_rest" || tf=0', 'tf=0')
    const always = (g: string) => g.replace('gate_test_file() {', 'gate_test_file() {\n  return 0')
    for (const [what, edit, file] of [
      ['never', never, 'scripts/x.test.ts'],
      ['always', always, 'scripts/new-tool.sh'],
    ] as const) {
      const r = repo()
      const gate = readFileSync(join(r.T, 'scripts/gate-fast.sh'), 'utf8')
      const broken = edit(gate)
      expect(broken, what).not.toBe(gate)
      r.commit({ 'scripts/gate-fast.sh': broken })
      r.commit({ [file]: 'x\n' })
      const p = planOf(r, r.git('rev-parse', 'HEAD~1'))
      expect(p.status, what).toBe(1)
      expect(p.stderr, what).toContain('plan-check: FAST')
    }
  })
})

describe("gate.sh --fast: the personal-data scan reads this change only, its files and its commits' messages", () => {
  // a value the generic list flags, built at run time so this file holds nothing the scan would flag
  const HIT = ['/Us', 'ers/', 'jordan'].join('')
  /** A repo whose gate gets past its stand-ins, with a flagged value already in the base (docs/old.md). */
  const setup = () => {
    const r = repo()
    r.put('node_modules/.bin/biome', '#!/bin/sh\nexit 0\n')
    chmodSync(join(r.T, 'node_modules/.bin/biome'), 0o755)
    const bin = join(r.T, 'bin')
    mkdirSync(bin)
    writeFileSync(join(bin, 'pnpm'), '#!/bin/sh\nexit 0\n', { mode: 0o755 })
    r.commit({ '.gitignore': 'node_modules\nbin\n', 'docs/old.md': `see ${HIT}/notes\n` })
    const base = r.git('rev-parse', 'HEAD')
    const run = (e: Record<string, string>, ...a: string[]) =>
      spawnSync('bash', ['scripts/gate.sh', '--base', base, ...a], {
        cwd: r.T,
        env: { ...env, PATH: `${bin}:${process.env.PATH}`, ...e },
        encoding: 'utf8',
      })
    return { ...r, run, bin, base }
  }

  it('a clean change passes though the tree holds an old hit, and says what it scanned; the full gate scans the tree and refuses', () => {
    const r = setup()
    r.commit({ 'docs/a.md': 'clean words\n' })
    const fast = r.run({}, '--fast')
    expect(fast.status, fast.stderr).toBe(0)
    expect(fast.stderr).toContain('gate: personal (this change only: its files and commit messages) ok')
    const full = r.run({})
    expect(full.status).toBe(1)
    expect(full.stderr).toContain('gate: REFUSED: personal failed')
  })

  it("a hit in the change's own file refuses, and so does one in an older commit's message, not the tip's alone", () => {
    const file = setup()
    file.commit({ 'docs/a.md': `new ${HIT}/x\n` })
    const f = file.run({}, '--fast')
    expect(f.status).toBe(1)
    expect(f.stderr).toContain('gate: REFUSED: personal (this change only')
    expect(f.stderr).toContain('docs/a.md:1')
    expect(f.stderr).not.toContain(HIT)
    const msg = setup()
    msg.put('docs/a.md', 'clean\n')
    msg.git('add', '-A')
    msg.git('commit', '-qm', `notes from ${HIT}/x`)
    msg.commit({ 'docs/b.md': 'clean too\n' })
    const m = msg.run({}, '--fast')
    expect(m.status).toBe(1)
    expect(m.stderr).toContain('gate: REFUSED: personal (this change only')
  })

  it('a folder turned into a file (its old files deleted) is not a failure of the scan', () => {
    const r = setup()
    r.commit({ 'docs/sub/y.md': 'clean\n' })
    const from = r.git('rev-parse', 'HEAD') // the change starts here, with the folder already in it
    r.git('rm', '-q', '-r', 'docs/sub')
    r.commit({ 'docs/sub': 'now a file\n' })
    const p = spawnSync('bash', ['scripts/gate.sh', '--fast', '--base', from], {
      cwd: r.T,
      env: { ...env, PATH: `${r.bin}:${process.env.PATH}` },
      encoding: 'utf8',
    })
    expect(p.status, p.stderr).toBe(0)
  })

  it('an edit on disk that is not committed yet is scanned too (the gate checks the files on disk)', () => {
    const r = setup()
    r.commit({ 'docs/a.md': 'clean\n' })
    r.put('docs/a.md', `dirty ${HIT}/x\n`)
    expect(r.run({}, '--fast').status).toBe(1)
  })

  it('a changed link is scanned as a link: an absolute target, or one leading out of the repository, refuses', () => {
    for (const target of ['/opt/shared/cfg', '../../outside']) {
      const r = setup()
      symlinkSync(target, join(r.T, 'docs/conf'))
      r.commit({})
      const p = r.run({}, '--fast')
      expect(p.status, target).toBe(1)
      expect(p.stdout + p.stderr, target).toContain('[symlink] docs/conf')
    }
  })

  it('a relative CHECK_EXTRA_RULES entry is read from the repository, as the full scan reads it', () => {
    const r = setup()
    r.put('rules/extra.txt', '.\t-\tzebra-quartz-value\n')
    r.commit({ '.gitignore': 'node_modules\nbin\nrules\n' })
    const base = r.git('rev-parse', 'HEAD')
    r.commit({ 'docs/a.md': 'a zebra-quartz-value here\n' })
    const p = spawnSync('bash', ['scripts/gate.sh', '--fast', '--base', base], {
      cwd: r.T,
      env: { ...env, PATH: `${r.bin}:${process.env.PATH}`, CHECK_EXTRA_RULES: 'rules/extra.txt' },
      encoding: 'utf8',
    })
    expect(p.status).toBe(1)
    expect(p.stderr).not.toContain('does not exist')
    expect(p.stderr).toContain('gate: REFUSED: personal (this change only')
  })

  it('the private list is a hard stop as before: a value on it refuses the fast gate, and no list says so', () => {
    const r = setup()
    const outside = mkdtempSync(join(tmpdir(), 'gate-fast-list-'))
    dirs.push(outside)
    const list = join(outside, 'private-rules.txt') // outside the repo, as the main checkout's gitignored list is
    writeFileSync(list, '.\t-\tzebra-quartz-value\n')
    r.commit({ 'docs/a.md': 'a zebra-quartz-value here\n' })
    const generic = r.run({}, '--fast')
    expect(generic.status, generic.stderr).toBe(0) // the generic rules alone do not know it
    expect(generic.stderr).toContain('gate: no private list')
    const p = r.run({ CHECK_EXTRA_RULES: list }, '--fast')
    expect(p.status).toBe(1)
    expect(p.stderr).toContain('gate: REFUSED: personal (this change only')
  })

  it('a fast gate that falls back to the full one scans the whole tree, as before', () => {
    const r = setup()
    r.commit({ 'scripts/tool.sh': 'echo\n' }) // a gate input: the full gate
    const p = r.run({}, '--fast')
    expect(p.stderr).toContain('full gate, not the fast one')
    expect(p.status).toBe(1)
    expect(p.stderr).toContain('gate: REFUSED: personal failed')
  })

  it('--checks-only (gate.sh --push after a race) keeps scanning the whole tree', () => {
    const r = setup()
    r.commit({ 'docs/a.md': 'clean\n' })
    const p = r.run({}, '--fast', '--checks-only')
    expect(p.status).toBe(1)
    expect(p.stderr).toContain('gate: REFUSED: personal failed')
  })

  describe('every fall back to the full gate is one line in <cache>/logs/fast-fallbacks.tsv', () => {
    const lines = () => (existsSync(FALLBACKS) ? readFileSync(FALLBACKS, 'utf8').trim().split('\n') : [])

    it('time, machine, sha, the printed reason and the files that tripped it: all of them, test files not among them', () => {
      rmSync(FALLBACKS, { force: true })
      const r = setup()
      r.commit({
        'scripts/tool.sh': 'echo\n',
        'packages/protocol/src/frames.ts': 'x\n',
        'apps/bridge/test/guards.test.ts': 'x\n', // a test: not what tripped it
        'docs/a.md': 'words\n',
      })
      const p = r.run({ TALOS_MACHINE: 'lemnos' }, '--fast')
      expect(p.stderr).toContain('full gate, not the fast one: ')
      const [time, machine, sha, reason, files] = lines()[0]?.split('\t') ?? []
      expect(lines()).toHaveLength(1)
      expect(time).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/)
      expect(machine).toBe('lemnos')
      expect(sha).toBe(r.git('rev-parse', 'HEAD'))
      expect(p.stderr).toContain(`full gate, not the fast one: ${reason}`)
      expect(reason).toContain('packages/protocol/src/frames.ts is on the keep-out list') // the first file's reason is the one printed
      expect(files?.split(',').sort()).toEqual(['packages/protocol/src/frames.ts', 'scripts/tool.sh'])
    })

    it('a reason that names no list still names its file', () => {
      rmSync(FALLBACKS, { force: true })
      const r = setup()
      r.commit({ 'apps/bridge/src/data/table.json': '{"a":1}\n' })
      r.run({ TALOS_MACHINE: 'lemnos' }, '--fast')
      expect(lines()[0]?.split('\t')[4]).toBe('apps/bridge/src/data/table.json')
    })

    it('a fast gate, a plan, --full and --checks-only log nothing; a log that cannot be written never stops the gate', () => {
      rmSync(FALLBACKS, { force: true })
      const r = setup()
      r.commit({ 'docs/a.md': 'clean\n' })
      expect(r.run({}, '--fast').status).toBe(0)
      r.commit({ 'scripts/tool.sh': 'echo\n' })
      for (const a of [
        ['--fast', '--plan'],
        ['--full', '--plan'],
        ['--fast', '--checks-only'],
      ])
        spawnSync('bash', ['scripts/gate.sh', '--base', r.base, ...a], {
          cwd: r.T,
          env: { ...env, PATH: `${r.bin}:${process.env.PATH}` },
          encoding: 'utf8',
        })
      expect(lines()).toEqual([])
      // the cache folder is a file: nothing can be written there, and the gate runs on to its own verdict
      const blocked = join(r.T, 'blocked')
      writeFileSync(blocked, 'x\n')
      const p = r.run({ TALOS_CI_CACHE: blocked }, '--fast')
      expect(p.stderr).toContain('full gate, not the fast one')
      expect(p.stderr).toContain('gate: typecheck ok') // it ran past the planning step
    })
  })
})

describe('a Swift test file is fast, so a bridge test that reads one says so with // gate-reads: (the fast gate runs it then)', () => {
  // gate.sh runs a Swift Tests/ file change through no bridge test unless a bridge test marks the file it reads
  const root = join(here, '..')
  const walk = (d: string): string[] =>
    readdirSync(d, { withFileTypes: true }).flatMap((e) =>
      e.isDirectory() ? walk(join(d, e.name)) : e.name.endsWith('.test.ts') ? [join(d, e.name)] : [],
    )
  // the case pattern of a gate-reads line (* and ? match / too), as a regular expression
  const globRe = (p: string) =>
    new RegExp(
      `^${p
        .replace(/[.+^${}()|[\]\\]/g, '\\$&')
        .replace(/\*/g, '.*')
        .replace(/\?/g, '.')}$`,
    )

  it('every bridge test that reads a .swift file under a Tests/ folder (outside a comment) marks it', () => {
    const missing: string[] = []
    for (const t of walk(join(root, 'apps/bridge/test'))) {
      const text = readFileSync(t, 'utf8')
      const marks = [...text.matchAll(/^\/\/ gate-reads:(.*)$/gm)]
        .flatMap((m) => (m[1] ?? '').trim().split(/\s+/))
        .filter(Boolean)
      for (const line of text.split('\n')) {
        if (/^\s*(\/\/|\*|\/\*)/.test(line)) continue
        for (const m of line.matchAll(/Tests\/[A-Za-z0-9_/.-]*\.swift/g)) {
          const ok = marks.some(
            (p) => globRe(p).test(`apps/desktop/${m[0]}`) || globRe(p).test(`apps/mobile/ios/x/${m[0]}`),
          )
          if (!ok) missing.push(`${t.slice(root.length + 1)} reads ${m[0]}`)
        }
      }
    }
    expect(missing).toEqual([])
  })
})

describe('gate.sh plans every test that reads a changed file (90eda966 and bc69061a went red on main with tests no gate planned)', () => {
  const root = join(here, '..')
  const real = (f: string) => readFileSync(join(root, f), 'utf8')
  // the plan for what changed after `base` (the commit of the tests), through both counts
  const planAfter = (r: ReturnType<typeof repo>, base: string, ...a: string[]) => {
    const p = spawnSync('bash', ['scripts/gate.sh', '--plan', '--base', base, ...a], {
      cwd: r.T,
      env,
      encoding: 'utf8',
    })
    expect(p.stderr).not.toContain('plan-check:')
    expect(p.status, p.stderr).toBe(0)
    return p.stdout.trim().split('\n')
  }
  // the repository's own tests in the temp repo: what each marks is what is checked
  const withTests = (files: string[]) => {
    const r = repo()
    for (const f of files) r.put(f, real(f))
    r.git('add', '-A')
    r.git('commit', '-qm', 'tests')
    return { r, base: r.git('rev-parse', 'HEAD') }
  }
  // the names are put together here, so no test file's name is written out whole in this file: a test that names another
  // test file is planned whenever that one changes (this one would run on every change to the readers below)
  const tests = (dir: string, ...names: string[]) => names.map((n) => `${dir}/${n}.test.ts`)
  const CORE = tests('scripts', 'install-bughunt', 'kit-update', 'root-install', 'uninstall-bughunt')
  const AUTH_TEST = `apps/relay/test/auth/${['enroll', 'session'].join('-')}.test.ts`

  it('a changed bridge source file runs real-file.test.ts, which walks all of src without naming a file (90eda966)', () => {
    const { r, base } = withTests(tests('apps/bridge/test', 'real-file'))
    r.commit({ 'apps/bridge/src/memory/cli.ts': 'export const x = 1\n' })
    expect(planAfter(r, base, '--fast')).toEqual([
      'fast',
      ...CHECKS,
      'bun',
      `\t${tests('apps/bridge/test', 'real-file')[0]}`,
    ])
  })

  it('a changed relay test runs the doc test that cites its titles, in the fast gate too (bc69061a)', () => {
    const { r, base } = withTests(tests('scripts', 'security-setup-code-doc'))
    r.commit({ [AUTH_TEST]: "it('x', () => {})\n" })
    expect(planAfter(r, base, '--fast')).toEqual([
      'fast',
      ...CHECKS,
      'vitest',
      `\t${AUTH_TEST}`,
      `\t${tests('scripts', 'security-setup-code-doc')[0]}`,
    ])
  })

  it('touching scripts/foo.sh runs the core installer tests, and not the rest of root-install*', () => {
    const { r, base } = withTests([...CORE, ...tests('scripts', 'root-install-v1', 'kit-tests')])
    r.commit({ 'scripts/foo.sh': '#!/bin/sh\n' })
    // and the same tests once more with a corepack pnpm first on PATH (KIT-8: a harness fault only a corepack pnpm shows)
    expect(planAfter(r, base)).toEqual([...CHECKS, 'vitest', ...CORE.map((t) => `\t${t}`), 'corepack-install'])
    const fast = planAfter(r, base, '--fast')
    expect(fast[0]).toMatch(/^full-gate: .*gate input/)
    expect(fast).toEqual(expect.arrayContaining([...CORE.map((t) => `\t${t}`), 'corepack-install']))
  })

  it('install.sh and a file under kit/ run them too', () => {
    for (const f of ['install.sh', 'kit/hooks/session-start.py']) {
      const { r, base } = withTests(CORE)
      r.commit({ [f]: '#\n' })
      expect(planAfter(r, base), f).toEqual(expect.arrayContaining([...CORE.map((t) => `\t${t}`), 'corepack-install']))
    }
  })

  it('the corepack step with no corepack on PATH fails loudly ("corepack missing"), and never skips', () => {
    const bin = mkdtempSync(join(tmpdir(), 'no-corepack-'))
    dirs.push(bin)
    for (const tool of ['bash', 'dirname']) {
      const at = spawnSync('bash', ['-c', `command -v ${tool}`], { encoding: 'utf8' }).stdout.trim()
      symlinkSync(at, join(bin, tool))
    }
    const r = spawnSync(join(bin, 'bash'), [join(root, 'scripts/corepack-install-tests.sh')], {
      env: { PATH: bin },
      encoding: 'utf8',
    })
    expect(r.status).toBe(1)
    expect(r.stderr).toContain('corepack missing')
  })

  it('the corepack step fails loudly when the pnpm shim corepack made is not a corepack one', () => {
    const bin = mkdtempSync(join(tmpdir(), 'fake-corepack-'))
    dirs.push(bin)
    for (const tool of ['bash', 'dirname', 'mktemp', 'rm', 'node', 'chmod']) {
      const at = spawnSync('bash', ['-c', `command -v ${tool}`], { encoding: 'utf8' }).stdout.trim()
      symlinkSync(at, join(bin, tool))
    }
    // a corepack that makes a plain script, whose real path has no "corepack" in it: Homebrew's pnpm, say
    writeFileSync(join(bin, 'corepack'), '#!/bin/bash\nprintf "#!/bin/sh\\n" > "$3/pnpm"\nchmod +x "$3/pnpm"\n', {
      mode: 0o755,
    })
    const r = spawnSync(join(bin, 'bash'), [join(root, 'scripts/corepack-install-tests.sh')], {
      env: { PATH: bin },
      encoding: 'utf8',
    })
    expect(r.status).toBe(1)
    expect(r.stderr).toContain("is not corepack's")
  })

  it('a change under apps/web only does not run the installer tests', () => {
    const { r, base } = withTests(CORE)
    r.commit({ 'apps/web/src/a.ts': 'y\n' })
    expect(planAfter(r, base, '--fast')).toEqual(['fast', ...CHECKS, 'vitest', '\tapps/web/src/a.ts']) // no corepack-install
  })
})

describe('the cross-file readers say what they read with // gate-reads: (the plan finds a guard by that line, and nothing else)', () => {
  const root = join(here, '..')
  const marks = (f: string) =>
    [...readFileSync(join(root, f), 'utf8').matchAll(/^\/\/ gate-reads:(.*)$/gm)]
      .flatMap((m) => (m[1] ?? '').trim().split(/\s+/))
      .filter(Boolean)
  // a reader of other files that no import follows: a doc test, a source scan, a shell harness. Left out on purpose:
  // gate-inputs.test (a gate input, so every change to what it reads is the full gate), size-budget (every gate runs it) and
  // last-good.test (it reads nothing it does not import)
  // each test file is [folder, name]: the names are put together, so this file never writes a test file's name out whole
  const READERS = [
    ['apps/bridge/test', 'real-file', 'rollback', 'talos', 'real-claude-permission-hook'],
    ['apps/relay/test/share', 'doc'],
    ['apps/relay/test', 'deploy-watch'],
    ['apps/web/test/help', 'help-truth'],
    ['packages/protocol/test', 'settings-table'],
    [
      'scripts',
      'security-setup-code-doc',
      'apps-doc',
      'setup-doc',
      'setup-docs-public',
      'bughunt-docs',
      'third-party-notices',
      'agent-setup-doc',
      'v2-features-doc',
      'claude-code-doc',
      'check-private-docs',
      'kit-onboarding',
      'kit-default-agent',
      'kit-instructions',
      'kit-source',
      'changelog-union',
      'export-public',
      'publish-public',
      'root-install',
      'install-bughunt',
      'uninstall-bughunt',
      'kit-update',
    ],
  ].flatMap(([dir, ...names]) => names.map((n) => `${dir}/${n}.test.ts`))

  it('each one of them has a line', () => {
    expect(READERS.filter((f) => marks(f).length === 0)).toEqual([])
  })

  it('a path a line names (no * or ?) is a file that exists: a rename must not leave a guard reading nothing', () => {
    const gone: string[] = []
    for (const f of READERS)
      for (const p of marks(f)) if (!/[*?]/.test(p) && !existsSync(join(root, p))) gone.push(`${f}: ${p}`)
    expect(gone).toEqual([])
  })
})
