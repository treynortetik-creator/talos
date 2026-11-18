// The e2e packages on Titan (docs/CI-MACHINES.md, "The e2e packages on Titan"): with CI_BROWSER_E2E_PART the browser job runs
// protocol and the web package and folds ci-part/browser-e2e in, taking those packages back when the part gives no answer; the
// browser-e2e part runs every other e2e package. The harness of ci-local-jobs.test.ts.
import { type ChildProcess, execFileSync, spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest'
import { t as scaled } from '../packages/testkit/src/time-factor.ts'
import { cleanEnv, copyCiLocalParts } from './ci-test-env'
import { fakeTool } from './fake-tool'

const here = dirname(fileURLToPath(import.meta.url))
const script = join(here, 'ci-local.sh')
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
// A fake pnpm: writes down each call; a --list of test:e2e prints $HOME/list (the tagged tests); exits 1 on $FAIL_ON.
const PNPM = `echo "pnpm $*$([ -n "\${E2E_WORKERS:-}" ] && [[ "$*" == *"!@talos-app/web"* ]] && echo " W=$E2E_WORKERS")" >> "$CALLS"
case "$*" in *test:e2e*--list*) cat "$HOME/list" 2>/dev/null ;; esac
# a host without the browsers' system libraries: playwright install warns and still exits 0
case "$*" in *"playwright install"*) [ ! -f "$HOME/no-host-deps" ] || echo "║ Host system is missing dependencies to run browsers. ║" ;; esac
[ -n "\${FAIL_ON:-}" ] && [[ "$* " == *"$FAIL_ON"* ]] && exit 1
exit 0`

function repo() {
  const T = mkdtempSync(join(tmpdir(), 'cibm-'))
  dirs.push(T)
  const git = (cwd: string, ...a: string[]) =>
    execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', ...a], { cwd, encoding: 'utf8' }).trim()
  const src = join(T, 'src')
  mkdirSync(join(src, 'scripts'), { recursive: true })
  git(src, 'init', '-q', '-b', 'main')
  writeFileSync(join(src, 'a.txt'), 'a\n')
  writeFileSync(join(src, 'scripts/mic-preflight.mjs'), "console.log('ok')\n")
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
  tool('pnpm', PNPM)
  tool('bun', 'exit 0')
  const env: Record<string, string> = {
    ...cleanEnv(),
    CI_MAX_LOAD: '0',
    CI_POLL: '0.05',
    CI_LOCK_TIMEOUT: '30',
    TALOS_CI_NESTED: '0',
    CI_SLOTS: '1',
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
  const posts = (ctx: string) =>
    (existsSync(env.GH_LOG as string) ? readFileSync(env.GH_LOG as string, 'utf8') : '')
      .split('\n')
      .filter((l) => l.includes('-X POST') && l.includes(`context=${ctx} `) && !l.includes('state=pending'))
  const set = (name: string, lines: string[]) =>
    writeFileSync(join(home, name), lines.length ? `${lines.join('\n')}\n` : '')
  return { T, home, clone, git, start, log, calls, posts, set }
}

const A = 'https://example.test/runs/9/attempts/1#'
// Lemnos's browser run with the e2e packages on Titan
const fold = {
  CI_ATTEMPT_URL: A,
  CI_STATUS_URL: `${A}lemnos`,
  CI_RUN_ID: '9',
  CI_PART_POLL: '0.2',
  CI_BROWSER_E2E_PART: 'titan-e2e',
  CI_BROWSER_E2E_WAIT: '30',
}
const partPass = `ci-part/browser-e2e\tsuccess\t${A}titan-e2e\tpassed on titan in 330s`
const partFail = `ci-part/browser-e2e\tfailure\t${A}titan-e2e\tfailed on titan`
const partRefused = `ci-part/browser-e2e\terror\t${A}titan-e2e\tnot tested: 1 @mac-only test lines outside the web package`
const browserRun = ['--ref', 'HEAD', '--jobs', 'browser']
// (the worker count the fake notes for the non-web side is the part's own test's business)
const e2eCalls = (r: ReturnType<typeof repo>) =>
  r
    .calls()
    .filter((l) => l.includes('test:e2e') && !l.includes('--list'))
    .map((l) => l.replace(/ W=\d+$/, ''))
const WEB = 'pnpm -r --workspace-concurrency=1 --no-bail --if-present --filter @talos-app/web test:e2e'
const THERE = 'pnpm -r --workspace-concurrency=1 --no-bail --if-present --filter !@talos-app/web --filter !{.} test:e2e'

describe('the browser job with CI_BROWSER_E2E_PART: web here, every other e2e package on the part, folded like check folds its parts', () => {
  it("runs protocol and the web package only (no grep: this is the Mac), and the part's green is browser's", async () => {
    const r = repo()
    r.set('rows', [partPass])
    r.set('jobs', ['titan-e2e\tcompleted'])
    const run = r.start(browserRun, fold)
    expect(await run.done, run.out()).toBe(0)
    expect(r.calls().filter((l) => l.startsWith('pnpm test:browser'))).toEqual(['pnpm test:browser'])
    expect(e2eCalls(r)).toEqual([WEB])
    expect(r.posts('local-ci/browser')).toEqual([
      expect.stringMatching(/state=success .*description=passed on \S+ in \d+s \(e2e packages on titan-e2e\)/),
    ])
  })

  it("the part's red: browser red with the part and its machine, and nothing taken back", async () => {
    const r = repo()
    r.set('rows', [partFail])
    r.set('jobs', ['titan-e2e\tcompleted'])
    const run = r.start(browserRun, fold)
    expect(await run.done).toBe(1)
    expect(e2eCalls(r)).toEqual([WEB])
    expect(r.posts('local-ci/browser')).toEqual([
      expect.stringMatching(/state=failure .*description=the browser-e2e part failed on titan-e2e; see its run/),
    ])
  })

  it('its job ended without an answer: the packages are taken back at once and run here, and the text says so', async () => {
    const r = repo()
    r.set('rows', [])
    r.set('jobs', ['titan-e2e\tcompleted'])
    const t0 = Date.now()
    const run = r.start(browserRun, fold)
    expect(await run.done, run.out()).toBe(0)
    expect(Date.now() - t0).toBeLessThan(25_000) // not the 30 s wait
    expect(e2eCalls(r)).toEqual([WEB, THERE])
    expect(r.posts('local-ci/browser')).toEqual([
      expect.stringMatching(/state=success .*\(e2e packages here: titan-e2e did not answer\)/),
    ])
  })

  it('refused on its machine (not tested, under its own link): taken back at once, whatever its job is doing', async () => {
    const r = repo()
    r.set('rows', [partRefused])
    r.set('jobs', ['titan-e2e\tin_progress'])
    const t0 = Date.now()
    const run = r.start(browserRun, fold)
    expect(await run.done, run.out()).toBe(0)
    expect(Date.now() - t0).toBeLessThan(25_000)
    expect(e2eCalls(r)).toEqual([WEB, THERE])
  })

  it('still working when the wait is over: taken back after CI_BROWSER_E2E_WAIT', async () => {
    const r = repo()
    r.set('rows', [])
    r.set('jobs', ['titan-e2e\tin_progress'])
    const run = r.start(browserRun, { ...fold, CI_BROWSER_E2E_WAIT: '2' })
    expect(await run.done, run.out()).toBe(0)
    expect(e2eCalls(r)).toEqual([WEB, THERE])
    expect(r.log('browser')).toContain('taking the e2e packages back from titan-e2e: no answer within 2s (working)')
  })

  it('a wait of 0 still sees an answer that is already there: the green is folded, nothing taken back', async () => {
    const r = repo()
    r.set('rows', [partPass])
    r.set('jobs', ['titan-e2e\tcompleted'])
    const run = r.start(browserRun, { ...fold, CI_BROWSER_E2E_WAIT: '0' })
    expect(await run.done, run.out()).toBe(0)
    expect(e2eCalls(r)).toEqual([WEB])
  })

  it('a job still queued is waited for like a running one, then taken back at the wait', async () => {
    const r = repo()
    r.set('rows', [])
    r.set('jobs', ['titan-e2e\tqueued'])
    const run = r.start(browserRun, { ...fold, CI_BROWSER_E2E_WAIT: '3' })
    expect(await run.done, run.out()).toBe(0)
    expect(e2eCalls(r)).toEqual([WEB, THERE])
    expect(r.log('browser')).toContain('no answer within 3s (working)')
  })

  it('one look that finds no job is not enough: a list read a moment early does not take the packages back', async () => {
    const r = repo()
    r.set('rows', [])
    r.set('jobs', ['titan-e2e\tcompleted'])
    const run = r.start(browserRun, { ...fold, CI_PART_POLL: '1' })
    const gh = join(r.T, 'gh.log')
    const looks = () => (existsSync(gh) ? readFileSync(gh, 'utf8').split('/actions/runs/9/jobs').length - 1 : 0)
    await vi.waitUntil(() => looks() >= 1, { timeout: 30_000, interval: 20 })
    r.set('rows', [partPass]) // its green lands before the second look
    expect(await run.done, run.out()).toBe(0)
    expect(e2eCalls(r)).toEqual([WEB])
  })

  it('a success that says "skipped" ran nothing there: not a pass; the packages are taken back', async () => {
    const r = repo()
    r.set('rows', [`ci-part/browser-e2e\tsuccess\t${A}titan-e2e\tskipped: no browser-e2e inputs changed since abc1234`])
    r.set('jobs', ['titan-e2e\tcompleted'])
    const run = r.start(browserRun, fold)
    expect(await run.done, run.out()).toBe(0)
    expect(e2eCalls(r)).toEqual([WEB, THERE])
  })

  it('taken back and red here, then the part goes green: the red here stands (a test failed on this machine)', async () => {
    const r = repo()
    r.set('rows', [])
    r.set('jobs', ['titan-e2e\tin_progress'])
    const run = r.start(browserRun, { ...fold, CI_BROWSER_E2E_WAIT: '1', FAIL_ON: '!{.} test:e2e' })
    await vi.waitUntil(() => e2eCalls(r).includes(THERE), { timeout: 30_000, interval: 20 })
    r.set('rows', [partPass])
    expect(await run.done).toBe(1)
    expect(r.posts('local-ci/browser')).toEqual([expect.stringMatching(/state=failure /)])
  })

  it("GitHub unreadable when browser is posted, after the part's green: not tested, never green", async () => {
    const r = repo()
    r.set('rows', [partPass])
    r.set('jobs', ['titan-e2e\tcompleted'])
    const run = r.start(browserRun, fold)
    await vi.waitUntil(() => existsSync(join(r.T, 'calls')) && r.calls().some((l) => l === WEB), {
      timeout: 30_000,
      interval: 20,
    })
    await new Promise((ok) => setTimeout(ok, 1200)) // the fold has read the green
    writeFileSync(join(r.home, 'unread'), '')
    expect(await run.done).toBe(1)
    expect(r.posts('local-ci/browser')).toEqual([
      expect.stringMatching(
        /state=(failure .*could not read|error .*description=not tested: browser-e2e part status unreadable)/,
      ),
    ])
  })

  it('working, then green before the wait is over: not taken back', async () => {
    const r = repo()
    r.set('rows', [])
    r.set('jobs', ['titan-e2e\tin_progress'])
    const run = r.start(browserRun, fold)
    await vi.waitUntil(() => r.calls().some((l) => l === WEB), { timeout: 30_000, interval: 50 })
    await new Promise((ok) => setTimeout(ok, 1500))
    r.set('rows', [partPass])
    r.set('jobs', ['titan-e2e\tcompleted'])
    expect(await run.done, run.out()).toBe(0)
    expect(e2eCalls(r)).toEqual([WEB])
    expect(r.posts('local-ci/browser')).toEqual([
      expect.stringMatching(/state=success .*\(e2e packages on titan-e2e\)/),
    ])
  })

  it('taken back and green here, but the part then went red on its machine in this attempt: browser is red', async () => {
    const r = repo()
    r.set('rows', [])
    r.set('jobs', ['titan-e2e\tin_progress'])
    const run = r.start(browserRun, { ...fold, CI_BROWSER_E2E_WAIT: '1' })
    await vi.waitUntil(() => e2eCalls(r).includes(THERE), { timeout: 30_000, interval: 20 })
    r.set('rows', [partFail])
    expect(await run.done).toBe(1)
    expect(r.posts('local-ci/browser')).toEqual([
      expect.stringMatching(/state=failure .*description=the browser-e2e part failed on titan-e2e; see its run/),
    ])
  })

  it('taken back and red here: red with its own words', async () => {
    const r = repo()
    r.set('rows', [])
    r.set('jobs', ['titan-e2e\tcompleted'])
    const run = r.start(browserRun, { ...fold, FAIL_ON: '!{.} test:e2e' })
    expect(await run.done).toBe(1)
    expect(r.posts('local-ci/browser')).toEqual([expect.stringMatching(/state=failure .*description=failed on /)])
  })

  it('no CI_BROWSER_E2E_WAIT (it has no default), or no way to read the part: every e2e package here, as today', async () => {
    // the attempt link must be one whole attempt of this run: a shorter one, another run's, or one with more after the `#`
    // would match another attempt's rows
    for (const extra of [
      { CI_BROWSER_E2E_WAIT: '' },
      { CI_RUN_ID: '' },
      { CI_ATTEMPT_URL: 'https://example.test/' },
      { CI_ATTEMPT_URL: 'https://example.test/runs/8/attempts/1#' },
      { CI_ATTEMPT_URL: `${A}x` },
    ]) {
      const r = repo()
      const run = r.start(browserRun, { ...fold, ...extra })
      expect(await run.done, JSON.stringify(extra)).toBe(0)
      expect(run.out()).toContain('browser runs every e2e package here')
      expect(e2eCalls(r)).toEqual(['pnpm -r --workspace-concurrency=1 --no-bail --if-present test:e2e'])
    }
  })

  it('refuses a malformed part, wait or worker count before anything is posted', async () => {
    const r = repo()
    for (const bad of [
      { CI_BROWSER_E2E_PART: 'Titan;x' },
      { CI_BROWSER_E2E_WAIT: '30s' },
      { CI_PART_E2E_WORKERS: '0' },
    ]) {
      const run = r.start(browserRun, { ...fold, ...bad })
      expect(await run.done, JSON.stringify(bad)).toBe(64)
    }
    expect(existsSync(join(r.T, 'gh.log')) ? r.posts('local-ci/browser') : []).toEqual([])
  })
})

// CI_TITAN_BROWSER=e2e-shadow on Lemnos (docs/CI-MACHINES.md, "The e2e packages on Titan"): the whole browser as today, its e2e
// in two calls, web first, so the shadow comparison (ci-runner.sh e2e-shadow) reads when web ended and the other packages' own
// result from the log
describe('the browser job with CI_BROWSER_E2E_SHADOW: every package here, web first, the other packages in a call of their own', () => {
  const shadow = { CI_BROWSER_E2E_SHADOW: '1' }
  it('web, then the rest, each marked in the log; green as today', async () => {
    const r = repo()
    const run = r.start(browserRun, shadow)
    expect(await run.done, run.out()).toBe(0)
    expect(r.calls().filter((l) => l.startsWith('pnpm test:browser'))).toEqual(['pnpm test:browser'])
    expect(e2eCalls(r)).toEqual([WEB, THERE])
    const log = r.log('browser')
    const web = log.indexOf('e2e-shadow: web ended at ')
    const end = log.indexOf('e2e-shadow: the other e2e packages ended with exit 0\n')
    expect(log).toMatch(/e2e-shadow: web ended at \d{10}\n/)
    expect(web).toBeGreaterThan(log.indexOf(`+ ${WEB}`))
    expect(web).toBeLessThan(log.indexOf(`+ ${THERE}`))
    expect(end).toBeGreaterThan(log.indexOf(`+ ${THERE}`))
    expect(r.posts('local-ci/browser')).toEqual([
      expect.stringMatching(/state=success .*description=passed on \S+ in \d+s/),
    ])
  })

  it('a red in the other packages is red here as today, and its exit is in the log; a red web still runs them', async () => {
    const r = repo()
    const run = r.start(browserRun, { ...shadow, FAIL_ON: '!@talos-app/web' })
    expect(await run.done).toBe(1)
    expect(r.log('browser')).toContain('e2e-shadow: the other e2e packages ended with exit 1\n')
    expect(r.posts('local-ci/browser')).toEqual([expect.stringMatching(/state=failure /)])
    const w = repo()
    const web = w.start(browserRun, { ...shadow, FAIL_ON: '--filter @talos-app/web' })
    expect(await web.done).toBe(1)
    expect(e2eCalls(w)).toEqual([WEB, THERE])
    expect(w.log('browser')).toContain('e2e-shadow: the other e2e packages ended with exit 0\n')
  })

  it("with CI_BROWSER_E2E_PART the fold wins: the other packages are the part's, never run here twice", async () => {
    const r = repo()
    r.set('rows', [partPass])
    r.set('jobs', ['titan-e2e\tcompleted'])
    const run = r.start(browserRun, { ...fold, ...shadow })
    expect(await run.done, run.out()).toBe(0)
    expect(e2eCalls(r)).toEqual([WEB])
    expect(r.log('browser')).not.toContain('e2e-shadow:')
  })
})

describe('the browser-e2e part (Titan): every e2e package but web, after a check that none of them has an @mac-only test', () => {
  const PART = { CI_STATUS_PREFIX: 'ci-part' }
  const partRun = ['--ref', 'HEAD', '--no-status', '--jobs', 'browser-e2e']

  it('runs the other packages on CI_PART_E2E_WORKERS workers, with no grep (the count is the guard), and no web, protocol or check', async () => {
    const r = repo()
    const run = r.start(partRun, { ...PART, CI_PART_E2E_WORKERS: '8' })
    expect(await run.done, run.out()).toBe(0)
    expect(r.calls().filter((l) => l.includes('test:'))).toEqual([
      'pnpm -r --workspace-concurrency=1 --if-present --filter !@talos-app/web --filter !{.} test:e2e --list --grep @mac-only --pass-with-no-tests W=8',
      'pnpm -r --workspace-concurrency=1 --no-bail --if-present --filter !@talos-app/web --filter !{.} test:e2e W=8',
    ])
    expect(r.calls().some((l) => l.startsWith('pnpm install'))).toBe(true)
  })

  it('an @mac-only test in those packages: not tested (a refusal, an error), and nothing run', async () => {
    const r = repo()
    r.set('list', ['Listing tests:', '  [chromium] › tests/x.spec.ts:3:1 › tagged', 'Total: 1 test in 1 file'])
    const run = r.start(partRun, PART)
    expect(await run.done, run.out()).toBe(0)
    expect(run.out()).toContain('browser-e2e refused: not tested: 1 @mac-only test lines outside the web package')
    expect(e2eCalls(r)).toEqual([])
  })

  it('the listing fails: not tested (the browser job takes the packages back), runs nothing', async () => {
    const r = repo()
    const run = r.start(partRun, { ...PART, FAIL_ON: 'test:e2e --list' })
    expect(await run.done, run.out()).toBe(0)
    expect(run.out()).toContain(
      'browser-e2e refused: not tested: the @mac-only tests of the e2e packages could not be listed',
    )
    expect(e2eCalls(r)).toEqual([])
  })

  it.skipIf(spawnSync('bash', ['-c', 'command -v flock']).status !== 0)(
    'the heavy lock not had in time (the other WSL distro holds it): not tested, nothing run',
    async () => {
      const r = repo()
      const lockFile = join(r.T, 'shared.lock')
      // the other distro: holds the shared flock for longer than the part will wait
      const other = spawn('flock', [lockFile, 'sleep', '60'], { stdio: 'ignore' })
      live.push(other)
      await new Promise((ok) => setTimeout(ok, 300))
      const run = r.start(partRun, { ...PART, CI_SHARED_LOCK: lockFile, CI_LOCK_TIMEOUT: '3' })
      expect(await run.done, run.out()).toBe(0)
      expect(run.out()).toContain('browser-e2e refused: not tested: the heavy lock was not had in time on')
      expect(e2eCalls(r)).toEqual([])
    },
  )

  it("the host lacks the browsers' system libraries (playwright install warns, exits 0): not tested, nothing run", async () => {
    const r = repo()
    writeFileSync(join(r.home, 'no-host-deps'), '')
    const run = r.start(partRun, PART)
    expect(await run.done, run.out()).toBe(0)
    expect(run.out()).toContain("browser-e2e refused: not tested: the browsers' system libraries are missing on")
    expect(e2eCalls(r)).toEqual([])
  })

  it('setup failed on this machine (install or build): not tested, never a red that no test made', async () => {
    const r = repo()
    const run = r.start(partRun, { ...PART, FAIL_ON: 'install --frozen-lockfile' })
    expect(await run.done, run.out()).toBe(0)
    expect(run.out()).toContain('browser-e2e refused: not tested: setup failed on')
    expect(e2eCalls(r)).toEqual([])
  })

  it('a red there is the part red', async () => {
    const r = repo()
    const run = r.start(partRun, {
      ...PART,
      FAIL_ON: '--no-bail --if-present --filter !@talos-app/web --filter !{.} test:e2e',
    })
    expect(await run.done).toBe(1)
  })

  it('cannot post under local-ci/', async () => {
    const r = repo()
    const run = r.start(['--ref', 'HEAD', '--no-status', '--jobs', 'browser-e2e'])
    expect(await run.done).toBe(64)
  })
})

describe('the split itself, with the real pnpm over this workspace', () => {
  // The fakes above only see the arguments. Here pnpm selects: every workspace package must fall on exactly one side, and the
  // workspace root on neither (its own test:e2e is `pnpm -r … test:e2e`: on the part's side it would run web there too).
  const root = join(dirname(script), '..')
  const side = (arr: 'E2E_HERE' | 'E2E_THERE' | '') => {
    const sel = arr ? `"\${${arr}[@]}"` : ''
    const out = spawnSync(
      'bash',
      ['-c', `. scripts/ci-local/jobs-mod-browser.sh && pnpm -r --workspace-concurrency=1 ${sel} exec pwd`],
      { cwd: root, encoding: 'utf8' },
    )
    expect(out.status, out.stderr).toBe(0)
    return out.stdout.split('\n').filter(Boolean).sort()
  }
  it('here + there = every package, none on both sides, never the root', () => {
    const all = side('') // `pnpm -r` alone: every package but the root
    const here = side('E2E_HERE')
    const there = side('E2E_THERE')
    expect(here.length).toBeGreaterThan(0)
    expect(there.filter((p) => here.includes(p))).toEqual([])
    expect([...here, ...there].sort()).toEqual(all)
    expect(there).not.toContain(root)
    expect(here).toEqual([join(root, 'apps/web')])
  }, 60_000)
})
