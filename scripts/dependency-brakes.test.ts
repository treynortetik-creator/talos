// The two brakes on the supply chain, checked where they live: a day's wait before pnpm picks a new package version, and a
// known-vulnerability audit of the production dependencies in every place checks run (the cloud workflow and ci-local.sh).
// The plain `pnpm audit` is not used: it also reports dev-only tools that never ship, and would fail on those.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const root = join(import.meta.dirname, '..')
const read = (p: string) => readFileSync(join(root, p), 'utf8')
const code = (t: string) => t.replace(/^\s*#.*$/gm, '')

describe('dependency brakes', () => {
  it('pnpm waits at least one day (1440 minutes) before it picks a new version, with no package exempted', () => {
    const ws = code(read('pnpm-workspace.yaml'))
    const age = /^minimumReleaseAge:\s*(\d+)\s*$/m.exec(ws)
    expect(age, 'minimumReleaseAge is set in pnpm-workspace.yaml').not.toBeNull()
    expect(Number(age?.[1])).toBeGreaterThanOrEqual(1440)
    expect(ws).not.toMatch(/minimumReleaseAgeExclude/)
  })

  it('the pinned pnpm is one that reads that setting (10.16 or newer)', () => {
    const pm = /^pnpm@(\d+)\.(\d+)\./.exec(JSON.parse(read('package.json')).packageManager)
    expect(pm).not.toBeNull()
    const [major, minor] = [Number(pm?.[1]), Number(pm?.[2])]
    expect(major > 10 || (major === 10 && minor >= 16)).toBe(true)
  })

  it('the cloud workflow audits production dependencies (high and above) last in the check job, even after a red step, and only warns', () => {
    const ci = read('.github/workflows/ci.yml')
    const check = ci.slice(ci.indexOf('\n  check:'), ci.indexOf('\n  mod:'))
    expect(check).toMatch(/run: pnpm audit --prod --audit-level high\s*$/m)
    expect(check.indexOf('pnpm audit --prod')).toBeGreaterThan(check.indexOf('run: pnpm test'))
    expect(check).toMatch(/continue-on-error: true\s*\n\s*if: \$\{\{ !cancelled\(\) \}\}\s*\n\s*run: pnpm audit/)
    expect(ci).not.toMatch(/pnpm audit(?! --prod --audit-level high)/)
  })

  it('ci-local.sh runs the same audit in its check job, as a warning', () => {
    const sh = read('scripts/ci-local.sh')
    const job = sh.slice(sh.indexOf('job_check() {'), sh.indexOf('claude_at()'))
    expect(job).toMatch(/warn_step check "\$log" "[^"]+" pnpm audit --prod --audit-level high\n/)
    expect(sh).not.toMatch(/pnpm audit(?! --prod --audit-level high)/)
  })
})
