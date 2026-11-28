// scripts/ci-local.sh inside one run: the jobs go side by side after one shared install and build. A local "origin", a fake
// `gh` that records statuses, and fake `pnpm` and `bun` that write down what they were asked to run, so these tests prove
// the order of events and that every gate is still a gate, without running any of the real suites.
import { type ChildProcess, execFileSync, spawn, spawnSync } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest'
import { t as scaled } from '../packages/testkit/src/time-factor.ts'
import { cleanEnv, copyCiLocalParts } from './ci-test-env'
import { fakeTool } from './fake-tool'
import { fixtureGitEnv, harnessBin, harnessEnv, withoutInherited } from './harness-path'
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
  tool('bun', `[ "$1" = --version ] && { echo 1.4.4; exit 0; }\n${fake('bun')}`) // a version question is not a call
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
  /** more shell code in the copy, beside the job functions (an override of a lock, say) */
  const inject = (code: string) =>
    writeFileSync(copy, readFileSync(copy, 'utf8').replace('\ncd "$WT"\n', `\n${code}\ncd "$WT"\n`))
  return {
    T,
    home,
    clone,
    git,
    start,
    log,
    env,
    inject,
    calledLines: () => readFileSync(calls, 'utf8').trim().split('\n'),
    allowRefused: () => {
      sandbox.allowed = true // this test expects a refusing stub to be called
    },
  }
}
const noStatus = ['--ref', 'HEAD', '--no-status']

// Titan's runner hung 4 h 23 m in `git fetch -q origin`: no credential, so git waited on a prompt for ever. A fake git that, for
// a fetch, asks the way git does (a terminal prompt, or a helper reading stdin) or never answers; everything else is real git.
const realGit = spawnSync('bash', ['-c', 'command -v git'], { encoding: 'utf8' }).stdout.trim()
const askingGit = `real=${realGit}
sub="" i=1
while [ $i -le $# ]; do a="\${!i}"; case "$a" in -C | -c) i=$((i + 2)) ;; -*) i=$((i + 1)) ;; *) sub="$a"; break ;; esac; done
case "$sub:\${GIT_FAKE_NET:-}" in
  fetch:prompt | ls-remote:prompt)
    [ "\${GIT_TERMINAL_PROMPT:-}" != 0 ] || { echo "fatal: could not read Username for 'https://github.com': terminal prompts disabled" >&2; exit 128; }
    read -r _ ; exit 128 ;;
  fetch:stdin | ls-remote:stdin) read -r _ ; exit 128 ;;
  fetch:hang | ls-remote:hang) exec sleep 300 ;;
  # stops on TERM only after a while (slow cleanup), or never; has a child; leaves a lock file of the call behind
  fetch:slow-term | ls-remote:slow-term | fetch:no-term | ls-remote:no-term)
    : > "$GIT_FAKE_LOCK"
    # the trap first: the child then ignores TERM too, so only a KILL of the whole group stops it
    if [ "\${GIT_FAKE_NET}" = slow-term ]; then trap 'echo term > "$GIT_FAKE_PIDS.term"; sleep 2; exit 143' TERM; else trap '' TERM; fi
    sleep 300 &
    echo "$$ $!" > "$GIT_FAKE_PIDS"
    ${waitForFile('$GIT_FAKE_LOCK.never', { step: 1 })} ;;
esac
exec "$real" "$@"`

// a job's log before the job has written it reads as empty
const tryLog = (read: () => string) => {
  try {
    return read()
  } catch {
    return ''
  }
}

