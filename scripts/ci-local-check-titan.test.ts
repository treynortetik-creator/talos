// check on Titan (docs/CI-MACHINES.md, "check on Titan"): with CI_CHECK_PART (CI_TITAN_CHECK=on) Lemnos's check job runs the
// macOS-only tests here and folds Titan's ci-part/check in, taking the whole check back (today's run, exactly) when the
// part is silent, refuses, says "not tested", or has no answer CI_CHECK_WAIT seconds after this run's other jobs end; and
// browser no longer waits for a local check. The harness of ci-local-browser-e2e.test.ts.
// The macOS-only list is checked against every test file check runs (vitest.config.ts's projects, the contract suite, the
// bridge's bun files), so the gate runs this file when one changes (scripts/gate.sh, guards_reading):
// gate-reads: packages/*/test/*.test.ts apps/relay/test/*.test.ts apps/mobile/test/*.test.ts apps/web/test/*.test.ts
// gate-reads: apps/web/test/*.test.tsx scripts/*.test.ts apps/bridge/test-contract/*.vitest.ts apps/bridge/*.test.*
// gate-reads: apps/bridge/*_test.* apps/bridge/*.spec.* apps/bridge/*_spec.*
import { type ChildProcess, execFileSync, spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { findTestFiles } from '../apps/bridge/scripts/test-parallel.ts'
import { t as scaled } from '../packages/testkit/src/time-factor.ts'
import { cleanEnv, copyCiLocalParts } from './ci-test-env'
import { fakeTool } from './fake-tool'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')
const script = join(here, 'ci-local.sh')
const listScript = join(here, 'ci-local', 'macos-only.sh')
vi.setConfig({ testTimeout: scaled(60_000), hookTimeout: scaled(60_000) })

const dirs: string[] = []
const live: ChildProcess[] = []
afterEach(() => {
  for (const c of live.splice(0)) c.kill('SIGKILL')
})
afterAll(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

const GH = `case "$1" in repo) echo owner/repo; exit 0 ;; esac
echo "$*" >> "$GH_LOG"
case "$*" in
  *"-X POST"*) exit 0 ;;
  *"/statuses?"*) [ ! -f "$HOME/unread" ] || exit 1; cat "$HOME/rows" 2>/dev/null ;;
  *"/jobs"*) cat "$HOME/jobs" 2>/dev/null ;;
esac
exit 0`
// Fake pnpm and bun: each call written down; exit 1 when the call contains $FAIL_ON.
const TOOL = (name: string) => `echo "${name} $*" >> "$CALLS"
[ -n "\${SLOW_ON:-}" ] && [[ "${name} $* " == *"$SLOW_ON"* ]] && sleep 4
[ -n "\${FAIL_ON:-}" ] && [[ "${name} $* " == *"$FAIL_ON"* ]] && exit 1
exit 0`

// The fixture's tests: two bridge files the macOS grep finds (one a schedules file), one it does not, and a non-test file; a
// root Vitest file and a contract file it finds, and a Vitest file it does not
const FIXTURE: Record<string, string> = {
  'apps/bridge/test/keychain.test.ts': "if (process.platform !== 'darwin') skip()\n",
  'apps/bridge/test/schedules/agent.test.ts': "spawn('launchctl', ['list'])\n",
  'apps/bridge/test/plain.test.ts': 'expect(1).toBe(1)\n',
  'apps/bridge/test/helper.ts': "export const os = 'darwin'\n",
  'apps/bridge/scripts/test-parallel.ts': '// knows --retry-failed and --shard\n',
  'apps/bridge/test-contract/mac.contract.vitest.ts': "spawn('xcrun')\n",
  'scripts/mac-x.test.ts': "it.skipIf(process.platform !== 'darwin')('y', () => {})\n",
  'scripts/plain-x.test.ts': 'expect(1).toBe(1)\n',
}
const LIST = [
  'bun apps/bridge/test/keychain.test.ts',
  'bun apps/bridge/test/schedules/agent.test.ts',
  'contract apps/bridge/test-contract/mac.contract.vitest.ts',
  'vitest scripts/mac-x.test.ts',
]
const MACOS = LIST.map((l) => l.split(' ')[1]).sort()

function repo(omit: string[] = []) {
  const T = mkdtempSync(join(tmpdir(), 'cict-'))
  dirs.push(T)
  const git = (cwd: string, ...a: string[]) =>
    execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', ...a], { cwd, encoding: 'utf8' }).trim()
  const src = join(T, 'src')
  mkdirSync(join(src, 'scripts'), { recursive: true })
  git(src, 'init', '-q', '-b', 'main')
  writeFileSync(join(src, 'scripts/mic-preflight.mjs'), "console.log('ok')\n")
  for (const [f, text] of Object.entries(FIXTURE).filter(([f]) => !omit.includes(f))) {
    mkdirSync(dirname(join(src, f)), { recursive: true })
    writeFileSync(join(src, f), text)
  }
  git(src, 'add', '-A')
  git(src, 'commit', '-qm', 'a')
  const origin = join(T, 'origin.git')
  git(T, 'clone', '-q', '--bare', src, origin)
  const clone = join(T, 'clone')
  git(T, 'clone', '-q', origin, clone)
  const copy = join(clone, 'scripts', 'ci-local.sh')
  writeFileSync(copy, readFileSync(script, 'utf8'))
  copyCiLocalParts(join(clone, 'scripts'))
  const bin = join(T, 'bin')
  mkdirSync(bin)
  const home = join(T, 'home')
  mkdirSync(home)
  const tool = (name: string, body: string) => fakeTool(bin, name, `#!/bin/bash\n${body}\n`)
  tool('gh', GH)
  tool('pnpm', TOOL('pnpm'))
  tool('uname', '[ "$1" = -s ] && { echo Darwin; exit 0; }\nexec /usr/bin/uname "$@"') // a Mac: the corepack variant runs on a Mac only
  // and a Mac that has not slept: a woken-at time of 1970 (before any run). Without it, on Linux the faked Darwin has no
  // kern.waketime, which a Mac counts as slept, and the check's status gains ", with warnings" (check-titan red at 94710fe)
  tool(
    'sysctl',
    '[ "$1" = -n ] && [ "$2" = kern.waketime ] && { echo "{ sec = 1, usec = 0 } Thu Jan  1 00:00:01 1970"; exit 0; }\nPATH=/usr/sbin:/sbin:/usr/bin:/bin exec sysctl "$@"',
  )
  tool('bun', `[ "$1" = --version ] && { echo 1.4.4; exit 0; }\n${TOOL('bun')}`) // a version question is not a call
  const env: Record<string, string> = {
    ...cleanEnv(),
    CI_MAX_LOAD: '0',
    CI_POLL: '0.05',
    CI_LOCK_TIMEOUT: '30',
    TALOS_CI_NESTED: '0',
    CI_SLOTS: '1',
    CI_WORKERS: '2',
    HOME: home,
    PATH: `${bin}:${process.env.PATH}`,
    GH_LOG: join(T, 'gh.log'),
    CALLS: join(T, 'calls'),
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
  const log = (job: string) => {
    const sha = git(clone, 'rev-parse', '--short=7', 'HEAD')
    return readFileSync(join(home, '.cache/talos-ci/logs', `${sha}-${job}.log`), 'utf8')
  }
  const calls = () =>
    existsSync(env.CALLS as string)
      ? readFileSync(env.CALLS as string, 'utf8')
          .trim()
          .split('\n')
      : []
  const gh = () => (existsSync(env.GH_LOG as string) ? readFileSync(env.GH_LOG as string, 'utf8') : '')
  const posts = (ctx: string) =>
    gh()
      .split('\n')
      .filter((l) => l.includes('-X POST') && l.includes(`context=${ctx} `) && !l.includes('state=pending'))
  const set = (name: string, lines: string[]) =>
    writeFileSync(join(home, name), lines.length ? `${lines.join('\n')}\n` : '')
  return { T, home, clone, git, start, log, calls, gh, posts, set }
}

const A = 'https://example.test/runs/9/attempts/1#'
const on = {
  CI_ATTEMPT_URL: A,
  CI_STATUS_URL: `${A}lemnos`,
  CI_RUN_ID: '9',
  CI_PART_POLL: '0.2',
  CI_CHECK_PART: 'check-titan',
  CI_CHECK_WAIT: '30',
}
const partPass = `ci-part/check\tsuccess\t${A}check-titan\tpassed on titan in 770s`
const partFail = `ci-part/check\tfailure\t${A}check-titan\tfailed on titan; see its log`
const partNotTested = `ci-part/check\terror\t${A}check-titan\tnot tested: the heavy lock was not had in time on titan`
const checkRun = ['--ref', 'HEAD', '--jobs', 'check']
// check's own steps: every call but the run's setup and the macOS-only subset (one bun call per file, --only <file>; one
// Vitest run and one contract run, --passWithNoTests <files>)
const setupCall = (l: string) => /^pnpm (install|build)\b/.test(l) || l.startsWith('pnpm exec playwright')
const bunSubsetCall = (l: string) => / --jobs 1 .*--only test\/(keychain|schedules\/agent)\.test\.ts$/.test(l)
const subsetCall = (l: string) => bunSubsetCall(l) || / --passWithNoTests /.test(l)
// the installer tests with a corepack pnpm first on PATH: once in today's check, and once at the end of the macOS subset (here, on
// a Mac), so it is counted on its own (ci-local-jobs-gates.test.ts: it fails the check job) and not among check's steps
const COREPACK = 'pnpm test:corepack-install'
const checkSteps = (r: ReturnType<typeof repo>) =>
  r
    .calls()
    .filter((l) => !setupCall(l) && !subsetCall(l) && l !== COREPACK)
    .map((l) => l.replaceAll(r.T, '<T>')) // each repo is its own temp dir
    .map((l) => (l.includes('/ci-test-results.ts ') ? 'bun ci-test-results.ts' : l)) // its run dir and commit differ too
    .sort()
// report-ci/fast runs beside check in every run that posts (typecheck and lint at nice 15): not check's
const FAST = ['pnpm lint', 'pnpm typecheck']
// check folded from its part: the per-test file of the subset's tests, beside report-ci/fast's steps
const FOLDED = ['bun ci-test-results.ts', ...FAST]
const subset = (r: ReturnType<typeof repo>) =>
  r
    .calls()
    .filter(subsetCall)
    .flatMap((l) =>
      bunSubsetCall(l) || l.includes(' test:contract ')
        ? [`apps/bridge/${l.replace(/^.* --(only|passWithNoTests) /, '')}`]
        : l.replace(/^.* --passWithNoTests /, '').split(' '),
    )
    .sort()

/** Today's check (no CI_CHECK_PART) on the fixture: its steps, for the take-back to equal. */
async function today() {
  const r = repo()
  const run = r.start(checkRun)
  expect(await run.done, run.out()).toBe(0)
  return checkSteps(r)
}

// What macos-only.sh greps for: a name only macOS has (a platform gate, a filesystem, a tool)
const MAC_RE =
  /darwin|apfs|APFS|clonefile|F_GETPATH|\/usr\/bin\/security|launchctl|xcrun|sw_vers|osascript|mdls|ditto|codesign|pbcopy/
// A test (or file) that runs only on macOS, or only off it: a comparison of the platform with 'darwin'
const DARWIN_GATE = /platform(\(\))?\s*[!=]==?\s*['"]darwin['"]|['"]darwin['"]\s*[!=]==?\s*(process\.|os\.)?platform/
/** Every test file check runs, "<runner> <repo-relative path>", as its runners list them: Vitest's root projects and the contract
 * suite (vitest list), and the bridge's bun files (test-parallel.ts's findTestFiles), not macos-only.sh's own folders. */
function checkFiles(): string[] {
  const vitestList = (cwd: string, ...a: string[]) =>
    execFileSync(join(root, 'node_modules/.bin/vitest'), ['list', '--filesOnly', ...a], {
      cwd,
      encoding: 'utf8',
      env: { ...process.env, VITEST: '', VITEST_MODE: '', VITEST_POOL_ID: '', VITEST_WORKER_ID: '', NODE_ENV: '' },
    })
      .split('\n')
      .map((l) => l.replace(/^\[[^\]]*\] /, '').trim())
      .filter((l) => /\.(ts|tsx)$/.test(l))
  const bridge = join(root, 'apps/bridge')
  return [
    ...vitestList(root).map((f) => `vitest ${f}`),
    ...vitestList(bridge, '--config', 'vitest.contract.config.ts').map((f) => `contract apps/bridge/${f}`),
    ...findTestFiles(bridge).map((f) => `bun apps/bridge/${f}`),
  ]
}

describe('the macOS-only tests: computed by one script, the same as the agreed grep over every file check runs', () => {
  let fromScript: string[] = []
  let files: string[] = []
  const text = (line: string) => readFileSync(join(root, line.slice(line.indexOf(' ') + 1)), 'utf8')
  beforeAll(() => {
    fromScript = execFileSync('bash', [listScript, root], { encoding: 'utf8' }).trim().split('\n')
    files = checkFiles()
  }, 120_000)

  it("the script's list is the grep's list, every runner's files, on this repository", () => {
    expect(files.length).toBeGreaterThan(1000)
    const want = files.filter((l) => MAC_RE.test(text(l))).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
    expect(want.filter((l) => l.startsWith('bun ')).length).toBeGreaterThan(10)
    expect(fromScript).toEqual(want)
  })

  it('a macOS-only test outside apps/bridge/test is in it, with its runner', () => {
    expect(fromScript).toContain('vitest scripts/root-install-v1.test.ts')
  })

  it('the guard: no file check runs has a darwin gate and is outside the list (so no test runs on neither machine)', () => {
    const gated = files.filter((l) => DARWIN_GATE.test(text(l)))
    expect(gated).toContain('vitest scripts/root-install-v1.test.ts')
    expect(gated.filter((l) => !fromScript.includes(l))).toEqual([])
  })

  it('on the fixture: only the files that match, by runner, schedules included', () => {
    const r = repo()
    const out = execFileSync('bash', [listScript, r.clone], { encoding: 'utf8' }).trim().split('\n')
    expect(out).toEqual(LIST)
  })
})

describe('check with CI_CHECK_PART: the macOS subset here, Titan folded in, today’s check taken back when it gives no answer', () => {
  it("off (no CI_CHECK_PART): today's check, no part read, no subset run of its own", async () => {
    const r = repo()
    const run = r.start(checkRun)
    expect(await run.done, run.out()).toBe(0)
    const steps = checkSteps(r)
    for (const s of ['pnpm typecheck', 'pnpm lint', 'bun ci-test-results.ts']) expect(steps, s).toContain(s)
    expect(steps.some((l) => l.startsWith('pnpm --filter @talos-app/bridge test:contract'))).toBe(true)
    expect(steps.some((l) => l.startsWith('pnpm test --maxWorkers=2'))).toBe(true)
    expect(steps.some((l) => /bun run .* --skip test\/schedules\//.test(l))).toBe(true)
    expect(subset(r)).toEqual([])
    expect(r.calls().filter((l) => l === COREPACK)).toEqual([COREPACK]) // today's check runs it once
    expect(r.gh()).not.toContain('/jobs')
    expect(r.posts('local-ci/check')).toEqual([
      expect.stringMatching(/state=success .*description=passed on \S+ in \d+s$/),
    ])
  })

  it('on, part green: local-ci/check green with no local suites, WITH the macOS subset, and the text says where', async () => {
    const r = repo()
    r.set('rows', [partPass])
    r.set('jobs', ['check-titan\tcompleted'])
    const run = r.start(checkRun, on)
    expect(await run.done, run.out()).toBe(0)
    expect(subset(r)).toEqual(MACOS)
    expect(checkSteps(r)).toEqual(FOLDED)
    expect(r.calls().filter((l) => l === COREPACK)).toEqual([COREPACK]) // the subset's end: a Mac's pnpm
    expect(r.posts('local-ci/check')).toEqual([
      expect.stringMatching(/state=success .*\(check on check-titan, macOS-only tests here\)/),
    ])
    // the per-test file says the rest of check ran on the part's machine
    expect(r.calls().find((l) => l.includes('/ci-test-results.ts '))).toMatch(/ check:check-titan$/)
  })

  it("on: the Vitest and contract files run through Vitest, with check's env, retry and reporters", async () => {
    const r = repo()
    r.set('rows', [partPass])
    r.set('jobs', ['check-titan\tcompleted'])
    const run = r.start(checkRun, on)
    expect(await run.done, run.out()).toBe(0)
    const vitest = r.calls().filter((l) => / --passWithNoTests /.test(l))
    expect(vitest).toEqual([
      expect.stringMatching(
        /^pnpm test --maxWorkers=2 --retry=1 --reporter=default --reporter=\S+\/ci-flake-vitest\.ts --reporter=\S+\/ci-test-results-vitest\.ts --passWithNoTests scripts\/mac-x\.test\.ts$/,
      ),
      expect.stringMatching(
        /^pnpm --filter @talos-app\/bridge test:contract --reporter=default --reporter=\S+\/ci-test-results-vitest\.ts --passWithNoTests test-contract\/mac\.contract\.vitest\.ts$/,
      ),
    ])
    // no bun call for a Vitest file
    expect(r.calls().filter((l) => l.startsWith('bun ') && l.includes('mac-x'))).toEqual([])
  })

  it('on, part green but the macOS Vitest file red here: check red', async () => {
    const r = repo()
    r.set('rows', [partPass])
    r.set('jobs', ['check-titan\tcompleted'])
    const run = r.start(checkRun, { ...on, FAIL_ON: '--passWithNoTests scripts/mac-x.test.ts' })
    expect(await run.done).toBe(1)
    expect(r.posts('local-ci/check')).toEqual([expect.stringMatching(/state=failure .*macOS-only tests failed here/)])
  })

  it('the macOS subset runs its schedules files first, one at a time, before the rest', async () => {
    const r = repo()
    r.set('rows', [partPass])
    r.set('jobs', ['check-titan\tcompleted'])
    const run = r.start(checkRun, on)
    expect(await run.done, run.out()).toBe(0)
    const order = r.calls().filter(bunSubsetCall)
    expect(order[0]).toMatch(/--only test\/schedules\/agent\.test\.ts$/)
    expect(order).toHaveLength(2)
  })

  it('a macOS list of schedules files only: the subset is green, not a red no test made', async () => {
    const r = repo(['apps/bridge/test/keychain.test.ts'])
    r.set('rows', [partPass])
    r.set('jobs', ['check-titan\tcompleted'])
    const run = r.start(checkRun, on)
    expect(await run.done, run.out()).toBe(0)
    expect(subset(r)).toEqual(MACOS.filter((f) => !f.endsWith('keychain.test.ts')))
  })

  it('check run as a part elsewhere (ci-part/ or report-ci/): no report-ci/fast beside it', async () => {
    for (const prefix of ['ci-part', 'report-ci']) {
      const r = repo()
      const run = r.start(checkRun, { CI_STATUS_PREFIX: prefix })
      expect(await run.done, run.out()).toBe(0)
      expect(r.posts('report-ci/fast'), prefix).toEqual([])
      expect(r.posts(`${prefix}/check`), prefix).toHaveLength(1)
    }
    // Lemnos's own (local-ci) still has it
    const r = repo()
    expect(await r.start(checkRun).done).toBe(0)
    expect(r.posts('report-ci/fast')).toHaveLength(1)
  })

  it("on, part red: check red with the part's machine, nothing taken back", async () => {
    const r = repo()
    r.set('rows', [partFail])
    r.set('jobs', ['check-titan\tcompleted'])
    const run = r.start(checkRun, on)
    expect(await run.done).toBe(1)
    expect(checkSteps(r)).toEqual(FOLDED)
    expect(r.posts('local-ci/check')).toEqual([
      expect.stringMatching(/state=failure .*description=check failed on check-titan; see its run/),
    ])
  })

  it('on, part green but the macOS subset red here: check red', async () => {
    const r = repo()
    r.set('rows', [partPass])
    r.set('jobs', ['check-titan\tcompleted'])
    const run = r.start(checkRun, { ...on, FAIL_ON: '--only test/keychain.test.ts' })
    expect(await run.done).toBe(1)
    expect(checkSteps(r)).toEqual(FOLDED)
    expect(r.posts('local-ci/check')).toEqual([expect.stringMatching(/state=failure /)])
  })

  it('on, "not tested" on its machine: taken back at once, and the take-back is exactly today\'s check', async () => {
    const want = await today()
    const r = repo()
    r.set('rows', [partNotTested])
    r.set('jobs', ['check-titan\tin_progress'])
    // An hour's wait: a run that waited instead of taking it back at once would hit the test's own timeout, whatever the load.
    const run = r.start(checkRun, { ...on, CI_CHECK_WAIT: '3600' })
    expect(await run.done, run.out()).toBe(0)
    expect(checkSteps(r)).toEqual(want)
    expect(subset(r)).toEqual(MACOS)
    expect(r.posts('local-ci/check')).toEqual([
      expect.stringMatching(/state=success .*\(check here: check-titan did not answer\)/),
    ])
  })

  it("on, silent (its job ended with no answer): taken back, today's check", async () => {
    const want = await today()
    const r = repo()
    r.set('rows', [])
    r.set('jobs', ['check-titan\tcompleted'])
    const run = r.start(checkRun, on)
    expect(await run.done, run.out()).toBe(0)
    expect(checkSteps(r)).toEqual(want)
    expect(r.log('check')).toContain(
      'taking check back from check-titan: its job ended without an answer, or it refused',
    )
  })

  it("on, late (still working CI_CHECK_WAIT after the run's other jobs end): taken back, today's check", async () => {
    const want = await today()
    const r = repo()
    r.set('rows', [])
    r.set('jobs', ['check-titan\tin_progress'])
    const run = r.start(checkRun, { ...on, CI_CHECK_WAIT: '2' })
    expect(await run.done, run.out()).toBe(0)
    expect(checkSteps(r)).toEqual(want)
    expect(r.log('check')).toContain(
      "taking check back from check-titan: no answer within 2s of this run's other jobs (working)",
    )
  })

  it('the wait counts from when the other jobs end: a part that answers while they still run is folded', async () => {
    const r = repo()
    r.set('rows', [])
    r.set('jobs', ['check-titan\tin_progress'])
    // browser runs about 4 s (its protocol suite is a fake that sleeps); the wait is 1 s; the part's green lands at 2.5 s
    const run = r.start(['--ref', 'HEAD', '--jobs', 'check,browser'], {
      ...on,
      CI_CHECK_WAIT: '1',
      SLOW_ON: 'pnpm test:browser ',
    })
    await new Promise((ok) => setTimeout(ok, 2500))
    r.set('rows', [partPass])
    await run.done
    expect(checkSteps(r).filter((l) => l.includes('test:contract'))).toEqual([])
    expect(r.posts('local-ci/check')).toEqual([expect.stringMatching(/state=success .*check on check-titan/)])
  })

  it("CI_CHECK_PART without a wait, or without a way to read the part: today's check, said once", async () => {
    const want = await today()
    for (const extra of [{ CI_CHECK_WAIT: '' }, { CI_RUN_ID: '' }]) {
      const r = repo()
      const run = r.start(checkRun, { ...on, ...extra })
      expect(await run.done, run.out()).toBe(0)
      expect(checkSteps(r)).toEqual(want)
      expect(subset(r)).toEqual([])
      expect(run.out()).toContain(
        'ci-local: CI_CHECK_PART given, but no CI_CHECK_WAIT or no way to read the part; check runs here',
      )
    }
  })

  it('on: browser no longer waits for a local check; it is answered while check still waits for the part', async () => {
    const r = repo()
    r.set('rows', [])
    r.set('jobs', ['check-titan\tin_progress'])
    const run = r.start(['--ref', 'HEAD', '--jobs', 'check,browser'], { ...on, CI_CHECK_WAIT: '6' })
    await vi.waitUntil(() => r.posts('local-ci/browser').length > 0, { timeout: 30_000, interval: 50 })
    expect(r.posts('local-ci/check')).toEqual([])
    r.set('rows', [partPass])
    expect(await run.done, run.out()).toBe(0)
    expect(r.posts('local-ci/check')).toEqual([expect.stringMatching(/state=success .*check on check-titan/)])
  })
})
