// Regression tests for the faster local CI. Each test pins one bug that was found and fixed. Same
// approach as ci-local-jobs.test.ts: the real script in a clone of a small repo, a fake `gh` that records statuses, and
// fake `pnpm` and `bun` that source $HOME/fake-hook, so a test can act inside a real step without replacing the script's
// own functions. Nothing here runs a real suite. A fake home means real slots and locks are never touched.
import { type ChildProcess, execFileSync, spawn } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest'
import { cleanEnv } from './ci-test-env'

const here = dirname(fileURLToPath(import.meta.url))
const script = join(here, 'ci-local.sh')
vi.setConfig({ testTimeout: 90_000 })

const dirs: string[] = []
const live: ChildProcess[] = []
const tidy: (() => void)[] = []
afterEach(() => {
  for (const c of live.splice(0)) c.kill('SIGKILL')
  for (const f of tidy.splice(0)) f()
})
afterAll(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const until = (cond: () => boolean) => vi.waitUntil(cond, { timeout: 30_000, interval: 25 })

/** Bounded, so a job the test leaves behind ends by itself: `waitfor <file>` gives up after 30 s. */
const waitfor = `waitfor() { local i; for i in $(seq 1 600); do [ -f "$1" ] && return 0; sleep 0.05; done; return 1; }`

function repo(jobs = '') {
  const T = mkdtempSync(join(tmpdir(), 'cijr-'))
  dirs.push(T)
  const git = (cwd: string, ...a: string[]) =>
    execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', ...a], { cwd, encoding: 'utf8' }).trim()
  const src = join(T, 'src')
  mkdirSync(join(src, 'apps/bridge/scripts'), { recursive: true })
  git(src, 'init', '-q', '-b', 'main')
  writeFileSync(join(src, 'a.txt'), 'a\n')
  writeFileSync(join(src, 'apps/bridge/scripts/test-parallel.ts'), '// stand-in\n')
  git(src, 'add', '-A')
  git(src, 'commit', '-qm', 'a')
  const first = git(src, 'rev-parse', 'HEAD')
  writeFileSync(join(src, 'a.txt'), 'b\n')
  git(src, 'commit', '-qam', 'b')
  const second = git(src, 'rev-parse', 'HEAD')
  const origin = join(T, 'origin.git')
  git(T, 'clone', '-q', '--bare', src, origin)
  const clone = join(T, 'clone')
  git(T, 'clone', '-q', origin, clone)
  mkdirSync(join(clone, 'scripts'))
  const copy = join(clone, 'scripts', 'ci-local.sh')
  writeFileSync(copy, readFileSync(script, 'utf8').replace('\ncd "$WT"\n', `\n${waitfor}\n${jobs}\ncd "$WT"\n`))
  const bin = join(T, 'bin')
  mkdirSync(bin)
  const home = join(T, 'home')
  mkdirSync(home)
  const tool = (name: string, body: string) => {
    writeFileSync(join(bin, name), `#!/bin/bash\n${body}\n`)
    chmodSync(join(bin, name), 0o755)
  }
  tool('gh', 'case "$1" in repo) echo owner/repo ;; api) echo "$*" >> "$GH_LOG" ;; esac')
  const fake = (n: string) => `echo "${n} $*" >> "$CALLS"; [ ! -f "$HOME/fake-hook" ] || . "$HOME/fake-hook"; exit 0`
  tool('pnpm', fake('pnpm'))
  tool('bun', fake('bun'))
  const env = {
    ...cleanEnv(),
    CI_MAX_LOAD: '0',
    CI_POLL: '0.05',
    CI_LOCK_TIMEOUT: '30',
    TALOS_CI_NESTED: '0',
    TALOS_CI_CACHE: '',
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
  const at = (f: string) => join(home, f)
  const touch = (f: string) => writeFileSync(at(f), '')
  const posted = () => (existsSync(env.GH_LOG) ? readFileSync(env.GH_LOG, 'utf8') : '')
  return { T, home, first, second, start, at, touch, posted, env }
}
const noStatus = ['--no-status']

describe('review #96: a cancelled run', () => {
  const freePort = () =>
    new Promise<number>((res) => {
      const s = createServer().listen(0, '127.0.0.1', () => {
        const a = s.address() as { port: number }
        s.close(() => res(a.port))
      })
    })

  // scripts/ci-local.sh:289. Shaped like Playwright 1.64.1: launchProcess spawns the web server `detached` (coreBundle.js
  // :10030), and the runner tears it down on SIGINT only (no handleSIGTERM in WebServerPlugin, runner/index.js:870). So TERM
  // to the job's group kills the runner and leaves the server. A later run asks for the slot's port with --strictPort.
  it('leaves the slot port free for the next browser job', async () => {
    const r = repo(`
job_web() { node "$HOME/runner.cjs"; }
job_probe() { node "$HOME/probe.cjs"; }`)
    writeFileSync(
      r.at('runner.cjs'),
      `const { spawn } = require('child_process'), { writeFileSync } = require('fs')
const code = "require('http').createServer((q,s)=>s.end('ok')).listen(" + process.env.PW_PORT + ", '127.0.0.1', () => require('fs').writeFileSync(process.env.HOME + '/listening', ''))"
const s = spawn(process.execPath, ['-e', code], { detached: true, stdio: 'ignore' })
writeFileSync(process.env.HOME + '/server-pid', String(s.pid))
process.on('SIGINT', () => { try { process.kill(-s.pid, 'SIGKILL') } catch {} process.exit(130) })
setInterval(() => {}, 1000)
`,
    )
    writeFileSync(
      r.at('probe.cjs'),
      `require('net').createServer().on('error', () => { console.log('port already used'); process.exit(1) })
  .listen(Number(process.env.PW_PORT), '127.0.0.1', function () { this.close() })
`,
    )
    tidy.push(() => {
      try {
        process.kill(-Number(readFileSync(r.at('server-pid'), 'utf8')), 'SIGKILL')
      } catch {}
    })
    const port = String(await freePort())
    const run = r.start([...noStatus, '--ref', 'HEAD', '--jobs', 'web'], { TALOS_CI_PW_PORT: port })
    await until(() => existsSync(r.at('listening')))
    run.child.kill('SIGTERM')
    expect(await run.done).toBe(130)
    const next = r.start([...noStatus, '--ref', 'HEAD', '--jobs', 'probe'], { TALOS_CI_PW_PORT: port })
    await next.done
    expect(next.out()).not.toContain('port already used')
    expect(await next.done).toBe(0)
  })
})

describe('review #96: a run whose main process was SIGKILLed', () => {
  // scripts/ci-local.sh:589. Jobs live in their own groups and RESULTS is one path per slot, so the orphan writes into the
  // next run's folder. Here the next run's own job fails, and that run must not exit 0 or post success on its sha.
  it("cannot report a job's result into the next run of the slot", async () => {
    const r = repo(`
job_late() {
  touch "$HOME/started-$SHA"
  waitfor "$HOME/release-$SHA"
  [ "$SHA" = "$PASSING_SHA" ]
}`)
    const env = { PASSING_SHA: r.first }
    const a = r.start(['--ref', r.first, '--jobs', 'late'], env)
    await until(() => existsSync(r.at(`started-${r.first}`)))
    a.child.kill('SIGKILL')
    await a.done
    const b = r.start(['--ref', r.second, '--jobs', 'late'], env)
    await until(() => existsSync(r.at(`started-${r.second}`)))
    r.touch(`release-${r.first}`) // the orphan of run A finishes, green
    await sleep(2500) // run B looks at its results once a second
    r.touch(`release-${r.second}`) // run B's own job fails
    expect(await b.done).toBe(1)
    expect(r.posted()).not.toMatch(new RegExp(`statuses/${r.second} .*state=success .*context=local-ci/late`))
  })

  // scripts/ci-local.sh:344. Without main, the job's chain must not walk on into the slot the next run now owns.
  it('stops its job chain, so nothing keeps running in a slot the next run took', async () => {
    const r = repo(`
step_hold() { touch "$HOME/in-first-step"; waitfor "$HOME/go"; }
job_chain() { run "$1" step_hold && run "$1" touch "$HOME/second-step-ran"; }
job_next() { touch "$HOME/next-on"; waitfor "$HOME/next-go"; }`)
    const a = r.start([...noStatus, '--ref', r.first, '--jobs', 'chain'])
    await until(() => existsSync(r.at('in-first-step')))
    a.child.kill('SIGKILL')
    await a.done
    const b = r.start([...noStatus, '--ref', r.second, '--jobs', 'next'])
    await until(() => existsSync(r.at('next-on')))
    r.touch('go')
    await sleep(2000)
    const walkedOn = existsSync(r.at('second-step-ran'))
    r.touch('next-go')
    expect(await b.done).toBe(0)
    expect(walkedOn).toBe(false)
  })

  // scripts/ci-local.sh:344, same finding: the mutex owner is main's pid, so a step still running looks dead. A check before
  // each step does not close this one: the step that holds the mutex has to be stopped, or the mutex kept.
  it('does not let a next run take a mutex from a step that is still running', async () => {
    const r = repo(`
mutex_body() {
  if [ -f "$HOME/holder" ] && kill -0 "$(cat "$HOME/holder")" 2>/dev/null; then echo overlap >> "$HOME/overlaps"; fi
  sh -c 'echo $PPID' > "$HOME/holder"
  touch "$HOME/inside"
  waitfor "$HOME/go"
}
job_build() { ci_mutex "$LOCKS" demo mutex_body; }`)
    const a = r.start([...noStatus, '--ref', r.first, '--jobs', 'build'])
    await until(() => existsSync(r.at('inside')))
    a.child.kill('SIGKILL')
    await a.done
    rmSync(r.at('inside'))
    const b = r.start([...noStatus, '--ref', r.second, '--jobs', 'build'])
    await vi.waitUntil(() => existsSync(r.at('inside')), { timeout: 5_000, interval: 25 }).catch(() => {})
    r.touch('go')
    await b.done
    expect(existsSync(r.at('overlaps'))).toBe(false)
  })
})

describe('review #96: one run per commit', () => {
  const inFlight = (b: { out: () => string }, ranTwice: () => boolean) =>
    until(() => b.out().includes('already being tested') || ranTwice())

  // scripts/ci-local.sh:322. The key is only "$JOBS $LATEST": a run that asked for more than the first one did must not
  // exit green on the first one's result.
  it.each(['TALOS_CI_FORCE_DESKTOP', 'TALOS_GUI_TESTS'])(
    'a run with %s=1 is not answered by one without',
    async (name) => {
      const r = repo(`
job_x() { echo "force=\${TALOS_CI_FORCE_DESKTOP:-0} gui=\${TALOS_GUI_TESTS:-0}" >> "$HOME/runs"; waitfor "$HOME/go"; }`)
      const lines = () => (existsSync(r.at('runs')) ? readFileSync(r.at('runs'), 'utf8').trim().split('\n') : [])
      const a = r.start([...noStatus, '--ref', 'HEAD', '--jobs', 'x'], { CI_SLOTS: '2' })
      await until(() => lines().length === 1)
      const b = r.start([...noStatus, '--ref', 'HEAD', '--jobs', 'x'], { CI_SLOTS: '2', [name]: '1' })
      await inFlight(b, () => lines().length > 1)
      r.touch('go')
      await a.done
      await b.done
      expect(lines().join('\n')).toMatch(name === 'TALOS_GUI_TESTS' ? /gui=1/ : /force=1/)
    },
  )

  // A skip is stored as exit 0, and the key leaves out --full, so a --full run waiting behind a run that skipped a job took the
  // skip for a pass. --full means no job is skipped: it must run the job itself. A run without --full still takes the skip.
  it.each([
    ['--full', 2],
    ['', 1],
  ])('a run with %j waiting behind a run that skipped a job runs it %i time(s) in all', async (flag, expected) => {
    const r = repo(`
job_x() { echo ran >> "$HOME/runs"; SKIPPED+=(x); SKIP_WHY="stub skip"; waitfor "$HOME/go"; }`)
    const count = () => (existsSync(r.at('runs')) ? readFileSync(r.at('runs'), 'utf8').trim().split('\n').length : 0)
    const a = r.start([...noStatus, '--ref', 'HEAD', '--jobs', 'x'], { CI_SLOTS: '2' })
    await until(() => count() === 1)
    const b = r.start([...noStatus, ...(flag ? [flag] : []), '--ref', 'HEAD', '--jobs', 'x'], { CI_SLOTS: '2' })
    await inFlight(b, () => count() > 1)
    r.touch('go')
    await a.done
    expect(await b.done).toBe(0)
    expect(count()).toBe(expected)
  })

  it('a run that posts is not answered by a --no-status run, which posted nothing', async () => {
    const r = repo(`
job_x() { echo ran >> "$HOME/runs"; waitfor "$HOME/go"; }`)
    const count = () => (existsSync(r.at('runs')) ? readFileSync(r.at('runs'), 'utf8').trim().split('\n').length : 0)
    const a = r.start(['--no-status', '--ref', 'HEAD', '--jobs', 'x'], { CI_SLOTS: '2' })
    await until(() => count() === 1)
    const b = r.start(['--ref', 'HEAD', '--jobs', 'x'], { CI_SLOTS: '2' })
    await inFlight(b, () => count() > 1)
    r.touch('go')
    await a.done
    expect(await b.done).toBe(0)
    expect(r.posted()).toMatch(/state=success .*context=local-ci\/x/)
  })

  it('a different job list on the same commit cannot overwrite a failure with a pass', async () => {
    const r = repo(`
job_flaky() {
  if mkdir "$HOME/first-in" 2>/dev/null; then
    for i in $(seq 1 40); do [ -f "$HOME/second-in" ] && break; sleep 0.05; done
    return 1
  fi
  touch "$HOME/second-in"
  for i in $(seq 1 200); do grep -q 'state=failure' "$GH_LOG" 2>/dev/null && break; sleep 0.05; done
}
job_other() { :; }`)
    const a = r.start(['--ref', 'HEAD', '--jobs', 'flaky'], { CI_SLOTS: '2' })
    await until(() => existsSync(r.at('first-in')))
    const b = r.start(['--ref', 'HEAD', '--jobs', 'flaky,other'], { CI_SLOTS: '2' })
    expect(await a.done).toBe(1)
    await b.done
    const flaky = r
      .posted()
      .split('\n')
      .filter((l) => l.includes('context=local-ci/flaky') && !l.includes('state=pending'))
    expect(flaky.at(-1)).toContain('state=failure')
  })
})

describe('review #96: the suites that must run alone', () => {
  // scripts/ci-local.sh:433. See the note under this finding in the review: if the owner accepts these overlaps, drop these
  // two tests and correct the comment at lines 430-432 and docs/CI-LOCAL.md instead.
  it('a Swift job does not run beside the contract suite of its own run', async () => {
    const r = repo(`
job_desktop() { touch "$HOME/swift-running"; waitfor "$HOME/contract-over"; sleep 0.2; rm -f "$HOME/swift-running"; }`)
    writeFileSync(
      r.at('fake-hook'),
      `case "$*" in *test:contract*)
  for i in $(seq 1 20); do [ -f "$HOME/swift-running" ] && echo overlap >> "$HOME/overlaps"; sleep 0.05; done
  touch "$HOME/contract-over" ;;
esac
`,
    )
    expect(await r.start([...noStatus, '--ref', 'HEAD', '--jobs', 'check,desktop']).done).toBe(0)
    expect(existsSync(r.at('overlaps'))).toBe(false)
  })

  it("a second run's loud group does not run beside the first run's contract suite", async () => {
    const r = repo()
    writeFileSync(
      r.at('fake-hook'),
      `me="$(git rev-parse HEAD)"
case "$*" in
  *test:contract*)
    if [ "$me" = "$SLOW_SHA" ]; then
      touch "$HOME/contract-running"
      for i in $(seq 1 60); do [ -f "$HOME/loud-ran" ] && break; sleep 0.05; done
      rm -f "$HOME/contract-running"
    fi ;;
  *"--skip test/schedules/"*)
    if [ "$me" != "$SLOW_SHA" ]; then
      [ -f "$HOME/contract-running" ] && echo overlap >> "$HOME/overlaps"
      touch "$HOME/loud-ran"
    fi ;;
esac
`,
    )
    const env = { CI_SLOTS: '2', SLOW_SHA: r.first }
    const a = r.start([...noStatus, '--ref', r.first, '--jobs', 'check'], env)
    await until(() => existsSync(r.at('contract-running')))
    const b = r.start([...noStatus, '--ref', r.second, '--jobs', 'check'], env)
    expect(await a.done).toBe(0)
    expect(await b.done).toBe(0)
    expect(existsSync(r.at('overlaps'))).toBe(false)
  })
})

describe('review #96: what a failure shows', () => {
  // scripts/ci-local.sh:371 and :614: the side-by-side logs go in fixed order, and report prints only the last 25 lines.
  it('a failing bridge file shows in the terminal, past Vitest output', async () => {
    const r = repo()
    writeFileSync(
      r.at('fake-hook'),
      `case "$*" in
  *"--skip test/schedules/"*) echo "the bridge reason"; exit 1 ;;
  *"test --maxWorkers"*) seq 1 40 ;;
esac
`,
    )
    const run = r.start([...noStatus, '--ref', 'HEAD', '--jobs', 'check'])
    expect(await run.done).toBe(1)
    expect(run.out()).toContain('✗ check')
    expect(run.out()).toContain('the bridge reason')
  })
})
