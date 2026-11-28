// ci-local.sh gates, split from ci-local-jobs.test.ts so the two run side by side: the same harness, the same tests.
import { type ChildProcess, execFileSync, spawn, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  appendFileSync,
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
import { delimiter, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest'
import { t as scaled } from '../packages/testkit/src/time-factor.ts'
import { report, timingsFor } from './ci-subset-report.ts'
import { cleanEnv, copyCiLocalParts } from './ci-test-env'
import { fakeTool } from './fake-tool'
import { fixtureGitEnv, harnessBin, harnessEnv, REFUSED_TOOLS, withoutInherited } from './harness-path'
import { waitForFile } from './wait-loop.ts'

const here = dirname(fileURLToPath(import.meta.url))
const script = join(here, 'ci-local.sh')
vi.setConfig({ testTimeout: scaled(60_000), hookTimeout: scaled(60_000) })

const dirs: string[] = []
const live: ChildProcess[] = []
const sandboxes: { T: string; allowed: boolean }[] = []
afterEach(() => {
  for (const c of live.splice(0)) c.kill('SIGKILL')
  // a refusing stub was called (scripts/harness-path.ts): a real tool no test stubbed. The test fails, unless it said it expects that.
  const marked = sandboxes.splice(0).filter((b) => !b.allowed && existsSync(join(b.T, 'refused')))
  const hits = marked.map((b) => readFileSync(join(b.T, 'refused'), 'utf8').trim()).filter(Boolean)
  if (hits.length > 0) throw new Error(`a refusing stub was called: ${hits.join(' | ')}`)
})
afterAll(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

/** The real script with these job functions added, in a clone of a one-commit repo with fake tools on the PATH. */
function repo(jobs = '', tools: Record<string, string> = {}) {
  const T = mkdtempSync(join(tmpdir(), 'cij-'))
  dirs.push(T)
  const sandbox = { T, allowed: false }
  sandboxes.push(sandbox)
  // a fake home, no configuration and no GIT_* of a running gate: an inherited GIT_DIR would aim a commit at the real repository
  const git = (cwd: string, ...a: string[]) =>
    execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', ...a], {
      cwd,
      encoding: 'utf8',
      env: fixtureGitEnv(T),
    }).trim()
  const src = join(T, 'src')
  mkdirSync(join(src, 'apps/bridge/scripts'), { recursive: true })
  git(src, 'init', '-q', '-b', 'main')
  writeFileSync(join(src, 'a.txt'), 'a\n')
  writeFileSync(join(src, 'apps/bridge/scripts/test-parallel.ts'), '// stand-in\n')
  git(src, 'add', '-A')
  git(src, 'commit', '-qm', 'a')
  const origin = join(T, 'origin.git')
  git(T, 'clone', '-q', '--bare', src, origin)
  const clone = join(T, 'clone')
  git(T, 'clone', '-q', origin, clone)
  mkdirSync(join(clone, 'scripts'), { recursive: true })
  const copy = join(clone, 'scripts', 'ci-local.sh')
  writeFileSync(copy, readFileSync(script, 'utf8').replace('\ncd "$WT"\n', `\n${jobs}\ncd "$WT"\n`))
  copyCiLocalParts(join(clone, 'scripts')) // the parts ci-local.sh sources in place
  cpSync(join(here, 'talos-machine.sh'), join(clone, 'scripts/talos-machine.sh')) // the time factor's rule, shared with gate.sh
  const bin = join(T, 'bin')
  mkdirSync(bin)
  harnessBin(bin) // the PATH is this folder alone: real tools by name, refusing stubs for the rest (scripts/harness-path.ts)
  const home = join(T, 'home')
  mkdirSync(home)
  const calls = join(T, 'calls')
  const tool = (name: string, body: string) => fakeTool(bin, name, `#!/bin/bash\n${body}\n`)
  tool('gh', 'case "$1" in repo) echo owner/repo ;; api) echo "$*" >> "$GH_LOG" ;; esac')
  // Exit 1 when the line it just wrote contains $FAIL_ON.
  const fake = (n: string) =>
    `echo "${n} $* SKIP_BUILD=\${SKIP_BUILD:-} E2E_SKIP_BUILD=\${E2E_SKIP_BUILD:-} TALOS_TYPECHECK=\${TALOS_TYPECHECK:-}" >> "$CALLS"
     [ -n "\${FAIL_ON:-}" ] && [[ "$* " == *"$FAIL_ON"* ]] && exit 1
     [ -n "\${FAIL_ON_TSC:-}" ] && [ "\${TALOS_TYPECHECK:-}" = tsc ] && exit 1
     exit 0`
  tool('pnpm', fake('pnpm'))
  tool('bun', fake('bun'))
  for (const [n, b] of Object.entries(tools)) tool(n, b)
  const env = {
    ...withoutInherited(cleanEnv()),
    CI_MAX_LOAD: '0',
    CI_POLL: '0.05',
    CI_LOCK_TIMEOUT: '30',
    TALOS_CI_NESTED: '0',
    CI_SLOTS: '1',
    GATE_LOAD: '0', // an idle machine unless a test says otherwise: the real load never decides a test (scripts/talos-machine.sh)
    ...harnessEnv(T, bin, home), // PATH is the private folder alone; HOME is the test's
    GH_LOG: join(T, 'gh.log'),
    CALLS: calls,
    TMPDIR: T,
  }
  const start = (args: string[], extra: Record<string, string> = {}) => {
    const child = spawn('bash', [copy, ...args], { cwd: clone, env: { ...env, ...extra } })
    live.push(child)
    let out = ''
    child.stdout?.on('data', (d) => {
      out += d
    })
    child.stderr?.on('data', (d) => {
      out += d
    })
    const done = new Promise<number>((r) => child.on('exit', (c, s) => r(c ?? (s ? 128 : -1))))
    return { child, done, out: () => out }
  }
  const log = (job: string, dir = '') => {
    const sha = git(clone, 'rev-parse', '--short=7', 'HEAD')
    return readFileSync(join(home, '.cache/talos-ci/logs', dir, `${sha}-${job}.log`), 'utf8')
  }
  return {
    T,
    home,
    clone,
    git,
    start,
    log,
    env,
    calledLines: () => readFileSync(calls, 'utf8').trim().split('\n'),
    allowRefused: () => {
      sandbox.allowed = true // this test expects a refusing stub to be called
    },
  }
}
const noStatus = ['--ref', 'HEAD', '--no-status']

describe('ci-local.sh gates', () => {
  // Everything the check and browser jobs run. Running side by side must not turn any of these into a step that cannot fail.
  const gates = [
    ['check', 'typecheck '],
    ['check', 'typecheck:mod'],
    ['check', 'lint'],
    ['check', 'test --maxWorkers'],
    ['check', '--only test/schedules/'],
    ['check', '--skip test/schedules/'],
    ['check', 'test:contract'],
    ['check', 'notices:check'],
    ['browser', 'playwright install'],
    ['browser', 'test:browser'],
    ['browser', 'test:e2e'],
  ]

  it.each(gates)('%s: a failing %s fails the run', async (job, step) => {
    const r = repo()
    const run = r.start([...noStatus, '--jobs', job as string], { FAIL_ON: step as string })
    expect(await run.done).toBe(1)
    expect(run.out()).toContain(`✗ ${job}`)
  })

  describe('the browser job: one failing part never hides the next', () => {
    it('a failing browser suite does not hide the e2e suite, which runs with --no-bail, and the job still fails', async () => {
      const r = repo()
      const run = r.start(['--ref', 'HEAD', '--jobs', 'browser'], { FAIL_ON: 'test:browser' })
      expect(await run.done).toBe(1)
      expect(run.out()).toContain('✗ browser')
      expect(r.calledLines().some((l) => l.includes('--no-bail') && l.includes('test:e2e'))).toBe(true)
      expect(readFileSync(r.env.GH_LOG, 'utf8')).not.toMatch(/state=success .*context=local-ci\/browser/)
    })

    it('a failing e2e suite fails the job', async () => {
      const r = repo()
      const run = r.start(['--ref', 'HEAD', '--jobs', 'browser'], { FAIL_ON: 'test:e2e' })
      expect(await run.done).toBe(1)
      expect(readFileSync(r.env.GH_LOG, 'utf8')).not.toMatch(/state=success .*context=local-ci\/browser/)
    })

    it('the tests run, and the job posts success', async () => {
      const r = repo()
      const run = r.start(['--ref', 'HEAD', '--jobs', 'browser'])
      expect(await run.done).toBe(0)
      expect(r.calledLines().some((l) => l.includes('test:browser'))).toBe(true)
      expect(r.calledLines().some((l) => l.includes('test:e2e'))).toBe(true)
      expect(readFileSync(r.env.GH_LOG, 'utf8')).toMatch(/state=success .*context=local-ci\/browser/)
    })
  })

  // Steps that warn: a failure reaches the run's output and the job's log, and the job stays green.
  const warnings = [
    ['check:personal', 'personal data found'],
    ['audit --prod --audit-level high', 'a high or critical advisory'],
  ]

  it('the typecheck is the default compiler on a push run; the nightly adds one tsc pass of typecheck and typecheck:mod (TALOS_TYPECHECK=tsc)', async () => {
    const push = repo()
    expect(await push.start([...noStatus, '--jobs', 'check']).done).toBe(0)
    const typechecks = (r: ReturnType<typeof repo>) => r.calledLines().filter((l) => /^pnpm typecheck(:mod)? /.test(l))
    expect(typechecks(push)).toHaveLength(2)
    expect(typechecks(push).some((l) => l.includes('TALOS_TYPECHECK=tsc'))).toBe(false)
    const night = repo()
    expect(await night.start([...noStatus, '--jobs', 'check'], { CI_NIGHTLY: '1' }).done).toBe(0)
    const lines = typechecks(night)
    expect(lines).toHaveLength(4)
    expect(lines.filter((l) => l.includes('TALOS_TYPECHECK=tsc')).map((l) => l.split(' ')[1])).toEqual([
      'typecheck',
      'typecheck:mod',
    ])
  })

  it('the nightly’s tsc pass failing turns the nightly red, and the suites and the audit still run; a push run never runs that pass', async () => {
    const night = repo()
    const run = night.start([...noStatus, '--jobs', 'check'], { CI_NIGHTLY: '1', FAIL_ON_TSC: '1' })
    expect(await run.done).not.toBe(0)
    expect(night.log('check', 'nightly')).toContain("(tsc, the nightly's second look)")
    const lines = night.calledLines().join('\n')
    for (const later of ['test:contract', 'audit --prod --audit-level high']) expect(lines).toContain(later)
    const push = repo()
    expect(await push.start([...noStatus, '--jobs', 'check'], { FAIL_ON_TSC: '1' }).done).toBe(0)
  })

  it('a green check job ran every step, with nothing dropped', async () => {
    const r = repo()
    expect(await r.start([...noStatus, '--jobs', 'check']).done).toBe(0)
    const lines = r.calledLines().join('\n')
    const steps = [
      ...gates.filter(([job]) => job === 'check').map(([, step]) => step),
      ...warnings.map(([step]) => step),
    ]
    for (const step of steps) expect(lines).toContain(step as string)
  })

  it.each(warnings)('check: a failing %s warns and the job still passes', async (step, words) => {
    const r = repo()
    const run = r.start([...noStatus, '--jobs', 'check'], { FAIL_ON: step as string })
    expect(await run.done).toBe(0)
    expect(run.out()).toContain(`! warning: ${words}`)
    expect(run.out()).toContain('✓ check')
    expect(r.log('check')).toContain(`warning: ${words}`)
  })

  // the installer tests with a corepack pnpm first on PATH (KIT-8): a Mac's step (uname says Darwin), in the loud suites hold
  const uname = (os: string) => ({ uname: `[ "$1" = -s ] && { echo ${os}; exit 0; }\nexec /usr/bin/uname "$@"` })
  it('check: a failing corepack variant fails the run, on a Mac', async () => {
    const r = repo('', uname('Darwin'))
    const run = r.start([...noStatus, '--jobs', 'check'], { FAIL_ON: 'test:corepack-install' })
    expect(await run.done).toBe(1)
    expect(run.out()).toContain('✗ check')
  })

  it('check: the corepack variant runs after the suites that run side by side, in the same hold of the suites lock', async () => {
    const r = repo('', uname('Darwin'))
    expect(await r.start([...noStatus, '--jobs', 'check']).done).toBe(0)
    expect(r.calledLines().filter((l) => l.includes('test:corepack-install'))).toHaveLength(1)
    const log = r.log('check')
    expect(log.indexOf('+ step_corepack_install')).toBeGreaterThan(log.indexOf('+ step_vitest'))
    // one hold for the loud group: the corepack step is inside loud_suites, not behind a second take of the mutex
    expect(log).toMatch(/ci_mutex .* suites loud_suites/)
    expect(log).not.toMatch(/ci_mutex .* suites step_corepack_install/)
  })

  it('check: the corepack variant is skipped, and said so, off a Mac (Titan runs the whole check on Linux)', async () => {
    const r = repo('', uname('Linux'))
    const run = r.start([...noStatus, '--jobs', 'check'])
    expect(await run.done).toBe(0)
    expect(r.calledLines().some((l) => l.includes('test:corepack-install'))).toBe(false)
    expect(r.log('check')).toContain('with a corepack pnpm skipped: they run on a Mac only')
  })

  it('a failing audit does not stop the suites, and a failing suite does not skip the audit', async () => {
    const a = repo()
    expect(await a.start([...noStatus, '--jobs', 'check'], { FAIL_ON: 'audit --prod' }).done).toBe(0)
    const ran = a.calledLines().join('\n')
    expect(ran).toContain('test --maxWorkers')
    expect(ran).toContain('test:contract')

    const b = repo()
    expect(await b.start([...noStatus, '--jobs', 'check'], { FAIL_ON: 'test --maxWorkers' }).done).toBe(1)
    expect(b.calledLines().join('\n')).toContain('audit --prod --audit-level high')
  })

  it('every suite that ran side by side reaches the job log whole, in a fixed order', async () => {
    const r = repo()
    expect(await r.start([...noStatus, '--jobs', 'check']).done).toBe(0)
    const log = r.log('check')
    const at = ['step_contract', 'step_bun_schedules', 'step_bun_rest', 'step_vitest'].map((s) => log.indexOf(`+ ${s}`))
    expect(at.every((n) => n >= 0)).toBe(true)
    expect(at).toEqual([...at].sort((a, b) => a - b))
    expect(log).toMatch(/\[step\] \d+s exit 0: step_bun_rest/)
  })

  it('a rerun of the same commit keeps the earlier logs in logs/prev; the latest keeps its name', async () => {
    const r = repo()
    expect(await r.start([...noStatus, '--jobs', 'check'], { FAIL_ON: 'lint' }).done).toBe(1)
    const first = r.log('check')
    const firstSetup = readFileSync(
      join(r.home, '.cache/talos-ci/logs', `${r.git(r.clone, 'rev-parse', '--short=7', 'HEAD')}-setup.log`),
      'utf8',
    )
    expect(first).toMatch(/exit 1: pnpm lint/)
    expect(await r.start([...noStatus, '--jobs', 'check']).done).toBe(0)
    expect(r.log('check')).not.toMatch(/exit 1: pnpm lint/)
    const prev = join(r.home, '.cache/talos-ci/logs/prev')
    const kept = readdirSync(prev)
    const sha = r.git(r.clone, 'rev-parse', '--short=7', 'HEAD')
    const checkKept = kept.filter((f) => f.startsWith(`${sha}-check.`) && f.endsWith('.log'))
    const setupKept = kept.filter((f) => f.startsWith(`${sha}-setup.`) && f.endsWith('.log'))
    expect(checkKept).toHaveLength(1)
    expect(readFileSync(join(prev, checkKept[0] as string), 'utf8')).toBe(first)
    expect(setupKept).toHaveLength(1)
    expect(readFileSync(join(prev, setupKept[0] as string), 'utf8')).toBe(firstSetup)
    // a third run keeps both earlier ones, not just the last
    expect(await r.start([...noStatus, '--jobs', 'check']).done).toBe(0)
    expect(readdirSync(prev).filter((f) => f.startsWith(`${sha}-check.`))).toHaveLength(2)
  })

  it('check no longer runs the schedules capture check (the capture tests cover it)', async () => {
    const r = repo()
    expect(await r.start([...noStatus, '--jobs', 'check']).done).toBe(0)
    expect(r.log('check')).not.toContain('step_capture')
    expect(r.calledLines().join('\n')).not.toContain('capture-schedules')
  })

  it('a commit forked before the parallel runner still runs the whole bridge suite', async () => {
    const r = repo()
    r.git(r.clone, 'rm', '-q', 'apps/bridge/scripts/test-parallel.ts')
    r.git(r.clone, 'commit', '-qm', 'old')
    expect(await r.start([...noStatus, '--jobs', 'check']).done).toBe(0)
    expect(r.calledLines().some((l) => l.startsWith('pnpm test:bun'))).toBe(true)
  })

  // Chronos's own suite (apps/chronos/tests/run.sh: each test file by itself; a bare `python3 -m unittest` in apps/chronos finds
  // none). It waits on real clocks and processes, so it runs in the quiet hold, after the schedules tests, and needs Python 3.9+.
  describe('check: the Chronos suite', () => {
    type Repo = ReturnType<typeof repo>
    const withChronos = (r: Repo, body = 'exit 0') => {
      mkdirSync(join(r.clone, 'apps/chronos/tests'), { recursive: true })
      writeFileSync(
        join(r.clone, 'apps/chronos/tests/run.sh'),
        `#!/bin/bash\necho "chronos-run $* PR_BASE=\${CHRONOS_PR_BASE:-}" >> "$CALLS"\n${body}\n`,
      )
      r.git(r.clone, 'add', '-A')
      r.git(r.clone, 'commit', '-qm', 'chronos')
    }
    // the version test the step makes (`python3 -c` with sys.version_info), answered as FAKE_PY says: `old` is Python 3.8
    const python3 = {
      python3:
        'case "$1" in -c) [ "${FAKE_PY:-}" = old ] && exit 1; exit 0 ;; --version) if [ "${FAKE_PY:-}" = old ]; then echo "Python 3.8.2"; else echo "Python 3.12.1"; fi ;; esac',
    }
    const runs = (r: Repo) => r.calledLines().filter((l) => l.startsWith('chronos-run'))
    const row = (r: Repo) =>
      (readFileSync(join(r.home, '.cache/talos-ci/logs/timings.tsv'), 'utf8').trim().split('\n').pop() as string).split(
        '\t',
      )

    it("runs Chronos's own runner once, after the schedules tests, without a PR base, and the job passes", async () => {
      const r = repo('', python3)
      withChronos(r)
      // a CHRONOS_PR_BASE in the runner's environment must not reach it: the range scan skips in CI
      expect(await r.start([...noStatus, '--jobs', 'check'], { CHRONOS_PR_BASE: 'origin/main' }).done).toBe(0)
      expect(runs(r)).toEqual(['chronos-run  PR_BASE='])
      const log = r.log('check')
      expect(log).toContain('+ step_chronos')
      expect(log.indexOf('+ step_chronos')).toBeGreaterThan(log.indexOf('+ step_bun_schedules'))
      expect(log).toMatch(/\[step\] \d+s exit 0: step_chronos/)
    })

    it('a failing Chronos test fails the check job', async () => {
      const r = repo('', python3)
      withChronos(r, 'echo "FAIL: test_x"; exit 1')
      const run = r.start([...noStatus, '--jobs', 'check'])
      expect(await run.done).toBe(1)
      expect(run.out()).toContain('✗ check')
      expect(r.log('check')).toContain('FAIL: test_x')
    })

    it('a red Chronos suite in a check part (ci-part/) is a red, never "not tested"', async () => {
      const r = repo('', python3)
      withChronos(r, 'exit 1')
      const run = r.start([...noStatus, '--jobs', 'check'], { CI_STATUS_PREFIX: 'ci-part' })
      expect(await run.done).toBe(1)
      expect(runs(r)).toHaveLength(1) // it ran: the red is Chronos's, not an early stop
      expect(r.log('check')).not.toContain('not tested')
    })

    it('a failing contract or schedules suite does not hide the Chronos suite', async () => {
      const r = repo('', python3)
      withChronos(r)
      expect(await r.start([...noStatus, '--jobs', 'check'], { FAIL_ON: 'test:contract' }).done).toBe(1)
      expect(runs(r)).toHaveLength(1)
    })

    it('is skipped, and said so, where python3 is older than 3.9; the job still passes', async () => {
      const r = repo('', python3)
      withChronos(r)
      expect(await r.start([...noStatus, '--jobs', 'check'], { FAKE_PY: 'old' }).done).toBe(0)
      expect(runs(r)).toEqual([])
      expect(r.log('check')).toContain('the Chronos suite skipped: python3 3.9 or newer is needed')
    })

    it('is skipped, and said so, by a commit that has no apps/chronos', async () => {
      const r = repo('', python3)
      expect(await r.start([...noStatus, '--jobs', 'check']).done).toBe(0)
      expect(r.log('check')).toContain('the Chronos suite skipped: this commit has no apps/chronos')
    })

    it('its time is a column of timings.tsv, appended after the bun column; - when it did not run', async () => {
      const a = repo('', python3)
      withChronos(a)
      expect(await a.start([...noStatus, '--jobs', 'check']).done).toBe(0)
      expect(row(a)[10]).toMatch(/^bun=/)
      expect(row(a)[11]).toMatch(/^chronos=\d+$/)
      const b = repo('', python3)
      expect(await b.start([...noStatus, '--jobs', 'check']).done).toBe(0)
      expect(row(b)[11]).toBe('chronos=-')
    })
  })
})

// A red suite never hides the ones after it. A push run stops at the first red one and says what it left out, one
// `NOT RUN: <suite> (<why>)` line each; a hostile run (CI_HOSTILE=1) runs the later suites too, and the job still fails.
describe('check: a red suite and the suites after it', () => {
  const uname = { uname: '[ "$1" = -s ] && { echo Darwin; exit 0; }\nexec /usr/bin/uname "$@"' }
  const QUIET_RED = 'step_contract, step_bun_schedules or step_chronos failed'
  const notRun = (log: string) => log.split('\n').filter((l) => l.startsWith('NOT RUN: '))
  const ran = (r: ReturnType<typeof repo>, what: string) => r.calledLines().some((l) => l.includes(what))

  it('a red contract suite: the schedules suite and the loud suites are NOT RUN, each said once, and they never ran', async () => {
    const r = repo('', uname)
    expect(await r.start([...noStatus, '--jobs', 'check'], { FAIL_ON: 'test:contract' }).done).toBe(1)
    expect(notRun(r.log('check'))).toEqual([
      'NOT RUN: step_bun_schedules (step_contract failed)',
      `NOT RUN: step_bun_rest (${QUIET_RED})`,
      `NOT RUN: step_vitest (${QUIET_RED})`,
      `NOT RUN: step_corepack_install (${QUIET_RED})`,
    ])
    for (const what of [
      '--only test/schedules/',
      '--skip test/schedules/',
      'test --maxWorkers',
      'test:corepack-install',
    ])
      expect(ran(r, what), what).toBe(false)
  })

  it('a hostile run runs every later suite after a red one, says nothing NOT RUN, and the job still fails', async () => {
    const r = repo('', uname)
    const run = r.start([...noStatus, '--jobs', 'check'], { FAIL_ON: 'test:contract', CI_HOSTILE: '1' })
    expect(await run.done, run.out()).toBe(1)
    expect(notRun(r.log('check', 'hostile'))).toEqual([]) // a hostile run's own log folder
    for (const what of [
      '--only test/schedules/',
      '--skip test/schedules/',
      'test --maxWorkers',
      'test:corepack-install',
    ])
      expect(ran(r, what), what).toBe(true)
    expect(run.out()).toContain('✗ check')
  })

  it('a red bun rest suite: the corepack variant is NOT RUN (Vitest beside it still ran); a hostile run runs it', async () => {
    const a = repo('', uname)
    expect(await a.start([...noStatus, '--jobs', 'check'], { FAIL_ON: '--skip test/schedules/' }).done).toBe(1)
    expect(notRun(a.log('check'))).toEqual(['NOT RUN: step_corepack_install (step_bun_rest or step_vitest failed)'])
    expect(ran(a, 'test --maxWorkers')).toBe(true)
    const b = repo('', uname)
    expect(
      await b.start([...noStatus, '--jobs', 'check'], { FAIL_ON: '--skip test/schedules/', CI_HOSTILE: '1' }).done,
    ).toBe(1)
    expect(notRun(b.log('check', 'hostile'))).toEqual([])
    expect(ran(b, 'test:corepack-install')).toBe(true)
  })

  // One test for each red step and each of hostile or not: six ci-local runs in one test took 14 s alone, and over its 60 s under the
  // push gate's load (it timed out at 60,010 ms, 07:00 on 11-25), where each run alone has a budget of its own.
  it.each(
    ['', '1'].flatMap((hostile) =>
      (
        [
          ['typecheck ', ['typecheck:mod', 'lint', 'notices:check']],
          ['typecheck:mod', ['lint', 'notices:check']],
          ['lint', ['notices:check']],
        ] as const
      ).map(([red, after]) => ({ hostile, red, after })),
    ),
  )(
    'a red quick gate ($red, hostile=$hostile) leaves out the gates after it, every suite and the audit, each said with the red step named (hostile too: they are no suite)',
    async ({ hostile, red, after }) => {
      const r = repo('', uname)
      const run = r.start([...noStatus, '--jobs', 'check'], { FAIL_ON: red, CI_HOSTILE: hostile })
      expect(await run.done).toBe(1)
      const why = `pnpm ${red.trim()} failed`
      expect(notRun(r.log('check', hostile ? 'hostile' : ''))).toEqual(
        [
          ...after,
          'step_contract',
          'step_bun_schedules',
          'step_chronos',
          'step_bun_rest',
          'step_vitest',
          'step_corepack_install',
          'audit',
        ].map((n) => `NOT RUN: ${n} (${why})`),
      )
      expect(ran(r, 'test:contract'), `${red} hostile=${hostile}`).toBe(false)
      expect(ran(r, 'audit --prod'), `${red} hostile=${hostile}`).toBe(false)
    },
  )

  it('a green run says nothing NOT RUN', async () => {
    const r = repo('', uname)
    expect(await r.start([...noStatus, '--jobs', 'check']).done).toBe(0)
    expect(notRun(r.log('check'))).toEqual([])
  })
})

// A hostile or nightly run of a commit shares its sha with the push run, and a rerun moves the earlier logs of a name away: so
// each kind of run has a log folder of its own (ci_logs_dir), and the push run's logs, prev/ and timings.tsv are never touched.
describe("check: the logs of a hostile or nightly run are not the push run's", () => {
  const kinds = [
    ['hostile', 'CI_HOSTILE', 'hostile'],
    ['nightly', 'CI_NIGHTLY', 'nightly'],
  ] as const
  it.each(kinds)(
    "a %s run of the same commit leaves the push run's log, prev/ and timings.tsv alone",
    async (_k, env, dir) => {
      const r = repo()
      const logs = join(r.home, '.cache/talos-ci/logs')
      const sha = r.git(r.clone, 'rev-parse', '--short=7', 'HEAD')
      expect(await r.start([...noStatus, '--jobs', 'check']).done).toBe(0)
      const pushLog = readFileSync(join(logs, `${sha}-check.log`), 'utf8')
      const pushRows = readFileSync(join(logs, 'timings.tsv'), 'utf8')
      const pushSetup = readFileSync(join(logs, `${sha}-setup.log`), 'utf8')
      expect(await r.start([...noStatus, '--jobs', 'check'], { FAIL_ON: 'lint', [env]: '1' }).done).toBe(1)
      // the push run's files are as it left them, and nothing was moved to prev/
      expect(readFileSync(join(logs, `${sha}-check.log`), 'utf8')).toBe(pushLog)
      expect(readFileSync(join(logs, `${sha}-setup.log`), 'utf8')).toBe(pushSetup)
      expect(readFileSync(join(logs, 'timings.tsv'), 'utf8')).toBe(pushRows)
      expect(existsSync(join(logs, 'prev'))).toBe(false)
      // the run's own are in its folder, and a rerun of it rotates there
      const own = join(logs, dir)
      expect(readFileSync(join(own, `${sha}-check.log`), 'utf8')).toMatch(/exit 1: pnpm lint/)
      expect(readFileSync(join(own, 'timings.tsv'), 'utf8').trim().split('\n')).toHaveLength(1)
      expect(await r.start([...noStatus, '--jobs', 'check'], { [env]: '1' }).done).toBe(0)
      expect(readdirSync(join(own, 'prev')).filter((f) => f.startsWith(`${sha}-check.`))).toHaveLength(1)
      expect(readFileSync(join(logs, `${sha}-check.log`), 'utf8')).toBe(pushLog)
      expect(readFileSync(join(logs, 'timings.tsv'), 'utf8')).toBe(pushRows)
    },
  )

  it("ci-subset-report reads the push run's walls, never a hostile run's of the same commit (it showed hostile walls for 43db7b2)", async () => {
    // a slow hostile run: its check job takes 6 s longer than the push run's
    const r = repo('step_contract() { [ -z "${SLOWMO:-}" ] || sleep 6; }')
    const logs = join(r.home, '.cache/talos-ci/logs')
    const sha = r.git(r.clone, 'rev-parse', '--short=7', 'HEAD')
    expect(await r.start([...noStatus, '--jobs', 'check']).done).toBe(0)
    appendFileSync(join(logs, `${sha}-check.log`), 'the macOS-only tests, here: x\n') // what a check with Titan on logs
    const wallOf = (dir: string) => timingsFor(readFileSync(join(logs, dir, 'timings.tsv'), 'utf8'), sha)?.check
    const pushWall = wallOf('')
    expect(await r.start([...noStatus, '--jobs', 'check'], { CI_HOSTILE: '1', SLOWMO: '1' }).done).toBe(0)
    // no wall-time limit: the push run's row is the same after the hostile run, the hostile run's is in its own folder, and the
    // report shows the push run's
    expect(wallOf('')).toBe(pushWall)
    expect(wallOf('hostile')).not.toBe(pushWall)
    expect(report(logs, { shas: [sha] })).toContain(`| ${pushWall}/-/-/- |`)
  })

  it('a failed job says in its status where its log is: the folder of its own kind of run', async () => {
    for (const [extra, dir] of [
      [{ CI_HOSTILE: '1' }, 'hostile/'],
      [{ CI_NIGHTLY: '1' }, 'nightly/'],
      [{}, ''],
    ] as const) {
      const r = repo()
      const sha = r.git(r.clone, 'rev-parse', '--short=7', 'HEAD')
      expect(await r.start(['--ref', 'HEAD', '--jobs', 'check'], { FAIL_ON: 'lint', ...extra }).done).toBe(1)
      expect(readFileSync(r.env.GH_LOG as string, 'utf8')).toContain(
        `see ~/.cache/talos-ci/logs/${dir}${sha}-check.log`,
      )
    }
  })
})

// The mod job runs the real Claude CLI and a throwaway npm copy of it (claude_at). It reaches them only with CI_MOD_REAL=1, which the
// CI runner sets and a hand run sets on purpose; a probe or a test never does. Every test here puts stubs for claude and npm first
// on the PATH that write a marker, and the real binaries are never named: nothing falls through to them.
describe('the mod job reaches claude and npm only on purpose (CI_MOD_REAL=1)', () => {
  const stubs = {
    claude: `case "$1" in --version) echo "\${FAKE_CLAUDE_VERSION:-2.1.312} (Claude Code)"; exit 0 ;; esac\necho "claude \${CI_MOD_REAL:-unset} $*" >> "$MARKER"`,
    npm: 'echo "npm ${CI_MOD_REAL:-unset} $*" >> "$MARKER"',
  }
  const modRepo = (version = '2.1.312') => {
    const r = repo('', stubs)
    mkdirSync(join(r.clone, 'plugins/talos-app-mod'), { recursive: true })
    writeFileSync(join(r.clone, 'plugins/talos-app-mod/CLAUDE_CODE_VERSION'), `${version}\n`)
    r.git(r.clone, 'add', '-A')
    r.git(r.clone, 'commit', '-qm', 'mod')
    const marker = join(r.T, 'marker')
    const go = (extra: Record<string, string> = {}, ...args: string[]) =>
      r.start([...noStatus, '--jobs', 'mod', ...args], { MARKER: marker, ...extra })
    const reached = () => (existsSync(marker) ? readFileSync(marker, 'utf8') : '')
    return { r, go, reached }
  }
  const REFUSED = 'claude_at: refused: the mod job runs the real claude and npm only with CI_MOD_REAL=1'

  it('without CI_MOD_REAL the job is red with one plain line, and neither claude nor npm is reached', async () => {
    const { r, go, reached } = modRepo()
    const run = go()
    expect(await run.done, run.out()).toBe(1)
    expect(run.out()).toContain('✗ mod')
    expect(r.log('mod')).toContain(REFUSED)
    expect(r.log('mod')).not.toContain('not tested')
    expect(reached()).toBe('') // no `npm exec` and no claude run was made
  })

  it('a CI_MOD_REAL that is not exactly 1 refuses too', async () => {
    for (const v of ['0', 'yes', '']) {
      const { go, reached } = modRepo()
      expect(await go({ CI_MOD_REAL: v }).done, v).toBe(1)
      expect(reached(), v).toBe('')
    }
  })

  it('with CI_MOD_REAL=1 the stubs are called: the local claude when its version is the pinned one, else a throwaway npm copy', async () => {
    const a = modRepo()
    expect(await a.go({ CI_MOD_REAL: '1' }).done).toBe(0)
    expect(a.reached()).toMatch(/^claude unset plugin validate plugins\/talos-app-mod\nclaude unset plugin test /)
    const b = modRepo()
    expect(await b.go({ CI_MOD_REAL: '1', FAKE_CLAUDE_VERSION: '9.9.9' }).done).toBe(0)
    expect(b.reached()).toContain(
      'npm unset exec --yes --package=@anthropic-ai/claude-code@2.1.312 -- claude plugin validate',
    )
    expect(b.reached()).not.toContain('claude unset plugin') // the local one answered --version only
  })

  it('the variable is not in the environment of anything the job starts (ci-local keeps it to its own shell)', async () => {
    const { go, reached } = modRepo()
    expect(await go({ CI_MOD_REAL: '1' }).done).toBe(0)
    expect(reached()).not.toMatch(/CI_MOD_REAL|claude 1 /) // the stubs print the value they see: "unset"
    expect(reached()).toContain('claude unset ')
  })

  it('an empty or malformed version is refused with the variable set, and nothing is reached', async () => {
    for (const v of ['', '2.1', 'v2.1.312', '2.1.312-beta', '$(touch x)', '2.1.x']) {
      const { r, go, reached } = modRepo(v)
      const run = go({ CI_MOD_REAL: '1' })
      expect(await run.done, v).toBe(1)
      expect(r.log('mod'), v).toContain('claude_at: refused: the Claude Code version is')
      expect(reached(), v).toBe('')
    }
  })

  it('latest is a version too: the advisory run (--latest) is allowed with the variable, and still refused without', async () => {
    const a = modRepo()
    expect(await a.go({ CI_MOD_REAL: '1' }, '--latest').done).toBe(0)
    expect(a.reached()).toContain('claude-code@latest')
    const b = modRepo()
    expect(await b.go({}, '--latest').done).toBe(1)
    expect(b.reached()).toBe('')
  })
})

// The NOT RUN lines are written twice: into the job log for a person, and into <short>-<job>.notrun beside it, the only file a report
// reads (a test that prints "NOT RUN: ..." into the log is not a suite left out).
describe('check: the .notrun file beside the job log', () => {
  const side = (r: ReturnType<typeof repo>, dir = '') => {
    const sha = r.git(r.clone, 'rev-parse', '--short=7', 'HEAD')
    return readFileSync(join(r.home, '.cache/talos-ci/logs', dir, `${sha}-check.notrun`), 'utf8')
  }
  const lines = (text: string) => text.split('\n').filter((l) => l.startsWith('NOT RUN: '))

  it('holds the same NOT RUN lines as the log; a rerun starts it empty', async () => {
    const r = repo()
    expect(await r.start([...noStatus, '--jobs', 'check'], { FAIL_ON: 'test:contract' }).done).toBe(1)
    const want = lines(r.log('check'))
    expect(want.length).toBeGreaterThan(0)
    expect(side(r)).toBe(`${want.join('\n')}\n`)
    expect(await r.start([...noStatus, '--jobs', 'check']).done).toBe(0)
    expect(side(r)).toBe('')
  })

  it('a line a test prints into the log is in the log, not in the file', async () => {
    const r = repo('', { pnpm: 'echo "NOT RUN: step_printed (by a test)"; exit 0' })
    expect(await r.start([...noStatus, '--jobs', 'check']).done).toBe(0)
    expect(r.log('check')).toContain('NOT RUN: step_printed (by a test)')
    expect(side(r)).toBe('')
  })

  it("a run of other jobs on the same commit keeps the first run's .notrun (the runner's fallback runs a job or two of it)", async () => {
    const r = repo()
    expect(await r.start([...noStatus, '--jobs', 'check'], { FAIL_ON: 'test:contract' }).done).toBe(1)
    const first = side(r)
    expect(first).not.toBe('')
    // another run of the commit, for another job: the lines of the first run are still there for its report
    expect(await r.start([...noStatus, '--jobs', 'mod']).done).toBe(1)
    expect(side(r)).toBe(first)
  })

  it('not_run writes clean lines: control characters out, a line at most 300 characters, the file at most 200 lines', () => {
    const T = mkdtempSync(join(tmpdir(), 'cinr-'))
    dirs.push(T)
    const log = join(T, 'x-check.log')
    const r = spawnSync(
      'bash',
      [
        '-c',
        `. "${join(here, 'ci-local/jobs-check.sh')}"
not_run "$LOG" "$WHY" "$SUITE"
not_run "$LOG" why "$LONG"
for i in $(seq 1 250); do not_run "$LOG" why "s$i"; done`,
      ],
      {
        encoding: 'utf8',
        env: {
          PATH: process.env.PATH ?? '',
          LOG: log,
          WHY: 'a b\u001b[1m\r\u0007c',
          SUITE: 'red\u001bsuite',
          LONG: 'x'.repeat(500),
        },
      },
    )
    expect(r.status, r.stderr).toBe(0)
    const file = readFileSync(join(T, 'x-check.notrun'), 'utf8').split('\n').filter(Boolean)
    expect(file).toHaveLength(200)
    expect(file[0]).toBe('NOT RUN: redsuite (a b[1mc)')
    expect(file[1]?.length).toBe(300)
    expect([...file.join('')].some((c) => c < ' ' || c === '\u007f')).toBe(false)
    expect(readFileSync(log, 'utf8').split('\n').filter(Boolean)).toHaveLength(252) // the log keeps every line
  })
})

// Everywhere a job leaves steps out, it says so: a NOT RUN line each, in the log and in the .notrun file a report reads. A lock not
// had in time is simulated by a ci_mutex that refuses (the command never starts); every tool is a stub.
describe('every place a job leaves steps out says NOT RUN', () => {
  const LOCK_OFF = (fn: string, which = 'ci_mutex') =>
    `eval "orig_$(declare -f ${which})"\n${which}() { [ "$3" = ${fn} ] && return 1; orig_${which} "$@"; }`
  const notRun = (text: string) => text.split('\n').filter((l) => l.startsWith('NOT RUN: '))
  const names = (text: string) => notRun(text).map((l) => l.replace(/^NOT RUN: /, '').replace(/ \(.*$/, ''))
  const ran = (r: ReturnType<typeof repo>, what: string) => r.calledLines().some((l) => l.includes(what))
  const side = (r: ReturnType<typeof repo>, job: string, dir = '') => {
    const sha = r.git(r.clone, 'rev-parse', '--short=7', 'HEAD')
    return readFileSync(join(r.home, '.cache/talos-ci/logs', dir, `${sha}-${job}.notrun`), 'utf8')
  }
  const uname = { uname: '[ "$1" = -s ] && { echo Darwin; exit 0; }\nexec /usr/bin/uname "$@"' }
  const SUITES = [
    'step_contract',
    'step_bun_schedules',
    'step_chronos',
    'step_bun_rest',
    'step_vitest',
    'step_corepack_install',
  ]

  it('setup red (pnpm install): check says every step it did not run, the browser job its two', async () => {
    const a = repo('', uname)
    expect(await a.start([...noStatus, '--jobs', 'check'], { FAIL_ON: 'install' }).done).toBe(1)
    expect(names(a.log('check'))).toEqual(['typecheck', 'typecheck:mod', 'lint', 'notices:check', ...SUITES, 'audit'])
    expect(a.log('check')).toContain('NOT RUN: typecheck (setup failed: pnpm install)')
    expect(side(a, 'check')).toBe(`${notRun(a.log('check')).join('\n')}\n`)
    const b = repo()
    expect(await b.start([...noStatus, '--jobs', 'browser'], { FAIL_ON: 'install' }).done).toBe(1)
    expect(notRun(b.log('browser'))).toEqual([
      'NOT RUN: test:browser (setup failed: pnpm install)',
      'NOT RUN: test:e2e (setup failed: pnpm install)',
    ])
  })

  it('the browsers cannot be made ready (playwright install red): the browser job names its two steps', async () => {
    const r = repo()
    expect(await r.start([...noStatus, '--jobs', 'browser'], { FAIL_ON: 'playwright install' }).done).toBe(1)
    expect(notRun(r.log('browser'))).toEqual([
      'NOT RUN: test:browser (the browsers could not be made ready)',
      'NOT RUN: test:e2e (the browsers could not be made ready)',
    ])
  })

  it('the loud suites lock not had in time: the three loud steps are NOT RUN, in a push and a hostile run, and the job is red', async () => {
    for (const hostile of ['', '1']) {
      const r = repo(LOCK_OFF('loud_suites'), uname)
      expect(await r.start([...noStatus, '--jobs', 'check'], { CI_HOSTILE: hostile }).done, hostile).toBe(1)
      expect(notRun(r.log('check', hostile ? 'hostile' : ''))).toEqual(
        ['step_bun_rest', 'step_vitest', 'step_corepack_install'].map(
          (n) => `NOT RUN: ${n} (the suites lock was not had in time)`,
        ),
      )
    }
  })

  it('the quiet lock not had in time: a hostile run does not go on to a second wait, says the rest NOT RUN, and the check part stays "not tested"', async () => {
    const r = repo(LOCK_OFF('quiet_suites', 'ci_mutex_all'), uname)
    const run = r.start([...noStatus, '--jobs', 'check'], { CI_HOSTILE: '1', CI_STATUS_PREFIX: 'ci-part' })
    await run.done
    expect(names(r.log('check', 'hostile'))).toEqual(SUITES)
    expect(notRun(r.log('check', 'hostile')).every((l) => l.endsWith('(the suites lock was not had in time)'))).toBe(
      true,
    )
    // no loud suite ran: a real red there would have been hidden behind "not tested"
    expect(ran(r, 'test --maxWorkers')).toBe(false)
    expect(ran(r, '--skip test/schedules/')).toBe(false)
    expect(r.log('check', 'hostile')).toContain('not tested: the suites lock was not had in time')
  })

  it('a hostile check part whose quiet suite is red goes on to the loud suites, and a red there stays a red, never "not tested"', async () => {
    for (const red of ['test:contract', 'test --maxWorkers']) {
      const r = repo('', uname)
      const run = r.start([...noStatus, '--jobs', 'check'], {
        CI_HOSTILE: '1',
        CI_STATUS_PREFIX: 'ci-part',
        FAIL_ON: red,
      })
      expect(await run.done, red).toBe(1)
      expect(ran(r, 'test --maxWorkers'), red).toBe(true)
      expect(r.log('check', 'hostile'), red).not.toContain('not tested')
    }
  })

  it('a red mod validate leaves the plugin test NOT RUN', async () => {
    const claude = {
      claude:
        'case "$1" in --version) echo "2.1.312 (Claude Code)"; exit 0 ;; esac\n[ "$2" = validate ] && exit 1\nexit 0',
      npm: 'exit 1',
    }
    const r = repo('', claude)
    mkdirSync(join(r.clone, 'plugins/talos-app-mod'), { recursive: true })
    writeFileSync(join(r.clone, 'plugins/talos-app-mod/CLAUDE_CODE_VERSION'), '2.1.312\n')
    r.git(r.clone, 'add', '-A')
    r.git(r.clone, 'commit', '-qm', 'mod')
    expect(await r.start([...noStatus, '--jobs', 'mod'], { CI_MOD_REAL: '1' }).done).toBe(1)
    expect(notRun(r.log('mod'))).toEqual(['NOT RUN: claude plugin test (claude plugin validate failed)'])
  })

  describe('the Swift jobs (every tool a stub; no simulator, no xcodebuild)', () => {
    const swiftRepo = (jobs = '', tools: Record<string, string> = {}) => {
      const stub = (n: string) =>
        `echo "${n} $*" >> "$CALLS"\n[ -n "\${FAIL_ON:-}" ] && [[ "$* " == *"$FAIL_ON"* ]] && exit 1\nexit 0`
      const r = repo(jobs, {
        swift: stub('swift'),
        xcodegen: stub('xcodegen'),
        xcodebuild: stub('xcodebuild'),
        ...tools,
      })
      cpSync(join(here, 'ci-swift-retry.sh'), join(r.clone, 'scripts/ci-swift-retry.sh'))
      for (const d of [
        'BridgeGuard',
        'TalosAudioCore',
        'TalosCrashCore',
        'TalosPushCore',
        'TalosRelayCore',
        'TalosShareCore',
      ]) {
        // git keeps no empty folder: each gets a file, so the worktree has it
        mkdirSync(join(r.clone, 'apps/mobile/ios', d), { recursive: true })
        writeFileSync(join(r.clone, 'apps/mobile/ios', d, '.keep'), '')
      }
      mkdirSync(join(r.clone, 'apps/mobile/ios/App'), { recursive: true })
      writeFileSync(join(r.clone, 'apps/mobile/ios/App/.keep'), '')
      writeFileSync(join(r.clone, 'apps/mobile/ios/TalosShareCore/test.sh'), 'exit 0\n')
      mkdirSync(join(r.clone, 'apps/desktop/scripts'), { recursive: true })
      writeFileSync(join(r.clone, 'apps/desktop/scripts/ci.sh'), 'exit 0\n') // never run: the desktop tests stop before it
      r.git(r.clone, 'add', '-A')
      r.git(r.clone, 'commit', '-qm', 'swift')
      return r
    }
    const MOBILE_AFTER = ['cap:sync', 'check:generated', 'generated-project-diff', 'xcodebuild-build', 'AppTests']

    it('mobile: a red BridgeGuard leaves every Swift step after it NOT RUN, down to AppTests', async () => {
      const r = swiftRepo()
      expect(await r.start([...noStatus, '--jobs', 'mobile'], { FAIL_ON: 'test --cache-path' }).done).toBe(1)
      expect(names(r.log('mobile'))).toEqual([
        'swift-test:TalosAudioCore',
        'swift-test:TalosCrashCore',
        'swift-test:TalosPushCore',
        'swift-test:TalosRelayCore',
        'TalosShareCore',
        ...MOBILE_AFTER,
      ])
      expect(notRun(r.log('mobile'))[0]).toBe('NOT RUN: swift-test:TalosAudioCore (swift-test:BridgeGuard failed)')
      expect(r.calledLines().some((l) => l.startsWith('xcodebuild'))).toBe(false)
    })

    it('mobile: a red xcodebuild leaves AppTests NOT RUN, and the simulator is never asked for', async () => {
      const r = swiftRepo()
      expect(await r.start([...noStatus, '--jobs', 'mobile'], { FAIL_ON: 'CODE_SIGNING_ALLOWED=NO build' }).done).toBe(
        1,
      )
      expect(notRun(r.log('mobile'))).toEqual(['NOT RUN: AppTests (xcodebuild-build failed)'])
    })

    it('mobile: the JS steps red or setup red leaves the whole Swift half NOT RUN', async () => {
      const a = swiftRepo()
      expect(await a.start([...noStatus, '--jobs', 'mobile'], { FAIL_ON: '@talos-app/mobile typecheck' }).done).toBe(1)
      expect(names(a.log('mobile')).slice(0, 2)).toEqual(['mobile-tests', 'swift-test:BridgeGuard'])
      expect(names(a.log('mobile'))).toContain('AppTests')
      expect(a.calledLines().some((l) => l.startsWith('swift '))).toBe(false)
      const b = swiftRepo()
      expect(await b.start([...noStatus, '--jobs', 'mobile'], { FAIL_ON: 'install' }).done).toBe(1)
      expect(names(b.log('mobile'))[0]).toBe('mobile-typecheck')
      expect(names(b.log('mobile'))).toContain('AppTests')
    })

    it('mobile: the desktop lock not had in time leaves the Swift half NOT RUN', async () => {
      const r = swiftRepo(LOCK_OFF('mobile_swift_steps'))
      expect(await r.start([...noStatus, '--jobs', 'mobile']).done).toBe(1)
      expect(notRun(r.log('mobile')).every((l) => l.endsWith('(the desktop lock was not had in time)'))).toBe(true)
      expect(names(r.log('mobile'))).toEqual([
        'swift-test:BridgeGuard',
        'swift-test:TalosAudioCore',
        'swift-test:TalosCrashCore',
        'swift-test:TalosPushCore',
        'swift-test:TalosRelayCore',
        'TalosShareCore',
        ...MOBILE_AFTER,
      ])
    })

    it('desktop: no usable tmux, or the desktop lock not had in time, leaves every ci.sh step NOT RUN, guards-test.sh with its six scripts', async () => {
      for (const [jobs, why] of [
        ['ci_tmux_ok() { return 1; }', 'no usable tmux (3.2 or newer)'],
        [`ci_tmux_ok() { return 0; }\n${LOCK_OFF('ci_pty_during')}`, 'the desktop lock was not had in time'],
      ]) {
        const r = swiftRepo(jobs)
        expect(await r.start([...noStatus, '--jobs', 'desktop'], { TALOS_CI_FORCE_DESKTOP: '1' }).done, why).toBe(1)
        const lines = notRun(r.log('desktop'))
        expect(lines).toHaveLength(15)
        expect(lines.every((l) => l.endsWith(`(${why})`))).toBe(true)
        expect(lines.some((l) => l.startsWith('NOT RUN: guards-test.sh(auto-update-apply-test.sh,'))).toBe(true)
        expect(side(r, 'desktop')).toBe(`${lines.join('\n')}\n`)
      }
    })
  })

  it('quiet_why writes quiet-done when the quiet hold was never had, so the Swift jobs and browser do not wait for it', () => {
    const T = mkdtempSync(join(tmpdir(), 'cinr-'))
    dirs.push(T)
    const r = spawnSync(
      'bash',
      [
        '-c',
        `RESULTS="${T}"; . "${join(here, 'ci-local/jobs-check.sh')}"; quiet_why "${T}/x-check.log" 1; echo "$QUIET_WHY"`,
      ],
      { encoding: 'utf8', env: { PATH: process.env.PATH ?? '' } },
    )
    expect(r.stdout.trim()).toBe('the suites lock was not had in time')
    expect(existsSync(join(T, 'quiet-done'))).toBe(true)
    expect(names(readFileSync(join(T, 'x-check.log'), 'utf8'))).toEqual([
      'step_contract',
      'step_bun_schedules',
      'step_chronos',
    ])
    // had (the marker is there): the file is the group's own to write
    const T2 = mkdtempSync(join(tmpdir(), 'cinr-'))
    dirs.push(T2)
    writeFileSync(join(T2, 'suites-quiet'), '')
    spawnSync(
      'bash',
      ['-c', `RESULTS="${T2}"; . "${join(here, 'ci-local/jobs-check.sh')}"; quiet_why "${T2}/x.log" 1`],
      {
        env: { PATH: process.env.PATH ?? '' },
      },
    )
    expect(existsSync(join(T2, 'quiet-done'))).toBe(false)
  })

  it('image: docker not running, a red build or a red check say what was not run', async () => {
    const docker = `echo "docker $*" >> "$CALLS"\n[ "$1" = build ] && cat > /dev/null\n[ -n "\${FAIL_ON:-}" ] && [[ "$* " == *"$FAIL_ON"* ]] && exit 1\nexit 0`
    const curl = 'case "$*" in *healthz*) exit 0 ;; esac\necho nothing; exit 1'
    const a = repo('docker_up() { return 1; }', { docker })
    expect(await a.start([...noStatus, '--jobs', 'image']).done).toBe(1)
    expect(names(a.log('image'))).toEqual([
      'docker-build',
      'docker-run',
      'healthz',
      'image-root',
      'image-me',
      'image-uid',
    ])
    const b = repo('docker_up() { return 0; }', { docker })
    expect(await b.start([...noStatus, '--jobs', 'image'], { FAIL_ON: 'build' }).done).toBe(1)
    expect(names(b.log('image'))).toEqual(['docker-run', 'healthz', 'image-root', 'image-me', 'image-uid'])
    const c = repo('docker_up() { return 0; }', { docker, curl })
    expect(await c.start([...noStatus, '--jobs', 'image']).done).toBe(1)
    expect(notRun(c.log('image'))).toEqual([
      'NOT RUN: image-me (image-root failed)',
      'NOT RUN: image-uid (image-root failed)',
    ])
  })
})

// The harness PATH is an allow-list (scripts/harness-path.ts): one private folder, the test's fake tools, links to a short list of real
// tools, and refusing stubs for what would start a VM, a container, an app or the network. A run of these harnesses once reached
// the real colima through docker_up. None of the tests below starts a real tool: every name they reach is a stub or not found.
describe('the harness PATH is an allow-list: nothing unlisted is found, every refused tool is a stub inside the sandbox', () => {
  const inSandbox = (r: ReturnType<typeof repo>, name: string) =>
    spawnSync('bash', ['-c', `command -v ${name}`], {
      env: { PATH: r.env.PATH as string },
      encoding: 'utf8',
    }).stdout.trim()
  const aMac = '[ "$1" = -s ] && { echo Darwin; exit 0; }\nexec /usr/bin/uname "$@"'

  it('the PATH has exactly one entry, the private folder, and no startup file or git pointer reaches the run', () => {
    const r = repo()
    expect((r.env.PATH as string).split(delimiter)).toEqual([join(r.T, 'bin')])
    expect(r.env.GIT_CONFIG_GLOBAL).toBe('/dev/null')
    expect(r.env.HOME).toBe(r.home)
    for (const k of ['BASH_ENV', 'ENV', 'PERL5OPT']) expect(r.env[k], k).toBe('')
    expect(Object.keys(r.env).filter((k) => /^(GIT_(?!CONFIG_)|BASH_FUNC_)/.test(k))).toEqual([])
  })

  it('every refused tool resolves inside the sandbox, is a refusing stub, and a call refuses (97) and leaves its marker', () => {
    const r = repo()
    r.allowRefused() // it calls them
    const bin = join(r.T, 'bin')
    for (const name of REFUSED_TOOLS) {
      expect(inSandbox(r, name), name).toBe(join(bin, name))
      if (name === 'gh') continue // the harness's own gh, which records statuses, replaces the refusing one
      // the file is the stub, not a real tool, before it is run
      expect(readFileSync(join(bin, name), 'utf8'), name).toContain(`refused: ${name}`)
      const call = spawnSync(join(bin, name), ['x', 'y'], {
        env: { PATH: bin, REFUSED_MARKER: r.env.REFUSED_MARKER as string },
        encoding: 'utf8',
      })
      expect(call.status, name).toBe(97)
      expect(call.stdout, name).toContain(`refused: ${name}`)
    }
    const marker = readFileSync(r.env.REFUSED_MARKER as string, 'utf8')
      .trim()
      .split('\n')
    const called = REFUSED_TOOLS.filter((n) => n !== 'gh').map((n) => `${n} x y`)
    expect(marker.sort()).toEqual(called.sort())
    for (const name of ['bash', 'git', 'perl', 'awk', 'sed', 'grep', 'date', 'nice'])
      expect(inSandbox(r, name), name).toContain(bin)
  })

  it('a tool that is not on the list is "command not found" (127), though the test process has it: nothing real runs', async () => {
    const outer = mkdtempSync(join(tmpdir(), 'cih-outer-'))
    dirs.push(outer)
    const marker = join(outer, 'ran')
    writeFileSync(join(outer, 'zz-made-up-tool'), `#!/bin/sh\necho ran >> "${marker}"\n`, { mode: 0o755 })
    const before = process.env.PATH
    process.env.PATH = `${outer}${delimiter}${before}` // the real binary is on the outer PATH, as a real colima was
    try {
      const r = repo('job_mod() { run "$1" zz-made-up-tool; }')
      const run = r.start([...noStatus, '--jobs', 'mod'])
      expect(await run.done, run.out()).toBe(1)
      expect(r.log('mod')).toMatch(/zz-made-up-tool: (command )?not found/)
      expect(r.log('mod')).toContain('exit 127')
      expect(existsSync(marker)).toBe(false)
    } finally {
      process.env.PATH = before
    }
  })

  it('the image job, with docker_up as it is and a fake sleep, reaches for colima start: the incident, through the stubs', async () => {
    // docker_up asks docker (refused), starts colima on a Mac that has it, and waits 60 s for docker (here: a sleep that returns)
    const r = repo('', { uname: aMac, sleep: 'exit 0' })
    r.allowRefused()
    expect(await r.start([...noStatus, '--jobs', 'image']).done).toBe(1)
    const marker = readFileSync(r.env.REFUSED_MARKER as string, 'utf8')
    expect(marker).toMatch(/^docker info$/m)
    expect(marker).toMatch(/^colima start$/m)
    expect(r.log('image')).toContain('docker is not running')
  })

  it('the mod job, with the opt-in, hits claude and npm, which refuse (a job at a time: docker_up would wait 60 s on a refusing docker)', async () => {
    const r = repo()
    r.allowRefused()
    mkdirSync(join(r.clone, 'plugins/talos-app-mod'), { recursive: true })
    writeFileSync(join(r.clone, 'plugins/talos-app-mod/CLAUDE_CODE_VERSION'), '2.1.312\n')
    r.git(r.clone, 'add', '-A')
    r.git(r.clone, 'commit', '-qm', 'mod')
    expect(await r.start([...noStatus, '--jobs', 'mod'], { CI_MOD_REAL: '1' }).done).toBe(1)
    // the local claude answers --version with a refusal, so a throwaway npm copy is asked for
    const marker = readFileSync(r.env.REFUSED_MARKER as string, 'utf8')
    expect(marker).toMatch(/^claude --version$/m)
    expect(marker).toMatch(/^npm exec /m)
  })
})

describe('the browser job and the Playwright install (its cleanup once read a link into ~/Desktop and hung for 20-30 minutes)', () => {
  // A fake pnpm: --dry-run lists three build folders under $PW (as Playwright does: no lock, no cleanup); the real install records
  // whether __dirlock was there and whether the cleanup was off, then (PW_MODE=hang) hangs with a child of its own.
  const PNPM = `echo "pnpm $* GC=\${PLAYWRIGHT_SKIP_BROWSER_GC:-}" >> "$CALLS"
case "$*" in
  *"playwright install --dry-run"*) for d in chromium-1 ffmpeg-1 webkit-1; do echo "  Install location:    $PW/$d"; done ;;
  *"playwright install"*)
    echo "lock=$([ -e "$PW/__dirlock" ] && echo present || echo absent)" >> "$CALLS"
    if [ "\${PW_MODE:-}" = hang ]; then sleep 600 & echo $! > "$PW_SLEEPER"; wait; fi ;;
esac
exit 0`
  const builds = ['chromium-1', 'ffmpeg-1', 'webkit-1']
  function pwRepo(missing = '') {
    const r = repo('', { pnpm: PNPM })
    const pw = join(r.T, 'pw')
    for (const b of builds) {
      mkdirSync(join(pw, b), { recursive: true })
      if (b !== missing) writeFileSync(join(pw, b, 'INSTALLATION_COMPLETE'), '')
    }
    const env = { PW: pw, PW_SLEEPER: join(r.T, 'sleeper') }
    const installs = () => r.calledLines().filter((l) => /playwright install (?!--dry-run)|^lock=/.test(l))
    return { r, pw, env, installs }
  }
  const lockAged = (pw: string, ageSeconds: number) => {
    mkdirSync(join(pw, '__dirlock'))
    const t = new Date(Date.now() - ageSeconds * 1000)
    utimesSync(join(pw, '__dirlock'), t, t)
  }
  const browser = ['--ref', 'HEAD', '--no-status', '--jobs', 'browser']

  it('every build the install would fetch is complete: no install, no wait for the mutex, and the log says so', async () => {
    const { r, env, installs } = pwRepo()
    expect(await r.start(browser, env).done).toBe(0)
    expect(installs()).toEqual([])
    expect(r.log('browser')).toContain('playwright install skipped')
    expect(r.calledLines().some((l) => l.includes('test:e2e'))).toBe(true)
  })

  it('a build without its INSTALLATION_COMPLETE marker: the install runs, once, with the cleanup off', async () => {
    const { r, env, installs } = pwRepo('webkit-1')
    expect(await r.start(browser, env).done).toBe(0)
    expect(installs()).toEqual(['pnpm exec playwright install chromium webkit GC=1', 'lock=absent'])
  })

  it('Playwright names no build (its list is empty): never read as complete, the install runs', async () => {
    const r = repo()
    expect(await r.start(browser).done).toBe(0)
    expect(r.calledLines().some((l) => l.includes('playwright install chromium webkit'))).toBe(true)
  })

  it('an install that hangs is stopped with its whole group at the limit, the step is loud, and the job is red', async () => {
    const { r, env } = pwRepo('webkit-1')
    const run = r.start(browser, { ...env, PW_MODE: 'hang', CI_PW_INSTALL_LIMIT: '2' })
    expect(await run.done).toBe(1)
    const log = r.log('browser')
    expect(log).toContain('playwright install stopped after 2s')
    expect(log).toContain('NOT RUN: test:browser (the browsers could not be made ready)')
    const pid = Number(readFileSync(env.PW_SLEEPER, 'utf8'))
    expect(() => process.kill(pid, 0)).toThrow() // the install's child went with it
  })

  it('a __dirlock older than the limit with no install running is cleared before the install', async () => {
    const { r, pw, env, installs } = pwRepo('webkit-1')
    lockAged(pw, 3600)
    expect(await r.start(browser, { ...env, CI_PW_INSTALL_LIMIT: '30' }).done).toBe(0)
    expect(installs()).toContain('lock=absent')
    expect(r.log('browser')).toContain('stale __dirlock')
  })

  it('a __dirlock younger than the limit is left alone', async () => {
    const { r, pw, env, installs } = pwRepo('webkit-1')
    lockAged(pw, 1)
    expect(await r.start(browser, { ...env, CI_PW_INSTALL_LIMIT: '30' }).done).toBe(0)
    expect(installs()).toContain('lock=present')
  })

  it('an old __dirlock while a Playwright install is running is left alone: that process owns it', async () => {
    const { r, pw, env, installs } = pwRepo('webkit-1')
    lockAged(pw, 3600)
    const up = join(r.T, 'owner-up')
    const owner = spawn('bash', [
      '-c',
      `: > "${up}"; exec -a "node ./node_modules/@playwright/test/cli.js install chromium" sleep 60`,
    ])
    live.push(owner)
    waitForFile(up)
    expect(await r.start(browser, { ...env, CI_PW_INSTALL_LIMIT: '30' }).done).toBe(0)
    expect(installs()).toContain('lock=present')
  })
})

// The gate's result reused (scripts/ci-local/jobs-check.sh, reuse_gate_step; gate.sh writes the record, rec_end). A whole bridge suite
// that passed in the gate on exactly this commit stands in for CI's two bridge steps; everything else about the run is as ever.
describe("the gate's result for the whole bridge suite, reused by the CI run of the same commit", () => {
  const BUN_CMD = 'bun run scripts/test-parallel.ts'
  const NOW = () => Math.floor(Date.now() / 1000)
  const hostName = execFileSync('hostname', ['-s'], { encoding: 'utf8' }).trim()
  const sha256 = (v: string) => createHash('sha256').update(v).digest('hex')
  type Over = Record<string, string | null>
  /**
   * The record gate.sh would have written for `sha` (rec_end), under <cache>/gate-results: `over` replaces a field (null leaves it
   * out), `env` the knobs it saw (name -> value), `partial` leaves out its last line.
   */
  const writeRecord = (
    cache: string,
    sha: string,
    tree: string,
    over: Over = {},
    opts: { env?: Record<string, string>; partial?: boolean; mode?: number; step?: string } = {},
  ) => {
    const step = opts.step ?? 'bun-all'
    const fields: Over = {
      step,
      cmd: BUN_CMD,
      sha,
      tree,
      gate: '20261124T120000Z-4242',
      at: String(NOW() - 60),
      machine: hostName,
      uid: String(process.getuid?.()),
      ci: 'true', // the gate ran the suite with CI=true, as the runner has it
      time_factor: '1',
      heavy_slots: '',
      bun: 'none',
      ...over,
    }
    const dir = join(cache, 'gate-results', sha)
    mkdirSync(dir, { recursive: true, mode: 0o700 })
    chmodSync(join(cache, 'gate-results'), 0o700)
    chmodSync(dir, 0o700)
    const lines = [
      'talos-gate-result v1',
      ...Object.entries(fields).flatMap(([k, v]) => (v === null ? [] : [`${k}=${v}`])),
      ...Object.entries(opts.env ?? {}).map(([k, v]) => `env.${k}=${sha256(v)}`),
      ...(opts.partial ? [] : ['end']),
    ]
    const f = join(dir, step)
    writeFileSync(f, `${lines.join('\n')}\n`, { mode: 0o600 })
    chmodSync(f, opts.mode ?? 0o600)
    return f
  }

  describe('reuse_gate_step, the decision (jobs-check.sh sourced alone, in a one-commit repo)', () => {
    function fixture() {
      const T = mkdtempSync(join(tmpdir(), 'reuse-'))
      dirs.push(T)
      const git = (...a: string[]) =>
        execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', ...a], {
          cwd: join(T, 'wt'),
          encoding: 'utf8',
          env: fixtureGitEnv(T),
        }).trim()
      mkdirSync(join(T, 'wt'))
      git('init', '-q', '-b', 'main')
      writeFileSync(join(T, 'wt/a.txt'), 'a\n')
      git('add', '-A')
      git('commit', '-qm', 'a')
      const sha = git('rev-parse', 'HEAD')
      const tree = git('rev-parse', 'HEAD^{tree}')
      const cache = join(T, 'cache')
      mkdirSync(cache)
      const reused = join(T, 'job.reused') // beside the flake file the job is given: the file reuse_gate_step writes to
      /** reuse_gate_step bun-all <cmd> <step>, with `vars` set as shell variables first; its exit code and what it said */
      const probe = (
        vars: Record<string, string> = {},
        env: Record<string, string> = {},
        cmd = BUN_CMD,
        id = 'bun-all',
      ) => {
        const sets = Object.entries({
          CACHE: cache,
          SHA: sha,
          FULL: '0',
          RUN_BUN: 'none',
          WHERE: 'testbox',
          REUSE_FIRST_RUN: '1',
          CI_FLAKE_FILE: join(T, 'job.flaky'),
          ...vars,
        })
          .map(([k, v]) => `${k}='${v}'`)
          .join('; ')
        const r = spawnSync(
          'bash',
          [
            '-c',
            `${sets}; . "${join(here, 'ci-local/jobs-check.sh')}"; reuse_gate_step ${id} "$1" step_bun_rest`,
            'probe',
            cmd,
          ],
          { cwd: join(T, 'wt'), env: { PATH: process.env.PATH ?? '', HOME: T, CI: 'true', ...env }, encoding: 'utf8' },
        )
        return {
          code: r.status,
          said: `${r.stdout}${r.stderr}`,
          reused: existsSync(reused) ? readFileSync(reused, 'utf8') : '',
        }
      }
      return { T, git, sha, tree, cache, probe }
    }

    it('the same commit and tree, the same step and command, on this machine a minute ago: reused, loudly, and written to the results file', () => {
      const f = fixture()
      writeRecord(f.cache, f.sha, f.tree)
      const r = f.probe()
      expect(r.code, r.said).toBe(0)
      expect(r.said).toMatch(
        /reused the gate's result for bun-all \(gate 20261124T120000Z-4242, \d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ\) in place of step_bun_rest/,
      )
      expect(r.said).toContain(f.sha.slice(0, 7))
      const [step, what, gate, at] = r.reused.trim().split('\t')
      expect([step, what, gate]).toEqual(['bun-all', 'step_bun_rest', '20261124T120000Z-4242'])
      expect(at).toMatch(/^\d{4}-\d\d-\d\dT/)
    })

    it('no record for this commit: runs normally, and says there was none', () => {
      const f = fixture()
      const r = f.probe()
      expect(r.code).toBe(1)
      expect(r.said).toContain(
        "not reusing the gate's result for bun-all (step_bun_rest): the gate left none for this commit",
      )
      expect(r.reused).toBe('')
    })

    const zeros = '0'.repeat(40)
    const doubts: Array<[string, Over, string, { partial?: boolean }?]> = [
      ['a different tree', { tree: zeros }, 'tree'],
      ['another commit', { sha: zeros }, 'commit'],
      ['a partial record (no last line)', {}, 'partial', { partial: true }],
      ['a record older than a day', { at: String(NOW() - 90_000) }, 'older'],
      ['a record from the future', { at: String(NOW() + 3_600) }, 'older'],
      ['a record with no time', { at: null }, 'lacks'],
      ['another command (the bridge suite run with other options)', { cmd: `${BUN_CMD} --jobs 1` }, 'command'],
      ['another step', { step: 'vitest-all' }, 'step'],
      ['another machine', { machine: 'some-other-box' }, 'machine'],
      ['another user', { uid: String((process.getuid?.() ?? 0) + 1) }, 'user'],
      ['another CI variable (the gate ran it without CI)', { ci: '' }, 'ci variable'],
      ['another time factor (the tests had longer budgets)', { time_factor: '3' }, 'time factor'],
      ['another number of heavy slots', { heavy_slots: '7' }, 'heavy slots'],
      ['another bun', { bun: '9.9.9' }, 'bun'],
      ['a key twice', {}, 'twice'], // (made below: the record gets a second tree line)
    ]
    it.each(doubts)('%s: runs normally, says why', (_name, over, why, opts) => {
      const f = fixture()
      const file = writeRecord(f.cache, f.sha, f.tree, over, opts)
      if (why === 'twice') writeFileSync(file, readFileSync(file, 'utf8').replace('end\n', 'tree=x\nend\n'))
      const r = f.probe()
      expect(r.code, r.said).toBe(1)
      expect(r.said).toContain("not reusing the gate's result for bun-all")
      expect(r.said.toLowerCase()).toContain(why)
      expect(r.reused).toBe('')
    })

    it('a knob that changes what a test does: the gate had one this run lacks, this run has one the gate lacked, or its value differs', () => {
      const a = fixture()
      writeRecord(a.cache, a.sha, a.tree, {}, { env: { TALOS_FUZZ_MS: '60000' } })
      const hadOne = a.probe()
      expect(hadOne.code).toBe(1)
      expect(hadOne.said).toContain('TALOS_FUZZ_MS')
      const b = fixture()
      writeRecord(b.cache, b.sha, b.tree)
      const hasOne = b.probe({}, { TALOS_FUZZ_MS: '60000' })
      expect(hasOne.code).toBe(1)
      expect(hasOne.said).toContain('TALOS_FUZZ_MS')
      const c = fixture()
      writeRecord(c.cache, c.sha, c.tree, {}, { env: { TALOS_FUZZ_MS: '60000' } })
      expect(c.probe({}, { TALOS_FUZZ_MS: '1000' }).code).toBe(1)
      for (const [name, value] of [
        ['TALOS_HEAVY_SLOTS', '2'],
        ['TZ', 'Pacific/Kiritimati'],
        ['NODE_OPTIONS', '--require=/x/hostile-clock.cjs'],
        ['BUN_OPTIONS', '--preload=/x/hostile-clock.cjs'],
        ['TALOS_HOSTILE_CLOCK_MS', '2592000000'],
      ] as const) {
        const d = fixture()
        writeRecord(d.cache, d.sha, d.tree)
        expect(d.probe({}, { [name]: value }).code, name).toBe(1)
      }
      // the same knob with the same value on both sides is no difference
      const e = fixture()
      writeRecord(e.cache, e.sha, e.tree, {}, { env: { TALOS_FUZZ_MS: '60000' } })
      expect(e.probe({}, { TALOS_FUZZ_MS: '60000' }).code).toBe(0)
    })

    it("a run's own bookkeeping variables are no difference (the slot, the held locks, the junit folder, the tmux prefix, the cache of bun)", () => {
      const f = fixture()
      writeRecord(f.cache, f.sha, f.tree)
      const r = f.probe(
        {},
        {
          TALOS_HEAVY_SLOT: '1',
          TALOS_HELD_LOCKS: '/x',
          TALOS_TEST_JUNIT_DIR: '/x/junit',
          TALOS_TEST_TMUX_PREFIX: 'talos-test-s1',
          TALOS_CI_SLOT_RUN: '1',
          TALOS_MACHINE: 'lemnos',
          BUN_INSTALL: '/x/bun',
          BUN_INSTALL_CACHE_DIR: '/x/cache',
        },
      )
      expect(r.code, r.said).toBe(0)
    })

    it("a run whose CI is not the gate's does not reuse (a hand run has none), and one with CI=1 neither", () => {
      for (const ci of ['', '1', 'false']) {
        const f = fixture()
        writeRecord(f.cache, f.sha, f.tree)
        const r = f.probe({}, { CI: ci })
        expect(r.code, `CI=${ci}: ${r.said}`).toBe(1)
        expect(r.said).toContain('another CI variable')
      }
    })

    it('only CI_REUSE unset or 1 leaves reuse on: 0, off, false, no and an empty word turn it off', () => {
      for (const v of ['0', 'off', 'false', 'no', 'x']) {
        const f = fixture()
        writeRecord(f.cache, f.sha, f.tree)
        const r = f.probe({}, { CI_REUSE: v })
        expect(r.code, `CI_REUSE=${v}: ${r.said}`).toBe(1)
        expect(r.said).toContain('CI_REUSE is not 1')
      }
      const f = fixture()
      writeRecord(f.cache, f.sha, f.tree)
      expect(f.probe({}, { CI_REUSE: '1' }).code).toBe(0)
    })

    it("a record written after the run began is not the gate's (the commit's own install scripts run after it): no reuse", () => {
      const f = fixture()
      writeRecord(f.cache, f.sha, f.tree)
      const r = f.probe({ T_SLOT: String(NOW() - 100) })
      expect(r.code, r.said).toBe(1)
      expect(r.said).toContain('written after this run began')
      expect(f.probe({ T_SLOT: String(NOW() + 100) }).code).toBe(0)
    })

    it('the time factor is read as the tests read it: unset, 0, 1 and "abc" are all 1', () => {
      for (const v of [undefined, '0', '1', 'abc', '1.0']) {
        const f = fixture()
        writeRecord(f.cache, f.sha, f.tree)
        const r = f.probe({}, v === undefined ? {} : { TALOS_TEST_TIME_FACTOR: v })
        expect(r.code, `${v}: ${r.said}`).toBe(0)
      }
      const f = fixture()
      writeRecord(f.cache, f.sha, f.tree, { time_factor: '3' })
      expect(f.probe({}, { TALOS_TEST_TIME_FACTOR: '3' }).code).toBe(0)
    })

    // A higher factor gives every test a longer budget, so a gate that passed at a higher factor than this run's proved less than this
    // run would: no reuse. A gate at a lower or equal one proved at least as much: reuse. (The factor follows the machine's load,
    // scripts/talos-machine.sh, so the gate's and the run's often differ.)
    it.each([
      // [the gate's factor, this run's TALOS_TEST_TIME_FACTOR, reused]
      ['1', '1', true],
      ['1', undefined, true],
      ['1', '2', true],
      ['1', '4', true],
      ['2', '3', true],
      ['3', '3', true],
      ['1.5', '2', true],
      ['1', '1.5', true],
      ['2', '1', false],
      ['2', undefined, false],
      ['3', '1', false],
      ['4', '3', false],
      ['3', '2.5', false],
      ['2.5', '2', false],
    ] as const)("the gate's factor %s, this run's %s: reused %s", (gate, here, reused) => {
      const f = fixture()
      writeRecord(f.cache, f.sha, f.tree, { time_factor: gate })
      const r = f.probe({}, here === undefined ? {} : { TALOS_TEST_TIME_FACTOR: here })
      expect(r.code, r.said).toBe(reused ? 0 : 1)
      if (!reused) {
        expect(r.said).toContain('time factor')
        expect(r.said).toContain('longer budgets')
        expect(r.reused).toBe('')
      }
    })

    it.each(['abc', '', '0', '0.5', '1e1', '-1', '3x', '1.2.3', '.5', '3.', '0x3'])(
      'a record whose time factor is %j is not a factor at all: no reuse, whatever this run has',
      (bad) => {
        const f = fixture()
        writeRecord(f.cache, f.sha, f.tree, { time_factor: bad })
        const r = f.probe({}, { TALOS_TEST_TIME_FACTOR: '4' })
        expect(r.code, r.said).toBe(1)
        expect(r.said.toLowerCase()).toMatch(/time factor|lacks/)
        expect(r.reused).toBe('')
      },
    )

    it.each([
      ['a hostile run', { env: { CI_HOSTILE: '1' }, why: 'hostile' }],
      ['the nightly', { env: { CI_NIGHTLY: '1' }, why: 'nightly' }],
      ['a --full run (every dispatch, and the nightly)', { vars: { FULL: '1' }, why: '--full' }],
      ['the off switch in the environment', { env: { CI_REUSE: '0' }, why: 'CI_REUSE is not 1' }],
      ['a rerun of a commit that already ran here', { vars: { REUSE_FIRST_RUN: '0' }, why: 'before' }],
      ['a part or report-only run (not local-ci)', { vars: { CI_STATUS_PREFIX: 'report-ci' }, why: 'local-ci' }],
    ] as const)('%s never reuses, with a good record there', (_name, c) => {
      const f = fixture()
      writeRecord(f.cache, f.sha, f.tree)
      const r = f.probe('vars' in c ? c.vars : {}, 'env' in c ? c.env : {})
      expect(r.code, r.said).toBe(1)
      expect(r.said).toContain("not reusing the gate's result for bun-all")
      expect(r.said).toContain(c.why)
      expect(r.reused).toBe('')
    })

    it('the off switch as a file in the cache (reuse-off) turns it off with no commit', () => {
      const f = fixture()
      writeRecord(f.cache, f.sha, f.tree)
      expect(f.probe().code).toBe(0)
      writeFileSync(join(f.cache, 'reuse-off'), '')
      const r = f.probe()
      expect(r.code).toBe(1)
      expect(r.said).toContain('reuse-off')
    })

    it("a record that is not the gate's own file is no record: a symlink, a file others can write, a folder others can write", () => {
      const a = fixture()
      const real = writeRecord(a.cache, a.sha, a.tree)
      const link = `${real}.link`
      renameLink(real, link)
      expect(a.probe().code).toBe(1)
      const b = fixture()
      writeRecord(b.cache, b.sha, b.tree, {}, { mode: 0o666 })
      expect(b.probe().code).toBe(1)
      const c = fixture()
      writeRecord(c.cache, c.sha, c.tree)
      chmodSync(join(c.cache, 'gate-results', c.sha), 0o777)
      expect(c.probe().code).toBe(1)
      const d = fixture()
      writeRecord(d.cache, d.sha, d.tree)
      chmodSync(join(d.cache, 'gate-results'), 0o777)
      expect(d.probe().code).toBe(1)
    })

    it('the checkout the step runs in must be the commit: another HEAD, no reuse', () => {
      const f = fixture()
      writeRecord(f.cache, f.sha, f.tree)
      writeFileSync(join(f.T, 'wt/b.txt'), 'b\n')
      f.git('add', '-A')
      f.git('commit', '-qm', 'b')
      const r = f.probe()
      expect(r.code, r.said).toBe(1)
      expect(r.said).toContain('checkout')
    })
  })

  const baseRepo = repo
  describe('the check job of a real ci-local.sh run', () => {
    // A run reuses the gate's result only when the knobs in its environment (TALOS_*, BUN_*, NODE_OPTIONS, TZ: jobs-check.sh,
    // reuse_env_now) are the record's. The record here has none, so a run of these tests must have none either: a builder's shell
    // with BUN_ENABLE_CRASH_REPORTING in it made the first test fail (the environment is meant to be hermetic, jobs-check.sh).
    const IGNORED = new Set(
      'TALOS_MACHINE TALOS_HELD_LOCKS TALOS_HEAVY_SLOT TALOS_TEST_TMUX_PREFIX TALOS_SHARED_LOCK_HELD TALOS_CI_SLOT_RUN TALOS_CI_NESTED TALOS_TEST_JUNIT_DIR TALOS_TEST_TIME_FACTOR BUN_INSTALL BUN_INSTALL_CACHE_DIR'.split(
        ' ',
      ),
    )
    const repo = () => {
      const r = baseRepo()
      for (const k of Object.keys(r.env))
        if (/^(TALOS_|BUN_)|^(NODE_OPTIONS|TZ)$/.test(k) && !IGNORED.has(k)) delete (r.env as Record<string, string>)[k]
      return r
    }
    const check = ['--ref', 'HEAD', '--no-status', '--jobs', 'check']
    const CI = { CI: 'true' } // the runner's own
    type Repo = ReturnType<typeof repo>
    const bunRuns = (r: Repo) =>
      r.calledLines().filter((l) => l.startsWith('bun run apps/bridge/scripts/test-parallel.ts'))
    const cache = (r: Repo) => join(r.home, '.cache/talos-ci')
    // The record carries the time factor the gate ran at, and the run compares it with the one in its own environment (jobs-check.sh,
    // reuse_gate_step). A run under gate.sh on a machine with 4 cores or fewer (Titan) has TALOS_TEST_TIME_FACTOR=3 there, and a
    // record that always said 1 was never reused (both tests below failed on Titan at f5bbbb3ee): the record says the ambient factor.
    const ambientFactor = (() => {
      const n = process.env.TALOS_TEST_TIME_FACTOR ?? ''
      return /^[0-9]+(\.[0-9]+)?$/.test(n) && Number(n) >= 1 ? String(Number(n)) : '1'
    })()
    const record = (r: Repo, over: Over = {}) =>
      writeRecord(cache(r), r.git(r.clone, 'rev-parse', 'HEAD'), r.git(r.clone, 'rev-parse', 'HEAD^{tree}'), {
        time_factor: ambientFactor,
        ...over,
      })
    const lastRow = (r: Repo) =>
      (
        readFileSync(join(cache(r), 'logs/timings.tsv'), 'utf8')
          .trim()
          .split('\n')
          .pop() as string
      ).split('\t')

    it('a record for the commit: neither bridge step runs, every other step does, and the run says so in its log, output, status and timings', async () => {
      const r = repo()
      record(r)
      const run = r.start(['--ref', 'HEAD', '--jobs', 'check'], CI)
      expect(await run.done, run.out()).toBe(0)
      expect(bunRuns(r), run.out()).toEqual([])
      const ran = r.calledLines().join('\n')
      for (const step of ['typecheck ', 'lint', 'test --maxWorkers', 'test:contract', 'notices:check'])
        expect(ran).toContain(step)
      const log = r.log('check')
      expect(log.match(/reused the gate's result for bun-all \(gate 20261124T120000Z-4242, /g)).toHaveLength(2)
      expect(log).toContain('in place of step_bun_schedules')
      expect(log).toContain('in place of step_bun_rest')
      expect(run.out()).toMatch(
        /~ check: reused the gate's result for bun-all \(gate 20261124T120000Z-4242, \S+\) in place of step_bun_/,
      )
      expect(readFileSync(r.env.GH_LOG, 'utf8')).toMatch(
        /passed on \S+ in \d+s, reused the gate's bun-all \(rest\+schedules; gate 20261124T120000Z-4242\)/,
      )
      expect(lastRow(r).slice(12)).toEqual(['reused=check:bun-all'])
      // the per-test file says whose tests are not in it: the shadow compare reads the bridge suite as not run here
      expect(ran).toMatch(/ci-test-results\.ts .* bridge-shard-1:gate bridge-shard-2:gate/)
    })

    // The run picks its own factor from the load at its start (scripts/talos-machine.sh, the gate's rule) and exports it to its jobs.
    // GATE_LOAD / GATE_CORES stand in for the machine: 36 on 18 cores is a factor of 2.
    describe('the factor the run picks, and the gate result it takes', () => {
      const loaded = { ...CI, GATE_LOAD: '36', GATE_CORES: '18', TALOS_TEST_TIME_FACTOR: '' }
      it("a gate at a factor under the run's: reused; the run says its factor and why", async () => {
        const r = repo()
        record(r, { time_factor: '1' })
        const run = r.start(['--ref', 'HEAD', '--jobs', 'check'], loaded)
        expect(await run.done, run.out()).toBe(0)
        expect(run.out()).toMatch(/ci-local: time factor 2: every test budget x2 \(load 36 on 18 cores/)
        expect(bunRuns(r), run.out()).toEqual([])
        expect(r.log('check')).toContain("reused the gate's result for bun-all")
      })
      it("a gate at the run's factor: reused", async () => {
        const r = repo()
        record(r, { time_factor: '2' })
        const run = r.start(['--ref', 'HEAD', '--jobs', 'check'], loaded)
        expect(await run.done, run.out()).toBe(0)
        expect(bunRuns(r), run.out()).toEqual([])
      })
      it("a gate at a factor over the run's (longer budgets): the bridge suite runs here, and the log says why", async () => {
        const r = repo()
        record(r, { time_factor: '3' })
        const run = r.start(['--ref', 'HEAD', '--jobs', 'check'], loaded)
        expect(await run.done, run.out()).toBe(0)
        expect(bunRuns(r)).toHaveLength(2)
        expect(r.log('check')).toContain("another time factor (the gate's 3, this run's 2")
      })
      it('an explicit TALOS_TEST_TIME_FACTOR wins over the load, and the jobs get it', async () => {
        const r = repo()
        const run = r.start(['--ref', 'HEAD', '--jobs', 'check'], { ...loaded, TALOS_TEST_TIME_FACTOR: '1' })
        expect(await run.done, run.out()).toBe(0)
        expect(run.out()).toContain(
          'ci-local: time factor 1: every test budget x1 (TALOS_TEST_TIME_FACTOR was already set)',
        )
      })
      it('a run on a small machine has the core floor, 3, with no load at all', async () => {
        const r = repo()
        const run = r.start(['--ref', 'HEAD', '--jobs', 'check'], {
          ...CI,
          GATE_LOAD: '0',
          GATE_CORES: '4',
          TALOS_TEST_TIME_FACTOR: '',
        })
        expect(await run.done, run.out()).toBe(0)
        expect(run.out()).toContain('ci-local: time factor 3: every test budget x3')
      })
    })

    it('the status keeps the reuse words in front of the warnings, inside the 140 characters GitHub keeps', async () => {
      const r = repo()
      record(r)
      const run = r.start(['--ref', 'HEAD', '--jobs', 'check'], { ...CI, FAIL_ON: 'check:personal' })
      expect(await run.done, run.out()).toBe(0)
      const posted = readFileSync(r.env.GH_LOG, 'utf8')
        .split('\n')
        .filter((l) => l.includes('state=success') && l.includes('local-ci/check'))
      expect(posted).toHaveLength(1)
      expect(posted[0]).toMatch(
        /passed on \S+ in \d+s, reused the gate's bun-all \(rest\+schedules; gate \S+\), with warnings/,
      )
    })

    it('no record: both bridge steps run as ever, and nothing is said to be reused', async () => {
      const r = repo()
      const run = r.start(check)
      expect(await run.done, run.out()).toBe(0)
      expect(bunRuns(r)).toHaveLength(2)
      expect(run.out()).not.toContain('reused the gate')
      expect(lastRow(r).slice(12)).toEqual(['reused=-'])
    })

    it("a rerun of the same commit tests everything again, record or not: a red CI run is never answered by the gate's green", async () => {
      const r = repo()
      expect(await r.start(check, { FAIL_ON: 'test --maxWorkers' }).done).toBe(1)
      expect(bunRuns(r)).toHaveLength(2)
      record(r)
      const run = r.start(check)
      expect(await run.done, run.out()).toBe(0)
      expect(bunRuns(r)).toHaveLength(4)
      expect(run.out()).not.toContain('reused the gate')
    })

    it('a red step that is not the bridge suite still fails the run', async () => {
      const r = repo()
      record(r)
      const run = r.start(check, { FAIL_ON: 'test:contract', ...CI })
      expect(await run.done).toBe(1)
      expect(bunRuns(r)).toEqual([])
    })

    it('a hand run (no CI in its environment) does not reuse the suite the gate ran under CI=true', async () => {
      const r = repo()
      record(r)
      const run = r.start(check, { CI: '' })
      expect(await run.done, run.out()).toBe(0)
      expect(bunRuns(r)).toHaveLength(2)
      expect(r.log('check')).toContain('another CI variable')
    })

    it('a record for another tree: the bridge steps run', async () => {
      const r = repo()
      record(r, { tree: '0'.repeat(40) })
      const run = r.start(check)
      expect(await run.done, run.out()).toBe(0)
      expect(bunRuns(r)).toHaveLength(2)
      expect(r.log('check')).toContain("not reusing the gate's result for bun-all")
    })

    it('--full asks for every test: nothing is reused', async () => {
      const r = repo()
      record(r)
      const run = r.start(['--ref', 'HEAD', '--no-status', '--full', '--jobs', 'check'])
      expect(await run.done, run.out()).toBe(0)
      expect(bunRuns(r)).toHaveLength(2)
    })
  })
})

/** `file` becomes a symlink to a copy of itself (a record made by anything but the gate's own write) */
function renameLink(file: string, link: string) {
  writeFileSync(link, readFileSync(file))
  rmSync(file)
  symlinkSync(link, file)
}
