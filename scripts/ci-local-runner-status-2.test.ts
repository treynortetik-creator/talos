// The runner, part 3b: what stays inside the run, and the small cases after it (split from ci-local-runner-status.test.ts so the parts run side by side; the setup below is the same).
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
const _alive = (pid: number) => spawnSync('kill', ['-0', String(pid)]).status === 0
const started = (f: string) =>
  vi.waitUntil(() => existsSync(f) && readFileSync(f, 'utf8').trim() !== '', { timeout: 30_000, interval: 25 })

function repo(jobs = '', tools: Record<string, string> = {}) {
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
  writeFileSync(copy, readFileSync(script, 'utf8').replace('\ncd "$WT"\n', `\n${jobs}\ncd "$WT"\n`))
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

describe('what stays inside the run', () => {
  // The run's own shell holds the token (statuses): code under test never does. Setup's install and build run the commit's own
  // scripts; a job under the suites mutex runs its tests.
  it('setup (pnpm install, build) and a job under the suites mutex never see GH_TOKEN or GITHUB_TOKEN', async () => {
    const r = repo('job_check() { ci_mutex "$LOCKS" suites sh -c \'env | sort > "$HOME/suitesenv"\'; }', {
      pnpm: 'env | sort > "$HOME/pnpmenv.$1"; exit 0',
    })
    const run = r.start([...withStatus, '--jobs', 'check'], {
      ...repoArgs,
      GH_TOKEN: 'a-token',
      GITHUB_TOKEN: 'a-token',
    })
    expect(await run.done, run.out()).toBe(0)
    for (const f of ['pnpmenv.install', 'pnpmenv.build', 'suitesenv'])
      expect(readFileSync(join(r.home, f), 'utf8'), f).not.toMatch(/^(GH_TOKEN|GITHUB_TOKEN)=/m)
    expect(r.posted()).toContain('-X POST') // the run itself still posted
  })

  it('no job sees the runner settings or the token, though the run itself still uses them', async () => {
    const r = repo('job_env() { env | sort > "$HOME/jobenv"; }', {
      gh: 't=none; [ -n "$GH_TOKEN" ] && t=$GH_TOKEN; case "$1" in repo) exit 1 ;; api) echo "$* token=$t" >> "$GH_LOG" ;; esac',
    })
    const wtBase = join(r.T, 'wt-base')
    mkdirSync(wtBase)
    const run = r.start([...withStatus, '--jobs', 'env'], {
      ...repoArgs,
      CI_STATUS_WHERE: 'ci-runner',
      CI_STATUS_URL: 'https://example.test/runs/9',
      CI_SHA_FILE: join(r.T, 'sha'),
      CI_WT_BASE: wtBase,
      CI_SLEEP_GUARD: '0',
      GH_TOKEN: 'a-token',
      GITHUB_TOKEN: 'a-token',
    })
    expect(await run.done).toBe(0)
    // Every test a job starts that runs its own ci-local.sh (a fake repo, a fake gh) would otherwise post to this one's commit,
    // write this one's sha file, call itself ci-runner, and a job could post a pass for any commit with the token.
    expect(readFileSync(join(r.home, 'jobenv'), 'utf8')).not.toMatch(
      /^(CI_REPO|CI_STATUS_WHERE|CI_STATUS_URL|CI_SHA_FILE|CI_WT_BASE|CI_SLEEP_GUARD|GH_TOKEN|GITHUB_TOKEN)=/m,
    )
    // ... while the run's own statuses still carry all of it.
    expect(r.posted()).toMatch(
      /description=passed on ci-runner .*target_url=https:\/\/example.test\/runs\/9 token=a-token/,
    )
    expect(readFileSync(join(r.T, 'sha'), 'utf8').trim()).toMatch(/^[0-9a-f]{40}$/)
  })

  it('the token is out of the jobs only: the statuses of a run killed outright are still closed with it', async () => {
    const r = repo('job_long() { sleep 120 & echo "$!" > "$HOME/child"; wait; }', {
      gh: 't=none; [ -n "$GH_TOKEN" ] && t=$GH_TOKEN; case "$1" in repo) exit 1 ;; api) echo "$* token=$t" >> "$GH_LOG" ;; esac',
    })
    const run = r.start([...withStatus, '--jobs', 'long'], { ...repoArgs, GH_TOKEN: 'a-token' })
    await started(join(r.home, 'child'))
    run.child.kill('SIGKILL')
    await run.done
    await vi.waitUntil(() => r.runs().length === 0, { timeout: 20_000, interval: 50 })
    expect(r.posted()).toMatch(/state=error .*context=local-ci\/long .* token=a-token/)
  })

  it('--keep keeps the worktree, and still empties the slot temp dir', async () => {
    const r = repo('job_ok() { :; }')
    const wtBase = join(r.T, 'wt-base')
    mkdirSync(wtBase)
    const run = r.start(['--no-status', '--ref', 'HEAD', '--jobs', 'ok', '--keep'], { CI_WT_BASE: wtBase })
    expect(await run.done).toBe(0)
    expect(readdirSync(wtBase)).toHaveLength(1)
    expect(existsSync(join(r.cache, 'tmp/talos-ci-s1'))).toBe(false)
  })

  it('the slot temp dir is emptied before the slot is let go, never after: the next run may already be using it', async () => {
    // Stand in for "the next run took the slot": the first time locks are released, a new run's temp dir appears. Cleanup that wipes
    // the dir AFTER that moment deletes the live one.
    const hook = `ci_release_owned() { [ -e "$HOME/released" ] && return 0; : > "$HOME/released"; mkdir -p "$SLOT_TMP" && : > "$SLOT_TMP/next-run"; }`
    const r = repo(`job_ok() { :; }\n${hook}`)
    const run = r.start(['--no-status', '--ref', 'HEAD', '--jobs', 'ok'])
    expect(await run.done).toBe(0)
    expect(existsSync(join(r.cache, 'tmp/talos-ci-s1/next-run'))).toBe(true)
  })

  it('a scratch worktree that cannot be made stops the run with a reason, and kills nothing', async () => {
    const r = repo('job_ok() { :; }')
    const run = r.start(['--no-status', '--ref', 'HEAD', '--jobs', 'ok'], { CI_WT_BASE: join(r.T, 'no-such-dir') })
    expect(await run.done).toBe(1)
    expect(run.out()).toContain("cannot make a scratch worktree under '")
    expect(r.runs()).toEqual([])
    expect(r.locks()).toEqual([])
  })
})

describe('ci_kill_inside only ever kills what is inside a run worktree', () => {
  // The function with `lsof` and `kill` replaced: lsof lists a process whose cwd is wherever the test says, kill writes down who.
  const kills = (target: string, procCwd: string, cwd: string) => {
    const T = mkdtempSync(join(tmpdir(), 'cilk-'))
    dirs.push(T)
    const out = join(T, 'killed')
    const r = spawnSync(
      'bash',
      [
        '-c',
        `. "${script}"
lsof() { printf 'p4242\\nn%s\\n' "$PROC_CWD"; }
kill() { echo "$@" >> "$OUT"; }
ci_kill_inside "$TARGET"`,
      ],
      { cwd, env: { ...cleanEnv(), PROC_CWD: procCwd, OUT: out, TARGET: target }, encoding: 'utf8' },
    )
    expect(r.status).toBe(0)
    return existsSync(out) ? readFileSync(out, 'utf8').trim() : ''
  }
  const real = (d: string) => execFileSync('realpath', [d], { encoding: 'utf8' }).trim()

  it('an empty path is no path: it must not become the current directory', () => {
    const d = mkdtempSync(join(tmpdir(), 'cilk-d-'))
    dirs.push(d)
    expect(kills('', real(d), d)).toBe('')
  })
  it('and neither is the root: every process started from / would be a target', () => {
    expect(kills('/', '/', '/tmp')).toBe('')
  })
  it('a path that is not there kills nothing', () => {
    expect(kills('/no/such/worktree', '/no/such/worktree', '/tmp')).toBe('')
  })
  it('a real worktree: its processes, and only they', () => {
    const d = mkdtempSync(join(tmpdir(), 'cilk-wt-'))
    dirs.push(d)
    expect(kills(d, `${real(d)}/apps/web`, '/tmp')).toBe('-KILL 4242')
    expect(kills(d, '/elsewhere', '/tmp')).toBe('')
  })
})

describe('a status that someone else answered is not overwritten by a dead run', () => {
  it('closes only the pending ones that still carry its own link', async () => {
    // GET answers with what GitHub holds now; the POSTs are what the dead run does about it.
    const gh = `case "$1" in repo) exit 1 ;; api) case "$*" in *"-X POST"*) echo "$*" >> "$GH_LOG" ;; *) cat "$HOME/rows" ;; esac ;; esac`
    const r = repo('', { gh })
    const url = 'https://example.test/runs/3'
    const sha = 'c'.repeat(40)
    const rows = [
      `local-ci/ours\tpending\t${url}`, // still the pending one this run posted: closed
      `local-ci/passed-elsewhere\tsuccess\t`, // the owner's Mac passed it since: left alone
      `local-ci/failed-elsewhere\tfailure\t${url}`, // answered, even with our link: left alone
      `local-ci/newer-run\tpending\thttps://example.test/runs/4`, // a newer run's pending: left alone
      `ci/unrelated\tpending\t${url}`,
    ]
    writeFileSync(join(r.home, 'rows'), `${rows.join('\n')}\n`)
    const rec = join(r.cache, 'runs/dead-run')
    mkdirSync(join(rec, 'reported'), { recursive: true })
    writeFileSync(join(rec, 'owner'), '999999\nlong ago\nnonce-1')
    writeFileSync(
      join(rec, 'posted'),
      `owner/repo\tci-runner\t${url}\n${['ours', 'passed-elsewhere', 'failed-elsewhere', 'newer-run', 'unlisted'].map((j) => `${sha}\t${j}`).join('\n')}\n`,
    )
    const reap = r.start(['--reap'])
    expect(await reap.done).toBe(0)
    const p = r.posted()
    expect(p).toMatch(/state=error .*context=local-ci\/ours /)
    expect(p).not.toContain('passed-elsewhere')
    expect(p).not.toContain('failed-elsewhere')
    expect(p).not.toContain('newer-run')
    // GitHub shows nothing for a job we posted: it can't be told apart from a failed read, and a status left pending is worse.
    expect(p).toMatch(/state=error .*context=local-ci\/unlisted /)
    expect(existsSync(rec)).toBe(false)
  })
})

describe('colima is not the runner job', () => {
  // colima is the Mac's way; on Linux (Titan) docker_up starts the user's rootless Docker instead. So the machine is told which
  // it is: on a Linux box this test used to take the Linux branch, never start colima, and wait out docker info for 60 s.
  const docker = `echo "docker $*" >> "$CALLS"; case "$1" in info) [ -f "$HOME/up" ]; exit ;; build) cat > /dev/null; exit 1 ;; *) exit 0 ;; esac`
  const colima =
    't=unset; [ -n "$RUNNER_TRACKING_ID" ] && t=$RUNNER_TRACKING_ID; echo "colima $* tracking=$t" >> "$CALLS"; touch "$HOME/up"; exit 0'
  const uname = (os: string) => `case "$1" in -s) echo ${os} ;; *) PATH=/usr/bin:/bin exec uname "$@" ;; esac`
  it("starts without the runner's tracking id, so the runner's orphan cleanup at the end of the job leaves the VM up", async () => {
    const r = repo('', { docker, colima, uname: uname('Darwin') })
    const run = r.start(['--no-status', '--ref', 'HEAD', '--jobs', 'image'], { RUNNER_TRACKING_ID: 'github_123' })
    await run.done
    expect(readFileSync(r.env.CALLS as string, 'utf8')).toContain('colima start tracking=unset')
  })
  it('on Linux: the user’s own Docker service is started, never colima', async () => {
    const r = repo('', {
      docker,
      colima,
      uname: uname('Linux'),
      systemctl: 'echo "systemctl $*" >> "$CALLS"; touch "$HOME/up"; exit 0',
    })
    const run = r.start(['--no-status', '--ref', 'HEAD', '--jobs', 'image'])
    await run.done
    const calls = readFileSync(r.env.CALLS as string, 'utf8')
    expect(calls).toContain('systemctl --user start docker')
    expect(calls).not.toContain('colima')
  })
})

describe('a job that warned', () => {
  it('passes, and its result line and status say so; a quiet job says nothing', async () => {
    const r = repo(
      'job_warned() { warn_step warned "$1" "the sample step found something" false; }\njob_quiet() { warn_step quiet "$1" "never" true; }',
    )
    const run = r.start([...withStatus, '--jobs', 'warned,quiet'], repoArgs)
    expect(await run.done).toBe(0)
    expect(run.out()).toContain('! warning: the sample step found something (exit 1: false)')
    expect(r.posted()).toMatch(
      /state=success .*context=local-ci\/warned .*description=passed on .*, with warnings \(see its log\)/,
    )
    expect(r.posted()).not.toMatch(/context=local-ci\/quiet .*description=passed on .*with warnings/)
  })
})

describe("the browser job's environment has no proxy, and localhost is never sent through one", () => {
  const PROXIES = ['http_proxy', 'https_proxy', 'all_proxy', 'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY']
  it('ci_browser_env clears every proxy variable and sets NO_PROXY for localhost and 127.0.0.1', async () => {
    const r = repo('job_x() { ci_browser_env; env > "$HOME/env"; }')
    const proxies = Object.fromEntries(PROXIES.map((v) => [v, 'http://proxy.example.com:3128']))
    const run = r.start([...withStatus, '--jobs', 'x'], { ...repoArgs, ...proxies, NO_PROXY: 'example.com' })
    expect(await run.done, run.out()).toBe(0)
    const env = readFileSync(join(r.home, 'env'), 'utf8').split('\n')
    for (const v of PROXIES)
      expect(
        env.filter((l) => l.startsWith(`${v}=`)),
        v,
      ).toEqual([])
    expect(env).toContain('NO_PROXY=localhost,127.0.0.1')
    expect(env).toContain('no_proxy=localhost,127.0.0.1')
  })

  it('job_browser calls it after the browser download, which may need a proxy, and before any test runs', () => {
    const text = readFileSync(join(dirname(script), 'ci-local/jobs-mod-browser.sh'), 'utf8') // job_browser is there
    const fn = (name: string) =>
      text.slice(text.indexOf(`${name}() {`), text.indexOf('\n}\n', text.indexOf(`${name}() {`)))
    // browser_ready (both browser jobs' first steps): the download, then the proxy taken out
    const ready = fn('browser_ready')
    expect(ready.indexOf('playwright install')).toBeGreaterThan(-1)
    expect(ready.indexOf('ci_browser_env')).toBeGreaterThan(ready.indexOf('playwright install'))
    const job = fn('job_browser')
    expect(job.indexOf('browser_ready')).toBeGreaterThan(-1)
    expect(job.indexOf('browser_ready')).toBeLessThan(job.indexOf('test:browser'))
    expect(job.indexOf('browser_ready')).toBeLessThan(job.indexOf('mic_preflight'))
  })
})

describe('a test that passed on retry', () => {
  // A job's test runners append "<test>\t<file>" to CI_FLAKE_FILE for each test that failed once and passed when run again.
  const jobs = `job_flaky() { printf 'flips once\\tsrc/a.test.ts\\n' >> "$CI_FLAKE_FILE"; }
job_steady() { :; }
job_redflaky() { printf 'flips too\\tsrc/b.test.ts\\n' >> "$CI_FLAKE_FILE"; return 1; }`
  const flakes = (r: { cache: string }) => {
    const f = join(r.cache, 'logs/flakes.tsv')
    return existsSync(f) ? readFileSync(f, 'utf8').trim().split('\n').filter(Boolean) : []
  }

  it('passes, says "passed on retry" in its status and result line, and the test goes to flakes.tsv and the job log', async () => {
    const r = repo(jobs)
    const run = r.start([...withStatus, '--jobs', 'flaky,steady'], repoArgs)
    expect(await run.done, run.out()).toBe(0)
    expect(r.posted()).toMatch(
      /state=success .*context=local-ci\/flaky .*description=passed on \S+ in \d+s, passed on retry \(1 flaky test, see flakes\.tsv\)/,
    )
    expect(r.posted()).not.toMatch(/context=local-ci\/steady .*passed on retry/)
    expect(run.out()).toContain('! flaky: passed on retry: flips once (src/a.test.ts)')
    const sha = r.git(r.clone, 'rev-parse', 'HEAD')
    const rows = flakes(r)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatch(
      new RegExp(`^\\d{4}-\\d\\d-\\d\\dT[\\d:]+Z\\t${sha}\\tflaky\\tflips once\\tsrc/a\\.test\\.ts$`),
    )
    const log = readFileSync(join(r.cache, `logs/${sha.slice(0, 7)}-flaky.log`), 'utf8')
    expect(log).toContain('passed on retry: flips once (src/a.test.ts)')
  })

  it('a job that failed is still red, and a test that passed on retry in it is still logged as a flake', async () => {
    const r = repo(jobs)
    const run = r.start([...withStatus, '--jobs', 'redflaky'], repoArgs)
    expect(await run.done).toBe(1)
    expect(r.posted()).toMatch(/state=failure .*context=local-ci\/redflaky/)
    expect(flakes(r)).toEqual([expect.stringMatching(/\tredflaky\tflips too\tsrc\/b\.test\.ts$/)])
  })

  it("each job gets its own flake file, emptied at its start, so one job's flake is never another's", async () => {
    const r = repo(`${jobs}\njob_peek() { [ -n "$CI_FLAKE_FILE" ] && [ ! -s "$CI_FLAKE_FILE" ]; }`)
    const run = r.start([...withStatus, '--jobs', 'flaky,peek'], { ...repoArgs, CI_SLOTS: '1' })
    expect(await run.done, run.out()).toBe(0)
    expect(r.posted()).not.toMatch(/context=local-ci\/peek .*passed on retry/)
  })
})

describe('a Mac that slept warns by default, and CI_SLEEP_GUARD=1 stops it reporting a pass', () => {
  const WAKE_AFTER = (offset: number) =>
    `if [ "$2" = kern.waketime ]; then echo "{ sec = $(( $(date +%s) + (${offset}) )), usec = 7 }"; exit 0; fi; exec /usr/sbin/sysctl "$@"`
  const ok = 'job_ok() { :; }'

  it('a job that finished green after a wake during the run still passes, with a warning', async () => {
    const r = repo(ok, { sysctl: WAKE_AFTER(+60) }) // "woke" a minute after the run began
    const run = r.start([...withStatus, '--jobs', 'ok'], repoArgs)
    expect(await run.done).toBe(0)
    expect(run.out()).toContain('! warning: the Mac slept during this run')
    expect(r.posted()).toMatch(/state=success .*context=local-ci\/ok .*with warnings/)
    expect(r.posted()).not.toContain('state=error')
  })

  it('with CI_SLEEP_GUARD=1 that job is an error, not a success; the run fails', async () => {
    const r = repo(ok, { sysctl: WAKE_AFTER(+60) })
    const run = r.start([...withStatus, '--jobs', 'ok'], { ...repoArgs, CI_SLEEP_GUARD: '1' })
    expect(await run.done).toBe(1)
    const p = r.posted()
    expect(p).toMatch(/state=error .*context=local-ci\/ok .*the Mac slept during the run/)
    expect(p).not.toContain('state=success')
    expect(run.out()).toContain('FAILED: ok')
  })

  it('a wake from before the run began, or no sleep at all, changes nothing', async () => {
    const r = repo(ok, { sysctl: WAKE_AFTER(-600) })
    expect(await r.start([...withStatus, '--jobs', 'ok'], { ...repoArgs, CI_SLEEP_GUARD: '1' }).done).toBe(0)
    expect(r.posted()).toContain('state=success')
    const never = repo(ok, {
      sysctl: 'if [ "$2" = kern.waketime ]; then echo "{ sec = 0, usec = 7 }"; exit 0; fi; exec /usr/sbin/sysctl "$@"',
    })
    expect(await never.start([...withStatus, '--jobs', 'ok'], { ...repoArgs, CI_SLEEP_GUARD: '1' }).done).toBe(0)
    expect(never.posted()).not.toContain('with warnings')
  })

  // macOS only: Linux has no kern.waketime, and ci-local.sh deliberately counts an unreadable wake time as slept only on a Mac
  it.skipIf(process.platform !== 'darwin')(
    'a Mac whose wake time cannot be read counts as slept: a warning by default, a failure with CI_SLEEP_GUARD=1',
    async () => {
      const blind = { sysctl: 'if [ "$2" = kern.waketime ]; then exit 1; fi; exec /usr/sbin/sysctl "$@"' }
      const r = repo(ok, blind)
      expect(await r.start([...withStatus, '--jobs', 'ok'], { ...repoArgs, CI_SLEEP_GUARD: '1' }).done).toBe(1)
      const off = repo(ok, blind)
      expect(await off.start([...withStatus, '--jobs', 'ok'], repoArgs).done).toBe(0)
      expect(off.posted()).toContain('with warnings')
    },
  )

  it('a skipped job does not depend on the Mac being awake', async () => {
    const r = repo('job_skip() { SKIPPED+=(skip); SKIP_WHY="no changes"; return 0; }', { sysctl: WAKE_AFTER(+60) })
    expect(await r.start([...withStatus, '--jobs', 'skip'], { ...repoArgs, CI_SLEEP_GUARD: '1' }).done).toBe(0)
    expect(r.posted()).toContain('skipped (no changes)')
  })

  it('ci_slept_since: strictly after the moment asked about', () => {
    const t = (offset: number, since: number) =>
      spawnSync('bash', ['-c', `. "${script}"; ci_slept_since ${since}`], {
        env: {
          ...cleanEnv(),
          PATH: `${repo('', { sysctl: `if [ "$2" = kern.waketime ]; then echo "{ sec = ${offset}, usec = 7 }"; exit 0; fi; exec /usr/sbin/sysctl "$@"` }).T}/bin:${process.env.PATH}`,
        },
      }).status
    expect(t(1000, 999)).toBe(0) // woke after: slept
    expect(t(1000, 1000)).toBe(1) // woke at the same second: not after
    expect(t(1000, 2000)).toBe(1)
  })
})
