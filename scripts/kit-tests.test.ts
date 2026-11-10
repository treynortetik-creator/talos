// Runs every kit/scripts/test-*.sh the way a new owner's machine would: a short TMPDIR, an empty temp HOME, no XDG_* variables,
// no network opt-ins. Each script is its own test, so a failure names the script. A script that cannot run on this platform is
// listed in PLATFORM_ONLY and skipped by name with its reason printed; nothing is skipped without appearing in that list.
// Lines a script prints that start with "skip" (sub-checks it left out) are echoed too, so they are never silent: each one is
// matched against KNOWN_SKIPS in kit-run.ts and printed with its reason, or marked UNLISTED when nobody wrote a reason down.
// A script that hangs is killed together with everything it started (see kit-run.ts) and fails with the output it had printed.
import { execFileSync } from 'node:child_process'
import { readdirSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { classifySkips, failureReport, runScript } from './kit-run.ts'
import { ROOT } from './size-report.ts'

const KIT_SCRIPTS = join(ROOT, 'kit/scripts')
const TIMEOUT_MS = 300_000

/**
 * Script name -> its own time cap. test-default-agent.sh renders the kit and runs the whole self-test.sh inside it: about 2.5 min
 * alone on a quiet Mac, about 4 min on a loaded one, so the 300 s default is no room when CI runs several jobs at once.
 */
const SLOW_MS: Record<string, number> = { 'test-default-agent.sh': 600_000 }

/** Script name -> the platform it needs and why. Empty today: every kit test fakes `say`, `afplay` and `launchctl`, so all run anywhere. */
const PLATFORM_ONLY: Record<string, { platform: NodeJS.Platform; reason: string }> = {}

function scriptEnv(home: string, tmp: string): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [k, v] of Object.entries(process.env)) {
    if (v === undefined || k.startsWith('XDG_') || k.startsWith('TALOS_TEST_') || k.startsWith('GIT_')) continue
    env[k] = v
  }
  return { ...env, HOME: home, TMPDIR: tmp, PYTHONDONTWRITEBYTECODE: '1' }
}

function skipReason(name: string, platform: NodeJS.Platform): string | undefined {
  const entry = PLATFORM_ONLY[name]
  return entry && entry.platform !== platform ? `${name} needs ${entry.platform}: ${entry.reason}` : undefined
}

const scripts = readdirSync(KIT_SCRIPTS)
  .filter((f) => /^test-.*\.sh$/.test(f))
  .sort()

describe('kit test scripts', () => {
  it('finds the kit test scripts, and PLATFORM_ONLY names only scripts that exist', () => {
    expect(scripts.length).toBeGreaterThan(10)
    for (const name of Object.keys(PLATFORM_ONLY)) expect(scripts).toContain(name)
  })

  it('SLOW_MS names only scripts that exist', () => {
    for (const name of Object.keys(SLOW_MS)) expect(scripts).toContain(name)
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
    const timeoutMs = SLOW_MS[name] ?? TIMEOUT_MS
    it.concurrent(name, { timeout: timeoutMs }, async () => {
      // Kill the script a little before the test timeout, so a hang reports as a failure with its output.
      const { code, out } = await runScript(join(KIT_SCRIPTS, name), {
        cwd: join(ROOT, 'kit'),
        timeoutMs: timeoutMs - 10_000,
        env: scriptEnv,
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
