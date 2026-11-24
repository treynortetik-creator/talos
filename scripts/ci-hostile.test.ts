// The hostile nightly (docs/CI-MACHINES.md, "The hostile nightly"): main's tests under conditions the other runs never see. Its
// clock shift (scripts/ci-local/hostile-clock.cjs), its conditions and load (scripts/ci-local/hostile.sh), its own contexts
// (hostile-ci/*, never main's verdict) and how the workflow names it. The alert and report are in ci-alert.test.ts. Fakes only:
// a local "origin", a fake gh, sleeping burners (CPU_BURN_IDLE=1).
import { type ChildProcess, execFileSync, spawn, spawnSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest'
import { t as scaled } from '../packages/testkit/src/time-factor.ts'
import { cleanEnv, copyCiLocalParts } from './ci-test-env'
import { fakeTool } from './fake-tool'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')
const SHIM = join(here, 'ci-local', 'hostile-clock.cjs')
const HOSTILE = join(here, 'ci-local', 'hostile.sh')
const LOCKS = join(here, 'ci-local', 'locks.sh')
const RUNNER = join(here, 'ci-runner.sh')
const DAY = 86_400_000
const SHIFT = 30 * DAY
vi.setConfig({ testTimeout: scaled(60_000), hookTimeout: scaled(60_000) })

const dirs: string[] = []
const live: ChildProcess[] = []
afterEach(() => {
  for (const c of live.splice(0)) c.kill('SIGKILL')
})
afterAll(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})
const scratch = () => {
  const d = mkdtempSync(join(tmpdir(), 'cih-'))
  dirs.push(d)
  return d
}
const base = (): Record<string, string> => ({ PATH: process.env.PATH ?? '', HOME: scratch() })
// every process still in a process group (none once it is stopped)
const inGroup = (g: string) =>
  spawnSync('ps', ['-Ao', 'pgid='], { encoding: 'utf8' })
    .stdout.split('\n')
    .filter((l) => l.trim() === g).length

// The probe: how far Date.now() and new Date() are from the clock timers and performance use (performance.timeOrigin + now()),
// in days, and whether timers still fire. The other forms of Date are checked against their real values.
const PROBE = `
const lag = (t) => Math.round((t - (performance.timeOrigin + performance.now())) / ${DAY})
const out = { now: lag(Date.now()), newDate: lag(new Date().getTime()), str: Date().slice(0, 10) }
out.strShift = Math.round((new Date(Date()).getTime() - (performance.timeOrigin + performance.now())) / ${DAY})
out.given = new Date(0).getTime() === 0 && new Date(2026, 0, 2).getDate() === 2 && new Date('2026-03-04T00:00:00Z').getTime() === Date.parse('2026-03-04T00:00:00Z')
out.utc = Date.UTC(2026, 0, 1) === 1767225600000
out.inst = new Date() instanceof Date && Object.prototype.toString.call(new Date()) === '[object Date]' && Date.name === 'Date' && new Date().constructor === Date
class Later extends Date { tomorrow() { return this.getTime() + ${DAY} } }
out.sub = lag(new Later().getTime()) === out.now && new Later() instanceof Date && new Later(5).getTime() === 5
const t0 = performance.now()
let ticks = 0
const iv = setInterval(() => { ticks++ }, 5)
setTimeout(() => {
  clearInterval(iv)
  out.timeout = performance.now() - t0 >= 15
  out.interval = ticks > 0
  console.log(JSON.stringify(out))
}, 20)
`
type Probe = Record<string, unknown>
const probe = (cmd: string, args: string[], env: Record<string, string>): Probe => {
  const d = scratch()
  const f = join(d, 'probe.js')
  writeFileSync(f, PROBE)
  const r = spawnSync(cmd, [...args, f], { env: { ...base(), ...env }, encoding: 'utf8' })
  expect(r.status, r.stderr).toBe(0)
  return JSON.parse(r.stdout.trim().split('\n').pop() as string)
}
const hasBun = spawnSync('bun', ['--version']).status === 0

