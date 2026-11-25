// ci-runner.sh alert: when main goes red, one message for the lead (the red jobs, the failing tests from the runner's own logs,
// the first red commit and how long main has been red, the commits since the last green), and one "green again" when it clears;
// within a streak, one "still RED" when the set of failing tests changes. The step only writes the message to ~/.cache/talos-ci/alerts; scripts/ci-alerts.sh is how a session
// on this Mac picks it up (its Monitor) and passes it on.
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
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, afterEach, describe, expect, it } from 'vitest'
import { comments, fakeGh } from './lead-inbox-fixture.ts'

const here = dirname(fileURLToPath(import.meta.url))
const dirs: string[] = []
const kills: (() => void)[] = [] // every long-running watcher a test started, killed even when the test fails
afterEach(() => {
  for (const k of kills.splice(0)) k()
})
afterAll(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})
const gitEnv = {
  PATH: process.env.PATH ?? '',
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_SYSTEM: '/dev/null',
  GIT_AUTHOR_NAME: 'Builder One',
  GIT_AUTHOR_EMAIL: 'one@example.com',
  GIT_COMMITTER_NAME: 'Builder One',
  GIT_COMMITTER_EMAIL: 'one@example.com',
}
const SIX = ['check', 'mod', 'browser', 'image', 'desktop', 'mobile']

function setup() {
  const T = mkdtempSync(join(tmpdir(), 'ci-alert-'))
  dirs.push(T)
  const git = (cwd: string, ...a: string[]) => {
    const r = spawnSync('git', a, { cwd, env: gitEnv, encoding: 'utf8' })
    if (r.status !== 0) throw new Error(`git ${a.join(' ')}: ${r.stderr}`)
    return r.stdout.trim()
  }
  const origin = join(T, 'origin.git')
  const w = join(T, 'w')
  git(T, 'init', '-q', '--bare', '-b', 'main', origin)
  git(T, 'clone', '-q', origin, w)
  const shas: string[] = []
  const commit = (subject: string, branch = 'main') => {
    writeFileSync(join(w, 'f'), `${subject}\n`)
    git(w, 'add', '-A')
    git(w, 'commit', '-qm', subject)
    git(w, 'push', '-q', 'origin', `HEAD:${branch}`)
    const s = git(w, 'rev-parse', 'HEAD')
    shas.push(s)
    return s
  }
  // the runner's checkout, where ci-runner.sh runs
  const r = join(T, 'r')
  const cache = join(T, 'cache')
  const bin = join(T, 'bin')
  mkdirSync(bin)
  mkdirSync(join(T, 'status'))
  // GitHub: the combined status of a commit, from status/<sha> ("context<TAB>state<TAB>description" rows)
  writeFileSync(
    join(bin, 'gh'),
    `#!/bin/sh\nall="$*"; case "$all" in "repo view"* | *"/issues"* | *"/labels"*) exec "${T}/inbox/gh" "$@" ;; *"/commits/"*"/status"*) s="\${all#*/commits/}"; s="\${s%%/status*}"; cat "${T}/status/$s" 2>/dev/null ;; *"/commits?sha=main"*) cat "${T}/main" 2>/dev/null ;; esac\nexit 0\n`,
    { mode: 0o755 },
  )
  // the lead's inbox on GitHub (scripts/lead-inbox.sh): its issue and comments in inbox-state/
  const inbox = join(T, 'inbox-state')
  fakeGh(join(T, 'inbox'), inbox)
  // at: when the statuses were posted (ISO); the "untested" check reads it
  const status = (sha: string, states: Record<string, string>, at = new Date().toISOString().replace(/\.\d+Z$/, 'Z')) =>
    writeFileSync(
      join(T, 'status', sha),
      Object.entries(states)
        .map(
          ([job, st]) =>
            `local-ci/${job}\t${st}\t${st === 'success' ? 'passed on ci-runner in 9s' : `${st} on ci-runner`}\t${at}\n`,
        )
        .join(''),
    )
  // main's commits as GitHub lists them, newest first
  // when: when each commit landed (its committer date, ISO); the "untested" gap is timed from the oldest untested one
  const main = (list: [string, string][]) =>
    writeFileSync(
      join(T, 'main'),
      `${[...list]
        .reverse()
        .map(([sha, when]) => `${sha}\t${when}`)
        .join('\n')}\n`,
    )
  const green = (sha: string, at?: string) => status(sha, Object.fromEntries(SIX.map((j) => [j, 'success'])), at)
  const red = (sha: string, jobs: string[]) =>
    status(sha, Object.fromEntries(SIX.map((j) => [j, jobs.includes(j) ? 'failure' : 'success'])))
  // dir: the log folder of the kind of run (a push run's is logs/; the hostile nightly's logs/hostile/, the nightly's logs/nightly/)
  const log = (sha: string, job: string, text: string, dir = 'logs') => {
    mkdirSync(join(cache, dir), { recursive: true })
    writeFileSync(join(cache, dir, `${sha.slice(0, 7)}-${job}.log`), text)
  }
  // the NOT RUN lines a job wrote (ci-local's not_run): the file beside its log that a report reads, and only that
  const notrun = (sha: string, job: string, text: string, dir = 'logs') => {
    mkdirSync(join(cache, dir), { recursive: true })
    writeFileSync(join(cache, dir, `${sha.slice(0, 7)}-${job}.notrun`), text)
  }
  const alert = (sha: string, extra: Record<string, string> = {}) => {
    if (!existsSync(r)) {
      git(T, 'clone', '-q', origin, r)
      mkdirSync(join(r, 'scripts'), { recursive: true })
      cpSync(join(here, 'ci-runner.sh'), join(r, 'scripts/ci-runner.sh'))
      cpSync(join(here, 'ci-alerts.sh'), join(r, 'scripts/ci-alerts.sh'))
      cpSync(join(here, 'ci-alert-tests.pl'), join(r, 'scripts/ci-alert-tests.pl'))
      cpSync(join(here, 'ci-runner/alert.sh'), join(r, 'scripts/ci-runner/alert.sh'))
      cpSync(join(here, 'ci-runner/gh-account.sh'), join(r, 'scripts/ci-runner/gh-account.sh'))
      cpSync(join(here, 'lead-inbox.sh'), join(r, 'scripts/lead-inbox.sh'))
    }
    return spawnSync('bash', ['scripts/ci-runner.sh', 'alert'], {
      cwd: r,
      env: {
        ...gitEnv,
        PATH: `${bin}:${process.env.PATH}`,
        HOME: T,
        TALOS_CI_CACHE: cache,
        GH_TOKEN: 't',
        GITHUB_REPOSITORY: 'owner/talos-app',
        GITHUB_SERVER_URL: 'https://github.com',
        GITHUB_RUN_ID: '77',
        CI_PLAN_SHA: sha,
        ...extra,
      },
      encoding: 'utf8',
    })
  }
  const alerts = () =>
    existsSync(join(cache, 'alerts')) ? readdirSync(join(cache, 'alerts')).filter((f) => f.endsWith('.txt')) : []
  const read = (f: string) => readFileSync(join(cache, 'alerts', f), 'utf8')
  const watch = (...a: string[]) =>
    spawnSync('bash', [join(here, 'ci-alerts.sh'), ...a], {
      env: { ...gitEnv, TALOS_CI_CACHE: cache },
      encoding: 'utf8',
    })
  // a long-running watcher, as under a Monitor: its own process group (so a kill takes its sleep and its untested check too), the
  // fake gh, a fast loop; out() is everything it has printed so far
  const watcher = () => {
    const p = spawn('bash', [join(here, 'ci-alerts.sh'), 'watch'], {
      cwd: T,
      env: {
        ...gitEnv,
        PATH: `${bin}:${process.env.PATH}`,
        HOME: T,
        TALOS_CI_CACHE: cache,
        GH_TOKEN: 't',
        TALOS_CI_ALERTS_EVERY: '0.2',
      },
      detached: true,
      stdio: ['ignore', 'pipe', 'ignore'],
    })
    let text = ''
    p.stdout.on('data', (b: Buffer) => {
      text += b.toString()
    })
    const exited = new Promise((done) => p.on('exit', done))
    const stop = () => {
      try {
        if (p.pid) process.kill(-p.pid, 'SIGKILL')
      } catch {} // already gone
    }
    kills.push(stop)
    return {
      out: () => text,
      kill: async () => {
        stop()
        await exited
      },
    }
  }
  const untested = () => {
    alert(shas[0] as string) // makes the runner's checkout once
    return spawnSync('bash', ['scripts/ci-runner.sh', 'untested'], {
      cwd: r,
      env: {
        ...gitEnv,
        PATH: `${bin}:${process.env.PATH}`,
        HOME: T,
        TALOS_CI_CACHE: cache,
        GH_TOKEN: 't',
        GITHUB_REPOSITORY: 'owner/talos-app',
      },
      encoding: 'utf8',
    })
  }
  return {
    T,
    r,
    cache,
    inbox,
    git,
    commit,
    green,
    red,
    status,
    main,
    log,
    notrun,
    alert,
    alerts,
    read,
    watch,
    watcher,
    untested,
  }
}

