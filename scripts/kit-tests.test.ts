// Runs every kit/scripts/test-*.sh, and kit/scripts/self-test.sh (required: see kitLaneScripts), the way a new owner's machine would: a short TMPDIR, an empty temp HOME, no XDG_* variables,
// no network opt-ins. Each script is its own test, so a failure names the script. A script that cannot run on this platform is
// listed in PLATFORM_ONLY and skipped by name with its reason printed; nothing is skipped without appearing in that list.
// Lines a script prints that start with "skip" (sub-checks it left out) are echoed too, so they are never silent: each one is
// matched against KNOWN_SKIPS in kit-run.ts and printed with its reason, or marked UNLISTED when nobody wrote a reason down.
// A script that hangs is killed together with everything it started (see kit-run.ts) and fails with the output it had printed.
import { execFileSync, spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it, vi } from 'vitest'
import { t as scaled } from '../packages/testkit/src/time-factor.ts'
import { classifySkips, failureReport, kitLaneScripts, runScript } from './kit-run.ts'
import { ROOT } from './size-report.ts'

const KIT_SCRIPTS = join(ROOT, 'kit/scripts')
const TIMEOUT_MS = 300_000

/**
 * Script name -> its own time cap (scaled by the time factor below). test-default-agent.sh renders the kit and runs the whole
 * self-test.sh inside it: about 2.5 min alone on a quiet Mac, about 4 min on a loaded one, so the 300 s default is no room when
 * CI runs several jobs at once. test-update.sh (about 155 s with other suites running) and test-install.sh (about 103 s) each
 * hit the 290 s kill of the 300 s default in a loaded gate at factor 1 (a Mac with more than 4 cores), while the scripts were fine.
 */
const SLOW_MS: Record<string, number> = {
  'test-default-agent.sh': 600_000,
  'test-update.sh': 600_000,
  'test-install.sh': 600_000,
}

/** Script name -> the platform it needs and why. Empty today: every kit test fakes `say`, `afplay` and `launchctl`, so all run anywhere. */
const PLATFORM_ONLY: Record<string, { platform: NodeJS.Platform; reason: string }> = {}

function scriptEnv(home: string, tmp: string, name = ''): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [k, v] of Object.entries(process.env)) {
    if (v === undefined || k.startsWith('XDG_') || k.startsWith('TALOS_TEST_') || k.startsWith('GIT_')) continue
    env[k] = v
  }
  // test-default-agent.sh runs self-test.sh, which runs most of these scripts again. This file runs each one already, so the
  // second run is left out, except in the full CI run (`ci-local.sh --full` sets TALOS_KIT_FULL_SELF_TEST=1), which keeps one
  // run of them inside a rendered agent folder.
  // self-test.sh itself, run here as a lane member, never runs them: they would be a third run on the full one.
  const full = process.env.TALOS_KIT_FULL_SELF_TEST === '1' && name !== 'self-test.sh'
  const suites = { TALOS_SELF_TEST_SUITES: full ? 'run' : 'skip' }
  // the machine's time factor is the one TALOS_TEST_ value the scripts read (a speed budget scales with it, as every test's does)
  const factor = process.env.TALOS_TEST_TIME_FACTOR
    ? { TALOS_TEST_TIME_FACTOR: process.env.TALOS_TEST_TIME_FACTOR }
    : {}
  return { ...env, ...suites, ...factor, HOME: home, TMPDIR: tmp, PYTHONDONTWRITEBYTECODE: '1' }
}

function skipReason(name: string, platform: NodeJS.Platform): string | undefined {
  const entry = PLATFORM_ONLY[name]
  return entry && entry.platform !== platform ? `${name} needs ${entry.platform}: ${entry.reason}` : undefined
}

// every test-*.sh, and self-test.sh (a required member, see LANE_REQUIRED_EXTRA in kit-run.ts)
const scripts = kitLaneScripts(KIT_SCRIPTS)