describe('the clock shim: Date.now and new Date shifted, timers not broken', () => {
  const on = { TALOS_HOSTILE_CLOCK_MS: String(SHIFT), NODE_OPTIONS: `--require=${SHIM}` }

  it('node with NODE_OPTIONS=--require: now is 30 days ahead; given dates, Date.UTC, instanceof and subclasses are real', () => {
    const p = probe('node', [], on)
    expect(p).toMatchObject({ now: 30, newDate: 30, strShift: 30, given: true, utc: true, inst: true, sub: true })
    // timers and performance.now are untouched: a 20 ms timeout fires after at least 15 ms, the interval ticks
    expect(p).toMatchObject({ timeout: true, interval: true })
  })

  it('reaches a worker thread too (the Vitest threads pool)', () => {
    const d = scratch()
    const f = join(d, 'w.mjs')
    writeFileSync(
      f,
      `import { Worker } from 'node:worker_threads'
new Worker('console.log(Math.round((Date.now() - performance.timeOrigin - performance.now()) / ${DAY}))', { eval: true })`,
    )
    const r = spawnSync('node', [f], { env: { ...base(), ...on }, encoding: 'utf8' })
    expect(r.stdout.trim(), r.stderr).toBe('30')
  })

  it('does nothing without the variable, with 0, or with a value that is not a whole number', () => {
    for (const v of [undefined, '0', 'soon', '1e9', '30d', ''])
      expect(
        probe('node', [], {
          NODE_OPTIONS: `--require=${SHIM}`,
          ...(v === undefined ? {} : { TALOS_HOSTILE_CLOCK_MS: v }),
        }),
        String(v),
      ).toMatchObject({
        now: 0,
        newDate: 0,
        timeout: true,
      })
    // a negative shift is a shift too (the clock behind)
    expect(
      probe('node', [], { NODE_OPTIONS: `--require=${SHIM}`, TALOS_HOSTILE_CLOCK_MS: String(-SHIFT) }),
    ).toMatchObject({ now: -30 })
  })

  it('loaded twice (a child that inherits NODE_OPTIONS and adds it again) shifts once', () => {
    const p = probe('node', ['--require', SHIM], on)
    expect(p).toMatchObject({ now: 30, newDate: 30 })
  })

  it.skipIf(!hasBun)('bun with BUN_OPTIONS=--preload: shifted the same, in a script and in `bun test`', () => {
    const p = probe('bun', [], { TALOS_HOSTILE_CLOCK_MS: String(SHIFT), BUN_OPTIONS: `--preload=${SHIM}` })
    expect(p).toMatchObject({
      now: 30,
      newDate: 30,
      given: true,
      utc: true,
      inst: true,
      sub: true,
      timeout: true,
      interval: true,
    })
    const d = scratch()
    writeFileSync(
      join(d, 'a.test.ts'),
      `import { expect, test } from 'bun:test'
test('shifted', () => { expect(Math.round((Date.now() - performance.timeOrigin - performance.now()) / ${DAY})).toBe(30) })`,
    )
    const r = spawnSync('bun', ['test', './a.test.ts'], {
      cwd: d,
      env: { ...base(), TALOS_HOSTILE_CLOCK_MS: String(SHIFT), BUN_OPTIONS: `--preload=${SHIM}` },
      encoding: 'utf8',
    })
    expect(r.status, `${r.stdout}${r.stderr}`).toBe(0)
  })
})

// ci_hostile_setup and ci_hostile_env, sourced as ci-local.sh does
const setupSh = (cache: string, extra = '', env: Record<string, string> = {}) =>
  spawnSync('bash', ['-c', `. "${HOSTILE}"\nci_hostile_setup "${cache}" abc1234 || exit 9\n${extra}`], {
    env: { ...base(), ...env },
    encoding: 'utf8',
  })

