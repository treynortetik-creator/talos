// scripts/ci-local.sh inside one run: the jobs go side by side after one shared install and build. A local "origin", a fake
// `gh` that records statuses, and fake `pnpm` and `bun` that write down what they were asked to run, so these tests prove
// the order of events and that every gate is still a gate, without running any of the real suites.
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
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest'
import { cleanEnv } from './ci-test-env'

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

/** The real script with these job functions added, in a clone of a one-commit repo with fake tools on the PATH. */
function repo(jobs = '') {
  const T = mkdtempSync(join(tmpdir(), 'cij-'))
  dirs.push(T)
  const git = (cwd: string, ...a: string[]) =>
    execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', ...a], { cwd, encoding: 'utf8' }).trim()
  const src = join(T, 'src')
  mkdirSync(join(src, 'apps/bridge/scripts'), { recursive: true })
  git(src, 'init', '-q', '-b', 'main')
  writeFileSync(join(src, 'a.txt'), 'a\n')
  writeFileSync(join(src, 'apps/bridge/scripts/test-parallel.ts'), '// stand-in\n')
  // A stand-in for scripts/mic-preflight.mjs: prints $MIC_FAKE (ok by default) and exits like the real one (ok 0, stuck 3, else 2).
  mkdirSync(join(src, 'scripts'))
  writeFileSync(
    join(src, 'scripts/mic-preflight.mjs'),
    "const w = process.env.MIC_FAKE || 'ok'\nif (process.env.MIC_NOISE) console.error('(node) ExperimentalWarning: noise')\nconsole.log(w)\nprocess.exit(w === 'ok' ? 0 : w === 'stuck' ? 3 : 2)\n",
  )
  git(src, 'add', '-A')
  git(src, 'commit', '-qm', 'a')
  const origin = join(T, 'origin.git')
  git(T, 'clone', '-q', '--bare', src, origin)
  const clone = join(T, 'clone')
  git(T, 'clone', '-q', origin, clone)
  mkdirSync(join(clone, 'scripts'), { recursive: true })
  const copy = join(clone, 'scripts', 'ci-local.sh')
  writeFileSync(copy, readFileSync(script, 'utf8').replace('\ncd "$WT"\n', `\n${jobs}\ncd "$WT"\n`))
  const bin = join(T, 'bin')
  mkdirSync(bin)
  const home = join(T, 'home')
  mkdirSync(home)
  const calls = join(T, 'calls')
  const tool = (name: string, body: string) => {
    writeFileSync(join(bin, name), `#!/bin/bash\n${body}\n`)
    chmodSync(join(bin, name), 0o755)
  }
  tool('gh', 'case "$1" in repo) echo owner/repo ;; api) echo "$*" >> "$GH_LOG" ;; esac')
  // Exit 1 when the line it just wrote contains $FAIL_ON.
  const fake = (n: string) =>
    `echo "${n} $* SKIP_BUILD=\${SKIP_BUILD:-} E2E_SKIP_BUILD=\${E2E_SKIP_BUILD:-}" >> "$CALLS"
     [ -n "\${FAIL_ON:-}" ] && [[ "$* " == *"$FAIL_ON"* ]] && exit 1
     exit 0`
  tool('pnpm', fake('pnpm'))
  tool('bun', fake('bun'))
  const env = {
    ...cleanEnv(),
    CI_MAX_LOAD: '0',
    CI_POLL: '0.05',
    CI_LOCK_TIMEOUT: '30',
    TALOS_CI_NESTED: '0',
    CI_SLOTS: '1',
    HOME: home,
    PATH: `${bin}:${process.env.PATH}`,
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
  const log = (job: string) => {
    const sha = git(clone, 'rev-parse', '--short=7', 'HEAD')
    return readFileSync(join(home, '.cache/talos-ci/logs', `${sha}-${job}.log`), 'utf8')
  }
  return { T, home, clone, git, start, log, env, calledLines: () => readFileSync(calls, 'utf8').trim().split('\n') }
}
const noStatus = ['--ref', 'HEAD', '--no-status']

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
    ['check', 'capture-schedules.ts --check'],
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

  describe("the browser job's microphone preflight", () => {
    const line =
      "the runner's microphone is blocked (getUserMedia never answers): check the Mac's microphone permission, then rerun"

    it('stuck: still runs every test, then fails the job with one plain line in the log and the status, posts no success', async () => {
      const r = repo()
      const run = r.start(['--ref', 'HEAD', '--jobs', 'browser'], { MIC_FAKE: 'stuck' })
      expect(await run.done).toBe(1)
      expect(run.out()).toContain('✗ browser')
      expect(r.log('browser')).toContain(line)
      const posted = readFileSync(r.env.GH_LOG, 'utf8')
      expect(posted).toMatch(/state=failure .*context=local-ci\/browser/)
      expect(posted).toContain(line)
      expect(posted).not.toMatch(/state=success .*context=local-ci\/browser/)
      const calls = r.calledLines()
      expect(calls.some((l) => l.includes('test:browser'))).toBe(true)
      expect(calls.some((l) => l.includes('test:e2e'))).toBe(true)
    })

    it('ok with a Node warning on stderr is still ok', async () => {
      const r = repo()
      const run = r.start(['--ref', 'HEAD', '--jobs', 'browser'], { MIC_NOISE: '1' })
      expect(await run.done).toBe(0)
      expect(r.log('browser')).toContain('ExperimentalWarning')
    })

    it('stuck plus another failure: the status names both', async () => {
      const r = repo()
      const run = r.start(['--ref', 'HEAD', '--jobs', 'browser'], { MIC_FAKE: 'stuck', FAIL_ON: 'test:browser' })
      expect(await run.done).toBe(1)
      expect(readFileSync(r.env.GH_LOG, 'utf8')).toContain('other tests failed too')
    })

    it('stuck: the e2e packages run with --no-bail, so the e2e suite runs after the failing web voice specs', async () => {
      const r = repo()
      const run = r.start(['--ref', 'HEAD', '--jobs', 'browser'], { MIC_FAKE: 'stuck' })
      expect(await run.done).toBe(1)
      expect(r.calledLines().some((l) => l.includes('--no-bail') && l.includes('test:e2e'))).toBe(true)
    })

    it('stuck: the e2e suite still runs when the web tests fail, and the job still fails', async () => {
      const r = repo()
      const run = r.start(['--ref', 'HEAD', '--jobs', 'browser'], { MIC_FAKE: 'stuck', FAIL_ON: 'test:browser' })
      expect(await run.done).toBe(1)
      expect(r.calledLines().some((l) => l.includes('test:e2e'))).toBe(true)
      expect(readFileSync(r.env.GH_LOG, 'utf8')).not.toMatch(/state=success .*context=local-ci\/browser/)
    })

    it('ok: a failing browser suite does not hide the e2e suite, which runs with --no-bail, and the job still fails', async () => {
      const r = repo()
      const run = r.start(['--ref', 'HEAD', '--jobs', 'browser'], { FAIL_ON: 'test:browser' })
      expect(await run.done).toBe(1)
      expect(run.out()).toContain('✗ browser')
      expect(r.calledLines().some((l) => l.includes('--no-bail') && l.includes('test:e2e'))).toBe(true)
      expect(readFileSync(r.env.GH_LOG, 'utf8')).not.toMatch(/state=success .*context=local-ci\/browser/)
    })

    it('ok: a failing e2e suite fails the job, and nothing is named as a microphone problem', async () => {
      const r = repo()
      const run = r.start(['--ref', 'HEAD', '--jobs', 'browser'], { FAIL_ON: 'test:e2e' })
      expect(await run.done).toBe(1)
      expect(readFileSync(r.env.GH_LOG, 'utf8')).not.toContain('microphone')
    })

    it('stuck: an e2e failure alone (the voice specs) does not claim other tests failed', async () => {
      const r = repo()
      const run = r.start(['--ref', 'HEAD', '--jobs', 'browser'], { MIC_FAKE: 'stuck', FAIL_ON: 'test:e2e' })
      expect(await run.done).toBe(1)
      expect(readFileSync(r.env.GH_LOG, 'utf8')).not.toContain('other tests failed too')
    })

    it('a preflight that cannot run fails the job too, never green', async () => {
      const r = repo()
      const run = r.start(['--ref', 'HEAD', '--jobs', 'browser'], { MIC_FAKE: 'error: no browser' })
      expect(await run.done).toBe(1)
      expect(r.log('browser')).toContain('the microphone preflight could not run')
      expect(readFileSync(r.env.GH_LOG, 'utf8')).not.toMatch(/state=success .*context=local-ci\/browser/)
    })

    it('ok: the tests run as before, in order after the preflight', async () => {
      const r = repo()
      const run = r.start(['--ref', 'HEAD', '--jobs', 'browser'])
      expect(await run.done).toBe(0)
      expect(r.log('browser')).toContain('+ node scripts/mic-preflight.mjs')
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
    const at = ['step_contract', 'step_bun_schedules', 'step_bun_rest', 'step_vitest', 'step_capture'].map((s) =>
      log.indexOf(`+ ${s}`),
    )
    expect(at.every((n) => n >= 0)).toBe(true)
    expect(at).toEqual([...at].sort((a, b) => a - b))
    expect(log).toMatch(/\[step\] \d+s exit 0: step_bun_rest/)
  })

  it('a commit forked before the parallel runner still runs the whole bridge suite', async () => {
    const r = repo()
    r.git(r.clone, 'rm', '-q', 'apps/bridge/scripts/test-parallel.ts')
    r.git(r.clone, 'commit', '-qm', 'old')
    expect(await r.start([...noStatus, '--jobs', 'check']).done).toBe(0)
    expect(r.calledLines().some((l) => l.startsWith('pnpm test:bun'))).toBe(true)
  })
})