describe('ci-local.sh: git never waits for a person', () => {
  it.each(['prompt', 'stdin', 'hang'])(
    'a fetch that would %s: the run goes on, and says which remote and why',
    async (how) => {
      const r = repo('job_x() { :; }', { git: askingGit })
      const run = r.start([...noStatus, '--ref', 'HEAD', '--jobs', 'x'], { GIT_FAKE_NET: how, CI_GIT_LIMIT: '2' })
      const code = await Promise.race([run.done, new Promise<string>((res) => setTimeout(() => res('hung'), 45_000))])
      expect(code, run.out()).toBe(0)
      // the remote it could not reach, and the likely reason
      expect(run.out()).toMatch(/ci-local: git fetch of \S*origin\.git (stopped after 2s|failed)/)
      expect(run.out()).toContain('no credential?')
      if (how === 'hang') expect(run.out()).toContain('stopped after 2s')
    },
  )

  it.each(['slow-term', 'no-term'])(
    'a fetch stopped at the limit (%s): its whole process group goes, TERM first; a lock it left is named, not removed',
    async (how) => {
      const r = repo('job_x() { :; }', { git: askingGit })
      const pids = join(r.T, 'git.pids')
      const lock = join(r.clone, '.git', 'FETCH_HEAD.lock')
      const run = r.start([...noStatus, '--ref', 'HEAD', '--jobs', 'x'], {
        GIT_FAKE_NET: how,
        GIT_FAKE_PIDS: pids,
        GIT_FAKE_LOCK: lock,
        CI_GIT_LIMIT: '2',
      })
      const code = await Promise.race([run.done, new Promise<string>((res) => setTimeout(() => res('hung'), 45_000))])
      expect(code, run.out()).toBe(0)
      // nothing of that git survives the call: not the git, not its child
      const [gitPid, childPid] = readFileSync(pids, 'utf8').trim().split(' ').map(Number) as [number, number]
      const alive = (p: number) => {
        try {
          process.kill(p, 0)
          return true
        } catch {
          return false
        }
      }
      expect(alive(gitPid), 'git').toBe(false)
      expect(alive(childPid), 'its child').toBe(false)
      expect(run.out()).toContain('stopped after 2s')
      // TERM came first: the one that stops on TERM saw it
      if (how === 'slow-term') expect(existsSync(`${pids}.term`)).toBe(true)
      // the lock it left: named, still there (it may not be ours to remove)
      expect(run.out()).toMatch(/it left \S*\.git\/FETCH_HEAD\.lock \(not removed/)
      expect(existsSync(lock)).toBe(true)
    },
  )

  it('a remote link with a token in it is never printed', async () => {
    const r = repo('job_x() { :; }', { git: askingGit })
    execFileSync(realGit, [
      '-C',
      r.clone,
      'remote',
      'set-url',
      'origin',
      'https://x-access-token:SECRET123@example.com/o/r.git',
    ])
    const run = r.start([...noStatus, '--ref', 'HEAD', '--jobs', 'x'], { GIT_FAKE_NET: 'prompt', CI_GIT_LIMIT: '2' })
    await run.done
    expect(run.out()).toContain('https://example.com/o/r.git')
    expect(run.out()).not.toContain('SECRET123')
  })
})

describe('ci-local.sh and the parts it sources (scripts/ci-local/)', () => {
  it('a copy without its scripts/ci-local/ folder stops at once with exit 64 and says why: nothing run, posted or recorded', async () => {
    const r = repo('job_x() { touch "$HOME/ran"; }')
    rmSync(join(r.clone, 'scripts', 'ci-local'), { recursive: true, force: true })
    const run = r.start(['--ref', 'HEAD', '--jobs', 'x'])
    expect(await run.done).toBe(64)
    expect(run.out()).toContain('ci-local.sh needs the scripts/ci-local/ folder beside it')
    expect(existsSync(join(r.home, 'ran'))).toBe(false)
    expect(existsSync(r.env.GH_LOG)).toBe(false)
    expect(existsSync(join(r.home, '.cache/talos-ci/runs'))).toBe(false)
  })

  // A run can wait an hour for a slot or for its commit. A checkout pulled meanwhile (a hand run from a builder's own tree) must
  // not hand it newer job code: every part is read before any wait.
  it('a part changed while the run waits for its slot is not used: the run keeps the version it started with', async () => {
    // at most 60 s, so a failed test cannot leave the loop running for ever
    const r = repo(
      'job_hold() { touch "$HOME/holding"; for _ in $(seq 600); do [ -f "$HOME/go" ] && break; sleep 0.1; done; }',
    )
    const part = join(r.clone, 'scripts/ci-local/jobs-image.sh')
    writeFileSync(part, `${readFileSync(part, 'utf8')}job_probe() { echo original > "$HOME/probe"; }\n`)
    const a = r.start([...noStatus, '--jobs', 'hold'], { CI_SLOTS: '1' })
    await vi.waitUntil(() => existsSync(join(r.home, 'holding')), { timeout: 30_000, interval: 50 })
    const b = r.start([...noStatus, '--jobs', 'probe'], { CI_SLOTS: '1' })
    await vi.waitUntil(() => b.out().includes('waiting for a free slot'), { timeout: 30_000, interval: 50 })
    writeFileSync(part, readFileSync(part, 'utf8').replace('echo original', 'echo swapped'))
    writeFileSync(join(r.home, 'go'), '')
    expect(await a.done).toBe(0)
    expect(await b.done, b.out()).toBe(0)
    expect(readFileSync(join(r.home, 'probe'), 'utf8').trim()).toBe('original')
  })

  it('a part that does not parse stops it at once too (exit 64), not half-way through a run', async () => {
    const r = repo('job_x() { touch "$HOME/ran"; }')
    writeFileSync(join(r.clone, 'scripts/ci-local/jobs-image.sh'), 'job_image() {\n  if then\n')
    const run = r.start(['--ref', 'HEAD', '--jobs', 'x'])
    expect(await run.done).toBe(64)
    expect(run.out()).toContain('jobs-image.sh does not parse')
    expect(existsSync(join(r.home, 'ran'))).toBe(false)
    expect(existsSync(r.env.GH_LOG)).toBe(false)
  })
})

describe('ci-local.sh jobs in a run', () => {
  it('runs jobs at the same time: each of these two only finishes if the other has started', async () => {
    const r = repo(`
job_one() { touch "$HOME/one"; for i in $(seq 1 400); do [ -f "$HOME/two" ] && return 0; sleep 0.05; done; return 1; }
job_two() { touch "$HOME/two"; for i in $(seq 1 400); do [ -f "$HOME/one" ] && return 0; sleep 0.05; done; return 1; }`)
    const run = r.start([...noStatus, '--jobs', 'one,two'])
    expect(await run.done).toBe(0)
    expect(run.out()).toContain('✓ one')
    expect(run.out()).toContain('✓ two')
    expect(run.out()).toContain('ci-local: all green')
    expect(run.out()).toMatch(/ci-local: timing: waited \d+s, setup \d+s, jobs \d+s/)
    expect(readFileSync(join(r.home, '.cache/talos-ci/logs/timings.tsv'), 'utf8')).toContain('one,two')
  })

  it("a job's time waiting for another job is told apart from its own steps, in the result line and in timings.tsv", async () => {
    // two waits for one (as browser waits for check): its wall time is mostly the wait
    const r = repo(`
job_one() { sleep 3; }
job_two() { wait_for_job one; sleep 1; }
job_three() { sleep 1; }`)
    const run = r.start([...noStatus, '--jobs', 'one,two,three'])
    expect(await run.done).toBe(0)
    const line = /✓ two \((\d+)s: (\d+)s of its own steps, (\d+)s waiting for another job\)/.exec(run.out())
    expect(line, run.out()).not.toBeNull()
    const [wall, steps, waited] = (line as RegExpExecArray).slice(1).map(Number) as [number, number, number]
    expect(wall).toBe(steps + waited)
    expect(waited).toBeGreaterThanOrEqual(2)
    expect(steps).toBeLessThanOrEqual(3) // a 1 s sleep, plus whole-second rounding of the wall time and of the wait
    // a job that waited for nothing keeps its plain line
    expect(run.out()).toMatch(/✓ three \(\d+s\)\n/)
    // timings.tsv: a ninth column, each job's wall/steps seconds; the first eight are as before. A tenth, appended: the desktop
    // job's pty peak and limit, "-" for a run without it (older rows keep nine and read the same). An eleventh: the run's bun. A twelfth:
    // the seconds of Chronos's suite inside check, "chronos=-" for a run that did not have it. A thirteenth: the steps taken from the
    // gate's result (reuse_gate_step), "reused=-" for a run that took none.
    const row = readFileSync(join(r.home, '.cache/talos-ci/logs/timings.tsv'), 'utf8')
      .trim()
      .split('\n')
      .pop() as string
    const cols = row.split('\t')
    expect(cols).toHaveLength(13)
    expect(cols[9]).toBe('-')
    expect(cols[10]).toBe('bun=1.4.4')
    expect(cols[11]).toBe('chronos=-')
    expect(cols[12]).toBe('reused=-')
    // and each job's log says first which bun it runs, and from where
    expect(r.log('two').split('\n')[0]).toBe(`bun: 1.4.4 (${join(r.T, 'bin')}/bun)`)
    expect(cols[3]).toBe('one,two,three')
    const per = Object.fromEntries((cols[8] as string).split(',').map((p) => p.split('=')))
    expect(Object.keys(per).sort()).toEqual(['one', 'three', 'two'])
    expect(per.two).toBe(`${wall}/${steps}`)
    const [oneWall, oneSteps] = (per.one as string).split('/').map(Number)
    expect(oneWall).toBe(oneSteps)
  })

  // Phase B: with CI_TITAN_IMAGE=on Titan posts local-ci/image, so Lemnos leaves image out: not run, nothing posted for it. The
  // rest is a default run (no --jobs), so its skips are planned as before.
  it("CI_REMOTE_JOBS=image: image is another machine's; it is neither run nor posted here, everything else is", async () => {
    const stubs = ['check', 'mod', 'browser', 'image', 'desktop', 'mobile']
      // a child process, as a job's tests are: it sees only what is exported
      .map((j) => `job_${j}() { echo "${j} [$(bash -c 'echo "\${CI_REMOTE_JOBS:-}"')]" >> "$HOME/ran"; }`)
      .join('\n')
    const r = repo(stubs)
    const run = r.start(['--ref', 'HEAD'], { CI_REMOTE_JOBS: 'image' })
    expect(await run.done, run.out()).toBe(0)
    const ran = readFileSync(join(r.home, 'ran'), 'utf8').trim().split('\n').sort()
    // and the jobs that do run never see it (it is this script's, not theirs)
    expect(ran).toEqual(['browser []', 'check []', 'desktop []', 'mobile []', 'mod []'])
    const posted = readFileSync(r.env.GH_LOG, 'utf8')
    expect(posted).not.toContain('context=local-ci/image')
    for (const j of ['check', 'mod', 'browser', 'desktop', 'mobile'])
      expect(posted, j).toContain(`context=local-ci/${j} `)
    expect(run.out()).toContain('image runs on another machine')
    // a job that is not one of the six is refused, not ignored
    const bad = repo(stubs).start(['--ref', 'HEAD', '--no-status'], { CI_REMOTE_JOBS: 'imag' })
    expect(await bad.done).toBe(64)
  })

  it('a failing job fails the run, the others still finish, and each result is posted on its own', async () => {
    const r = repo(`
job_bad() { echo "the reason" >> "$1"; return 1; }
job_slow() { sleep 1; touch "$HOME/slow-finished"; }`)
    const run = r.start(['--ref', 'HEAD', '--jobs', 'bad,slow'])
    expect(await run.done).toBe(1)
    expect(existsSync(join(r.home, 'slow-finished'))).toBe(true)
    expect(run.out()).toContain('✗ bad')
    expect(run.out()).toContain('the reason')
    expect(run.out()).toContain('ci-local: FAILED: bad')
    const posted = readFileSync(r.env.GH_LOG, 'utf8')
    expect(posted).toMatch(/state=failure .*context=local-ci\/bad/)
    expect(posted).toMatch(/state=success .*context=local-ci\/slow/)
  })

  // ci-runner.sh fallback runs a job another machine did not answer, and says why in the job's status (docs/CI-MACHINES.md,
  // "Status names and texts"): an owner reading it sees why Lemnos answered
  it('a job taken over for another machine (CI_FALLBACK_NOTES) ends its status with why, passed or failed', async () => {
    const r = repo(`
job_bad() { echo "the reason" >> "$1"; return 1; }
job_slow() { :; }
job_plain() { :; }`)
    const run = r.start(['--ref', 'HEAD', '--jobs', 'bad,slow,plain'], {
      CI_FALLBACK_NOTES: 'bad=titan errored;slow=titan did not answer',
    })
    expect(await run.done).toBe(1)
    const posts = readFileSync(r.env.GH_LOG, 'utf8')
      .split('\n')
      .filter((l) => l.includes('-X POST') && !l.includes('state=pending'))
    const of = (j: string) => posts.find((l) => l.includes(`context=local-ci/${j} `)) ?? ''
    expect(of('slow')).toMatch(/state=success .*description=passed on \S+ in \d+s \(fallback: titan did not answer\)$/)
    expect(of('bad')).toMatch(/state=failure .*description=failed on \S+; see .*\(fallback: titan errored\)$/)
    expect(of('plain')).toMatch(/state=success /)
    expect(of('plain')).not.toContain('fallback')
    // a malformed note is refused before anything runs
    for (const bad of ['image=Titan!', 'image', '=titan errored', 'image=titan errored;'])
      expect(await repo('').start([...noStatus, '--jobs', 'plain'], { CI_FALLBACK_NOTES: bad }).done, bad).toBe(64)
  })

  // A Titan part that fails is Linux's red (owner, 11-25: Mac first): Titan says "not tested" and reports the red to report-ci/, and
  // the Mac, which takes the job over, is the one that decides. Shown with the image job (a stub: no Docker here).
  describe("a Titan image that fails: the Mac's own run decides", () => {
    const A = 'https://example.test/runs/9/attempts/1#'
    const titan = {
      CI_STATUS_PREFIX: 'local-ci',
      CI_TITAN_PART: '1',
      CI_ATTEMPT_URL: A,
      CI_STATUS_URL: `${A}titan`,
      CI_RUN_ID: '9',
    }
    const TLOG = '~/.cache/talos-ci/logs/2026-11-25/abc1234-image.log'
    const posts = (r: ReturnType<typeof repo>, ctx: string) =>
      readFileSync(r.env.GH_LOG, 'utf8')
        .split('\n')
        .filter((l) => l.includes('-X POST') && l.includes(`context=${ctx} `) && !l.includes('state=pending'))
    const rows = (...lines: string[]) => ({
      docker: 'exit 0', // the cleanup after any image run
      gh: `case "$1" in repo) echo owner/repo ;; api) echo "$*" >> "$GH_LOG"
  case "$*" in *"/statuses?"*) printf '%s\\n' ${lines.map((l) => `'${l}'`).join(' ')} ;; esac ;; esac`,
    })

    it('on Titan: a red image is "not tested" under local-ci/ and a failure under report-ci/, so the Mac takes it over', async () => {
      const r = repo('job_image() { echo "docker build failed" >> "$1"; return 1; }', { docker: 'exit 0' })
      const run = r.start(['--ref', 'HEAD', '--jobs', 'image'], titan)
      expect(await run.done, run.out()).toBe(0)
      expect(posts(r, 'local-ci/image')).toEqual([
        expect.stringMatching(
          /state=error .*description=not tested: Titan failed image, log ~\/\.cache\/talos-ci\/logs\/.*-image\.log;/,
        ),
      ])
      expect(posts(r, 'report-ci/image')).toEqual([
        expect.stringMatching(
          /state=failure .*description=Titan failed image, log ~\/\.cache\/talos-ci\/logs\/.*-image\.log/,
        ),
      ])
    })

    it('on Titan: a green image also says so under report-ci/; without CI_TITAN_PART a red stays a red', async () => {
      const r = repo('job_image() { :; }', { docker: 'exit 0' })
      expect(await r.start(['--ref', 'HEAD', '--jobs', 'image'], titan).done).toBe(0)
      expect(posts(r, 'local-ci/image')).toEqual([expect.stringMatching(/state=success /)])
      expect(posts(r, 'report-ci/image')).toEqual([expect.stringMatching(/state=success .*description=passed on /)])
      const plain = repo('job_image() { return 1; }', { docker: 'exit 0' })
      expect(await plain.start(['--ref', 'HEAD', '--jobs', 'image'], { ...titan, CI_TITAN_PART: '' }).done).toBe(1)
      expect(posts(plain, 'local-ci/image')).toEqual([expect.stringMatching(/state=failure /)])
      expect(posts(plain, 'report-ci/image')).toEqual([])
    })

    const taken = {
      CI_ATTEMPT_URL: A,
      CI_STATUS_URL: `${A}lemnos`,
      CI_RUN_ID: '9',
      CI_FALLBACK_NOTES: 'image=titan errored',
    }
    const titanRed = `local-ci/image\terror\t${A}titan\tnot tested: Titan failed image, log ${TLOG}; the Mac re-runs it`

    it('on the Mac: the take-over passes, and the status, output and log say "Titan-only failure, not counted" with the log', async () => {
      const r = repo('job_image() { :; }', rows(titanRed))
      const run = r.start(['--ref', 'HEAD', '--jobs', 'image'], taken)
      expect(await run.done, run.out()).toBe(0)
      const text = `Titan-only failure, not counted: image, log ${TLOG}`
      expect(posts(r, 'local-ci/image')).toEqual([
        expect.stringContaining(`state=success -f context=local-ci/image -f description=${text}`),
      ])
      expect(r.log('image')).toContain(text)
      expect(run.out()).toContain(text)
    })

    it('on the Mac: red here too is red, with no "not counted"; a take-over of a job Titan never failed says nothing of Titan', async () => {
      const bad = repo('job_image() { return 1; }', rows(titanRed))
      expect(await bad.start(['--ref', 'HEAD', '--jobs', 'image'], taken).done).toBe(1)
      expect(posts(bad, 'local-ci/image')).toEqual([expect.stringMatching(/state=failure /)])
      expect(posts(bad, 'local-ci/image').join('\n')).not.toContain('not counted')
      const quiet = repo(
        'job_image() { :; }',
        rows(`local-ci/image\terror\t${A}titan\trun on titan ended before this job reported`),
      )
      expect(await quiet.start(['--ref', 'HEAD', '--jobs', 'image'], taken).done).toBe(0)
      expect(posts(quiet, 'local-ci/image').join('\n')).not.toContain('Titan')
    })
  })

  it('a job killed from outside is a failure, never a pass', async () => {
    const r = repo("\njob_killed() { sh -c 'kill -KILL $PPID'; }\n")
    const run = r.start([...noStatus, '--jobs', 'killed'])
    expect(await run.done).toBe(1)
    expect(run.out()).toContain('✗ killed')
    expect(r.log('killed')).toContain('died without a result')
  })

  it('a job that does not exist is a failure, and asking twice runs a job once', async () => {
    const r = repo('\njob_once() { echo ran >> "$HOME/once"; }\n')
    const run = r.start([...noStatus, '--jobs', 'once,nope,once'])
    expect(await run.done).toBe(1)
    expect(run.out()).toContain('✗ nope')
    expect(readFileSync(join(r.home, 'once'), 'utf8').trim()).toBe('ran')
  })

  it('the two Swift jobs never overlap, whatever order they are asked for', async () => {
    const swift = (me: string) =>
      `job_${me}() { echo "start ${me}" >> "$HOME/swift"; sleep 0.5; echo "end ${me}" >> "$HOME/swift"; }`
    const r = repo(`\n${swift('desktop')}\n${swift('mobile')}\njob_other() { sleep 0.1; }\n`)
    expect(await r.start([...noStatus, '--jobs', 'mobile,other,desktop']).done).toBe(0)
    expect(readFileSync(join(r.home, 'swift'), 'utf8').trim().split('\n')).toEqual([
      'start mobile',
      'end mobile',
      'start desktop',
      'end desktop',
    ])
  })

  it('a cancelled run stops its jobs and what they started, and lets go of the slot', async () => {
    const r = repo(`
job_long() { sleep 120 & echo "$!" > "$HOME/grandchild"; wait; }`)
    const run = r.start([...noStatus, '--jobs', 'long'])
    const pidFile = join(r.home, 'grandchild')
    await vi.waitUntil(() => existsSync(pidFile) && readFileSync(pidFile, 'utf8').trim() !== '', {
      timeout: 30_000,
      interval: 25,
    })
    const pid = Number(readFileSync(pidFile, 'utf8'))
    run.child.kill('SIGTERM')
    expect(await run.done).toBe(130)
    expect(spawnSync('kill', ['-0', String(pid)]).status).not.toBe(0)
    expect(existsSync(join(r.home, '.cache/talos-ci/locks/slot-1'))).toBe(false)
  })
})

describe('ci-local.sh: a job cannot outlive its run', () => {
  const alive = (pid: number) => spawnSync('kill', ['-0', String(pid)]).status === 0
  const pidIn = (f: string) => Number(readFileSync(f, 'utf8'))
  const started = (f: string) =>
    vi.waitUntil(() => existsSync(f) && readFileSync(f, 'utf8').trim() !== '', { timeout: 30_000, interval: 25 })

  it('a cancelled run leaves nothing working in its worktree, even a detached server that ignores signals', async () => {
    // Like Playwright's web server: a process group of its own, so no signal to the job's group reaches it.
    const r = repo(`
job_web() { set -m; bash -c 'trap "" INT TERM HUP; exec sleep 120' & echo "$!" > "$HOME/server"; set +m; wait; }`)
    const run = r.start([...noStatus, '--jobs', 'web'])
    await started(join(r.home, 'server'))
    const server = pidIn(join(r.home, 'server'))
    expect(alive(server)).toBe(true)
    run.child.kill('SIGTERM')
    expect(await run.done).toBe(130)
    expect(alive(server)).toBe(false)
  })

  it('a run killed outright with no run after it: its watchdog stops the jobs and clears the record', async () => {
    const r = repo(`
job_long() { sleep 120 & echo "$!" > "$HOME/child"; wait; }`)
    const run = r.start([...noStatus, '--jobs', 'long'])
    await started(join(r.home, 'child'))
    const child = pidIn(join(r.home, 'child'))
    run.child.kill('SIGKILL')
    await run.done
    await vi.waitUntil(() => !alive(child), { timeout: 20_000, interval: 50 })
    const runs = join(r.home, '.cache/talos-ci/runs')
    await vi.waitUntil(() => readdirSync(runs).length === 0, { timeout: 20_000, interval: 50 })
  })

  it('a job that finished leaves no background process behind, on a green run too', async () => {
    const r = repo(`
job_leaky() { sleep 120 & echo "$!" > "$HOME/left"; }`)
    expect(await r.start([...noStatus, '--jobs', 'leaky']).done).toBe(0)
    expect(alive(pidIn(join(r.home, 'left')))).toBe(false)
  })

  it('results live with the run: the slot temp dir holds none, and nothing is left when the run ends', async () => {
    const r = repo(`
job_probe() { ls "$SLOT_TMP" > "$HOME/slot-tmp"; echo "$RESULTS" > "$HOME/results"; }`)
    expect(await r.start([...noStatus, '--jobs', 'probe']).done).toBe(0)
    expect(readFileSync(join(r.home, 'slot-tmp'), 'utf8')).not.toContain('results')
    expect(readFileSync(join(r.home, 'results'), 'utf8')).toContain('/runs/')
    expect(readdirSync(join(r.home, '.cache/talos-ci/runs'))).toEqual([])
  })
})

describe('ci-local.sh shared setup', () => {
  const browserAndCheck = [...noStatus, '--jobs', 'check,browser']

  it('installs and builds once, before any job, and the browser job does not build again', async () => {
    const r = repo()
    expect(await r.start(browserAndCheck).done).toBe(0)
    const lines = r.calledLines()
    expect(lines[0]).toContain('pnpm install --frozen-lockfile')
    expect(lines[1]).toContain('pnpm build')
    expect(lines.filter((l) => l.includes('pnpm install'))).toHaveLength(1)
    expect(lines.filter((l) => /^pnpm build/.test(l))).toHaveLength(1)
    const e2e = lines.filter((l) => l.includes('test:e2e'))
    expect(e2e).toHaveLength(1)
    expect(e2e[0]).toContain('SKIP_BUILD=1 E2E_SKIP_BUILD=1')
  })

  it('the browser job waits for the check job, and mod, image and desktop do not', async () => {
    const r = repo(`
job_check() { for i in $(seq 1 400); do [ -f "$HOME/other-ran" ] && break; sleep 0.05; done; sleep 0.3; echo "check over" >> "$CALLS"; }
job_other() { touch "$HOME/other-ran"; }`)
    expect(await r.start([...noStatus, '--jobs', 'check,browser,other']).done).toBe(0)
    const lines = r.calledLines()
    expect(lines.indexOf('check over')).toBeGreaterThanOrEqual(0)
    expect(lines.indexOf('check over')).toBeLessThan(lines.findIndex((l) => l.includes('test:browser')))
    expect(existsSync(join(r.home, 'other-ran'))).toBe(true)
  })

  it('a check job that dies does not leave the browser job waiting', async () => {
    const r = repo("\njob_check() { sh -c 'kill -KILL $PPID'; }\n")
    const run = r.start([...noStatus, '--jobs', 'check,browser'])
    expect(await run.done).toBe(1)
    expect(run.out()).toContain('✗ check')
    expect(run.out()).toContain('✓ browser')
  })

  it('a job that needs no dependencies does not pay for the install', async () => {
    const r = repo('\njob_plain() { :; }\n')
    expect(await r.start([...noStatus, '--jobs', 'plain']).done).toBe(0)
    expect(existsSync(r.env.CALLS)).toBe(false)
  })

  it("a job's temp folder and files are its owner's alone, under a runner whose default umask is 0002", async () => {
    const r = repo(`
job_perm() { job_tmp perm && mkdir "$TMPDIR/made" && : > "$TMPDIR/made/f" &&
  perl -e 'printf "%o ", (stat $_)[2] & 07777 for @ARGV' "$TMPDIR/made" "$TMPDIR/made/f" > "$HOME/modes"; }`)
    // perl's stat, not \`stat -c\` (GNU only; macOS stat has no -c), so the case runs on every CI machine
    // BASH_ENV runs before the script: the shell starts with talos-ci's runner default (systemd's user manager: 0002)
    const before = join(r.T, 'umask-0002.sh')
    writeFileSync(before, 'umask 0002\n')
    expect(await r.start([...noStatus, '--jobs', 'perm'], { BASH_ENV: before }).done).toBe(0)
    expect(readFileSync(join(r.home, 'modes'), 'utf8').trim()).toBe('755 644')
  })

  it.each([
    ['pnpm install', 'install --frozen-lockfile'],
    ['pnpm build', 'build'],
  ])('a failed %s fails every job that needed it, with the reason in its log', async (what, arg) => {
    const r = repo('\njob_plain() { :; }\n')
    const run = r.start([...noStatus, '--jobs', 'check,browser,plain'], { FAIL_ON: arg })
    expect(await run.done).toBe(1)
    expect(run.out()).toContain('✗ check')
    expect(run.out()).toContain('✗ browser')
    expect(run.out()).toContain('✓ plain')
    expect(r.log('check')).toContain(`setup failed: ${what}`)
    expect(r.calledLines().filter((l) => l.includes('test'))).toEqual([])
  })
})

describe('the parts of check that run on another machine, and the Linux report job (docs/CI-MACHINES.md)', () => {
  const PART = { CI_STATUS_PREFIX: 'ci-part' }
  /** The commit's bridge runner knows --shard (a newer runner), committed in the clone and tested from there. */
  const withShard = (r: ReturnType<typeof repo>) => {
    writeFileSync(join(r.clone, 'apps/bridge/scripts/test-parallel.ts'), '// knows --shard K/N\n')
    r.git(r.clone, 'commit', '-qam', 'runner with --shard')
  }

  it('bridge-shard-K runs its half of the rest files: --skip test/schedules/ --shard K/2, on CI_PART_JOBS processes', async () => {
    for (const k of [1, 2]) {
      const r = repo()
      withShard(r)
      const run = r.start([...noStatus, '--jobs', `bridge-shard-${k}`], { ...PART, CI_PART_JOBS: '3' })
      expect(await run.done, run.out()).toBe(0)
      const bun = r.calledLines().filter((l) => l.startsWith('bun run apps/bridge/scripts/test-parallel.ts'))
      expect(bun, String(k)).toHaveLength(1)
      expect(bun[0]).toMatch(new RegExp(`--jobs 3 .*--skip test/schedules/ --shard ${k}/2 `))
      expect(
        r.calledLines().some((l) => l.startsWith('pnpm install --frozen-lockfile')),
        'the one install',
      ).toBe(true)
    }
  })

  it('a commit whose runner has no --shard: the part runs nothing and says so (Lemnos runs every file, as before)', async () => {
    const r = repo()
    const run = r.start([...noStatus, '--jobs', 'bridge-shard-1'], PART)
    expect(await run.done, run.out()).toBe(0)
    expect(run.out()).toContain("bridge-shard-1: this commit's bridge runner has no --shard")
    expect(existsSync(join(r.T, 'calls')) ? r.calledLines().filter((l) => l.startsWith('bun ')) : []).toEqual([])
  })

  it('vitest runs the root suite on CI_PART_WORKERS workers, with no retry and the flake log of check', async () => {
    const r = repo()
    const run = r.start([...noStatus, '--jobs', 'vitest'], { ...PART, CI_PART_WORKERS: '4' })
    expect(await run.done, run.out()).toBe(0)
    const v = r.calledLines().filter((l) => l.startsWith('pnpm test '))
    expect(v).toEqual([
      expect.stringMatching(
        /^pnpm test --maxWorkers=4 .*--retry=0 --reporter=default --reporter=\S+ci-flake-vitest\.ts/,
      ),
    ])
  })

  // The WSL distro's tests (scripts/windows-distro.test.ts) are off the push lanes (owner, 11-25: Windows and Linux are back-burner,
  // Mac first): the Vitest config leaves them out unless TALOS_LINUX_LANE=1, which Titan's Linux check, Hestia's linux job, the
  // nightly and every --full run (a dispatch) set. So Lemnos's check, the gate's tests and a plain `pnpm test` do not run them.
  it('the WSL distro tests are off the push lanes: the Vitest config leaves them out, unless TALOS_LINUX_LANE=1', () => {
    const listed = (lane: string) => {
      const out = spawnSync('pnpm', ['exec', 'vitest', 'list', '--filesOnly', '--project', 'scripts'], {
        cwd: join(here, '..'),
        encoding: 'utf8',
        env: {
          ...process.env,
          VITEST: '',
          VITEST_MODE: '',
          VITEST_POOL_ID: '',
          VITEST_WORKER_ID: '',
          NODE_ENV: '',
          TALOS_LINUX_LANE: lane,
        },
      })
      expect(out.status, out.stderr).toBe(0)
      return out.stdout.split('\n').map((l) => l.replace(/^\[[^\]]*\] /, '').trim())
    }
    const push = listed('')
    expect(push).toContain('scripts/heavy-lock.test.ts') // the rest of the project is there
    expect(push).not.toContain('scripts/windows-distro.test.ts')
    expect(listed('1')).toContain('scripts/windows-distro.test.ts')
  })

  it('check runs the root suite with TALOS_LINUX_LANE on Linux (Titan), in the nightly and on --full; never on a Mac push', async () => {
    const pnpm = 'echo "pnpm $* LANE=${TALOS_LINUX_LANE:-}" >> "$CALLS"'
    const lane = async (args: string[], extra: Record<string, string>, tools: Record<string, string> = {}) => {
      const r = repo('', { pnpm, ...tools })
      const run = r.start([...noStatus, '--jobs', 'vitest', ...args], { CI_STATUS_PREFIX: 'ci-part', ...extra })
      expect(await run.done, run.out()).toBe(0)
      return r.calledLines().find((l) => l.startsWith('pnpm test ')) ?? ''
    }
    // a Mac, a push: uname is stubbed so the case means the same on any host (on Titan's Linux the real uname said Linux)
    expect(await lane([], {}, { uname: 'echo Darwin' })).toMatch(/LANE=$/)
    expect(await lane([], {}, { uname: 'echo Linux' })).toMatch(/LANE=1$/) // Titan
    expect(await lane([], { CI_NIGHTLY: '1' })).toMatch(/LANE=1$/)
    expect(await lane(['--full'], {})).toMatch(/LANE=1$/)
  })

  it('linux runs the supervisor files, the permission hook, the secret store and history-corrupt.test.ts on 2 processes, then the WSL distro’s Vitest file, under report-ci/', async () => {
    const r = repo()
    const run = r.start([...noStatus, '--jobs', 'linux'], { CI_STATUS_PREFIX: 'report-ci' })
    expect(await run.done, run.out()).toBe(0)
    const bun = r.calledLines().filter((l) => l.startsWith('bun run apps/bridge/scripts/test-parallel.ts'))
    expect(bun).toEqual([
      expect.stringMatching(/--jobs 2 .*--only test\/supervisor\/ /),
      expect.stringMatching(/--jobs 2 .*--only test\/permission-hook\.test\.ts /),
      expect.stringMatching(/--jobs 2 .*--only test\/secrets-store\.test\.ts /),
      expect.stringMatching(/--jobs 2 .*--only test\/history-corrupt\.test\.ts /),
    ])
    expect(r.calledLines().filter((l) => l.includes('vitest run'))).toEqual([
      expect.stringMatching(/vitest run --project scripts scripts\/windows-distro\.test\.ts/),
    ])
  })

  it('linux also runs the script tests that skip on macOS, picked by their own condition and named in its log; one that skipped whole fails it', async () => {
    // a pnpm that prints what the no-silent-skip reporter would, for the Linux-only file
    const pnpm = `echo "pnpm $*" >> "$CALLS"
case "$*" in *ci-no-silent-skip*)
  case "\${RAN:-all}" in
    all) echo "no-silent-skip: scripts/a-linux.test.ts: 2 of 2 ran" ;;
    one) echo "no-silent-skip: scripts/a-linux.test.ts: 1 of 2 ran" ;;
    none) ;; # the file never ran: no count line at all
  esac ;;
esac
exit 0`
    // all ran: green; one test skipped on Linux, or the file never ran: red, with the file named
    for (const [ran, why] of [
      ['all', ''],
      ['one', 'scripts/a-linux.test.ts (1 of 2 ran)'],
      ['none', 'scripts/a-linux.test.ts (no count: it never ran)'],
    ] as const) {
      const allSkipped = ran !== 'all'
      const r = repo('', { pnpm })
      // built in two pieces: the Linux job's own grep must not pick this file for the line itself
      const linuxOnly = 'it.runIf(process.platform === ' + "'linux')('x', () => {})\n"
      writeFileSync(join(r.clone, 'scripts/a-linux.test.ts'), linuxOnly)
      writeFileSync(join(r.clone, 'scripts/b-mac.test.ts'), "it.skipIf(process.platform !== 'darwin')('y', () => {})\n")
      r.git(r.clone, 'add', 'scripts/a-linux.test.ts', 'scripts/b-mac.test.ts')
      r.git(r.clone, 'commit', '-qm', 'two script tests')
      const run = r.start([...noStatus, '--jobs', 'linux'], {
        CI_STATUS_PREFIX: 'report-ci',
        RAN: ran,
      })
      expect(await run.done, run.out()).toBe(allSkipped ? 1 : 0)
      const vitest = r.calledLines().filter((l) => l.includes('vitest run'))
      expect(vitest[1]).toMatch(
        /vitest run --project scripts scripts\/a-linux\.test\.ts +--retry=0 --reporter=default --reporter=\S+ci-no-silent-skip\.ts/,
      )
      expect(vitest.join('\n')).not.toContain('b-mac')
      expect(r.log('linux')).toContain('the script tests that skip on macOS, run here: scripts/a-linux.test.ts')
      if (allSkipped) expect(r.log('linux')).toContain(`skipped on this Linux box: ${why}`)
    }
  })
})