describe('ci-runner.sh alert: one message when main goes red, one when it is green again', () => {
  it('red once per streak, with the jobs, the failing tests, the first red commit and the commits since the last green', () => {
    const s = setup()
    const c1 = s.commit('base: all good')
    s.green(c1)
    expect(s.alert(c1).status).toBe(0)
    expect(s.alerts()).toEqual([]) // green to start with: nothing to say

    const c2 = s.commit('scripts: a change that breaks two jobs')
    s.red(c2, ['check', 'browser'])
    s.log(
      c2,
      'check',
      [
        ' FAIL  |scripts| ci-local.test.ts > slots > one holder at a time',
        '(fail) the tmux host > signal reaches the group [12.00ms]',
        ' FAIL  |scripts| ci-local.test.ts > slots > one holder at a time',
        '(pass) something else [1.00ms]',
      ].join('\n'),
    )
    s.log(
      c2,
      'browser',
      [
        '  ✘   12 [iphone] › test/shell/phone-chat.spec.ts:378:5 › header keeps its menu (570ms)',
        '  ✘   19 [iphone] › test/shell/phone-chat.spec.ts:378:5 › header keeps its menu (retry #1) (792ms)',
        '  ✓   20 [iphone] › test/shell/other.spec.ts:1:1 › fine (10ms)',
      ].join('\n'),
    )
    const r2 = s.alert(c2)
    expect(r2.status).toBe(0)
    expect(s.alerts(), r2.stdout + r2.stderr).toHaveLength(1)
    const m = s.read(s.alerts()[0] as string)
    expect(m).toContain(`main is RED at ${c2.slice(0, 7)}: check browser`)
    expect(m).toMatch(new RegExp(`first red ${c2.slice(0, 7)}, red for \\d+m`))
    expect(m).toContain('|scripts| ci-local.test.ts > slots > one holder at a time')
    expect(m.match(/one holder at a time/g)).toHaveLength(1) // deduped
    expect(m).toContain('the tmux host > signal reaches the group')
    expect(m).toContain('test/shell/phone-chat.spec.ts:378:5 › header keeps its menu')
    expect(m).not.toContain('retry #1')
    expect(m).not.toContain('something else')
    expect(m).toContain(`commits since the last green ${c1.slice(0, 7)}:`)
    expect(m).toContain(`${c2.slice(0, 7)} Builder One scripts: a change that breaks two jobs`)
    expect(m).not.toContain('base: all good')
    expect(m).toContain('https://github.com/owner/talos-app/actions/runs/77')

    // still red on the next commit: silent
    const c3 = s.commit('web: unrelated')
    s.red(c3, ['check'])
    expect(s.alert(c3).status).toBe(0)
    expect(s.alerts()).toHaveLength(1)

    // green again: one line, then silent while it stays green
    const c4 = s.commit('scripts: the fix')
    s.green(c4)
    // the new file, not "the one that is not first": names start with the epoch second, so two alerts of one second sort by
    // their random sha, and the green one could come first (it did, on Titan's WSL, about one run in three)
    const before = s.alerts()
    expect(s.alert(c4).status).toBe(0)
    const again = s.alerts().filter((f) => !before.includes(f))
    expect(again).toHaveLength(1)
    expect(s.read(again[0] as string)).toContain(
      `main is green again at ${c4.slice(0, 7)} (red since ${c2.slice(0, 7)}, for `,
    )
    const c5 = s.commit('docs')
    s.green(c5)
    s.alert(c5)
    expect(s.alerts()).toHaveLength(2)
  })

  it('a cancelled commit ("not tested:" errors) is no verdict: no red alert, and the streak is unchanged', () => {
    const s = setup()
    const c1 = s.commit('base')
    s.green(c1)
    s.alert(c1)
    const c2 = s.commit('cancelled')
    writeFileSync(
      join(s.T, 'status', c2),
      SIX.map(
        (j) => `local-ci/${j}\terror\tnot tested: run cancelled before this job reported (on ci-runner); re-run\n`,
      ).join(''),
    )
    const r = s.alert(c2)
    expect(r.status).toBe(0)
    expect(r.stdout).toContain('has no verdict')
    expect(s.alerts()).toEqual([])
  })

  it('a commit a run stood aside from (report-ci/superseded, nothing under local-ci/) is no verdict: no red, no "green again", the streak is unchanged', () => {
    const s = setup()
    const c1 = s.commit('base')
    s.green(c1)
    s.alert(c1)
    const c2 = s.commit('breaks')
    s.red(c2, ['check'])
    s.alert(c2)
    expect(s.alerts()).toHaveLength(1) // main is RED at c2
    const c3 = s.commit('superseded by c4')
    writeFileSync(
      join(s.T, 'status', c3),
      "report-ci/superseded\tsuccess\tnot tested: superseded by 1234567; CI tests main's newest commit\t2026-11-16T10:00:00Z\n",
    )
    const r = s.alert(c3)
    expect(r.status).toBe(0)
    expect(r.stdout).toContain('has no verdict')
    expect(s.alerts()).toHaveLength(1) // nothing new: not "green again", not another red
    // the streak is as c2 left it: the next real result continues it
    const c4 = s.commit('fixed')
    s.green(c4)
    s.alert(c4)
    expect(s.alerts().some((f) => f.endsWith('-green.txt'))).toBe(true)
  })

  it('only real failures: not a passing test with FAIL in its name, not Swift Testing\u2019s issue, suite or run \u2718 lines; colours stripped', () => {
    const s = setup()
    const c1 = s.commit('base')
    s.green(c1)
    s.alert(c1)
    const c2 = s.commit('breaks')
    s.red(c2, ['check', 'desktop'])
    s.log(
      c2,
      'check',
      [
        '(pass) D55 doctor refuses the key: FAIL with the fix (the BRIDGE_PUBKEY line) [708.56ms]',
        '\u001b[31m FAIL \u001b[39m \u001b[22m|scripts| a.test.ts > b > c\u001b[49m',
      ].join('\n'),
    )
    s.log(
      c2,
      'desktop',
      [
        '\u2718 Test checkFlags() recorded an issue at A.swift:3:1: Expectation failed',
        '\u2718 Suite Flags failed after 0.1 seconds with 1 issue.',
        '\u2718 Test run with 312 tests in 20 suites failed after 9.2 seconds with 1 issue.',
      ].join('\n'),
    )
    s.alert(c2)
    const m = s.read(s.alerts()[0] as string)
    expect(m).toContain('  |scripts| a.test.ts > b > c\n')
    expect(m).not.toContain('BRIDGE_PUBKEY')
    expect(m).not.toContain('\u001b')
    expect(m).not.toContain('Suite Flags')
    expect(m).not.toMatch(/\n\s*\n/) // no blank lines
  })

  // Python unittest (Chronos's suite, apps/chronos/tests/run.sh: each test file by itself): the summary header of a failed test,
  // "FAIL: test_x (__main__.Class.test_x)" or "ERROR: ...", under a line of "=". Not the verbose "... FAIL" line (the same test),
  // and not another tool's "FAIL:" or "error:" prose.
  const UNITTEST = [
    'test_a (__main__.Alpha.test_a) ... FAIL',
    'test_b (__main__.Beta.test_b) ... ERROR',
    'test_fine (__main__.Beta.test_fine) ... ok',
    '',
    '======================================================================',
    'FAIL: test_a (__main__.Alpha.test_a)',
    '----------------------------------------------------------------------',
    'Traceback (most recent call last):',
    'AssertionError: 1 != 2',
    '',
    '======================================================================',
    'ERROR: test_b (__main__.Beta.test_b)',
    '----------------------------------------------------------------------',
    '======================================================================',
    'FAIL: test_sub (__main__.Alpha.test_sub) (i=1)',
    '======================================================================',
    'FAIL: test_old (__main__.Gamma)', // Python before 3.11 names the class only
    'FAILED (failures=3, errors=1)',
    // the same file's test again from a second file's run (each Chronos test file runs by itself): named once
    '======================================================================',
    'FAIL: test_a (__main__.Alpha.test_a)',
    // other tools' lines: prose, an annotation, a shell test's own report
    'FAIL: kit test sandbox (exit 1)',
    'FAIL: test_prose (not a unittest header)',
    '======================================================================',
    'ERROR: cannot read the file (x)',
    'error: something went wrong',
    'ERROR: not_under_a_rule (__main__.Alpha.not_under_a_rule)',
  ].join('\n')
  const NAMES = ['test_a (Alpha.test_a)', 'test_b (Beta.test_b)', 'test_sub (Alpha.test_sub)', 'test_old (Gamma)']

  it('Python unittest: each failed or errored test is named once, as "test_x (Class.test_x)", from its summary header only', () => {
    const s = setup()
    const c1 = s.commit('base')
    s.green(c1)
    s.alert(c1)
    const c2 = s.commit('breaks chronos')
    s.red(c2, ['check'])
    s.log(c2, 'check', UNITTEST)
    s.alert(c2)
    const m = s.read(s.alerts()[0] as string)
    expect(m).toContain(`failing tests:\n${NAMES.map((n) => `  ${n}\n`).join('')}`)
    for (const prose of ['kit test sandbox', 'test_prose', 'cannot read', 'something went wrong', 'not_under_a_rule'])
      expect(m).not.toContain(prose)
    expect(m).not.toContain('none named')
  })

  it('Python unittest: the nightly and the hostile report name them too', () => {
    const rows = (prefix: string) =>
      SIX.map((j) => `${prefix}${j}\t${j === 'check' ? 'failure' : 'success'}\tx\t2026-11-15T11:50:00Z\n`).join('')
    const n = setup()
    const cn = n.commit('base')
    writeFileSync(join(n.T, 'status', cn), rows('nightly-ci/'))
    n.log(cn, 'check', UNITTEST, 'logs/nightly')
    n.alert(cn, { GITHUB_EVENT_NAME: 'schedule' })
    expect(n.read(n.alerts()[0] as string)).toContain(`failing tests:\n${NAMES.map((x) => `  ${x}\n`).join('')}`)
    const h = setup()
    const ch = h.commit('base')
    writeFileSync(join(h.T, 'status', ch), rows('hostile-ci/'))
    h.log(ch, 'check', UNITTEST, 'logs/hostile')
    h.alert(ch, { CI_HOSTILE: '1', GITHUB_EVENT_NAME: 'schedule' })
    expect(h.read(h.alerts()[0] as string).split('\n')[0]).toContain(
      `HOSTILE nightly at ${ch.slice(0, 7)}: 4 finding(s)`,
    )
    const rep = readFileSync(join(h.cache, 'hostile', `${new Date().toISOString().slice(0, 10)}.md`), 'utf8')
    expect(rep).toContain(`(4; nothing is retried):\n${NAMES.map((x) => `- ${x}\n`).join('')}`)
  })

  it('Swift Testing: every test that failed is named once, from its own "failed after" line (nothing is rerun)', () => {
    const s = setup()
    const c1 = s.commit('base')
    s.green(c1)
    s.alert(c1)
    const c2 = s.commit('breaks desktop')
    s.red(c2, ['desktop'])
    // the relevant lines of a real desktop log (a26e55f): two tests fail; the suite and whole-run lines are not tests
    const real = [
      '✘ Test aDraftHoldEndedByANoBoxTickStillRetypesTheLine() recorded an issue at PointerOwedEnterTests.swift:77:5: Expectation failed: r.wait(10) { r.up("trip") }',
      '✔ Test runningHoldsAndStopReleases(kind:) with 2 test cases passed after 8.791 seconds.',
      '✘ Test anOwnersParkSaysOwnerAndACrashSaysCrash() recorded an issue at WorkerStatusFieldsTests.swift:59:5: Expectation failed: r.wait(10) { r.state("trip") == "parked" }',
      '\u001b[91m✘\u001b[0m Test anOwnersParkSaysOwnerAndACrashSaysCrash() failed after 38.478 seconds with 1 issue.',
      '✘ Suite "workers.json: needs_you, stopped_why, turn_started_at" failed after 99.304 seconds with 1 issue.',
      '✘ Test aDraftHoldEndedByANoBoxTickStillRetypesTheLine() failed after 96.896 seconds with 4 issues.',
      '✘ Suite "An owed Enter goes only onto our own line" failed after 156.827 seconds with 4 issues.',
      '✘ Test run with 864 tests in 132 suites failed after 250.490 seconds with 6 issues (including 1 known issue).',
    ]
    // a second package whose test failed
    const second = ['✘ Test aCrashingCase(kind:) with 2 test cases failed after 1.0 seconds with 1 issue.']
    s.log(c2, 'desktop', [...real, ...second].join('\n'))
    s.alert(c2)
    const m = s.read(s.alerts()[0] as string)
    expect(m).toContain(
      'failing tests:\n  anOwnersParkSaysOwnerAndACrashSaysCrash()\n  aDraftHoldEndedByANoBoxTickStillRetypesTheLine()\n  aCrashingCase(kind:)\n',
    )
    expect(m.match(/anOwnersPark/g)).toHaveLength(1)
    expect(m).not.toContain('none named')
    expect(m).not.toContain('Suite')
    expect(m).not.toContain('Test run')
    expect(m).not.toContain('\u001b')
  })

  it('Playwright with and without a [project] (apps/web and e2e): a test that passed on a retry is flaky, not failing; a test failing every try is named once', () => {
    const s = setup()
    const c1 = s.commit('base')
    s.green(c1)
    s.alert(c1)
    const c2 = s.commit('breaks browser')
    s.red(c2, ['browser'])
    // the relevant lines of real browser logs (2407893, 1cb1d3e): apps/web's projects, then the e2e package's (no project)
    const sess = 'test/thread-sessions/session-status.spec.ts:80:3 › the row says what the session waits on'
    const e15 = 'tests/apps.spec.ts:525:1 › E15. switched off while a view is open (tool list: E15b)'
    const wake = 'tests/schedules.spec.ts:393:1 › wake: the Mac was away past the fire time'
    const oversize =
      'tests/bridge-oversize-card.spec.ts:16:1 › a card.create over 256 KiB must not knock the bridge socket'
    s.log(
      c2,
      'browser',
      [
        `  ✘  1900 [pixel] › ${sess} (dark) (788ms)`,
        `  ✓  1914 [pixel] › ${sess} (dark) (retry #1) (1.5s)`,
        `  ✘  2912 [desktop] › ${sess} (light) (1.0s)`,
        `  ✘  2935 [desktop] › ${sess} (light) (retry #1) (1.2s)`,
        `  1) [pixel] › ${sess} (dark) `,
        '  1 failed',
        '  1 flaky',
        `\u001b[31m  ✘\u001b[39m   64 ${e15} (13.1s)`,
        `  ✘   70 ${e15} (retry #1) (8.4s)`,
        `  ✘   77 ${oversize} (4.7s)`,
        `  ✓   82 ${oversize} (retry #1) (6.4s)`,
        `  ✘  113 ${wake} (1.5m)`, // a minute or more: Playwright says m
        `  ✘  121 ${wake} (retry #1) (1.4m)`,
        `  ✘  130 ${sess} (slow) (1.6m)`,
        `  ✓  131 ${sess} (slow) (retry #1) (2.0m)`,
        `  1) ${e15} `,
        `  2) ${wake} `,
        '  2 failed',
        `    ${e15} `,
        '  1 flaky',
        `    ${oversize} `,
      ].join('\n'),
    )
    s.alert(c2)
    const m = s.read(s.alerts()[0] as string)
    expect(m).toContain(`failing tests:\n  [desktop] › ${sess} (light)\n  ${e15}\n  ${wake}\n`)
    expect(m).not.toContain('[pixel]') // passed on its retry
    expect(m).not.toContain('bridge-oversize') // flaky
    expect(m).not.toContain('retry #')
    expect(m.match(/E15\./g)).toHaveLength(1)
  })

  it('within a red streak: a changed set of failing tests is said once ("still RED"); the same set again is not', () => {
    const s = setup()
    const c1 = s.commit('base')
    s.green(c1)
    s.alert(c1)
    const fails = (sha: string, names: string[]) => {
      s.red(sha, ['check'])
      s.log(sha, 'check', names.map((n) => `(fail) ${n} [1ms]`).join('\n'))
    }
    const c2 = s.commit('breaks a and b')
    fails(c2, ['a', 'b'])
    s.alert(c2)
    expect(s.alerts()).toHaveLength(1)
    const c3 = s.commit('same two, other order')
    fails(c3, ['b', 'a'])
    s.alert(c3)
    expect(s.alerts()).toHaveLength(1) // the same set: silent
    const c4 = s.commit('a fixed, c broken')
    fails(c4, ['b', 'c'])
    const before = s.alerts()
    expect(s.alert(c4).status).toBe(0)
    const added = s.alerts().filter((f) => !before.includes(f))
    expect(added).toHaveLength(1)
    const m = s.read(added[0] as string)
    expect(m.split('\n')[0]).toBe(
      `main is still RED at ${c4.slice(0, 7)}: new failures: c; now passing: a; still failing: 1`,
    )
    expect(m).toContain('https://github.com/owner/talos-app/actions/runs/77')
    const c5 = s.commit('no change')
    fails(c5, ['c', 'b'])
    s.alert(c5)
    expect(s.alerts()).toHaveLength(2) // the set last said, again: silent
    const c6 = s.commit('no names in the logs')
    s.red(c6, ['check'])
    s.alert(c6)
    expect(s.alerts()).toHaveLength(2) // nothing to compare: silent, and the set is kept
    const c6b = s.commit('one red job names none')
    s.red(c6b, ['check', 'mod'])
    s.log(c6b, 'check', '(fail) b [1ms]')
    s.alert(c6b)
    expect(s.alerts()).toHaveLength(2) // c may still fail inside mod: not "now passing"
    // many new ones: at most 15 named, then how many more
    const c7 = s.commit('breaks a lot')
    fails(c7, ['b', 'c', ...Array.from({ length: 20 }, (_, i) => `n${i}`)])
    const before7 = s.alerts()
    s.alert(c7)
    const m7 = s.read(s.alerts().filter((f) => !before7.includes(f))[0] as string)
    expect(m7.split('\n')[0]).toBe(
      `main is still RED at ${c7.slice(0, 7)}: new failures: ${Array.from({ length: 15 }, (_, i) => `n${i}`).join(', ')}, and 5 more; now passing: none; still failing: 2`,
    )
    // green again: the usual line, and the set is cleared
    const c8 = s.commit('fix')
    s.green(c8)
    s.alert(c8)
    expect(readFileSync(join(s.cache, 'main-streak'), 'utf8')).not.toMatch(/^failing=/m)
  })

  it('a streak file from before failing sets were kept is still read: no "still RED" for its first red commit, then as usual', () => {
    const s = setup()
    const c1 = s.commit('base')
    s.green(c1)
    s.alert(c1)
    const c2 = s.commit('red, said by the old runner')
    s.red(c2, ['check'])
    s.alert(c2) // makes the runner's checkout
    const at = Math.floor(Date.now() / 1000) - 600
    writeFileSync(join(s.cache, 'main-streak'), `state=red\nsha=${c2}\nfirst=${c2}\nfirst_at=${at}\ngreen=${c1}\n`)
    const c3 = s.commit('still red')
    s.red(c3, ['check'])
    s.log(c3, 'check', '(fail) a [1ms]')
    const before = s.alerts()
    expect(s.alert(c3).status).toBe(0)
    expect(s.alerts()).toEqual(before) // no set on record to compare with: recorded, not said
    const streak = readFileSync(join(s.cache, 'main-streak'), 'utf8')
    expect(streak).toContain(`first=${c2}\nfirst_at=${at}\ngreen=${c1}\n`)
    expect(streak).toMatch(/^failing=a$/m)
    const c4 = s.commit('another')
    s.red(c4, ['check'])
    s.log(c4, 'check', '(fail) b [1ms]')
    s.alert(c4)
    const added = s.alerts().filter((f) => !before.includes(f))
    expect(added).toHaveLength(1)
    expect(s.read(added[0] as string)).toContain('new failures: b; now passing: a; still failing: 0')
  })

  it('a long list of commits says how many more there are', () => {
    const s = setup()
    const c1 = s.commit('base')
    s.green(c1)
    s.alert(c1)
    let last = ''
    for (let i = 0; i < 25; i++) last = s.commit(`commit ${i}`)
    s.red(last, ['mod'])
    s.alert(last)
    const m = s.read(s.alerts()[0] as string)
    expect(m.match(/ commit \d+/g)).toHaveLength(20)
    expect(m).toContain('... and 5 more commits')
  })

  it('at most ten failing tests, then how many more', () => {
    const s = setup()
    const c1 = s.commit('base')
    s.green(c1)
    s.alert(c1)
    const c2 = s.commit('breaks a lot')
    s.red(c2, ['check'])
    s.log(c2, 'check', Array.from({ length: 15 }, (_, i) => `(fail) case ${i} [1ms]`).join('\n'))
    s.alert(c2)
    const m = s.read(s.alerts()[0] as string)
    expect(m.match(/case \d+/g)).toHaveLength(10)
    expect(m).toContain('and 5 more')
  })

  it('no verdict yet (pending, no status, an error only), a commit not on main, or an older result: nothing', () => {
    const s = setup()
    const c1 = s.commit('base')
    s.green(c1)
    s.alert(c1)
    const c2 = s.commit('pending')
    s.status(c2, { check: 'pending' })
    s.alert(c2)
    const c3 = s.commit('none')
    s.alert(c3)
    expect(s.alerts()).toEqual([])
    // a branch commit, never on main
    s.git(join(s.T, 'w'), 'checkout', '-q', '-b', 'side')
    const b = s.commit('side work', 'side')
    s.red(b, ['check'])
    s.alert(b)
    expect(s.alerts()).toEqual([])
    // main moves on and is green; a late red result for an older commit changes nothing
    s.git(join(s.T, 'w'), 'checkout', '-q', 'main')
    s.git(join(s.T, 'w'), 'reset', '-q', '--hard', c3)
    const c4 = s.commit('newer')
    s.green(c4)
    s.alert(c4)
    s.red(c3, ['mod'])
    s.alert(c3)
    expect(s.alerts()).toEqual([])
  })
})

