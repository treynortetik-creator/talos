// The runner, part 3: report-ci/fast and a cancelled run (split from ci-local-runner.test.ts so the parts run side by side; the setup below is the same).
// scripts/ci-local.sh as the self-hosted runner uses it (docs/CI-LOCAL.md, "On the self-hosted runner"): what a cancelled run leaves behind
// (nothing: no held lock, no stale container, no half-started colima, no status stuck pending), what a status says and links to,
// where the scratch goes, and a Mac that slept warning by default. The same harness as ci-local-jobs.test.ts: a local
// "origin", a fake `gh` that records the statuses it is asked to post, fake `pnpm`/`docker`/`colima`/`sysctl`.
import { type ChildProcess, execFileSync, spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
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
const alive = (pid: number) => spawnSync('kill', ['-0', String(pid)]).status === 0
const started = (f: string) =>
  vi.waitUntil(() => existsSync(f) && readFileSync(f, 'utf8').trim() !== '', { timeout: 30_000, interval: 25 })

function repo(jobs = '', tools: Record<string, string> = {}, pre = '') {
  const T = mkdtempSync(join(tmpdir(), 'cilr-'))
  dirs.push(T)
  const git = (cwd: string, ...a: string[]) =>
    execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', ...a], { cwd, encoding: 'utf8' }).trim()
  const src = join(T, 'src')
  mkdirSync(src, { recursive: true })
  git(src, 'init', '-q', '-b', 'main')
  writeFileSync(join(src, 'a.txt'), 'a\n')
  git(src, 'add', '-A')
  git(src, 'commit', '-qm', 'a')
  const origin = join(T, 'origin.git')
  git(T, 'clone', '-q', '--bare', src, origin)
  const clone = join(T, 'clone')
  git(T, 'clone', '-q', origin, clone)
  mkdirSync(join(clone, 'scripts'))
  const copy = join(clone, 'scripts', 'ci-local.sh')
  // `pre` is code run before the run asks for its slot (a wait the jobs' own stubs come too late to reach)
  writeFileSync(
    copy,
    readFileSync(script, 'utf8')
      .replace('\ncd "$WT"\n', `\n${jobs}\ncd "$WT"\n`)
      .replace('\nT_ASKED=$(date +%s)\n', `\n${pre}\nT_ASKED=$(date +%s)\n`),
  )
  copyCiLocalParts(join(clone, 'scripts')) // the parts ci-local.sh sources in place
  // the helpers ci-local.sh runs from its own folder
  for (const h of ['ci-swift-retry.sh', 'ci-flake-vitest.ts'])
    writeFileSync(join(clone, 'scripts', h), readFileSync(join(dirname(script), h), 'utf8'))
  const bin = join(T, 'bin')
  mkdirSync(bin)
  const home = join(T, 'home')
  mkdirSync(home)
  const tool = (name: string, body: string) => fakeTool(bin, name, `#!/bin/bash\n${body}\n`)
  // `gh repo view` fails: a runner run gives the repository in CI_REPO and must not need it.
  tool('gh', 'case "$1" in repo) exit 1 ;; api) echo "$*" >> "$GH_LOG" ;; esac')
  tool('pnpm', 'exit 0')
  tool('bun', 'exit 0')
  for (const [n, b] of Object.entries(tools)) tool(n, b)
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
  const cache = join(home, '.cache/talos-ci')
  const posted = () => (existsSync(env.GH_LOG as string) ? readFileSync(env.GH_LOG as string, 'utf8') : '')
  return {
    T,
    home,
    clone,
    git,
    start,
    env,
    cache,
    posted,
    tool,
    runs: () => readdirSync(join(cache, 'runs')),
    locks: () => (existsSync(join(cache, 'locks')) ? readdirSync(join(cache, 'locks')) : []),
  }
}
const repoArgs = { CI_REPO: 'owner/repo' }
const withStatus = ['--ref', 'HEAD']

describe('report-ci/fast: typecheck, lint and the unit tests, posted beside the six, outside the verdict', () => {
  // job_check is a stub: what pnpm is asked comes from the fast lane (and the run's one install and build)
  const QUIET_CHECK = 'job_check() { :; }'
  const calls = (r: { env: Record<string, string> }) =>
    existsSync(r.env.CALLS as string) ? readFileSync(r.env.CALLS as string, 'utf8') : ''

  it('a run that tests check also posts report-ci/fast: pending, then its answer, never under local-ci/', async () => {
    const r = repo(QUIET_CHECK, { pnpm: 'echo "pnpm $*" >> "$CALLS"; exit 0' })
    const run = r.start([...withStatus, '--jobs', 'check'], repoArgs)
    expect(await run.done, run.out()).toBe(0)
    const p = r.posted()
    expect(p).toMatch(/state=pending .*context=report-ci\/fast /)
    expect(p).toMatch(/state=success .*context=report-ci\/fast .*description=passed on /)
    expect(p).not.toContain('context=local-ci/fast')
    const c = calls(r)
    expect(c).toContain('pnpm typecheck')
    expect(c).toContain('pnpm lint')
    // no base here (this fake GitHub has no statuses), so no unit tests: they would repeat check's. ci-affected.test.ts
    // checks the run with a base, where the unit tests the change can reach run
    expect(c).not.toContain('vitest')
  })

  it('a failing step fails report-ci/fast and names it; the run is red, as check would be', async () => {
    const r = repo(QUIET_CHECK, { pnpm: 'case "$1" in lint) exit 1 ;; *) exit 0 ;; esac' })
    const run = r.start([...withStatus, '--jobs', 'check'], repoArgs)
    expect(await run.done, `${run.out()}\n${r.posted()}`).toBe(1)
    expect(r.posted()).toMatch(/state=failure .*context=report-ci\/fast /)
    expect(r.posted()).toMatch(/state=success .*context=local-ci\/check /)
  })

  it('no fast status without check in the run, or without statuses at all', async () => {
    const a = repo('job_mod() { :; }')
    expect(await a.start([...withStatus, '--jobs', 'mod'], repoArgs).done).toBe(0)
    expect(a.posted()).not.toContain('report-ci/fast')
    const b = repo(QUIET_CHECK, { pnpm: 'echo "pnpm $*" >> "$CALLS"; exit 0' })
    expect(await b.start(['--no-status', '--ref', 'HEAD', '--jobs', 'check']).done).toBe(0)
    expect(calls(b)).not.toContain('vitest')
  })

  it('--jobs cannot name fast: it is not a job of its own, it comes with check', async () => {
    const r = repo(QUIET_CHECK)
    const run = r.start([...withStatus, '--jobs', 'check,fast'], repoArgs)
    expect(await run.done).toBe(64)
    expect(run.out()).toContain('fast is not a job')
    expect(r.posted()).toBe('')
  })

  it('a cancel closes a pending report-ci/fast as not tested, like a job', async () => {
    const r = repo(`${QUIET_CHECK}\njob_fast() { sleep 120 & echo "$!" > "$HOME/child"; wait; }`)
    const run = r.start([...withStatus, '--jobs', 'check'], {
      ...repoArgs,
      CI_STATUS_URL: 'https://example.test/runs/9',
    })
    await started(join(r.home, 'child'))
    run.child.kill('SIGTERM')
    expect(await run.done).toBe(130)
    expect(r.posted()).toMatch(
      /state=error .*context=report-ci\/fast .*not tested: run cancelled before this job reported/,
    )
  })

  it('it never takes the suites mutex or any other, and every step runs at low priority', () => {
    const text = readFileSync(join(dirname(script), 'ci-local/jobs-check.sh'), 'utf8') // job_fast is there
    const job = text.slice(text.indexOf('job_fast() {'), text.indexOf('\n}\n', text.indexOf('job_fast() {')))
    expect(job).not.toContain('ci_mutex')
    const steps = job.split('\n').filter((l) => /run "\$log"/.test(l))
    expect(steps.length).toBeGreaterThanOrEqual(3)
    for (const l of steps) expect(l).toMatch(/run "\$log" nice -n \d+ /)
  })
})

describe('a cancelled run leaves nothing behind', () => {
  const LONG = `
job_long() { sleep 120 & echo "$!" > "$HOME/child"; wait; }
job_mx() { ci_mutex "$LOCKS" docker sleep 120; }`

  // Cancelled (INT or TERM: a cancel, a job timeout, a stopped runner) is an error that says "not tested:", which no verdict reads
  // as red or green, and GitHub never shows as a pass; a run killed outright (no trap) keeps the plain error (below).
  it("no status is left pending: the job a cancelled run never finished is closed as not tested, with the run's link", async () => {
    for (const sig of ['SIGTERM', 'SIGINT'] as const) {
      const r = repo(LONG)
      const run = r.start([...withStatus, '--jobs', 'long'], {
        ...repoArgs,
        CI_STATUS_WHERE: 'ci-runner',
        CI_STATUS_URL: 'https://example.test/runs/9',
      })
      await started(join(r.home, 'child'))
      run.child.kill(sig)
      expect(await run.done, sig).toBe(130)
      const p = r.posted()
      expect(p, sig).toMatch(/state=pending .*context=local-ci\/long/)
      expect(p, sig).toMatch(
        /state=error .*context=local-ci\/long .*description=not tested: run cancelled before this job reported \(on ci-runner\); re-run .*target_url=https:\/\/example.test\/runs\/9/,
      )
      expect(p, sig).not.toContain('state=success') // never a green for a job nobody ran
      expect(p, sig).not.toContain('ended before this job reported') // nor the plain error of a run that died
    }
  })

  it('a job that already reported keeps its answer; only the unfinished one is closed', async () => {
    const r = repo(`${LONG}\njob_quick() { :; }`)
    const run = r.start([...withStatus, '--jobs', 'quick,long'], repoArgs)
    await started(join(r.home, 'child'))
    await vi.waitUntil(() => /state=success .*local-ci\/quick/.test(r.posted()), { timeout: 30_000, interval: 25 })
    // The marker is written just after the post. A kill between the two is closed by the check against GitHub (a status that is
    // no longer pending is left alone, see the dead-run test below); this test is about the marker, so it waits for it.
    await vi.waitUntil(() => r.runs().some((d) => existsSync(join(r.cache, 'runs', d, 'reported/quick'))), {
      timeout: 30_000,
      interval: 25,
    })
    run.child.kill('SIGTERM')
    await run.done
    const p = r.posted()
    expect(p).toMatch(/state=error .*context=local-ci\/long .*not tested:/)
    expect(p).not.toMatch(/context=local-ci\/quick .*not tested:/)
  })

  it('a mutex a job was holding is released, not left with a dead owner', async () => {
    const r = repo(LONG)
    const run = r.start(['--no-status', '--ref', 'HEAD', '--jobs', 'mx'])
    await vi.waitUntil(() => r.locks().includes('mutex-docker'), { timeout: 30_000, interval: 25 })
    run.child.kill('SIGTERM')
    expect(await run.done).toBe(130)
    expect(r.locks()).toEqual([]) // no slot, no sha lock, no mutex
  })

  it('killed outright: the watchdog does it all: statuses closed, locks released, worktree and temp dir gone', async () => {
    const r = repo(LONG)
    const wtBase = join(r.T, 'wt-base')
    mkdirSync(wtBase)
    const run = r.start([...withStatus, '--jobs', 'long,mx'], { ...repoArgs, CI_WT_BASE: wtBase })
    await started(join(r.home, 'child'))
    await vi.waitUntil(() => r.locks().includes('mutex-docker'), { timeout: 30_000, interval: 25 })
    expect(readdirSync(wtBase)).toHaveLength(1)
    const child = Number(readFileSync(join(r.home, 'child'), 'utf8'))
    run.child.kill('SIGKILL')
    await run.done
    await vi.waitUntil(() => !alive(child) && r.runs().length === 0, { timeout: 20_000, interval: 50 })
    expect(r.locks()).toEqual([])
    expect(readdirSync(wtBase)).toEqual([])
    expect(existsSync(join(r.cache, 'tmp/talos-ci-s1'))).toBe(false)
    expect(r.posted()).toMatch(/state=error .*context=local-ci\/long/)
    expect(r.posted()).toMatch(/state=error .*context=local-ci\/mx/)
  })

  it('a runner that signals every process under a cancelled job (INT, then TERM, then KILL) cannot take the watchdog with it', async () => {
    const r = repo(LONG)
    const run = r.start([...withStatus, '--jobs', 'long'], repoArgs)
    await started(join(r.home, 'child'))
    // Everything under the run, found the way a runner finds it: by parent pid.
    const table = execFileSync('ps', ['-A', '-o', 'pid=,ppid='], { encoding: 'utf8' })
      .trim()
      .split('\n')
      .map((l) => l.trim().split(/\s+/).map(Number) as [number, number])
    const under = new Set<number>([run.child.pid as number])
    for (let grew = true; grew; ) {
      grew = false
      for (const [pid, ppid] of table) {
        if (under.has(ppid) && !under.has(pid)) {
          under.add(pid)
          grew = true
        }
      }
    }
    under.delete(run.child.pid as number)
    expect(under.size).toBeGreaterThan(2) // job group, its sleep, the watchdog, ...
    run.child.kill('SIGKILL') // the run is gone before it can clean up itself
    for (const sig of ['SIGINT', 'SIGTERM'] as const)
      for (const pid of under) spawnSync('kill', [`-${sig.slice(3)}`, String(pid)])
    await run.done
    await vi.waitUntil(() => r.runs().length === 0, { timeout: 20_000, interval: 50 })
    expect(r.posted()).toMatch(/state=error .*context=local-ci\/long/)
    expect(r.locks()).toEqual([])
  })

  it('--reap does the same for a run nothing was left to clean up after (both it and its watchdog killed)', async () => {
    const r = repo()
    const rec = join(r.cache, 'runs/dead-run')
    const wtBase = join(r.T, 'wt-base')
    const wt = join(wtBase, 'talos-ci-abc1234.XXXX')
    mkdirSync(join(rec, 'reported'), { recursive: true })
    mkdirSync(join(wt, 'node_modules'), { recursive: true })
    mkdirSync(join(r.cache, 'tmp/talos-ci-s1'), { recursive: true })
    const owner = '999999\nlong ago\nnonce-1' // a pid that is not running
    writeFileSync(join(rec, 'owner'), owner)
    writeFileSync(join(rec, 'worktree'), wt)
    writeFileSync(join(rec, 'tmp'), join(r.cache, 'tmp/talos-ci-s1'))
    writeFileSync(join(rec, 'repo'), r.clone)
    const sha = 'c'.repeat(40)
    writeFileSync(
      join(rec, 'posted'),
      `owner/repo\tci-runner\thttps://example.test/runs/3\n${sha}\tcheck\n${sha}\tmod\n`,
    )
    writeFileSync(join(rec, 'reported/mod'), '') // mod had its answer
    // A lock that run held, and a lock a live run holds.
    for (const [name, text] of [
      ['slot-1', owner],
      ['slot-2', `${process.pid}\n\nlive`],
    ]) {
      mkdirSync(join(r.cache, 'locks', name!), { recursive: true })
      writeFileSync(join(r.cache, 'locks', name!, 'owner'), text!)
    }
    mkdirSync(join(r.cache, 'runs/live-run'))
    writeFileSync(join(r.cache, 'runs/live-run/owner'), `${process.pid}\n\nlive`)

    const reap = r.start(['--reap'])
    expect(await reap.done).toBe(0)
    expect(existsSync(rec)).toBe(false)
    expect(existsSync(wt)).toBe(false)
    expect(existsSync(join(r.cache, 'tmp/talos-ci-s1'))).toBe(false)
    expect(r.locks()).toEqual(['slot-2']) // the dead run's lock is released, the live one's is not
    expect(existsSync(join(r.cache, 'runs/live-run'))).toBe(true)
    const p = r.posted()
    expect(p).toMatch(
      new RegExp(`statuses/${sha} .*state=error .*context=local-ci/check .*target_url=https://example.test/runs/3`),
    )
    expect(p).not.toContain('local-ci/mod')
  })

  it("an older run's record (bare job names) is closed under local-ci/, whatever prefix the reaper itself posts under", async () => {
    const r = repo()
    const rec = join(r.cache, 'runs/old-run')
    mkdirSync(join(rec, 'reported'), { recursive: true })
    writeFileSync(join(rec, 'owner'), '999999\nlong ago\nnonce-2')
    const sha = 'd'.repeat(40)
    writeFileSync(join(rec, 'posted'), `owner/repo\tci-runner\thttps://example.test/runs/4\n${sha}\tcheck\n`)
    const reap = r.start(['--reap'], { CI_STATUS_PREFIX: 'ci-part' })
    expect(await reap.done).toBe(0)
    expect(r.posted()).toMatch(new RegExp(`statuses/${sha} .*state=error .*context=local-ci/check `))
    expect(r.posted()).not.toContain('context=ci-part/check')
  })

  it('a record stays readable by an older ci-local.sh: bare job names for local-ci/ and report-ci/fast, three header fields', async () => {
    const r = repo('job_long() { sleep 120 & echo "$!" > "$HOME/child"; wait; }\njob_check() { :; }')
    const run = r.start([...withStatus, '--jobs', 'long'], {
      ...repoArgs,
      CI_STATUS_URL: 'https://example.test/runs/9/attempts/1#lemnos',
      CI_ATTEMPT_URL: 'https://example.test/runs/9/attempts/1#',
    })
    await started(join(r.home, 'child'))
    const id = r.runs()[0] as string
    const posted = readFileSync(join(r.cache, 'runs', id, 'posted'), 'utf8')
      .trim()
      .split('\n')
    expect(posted[0]?.split('\t')).toHaveLength(3)
    expect(posted.slice(1).map((l) => l.split('\t')[1])).toEqual(['long'])
    expect(readFileSync(join(r.cache, 'runs', id, 'attempt'), 'utf8').trim()).toBe(
      'https://example.test/runs/9/attempts/1#',
    )
    run.child.kill('SIGTERM')
    await run.done
  })

  // An older ci-local.sh (before CI_STATUS_PREFIX, e.g. a rollback or an old base on a runner that shares this cache) settles a
  // dead run's record by posting `error` to the context it always meant for each row of `posted`: report-ci/fast for "fast",
  // local-ci/<row> for anything else (it reads the row as a bare job name). Its rule, copied from 8f3fbcb7^, is the oracle here.
  const olderReaperContexts = (posted: string) =>
    posted
      .trim()
      .split('\n')
      .slice(1)
      .map((l) => l.split('\t')[1] as string)
      .filter(Boolean)
      .map((job) => (job === 'fast' ? 'report-ci/fast' : `local-ci/${job}`))

  it("a part's or report-only run's record gives an older reaper nothing to post: its contexts are in a file of their own", async () => {
    for (const prefix of ['ci-part', 'report-ci']) {
      const r = repo('job_long() { sleep 120 & echo "$!" > "$HOME/child"; wait; }\njob_check() { :; }')
      const run = r.start([...withStatus, '--jobs', 'long'], { ...repoArgs, CI_STATUS_PREFIX: prefix })
      await started(join(r.home, 'child'))
      const rec = join(r.cache, 'runs', r.runs()[0] as string)
      const posted = existsSync(join(rec, 'posted')) ? readFileSync(join(rec, 'posted'), 'utf8') : ''
      // what an older reaper would close: nothing under local-ci/, so no extra local-ci/* context turns the verdict red
      expect(
        olderReaperContexts(posted).filter((c) => c.startsWith('local-ci/')),
        prefix,
      ).toEqual([])
      const own = readFileSync(join(rec, 'posted-contexts'), 'utf8').trim().split('\n')
      expect(own[0]?.split('\t'), prefix).toHaveLength(3)
      expect(
        own.slice(1).map((l) => l.split('\t')[1]),
        prefix,
      ).toEqual([`${prefix}/long`])
      // and this ci-local.sh still closes it, under its own context, when the run is cancelled
      run.child.kill('SIGTERM')
      await run.done
      expect(r.posted(), prefix).toMatch(new RegExp(`state=error .*context=${prefix}/long .*not tested:`))
      expect(r.posted(), prefix).not.toContain('context=local-ci/')
    }
  })

  // bash 5.2 runs a TERM trap that comes due while the shell parses a $(...) in the middle of that parse: the trap fails (no cancelled
  // marker, no exit 130) and the same parse error cuts off the command it was in, the main loop. That race is what a loaded machine
  // hits; here the cut is made the same way on purpose (an expansion error in the loop's own step, once the job is going).
  it('a main loop cut off with a job unreported (a cancel whose trap bash lost) ends as cancelled, never as all green', async () => {
    const r = repo(
      'job_long() { sleep 120 & echo "$!" > "$HOME/child"; wait; }\njob_check() { :; }\n' +
        'part_beat_post() { [ -e "$HOME/child" ] || return 0; local x; x=$((1 +)); }',
    )
    const run = r.start([...withStatus, '--jobs', 'long'], { ...repoArgs, CI_STATUS_PREFIX: 'ci-part' })
    await started(join(r.home, 'child'))
    expect(await run.done).toBe(130)
    expect(run.out()).not.toContain('all green')
    expect(r.posted()).toMatch(/state=error .*context=ci-part\/long .*not tested:/)
    expect(alive(Number(readFileSync(join(r.home, 'child'), 'utf8').trim()))).toBe(false)
    expect(r.runs()).toEqual([])
  })

  // The same cut in the waits before the jobs start, the commonest time a run is cancelled: the cut abandons the whole command (the
  // wait for a slot, or the wait for the commit's lock) and the script went on, unslotted or unlocked, deaf to the cancel.
  // Here it is made on purpose, with an expansion error in a step of the wait itself.
  const CUT = 'local x; x=$((1 +))'
  const ranStub = 'job_long() { : > "$HOME/ran"; }\njob_check() { :; }'
  const slotsLeft = (r: { locks: () => string[] }) => r.locks().filter((l) => /^(slot|sha)-/.test(l))

  it('the wait for a free slot cut off (a cancel whose trap bash lost) ends as cancelled: no slot, no jobs, nothing posted', async () => {
    const r = repo(ranStub, {}, `ci_legacy_busy() { ${CUT}; }`)
    const run = r.start([...withStatus, '--jobs', 'long'], repoArgs)
    expect(await run.done, run.out()).toBe(130)
    expect(run.out()).toMatch(/::error::.*wait for a free slot was cut off/)
    expect(run.out()).not.toContain('all green')
    expect(existsSync(join(r.home, 'ran'))).toBe(false)
    expect(r.posted()).toBe('')
    expect(slotsLeft(r)).toEqual([])
  })

  it('the wait for the commit already being tested cut off ends as cancelled: the lock was never had, so no jobs run', async () => {
    // the commit's lock reads as held by someone else, and the wait's first pause is the step that is cut (once: the wait for the jobs sleeps too)
    const pre = `eval "$(declare -f ci_lock_try | sed '1s/ci_lock_try/ci_lock_try_real/')"\nci_lock_try() { case "$1" in */sha-*) return 1 ;; esac; ci_lock_try_real "$@"; }\nsleep() { [ ! -e "$HOME/cut" ] || { command sleep "$@"; return; }; : > "$HOME/cut"; ${CUT}; }`
    const r = repo(ranStub, {}, pre)
    const run = r.start([...withStatus, '--jobs', 'long'], repoArgs)
    expect(await run.done, run.out()).toBe(130)
    expect(run.out()).toMatch(/::error::.*wait for the run testing [0-9a-f]{7} was cut off/)
    expect(run.out()).not.toContain('all green')
    expect(existsSync(join(r.home, 'ran'))).toBe(false)
    expect(r.posted()).toBe('')
    expect(slotsLeft(r)).toEqual([]) // the slot it did take is let go
  })

  it('a cut right after the slot is taken (its turn and queue ticket still to let go) ends as cancelled and leaves no ticket or turn lock', async () => {
    // two heavy slots: the run waits in locks.queue/admit and holds the turn lock through the take; the first look at the turn lock after
    // slot-1 exists is the step that is cut (once)
    const pre = `eval "$(declare -f ci_turn_leave | sed '1s/ci_turn_leave/ci_turn_leave_real/')"\nci_turn_leave() { if [ -d "$LOCKS/slot-1" ] && [ ! -e "$HOME/cut" ]; then : > "$HOME/cut"; ${CUT}; fi; ci_turn_leave_real "$@"; }`
    const r = repo(ranStub, {}, pre)
    const run = r.start([...withStatus, '--jobs', 'long'], { ...repoArgs, TALOS_HEAVY_SLOTS: '2' })
    expect(await run.done, run.out()).toBe(130)
    expect(existsSync(join(r.home, 'cut'))).toBe(true)
    expect(run.out()).toMatch(/::error::.*wait for a free slot was cut off/)
    expect(existsSync(join(r.home, 'ran'))).toBe(false)
    expect(r.posted()).toBe('')
    expect(r.locks().filter((l) => /^(slot|sha|mutex-turn)/.test(l))).toEqual([])
    const admit = join(r.cache, 'locks.queue/admit')
    expect(existsSync(admit) ? readdirSync(admit) : []).toEqual([])
  })

  it('a cut after the commit lock was made and owned, before this run recorded it as held, ends as cancelled', async () => {
    const pre = `eval "$(declare -f ci_new_owner | sed '1s/ci_new_owner/ci_new_owner_real/')"\nci_new_owner() { ci_new_owner_real "$@" || return 1; case "$1" in */sha-*) ${CUT} ;; esac; }`
    const r = repo(ranStub, {}, pre)
    const run = r.start([...withStatus, '--jobs', 'long'], repoArgs)
    expect(await run.done, run.out()).toBe(130)
    expect(run.out()).toMatch(/::error::.*wait for the run testing [0-9a-f]{7} was cut off/)
    expect(existsSync(join(r.home, 'ran'))).toBe(false)
    expect(r.posted()).toBe('')
    expect(slotsLeft(r)).toEqual([]) // owned, though not in CI_HELD: the exit lets it go (ci_release_owned)
  })

  it('a dead part run found by the next run (its record left whole) is closed under its own prefix, the bare rows under theirs', async () => {
    const r = repo()
    const rec = join(r.cache, 'runs/dead-part-run')
    mkdirSync(join(rec, 'reported'), { recursive: true })
    writeFileSync(join(rec, 'owner'), '999999\nlong ago\nnonce-3')
    const sha = 'e'.repeat(40)
    writeFileSync(
      join(rec, 'posted'),
      `owner/repo\tdelphi\thttps://example.test/runs/5/attempts/1#delphi\n${sha}\tfast\n`,
    )
    writeFileSync(
      join(rec, 'posted-contexts'),
      `owner/repo\tdelphi\thttps://example.test/runs/5/attempts/1#delphi\n${sha}\tci-part/vitest\n${sha}\tci-part/bridge-shard-1\n`,
    )
    writeFileSync(join(rec, 'reported/bridge-shard-1'), '') // that part had its answer
    const reap = r.start(['--reap'])
    expect(await reap.done).toBe(0)
    expect(existsSync(rec)).toBe(false)
    const p = r.posted()
    expect(p).toMatch(new RegExp(`statuses/${sha} .*state=error .*context=ci-part/vitest `))
    expect(p).toMatch(new RegExp(`statuses/${sha} .*state=error .*context=report-ci/fast `))
    expect(p).not.toContain('context=ci-part/bridge-shard-1')
    expect(p).not.toContain('context=local-ci/')
  })

  // The nightly (CI_NIGHTLY=1, from ci-runner.sh on a schedule run) posts under nightly-ci/ only: a push run's local-ci/* verdict
  // on the same commit is never set back to pending or overwritten (87169cd9, 2026-11-14: main read as untested for two hours).
  it('the nightly posts nightly-ci/<job>, nightly-ci/part-<part> and nightly-ci/report-<job>, never local-ci/* or report-ci/*', async () => {
    for (const [prefix, want] of [
      ['local-ci', 'nightly-ci/long'],
      ['ci-part', 'nightly-ci/part-long'],
      ['report-ci', 'nightly-ci/report-long'],
    ] as const) {
      const r = repo('job_long() { sleep 120 & echo "$!" > "$HOME/child"; wait; }\njob_check() { :; }')
      const run = r.start([...withStatus, '--jobs', 'long'], { ...repoArgs, CI_STATUS_PREFIX: prefix, CI_NIGHTLY: '1' })
      await started(join(r.home, 'child'))
      const rec = join(r.cache, 'runs', r.runs()[0] as string)
      // its contexts are in posted-contexts, never bare rows an older (or a push run's) reaper would close under local-ci/
      const posted = existsSync(join(rec, 'posted')) ? readFileSync(join(rec, 'posted'), 'utf8') : ''
      expect(olderReaperContexts(posted), prefix).toEqual([])
      expect(readFileSync(join(rec, 'posted-contexts'), 'utf8'), prefix).toContain(`\t${want}\n`)
      run.child.kill('SIGTERM')
      await run.done
      const p = r.posted()
      expect(p, prefix).toMatch(new RegExp(`state=pending .*context=${want} `))
      expect(p, prefix).toMatch(new RegExp(`state=error .*context=${want} .*not tested:`))
      expect(p, prefix).not.toMatch(/context=(local-ci|report-ci|ci-part)\//)
    }
  })

  it("a nightly's reaper closes an older run's bare rows under local-ci/, the context they always meant", async () => {
    const r = repo()
    const rec = join(r.cache, 'runs/old-push-run')
    mkdirSync(join(rec, 'reported'), { recursive: true })
    writeFileSync(join(rec, 'owner'), '999999\nlong ago\nnonce-9')
    const sha = 'f'.repeat(40)
    writeFileSync(join(rec, 'posted'), `owner/repo\tci-runner\thttps://example.test/runs/8\n${sha}\tcheck\n`)
    const reap = r.start(['--reap'], { CI_NIGHTLY: '1' })
    expect(await reap.done).toBe(0)
    expect(r.posted()).toMatch(new RegExp(`statuses/${sha} .*state=error .*context=local-ci/check `))
    expect(r.posted()).not.toContain('nightly-ci/')
  })

  it("a dead nightly's record: what it reported (marked by job name) is left alone, the rest closed under nightly-ci/", async () => {
    const r = repo()
    const rec = join(r.cache, 'runs/dead-nightly')
    mkdirSync(join(rec, 'reported'), { recursive: true })
    writeFileSync(join(rec, 'owner'), '999999\nlong ago\nnonce-10')
    const sha = '9'.repeat(40)
    writeFileSync(
      join(rec, 'posted-contexts'),
      `owner/repo\ttitan\thttps://example.test/runs/6/attempts/1#check-titan\n${sha}\tnightly-ci/part-check\n${sha}\tnightly-ci/report-fast\n${sha}\tnightly-ci/mod\n`,
    )
    for (const j of ['check', 'fast']) writeFileSync(join(rec, 'reported', j), '')
    const reap = r.start(['--reap'])
    expect(await reap.done).toBe(0)
    const p = r.posted()
    expect(p).toMatch(new RegExp(`statuses/${sha} .*state=error .*context=nightly-ci/mod `))
    expect(p).not.toContain('nightly-ci/part-check')
    expect(p).not.toContain('nightly-ci/report-fast')
  })

  it('a stale container and image of the run are removed; Docker already up means colima is not touched', async () => {
    const docker = `echo "docker $*" >> "$CALLS"
case "$1" in
  info) exit 0 ;;
  build) cat > /dev/null; echo "$$" > "$HOME/building"; sleep 120 ;;
  *) exit 0 ;;
esac`
    const r = repo('', { docker, colima: 'echo "colima $*" >> "$CALLS"; exit 0' })
    const run = r.start(['--no-status', '--ref', 'HEAD', '--jobs', 'image'])
    await started(join(r.home, 'building'))
    run.child.kill('SIGTERM')
    expect(await run.done).toBe(130)
    const calls = readFileSync(r.env.CALLS as string, 'utf8')
    expect(calls).toMatch(/docker rm -f talos-ci-s1-[0-9a-f]{7}-\d+/)
    expect(calls).toMatch(/docker image rm -f talos-relay:ci-[0-9a-f]{7}-s1/)
    expect(calls).not.toContain('colima')
    expect(r.runs()).toEqual([])
  })

  // Each check after the relay's /healthz is a step of its own in the job log, and a failed one says what came back (Titan's
  // image job failed at one of them, and the log could not say which).
  describe("the image job's checks, each a named step that says what came back when it fails", () => {
    // a fake Docker whose relay answers as $ROOT_BODY, $ME_CODE and $UID_LINE say; a fake curl that is that relay
    const tools = {
      docker: `echo "docker $*" >> "$CALLS"
case "$1" in
  info | run | rm | logs) exit 0 ;;
  build) cat > /dev/null; exit 0 ;;
  image) exit 0 ;;
  exec) shift 2; line="\${UID_LINE:-Uid:	10001	10001	10001	10001}"; case "$*" in *"grep -q"*) printf '%s\\n' "$line" | grep -q '^Uid:[[:space:]]*10001' ;; *) printf '%s\\n' "$line" ;; esac; exit ;;
esac`,
      curl: `case "$*" in
  *-w*) printf '%s' "\${ME_CODE:-401}" ;;
  */healthz*) echo '{"ok":true}' ;;
  *) printf '%s' "\${ROOT_BODY:-<html><div id=\\"root\\"></div></html>}" ;;
esac`,
      openssl: 'echo key',
    }
    const imageLog = (r: { cache: string }) => {
      const logs = readdirSync(join(r.cache, 'logs')).filter((f) => f.endsWith('-image.log'))
      return readFileSync(join(r.cache, 'logs', logs[0] as string), 'utf8')
    }
    it('all pass: three named steps, each exit 0', async () => {
      const r = repo('', tools)
      const run = r.start(['--no-status', '--ref', 'HEAD', '--jobs', 'image'])
      expect(await run.done, run.out()).toBe(0)
      const log = imageLog(r)
      for (const step of ['image_root', 'image_me', 'image_uid'])
        expect(log).toMatch(new RegExp(`\\[step\\] \\d+s exit 0: ${step} `))
    })
    const cases: [string, Record<string, string>, string, RegExp][] = [
      [
        'image_root',
        { ROOT_BODY: 'Bad Gateway from a proxy' },
        '/ did not serve the web app',
        /sent \(first 200 bytes\): Bad Gateway from a proxy/,
      ],
      ['image_me', { ME_CODE: '200' }, '/api/me without a session answered 200, not 401', /answered 200/],
      ['image_uid', { UID_LINE: 'Uid:\t0\t0\t0\t0' }, 'the relay does not run as uid 10001', /Uid:\t0\t0\t0\t0/],
    ]
    for (const [step, env, says, shows] of cases)
      it(`${step} fails: the job is red, its step is named, and the log says what came back`, async () => {
        const r = repo('', tools)
        const run = r.start(['--no-status', '--ref', 'HEAD', '--jobs', 'image'], env)
        expect(await run.done).toBe(1)
        const log = imageLog(r)
        expect(log).toMatch(new RegExp(`\\[step\\] \\d+s exit 1: ${step} `))
        expect(log).toContain(says)
        expect(log).toMatch(shows)
      })
  })

  it('cut off in the middle of `colima start`, the half-started VM is stopped; a start that finished is left running', async () => {
    const docker = `echo "docker $*" >> "$CALLS"; [ -f "$HOME/up" ] && exit 0; exit 1`
    const colima = `echo "colima $*" >> "$CALLS"
case "$1" in start) echo "$$" > "$HOME/starting"; sleep 120 ;; *) exit 0 ;; esac`
    // colima is the Mac's way to Docker (docker_up takes systemctl on Linux), so the Mac's path is what this tests: on every OS,
    // uname -s says Darwin here (anything else goes to the real uname)
    const uname = `case "$1" in -s) echo Darwin ;; *) PATH=/usr/bin:/bin exec uname "$@" ;; esac`
    const r = repo('', { docker, colima, uname })
    const run = r.start(['--no-status', '--ref', 'HEAD', '--jobs', 'image'])
    await started(join(r.home, 'starting'))
    run.child.kill('SIGTERM')
    expect(await run.done).toBe(130)
    expect(readFileSync(r.env.CALLS as string, 'utf8')).toContain('colima stop --force')

    // The same job when the start completes: nothing stops it.
    const ok = repo('', {
      docker: `echo "docker $*" >> "$CALLS"; case "$1" in info) [ -f "$HOME/up" ]; exit ;; build) cat > /dev/null; exit 1 ;; *) exit 0 ;; esac`,
      colima: 'echo "colima $*" >> "$CALLS"; touch "$HOME/up"; exit 0',
      uname,
    })
    const done = ok.start(['--no-status', '--ref', 'HEAD', '--jobs', 'image'])
    await done.done
    const calls = readFileSync(ok.env.CALLS as string, 'utf8')
    expect(calls).toContain('colima start')
    expect(calls).not.toContain('colima stop')
  })
})
