// scripts/gate.sh's "swift build (<package>)" step: nothing else in the gate compiles Swift, so a change to a *.swift file
// (or a package manifest) must build its SwiftPM package, tests included, in the fast gate and the full one; a machine that
// cannot build Swift refuses the push, it never skips. `--plan` runs nothing; the run tests use stand-in pnpm, biome, swift
// and uname, as gate.test.ts does for pnpm and biome.
import { spawnSync } from 'node:child_process'
import {
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
import { fakeTool } from './fake-tool'
import { gateTestEnv } from './gate-test-env'

const here = dirname(fileURLToPath(import.meta.url))
vi.setConfig({ testTimeout: scaled(60_000), hookTimeout: scaled(60_000) })
const dirs: string[] = []
afterAll(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

const env = gateTestEnv({
  TALOS_CI_CACHE: mkdtempSync(join(tmpdir(), 'gate-swift-cache-')),
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_SYSTEM: '/dev/null',
  GIT_AUTHOR_NAME: 't',
  GIT_AUTHOR_EMAIL: 't@example.com',
  GIT_COMMITTER_NAME: 't',
  GIT_COMMITTER_EMAIL: 't@example.com',
})
dirs.push(env.TALOS_CI_CACHE as string)

const CHECKS = ['typecheck', 'lint', 'personal', 'size', 'timing']
const DESKTOP = 'apps/desktop'
const GUARD = 'apps/mobile/ios/BridgeGuard'
const APP = 'apps/mobile/ios/App/App/AppDelegate.swift'
const step = (pkg: string) => [`swift build (${pkg})`, '\tswift build --build-tests']

function repo() {
  const T = mkdtempSync(join(tmpdir(), 'gate-swift-'))
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
  put('docs/protected-paths.txt', 'apps/bridge/src/keys.ts\n')
  put('docs/a.md')
  put('apps/web/src/a.ts')
  put('apps/bridge/src/a.ts')
  put(`${DESKTOP}/Package.swift`, '// swift-tools-version:5.9\n')
  put(`${DESKTOP}/Sources/TalosSupervisor/Supervisor.swift`, 'let t = 1\n')
  put(`${DESKTOP}/Tests/TalosSupervisorTests/SupervisorTests.swift`, 'let t = 1\n')
  put(`${GUARD}/Package.swift`, '// swift-tools-version:5.9\n')
  put(`${GUARD}/Sources/BridgeGuard/A.swift`, 'let a = 1\n')
  put(`${GUARD}/Tests/BridgeGuardTests/A.swift`, 'let a = 1\n')
  put('apps/mobile/ios/TalosPushCore/Package.swift', '// swift-tools-version:5.9\n')
  put('apps/mobile/ios/App/CapApp-SPM/Package.swift', '// swift-tools-version:5.9\n')
  put('apps/mobile/ios/App/App/AppDelegate.swift', 'let a = 1\n')
  put('.gitignore', 'node_modules\nbin\n')
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
    expect(r.stderr).not.toContain('plan-check:')
    expect(r.status, r.stderr).toBe(0)
    return r.stdout.trim().split('\n')
  }
  /** A real (not --plan) run with stand-in tools; `swiftBody` is the stand-in swift, null for none on PATH's front. */
  const run = (opts: {
    uname: string
    swift?: string
    swiftc?: string
    noSwift?: boolean
    args?: string[]
    extra?: Record<string, string>
  }) => {
    put('node_modules/.bin/biome', '#!/bin/sh\necho "biome $*" >> "$CALLS"\nexit 0\n')
    const bin = join(T, 'bin')
    mkdirSync(bin, { recursive: true })
    fakeTool(bin, 'pnpm', '#!/bin/sh\necho "pnpm $*" >> "$CALLS"\nexit 0\n')
    fakeTool(bin, 'uname', `#!/bin/sh\n[ "$1" = -s ] && { echo ${opts.uname}; exit 0; }\nexec /usr/bin/uname "$@"\n`)
    if (opts.swift) fakeTool(bin, 'swift', opts.swift)
    if (opts.swift || opts.swiftc) fakeTool(bin, 'swiftc', opts.swiftc ?? '#!/bin/sh\nexit 0\n')
    // no swift at all: a PATH folder that holds one (/usr/bin on a Mac) is replaced by links to everything in it but swift
    const path = (process.env.PATH ?? '')
      .split(':')
      .map((d, i) => {
        if (!opts.noSwift || !d || !existsSync(join(d, 'swift'))) return d
        const mirror = join(bin, `path-${i}`) // inside bin: ignored, so the gate sees no new files
        mkdirSync(mirror)
        for (const name of readdirSync(d)) if (!name.startsWith('swift')) symlinkSync(join(d, name), join(mirror, name))
        return mirror
      })
      .join(':')
    const calls = join(T, 'calls.log')
    rmSync(calls, { force: true })
    spawnSync('chmod', ['+x', join(T, 'node_modules/.bin/biome')])
    const p = spawnSync('bash', ['scripts/gate.sh', '--base', base, ...(opts.args ?? ['--fast'])], {
      cwd: T,
      env: { ...env, CALLS: calls, PATH: `${bin}:${path}`, ...opts.extra },
      encoding: 'utf8',
    })
    return { ...p, calls: existsSync(calls) ? readFileSync(calls, 'utf8').trim().split('\n') : [] }
  }
  return { T, git, put, commit, plan, run, base }
}

describe('--plan lists "swift build (<package>)" for a Swift change, in the fast gate and the full one', () => {
  it('a Swift source file in the Mac app plans it, in both', () => {
    const r = repo()
    r.commit({ [`${DESKTOP}/Sources/TalosSupervisor/Supervisor.swift`]: 'let t = 2\n' })
    expect(r.plan()).toEqual(expect.arrayContaining(step(DESKTOP)))
    expect(r.plan('--fast')).toEqual(expect.arrayContaining(step(DESKTOP)))
  })

  it('a Swift test file plans it with the tests built, and the change stays a fast one', () => {
    const r = repo()
    r.commit({ [`${GUARD}/Tests/BridgeGuardTests/A.swift`]: 'let a = 2\n' })
    expect(r.plan('--fast')).toEqual(['fast', ...CHECKS, ...step(GUARD)])
  })

  it('a package manifest or its resolved pins plan the package; two files of one package plan it once', () => {
    for (const f of [`${GUARD}/Package.swift`, `${GUARD}/Package.resolved`]) {
      const r = repo()
      r.commit({ [f]: '{}\n' })
      expect(r.plan(), f).toEqual(expect.arrayContaining(step(GUARD)))
    }
    const r = repo()
    r.commit({
      [`${GUARD}/Sources/BridgeGuard/A.swift`]: 'let a = 2\n',
      [`${GUARD}/Tests/BridgeGuardTests/A.swift`]: 'let a = 2\n',
    })
    expect(r.plan().filter((l) => l === `swift build (${GUARD})`)).toHaveLength(1)
  })

  it('each package a change touches gets its own step, sorted', () => {
    const r = repo()
    r.commit({
      [`${DESKTOP}/Sources/TalosSupervisor/Supervisor.swift`]: 'let t = 3\n',
      'apps/mobile/ios/TalosPushCore/Sources/A.swift': 'let a = 1\n',
      [`${GUARD}/Sources/BridgeGuard/A.swift`]: 'let a = 3\n',
    })
    const swift = r.plan('--fast').filter((l) => l.startsWith('swift build ('))
    expect(swift).toEqual([
      `swift build (${DESKTOP})`,
      `swift build (${GUARD})`,
      'swift build (apps/mobile/ios/TalosPushCore)',
    ])
  })

  it('a change with no Swift in it plans no Swift step', () => {
    const r = repo()
    r.commit({ 'docs/a.md': 'more\n', 'apps/web/src/a.ts': 'y\n', 'apps/bridge/src/a.ts': 'y\n' })
    for (const p of [r.plan(), r.plan('--fast')]) expect(p.join('\n')).not.toContain('swift build')
  })

  it('the Xcode app folder is not a SwiftPM package of the gate (CI builds it)', () => {
    const r = repo()
    r.commit({
      'apps/mobile/ios/App/App/AppDelegate.swift': 'let a = 2\n',
      'apps/mobile/ios/App/CapApp-SPM/Package.swift': '// changed\n',
    })
    expect(r.plan().join('\n')).not.toContain('swift build')
  })
})

describe('--full builds every SwiftPM package, and the Xcode app folder gets a syntax check, not a build', () => {
  it('--full --plan lists every package (not the Xcode app folder) whatever changed, and the Xcode app files to parse', () => {
    const r = repo()
    r.commit({ 'docs/a.md': 'more\n' })
    const p = r.plan('--full')
    expect(p.filter((l) => l.startsWith('swift build ('))).toEqual([
      `swift build (${DESKTOP})`,
      `swift build (${GUARD})`,
      'swift build (apps/mobile/ios/TalosPushCore)',
    ])
    expect(p).toEqual(expect.arrayContaining(['swift parse (apps/mobile/ios/App)', `\t${APP}`]))
  })

  it('a changed Xcode app file plans swift parse with its path, and no build; a deleted one plans nothing', () => {
    const r = repo()
    r.commit({ [APP]: 'let a = 2\n' })
    for (const p of [r.plan(), r.plan('--fast')]) {
      expect(p).toEqual(expect.arrayContaining(['swift parse (apps/mobile/ios/App)', `\t${APP}`]))
      expect(p.join('\n')).not.toContain('swift build')
    }
    const d = repo()
    d.git('rm', '-q', APP)
    d.git('commit', '-qm', 'rm')
    expect(d.plan().join('\n')).not.toContain('swift')
  })
})

describe('a planned Swift step on a machine that cannot build Swift refuses', () => {
  it('not a Mac: one plain line says to land it from a Mac, before any step runs', () => {
    const r = repo()
    r.commit({ [`${GUARD}/Tests/BridgeGuardTests/A.swift`]: 'let a = 2\n' })
    const p = r.run({ uname: 'Linux', swift: '#!/bin/sh\nexit 0\n' }) // a swift on PATH does not make Linux a Mac
    expect(p.status).toBe(1)
    expect(p.stderr).toContain(`gate: REFUSED: this change touches Swift (${GUARD}) and this machine is not a Mac`)
    expect(p.stderr).toContain('land it from a Mac')
    expect(p.calls).toEqual([]) // not even the type check ran
  })

  it('a Mac with no swift on PATH: refuses with a line saying how to get it, before any step runs', () => {
    const r = repo()
    r.commit({ [`${GUARD}/Tests/BridgeGuardTests/A.swift`]: 'let a = 2\n' })
    const p = r.run({ uname: 'Darwin', noSwift: true })
    expect(p.status).toBe(1)
    expect(p.stderr).toContain(`gate: REFUSED: this change touches Swift (${GUARD}) and swift is not installed`)
    expect(p.stderr).toContain('xcode-select --install')
    expect(p.calls).toEqual([])
  })

  it('the Xcode app syntax check refuses the same way off a Mac', () => {
    const r = repo()
    r.commit({ [APP]: 'let a = 2\n' })
    const p = r.run({ uname: 'Linux', swift: '#!/bin/sh\nexit 0\n' })
    expect(p.status).toBe(1)
    expect(p.stderr).toContain('this machine is not a Mac')
    expect(p.stderr).toContain('land it from a Mac')
  })

  it('a change with no Swift still runs on that machine', () => {
    const r = repo()
    r.commit({ 'docs/a.md': 'more\n' })
    const p = r.run({ uname: 'Linux' })
    expect(p.status, p.stderr).toBe(0)
    expect(p.stderr).not.toContain('Swift')
  })
})

describe('the swift step runs swift build --build-tests in the package, and a failure refuses the gate', () => {
  const change = { [`${GUARD}/Tests/BridgeGuardTests/A.swift`]: 'let a = 2\n' }

  it('a passing build is run once, in the package folder, with the tests built', () => {
    const r = repo()
    r.commit(change)
    const p = r.run({ uname: 'Darwin', swift: '#!/bin/sh\necho "swift $(basename "$PWD") $*" >> "$CALLS"\nexit 0\n' })
    expect(p.status, p.stderr).toBe(0)
    expect(p.stderr).toContain(`gate: swift build (${GUARD}) ok`)
    const swift = p.calls.filter((c) => c.startsWith('swift '))
    expect(swift).toHaveLength(1)
    expect(swift[0]).toMatch(/^swift BridgeGuard build --build-tests/)
  })

  it('a failing build refuses, and says which package', () => {
    const r = repo()
    r.commit(change)
    const p = r.run({
      uname: 'Darwin',
      swift: '#!/bin/sh\necho "error: \'=\' must have consistent whitespace" >&2\nexit 1\n',
    })
    expect(p.status).toBe(1)
    expect(p.stderr).toContain('must have consistent whitespace')
    expect(p.stderr).toContain(`gate: REFUSED: swift build (${GUARD}) failed`)
    expect(p.stderr).not.toContain('gate: passed')
  })

  it('a build slower than its limit is stopped and refuses, naming the limit', () => {
    const r = repo()
    r.commit(change)
    const p = r.run({
      uname: 'Darwin',
      swift: '#!/bin/sh\nsleep 30\n',
      extra: { GATE_SWIFT_LIMIT: '1' },
    })
    expect(p.status).toBe(1)
    expect(p.stderr).toContain('stopped after 1 s (GATE_SWIFT_LIMIT)')
    expect(p.stderr).toContain(`gate: REFUSED: swift build (${GUARD}) failed`)
  })
})

describe('the swift parse step runs swiftc -parse on each changed Xcode app file', () => {
  const change = { [APP]: 'let a = 2\n', 'apps/mobile/ios/App/App/Other.swift': 'let b = 2\n' }

  it('each file is parsed once, and no package is built', () => {
    const r = repo()
    r.commit(change)
    const p = r.run({
      uname: 'Darwin',
      swift: '#!/bin/sh\necho "swift $*" >> "$CALLS"\nexit 0\n',
      swiftc: '#!/bin/sh\necho "swiftc $*" >> "$CALLS"\nexit 0\n',
    })
    expect(p.status, p.stderr).toBe(0)
    expect(p.stderr).toContain('gate: swift parse (apps/mobile/ios/App) ok')
    expect(p.calls.filter((c) => c.startsWith('swiftc '))).toEqual([
      `swiftc -parse ${APP}`,
      'swiftc -parse apps/mobile/ios/App/App/Other.swift',
    ])
    expect(p.calls.filter((c) => c.startsWith('swift '))).toEqual([])
  })

  it('a parse error refuses the gate', () => {
    const r = repo()
    r.commit(change)
    const p = r.run({
      uname: 'Darwin',
      swift: '#!/bin/sh\nexit 0\n',
      swiftc:
        '#!/bin/sh\ncase "$2" in *Other.swift) echo "error: \'=\' must have consistent whitespace" >&2; exit 1 ;; esac\nexit 0\n',
    })
    expect(p.status).toBe(1)
    expect(p.stderr).toContain('consistent whitespace')
    expect(p.stderr).toContain('gate: REFUSED: swift parse (apps/mobile/ios/App) failed')
  })
})

describe('swift_touched (scripts/gate/swift-race.sh): a race decides on its Swift packages, and any doubt runs the full gate', () => {
  const touched = (plan: string, theirs: string) =>
    spawnSync(
      'bash',
      ['-c', 'source scripts/gate/swift-race.sh; swift_touched "$1" "$2"; echo "rc=$?"', '_', plan, theirs],
      {
        cwd: join(here, '..'),
        encoding: 'utf8',
      },
    ).stdout.trim()

  it('an empty plan (plan_of could not plan) counts as touched: the full gate runs, never the cheap pass', () => {
    expect(touched('', 'apps/web/src/a.ts')).toMatch(/rc=0$/)
  })

  it('a plan with no Swift step leaves it to the other checks, and a same-package file is touched', () => {
    expect(touched('typecheck\nlint', 'apps/desktop/Sources/A.swift')).toBe('rc=1')
    expect(touched('typecheck\nswift build (apps/desktop)', 'apps/desktop/Sources/B.swift')).toBe(
      'apps/desktop/Sources/B.swift\nrc=0',
    )
  })
})