// The nightly (a schedule run) posts nightly-ci/* only. Its alert reads those, says "nightly", and never touches main's streak:
// a push run's local-ci/* is main's verdict, whatever the nightly found (87169cd9, 2026-11-14).
describe("ci-runner.sh alert for the nightly: its own nightly-ci/* only, never main's verdict or streak", () => {
  const SIX_ROWS = (prefix: string, st: (j: string) => string) =>
    SIX.map(
      (j) =>
        `${prefix}${j}\t${st(j)}\t${st(j) === 'success' ? 'passed on ci-runner in 9s' : 'failed on ci-runner'}\t2026-11-14T16:18:00Z\n`,
    ).join('')

  it('a red nightly on a commit whose push run was green: one "NIGHTLY" message; main\'s streak is unchanged', () => {
    const s = setup()
    const c1 = s.commit('base: all good')
    s.green(c1)
    expect(s.alert(c1).status).toBe(0) // the push run: green, the streak says so
    const streak = readFileSync(join(s.cache, 'main-streak'), 'utf8')
    writeFileSync(
      join(s.T, 'status', c1),
      SIX_ROWS('local-ci/', () => 'success') +
        SIX_ROWS('nightly-ci/', (j) => (j === 'check' ? 'failure' : 'success')) +
        'nightly-ci/report-linux\tfailure\tfailed on hestia\t2026-11-14T16:30:00Z\n',
    )
    s.log(c1, 'check', ' FAIL  apps/bridge/test/a.test.ts > a nightly-only fuzz\n', 'logs/nightly')
    const r = s.alert(c1, { GITHUB_EVENT_NAME: 'schedule' })
    expect(r.status, r.stderr).toBe(0)
    const files = s.alerts()
    expect(files).toHaveLength(1)
    expect(files[0]).toMatch(/-nightly-red\.txt$/)
    const msg = s.read(files[0] as string)
    expect(msg).toMatch(
      /^main's NIGHTLY is RED at [0-9a-f]{7}: check \(nightly-ci\/\*; main's push verdict, local-ci\/\*, is unchanged\)/,
    )
    expect(msg).toContain('a nightly-only fuzz')
    expect(msg).not.toContain('linux') // a report-only nightly context is not a job of the six
    expect(readFileSync(join(s.cache, 'main-streak'), 'utf8')).toBe(streak)
  })

  it('a red nightly lists every NOT RUN line of its red jobs, with a count in its first line, and none of a green job', () => {
    const s = setup()
    const c1 = s.commit('base')
    writeFileSync(
      join(s.T, 'status', c1),
      SIX_ROWS('nightly-ci/', (j) => (j === 'check' ? 'failure' : 'success')),
    )
    s.log(c1, 'check', ' FAIL  apps/bridge/test/a.test.ts > a nightly-only fuzz\n', 'logs/nightly')
    s.notrun(
      c1,
      'check',
      'NOT RUN: step_bun_rest (step_contract, step_bun_schedules or step_chronos failed)\nNOT RUN: step_vitest (step_contract, step_bun_schedules or step_chronos failed)\n',
      'logs/nightly',
    )
    s.notrun(c1, 'mod', 'NOT RUN: step_made_up (a green job is not asked)\n', 'logs/nightly')
    expect(s.alert(c1, { GITHUB_EVENT_NAME: 'schedule' }).status).toBe(0)
    const msg = s.read(s.alerts()[0] as string)
    expect(msg.split('\n')[0]).toMatch(/is unchanged\), 2 suite\(s\) NOT RUN$/)
    expect(msg).toContain(
      'NOT RUN, left out (2):\n' +
        '  check: NOT RUN: step_bun_rest (step_contract, step_bun_schedules or step_chronos failed)\n' +
        '  check: NOT RUN: step_vitest (step_contract, step_bun_schedules or step_chronos failed)\n',
    )
    expect(msg).not.toContain('step_made_up')
  })

  it("a green nightly says nothing; a push run never reads a red nightly as main's verdict", () => {
    const s = setup()
    const c1 = s.commit('base')
    writeFileSync(
      join(s.T, 'status', c1),
      SIX_ROWS('nightly-ci/', () => 'success'),
    )
    expect(s.alert(c1, { GITHUB_EVENT_NAME: 'schedule' }).status).toBe(0)
    expect(s.alerts()).toEqual([])
    // the push run's alert step on a commit with a green push verdict and a red nightly: green, no red message
    writeFileSync(
      join(s.T, 'status', c1),
      SIX_ROWS('nightly-ci/', () => 'failure') + SIX_ROWS('local-ci/', () => 'success'),
    )
    expect(s.alert(c1, { GITHUB_EVENT_NAME: 'push' }).status).toBe(0)
    expect(s.alerts()).toEqual([])
    expect(readFileSync(join(s.cache, 'main-streak'), 'utf8')).toMatch(/^state=green$/m)
  })
})