// part_lockwait reads the clock through `date`, which this script replaces by a fixed time per look; each look is [time, row]
describe('how Lemnos reads a lock-wait heartbeat (part_lockwait)', () => {
  const WHAT = 'the heavy lock'
  const wait = (n: number, beat: string | number = 30) =>
    `pending\twaiting for lock: ${n}s on titan${beat === '' ? '' : ` (beat ${beat}s)`}: ${WHAT}`
  const running = 'pending\trunning on titan'
  const looks = (env: Record<string, string>, steps: [number, string][]) => {
    const T = mkdtempSync(join(tmpdir(), 'cijl-'))
    dirs.push(T)
    const script = `RESULTS="${T}"; . "${join(here, 'ci-local/jobs-check.sh')}"
date() { echo "$NOW"; }
${steps.map(([t, row]) => `NOW=${t}; part_lockwait '${row}' "$RESULTS/seen"`).join('\n')}`
    const out = spawnSync('bash', ['-c', script], { encoding: 'utf8', env: { PATH: process.env.PATH ?? '', ...env } })
    return out.stdout.trim().split('\n')
  }
  const q = (n: number) => `queued ${n} ${WHAT}`
  // the same words at 1000 and at 1000 + gap: alive or gone
  const gap = (env: Record<string, string>, row: string, gaps: number[]) =>
    looks(env, [[1000, row], ...gaps.map((g): [number, string] => [1000 + g, row])]).slice(1)

  it('the window is the part’s own beat (from its status) plus Lemnos’s poll plus 30 s', () => {
    expect(gap({ CI_PART_POLL: '10' }, wait(5, 30), [70, 71])).toEqual([q(5), 'working'])
    expect(gap({ CI_PART_POLL: '10' }, wait(5, 10), [50, 51])).toEqual([q(5), 'working']) // a part that beats faster
  })
  it('no beat in the words (older text), or one outside 10..300 s: 30 s, and the nearest end', () => {
    expect(gap({ CI_PART_POLL: '10' }, wait(5, ''), [70, 71])).toEqual([q(5), 'working'])
    expect(gap({ CI_PART_POLL: '10' }, wait(5, 100000), [340, 341])).toEqual([q(5), 'working']) // 300
    expect(gap({ CI_PART_POLL: '10' }, wait(5, 1), [50, 51])).toEqual([q(5), 'working']) // 10
    expect(gap({ CI_PART_POLL: '10' }, wait(5, 'x'), [70, 71])).toEqual([q(5), 'working']) // not a number: 30
  })
  it('CI_PART_BEAT_STALE sets it outright, whatever the part says', () => {
    expect(gap({ CI_PART_BEAT_STALE: '5' }, wait(5, 100), [5, 6])).toEqual([q(5), 'working'])
  })
  it('a knob with a leading zero is a decimal number, not a bad octal that quietly ends the reading', () => {
    // 08 is eight: a window of 30 + 8 + 30
    expect(gap({ CI_PART_POLL: '08' }, wait(5, 30), [68, 69])).toEqual([q(5), 'working'])
    expect(gap({ CI_PART_BEAT_STALE: '08' }, wait(5, 30), [8, 9])).toEqual([q(5), 'working'])
  })
  it('the cap counts every wait of the part: two waits of 60% of it are stuck', () => {
    const env = { CI_PART_LOCK_WAIT_MAX: '10' }
    // the first wait ends in "running on" (6 s), the second reaches 5 s: 11 s in all
    expect(
      looks(env, [
        [1000, wait(6)],
        [1001, running],
        [1002, wait(5)],
      ]),
    ).toEqual([q(6), 'working', `stuck 11 ${WHAT}`])
    // a second wait that begins between two looks (its count is lower than the last seen) is a new wait too
    expect(
      looks(env, [
        [1000, wait(6)],
        [1001, wait(2)],
        [1002, wait(5)],
      ]),
    ).toEqual([q(6), q(8), `stuck 11 ${WHAT}`])
    // one wait of 6 s alone is under the cap
    expect(looks(env, [[1000, wait(6)]])).toEqual([q(6)])
  })
  it('the beat is a number of seconds read in decimal: 010 is ten, and the floor is 10 (part_beat_secs)', () => {
    const T = mkdtempSync(join(tmpdir(), 'cijl-'))
    dirs.push(T)
    const sh = (env: Record<string, string>) =>
      spawnSync('bash', ['-c', `RESULTS="${T}"; . "${join(here, 'ci-local/jobs-check.sh')}"; part_beat_secs`], {
        encoding: 'utf8',
        env: { PATH: process.env.PATH ?? '', ...env },
      }).stdout.trim()
    expect(sh({ CI_PART_BEAT: '010' })).toBe('10')
    expect(sh({})).toBe('30')
  })
})