describe('ci_hostile_setup and ci_hostile_env: the conditions, said in the log and kept for the report', () => {
  it('a temp base with a space, under the cache (not /tmp, not /var/folders); the four conditions in the log and the file', () => {
    const cache = join(scratch(), 'cache')
    const r = setupSh(cache, 'printf "%s\\n" "$CI_TMP_BASE"')
    expect(r.status, r.stderr).toBe(0)
    const lines = r.stdout.trim().split('\n')
    const tmpBase = lines.pop() as string
    expect(tmpBase).toBe(join(cache, 'hostile tmp'))
    expect(tmpBase).toContain(' ')
    // under the cache (the runner's is ~/.cache/talos-ci), not the system temp folder
    expect(tmpBase.startsWith(`${cache}/`)).toBe(true)
    const cond = readFileSync(join(cache, 'hostile', 'abc1234.conditions'), 'utf8')
    for (const want of [
      /^clock: \+30 days .*not shifted: .*Swift, the shell's date/m,
      /^time zone: TZ=Pacific\/(Kiritimati|Pago_Pago) \([+-]\d{4}\)/m,
      /^temp folder: .*hostile tmp/m,
      /^load: \d+ CPU burner\(s\) \(half the cores/m,
    ])
      expect(cond).toMatch(want)
    // the same lines in the run's log
    expect(lines).toEqual(
      cond
        .trim()
        .split('\n')
        .map((l) => `ci-local: hostile: ${l}`),
    )
    expect(readFileSync(join(cache, 'hostile', 'abc1234.load'), 'utf8')).toBe('') // a fresh load record
  })

  it('the zone is 14 hours east on odd days of the month, 11 hours west on even ones', () => {
    const d = Number(new Date().toISOString().slice(8, 10))
    const r = setupSh(join(scratch(), 'c'), 'TZ="$CI_HOSTILE_TZ" date +%z')
    expect(r.stdout.trim().split('\n').pop()).toBe(d % 2 ? '+1400' : '-1100')
  })

  it('ci_hostile_env: TZ, the shift and both preloads, added to what NODE_OPTIONS and BUN_OPTIONS already had', () => {
    const r = setupSh(
      join(scratch(), 'c'),
      "ci_hostile_env\nnode -e 'console.log(JSON.stringify({tz: process.env.TZ, ms: process.env.TALOS_HOSTILE_CLOCK_MS, no: process.env.NODE_OPTIONS, bo: process.env.BUN_OPTIONS, d: Math.round((Date.now() - performance.timeOrigin - performance.now()) / 864e5), off: new Date().getTimezoneOffset()}))'",
      { NODE_OPTIONS: '--max-old-space-size=4096', BUN_OPTIONS: '--smol' },
    )
    expect(r.status, r.stderr).toBe(0)
    const o = JSON.parse(r.stdout.trim().split('\n').pop() as string)
    expect(o.tz).toMatch(/^Pacific\/(Kiritimati|Pago_Pago)$/)
    expect(o.off).toBe(o.tz === 'Pacific/Kiritimati' ? -840 : 660) // what JavaScript reads: UTC+14 or UTC-11
    expect(o.ms).toBe(String(SHIFT))
    expect(o.no).toBe(`--max-old-space-size=4096 --require=${SHIM}`)
    expect(o.bo).toBe(`--smol --preload=${SHIM}`)
    expect(o.d).toBe(30)
  })
})

// ci_mutex's suites hold with hostile.sh sourced, as ci-local.sh runs it: the real locks.sh, heavy-lock.sh and cpu-burn.sh, with
// sleeping burners. The burner asks heavy-lock.sh whether it runs inside the holder, so this is the real check.
function mutexSh(cmd: string, opts: { name?: string; hostile?: boolean; env?: Record<string, string> } = {}) {
  const T = scratch()
  const cache = join(T, 'cache')
  mkdirSync(join(cache, 'locks'), { recursive: true })
  const src = [
    `. "${LOCKS}"`,
    opts.hostile === false ? '' : `. "${HOSTILE}"\nci_hostile_setup "${cache}" abc1234 >/dev/null || exit 9`,
    `CI_NONCE="t-$$" CI_POLL=0.05 CI_LOCK_TIMEOUT=30 CI_LOCK_GRACE=1 CI_RUNS="${cache}/runs"`,
    `ci_mutex "${cache}/locks" ${opts.name ?? 'suites'} ${cmd}`,
    'echo "rc=$?"',
  ].join('\n')
  const r = spawnSync('bash', ['-c', src], {
    env: { ...base(), CPU_BURN_IDLE: '1', TALOS_HEAVY_GUARD: '/nonexistent', ...opts.env },
    encoding: 'utf8',
    timeout: 50_000,
  })
  const load = existsSync(join(cache, 'hostile', 'abc1234.load'))
    ? readFileSync(join(cache, 'hostile', 'abc1234.load'), 'utf8')
    : ''
  return { ...r, cache, load }
}

describe('the load: a burner beside each hold of the heavy lock, its own pids stopped and checked', () => {
  it('a suites hold runs its command with burners up, passes its exit code through, and leaves none of them', () => {
    // the command sees the burners: cpu-burn.sh's sleeping burners are children of a group the record names afterwards
    const r = mutexSh(
      `bash -c 'n=0; until pgrep -f "seconds 600 -- sleep 600" >/dev/null || [ $n -ge 200 ]; do sleep 0.05; n=$((n+1)); done; pgrep -f "seconds 600 -- sleep 600" >/dev/null && echo saw-burner; exit 3'`,
    )
    expect(r.stdout, r.stderr).toContain('saw-burner')
    expect(r.stdout).toContain('rc=3')
    const g = /burner stopped, none left \(group (\d+)\)/.exec(r.load)?.[1]
    expect(g, `${r.load}\n${r.stderr}`).toBeTruthy()
    expect(inGroup(g as string)).toBe(0)
    expect(r.stderr).toMatch(/ci-local: hostile: load: burner stopped, none left/)
  })

  it('a burner that may not burn (not inside the holder) is "not applied"; the command still runs', () => {
    const T = scratch()
    const lock = join(T, 'fake-lock.sh')
    writeFileSync(lock, '#!/usr/bin/env bash\ncase "$1" in held) exit 1 ;; run) exit 75 ;; esac\n', { mode: 0o755 })
    const r = mutexSh('true', { env: { CPU_BURN_LOCK: lock } })
    expect(r.stdout, r.stderr).toContain('rc=0')
    expect(r.load).toMatch(/^load: not applied to this hold \(cpu-burn: refused/m)
  })

  it('only the suites lock burns, and only with hostile.sh sourced (never a gate or a normal run)', () => {
    expect(mutexSh('true', { name: 'desktop' }).load).toBe('')
    const plain = mutexSh('true', { hostile: false })
    expect(plain.stdout).toContain('rc=0')
    expect(plain.stderr).not.toContain('hostile')
  })
})

// ci-local.sh itself, CI_HOSTILE=1: a fake job reports what it sees. The same harness as ci-local-runner-status.test.ts.
function ciLocal(job: string, hostile = '1') {
  const T = scratch()
  const git = (cwd: string, ...a: string[]) =>
    execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', ...a], { cwd, encoding: 'utf8' }).trim()
  const src = join(T, 'src')
  mkdirSync(src)
  git(src, 'init', '-q', '-b', 'main')
  writeFileSync(join(src, 'a.txt'), 'a\n')
  git(src, 'add', '-A')
  git(src, 'commit', '-qm', 'a')
  const origin = join(T, 'origin.git')
  git(T, 'clone', '-q', '--bare', src, origin)
  const clone = join(T, 'clone')
  git(T, 'clone', '-q', origin, clone)
  const scripts = join(clone, 'scripts')
  mkdirSync(scripts)
  writeFileSync(
    join(scripts, 'ci-local.sh'),
    readFileSync(join(here, 'ci-local.sh'), 'utf8').replace('\ncd "$WT"\n', `\n${job}\ncd "$WT"\n`),
  )
  copyCiLocalParts(scripts)
  for (const h of ['ci-swift-retry.sh', 'ci-flake-vitest.ts', 'cpu-burn.sh', 'heavy-lock.sh'])
    cpSync(join(here, h), join(scripts, h))
  const bin = join(T, 'bin')
  mkdirSync(bin)
  const home = join(T, 'home')
  mkdirSync(home)
  fakeTool(bin, 'gh', '#!/bin/bash\ncase "$1" in repo) exit 1 ;; api) echo "$*" >> "$GH_LOG" ;; esac\n')
  fakeTool(bin, 'pnpm', '#!/bin/bash\nexit 0\n')
  fakeTool(bin, 'bun', '#!/bin/bash\nexit 0\n')
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
    TMPDIR: T,
    CI_REPO: 'owner/repo',
    CI_HOSTILE: hostile,
    CPU_BURN_IDLE: '1',
    TALOS_HEAVY_GUARD: '/nonexistent',
  }
  const child = spawn('bash', [join(scripts, 'ci-local.sh'), '--ref', 'HEAD', '--jobs', 'long'], { cwd: clone, env })
  live.push(child)
  let out = ''
  child.stdout?.on('data', (d) => {
    out += d
  })
  child.stderr?.on('data', (d) => {
    out += d
  })
  const done = new Promise<number>((r) => child.on('exit', (c, s) => r(c ?? (s ? 128 : -1))))
  const cache = join(home, '.cache/talos-ci')
  return {
    done,
    out: () => out,
    home,
    cache,
    posted: () => (existsSync(env.GH_LOG) ? readFileSync(env.GH_LOG, 'utf8') : ''),
    short: git(clone, 'rev-parse', '--short=7', 'HEAD'),
  }
}

describe('ci-local.sh with CI_HOSTILE=1: hostile-ci/* only, and every job runs under the conditions', () => {
  it('the job sees the time zone, the temp folder with a space, the clock shift; it posts hostile-ci/long, never local-ci/*', async () => {
    const r = ciLocal(
      `job_long() { { echo "TZ=$TZ"; echo "TMPDIR=$TMPDIR"; echo "MS=$TALOS_HOSTILE_CLOCK_MS"; echo "NO=$NODE_OPTIONS"; echo "child=$(bash -c 'echo "\${CI_HOSTILE:-unset}"')"
  node -e 'console.log("days=" + Math.round((Date.now() - performance.timeOrigin - performance.now()) / 864e5))'; } > "$HOME/seen"; ci_mutex "$LOCKS" suites true; }`,
    )
    expect(await r.done, r.out()).toBe(0)
    const seen = readFileSync(join(r.home, 'seen'), 'utf8')
    expect(seen).toMatch(/^TZ=Pacific\/(Kiritimati|Pago_Pago)$/m)
    expect(seen).toMatch(new RegExp(`^TMPDIR=${r.cache}/hostile tmp/talos-ci-s1$`, 'm'))
    expect(seen).toContain(`MS=${SHIFT}\n`)
    expect(seen).toMatch(/^NO=.*--require=\S+\/scripts\/ci-local\/hostile-clock\.cjs$/m)
    expect(seen).toContain('days=30\n')
    expect(seen).toContain('child=unset\n') // a test's own ci-local copy never inherits it (export -n)
    const p = r.posted()
    expect(p).toMatch(/state=pending .*context=hostile-ci\/long /)
    expect(p).toMatch(/state=success .*context=hostile-ci\/long /)
    expect(p).not.toMatch(/context=(local-ci|report-ci|ci-part|nightly-ci)\//)
    // the conditions in the run's log and kept for the report; the job's one hold of the heavy lock had its burner
    expect(r.out()).toMatch(/ci-local: hostile: clock: \+30 days/)
    expect(r.out()).toMatch(/ci-local: hostile: temp folder: /)
    expect(readFileSync(join(r.cache, 'hostile', `${r.short}.conditions`), 'utf8')).toMatch(/^time zone: /m)
    expect(readFileSync(join(r.cache, 'hostile', `${r.short}.load`), 'utf8')).toMatch(
      /^load: burner stopped, none left \(group \d+\)$/m,
    )
  })

  it('CI_HOSTILE is 1 or empty: anything else runs nothing', async () => {
    // the fake harness, so a script that let it through would run only the fake job here
    const r = ciLocal('job_long() { : > "$HOME/ran"; }', 'yes')
    expect(await r.done, r.out()).toBe(64)
    expect(r.out()).toContain("CI_HOSTILE is 1 or empty, not 'yes'")
    expect(existsSync(join(r.home, 'ran'))).toBe(false)
    expect(r.posted()).toBe('')
  })
})

// ci-runner.sh: the contexts, the plan, the dispatch wait, the sweep
const SHA = 'a'.repeat(40)
const runnerSh = (code: string, env: Record<string, string> = {}, path?: string) =>
  spawnSync('bash', ['-c', `. "${RUNNER}"\n${code}`], {
    env: { PATH: path ? `${path}:${process.env.PATH}` : (process.env.PATH ?? ''), TMPDIR: tmpdir(), ...env },
    encoding: 'utf8',
  })
const ghBin = (body: string) => {
  const b = scratch()
  writeFileSync(join(b, 'gh'), `#!/bin/bash\n${body}\n`, { mode: 0o755 })
  return b
}

// every machine's runner online, as plan asks the repository's runners (scripts/ci-runner/online.sh)
const planSh = (env: Record<string, string>) =>
  runnerSh(
    'ci_plan',
    { GH_TOKEN: 't', ...env },
    ghBin(`case "$*" in
  *"/actions/runners"*)
    for l in talos-ci talos-ci-delphi talos-ci-cyclops talos-ci-report talos-ci-linux talos-ci-linux-b; do printf 'online\\tself-hosted,%s\\n' "$l"; done ;;
esac`),
  )

describe('ci-runner.sh: the hostile nightly posts under hostile-ci/ and runs only on Lemnos', () => {
  const ctxs = ['local-ci/check', 'ci-part/check', 'report-ci/fast', 'report-ci/linux', 'other/x']
  const map = (file: string, env: Record<string, string>) =>
    spawnSync('bash', ['-c', `. "${file}"\nfor c in ${ctxs.join(' ')}; do ci_ns "$c"; done`], {
      env: { PATH: process.env.PATH ?? '', ...env },
      encoding: 'utf8',
    })
      .stdout.trim()
      .split('\n')
      .join(' ')

  it('ci_ns: hostile-ci/ in ci-runner.sh and locks.sh alike, also on a schedule run (it wins over the nightly)', () => {
    const want = 'hostile-ci/check hostile-ci/part-check hostile-ci/report-fast hostile-ci/report-linux other/x'
    for (const f of [RUNNER, LOCKS]) {
      expect(map(f, { CI_HOSTILE: '1' }), f).toBe(want)
      expect(map(f, { CI_HOSTILE: '1', CI_NIGHTLY: '1' }), f).toBe(want)
      expect(map(f, { CI_NIGHTLY: '1' }), f).toMatch(/^nightly-ci\/check /)
      expect(map(f, {}), f).toBe(ctxs.join(' '))
    }
  })

  it('ci_post_status under CI_HOSTILE posts hostile-ci/<job>, never local-ci/*', () => {
    const T = scratch()
    const b = ghBin(`echo "$*" >> "${T}/posts"`)
    for (const [prefix, job] of [
      ['', 'image'],
      ['ci-part', 'check'],
      ['', 'fast'],
      // Titan's report-only copies (CI_TITAN_HOSTILE=shadow: plan's report-ci prefix)
      ['report-ci', 'check'],
      ['report-ci', 'browser-e2e'],
    ])
      spawnSync('bash', ['-c', `. "${LOCKS}"\nci_post_status owner/talos-app ${SHA} ${job} success words`], {
        env: { PATH: `${b}:${process.env.PATH}`, CI_HOSTILE: '1', CI_STATUS_PREFIX: prefix as string },
        encoding: 'utf8',
      })
    expect(readFileSync(join(T, 'posts'), 'utf8').match(/context=\S+/g)).toEqual([
      'context=hostile-ci/image',
      'context=hostile-ci/part-check',
      'context=hostile-ci/report-fast',
      'context=hostile-ci/report-check',
      'context=hostile-ci/report-browser-e2e',
    ])
  })

  it('the verdict never reads hostile-ci/*: a red hostile run leaves a green push verdict green, and alone is no verdict', () => {
    const six = ['check', 'mod', 'browser', 'image', 'desktop', 'mobile']
    const rows = [
      ...six.map((c) => `hostile-ci/${c}\tfailure\tfailed on ci-runner`),
      ...six.map((c) => `local-ci/${c}\tsuccess\tpassed on ci-runner in 40s`),
    ]
    expect(runnerSh(`ci_classify <<'X'\n${rows.join('\n')}\nX`).stdout.split('\t')[0]).toBe('green')
    expect(runnerSh(`ci_classify <<'X'\n${rows.slice(0, 6).join('\n')}\nX`).stdout.split('\t')[0]).toBe('none')
  })

  it('plan: with every machine switched on, the hostile run plans no part elsewhere', () => {
    const on = {
      GITHUB_EVENT_NAME: 'schedule',
      GITHUB_REF: 'refs/heads/main',
      GITHUB_SHA: SHA,
      GITHUB_REPOSITORY: 'owner/talos-app',
      CI_DELPHI: 'on',
      CI_CYCLOPS: 'on',
      CI_HESTIA: 'on',
      CI_TITAN_IMAGE: 'on',
      CI_TITAN_BROWSER: 'e2e',
      CI_BROWSER_E2E_WAIT: '600',
    }
    const normal = planSh(on).stdout
    expect(normal).toMatch(/^delphi=\S/m) // the nightly does plan them
    const hostile = planSh({ ...on, CI_HOSTILE: '1' })
    expect(hostile.status, hostile.stderr).toBe(0)
    const out = Object.fromEntries(
      hostile.stdout
        .trim()
        .split('\n')
        .map((l) => l.split(/=(.*)/s).slice(0, 2)),
    )
    expect(out.sha).toBe(SHA)
    for (const k of Object.keys(out).filter((k) => k !== 'sha')) expect(out[k], k).toBe('')
  })

  describe('plan: CI_TITAN_HOSTILE=shadow also sends check and the e2e packages to Titan, report-only', () => {
    const on = {
      GITHUB_EVENT_NAME: 'schedule',
      GITHUB_REF: 'refs/heads/main',
      GITHUB_SHA: SHA,
      GITHUB_REPOSITORY: 'owner/talos-app',
      CI_HOSTILE: '1',
      CI_DELPHI: 'on',
      CI_CYCLOPS: 'on',
      CI_HESTIA: 'on',
      CI_TITAN_IMAGE: 'on',
      CI_TITAN_BROWSER: 'e2e',
      CI_BROWSER_E2E_WAIT: '600',
      CI_TITAN_CHECK: 'on',
      CI_CHECK_WAIT: '900',
    }
    const plan = (env: Record<string, string>) => {
      const r = planSh(env)
      expect(r.status, r.stderr).toBe(0)
      return {
        out: Object.fromEntries(
          r.stdout
            .trim()
            .split('\n')
            .map((l) => l.split(/=(.*)/s).slice(0, 2)),
        ) as Record<string, string>,
        err: r.stderr,
      }
    }
    const rest = (o: Record<string, string>) =>
      Object.entries(o).filter(([k]) => !['sha', 'check_titan', 'browser_e2e', 'linux_label'].includes(k))

    it('shadow: check_titan and browser_e2e are report-ci on titan-b; nothing else goes anywhere, nothing waits for them', () => {
      const { out } = plan({ ...on, CI_TITAN_HOSTILE: 'shadow' })
      expect(out.check_titan).toBe('report-ci')
      expect(out.browser_e2e).toBe('report-ci')
      // Titan's second runner: a push landing during the hostile run never queues its Titan jobs behind these
      expect(out.linux_label).toBe('talos-ci-linux-b')
      expect(
        plan({ ...on, CI_HOSTILE: '', GITHUB_EVENT_NAME: 'push', CI_TITAN_HOSTILE: 'shadow' }).out.linux_label,
      ).toBe('')
      const paused = { ...on, CI_TITAN_BROWSER: 'off', CI_TITAN_CHECK: 'off', CI_TITAN_HOSTILE: 'shadow' }
      expect(plan(paused).out.linux_label).toBe('') // nothing on Titan: no label either
      for (const [k, v] of rest(out)) expect(v, k).toBe('') // no wait, no fold, no image, no shards, no Hestia
    })

    it('shadow with the push switches in shadow too: the same; a push is untouched by it', () => {
      const env = { ...on, CI_TITAN_CHECK: 'shadow', CI_TITAN_BROWSER: 'e2e-shadow', CI_TITAN_HOSTILE: 'shadow' }
      expect(plan(env).out).toMatchObject({
        check_titan: 'report-ci',
        browser_e2e: 'report-ci',
        e2e_wait: '',
        check_wait: '',
      })
      const push = plan({ ...on, CI_HOSTILE: '', GITHUB_EVENT_NAME: 'push', CI_TITAN_HOSTILE: 'shadow' }).out
      expect(push).toMatchObject({ check_titan: 'ci-part', check_wait: '900', browser_e2e: 'ci-part', e2e_wait: '600' })
    })

    it('the gaming pause (all three Titan switches off) keeps the hostile parts off Titan; each follows its own switch', () => {
      const paused = {
        ...on,
        CI_TITAN_IMAGE: 'off',
        CI_TITAN_BROWSER: 'off',
        CI_TITAN_CHECK: 'off',
        CI_TITAN_HOSTILE: 'shadow',
      }
      expect(plan(paused).out).toMatchObject({ check_titan: '', browser_e2e: '' })
      expect(plan({ ...on, CI_TITAN_CHECK: 'off', CI_TITAN_HOSTILE: 'shadow' }).out).toMatchObject({
        check_titan: '',
        browser_e2e: 'report-ci',
      })
      // on without its wait plans nothing on Titan for a push, so nothing for the hostile run either
      const noWait = { ...on, CI_BROWSER_E2E_WAIT: '', CI_TITAN_HOSTILE: 'shadow' }
      expect(plan(noWait).out).toMatchObject({ check_titan: 'report-ci', browser_e2e: '' })
    })

    it('off, unset or an unknown value: everything on Lemnos, as before; an unknown value says so', () => {
      for (const v of ['off', ''])
        for (const [k, x] of Object.entries(plan({ ...on, CI_TITAN_HOSTILE: v }).out))
          if (k !== 'sha') expect(x, `${v}:${k}`).toBe('')
      const odd = plan({ ...on, CI_TITAN_HOSTILE: 'on' })
      for (const [k, x] of Object.entries(odd.out)) if (k !== 'sha') expect(x, k).toBe('')
      expect(odd.err).toContain("CI_TITAN_HOSTILE 'on' is not off or shadow; taken as off")
    })

    it('a schedule on a day a dispatched hostile nightly already ran still hands Titan nothing', () => {
      const H = scratch()
      const env = { ...on, CI_TITAN_HOSTILE: 'shadow', HOME: H, TALOS_CI_CACHE: join(H, 'cache') }
      const m = runnerSh(`. "${join(here, 'ci-runner/schedule.sh')}"\nci_dispatch_marker hostile`, env).stdout.trim()
      mkdirSync(dirname(m), { recursive: true })
      writeFileSync(m, '')
      for (const [k, x] of Object.entries(plan(env).out)) if (k !== 'sha') expect(x, k).toBe('')
    })
  })

  it('dispatch-wait: a hostile dispatch is never closed as superseded, and reads nothing from GitHub', () => {
    const T = scratch()
    const b = ghBin(`echo "$*" >> "${T}/gh"; exit 1`)
    const o = join(T, 'out')
    const r = runnerSh(
      `. "${join(here, 'ci-runner/main-queue.sh')}"\nci_dispatch_wait`,
      {
        GITHUB_EVENT_NAME: 'workflow_dispatch',
        CI_HOSTILE: '1',
        CI_PLAN_SHA: SHA,
        GITHUB_REPOSITORY: 'o/r',
        GITHUB_OUTPUT: o,
      },
      b,
    )
    expect(r.status, r.stderr).toBe(0)
    expect(readFileSync(o, 'utf8')).toBe('superseded=false\n')
    expect(existsSync(join(T, 'gh'))).toBe(false)
  })

  it('the sweep closes a pending hostile-ci/* the run left, under its own link', () => {
    const T = scratch()
    writeFileSync(join(T, 'sha'), `${SHA}\n`)
    const b = ghBin(
      `case "$*" in *"-X POST"*) echo "$*" >> "${T}/posts" ;; *"/status?"*) printf 'hostile-ci/check\\tpending\\thttps://r/1\\n' ;; *) printf 'hostile-ci/check\\tpending\\thttps://r/1\\n' ;; esac`,
    )
    const r = spawnSync('bash', [RUNNER, 'sweep'], {
      env: {
        PATH: `${b}:${process.env.PATH}`,
        CI_SHA_FILE: join(T, 'sha'),
        CI_STATUS_URL: 'https://r/1',
        GITHUB_REPOSITORY: 'o/r',
      },
      encoding: 'utf8',
    })
    expect(r.status, r.stderr).toBe(0)
    expect(readFileSync(join(T, 'posts'), 'utf8')).toContain('context=hostile-ci/check')
  })
})

// The workflow: a second schedule and a dispatch input name the hostile run (CI_HOSTILE), in a group of its own, never cancelled
// by a push or the nightly. GitHub's expressions evaluated as GitHub would (&& and || return an operand; == is ===).
describe('ci-runner.yml: the hostile nightly by its own schedule, or by hand', () => {
  const yml = readFileSync(join(root, '.github/workflows/ci-runner.yml'), 'utf8')
  const evalExpr = (raw: string, github: object, inputs: object) => {
    const body = (/\$\{\{ (.*) \}\}/.exec(raw)?.[1] ?? raw).replace(/ == /g, ' === ').replace(/ != /g, ' !== ')
    const format = (f: string, ...a: unknown[]) => f.replace(/\{(\d)\}/g, (_, i) => String(a[Number(i)]))
    return new Function('github', 'inputs', 'format', `return (${body})`)(github, inputs, format)
  }
  const line = (re: RegExp) => re.exec(yml)?.[1] as string
  const hostileExpr = line(/^env:\n {2}CI_HOSTILE: (.*)$/m)
  const groupExpr = line(/^ {2}group: ci-runner-(.*)$/m)
  const cancelExpr = line(/^ {2}cancel-in-progress: (.*)$/m)
  const cron = (c: string) => ({ event_name: 'schedule', event: { schedule: c } })
  const dispatch = { event_name: 'workflow_dispatch', event: {} }

  it("plan reads CI_TITAN_HOSTILE; Lemnos's two shadow compares never run for the hostile nightly", () => {
    expect(yml).toMatch(/\n {6}CI_TITAN_HOSTILE: \$\{\{ vars\.CI_TITAN_HOSTILE \}\}\n/)
    expect(yml).toMatch(/\n {6}linux_label: \$\{\{ steps\.plan\.outputs\.linux_label \}\}\n/)
    // browser-e2e and check-titan take plan's label (titan-b for the hostile copies), the image job its own
    for (const job of ['browser-e2e', 'check-titan']) {
      const body = yml.slice(yml.indexOf(`\n  ${job}:\n`) + 1).split(/\n {2}\S/)[0]
      expect(body, job).toContain(
        `runs-on: [self-hosted, Linux, "\${{ needs.plan.outputs.linux_label || 'talos-ci-linux' }}"]`,
      )
    }
    const titanJob = yml.slice(yml.indexOf('\n  titan:\n') + 1).split(/\n {2}\S/)[0]
    expect(titanJob).toContain('runs-on: [self-hosted, Linux, talos-ci-linux]\n')
    for (const name of [
      "Compare Titan's e2e packages with Lemnos's (shadow)",
      "Compare Titan's check with Lemnos's, test by test (shadow)",
    ]) {
      const at = yml.indexOf(`- name: ${name}`)
      expect(at, name).toBeGreaterThan(0)
      expect(yml.slice(at).split('\n')[1], name).toContain("&& env.CI_HOSTILE != '1' &&")
    }
  })

  it('two schedules: the nightly and the hostile one, at another hour; a boolean dispatch input', () => {
    expect([...yml.matchAll(/^ {4}- cron: "([^"]+)"/gm)].map((m) => m[1])).toEqual(['17 9 * * *', '43 11 * * *'])
    expect(yml).toMatch(/\n {6}hostile:\n {8}description: .*\n {8}type: boolean\n {8}default: false\n/)
  })

  it('CI_HOSTILE is 1 for the hostile schedule and a hostile dispatch only, for every job of the run', () => {
    expect(hostileExpr).toBeTruthy()
    expect(evalExpr(hostileExpr, cron('43 11 * * *'), {})).toBe('1')
    expect(evalExpr(hostileExpr, dispatch, { hostile: true, ref: 'main' })).toBe('1')
    expect(evalExpr(hostileExpr, cron('17 9 * * *'), {})).toBe('')
    expect(evalExpr(hostileExpr, dispatch, { hostile: false, ref: 'main' })).toBe('')
    for (const e of ['push', 'pull_request'])
      expect(evalExpr(hostileExpr, { event_name: e, event: {} }, {}), e).toBe('')
  })

  it('a nightly dispatch input: nightly=hostile is the hostile run; nightly=nightly the nightly group; none is a plain dispatch', () => {
    expect(yml).toMatch(
      /\n {6}nightly:\n {8}description: .*\n {8}type: choice\n {8}options: \[none, nightly, hostile\]\n {8}default: none\n/,
    )
    const dispatchedExpr = line(/^ {2}CI_DISPATCH_NIGHTLY: (.*)$/m)
    const group = (i: object) => evalExpr(groupExpr, dispatch, i)
    const cancel = (i: object) => evalExpr(cancelExpr, dispatch, i)
    expect(evalExpr(hostileExpr, dispatch, { hostile: false, nightly: 'hostile', ref: 'main' })).toBe('1')
    expect(evalExpr(hostileExpr, dispatch, { hostile: false, nightly: 'nightly', ref: 'main' })).toBe('')
    expect(evalExpr(hostileExpr, dispatch, { hostile: false, nightly: 'none', ref: 'main' })).toBe('')
    expect(evalExpr(dispatchedExpr, dispatch, { nightly: 'hostile' })).toBe('hostile')
    expect(evalExpr(dispatchedExpr, dispatch, { nightly: 'nightly' })).toBe('nightly')
    expect(evalExpr(dispatchedExpr, dispatch, { nightly: 'none' })).toBe('')
    expect(evalExpr(dispatchedExpr, cron('17 9 * * *'), {})).toBe('')
    expect(group({ nightly: 'hostile', ref: 'main', jobs: '' })).toBe('hostile')
    expect(group({ nightly: 'nightly', ref: 'main', jobs: '' })).toBe('nightly') // the schedule's own group: never two at once
    expect(group({ nightly: 'none', ref: 'main', jobs: '' })).toBe('ref-main-')
    expect(cancel({ nightly: 'hostile' })).toBe(false)
    expect(cancel({ nightly: 'nightly' })).toBe(false)
    expect(cancel({ nightly: 'none' })).toBe(true)
  })

  it('its own group, never cancelled; the nightly, pushes and plain dispatches keep theirs', () => {
    const group = (g: object, i: object = {}) => evalExpr(groupExpr, g, i)
    const cancel = (g: object, i: object = {}) => evalExpr(cancelExpr, g, i)
    expect(group(cron('43 11 * * *'))).toBe('hostile')
    expect(group(dispatch, { hostile: true, ref: 'main', jobs: '' })).toBe('hostile')
    expect(group(cron('17 9 * * *'))).toBe('nightly')
    expect(group({ event_name: 'push', event: {} })).toBe('main')
    expect(group(dispatch, { hostile: false, ref: 'main', jobs: '' })).toBe('ref-main-')
    expect(cancel(cron('43 11 * * *'))).toBe(false)
    expect(cancel(dispatch, { hostile: true })).toBe(false)
    expect(cancel(dispatch, { hostile: false })).toBe(true)
  })

  it('the green job is for a push only, so a hostile run never moves green', () => {
    const green = yml.split('\n  green:\n')[1]?.split('\n  close:\n')[0] as string
    expect(green).toMatch(
      /if: \$\{\{ !cancelled\(\) && github\.event_name == 'push' && github\.ref == 'refs\/heads\/main' && needs\.ci\.outputs\.superseded != 'true' \}\}/,
    )
  })
})