describe('kit test scripts', () => {
  it('finds the kit test scripts, and PLATFORM_ONLY names only scripts that exist', () => {
    expect(scripts.length).toBeGreaterThan(10)
    for (const name of Object.keys(PLATFORM_ONLY)) expect(scripts).toContain(name)
  })

  it('the lane runs self-test.sh itself, so a kit change cannot land while it fails', () => {
    expect(scripts).toContain('self-test.sh')
    expect(scripts.filter((n) => n === 'self-test.sh')).toHaveLength(1)
  })

  it('the lane runs self-test.sh with its suites left out, even on the full run: test-*.sh and test-default-agent.sh run them already', () => {
    try {
      for (const full of [undefined, '1']) {
        vi.stubEnv('TALOS_KIT_FULL_SELF_TEST', full)
        expect(scriptEnv('/h', '/t', 'self-test.sh').TALOS_SELF_TEST_SUITES, String(full)).toBe('skip')
      }
    } finally {
      vi.unstubAllEnvs()
    }
  })

  it('SLOW_MS names only scripts that exist', () => {
    for (const name of Object.keys(SLOW_MS)) expect(scripts).toContain(name)
  })

  it('self-test.sh inside test-default-agent.sh leaves out the suites this file runs on their own, unless it is the full run', () => {
    // Both branches are set here, whatever the run around this test set: a --full CI run exports TALOS_KIT_FULL_SELF_TEST=1.
    try {
      for (const outside of [undefined, '0', 'yes']) {
        if (outside === undefined) vi.stubEnv('TALOS_KIT_FULL_SELF_TEST', undefined)
        else vi.stubEnv('TALOS_KIT_FULL_SELF_TEST', outside)
        expect(scriptEnv('/h', '/t').TALOS_SELF_TEST_SUITES, String(outside)).toBe('skip')
      }
      vi.stubEnv('TALOS_KIT_FULL_SELF_TEST', '1')
      // 'run', not unset: a skip exported in the environment must not reach the one full run
      vi.stubEnv('TALOS_SELF_TEST_SUITES', 'skip')
      expect(scriptEnv('/h', '/t').TALOS_SELF_TEST_SUITES).toBe('run')
    } finally {
      vi.unstubAllEnvs()
    }
  })

  it("upgrade.sh's gate always runs self-test.sh with its suites, whatever the environment says", () => {
    const gate = readFileSync(join(KIT_SCRIPTS, 'upgrade.sh'), 'utf8')
      .split('\n')
      .filter((l) => l.includes('bash scripts/self-test.sh') && !/^\s*(red|echo|printf|#)/.test(l)) // runs, not advice text
    expect(gate.length).toBeGreaterThan(0)
    for (const l of gate) expect(l).toContain('TALOS_SELF_TEST_SUITES=run ')
  })

  it('self-test.sh runs every kit suite through suite(), and each one is a script this file runs', () => {
    const text = readFileSync(join(KIT_SCRIPTS, 'self-test.sh'), 'utf8')
    expect(text).not.toMatch(/bash "\$KIT\/scripts\/test-/)
    const named = [...text.matchAll(/suite "\$KIT\/scripts\/(test-[a-z-]+\.sh)"/g)].map((m) => m[1])
    expect(named.length).toBeGreaterThan(5)
    for (const n of named) expect(scripts).toContain(n)
    expect(text).toContain('suite "$KIT/scripts/test-$_n.sh"') // the loop over the 1.2 feature suites
  })

  it('suite() runs the script and reports it, or with TALOS_SELF_TEST_SUITES=skip runs nothing and says it skipped', () => {
    const text = readFileSync(join(KIT_SCRIPTS, 'self-test.sh'), 'utf8')
    const fn = /^suite\(\) \{[\s\S]*?^\}$/m.exec(text)?.[0] as string
    expect(fn).toBeTruthy()
    const d = mkdtempSync(join(tmpdir(), 'kst-'))
    try {
      const stub = join(d, 'test-x.sh')
      writeFileSync(stub, `echo ran >> "${d}/ran"\nexit 0\n`)
      chmodSync(stub, 0o755)
      const call = (env: Record<string, string>) =>
        spawnSync(
          'bash',
          ['-c', `ok() { echo "PASS $1"; }\nbad() { echo "FAIL $1"; }\n${fn}\nsuite "${stub}" good worse`],
          {
            encoding: 'utf8',
            env: { PATH: process.env.PATH as string, ...env },
          },
        ).stdout
      expect(call({ TALOS_SELF_TEST_SUITES: 'skip' })).toMatch(/^PASS skipped.*test-x\.sh/)
      expect(existsSync(join(d, 'ran'))).toBe(false)
      expect(call({})).toBe('PASS good\n')
      expect(existsSync(join(d, 'ran'))).toBe(true)
      writeFileSync(stub, 'exit 1\n')
      expect(call({})).toBe('FAIL worse\n')
    } finally {
      rmSync(d, { recursive: true, force: true })
    }
  })

  it('hands each script a temp HOME, a TMPDIR and no XDG_* variable', () => {
    const env = scriptEnv('/h', '/t')
    expect(env.HOME).toBe('/h')
    expect(env.TMPDIR).toBe('/t')
    expect(Object.keys(env).filter((k) => k.startsWith('XDG_'))).toEqual([])
  })

  for (const name of scripts) {
    const reason = skipReason(name, process.platform)
    if (reason) {
      console.warn(`SKIPPED ${reason}`)
      it.skip(`${name} (${reason})`, () => {})
      continue
    }
    // x TALOS_TEST_TIME_FACTOR like every test budget: a flat cap killed test-hub-fence.sh (163 s alone) and test-update.sh at
    // 290 s in a loaded gate (factor 3), while the script itself was fine
    const timeoutMs = scaled(SLOW_MS[name] ?? TIMEOUT_MS)
    it.concurrent(name, { timeout: timeoutMs }, async () => {
      // Kill the script a little before the test timeout, so a hang reports as a failure with its output.
      const { code, out } = await runScript(join(KIT_SCRIPTS, name), {
        cwd: join(ROOT, 'kit'),
        timeoutMs: timeoutMs - 10_000,
        env: (home, tmp) => scriptEnv(home, tmp, name),
      })
      for (const { line, reason } of classifySkips(name, out))
        console.warn(`${name}: ${line} [${reason ?? 'UNLISTED skip: add it to KNOWN_SKIPS in kit-run.ts'}]`)
      expect(code, failureReport(out)).toBe(0)
    })
  }

  afterAll(() => {
    // The scripts must not leave files in kit/ (that would also break the tree check in kit-source.test.ts).
    const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('GIT_')))
    const status = execFileSync('git', ['status', '--porcelain', '--', 'kit'], { cwd: ROOT, encoding: 'utf8', env })
    expect(status).toBe('')
  })
})
