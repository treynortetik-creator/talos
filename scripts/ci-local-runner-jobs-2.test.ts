// The runner, part 2b: two answers for one context, the owner machine, docker, a status that could not be posted, --sha (split from ci-local-runner-jobs.test.ts so the parts run side by side; the setup below is the same).
// scripts/ci-local.sh as the self-hosted runner uses it (docs/CI-LOCAL.md, "On the self-hosted runner"): what a cancelled run leaves behind
// (nothing: no held lock, no stale container, no half-started colima, no status stuck pending), what a status says and links to,
// where the scratch goes, and a Mac that slept warning by default. The same harness as ci-local-jobs.test.ts: a local
// "origin", a fake `gh` that records the statuses it is asked to post, fake `pnpm`/`docker`/`colima`/`sysctl`.
import { type ChildProcess, execFileSync, spawn, spawnSync } from 'node:child_process'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir, userInfo } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest'
import { ciLocalSource, cleanEnv, copyCiLocalParts, systemPathWithout } from './ci-test-env'
import { fakeTool } from './fake-tool'

const here = dirname(fileURLToPath(import.meta.url))
const script = join(here, 'ci-local.sh')
vi.setConfig({ testTimeout: 60_000 })

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

describe('two answers for one context: with CI_ATTEMPT_URL, a red from any machine of the attempt stays red', () => {
  // A fake GitHub that serves the commit's full status list (newest first) from $HOME/rows and the combined status from
  // $HOME/combined, as "context, state, link, description" lines.
  const GH = `case "$1" in repo) exit 1 ;; esac
echo "$*" >> "$GH_LOG"
case "$*" in *"-X POST"*) exit 0 ;; *"/statuses?"*) cat "$HOME/rows" 2>/dev/null ;; *"/status?"*) cat "$HOME/combined" 2>/dev/null ;; esac
exit 0`
  const ATTEMPT = 'https://example.test/runs/9/attempts/1#'
  const env = { ...repoArgs, CI_ATTEMPT_URL: ATTEMPT, CI_STATUS_URL: `${ATTEMPT}lemnos` }
  const rows = (r: { home: string }, lines: string[]) => writeFileSync(join(r.home, 'rows'), `${lines.join('\n')}\n`)
  const finals = (r: { posted: () => string }, job: string) =>
    r
      .posted()
      .split('\n')
      .filter((l) => l.includes(`context=local-ci/${job} `) && !l.includes('state=pending'))

  it('a context another machine of this attempt already answered is not run, and nothing is posted for it', async () => {
    const r = repo('job_x() { touch "$HOME/ran"; }', { gh: GH })
    rows(r, [`local-ci/x\tsuccess\t${ATTEMPT}titan\tpassed on titan in 9s`])
    const run = r.start([...withStatus, '--jobs', 'x'], env)
    expect(await run.done, run.out()).toBe(0)
    expect(existsSync(join(r.home, 'ran'))).toBe(false)
    expect(r.posted()).not.toMatch(/-X POST .*context=local-ci\/x /)
    expect(run.out()).toContain('x: answered in this attempt')
  })

  // Another machine stopped mid-job (cancelled, timed out, its runner stopped) leaves `error` with its own link: that is no answer,
  // not a red. This run (Lemnos's fallback taking the job over) runs it and its result is the answer. Its own error stands.
  describe("another machine's error of this attempt is no answer; a failure is; this run's own error stands", () => {
    const comb = (r: { home: string }, lines: string[]) =>
      writeFileSync(join(r.home, 'combined'), `${lines.join('\n')}\n`)
    const stopped = `local-ci/x\terror\t${ATTEMPT}titan\trun on titan ended before this job reported (cancelled or interrupted); re-run`

    it('Titan stopped before the take-over: x runs here and its green is posted; the verdict lands', async () => {
      const r = repo('job_x() { touch "$HOME/ran"; }', { gh: GH })
      rows(r, [stopped])
      comb(r, [stopped])
      const run = r.start([...withStatus, '--jobs', 'x'], env)
      expect(await run.done, run.out()).toBe(0)
      expect(existsSync(join(r.home, 'ran'))).toBe(true)
      expect(finals(r, 'x').join('\n')).toMatch(
        /state=success .*target_url=https:\/\/example\.test\/runs\/9\/attempts\/1#lemnos/,
      )
    })

    it('Titan cancelled (an error that says "not tested:") before the take-over: x runs here, its green is posted', async () => {
      const r = repo('job_x() { touch "$HOME/ran"; }', { gh: GH })
      const cancelled = `local-ci/x\terror\t${ATTEMPT}titan\tnot tested: run cancelled before this job reported (on titan); re-run`
      rows(r, [cancelled])
      comb(r, [cancelled])
      const run = r.start([...withStatus, '--jobs', 'x'], env)
      expect(await run.done, run.out()).toBe(0)
      expect(existsSync(join(r.home, 'ran'))).toBe(true)
      expect(finals(r, 'x').join('\n')).toMatch(
        /state=success .*description=passed on .*target_url=https:\/\/example\.test\/runs\/9\/attempts\/1#lemnos/,
      )
    })

    it("Titan's error lands after this run's pending (it was stopped during the take-over): the green is still posted", async () => {
      const r = repo('job_x() { touch "$HOME/ran"; }', { gh: GH })
      const run = r.start([...withStatus, '--jobs', 'x'], env)
      await vi.waitUntil(() => existsSync(join(r.home, 'ran')), { timeout: 20_000, interval: 50 })
      rows(r, [stopped, `local-ci/x\tpending\t${ATTEMPT}lemnos\trunning on ci-runner`])
      comb(r, [stopped])
      expect(await run.done, run.out()).toBe(0)
      expect(finals(r, 'x').join('\n')).toMatch(/state=success /)
    })

    it('Titan stopped, then x fails here: the take-over is red', async () => {
      const r = repo('job_x() { return 1; }', { gh: GH })
      rows(r, [stopped])
      comb(r, [stopped])
      const run = r.start([...withStatus, '--jobs', 'x'], env)
      expect(await run.done).toBe(1)
      expect(finals(r, 'x').join('\n')).toMatch(/state=failure /)
    })

    it("Titan's failure stands: x is not run here", async () => {
      const r = repo('job_x() { touch "$HOME/ran"; }', { gh: GH })
      rows(r, [`local-ci/x\tfailure\t${ATTEMPT}titan\tfailed on titan`])
      const run = r.start([...withStatus, '--jobs', 'x'], env)
      expect(await run.done).toBe(0)
      expect(existsSync(join(r.home, 'ran'))).toBe(false)
      expect(run.out()).toContain('x: answered in this attempt (failure)')
    })

    it("this run's own error (its own link) stands: never overridden, x is not run again", async () => {
      const r = repo('job_x() { touch "$HOME/ran"; }', { gh: GH })
      rows(r, [`local-ci/x\terror\t${ATTEMPT}lemnos\trun on ci-runner ended before this job reported`])
      const run = r.start([...withStatus, '--jobs', 'x'], env)
      expect(await run.done).toBe(0)
      expect(existsSync(join(r.home, 'ran'))).toBe(false)
      expect(run.out()).toContain('x: answered in this attempt (error)')
    })
  })

  it("a pass here does not cover another machine's red of this attempt: the red is posted again, with its words", async () => {
    const r = repo('job_x() { :; }', { gh: GH })
    const run = r.start([...withStatus, '--jobs', 'x'], env)
    // the red arrives while x runs: before it starts, the attempt has nothing for x
    await vi.waitUntil(() => /state=pending .*context=local-ci\/x /.test(r.posted()), { timeout: 30_000, interval: 25 })
    rows(r, [`local-ci/x\tfailure\t${ATTEMPT}titan\tx failed on titan; see its run`])
    expect(await run.done).toBe(1)
    expect(finals(r, 'x')).toEqual([
      expect.stringMatching(/state=failure .*description=x failed on titan; see its run/),
    ])
  })

  it('a pass after another pass of this attempt posts nothing more: the first green stands', async () => {
    const r = repo('job_x() { until [ -f "$HOME/go" ]; do sleep 0.05; done; }', { gh: GH })
    const run = r.start([...withStatus, '--jobs', 'x'], env)
    await vi.waitUntil(() => /state=pending .*context=local-ci\/x /.test(r.posted()), { timeout: 30_000, interval: 25 })
    rows(r, [`local-ci/x\tsuccess\t${ATTEMPT}titan\tpassed on titan in 9s`])
    // the other green came after this run's pending, so the newest status is that green: nothing more is posted
    writeFileSync(join(r.home, 'combined'), `local-ci/x\tsuccess\t${ATTEMPT}titan\n`)
    writeFileSync(join(r.home, 'go'), '')
    expect(await run.done).toBe(0)
    expect(finals(r, 'x')).toEqual([])
  })

  it("a green of this attempt from before this run's pending: the pending is the newest, so this run still answers it", async () => {
    const r = repo('job_x() { until [ -f "$HOME/go" ]; do sleep 0.05; done; }', { gh: GH })
    const run = r.start([...withStatus, '--jobs', 'x'], env)
    await vi.waitUntil(() => /state=pending .*context=local-ci\/x /.test(r.posted()), { timeout: 30_000, interval: 25 })
    rows(r, [`local-ci/x\tpending\t${ATTEMPT}lemnos\trunning`, `local-ci/x\tsuccess\t${ATTEMPT}titan\tpassed on titan`])
    writeFileSync(join(r.home, 'combined'), `local-ci/x\tpending\t${ATTEMPT}lemnos\n`)
    writeFileSync(join(r.home, 'go'), '')
    expect(await run.done).toBe(0)
    expect(finals(r, 'x')).toEqual([expect.stringMatching(/state=success /)])
  })

  it("this attempt's statuses cannot be read at the end: never a green, the context says why", async () => {
    const r = repo('job_x() { touch "$HOME/fail-reads"; }', {
      gh: `case "$1" in repo) exit 1 ;; esac
echo "$*" >> "$GH_LOG"
case "$*" in *"-X POST"*) exit 0 ;; *"/statuses?"*) [ -f "$HOME/fail-reads" ] && exit 1; cat "$HOME/rows" 2>/dev/null ;; esac
exit 0`,
    })
    const run = r.start([...withStatus, '--jobs', 'x'], env)
    expect(await run.done).toBe(1)
    expect(finals(r, 'x')).toEqual([
      expect.stringMatching(/state=failure .*could not read this attempt's statuses; re-run/),
    ])
  })

  it("another attempt's statuses (a re-run) are not this attempt's: they are ignored", async () => {
    const r = repo('job_x() { :; }', { gh: GH })
    rows(r, ['local-ci/x\tfailure\thttps://example.test/runs/9/attempts/0#titan\tred in the first attempt'])
    const run = r.start([...withStatus, '--jobs', 'x'], env)
    expect(await run.done).toBe(0)
    expect(finals(r, 'x')).toEqual([expect.stringMatching(/state=success /)])
  })

  it('without CI_ATTEMPT_URL (one machine, as today) the list is never read', async () => {
    const r = repo('job_x() { :; }', { gh: GH })
    rows(r, [`local-ci/x\tfailure\t${ATTEMPT}titan\tred`])
    const run = r.start([...withStatus, '--jobs', 'x'], repoArgs)
    expect(await run.done).toBe(0)
    expect(r.posted()).not.toContain('/statuses?')
    expect(finals(r, 'x')).toEqual([expect.stringMatching(/state=success /)])
  })

  it("a cancel that finds this attempt's red for the context posts that red again, not an error", async () => {
    const r = repo('job_x() { sleep 120 & echo "$!" > "$HOME/child"; wait; }', { gh: GH })
    const run = r.start([...withStatus, '--jobs', 'x'], env)
    await started(join(r.home, 'child'))
    rows(r, [`local-ci/x\tpending\t${ATTEMPT}lemnos\trunning`, `local-ci/x\tfailure\t${ATTEMPT}titan\tred on titan`])
    writeFileSync(join(r.home, 'combined'), `local-ci/x\tpending\t${ATTEMPT}lemnos\n`)
    run.child.kill('SIGTERM')
    expect(await run.done).toBe(130)
    expect(finals(r, 'x')).toEqual([expect.stringMatching(/state=failure .*description=red on titan/)])
  })
})

describe("CI_OWNER_MACHINE=1: on the owner's own Mac the run refuses unless the wall around the live Talos is there", () => {
  // Every condition passing: not an admin, the owner's home, live folders and tmux folder unreadable, no claude or chronos, no
  // TMUX. Each test breaks one and expects a refusal naming it, before any slot or status.
  const ok = (r: { T: string }): Record<string, string> => {
    const owner = join(r.T, 'owner-home')
    const tmux = join(r.T, 'tmux-501')
    mkdirSync(join(owner, '.config/talos'), { recursive: true })
    mkdirSync(tmux)
    chmodSync(owner, 0o000)
    chmodSync(tmux, 0o000)
    // a PATH of the fake tools and the system's own tools only, minus any claude or chronos of this machine's (Titan has
    // /usr/bin/claude): those must not count
    const PATH = `${join(r.T, 'bin')}:${systemPathWithout(r.T, ['claude', 'chronos'])}`
    // the owner must be a user of this machine (its uid is looked up): the one running the tests stands in, its folders faked
    return { CI_OWNER_MACHINE: '1', CI_LIVE_OWNER: userInfo().username, CI_LIVE_HOME: owner, CI_LIVE_TMUX: tmux, PATH }
  }
  const restore = (env: Record<string, string>) => {
    chmodSync(env.CI_LIVE_HOME as string, 0o700)
    chmodSync(env.CI_LIVE_TMUX as string, 0o700)
  }
  const tools = (admin: boolean) => ({
    dseditgroup: admin ? 'exit 0' : 'exit 67', // checkmember: 0 is a member
  })

  it('all conditions hold: the run goes on', async () => {
    const r = repo('job_x() { :; }', tools(false))
    const env = ok(r)
    try {
      const run = r.start(['--no-status', '--ref', 'HEAD', '--jobs', 'x'], env)
      expect(await run.done, run.out()).toBe(0)
    } finally {
      restore(env)
    }
  })

  const refused = async (r: ReturnType<typeof repo>, env: Record<string, string>, reason: RegExp) => {
    try {
      const run = r.start([...withStatus, '--jobs', 'x'], { ...repoArgs, ...env })
      expect(await run.done).toBe(1)
      expect(run.out()).toMatch(reason)
      expect(r.posted()).toBe('')
    } finally {
      restore(env)
    }
  }

  it('the user is an admin', async () => {
    const r = repo('job_x() { :; }', tools(true))
    await refused(r, ok(r), /refusing on the owner's machine: this user is in the admin group/)
  })

  it("the owner's home can be listed", async () => {
    const r = repo('job_x() { :; }', tools(false))
    const env = ok(r)
    chmodSync(env.CI_LIVE_HOME as string, 0o755)
    await refused(r, env, /the owner's home .* can be listed/)
  })

  it("the owner's tmux socket folder can be listed", async () => {
    const r = repo('job_x() { :; }', tools(false))
    const env = ok(r)
    chmodSync(env.CI_LIVE_TMUX as string, 0o755)
    await refused(r, env, /the owner's tmux folder .* can be listed/)
  })

  it('claude or chronos is on PATH', async () => {
    for (const name of ['claude', 'chronos']) {
      const r = repo('job_x() { :; }', { ...tools(false), [name]: 'exit 0' })
      await refused(r, ok(r), new RegExp(`${name} is on PATH`))
    }
  })

  it('the admin check cannot answer (dseditgroup exits with an error): refused, never read as "not an admin"', async () => {
    const r = repo('job_x() { :; }', { dseditgroup: 'exit 64' })
    await refused(r, ok(r), /could not check admin membership \(dseditgroup exit 64\)/)
  })

  it('an owner who does not exist on this Mac: refused, since nothing could be checked', async () => {
    const r = repo('job_x() { :; }', tools(false))
    await refused(r, { ...ok(r), CI_LIVE_OWNER: 'nobody-here-xyz' }, /there is no user nobody-here-xyz/)
  })

  it('TMUX is set', async () => {
    const r = repo('job_x() { :; }', tools(false))
    await refused(r, { ...ok(r), TMUX: '/tmp/tmux-501/default,1,0' }, /TMUX is set/)
  })

  it('CI_LIVE_OWNER missing: refused, it cannot check the wall', async () => {
    const r = repo('job_x() { :; }', tools(false))
    const env = ok(r)
    await refused(r, { ...env, CI_LIVE_OWNER: '' }, /CI_LIVE_OWNER is not set/)
  })
})

describe('docker_up on Linux: rootless Docker is started with systemctl --user, not colima', () => {
  it('Docker down on Linux: systemctl --user start docker, then the wait; colima is never touched', async () => {
    const r = repo('job_x() { docker_up && echo up >> "$CALLS"; }', {
      uname: 'case "$1" in -s) echo Linux ;; *) /usr/bin/uname "$@" ;; esac',
      docker: 'echo "docker $*" >> "$CALLS"; [ -f "$HOME/up" ]',
      systemctl: 'echo "systemctl $*" >> "$CALLS"; touch "$HOME/up"; exit 0',
      colima: 'echo "colima $*" >> "$CALLS"; exit 0',
    })
    const run = r.start(['--no-status', '--ref', 'HEAD', '--jobs', 'x'])
    expect(await run.done, run.out()).toBe(0)
    const calls = readFileSync(r.env.CALLS as string, 'utf8')
    expect(calls).toContain('systemctl --user start docker')
    expect(calls).toContain('up')
    expect(calls).not.toContain('colima')
  })

  it('the failure line names no tool', () => {
    const text = ciLocalSource() // ci-local.sh and the parts it sources
    expect(text).toContain('docker is not running (could not start it)')
    expect(text).not.toContain('colima start failed')
  })
})

describe('a status that could not be posted says so in the log, with why', () => {
  // The job still passes: a lost final post leaves its pending, which sweep later closes as an error ("no verdict"), never a green.
  it('gh not on PATH, gh not signed in, or gh failing: "status not posted: <context> (<reason>)", and the run goes on', async () => {
    const cases: [Record<string, string>, string, RegExp][] = [
      [
        { gh: 'echo "To get started with GitHub CLI, please run:  gh auth login" >&2; exit 4' },
        'gh',
        /\(gh is not signed in\)/,
      ],
      [{ gh: 'echo "HTTP 422: Validation Failed" >&2; exit 1' }, 'gh', /\(gh exit 1: HTTP 422: Validation Failed\)/],
    ]
    for (const [tools, , reason] of cases) {
      const r = repo('job_x() { :; }', tools)
      const run = r.start([...withStatus, '--jobs', 'x'], repoArgs)
      expect(await run.done, run.out()).toBe(0)
      expect(run.out()).toMatch(new RegExp(`status not posted: local-ci/x ${reason.source}`))
    }
    // no gh at all: a PATH of the fake tools (without gh) and the system's folders
    const r = repo('job_x() { :; }')
    rmSync(join(r.T, 'bin/gh'))
    const run = r.start([...withStatus, '--jobs', 'x'], {
      ...repoArgs,
      PATH: `${join(r.T, 'bin')}:/usr/bin:/bin:/usr/sbin:/sbin`,
    })
    expect(await run.done, run.out()).toBe(0)
    expect(run.out()).toContain('status not posted: local-ci/x (no gh on PATH)')
  })
})

describe('--sha: the commit the plan fixed; a run whose PR or ref has moved on tests nothing', () => {
  it('the same commit runs as usual', async () => {
    const r = repo('job_x() { :; }')
    const sha = r.git(r.clone, 'rev-parse', 'HEAD')
    const run = r.start([...withStatus, '--jobs', 'x', '--sha', sha], repoArgs)
    expect(await run.done, run.out()).toBe(0)
    expect(r.posted()).toMatch(/state=success .*context=local-ci\/x /)
  })

  it('another commit: it says so, tests nothing, posts nothing, and exits 0', async () => {
    const r = repo('job_x() { touch "$HOME/ran"; }')
    const run = r.start([...withStatus, '--jobs', 'x', '--sha', 'b'.repeat(40)], repoArgs)
    expect(await run.done).toBe(0)
    expect(run.out()).toContain(`not the planned ${'b'.repeat(7)}`)
    expect(r.posted()).toBe('')
    expect(existsSync(join(r.home, 'ran'))).toBe(false)
  })

  it('anything but a full sha is refused', async () => {
    for (const bad of ['abc1234', 'z'.repeat(40), '']) {
      const r = repo('job_x() { :; }')
      expect(await r.start([...withStatus, '--jobs', 'x', '--sha', bad], repoArgs).done, bad).toBe(64)
    }
  })
})
