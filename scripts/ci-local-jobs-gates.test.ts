// ci-local.sh gates, split from ci-local-jobs.test.ts so the two run side by side: the same harness, the same tests.
import { type ChildProcess, execFileSync, spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest'
import { cleanEnv, copyCiLocalParts } from './ci-test-env'
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

/** The real script with these job functions added, in a clone of a one-commit repo with fake tools on the PATH. */
function repo(jobs = '', tools: Record<string, string> = {}) {
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
  copyCiLocalParts(join(clone, 'scripts')) // the parts ci-local.sh sources in place
  const bin = join(T, 'bin')
  mkdirSync(bin)
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
})