// The hostile nightly (CI_HOSTILE=1: its own schedule, or a dispatch) posts hostile-ci/* only. Every run appends to the day's
// report (<cache>/hostile/<UTC date>.md); a red one writes ONE alert of its own kind, never "main is RED", never the streak.
describe('ci-runner.sh alert for the hostile nightly: a report, and one "hostile" alert when red', () => {
  const ROWS = (prefix: string, st: (j: string) => string) =>
    SIX.map(
      (j) =>
        `${prefix}${j}\t${st(j)}\t${st(j) === 'success' ? 'passed on ci-runner in 9s' : 'failed on ci-runner'}\t2026-11-15T11:50:00Z\n`,
    ).join('')
  const conditions = (cache: string, sha: string) => {
    mkdirSync(join(cache, 'hostile'), { recursive: true })
    writeFileSync(
      join(cache, 'hostile', `${sha.slice(0, 7)}.conditions`),
      'clock: +30 days for JavaScript\ntime zone: TZ=Pacific/Kiritimati (+1400)\n',
    )
    writeFileSync(
      join(cache, 'hostile', `${sha.slice(0, 7)}.load`),
      'load: burner stopped, none left (group 5)\nload: burner stopped, none left (group 6)\n',
    )
  }
  const report = (cache: string) =>
    readFileSync(join(cache, 'hostile', `${new Date().toISOString().slice(0, 10)}.md`), 'utf8')

  it('red: one "HOSTILE" alert with a one-line summary; the report has the conditions and the findings, each "failed once" in the named run', () => {
    const s = setup()
    const c1 = s.commit('base: all good')
    s.green(c1)
    expect(s.alert(c1).status).toBe(0) // the push run: green
    const streak = readFileSync(join(s.cache, 'main-streak'), 'utf8')
    writeFileSync(
      join(s.T, 'status', c1),
      ROWS('local-ci/', () => 'success') + ROWS('hostile-ci/', (j) => (j === 'check' ? 'failure' : 'success')),
    )
    s.log(c1, 'check', ' FAIL  apps/bridge/test/usage.test.ts > the pool resets at month end\n', 'logs/hostile')
    conditions(s.cache, c1)
    const r = s.alert(c1, { GITHUB_EVENT_NAME: 'schedule', CI_HOSTILE: '1' })
    expect(r.status, r.stderr).toBe(0)
    const files = s.alerts()
    expect(files).toHaveLength(1) // nothing else from this step: no untested or Linux report lines
    expect(files[0]).toMatch(/-hostile\.txt$/)
    const msg = s.read(files[0] as string)
    expect(msg.split('\n')[0]).toMatch(
      /^HOSTILE nightly at [0-9a-f]{7}: 1 finding\(s\) \(each failed once; nothing is retried\); red: check\. Test fixes, not a red main \(local-ci\/\* unchanged\)\.$/,
    )
    expect(msg).not.toMatch(/main is RED|NIGHTLY/)
    expect(readFileSync(join(s.cache, 'main-streak'), 'utf8')).toBe(streak)
    const rep = report(s.cache)
    expect(rep).toMatch(new RegExp(`^## ${c1.slice(0, 7)}, \\d\\d:\\d\\d UTC: red$`, 'm'))
    expect(rep).toContain('- clock: +30 days for JavaScript\n- time zone: TZ=Pacific/Kiritimati (+1400)\n')
    expect(rep).toContain(
      '- load per hold of the heavy lock: 2 with a burner (its first 600 s), 0 not applied, 0 with burners left over (killed)',
    )
    expect(rep).toContain(
      'Findings, each failed once in https://github.com/owner/talos-app/actions/runs/77 (1; nothing is retried):\n- apps/bridge/test/usage.test.ts > the pool resets at month end\n',
    )
    // nothing retries, so nothing can have "failed twice" or "passed on retry": neither is said, in the alert or the report
    expect(msg + rep).not.toMatch(/twice|[Ff]laky|on retry/)
  })

  it('NOT RUN lines of the red jobs: counted in the summary, listed under their own heading; a report with none says "none recorded"', () => {
    const s = setup()
    const c1 = s.commit('base')
    writeFileSync(
      join(s.T, 'status', c1),
      ROWS('hostile-ci/', (j) => (j === 'check' || j === 'desktop' ? 'failure' : 'success')),
    )
    s.log(c1, 'check', ' FAIL  apps/bridge/test/a.test.ts > a\n', 'logs/hostile')
    s.notrun(c1, 'check', 'NOT RUN: step_vitest (step_contract failed)\n', 'logs/hostile')
    s.notrun(
      c1,
      'desktop',
      'NOT RUN: guards-test.sh (test.sh failed)\nNOT RUN: install-test.sh (test.sh failed)\n',
      'logs/hostile',
    )
    s.notrun(c1, 'mod', 'NOT RUN: step_made_up (a green job is not asked)\n', 'logs/hostile')
    expect(s.alert(c1, { CI_HOSTILE: '1', GITHUB_EVENT_NAME: 'schedule' }).status).toBe(0)
    expect(s.read(s.alerts()[0] as string).split('\n')[0]).toMatch(
      /^HOSTILE nightly at [0-9a-f]{7}: 1 finding\(s\) \(each failed once; nothing is retried\), 3 suite\(s\) NOT RUN; red: check desktop\. Test fixes/,
    )
    expect(report(s.cache)).toContain(
      '\nNOT RUN, left out (3):\n- check: NOT RUN: step_vitest (step_contract failed)\n' +
        '- desktop: NOT RUN: guards-test.sh (test.sh failed)\n- desktop: NOT RUN: install-test.sh (test.sh failed)\n',
    )
    expect(report(s.cache)).not.toContain('step_made_up')
    const c2 = s.commit('next')
    writeFileSync(
      join(s.T, 'status', c2),
      ROWS('hostile-ci/', () => 'success'),
    )
    expect(s.alert(c2, { CI_HOSTILE: '1' }).status).toBe(0)
    expect(report(s.cache).split(`## ${c2.slice(0, 7)}`)[1]).toContain('NOT RUN, left out (0):\n- none recorded\n')
  })

  it('green: no alert; a second run appends a section of its own', () => {
    const s = setup()
    const c1 = s.commit('base')
    writeFileSync(
      join(s.T, 'status', c1),
      ROWS('hostile-ci/', () => 'success'),
    )
    expect(s.alert(c1, { CI_HOSTILE: '1', GITHUB_EVENT_NAME: 'workflow_dispatch' }).status).toBe(0)
    expect(s.alerts()).toEqual([])
    expect(existsSync(join(s.cache, 'main-streak'))).toBe(false)
    expect(s.alert(c1, { CI_HOSTILE: '1', GITHUB_EVENT_NAME: 'workflow_dispatch' }).status).toBe(0)
    const rep = report(s.cache)
    expect(rep.match(/^## [0-9a-f]{7}, .*: green$/gm)).toHaveLength(2)
    expect(rep).toContain('(0; nothing is retried):\n- none\n')
    expect(rep).toContain('- none recorded (the run did not get as far as its slot)')
  })

  it("Titan's report-only parts (CI_TITAN_HOSTILE=shadow) are listed, never in the result: a red one alone is no alert", () => {
    const s = setup()
    const c1 = s.commit('base')
    writeFileSync(
      join(s.T, 'status', c1),
      `${ROWS('hostile-ci/', () => 'success')}hostile-ci/report-check\tfailure\tfailed on titan; 2 failed\t2026-11-15T12:10:00Z\n` +
        'hostile-ci/report-browser-e2e\tpending\trunning on titan\t2026-11-15T12:00:00Z\n' +
        'hostile-ci/report-check\tpending\trunning on titan\t2026-11-15T11:50:00Z\n',
    )
    const r = s.alert(c1, { CI_HOSTILE: '1', GITHUB_EVENT_NAME: 'schedule' })
    expect(r.status, r.stderr).toBe(0)
    expect(s.alerts()).toEqual([])
    const rep = report(s.cache)
    expect(rep).toMatch(/^## [0-9a-f]{7}, .*: green$/m)
    expect(rep).toContain(
      "\nReport-only, not in the result above (Titan: CI_TITAN_HOSTILE=shadow; its tests are in its job's logs):\n" +
        '- hostile-ci/report-check: failure (failed on titan; 2 failed)\n' +
        '- hostile-ci/report-browser-e2e: pending (running on titan)\n',
    )
    // none: no such section
    const c2 = s.commit('next')
    writeFileSync(
      join(s.T, 'status', c2),
      ROWS('hostile-ci/', () => 'success'),
    )
    expect(s.alert(c2, { CI_HOSTILE: '1', GITHUB_EVENT_NAME: 'schedule' }).status).toBe(0)
    expect(report(s.cache).split(`## ${c2.slice(0, 7)}`)[1]).not.toContain('Report-only')
  })

  it('a NOT RUN line in a job log is not a suite left out: only the .notrun file beside it is read, so a test that prints one is not counted', () => {
    const s = setup()
    const c1 = s.commit('base')
    writeFileSync(
      join(s.T, 'status', c1),
      ROWS('hostile-ci/', (j) => (j === 'check' ? 'failure' : 'success')),
    )
    // a test's own output: it printed the shape of one (no .notrun file was written)
    s.log(
      c1,
      'check',
      ' FAIL  apps/bridge/test/a.test.ts > a\nNOT RUN: step_made_up (printed by a test)\n',
      'logs/hostile',
    )
    expect(s.alert(c1, { CI_HOSTILE: '1', GITHUB_EVENT_NAME: 'schedule' }).status).toBe(0)
    expect(s.read(s.alerts()[0] as string).split('\n')[0]).not.toContain('NOT RUN')
    const rep = report(s.cache)
    expect(rep).not.toContain('step_made_up')
    expect(rep).toContain('(0):\n- none recorded in the logs of the red job(s): check\n')
  })

  it('the NOT RUN list is clean and capped: control characters out, a line at most 300 characters, 50 a job then the true count', () => {
    const s = setup()
    const c1 = s.commit('base')
    writeFileSync(
      join(s.T, 'status', c1),
      ROWS('hostile-ci/', (j) => (j === 'check' ? 'failure' : 'success')),
    )
    const lines = [
      'NOT RUN: a\u001b[31mred\u001b[0m\r (bell\u0007 and escape)',
      'a stray line that is not one',
      `NOT RUN: long (${'x'.repeat(1000)})`,
      ...Array.from({ length: 80 }, (_v, i) => `NOT RUN: step_${i} (why)`),
    ]
    s.notrun(c1, 'check', `${lines.join('\n')}\n`, 'logs/hostile')
    expect(s.alert(c1, { CI_HOSTILE: '1', GITHUB_EVENT_NAME: 'schedule' }).status).toBe(0)
    const rep = report(s.cache)
    const section = rep.split('NOT RUN, left out')[1]?.split('\n\n')[0] as string
    expect(section.startsWith(' (82):')).toBe(true) // the true count, though the list is capped
    const listed = section.split('\n').slice(1).filter(Boolean)
    expect(listed).toHaveLength(51) // 50 lines and the "and N more" line
    expect(listed[50]).toBe('- check: ... and 32 more not listed')
    expect(listed[0]).toBe('- check: NOT RUN: a[31mred[0m (bell and escape)') // no escape, return or bell character
    expect([...rep].some((c) => (c < ' ' && c !== '\n') || c === '\u007f')).toBe(false)
    expect(listed[1]?.length).toBeLessThanOrEqual('- check: '.length + 300)
    expect(listed.some((l) => l.includes('step_47 '))).toBe(true) // the first 50 NOT RUN lines: two, then step_0 to step_47
    expect(listed.some((l) => l.includes('step_48 '))).toBe(false) // the rest is not listed
    expect(s.read(s.alerts()[0] as string).split('\n')[0]).toContain(', 82 suite(s) NOT RUN;')
  })

  it('a job that ended in error (not tested, a slept Mac) is read too: its tests and its NOT RUN lines', () => {
    const s = setup()
    const c1 = s.commit('base')
    writeFileSync(
      join(s.T, 'status', c1),
      ROWS('hostile-ci/', (j) => (j === 'check' ? 'failure' : j === 'mobile' ? 'error' : 'success')),
    )
    s.log(c1, 'mobile', ' FAIL  apps/mobile/test/a.test.ts > a mobile test\n', 'logs/hostile')
    s.notrun(c1, 'mobile', 'NOT RUN: TalosShareCore (BridgeGuard failed)\n', 'logs/hostile')
    s.log(c1, 'check', ' FAIL  apps/bridge/test/a.test.ts > a\n', 'logs/hostile')
    expect(s.alert(c1, { CI_HOSTILE: '1', GITHUB_EVENT_NAME: 'schedule' }).status).toBe(0)
    const rep = report(s.cache)
    expect(rep).toContain('- apps/mobile/test/a.test.ts > a mobile test\n')
    expect(rep).toContain('- mobile: NOT RUN: TalosShareCore (BridgeGuard failed)\n')
    expect(s.read(s.alerts()[0] as string).split('\n')[0]).toContain('1 suite(s) NOT RUN; red: check mobile.')
  })

  it("the push run's logs of the same commit (logs/) are never read: not its failing tests or its NOT RUN lines", () => {
    const s = setup()
    const c1 = s.commit('base')
    writeFileSync(
      join(s.T, 'status', c1),
      ROWS('hostile-ci/', (j) => (j === 'check' ? 'failure' : 'success')) + ROWS('local-ci/', () => 'success'),
    )
    s.log(c1, 'check', " FAIL  apps/bridge/test/a.test.ts > the push run's test\n")
    s.notrun(c1, 'check', 'NOT RUN: step_vitest (push)\n')
    s.log(c1, 'check', ' FAIL  apps/bridge/test/b.test.ts > the hostile test\n', 'logs/hostile')
    expect(s.alert(c1, { CI_HOSTILE: '1', GITHUB_EVENT_NAME: 'schedule' }).status).toBe(0)
    const rep = report(s.cache)
    expect(rep).toContain('(1; nothing is retried):\n- apps/bridge/test/b.test.ts > the hostile test\n')
    expect(rep).toContain('(0):\n- none recorded in the logs of the red job(s): check\n')
    expect(rep).not.toContain("push run's")
    expect(rep).not.toContain('step_vitest')
    expect(s.read(s.alerts()[0] as string)).not.toContain('NOT RUN')
  })

  it("a nightly alert reads logs/nightly/ only: the push run's log of the same commit is not its", () => {
    const s = setup()
    const c1 = s.commit('base')
    writeFileSync(
      join(s.T, 'status', c1),
      ROWS('nightly-ci/', (j) => (j === 'check' ? 'failure' : 'success')),
    )
    s.log(c1, 'check', " FAIL  apps/bridge/test/a.test.ts > the push run's test\n")
    expect(s.alert(c1, { GITHUB_EVENT_NAME: 'schedule' }).status).toBe(0)
    const msg = s.read(s.alerts()[0] as string)
    expect(msg).not.toContain("push run's test")
    expect(msg).toContain(`failing tests: none named in this runner's logs (${s.cache}/logs/nightly/`)
  })

  it("a push run never reads a red hostile run: main's verdict stays green, no alert", () => {
    const s = setup()
    const c1 = s.commit('base')
    writeFileSync(join(s.T, 'status', c1), ROWS('hostile-ci/', () => 'failure') + ROWS('local-ci/', () => 'success'))
    expect(s.alert(c1, { GITHUB_EVENT_NAME: 'push' }).status).toBe(0)
    expect(s.alerts()).toEqual([])
    expect(readFileSync(join(s.cache, 'main-streak'), 'utf8')).toMatch(/^state=green$/m)
  })
})

describe('scripts/ci-alerts.sh: how a session on this Mac picks the messages up', () => {
  const untilPrinted = async (w: { out: () => string }, re: RegExp) => {
    for (let i = 0; i < 100 && !re.test(w.out()); i++) await new Promise((r) => setTimeout(r, 50))
    expect(w.out()).toMatch(re)
  }

  it('watch prints a message with its id and leaves it waiting; only ack moves it to sent/; list shows the unacked', () => {
    const s = setup()
    const c1 = s.commit('base')
    s.green(c1)
    s.alert(c1)
    const c2 = s.commit('breaks')
    s.red(c2, ['mod'])
    s.alert(c2)
    const name = s.alerts()[0] as string
    const id = name.replace(/\.txt$/, '')
    expect(s.watch('list').stdout).toContain(name)
    const w = s.watch('watch', '--once')
    expect(w.status).toBe(0)
    const lines = w.stdout.trim().split('\n')
    expect(lines).toHaveLength(1)
    expect(lines[0]).toMatch(
      new RegExp(`^CI ALERT ${id}: main is RED at ${c2.slice(0, 7)}: mod .*ci-alerts\\.sh ack ${id}\\)$`),
    )
    // printed is not delivered: still waiting, still listed, and the next watcher offers it again
    expect(s.alerts()).toEqual([name])
    expect(s.watch('list').stdout).toContain(name)
    expect(s.watch('watch', '--once').stdout).toContain(`CI ALERT ${id}:`)
    // ack is what marks it sent
    const a = s.watch('ack', id)
    expect(a.status, a.stderr).toBe(0)
    expect(s.alerts()).toEqual([])
    expect(existsSync(join(s.cache, 'alerts', 'sent', name))).toBe(true)
    expect(s.watch('watch', '--once').stdout).toBe('')
    expect(s.watch('list').stdout).toContain('nothing waiting')
    expect(s.watch('ack', id).status).toBe(0) // twice is fine
    expect(s.watch('ack', 'no-such-alert').status).toBe(1)
    expect(s.watch('ack', '../x').status).toBe(64)
  })

  it('a message written between two watchers, or printed and never acked, is offered by the next one; once per watcher', async () => {
    const s = setup()
    const say = (id: string) => writeFileSync(join(s.cache, 'alerts', `${id}.txt`), `main is RED at ${id}\n`)
    mkdirSync(join(s.cache, 'alerts'), { recursive: true })
    say('1-aaaaaaa-red')
    const w1 = s.watcher()
    await untilPrinted(w1, /CI ALERT 1-aaaaaaa-red:/)
    say('2-bbbbbbb-red') // while it runs
    await untilPrinted(w1, /CI ALERT 2-bbbbbbb-red:/)
    await new Promise((r) => setTimeout(r, 1000)) // several more passes
    await w1.kill() // the Monitor's 30 minutes are up; neither was acked
    expect(w1.out().match(/CI ALERT 1-aaaaaaa-red:/g)).toHaveLength(1)
    expect(w1.out().match(/CI ALERT 2-bbbbbbb-red:/g)).toHaveLength(1)
    say('3-ccccccc-red') // in the gap, no watcher running
    const w2 = s.watcher()
    await untilPrinted(w2, /CI ALERT 3-ccccccc-red:/)
    await untilPrinted(w2, /CI ALERT 1-aaaaaaa-red:/)
    await untilPrinted(w2, /CI ALERT 2-bbbbbbb-red:/)
    await w2.kill()
    // the watcher's 10-minute slot also runs the relays check, which (with no relay list here) rightly writes its own alert: not what this is about
    expect(
      s
        .alerts()
        .filter((f) => !f.includes('-relay-'))
        .sort(),
    ).toEqual(['1-aaaaaaa-red.txt', '2-bbbbbbb-red.txt', '3-ccccccc-red.txt'])
  }, 20_000)
})

describe('watcher health: a heartbeat, and list says when something is wrong', () => {
  it('watch writes a heartbeat; list exits non-zero on a stale or missing one, and on a message waiting over 15 min', () => {
    const s = setup()
    expect(s.watch('list').status).toBe(1) // no watcher has ever run
    expect(s.watch('list').stdout).toContain('no watcher heartbeat')
    expect(s.watch('watch', '--once').status).toBe(0)
    const hb = join(s.cache, 'alerts', '.heartbeat')
    expect(Number(readFileSync(hb, 'utf8'))).toBeGreaterThan(Date.now() / 1000 - 60)
    const ok = s.watch('list')
    expect(ok.status, ok.stdout).toBe(0)
    expect(ok.stdout).toContain('nothing waiting')
    writeFileSync(hb, `${Math.floor(Date.now() / 1000) - 400}\n`)
    const stale = s.watch('list')
    expect(stale.status).toBe(1)
    expect(stale.stdout).toMatch(/the watcher's heartbeat is 6 min old/)
    writeFileSync(hb, `${Math.floor(Date.now() / 1000)}\n`)
    const f = join(s.cache, 'alerts', '1-abcdef0-red.txt')
    writeFileSync(f, 'main is RED at abcdef0: mod\n')
    utimesSync(f, new Date(Date.now() - 20 * 60_000), new Date(Date.now() - 20 * 60_000))
    const late = s.watch('list')
    expect(late.status).toBe(1)
    expect(late.stdout).toMatch(/1-abcdef0-red\.txt has waited 20 min without being acked/)
  })
})

describe('ci-runner.sh untested: one message when main has had no finished verdict for 2 h while commits landed', () => {
  const hoursAgo = (h: number) => new Date(Date.now() - h * 3600_000).toISOString().replace(/\.\d+Z$/, 'Z')

  it('says it once per gap, with the last tested commit, its age and how many are untested; clears on the next verdict', () => {
    const s = setup()
    const c1 = s.commit('tested')
    s.green(c1, hoursAgo(3))
    const c2 = s.commit('untested one')
    const c3 = s.commit('untested two')
    s.status(c3, { check: 'pending' }, hoursAgo(1)) // running, not finished
    s.main([
      [c1, hoursAgo(3.2)],
      [c2, hoursAgo(2.5)],
      [c3, hoursAgo(1)],
    ])
    expect(s.untested().status).toBe(0)
    expect(s.alerts()).toHaveLength(1)
    const m = s.read(s.alerts()[0] as string)
    expect(m).toMatch(
      new RegExp(
        `^main UNTESTED: no finished verdict for 2h 30m while 2 commits landed; last tested ${c1.slice(0, 7)} \\(green, 3h 0m ago\\)`,
      ),
    )
    s.untested()
    expect(s.alerts()).toHaveLength(1) // once per gap
    // a verdict lands: the gap closes, silently; a later gap is said again
    s.green(c3, hoursAgo(0))
    s.untested()
    expect(s.alerts()).toHaveLength(1)
    const c4 = s.commit('after')
    s.green(c3, hoursAgo(2.5))
    s.main([
      [c1, hoursAgo(3.2)],
      [c2, hoursAgo(2.5)],
      [c3, hoursAgo(2.6)],
      [c4, hoursAgo(2.2)],
    ])
    s.untested()
    expect(s.alerts()).toHaveLength(2)
  })

  it('a recent verdict, a commit that only just landed after a quiet day, or a tested tip, is not a gap', () => {
    const s = setup()
    const c1 = s.commit('tested')
    s.green(c1, hoursAgo(1))
    const c2 = s.commit('new')
    s.main([
      [c1, hoursAgo(1.2)],
      [c2, hoursAgo(0.5)],
    ])
    s.untested()
    expect(s.alerts()).toEqual([])
    // main tested yesterday, quiet since; a commit lands now and CI is on it: not untested yet, and no gap is used up
    s.green(c1, hoursAgo(26))
    s.main([
      [c1, hoursAgo(26.5)],
      [c2, hoursAgo(0.1)],
    ])
    s.untested()
    expect(s.alerts()).toEqual([])
    expect(existsSync(join(s.cache, 'main-untested'))).toBe(false)
    s.status(c2, Object.fromEntries(SIX.map((j) => [j, j === 'check' ? 'failure' : 'success'])), hoursAgo(5))
    s.untested()
    expect(s.alerts()).toEqual([]) // the tip itself has a verdict, however old
  })
})

// Linux reds that main's verdict does not see (report-only): Hestia's report-ci/linux, and check-titan's report-ci/check while
// CI_TITAN_CHECK is shadow. One alert when one goes red on main (its newest result), one when it is green again; never the
// nightly's nightly-ci/report-*, never ci-part/* (folded into the verdict), and "not tested", pending or error is no result.
describe("ci-runner.sh: main's Linux report (report-ci/linux, report-ci/check) red, or green again", () => {
  const now = () => new Date().toISOString().replace(/\.\d+Z$/, 'Z')
  const rows = (extra: Record<string, [string, string]>) =>
    SIX.map((j) => `local-ci/${j}\tsuccess\tpassed on ci-runner in 9s\t${now()}\n`).join('') +
    Object.entries(extra)
      .map(([ctx, [st, desc]]) => `${ctx}\t${st}\t${desc}\t${now()}\n`)
      .join('')
  const linux = (s: ReturnType<typeof setup>) => s.alerts().filter((f) => f.includes('-report-'))

  it("a red report-ci/browser-e2e (Titan's Linux e2e, e2e-shadow) on a green main is a Linux report alert too", () => {
    const s = setup()
    const c1 = s.commit('one')
    writeFileSync(join(s.T, 'status', c1), rows({ 'report-ci/browser-e2e': ['failure', 'failed on titan: e2e'] }))
    s.main([[c1, now()]])
    expect(s.alert(c1).status).toBe(0)
    const files = linux(s)
    expect(files).toHaveLength(1)
    expect(files[0]).toMatch(new RegExp(`-${c1.slice(0, 7)}-report-browser-e2e-red\\.txt$`))
  })

  it('a red report-ci/linux on a green main: one alert, said once however often it runs; green again once', () => {
    const s = setup()
    const set = (sha: string, extra: Record<string, [string, string]>) =>
      writeFileSync(join(s.T, 'status', sha), rows(extra))
    const c1 = s.commit('one')
    set(c1, { 'report-ci/linux': ['failure', 'failed on hestia: linux'] })
    s.main([[c1, now()]])
    expect(s.alert(c1).status).toBe(0) // the push run's alert step
    expect(s.untested().status).toBe(0) // and the watcher's every-10-minutes check
    let files = linux(s)
    expect(files).toHaveLength(1)
    expect(files[0]).toMatch(new RegExp(`-${c1.slice(0, 7)}-report-linux-red\\.txt$`))
    expect(s.read(files[0] as string)).toMatch(
      new RegExp(`^main's LINUX REPORT is RED at ${c1.slice(0, 7)}: report-ci/linux \\(failed on hestia: linux\\)`),
    )
    expect(s.watch('watch', '--once').stdout).toContain("main's LINUX REPORT is RED")
    // still red at the next commit, and not tested at the tip after it: nothing new
    const c2 = s.commit('two')
    const c3 = s.commit('three')
    set(c2, { 'report-ci/linux': ['failure', 'failed on hestia: linux'] })
    set(c3, { 'report-ci/linux': ['error', 'not tested: cancelled'] })
    s.main([
      [c1, now()],
      [c2, now()],
      [c3, now()],
    ])
    s.untested()
    expect(linux(s)).toHaveLength(1)
    // green at the tip: one green-again, however often it runs
    set(c3, { 'report-ci/linux': ['success', 'passed on hestia in 90s'] })
    s.untested()
    s.untested()
    files = linux(s)
    expect(files).toHaveLength(2)
    const green = files.find((f) => f.endsWith('-green.txt')) as string
    expect(s.read(green)).toMatch(
      new RegExp(
        `^main's LINUX REPORT is green again at ${c3.slice(0, 7)}: report-ci/linux \\(red since ${c1.slice(0, 7)}\\)`,
      ),
    )
  })

  it('no alert for the nightly, a part, a skip, "not tested" or pending; report-ci/check alerts unless check-titan is on', () => {
    const s = setup()
    const c1 = s.commit('one')
    s.main([[c1, now()]])
    writeFileSync(
      join(s.T, 'status', c1),
      rows({
        'nightly-ci/report-linux': ['failure', 'failed on hestia'],
        'ci-part/check': ['failure', 'failed on titan'],
        'report-ci/linux': ['success', 'not tested: superseded by abc1234'],
      }),
    )
    s.untested()
    expect(linux(s)).toEqual([])
    writeFileSync(join(s.T, 'status', c1), rows({ 'report-ci/linux': ['pending', 'running on hestia'] }))
    s.untested()
    expect(linux(s)).toEqual([])
    // check-titan in shadow: its red is a Linux red main's verdict does not see
    writeFileSync(join(s.T, 'status', c1), rows({ 'report-ci/check': ['failure', 'failed on titan: check'] }))
    s.alert(c1)
    expect(linux(s)).toHaveLength(1)
    expect(s.read(linux(s)[0] as string)).toMatch(
      /^main's LINUX REPORT is RED at [0-9a-f]{7}: report-ci\/check \(failed on titan: check\)/,
    )
  })

  it('check-titan turned on: an older shadow red is not said; its ci-part/check is part of the verdict', () => {
    const s = setup()
    const c1 = s.commit('shadow')
    const c2 = s.commit('on')
    writeFileSync(join(s.T, 'status', c1), rows({ 'report-ci/check': ['failure', 'failed on titan: check'] }))
    writeFileSync(join(s.T, 'status', c2), rows({ 'ci-part/check': ['success', 'passed on titan in 300s'] }))
    s.main([
      [c1, now()],
      [c2, now()],
    ])
    s.untested() // no CI_TITAN_CHECK here: the watcher on the Mac never has the plan's variables
    expect(linux(s)).toEqual([])
  })

  it('one alert per commit and context going red, even when two runs read the state before either wrote it', () => {
    const s = setup()
    const c1 = s.commit('one')
    writeFileSync(join(s.T, 'status', c1), rows({ 'report-ci/linux': ['failure', 'failed on hestia'] }))
    s.main([[c1, now()]])
    s.untested()
    expect(linux(s)).toHaveLength(1)
    expect(s.watch('ack', (linux(s)[0] as string).replace(/\.txt$/, '')).status).toBe(0) // passed on, moved to sent/
    rmSync(join(s.cache, 'main-report-linux')) // the second run read no state: as if it ran alongside the first
    s.untested()
    expect(linux(s)).toEqual([])
  })
})

describe.skipIf(spawnSync('jq', ['--version']).status !== 0)(
  "the lead's inbox: the runner posts nothing; the inbox job's flush posts each alert (scripts/lead-inbox.sh)",
  () => {
    it('the alert step never calls the issues API; flush then posts each alert once, in order, scrubbed', () => {
      const s = setup()
      const c1 = s.commit('base')
      s.green(c1)
      s.alert(c1)
      const c2 = s.commit('breaks')
      s.red(c2, ['mod'])
      expect(s.alert(c2).status).toBe(0)
      const c3 = s.commit('fix')
      s.green(c3)
      expect(s.alert(c3).status).toBe(0)
      const ids = s.alerts().map((f) => f.replace(/\.txt$/, ''))
      expect(ids).toHaveLength(2)
      // the job that runs code under test touched no issue: no call reached the inbox's fake GitHub at all
      expect(existsSync(join(s.inbox, 'calls'))).toBe(false)
      expect(comments(s.inbox)).toEqual([])
      const flush = () =>
        spawnSync('bash', [join(s.r, 'scripts/lead-inbox.sh'), 'flush'], {
          env: {
            ...gitEnv,
            PATH: `${join(s.T, 'bin')}:${process.env.PATH}`,
            HOME: s.T,
            TALOS_CI_CACHE: s.cache,
            GITHUB_REPOSITORY: 'owner/talos-app',
            GH_TOKEN: 't', // the inbox job's token
          },
          encoding: 'utf8',
        })
      const f = flush()
      expect(f.status, f.stderr).toBe(0)
      const got = comments(s.inbox)
      expect(got.map((c) => c.body.split('\n')[0]).sort()).toEqual([...ids].sort())
      const red = got.find((c) => c.body.split('\n')[0]?.endsWith('-red'))?.body as string
      expect(red).toContain(`main is RED at ${c2.slice(0, 7)}: mod`)
      expect(red).toMatch(/<author> breaks/)
      expect(red).not.toContain('Builder One') // the commit author, in the alert file's commit list
      const redId = red.split('\n')[0] as string
      expect(s.read(`${redId}.txt`)).toContain('Builder One') // the relay's own file is unchanged
      expect(flush().status).toBe(0)
      expect(comments(s.inbox)).toHaveLength(2) // again: nothing twice
    })
  },
)

describe('ci-alerts.sh watch runs lead-inbox.sh flush in the background, at most every 10 minutes', () => {
  it('once at start, not again before 600 s have passed on its clock, then again', async () => {
    const T = mkdtempSync(join(tmpdir(), 'ci-alert-flush-'))
    dirs.push(T)
    const scripts = join(T, 'scripts')
    const bin = join(T, 'bin')
    const cache = join(T, 'cache')
    mkdirSync(scripts)
    mkdirSync(bin)
    mkdirSync(join(cache, 'alerts'), { recursive: true })
    cpSync(join(here, 'ci-alerts.sh'), join(scripts, 'ci-alerts.sh'))
    // the two background jobs record each start; the clock (date +%s) is a file the test moves
    writeFileSync(join(scripts, 'ci-runner.sh'), `#!/bin/sh\necho "$1" >> '${T}/untested'\n`)
    writeFileSync(join(scripts, 'lead-inbox.sh'), `#!/bin/sh\necho "$1" >> '${T}/flushes'\n`)
    writeFileSync(join(T, 'clock'), '1000000\n')
    writeFileSync(join(bin, 'date'), `#!/bin/sh\n[ "$*" = "+%s" ] && exec cat '${T}/clock'\nexec /bin/date "$@"\n`, {
      mode: 0o755,
    })
    const p = spawn('bash', [join(scripts, 'ci-alerts.sh'), 'watch'], {
      env: {
        ...gitEnv,
        PATH: `${bin}:${process.env.PATH}`,
        HOME: T,
        TALOS_CI_CACHE: cache,
        GH_TOKEN: 't',
        TALOS_CI_ALERTS_EVERY: '0.05',
      },
      detached: true,
      stdio: ['ignore', 'pipe', 'ignore'],
    })
    let out = ''
    p.stdout.on('data', (b: Buffer) => {
      out += b.toString()
    })
    kills.push(() => {
      try {
        if (p.pid) process.kill(-p.pid, 'SIGKILL')
      } catch {} // already gone
    })
    const flushes = () => (existsSync(join(T, 'flushes')) ? readFileSync(join(T, 'flushes'), 'utf8') : '')
    const wait = async (ok: () => boolean) => {
      for (let i = 0; i < 200 && !ok(); i++) await new Promise((r) => setTimeout(r, 25))
      expect(ok()).toBe(true)
    }
    // two messages offered one after the other: the pass that offers the second began after the clock was set
    let k = 0
    const pass = async () => {
      for (let i = 0; i < 2; i++) {
        const id = `${++k}-aaaaaaa-red`
        writeFileSync(join(cache, 'alerts', `${id}.txt`), 'x\n')
        await wait(() => out.includes(`CI ALERT ${id}:`))
      }
    }
    await pass()
    await wait(() => flushes() === 'flush\n')
    writeFileSync(join(T, 'clock'), '1000599\n')
    await pass()
    await pass()
    expect(flushes()).toBe('flush\n')
    writeFileSync(join(T, 'clock'), '1000600\n')
    await pass()
    await wait(() => flushes() === 'flush\nflush\n')
    await pass()
    expect(flushes()).toBe('flush\nflush\n')
  }, 20_000)
})
