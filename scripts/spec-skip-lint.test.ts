// No browser spec skips a test by machine (scripts/spec-skip-lint.ts; docs/CI-MACHINES.md, "browser in two places"): the scan's
// own cases, then every *.spec.ts in the repository. So the gate runs it when a spec changes (scripts/gate.sh, guards_reading):
// gate-reads: *.spec.ts
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { machineSkips } from './spec-skip-lint'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const why = (src: string) => machineSkips(src).map((f) => f.why)

describe('the scan', () => {
  it.each([
    ["test.skip(process.platform === 'linux', 'Linux WebKit')", 'the platform'],
    ["test.fixme(os.platform() !== 'darwin')", 'the platform'],
    ["test.describe.skip(platform() === 'linux')", 'the platform'],
    [
      "test.beforeEach(({ browserName }) => test.skip(browserName === 'webkit' && process.platform === 'linux', 'x'))",
      'the platform',
    ],
    ["test.skip(() => process.platform === 'linux', 'x')", 'the platform'],
    ["test.skip(os.hostname() === 'titan', 'x')", 'the host name'],
    ["test.skip(!!process.env.CI, 'slow on CI')", 'a CI variable'],
    ["test.skip(process.env['GITHUB_ACTIONS'] === 'true')", 'a CI variable'],
    ["test.skip(Boolean(process.env.TALOS_MACHINE), 'x')", 'a CI variable'],
    ["test.skip(!!process.env.WSL_DISTRO_NAME, 'x')", 'WSL'],
    ["test.skip(readFileSync('/proc/version', 'utf8').includes('microsoft'))", 'WSL'],
    ["test.skip(onLinux, 'x')", 'a helper named onLinux'],
    ["test.skip(isWsl(), 'x')", 'a helper named isWsl'],
    ["const slow = process.platform === 'linux'\ntest.skip(slow, 'x')", 'the platform'],
    ["const a = process.env.CI\nconst b = !!a\ntest.skip(b, 'x')", 'a CI variable'],
    ["if (process.platform === 'linux') test.skip()", 'the platform'],
    ["if (process.env.CI) {\n  test.skip(true, 'not here')\n}", 'a CI variable'],
    ["process.platform === 'linux' && test.skip()", 'the platform'],
  ])('refuses %s', (src, expected) => {
    expect(why(src)).toContain(expected)
  })

  it.each([
    "test.skip(browserName === 'webkit', 'WebKit does not Tab to buttons by default')",
    "test.skip(info.project.name !== 'desktop', 'mouse selection')",
    "test.beforeEach(({ page }) => test.skip(isPhoneWidth(page), 'the phone has its own sheet'))",
    "test.skip(({ isMobile }) => isMobile, 'desktop pointer only')",
    "test.skip(!process.env.TALOS_SHOTS, 'screenshots are rewritten only with TALOS_SHOTS=1')",
    // skipped everywhere (a title and a body): its body may mention anything
    "test.skip('old flow', async () => { if (process.platform === 'linux') return })",
    // the reason may name the machine; only the condition counts
    "test.skip(browserName === 'webkit', 'WebKit on Linux and WSL plays no media')",
    // not a skip: a platform check that changes what a test loads (the temporary .mov abort) is not this scan's
    "test.beforeEach(async ({ page, browserName }) => { if (browserName === 'webkit' && process.platform === 'linux') await page.route('**/*.mov', (r) => r.abort()) })",
    'const t = { skip: 1 }\nif (x) t.skip',
  ])('lets %s through', (src) => {
    expect(machineSkips(src)).toEqual([])
  })

  it('names the line', () => {
    expect(machineSkips("import x\n\ntest('a', () => {\n  test.skip(process.platform === 'linux')\n})")).toEqual([
      { line: 4, text: "test.skip(process.platform === 'linux')", why: 'the platform' },
    ])
  })
})

describe('the repository', () => {
  it('no *.spec.ts skips or marks fixme by platform, host name, CI variable or WSL (tag the test @mac-only instead)', () => {
    const files = execFileSync('git', ['ls-files', '*.spec.ts'], { cwd: root, encoding: 'utf8' })
      .split('\n')
      .filter(Boolean)
    expect(files.length).toBeGreaterThan(50)
    const bad = files.flatMap((f) =>
      machineSkips(readFileSync(join(root, f), 'utf8')).map((s) => `${f}:${s.line}: keyed on ${s.why}: ${s.text}`),
    )
    expect(bad).toEqual([])
  })
})