describe('check folds in its parts from other machines (docs/CI-MACHINES.md, "check in three places")', () => {
  // A fake GitHub: the commit's full status list from $HOME/rows ("context, state, link, description"), the run's jobs from
  // $HOME/jobs ("name, status"); posts are written down.
  const GH = `case "$1" in repo) echo owner/repo; exit 0 ;; esac
echo "$*" >> "$GH_LOG"
case "$*" in *"-X POST"*) exit 0 ;; *"/statuses?"*) cat "$HOME/rows" 2>/dev/null ;; *"/jobs"*) cat "$HOME/jobs" 2>/dev/null ;; esac
exit 0`
  const A = 'https://example.test/runs/9/attempts/1#'
  const ALL_REMOTE = 'bridge-shard-1:delphi vitest:delphi bridge-shard-2:cyclops'
  const env = (parts: string, wait = '30') => ({
    CI_ATTEMPT_URL: A,
    CI_STATUS_URL: `${A}lemnos`,
    CI_RUN_ID: '9',
    CI_REMOTE_PARTS: parts,
    CI_PART_POLL: '0.2',
    CI_PART_WAIT: wait,
  })
  const setup = (rows: string[], jobs: string[], inject = '') => {
    const r = repo(inject, { gh: GH })
    writeFileSync(join(r.clone, 'apps/bridge/scripts/test-parallel.ts'), '// knows --shard K/N\n')
    r.git(r.clone, 'commit', '-qam', 'runner with --shard')
    writeFileSync(join(r.home, 'rows'), rows.length ? `${rows.join('\n')}\n` : '')
    writeFileSync(join(r.home, 'jobs'), jobs.length ? `${jobs.join('\n')}\n` : '')
    return r
  }
  const pass = (part: string, m: string) => `ci-part/${part}\tsuccess\t${A}${m}\tpassed on ${m} in 60s`
  const fail = (part: string, m: string) => `ci-part/${part}\tfailure\t${A}${m}\tfailed on ${m}`
  const rest = (r: ReturnType<typeof repo>) =>
    r.calledLines().filter((l) => l.startsWith('bun run apps/bridge/scripts/test-parallel.ts') && l.includes('--skip'))
  const vitest = (r: ReturnType<typeof repo>) => r.calledLines().filter((l) => l.startsWith('pnpm test --maxWorkers'))
  const checkPosts = (r: ReturnType<typeof repo>) =>
    readFileSync(r.env.GH_LOG as string, 'utf8')
      .split('\n')
      .filter((l) => l.includes('-X POST') && l.includes('context=local-ci/check ') && !l.includes('state=pending'))

  it('all three parts answered green: check runs neither the rest files nor Vitest itself, and says where they ran', async () => {
    const r = setup(
      [pass('bridge-shard-1', 'delphi'), pass('vitest', 'delphi'), pass('bridge-shard-2', 'cyclops')],
      ['delphi\tcompleted', 'cyclops\tcompleted'],
    )
    const run = r.start(['--ref', 'HEAD', '--jobs', 'check'], env(ALL_REMOTE))
    expect(await run.done, run.out()).toBe(0)
    expect(rest(r)).toEqual([])
    expect(vitest(r)).toEqual([])
    expect(checkPosts(r)).toEqual([
      expect.stringMatching(
        /state=success .*description=passed on \S+ in \d+s \(shard 1 and vitest on delphi, shard 2 on cyclops\)/,
      ),
    ])
  })

  it('a machine that never picked its job up: its part runs here at the first look, and the text says so', async () => {
    const r = setup(
      [pass('bridge-shard-1', 'delphi'), pass('vitest', 'delphi')],
      ['delphi\tcompleted', 'cyclops\tqueued'],
    )
    const run = r.start(['--ref', 'HEAD', '--jobs', 'check'], env(ALL_REMOTE))
    expect(await run.done, run.out()).toBe(0)
    expect(rest(r)).toEqual([expect.stringMatching(/--skip test\/schedules\/ --shard 2\/2 /)])
    expect(vitest(r)).toEqual([])
    expect(checkPosts(r)).toEqual([
      expect.stringMatching(/state=success .*\(shard 1 and vitest on delphi, shard 2 here: cyclops did not answer\)/),
    ])
  })

  // A part machine that lacks a tool its pile needs refuses the part: `error` under its own link, nothing more. Whatever its job
  // then does (ends green or red, or is still finishing), Lemnos takes that pile at once, and check's verdict is Lemnos's.
  describe("a part refused for a missing tool (error, its own link) is taken here at once; the verdict is Lemnos's", () => {
    const refused = (part: string, m: string) =>
      `ci-part/${part}\terror\t${A}${m}\t${part} needs tmux 3.2+, which ${m} does not have; it runs on Lemnos`
    for (const job of ['completed', 'in_progress'])
      it(`its job ${job}: shard 2 runs here at the first look, never waits out CI_PART_WAIT, and check is green`, async () => {
        const r = setup(
          [pass('bridge-shard-1', 'delphi'), pass('vitest', 'delphi'), refused('bridge-shard-2', 'cyclops')],
          ['delphi\tcompleted', `cyclops\t${job}`],
        )
        // an hour's wait: a run that waited would hit the test's own timeout, whatever the load
        const run = r.start(['--ref', 'HEAD', '--jobs', 'check'], env(ALL_REMOTE, '3600'))
        expect(await run.done, run.out()).toBe(0)
        expect(rest(r)).toEqual([expect.stringMatching(/--skip test\/schedules\/ --shard 2\/2 /)])
        expect(checkPosts(r)).toEqual([expect.stringMatching(/state=success .*shard 2 here/)])
      })
    it("an error under another link (Lemnos's own, another machine's) is no refusal: the working part is waited for", async () => {
      for (const link of ['lemnos', 'delphi']) {
        const r = setup(
          [pass('bridge-shard-1', 'delphi'), pass('vitest', 'delphi'), refused('bridge-shard-2', link)],
          ['delphi\tcompleted', 'cyclops\tin_progress'],
        )
        const run = r.start(['--ref', 'HEAD', '--jobs', 'check'], env(ALL_REMOTE, '2'))
        expect(await run.done, run.out()).toBe(0)
        // waited for cyclops (still working), then took it at CI_PART_WAIT: not taken at once as a refusal
        expect(r.log('check'), link).toContain('no answer within 2s')
      }
    })

    it("Lemnos runs a pile with the plan's pile list, the same one the part machines got", async () => {
      const r = setup(
        [pass('bridge-shard-1', 'delphi'), pass('vitest', 'delphi'), refused('bridge-shard-2', 'cyclops')],
        ['delphi\tcompleted', 'cyclops\tcompleted'],
      )
      writeFileSync(join(r.clone, 'apps/bridge/scripts/test-parallel.ts'), '// knows --shard K/N and --pile-tools\n')
      r.git(r.clone, 'commit', '-qam', 'runner with --pile-tools')
      const run = r.start(['--ref', 'HEAD', '--jobs', 'check'], { ...env(ALL_REMOTE), CI_SHARD_TOOLS: 'tmux|' })
      expect(await run.done, run.out()).toBe(0)
      expect(rest(r)).toEqual([expect.stringMatching(/--shard 2\/2 --pile-tools tmux\|/)])
    })

    it('Lemnos runs the refused pile and it fails: check is red, from Lemnos, not from the refusal', async () => {
      const r = setup(
        [pass('bridge-shard-1', 'delphi'), pass('vitest', 'delphi'), refused('bridge-shard-2', 'cyclops')],
        ['delphi\tcompleted', 'cyclops\tcompleted'],
      )
      const run = r.start(['--ref', 'HEAD', '--jobs', 'check'], { ...env(ALL_REMOTE), FAIL_ON: '--shard 2/2' })
      expect(await run.done).toBe(1)
      expect(checkPosts(r)).toEqual([expect.stringMatching(/state=failure /)])
      expect(checkPosts(r).join('\n')).not.toContain('needs tmux')
    })
  })

  // A red quiet suite on Lemnos: a push run stops there and says which parts it never ran or read, one `NOT RUN:` line each; a
  // hostile run goes on to the parts and still fails check.
  describe('a red quiet suite and the parts', () => {
    const answered = () =>
      setup(
        [pass('bridge-shard-1', 'delphi'), pass('vitest', 'delphi'), pass('bridge-shard-2', 'cyclops')],
        ['delphi\tcompleted', 'cyclops\tcompleted'],
      )
    const notRun = (log: string) => log.split('\n').filter((l) => l.startsWith('NOT RUN: '))
    const why = 'step_contract, step_bun_schedules or step_chronos failed'

    it('a push run: every part is NOT RUN, those on another machine say so, and nothing of them is read', async () => {
      const r = answered()
      const run = r.start(['--ref', 'HEAD', '--jobs', 'check'], { ...env(ALL_REMOTE), FAIL_ON: 'test:contract' })
      expect(await run.done, run.out()).toBe(1)
      expect(notRun(r.log('check'))).toEqual([
        'NOT RUN: step_bun_schedules (step_contract failed)',
        `NOT RUN: step_corepack_install (${why})`,
        `NOT RUN: bridge-shard-1 (${why}; it runs on delphi and its result is not read here)`,
        `NOT RUN: bridge-shard-2 (${why}; it runs on cyclops and its result is not read here)`,
        `NOT RUN: vitest (${why}; it runs on delphi and its result is not read here)`,
      ])
      expect(rest(r)).toEqual([])
    })

    it('a red quick gate with parts configured: the parts that run elsewhere are named as parts, never as step_vitest or step_bun_rest', async () => {
      const r = answered()
      const run = r.start(['--ref', 'HEAD', '--jobs', 'check'], { ...env(ALL_REMOTE), FAIL_ON: 'lint' })
      expect(await run.done, run.out()).toBe(1)
      const why = 'pnpm lint failed'
      expect(notRun(r.log('check'))).toEqual([
        `NOT RUN: notices:check (${why})`,
        `NOT RUN: step_contract (${why})`,
        `NOT RUN: step_bun_schedules (${why})`,
        `NOT RUN: step_chronos (${why})`,
        `NOT RUN: step_corepack_install (${why})`,
        `NOT RUN: bridge-shard-1 (${why}; it runs on delphi and its result is not read here)`,
        `NOT RUN: bridge-shard-2 (${why}; it runs on cyclops and its result is not read here)`,
        `NOT RUN: vitest (${why}; it runs on delphi and its result is not read here)`,
        `NOT RUN: audit (${why})`,
      ])
    })

    it('the quiet lock not had in time: the quiet steps, the corepack step and every part are NOT RUN, with no second wait, hostile or not', async () => {
      for (const hostile of ['', '1']) {
        const r = setup(
          [pass('bridge-shard-1', 'delphi'), pass('vitest', 'delphi'), pass('bridge-shard-2', 'cyclops')],
          ['delphi\tcompleted', 'cyclops\tcompleted'],
          'eval "orig_$(declare -f ci_mutex_all)"\nci_mutex_all() { [ "$3" = quiet_and_parts ] && return 1; orig_ci_mutex_all "$@"; }',
        )
        const run = r.start(['--ref', 'HEAD', '--jobs', 'check'], { ...env(ALL_REMOTE), CI_HOSTILE: hostile })
        await run.done
        const why = 'the suites lock was not had in time'
        expect(notRun(r.log('check', hostile ? 'hostile' : ''))).toEqual([
          `NOT RUN: step_contract (${why})`,
          `NOT RUN: step_bun_schedules (${why})`,
          `NOT RUN: step_chronos (${why})`,
          `NOT RUN: step_corepack_install (${why})`,
          `NOT RUN: bridge-shard-1 (${why}; it runs on delphi and its result is not read here)`,
          `NOT RUN: bridge-shard-2 (${why}; it runs on cyclops and its result is not read here)`,
          `NOT RUN: vitest (${why}; it runs on delphi and its result is not read here)`,
        ])
        expect(rest(r), hostile).toEqual([]) // nothing was taken here
      }
    })

    it('the second look: the suites lock not had in time for the parts taken late names those parts NOT RUN', async () => {
      const r = setup(
        [pass('bridge-shard-1', 'delphi'), pass('bridge-shard-2', 'cyclops')],
        ['delphi\tin_progress', 'cyclops\tcompleted'],
        'eval "orig_$(declare -f ci_mutex)"\nci_mutex() { [ "$3" = parts_here ] && return 1; orig_ci_mutex "$@"; }',
      )
      const run = r.start(['--ref', 'HEAD', '--jobs', 'check'], env(ALL_REMOTE, '1'))
      expect(await run.done, run.out()).toBe(1)
      // vitest never answered (its machine still works), was taken late, and its lock was not had: it never ran here
      expect(notRun(r.log('check'))).toEqual(['NOT RUN: vitest (the suites lock was not had in time)'])
    })

    it('a hostile run: the parts are looked at (here or read from their machines), nothing is NOT RUN, check is red', async () => {
      const r = setup(
        [pass('bridge-shard-1', 'delphi'), pass('vitest', 'delphi')].map((l) =>
          l.replace('ci-part/', 'hostile-ci/part-'),
        ), // a hostile run's own contexts
        ['delphi\tcompleted', 'cyclops\tqueued'],
      )
      const run = r.start(['--ref', 'HEAD', '--jobs', 'check'], {
        ...env(ALL_REMOTE),
        FAIL_ON: 'test:contract',
        CI_HOSTILE: '1',
      })
      expect(await run.done, run.out()).toBe(1)
      expect(notRun(r.log('check', 'hostile'))).toEqual([]) // a hostile run's own log folder
      // shard 2's machine never picked it up: it ran here, after the red quiet suite
      expect(rest(r)).toEqual([expect.stringMatching(/--skip test\/schedules\/ --shard 2\/2 /)])
      expect(r.log('check', 'hostile')).toContain('+ step_corepack_install')
    })
  })

  it('a part that failed on its machine fails check, with the part and the machine in the text', async () => {
    const r = setup(
      [pass('bridge-shard-1', 'delphi'), pass('vitest', 'delphi'), fail('bridge-shard-2', 'cyclops')],
      ['delphi\tcompleted', 'cyclops\tcompleted'],
    )
    const run = r.start(['--ref', 'HEAD', '--jobs', 'check'], env(ALL_REMOTE))
    expect(await run.done).toBe(1)
    expect(checkPosts(r)).toEqual([
      expect.stringMatching(/state=failure .*description=bridge shard 2 failed on cyclops; see its run/),
    ])
  })

  // The commit's status list is read once per poll, whatever the number of parts: polling many parts at a 30 s tick must not
  // spend GitHub's rate limit per part (it ran out once from polling)
  for (const parts of ['vitest:delphi', ALL_REMOTE])
    it(`one status read per poll with ${parts.split(' ').length} part(s) working`, async () => {
      const r = setup([], ['delphi\tin_progress', 'cyclops\tin_progress'])
      const run = r.start(['--ref', 'HEAD', '--jobs', 'check'], env(parts, '3'))
      expect(await run.done, run.out()).toBe(0)
      // Each poll reads the run's jobs once: the status reads are one per poll, plus the run's own seven, whatever the parts.
      // Those seven: before posting pending, one per job (check, and the report-ci/fast that comes with it); right before each
      // job's final post, one per job; one for check's parts right before check is posted; and two for the settle step's note
      // that this attempt stood aside (docs/CI-MACHINES.md): one when the run starts, one right before check's pass or failure.
      const log = readFileSync(r.env.GH_LOG as string, 'utf8').split('\n')
      const polls = log.filter((l) => l.includes('/actions/runs/9/jobs')).length
      const statusReads = log.filter((l) => l.includes('/statuses?')).length
      expect(polls).toBeGreaterThanOrEqual(3)
      expect(statusReads).toBe(polls + 7)
    })

  it('a part still working after CI_PART_WAIT is taken: it runs here, after the wait', async () => {
    const r = setup(
      [pass('bridge-shard-1', 'delphi'), pass('bridge-shard-2', 'cyclops')],
      ['delphi\tin_progress', 'cyclops\tcompleted'],
    )
    const run = r.start(['--ref', 'HEAD', '--jobs', 'check'], env(ALL_REMOTE, '1'))
    expect(await run.done, run.out()).toBe(0)
    expect(rest(r)).toEqual([])
    expect(vitest(r)).toHaveLength(1)
    expect(checkPosts(r)).toEqual([expect.stringMatching(/state=success .*vitest here: delphi did not answer/)])
  })

  // A part queued for a lock on its own machine (docs/CI-MACHINES.md, "A part queued for a lock"): its pending status says
  // "waiting for lock: <n>s ..." and the words change at each beat, so a test changes them once per poll of the main shell (each
  // poll reads the run's jobs once: the event to wait on), never on a timer.
  describe('a bridge shard queued for a lock on its own machine', () => {
    const WHAT = 'the heavy lock, which the other WSL distro holds'
    const waiting = (n: number) =>
      `ci-part/bridge-shard-2\tpending\t${A}cyclops\twaiting for lock: ${n}s on cyclops (beat 30s): ${WHAT}`
    const others = [pass('bridge-shard-1', 'delphi'), pass('vitest', 'delphi')]
    const jobs = ['delphi\tcompleted', 'cyclops\tin_progress']
    const ghLines = (r: ReturnType<typeof repo>) =>
      existsSync(r.env.GH_LOG as string) ? readFileSync(r.env.GH_LOG as string, 'utf8').split('\n') : []
    const polls = (r: ReturnType<typeof repo>) => ghLines(r).filter((l) => l.includes('/actions/runs/9/jobs')).length
    // whole or not at all: the fake gh reads the file at any moment, and an empty read in the middle of a rewrite is a poll with no
    // waiting row (a part "working", which a wait of a second cannot afford)
    const setRows = (r: ReturnType<typeof repo>, rows: string[]) => {
      writeFileSync(join(r.home, 'rows.tmp'), `${rows.join('\n')}\n`)
      renameSync(join(r.home, 'rows.tmp'), join(r.home, 'rows'))
    }
    /** One beat per poll of the main shell, `count` of them (it stops at once if the run has ended: the caller's check then fails). */
    async function beats(
      r: ReturnType<typeof repo>,
      run: { done: Promise<number> },
      count: number,
      rowsAt = (n: number) => [...others, waiting(n)],
    ) {
      let over = false
      void run.done.then(() => {
        over = true
      })
      const base = polls(r)
      for (let i = 0; i < count && !over; i++) {
        await vi.waitUntil(() => over || polls(r) > base + i, { timeout: scaled(30_000), interval: 25 })
        setRows(r, rowsAt(i + 1))
      }
    }
    // A wait of 1 s against real-time polls: with every look "queued" the wait can never run out (its queued seconds are added at each look),
    // but ONE look that is not (a heartbeat read as stale because the test or the machine was slow to change the words, an empty read)
    // costs the whole gap since the last look, 1 s or more. So the window for a stale heartbeat is far wider than any load: the staleness
    // itself is tested on its own (the cases with CI_PART_BEAT_STALE 1, and part_lockwait's, with a clock of their own)
    const queued = { ...env(ALL_REMOTE, '1'), CI_PART_BEAT_STALE: '60' }

    it('a fresh heartbeat holds CI_PART_WAIT: not taken while it beats, and its answer is folded', async () => {
      const r = setup([...others, waiting(1)], jobs)
      const run = r.start(['--ref', 'HEAD', '--jobs', 'check'], queued)
      await beats(r, run, 6)
      expect(r.log('check')).not.toContain('taking')
      setRows(r, [...others, pass('bridge-shard-2', 'cyclops'), waiting(7)])
      expect(await run.done, run.out()).toBe(0)
      expect(rest(r)).toEqual([])
      expect(checkPosts(r)).toEqual([expect.stringMatching(/state=success .*shard 2 on cyclops/)])
    })

    it('stuck past CI_PART_LOCK_WAIT_MAX: taken here, and the log names the lock wait and the machine', async () => {
      const r = setup([...others, waiting(10)], jobs)
      // an hour's answer wait: only the lock-wait cap can end this before the test's own timeout
      const run = r.start(['--ref', 'HEAD', '--jobs', 'check'], {
        ...env(ALL_REMOTE, '3600'),
        CI_PART_LOCK_WAIT_MAX: '3',
      })
      expect(await run.done, run.out()).toBe(0)
      expect(r.log('check')).toContain(
        `taking bridge-shard-2: waiting for a lock on cyclops for 10s in all, over CI_PART_LOCK_WAIT_MAX (3s): ${WHAT}`,
      )
      expect(rest(r)).toEqual([expect.stringMatching(/--shard 2\/2 /)])
      expect(checkPosts(r)).toEqual([expect.stringMatching(/state=success .*shard 2 here: cyclops did not answer/)])
    })

    // Two shards on other machines: each has its own wait, and a queued one's time is its own (not the other's)
    const waiting1 = (n: number) =>
      `ci-part/bridge-shard-1\tpending\t${A}delphi\twaiting for lock: ${n}s on delphi (beat 30s): ${WHAT}`
    const vitestPass = pass('vitest', 'delphi')
    const bothJobs = ['delphi\tin_progress', 'cyclops\tin_progress']

    it('shard 1 hung, shard 2 queued: shard 1 is taken at CI_PART_WAIT, shard 2 is not (its queue is not counted)', async () => {
      const r = setup([vitestPass, waiting(1)], bothJobs)
      const run = r.start(['--ref', 'HEAD', '--jobs', 'check'], queued)
      await beats(r, run, 6, (n) => [vitestPass, waiting(n)])
      expect(r.log('check')).not.toContain('taking bridge-shard-2')
      setRows(r, [vitestPass, pass('bridge-shard-2', 'cyclops'), waiting(7)])
      expect(await run.done, run.out()).toBe(0)
      expect(rest(r)).toEqual([expect.stringMatching(/--shard 1\/2 /)])
      expect(checkPosts(r)).toEqual([expect.stringMatching(/state=success .*shard 1 here: delphi did not answer/)])
      expect(checkPosts(r).join('\n')).not.toContain('shard 2 here')
    })

    it('shard 1 queued, shard 2 hung: shard 2 is taken at its own CI_PART_WAIT, not after shard 1’s queue', async () => {
      const r = setup([vitestPass, waiting1(1)], bothJobs)
      const run = r.start(['--ref', 'HEAD', '--jobs', 'check'], queued)
      await beats(r, run, 6, (n) => [vitestPass, waiting1(n)])
      // both answer late: shard 2 after its own wait is over (1 s), though shard 1's queue went on for five more
      setRows(r, [vitestPass, pass('bridge-shard-1', 'delphi'), pass('bridge-shard-2', 'cyclops'), waiting1(7)])
      expect(await run.done, run.out()).toBe(0)
      expect(rest(r)).toEqual([expect.stringMatching(/--shard 2\/2 /)])
      expect(r.log('check')).toContain('taking bridge-shard-2: no answer within 1s')
      expect(checkPosts(r)).toEqual([expect.stringMatching(/state=success .*shard 2 here: cyclops did not answer/)])
    })

    it('the cap covers every wait of the shard: two waits of 60% of it are stuck, though each is under it', async () => {
      const r = setup([...others, waiting(1)], jobs)
      const run = r.start(['--ref', 'HEAD', '--jobs', 'check'], {
        ...env(ALL_REMOTE, '3600'),
        CI_PART_LOCK_WAIT_MAX: '10',
      })
      let over = false
      void run.done.then(() => {
        over = true
      })
      const running = `ci-part/bridge-shard-2\tpending\t${A}cyclops\trunning on cyclops`
      // A wait that reaches 6 s, "running on", a wait that reaches 5 s. The shards are polled jobs first, then statuses, so a poll that
      // began before a write may read it a moment later: each row is held for two poll starts, which is one whole poll that read it.
      // (A row replaced before any poll read it would leave the first wait at 5 s and the total at 10, which is not over the cap.)
      for (const row of [waiting(6), running, waiting(5)]) {
        const base = polls(r)
        await vi.waitUntil(() => over || polls(r) > base, { timeout: scaled(30_000), interval: 25 })
        if (over) break
        setRows(r, [...others, row])
        const written = polls(r)
        await vi.waitUntil(() => over || polls(r) > written + 1, { timeout: scaled(30_000), interval: 25 })
      }
      // the poll that reads it writes stuck; the fold loop reads that on its own beat, so answer only once it took the shard (or
      // never did: a red build ends here, with the part's pass)
      await vi
        .waitUntil(() => over || tryLog(() => r.log('check')).includes('taking bridge-shard-2'), {
          timeout: scaled(30_000),
          interval: 250,
        })
        .catch(() => {})
      if (!over) setRows(r, [...others, pass('bridge-shard-2', 'cyclops')])
      expect(await run.done, run.out()).toBe(0)
      expect(r.log('check')).toContain(
        `taking bridge-shard-2: waiting for a lock on cyclops for 11s in all, over CI_PART_LOCK_WAIT_MAX (10s): ${WHAT}`,
      )
      expect(rest(r)).toEqual([expect.stringMatching(/--shard 2\/2 /)])
    })

    it('a heartbeat that went stale holds nothing: taken at CI_PART_WAIT, as a part that is only working', async () => {
      const r = setup([...others, waiting(5)], jobs) // the same words at every poll: nobody beats
      const run = r.start(['--ref', 'HEAD', '--jobs', 'check'], { ...env(ALL_REMOTE, '1'), CI_PART_BEAT_STALE: '1' })
      expect(await run.done, run.out()).toBe(0)
      expect(r.log('check')).toContain('taking bridge-shard-2: no answer within 1s')
      expect(rest(r)).toEqual([expect.stringMatching(/--shard 2\/2 /)])
    })

    it('once it runs (a "running on" status above the wait), the normal wait applies from then', async () => {
      const r = setup([...others, waiting(1)], jobs)
      const run = r.start(['--ref', 'HEAD', '--jobs', 'check'], queued)
      await beats(r, run, 6)
      expect(r.log('check')).not.toContain('taking')
      setRows(r, [...others, `ci-part/bridge-shard-2\tpending\t${A}cyclops\trunning on cyclops`, waiting(7)])
      expect(await run.done, run.out()).toBe(0)
      expect(r.log('check')).toContain('taking bridge-shard-2: no answer within 1s')
    })
  })

  it('a part working when the quiet group ends, and green before the wait is over, is not taken', async () => {
    const r = setup(
      [pass('bridge-shard-1', 'delphi'), pass('bridge-shard-2', 'cyclops')],
      ['delphi\tin_progress', 'cyclops\tcompleted'],
    )
    // the vitest part goes green while check waits
    const run = r.start(['--ref', 'HEAD', '--jobs', 'check'], env(ALL_REMOTE, '60'))
    await vi.waitUntil(
      () => existsSync(join(r.T, 'calls')) && r.calledLines().some((l) => l.includes('test:contract')),
      {
        timeout: 30_000,
        interval: 50,
      },
    )
    writeFileSync(
      join(r.home, 'rows'),
      `${[pass('bridge-shard-1', 'delphi'), pass('bridge-shard-2', 'cyclops'), pass('vitest', 'delphi')].join('\n')}\n`,
    )
    expect(await run.done, run.out()).toBe(0)
    expect(vitest(r)).toEqual([])
  })

  it("no parts asked for (every switch off): check runs today's loud group, the whole rest and Vitest, and reads no part", async () => {
    const r = setup([], [])
    const run = r.start(['--ref', 'HEAD', '--jobs', 'check'], {})
    expect(await run.done, run.out()).toBe(0)
    expect(rest(r)).toEqual([expect.not.stringContaining('--shard')])
    expect(vitest(r)).toHaveLength(1)
    expect(readFileSync(r.env.GH_LOG as string, 'utf8')).not.toContain('/jobs')
  })

  it('parts asked for but no way to read them (no CI_ATTEMPT_URL): every part runs here, as today', async () => {
    const r = setup([pass('bridge-shard-1', 'delphi')], ['delphi\tcompleted'])
    const run = r.start(['--ref', 'HEAD', '--jobs', 'check'], { CI_REMOTE_PARTS: ALL_REMOTE })
    expect(await run.done, run.out()).toBe(0)
    expect(rest(r)).toEqual([expect.not.stringContaining('--shard')])
    expect(vitest(r)).toHaveLength(1)
  })

  describe('check as a part on Titan (CI_STATUS_PREFIX ci-part: check-titan, docs/CI-MACHINES.md, "check on Titan")', () => {
    const PART = { ...env(ALL_REMOTE), CI_STATUS_PREFIX: 'ci-part' }
    const partPosts = (r: ReturnType<typeof repo>) =>
      readFileSync(r.env.GH_LOG as string, 'utf8')
        .split('\n')
        .filter((l) => l.includes('-X POST') && l.includes('context=ci-part/check ') && !l.includes('state=pending'))
    // the suites mutex never had: ci_mutex for `suites` gives up as on its timeout, every other lock as before
    const NO_SUITES = `eval "real_$(declare -f ci_mutex)"
ci_mutex() { [ "$2" = suites ] && { echo "ci-local: timed out waiting for suites" >&2; return 1; }; real_ci_mutex "$@"; }`

    it('has no parts of its own: the whole rest and Vitest run here, and its per-test file is gathered', async () => {
      const r = setup([pass('bridge-shard-1', 'delphi')], ['delphi\tcompleted'])
      const run = r.start(['--ref', 'HEAD', '--jobs', 'check'], PART)
      expect(await run.done, run.out()).toBe(0)
      expect(run.out()).toContain(
        'check runs as a part here (ci-part/): it has no parts of its own; CI_REMOTE_PARTS ignored',
      )
      expect(rest(r)).toEqual([expect.not.stringContaining('--shard')])
      expect(vitest(r)).toEqual([
        expect.stringContaining(`--reporter=${join(r.clone, 'scripts/ci-test-results-vitest.ts')}`),
      ])
      const sha = r.git(r.clone, 'rev-parse', 'HEAD')
      expect(r.calledLines().filter((l) => l.includes('ci-test-results.ts '))).toEqual([
        expect.stringContaining(`-check-tests.tsv ${sha} `),
      ])
      expect(partPosts(r)).toEqual([expect.stringContaining('state=success')])
      expect(readFileSync(r.env.GH_LOG as string, 'utf8')).not.toContain('/jobs')
    })

    // A part queued for the suites lock says so (docs/CI-MACHINES.md, "A part queued for a lock"): a heavy run holds the lock, the
    // part's pending status turns to "waiting for lock: <n>s on ...: <what>" at each beat, and to "running on" once it has it.
    const ghLog = (r: ReturnType<typeof repo>) =>
      existsSync(r.env.GH_LOG as string) ? readFileSync(r.env.GH_LOG as string, 'utf8') : ''
    const pendings = (r: ReturnType<typeof repo>) =>
      ghLog(r)
        .split('\n')
        .filter((l) => l.includes('-X POST') && l.includes('context=ci-part/check ') && l.includes('state=pending'))
        .map((l) => l.replace(/^.*-f description=/, '').replace(/ -f target_url=.*$/, ''))
    // a beat of one second: a seam inside the copy of the script under test, not a knob (CI_PART_BEAT is at least 10 s, always)
    const FAST_BEAT = 'part_beat_secs() { echo 1; }'
    const jobLog = (r: ReturnType<typeof repo>) => {
      try {
        return r.log('check')
      } catch {
        return '' // not started yet
      }
    }
    /** A heavy run (a gate) that holds the suites lock until the file `go` is there. */
    async function holder(r: ReturnType<typeof repo>) {
      const go = join(r.T, 'gate.go')
      const ran = join(r.T, 'gate.ran')
      const gate = spawn(
        'bash',
        [join(here, 'heavy-lock.sh'), 'run', 'g1', '--', 'sh', '-c', `echo ran > "${ran}"; ${waitForFile(go)}`],
        {
          env: {
            PATH: process.env.PATH ?? '',
            HOME: r.home,
            HEAVY_LOCK_POLL: '0.1',
            TALOS_HEAVY_GUARD: join(r.T, 'none'),
            TALOS_HEAVY_SLOTS: '1', // one slot: the run waits for the lock itself, not for a turn before it starts
          },
        },
      )
      live.push(gate)
      await vi.waitUntil(() => existsSync(ran), { timeout: scaled(30_000), interval: 25 })
      return () => writeFileSync(go, '')
    }

    it('queued for the suites lock: it posts "waiting for lock" while it waits, and "running on" once it has the lock', async () => {
      const r = setup([], [])
      // the loud group's Vitest step waits for a file: the part runs on, long enough for the main shell to say so
      r.inject(`step_vitest() { ${waitForFile('$HOME/part-fin')}; }`)
      r.inject(FAST_BEAT)
      const release = await holder(r)
      const run = r.start(['--ref', 'HEAD', '--jobs', 'check'], { ...PART, TALOS_HEAVY_SLOTS: '1' })
      await vi.waitUntil(() => pendings(r).some((d) => d.startsWith('waiting for lock: ')), {
        timeout: scaled(30_000),
        interval: 25,
      })
      release()
      await vi.waitUntil(() => pendings(r).at(-1)?.startsWith('running on '), { timeout: scaled(30_000), interval: 25 })
      writeFileSync(join(r.home, 'part-fin'), '')
      expect(await run.done, run.out()).toBe(0)
      const all = pendings(r)
      expect(all[0]).toMatch(/^running on /)
      expect(all.filter((d) => d.startsWith('waiting for lock: '))[0]).toMatch(
        /^waiting for lock: \d+s on .+: the heavy lock/,
      )
      expect(partPosts(r)).toEqual([expect.stringContaining('state=success')])
    })

    it('a lock wait shorter than one beat posts nothing of its own', async () => {
      const r = setup([], [])
      const release = await holder(r)
      const run = r.start(['--ref', 'HEAD', '--jobs', 'check'], { ...PART, TALOS_HEAVY_SLOTS: '1' }) // a beat of 30 s
      await vi.waitUntil(() => /waiting for the heavy lock/.test(jobLog(r)), { timeout: scaled(30_000), interval: 25 })
      release()
      expect(await run.done, run.out()).toBe(0)
      expect(pendings(r)).toEqual([expect.stringMatching(/^running on /)])
    })

    // each call of ci_part_beat is written down (with the file it would write), so a test waits for the wait's own events
    const SPY = `eval "real_$(declare -f ci_part_beat)"
ci_part_beat() { echo "beat [$CI_LOCKWAIT_FILE]" >> "$HOME/beats"; real_ci_part_beat "$@"; }`
    const beats = (r: ReturnType<typeof repo>) =>
      existsSync(join(r.home, 'beats')) ? readFileSync(join(r.home, 'beats'), 'utf8').trim().split('\n') : []

    it('only a part posts its lock wait: the same wait as Lemnos’s own check (local-ci/) writes no beat file and posts nothing', async () => {
      for (const prefix of ['ci-part', 'local-ci']) {
        const r = setup([], [])
        r.inject(SPY)
        const release = await holder(r)
        r.inject(FAST_BEAT)
        const run = r.start(['--ref', 'HEAD', '--jobs', 'check'], {
          ...(prefix === 'ci-part' ? PART : {}),
          TALOS_HEAVY_SLOTS: '1',
        })
        // the wait goes on for several looks of the lock (CI_POLL, 0.05 s each): the beat has had its chances
        await vi.waitUntil(() => beats(r).length >= 3, { timeout: scaled(30_000), interval: 25 })
        if (prefix === 'ci-part')
          await vi.waitUntil(() => pendings(r).some((d) => d.startsWith('waiting for lock: ')), {
            timeout: scaled(30_000),
            interval: 25,
          })
        release()
        expect(await run.done, run.out()).toBe(0)
        if (prefix === 'ci-part')
          expect(new Set(beats(r))).toEqual(new Set([expect.stringMatching(/\/check\.lockwait\]$/)]))
        else {
          expect(new Set(beats(r)), prefix).toEqual(new Set(['beat []'])) // no file: the job writes nothing
          expect(ghLog(r), prefix).not.toContain('waiting for lock')
        }
      }
    })

    it('a job killed while it waits: its failure is the last status posted, no waiting or running after it', async () => {
      const r = setup([], [])
      r.inject(FAST_BEAT)
      const release = await holder(r)
      const run = r.start(['--ref', 'HEAD', '--jobs', 'check'], { ...PART, TALOS_HEAVY_SLOTS: '1' })
      await vi.waitUntil(() => pendings(r).some((d) => d.startsWith('waiting for lock: ')), {
        timeout: scaled(30_000),
        interval: 25,
      })
      // the job's own process group (the run's record): killed outright, so it leaves no result file
      const runs = join(r.home, '.cache/talos-ci/runs')
      const group = readdirSync(runs)
        .map((n) => join(runs, n, 'results', 'check.group'))
        .find((f) => existsSync(f))
      expect(group).toBeDefined()
      process.kill(-Number(readFileSync(group as string, 'utf8').trim()), 'SIGKILL')
      expect(await run.done).toBe(1)
      release()
      const posts = ghLog(r)
        .split('\n')
        .filter((l) => l.includes('-X POST') && l.includes('context=ci-part/check '))
        .map((l) => /state=(\w+)/.exec(l)?.[1])
      expect(posts.at(-1)).toBe('failure')
    })

    it('a failed setup: "not tested" (an error Lemnos takes back), never a red, and nothing run', async () => {
      const r = setup([], [])
      const run = r.start(['--ref', 'HEAD', '--jobs', 'check'], { ...PART, FAIL_ON: 'build' })
      expect(await run.done, run.out()).toBe(0)
      expect(partPosts(r)).toEqual([expect.stringMatching(/state=error .*description=not tested: setup failed on /)])
      expect(rest(r)).toEqual([])
    })

    it('the suites lock not had in time: "not tested", and the per-test file is still written', async () => {
      const r = setup([], [])
      r.inject(NO_SUITES)
      const run = r.start(['--ref', 'HEAD', '--jobs', 'check'], PART)
      expect(await run.done, run.out()).toBe(0)
      expect(partPosts(r)).toEqual([
        expect.stringMatching(/state=error .*description=not tested: the suites lock was not had in time on /),
      ])
      expect(r.calledLines().filter((l) => l.includes('ci-test-results.ts '))).toHaveLength(1)
    })

    // the quiet hold had, the loud one not (a heavy run took the lock in between): ci_mutex gives up on the second `suites`
    const NO_LOUD = `eval "real_$(declare -f ci_mutex)"
ci_mutex() {
  if [ "$2" = suites ] && [ -f "$RESULTS/held-once" ]; then echo "ci-local: timed out waiting for suites" >&2; return 1; fi
  [ "$2" != suites ] || : > "$RESULTS/held-once"
  real_ci_mutex "$@"
}`

    it('the quiet group green, then the loud hold not had in time: "not tested" too, not a red', async () => {
      const r = setup([], [])
      r.inject(NO_LOUD)
      const run = r.start(['--ref', 'HEAD', '--jobs', 'check'], PART)
      expect(await run.done, run.out()).toBe(0)
      expect(partPosts(r)).toEqual([
        expect.stringMatching(/state=error .*description=not tested: the suites lock was not had in time on /),
      ])
      expect(vitest(r)).toEqual([])
    })

    it('a red quiet group is a red, though the loud hold was never asked for', async () => {
      const r = setup([], [])
      const run = r.start(['--ref', 'HEAD', '--jobs', 'check'], { ...PART, FAIL_ON: 'test:contract' })
      expect(await run.done, run.out()).toBe(1)
      expect(partPosts(r)).toEqual([expect.stringContaining('state=failure')])
      expect(vitest(r)).toEqual([])
    })

    it("the contract suite's tests go in the per-test file too", async () => {
      const r = setup([], [])
      expect(await r.start(['--ref', 'HEAD', '--jobs', 'check'], PART).done).toBe(0)
      expect(r.calledLines().filter((l) => l.includes('test:contract'))).toEqual([
        expect.stringContaining(`--reporter=${join(r.clone, 'scripts/ci-test-results-vitest.ts')}`),
      ])
    })

    it("with parts on other machines, Lemnos's own check names them in its per-test file's call", async () => {
      const r = setup(
        [pass('bridge-shard-1', 'delphi'), pass('vitest', 'delphi'), pass('bridge-shard-2', 'cyclops')],
        ['delphi\tcompleted', 'cyclops\tcompleted'],
      )
      expect(await r.start(['--ref', 'HEAD', '--jobs', 'check'], env(ALL_REMOTE)).done).toBe(0)
      expect(r.calledLines().filter((l) => l.includes('ci-test-results.ts '))).toEqual([
        expect.stringMatching(/-check-tests\.tsv \w+ \S+ bridge-shard-1:delphi vitest:delphi bridge-shard-2:cyclops /),
      ])
    })

    it('CI_CHECK_PART_REFUSE=1: the part says "not tested" at once and runs nothing; local-ci/check ignores it', async () => {
      const r = setup([], [])
      const run = r.start(['--ref', 'HEAD', '--jobs', 'check'], { ...PART, CI_CHECK_PART_REFUSE: '1' })
      expect(await run.done, run.out()).toBe(0)
      expect(partPosts(r)).toEqual([
        expect.stringMatching(
          /state=error .*description=not tested: forced \(CI_CHECK_PART_REFUSE=1, a manual dispatch\)/,
        ),
      ])
      expect(r.calledLines().filter((l) => l.includes('typecheck') || l.includes('test-parallel'))).toEqual([])
      const own = setup([], [])
      const ownRun = own.start(['--ref', 'HEAD', '--jobs', 'check'], { CI_CHECK_PART_REFUSE: '1' })
      expect(await ownRun.done, ownRun.out()).toBe(0)
      expect(checkPosts(own)).toEqual([expect.stringContaining('state=success')])
    })

    it('a red test is a red, as a part too, and the per-test file is still written', async () => {
      const r = setup([], [])
      const run = r.start(['--ref', 'HEAD', '--jobs', 'check'], { ...PART, FAIL_ON: '--maxWorkers' })
      expect(await run.done, run.out()).toBe(1)
      expect(partPosts(r)).toEqual([expect.stringContaining('state=failure')])
      expect(r.calledLines().filter((l) => l.includes('ci-test-results.ts '))).toHaveLength(1)
    })

    it("Lemnos's own check (local-ci/) without the suites lock is a red, as before: only a part says not tested", async () => {
      const r = setup([], [])
      r.inject(NO_SUITES)
      const run = r.start(['--ref', 'HEAD', '--jobs', 'check'], {})
      expect(await run.done, run.out()).toBe(1)
      expect(checkPosts(r)).toEqual([expect.stringContaining('state=failure')])
    })
  })

  it('a malformed CI_REMOTE_PARTS is refused before anything is posted', async () => {
    const r = setup([], [])
    for (const bad of ['check:delphi', 'vitest', 'vitest:Delphi;x']) {
      const run = r.start(['--ref', 'HEAD', '--jobs', 'check'], { ...env(bad) })
      expect(await run.done, bad).toBe(64)
    }
  })
})
