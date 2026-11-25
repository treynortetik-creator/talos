// ci-local.sh gates, split from ci-local-jobs.test.ts so the two run side by side: the same harness, the same tests.
import { type ChildProcess, execFileSync, spawn, spawnSync } from 'node:child_process'
import {
  appendFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
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
    `echo "${n} $* SKIP_BUILD=\${SKIP_BUILD:-} E2E_SKIP_BUILD=\${E2E_SKIP_BUILD:-}" >> "$CALLS"
     [ -n "\${FAIL_ON:-}" ] && [[ "$* " == *"$FAIL_ON"* ]] && exit 1
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

  it('a red quick gate leaves out the gates after it, every suite and the audit, each said with the red step named; hostile too (they are no suite)', async () => {
    for (const hostile of ['', '1']) {
      for (const [red, after] of [
        ['typecheck ', ['typecheck:mod', 'lint', 'notices:check']],
        ['typecheck:mod', ['lint', 'notices:check']],
        ['lint', ['notices:check']],
      ] as const) {
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
      }
    }
  })

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
