// The flake reporters CI gives Vitest and Playwright (scripts/ci-flake-vitest.ts, scripts/ci-flake-playwright.ts): with one retry,
// a test that fails once and then passes is green, and the reporter appends "<test>\t<file>" to CI_FLAKE_FILE so ci-local.sh can
// say "passed on retry" and keep logs/flakes.tsv. A test that fails twice stays red and is not a flake. Each runner is run for
// real on a test written into a temp folder, which fails on its first run there and passes on the next.
// The launchOptions check at the end reads every *.spec.ts, so the gate runs this file when a spec changes (scripts/gate.sh,
// guards_reading):
// gate-reads: *.spec.ts
import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, describe, expect, it, vi } from 'vitest'
import { cleanEnv } from './ci-test-env'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')
const dirs: string[] = []
afterAll(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})
const temp = () => {
  const d = mkdtempSync(join(tmpdir(), 'flk-'))
  dirs.push(d)
  return d
}
const lines = (f: string) => (existsSync(f) ? readFileSync(f, 'utf8').trim().split('\n').filter(Boolean) : [])
/** A test body that fails the first time it runs in `d` and passes after that; `always` fails every time. */
const flips = (d: string, always = false) => `const first = !existsSync(${JSON.stringify(join(d, 'mark'))})
  appendFileSync(${JSON.stringify(join(d, 'mark'))}, 'run\\n')
  expect(${always ? 'true' : 'first'}).toBe(false)`

describe('ci-flake-vitest.ts with --retry=1', () => {
  const vitest = (d: string, env: Record<string, string>) =>
    spawnSync(
      join(root, 'node_modules/.bin/vitest'),
      [
        'run',
        '--root',
        d,
        '--globals',
        '--retry=1',
        '--reporter=default',
        `--reporter=${join(here, 'ci-flake-vitest.ts')}`,
      ],
      { cwd: root, encoding: 'utf8', env: { ...cleanEnv(), ...env } },
    )
  const write = (d: string, always = false) =>
    writeFileSync(
      join(d, 'a.test.ts'),
      `import { appendFileSync, existsSync } from 'node:fs'\ndescribe('group', () => {\n  test('steady', () => {})\n  test('flips once', () => {\n  ${flips(d, always)}\n  })\n})\n`,
    )

  it('a test that passes on its retry is green and is written to CI_FLAKE_FILE with its file', () => {
    const d = temp()
    write(d)
    const r = vitest(d, { CI_FLAKE_FILE: join(d, 'flakes') })
    expect(r.status, r.stdout + r.stderr).toBe(0)
    expect(lines(join(d, 'mark'))).toHaveLength(2)
    expect(lines(join(d, 'flakes'))).toEqual(['group > flips once\ta.test.ts'])
  }, 60_000)

  it('a test that fails twice is red and is not a flake', () => {
    const d = temp()
    write(d, true)
    const r = vitest(d, { CI_FLAKE_FILE: join(d, 'flakes') })
    expect(r.status).toBe(1)
    expect(lines(join(d, 'flakes'))).toEqual([])
  }, 60_000)
})

describe('ci-flake-playwright.ts with retries: 1', () => {
  const playwright = (d: string, env: Record<string, string>) =>
    spawnSync(join(root, 'node_modules/.bin/playwright'), ['test', '-c', join(d, 'playwright.config.ts')], {
      cwd: root,
      encoding: 'utf8',
      // the spec lives in a temp folder, so its import of @playwright/test is found through NODE_PATH
      env: { ...cleanEnv(), ...env, NODE_PATH: join(root, 'node_modules') },
    })
  const write = (d: string, always = false) => {
    writeFileSync(
      join(d, 'playwright.config.ts'),
      `export default { testDir: '.', testMatch: '*.flaky.ts', outputDir: ${JSON.stringify(join(d, 'out'))}, workers: 1, retries: 1, reporter: [['list'], [${JSON.stringify(join(here, 'ci-flake-playwright.ts'))}]] }\n`,
    )
    writeFileSync(
      join(d, 'a.flaky.ts'),
      `import { appendFileSync, existsSync } from 'node:fs'\nimport { expect, test } from '@playwright/test'\ntest.describe('group', () => {\n  test('flips once', () => {\n  ${flips(d, always)}\n  })\n})\n`,
    )
  }

  it('a test that passes on its retry is green and is written to CI_FLAKE_FILE with its file', () => {
    const d = temp()
    write(d)
    const r = playwright(d, { CI_FLAKE_FILE: join(d, 'flakes') })
    expect(r.status, r.stdout + r.stderr).toBe(0)
    expect(lines(join(d, 'flakes'))).toEqual(['group > flips once\ta.flaky.ts'])
  }, 60_000)

  it('a test that fails twice is red and is not a flake', () => {
    const d = temp()
    write(d, true)
    const r = playwright(d, { CI_FLAKE_FILE: join(d, 'flakes') })
    expect(r.status).toBe(1)
    expect(lines(join(d, 'flakes'))).toEqual([])
  }, 60_000)
})

describe('every Playwright config retries once and reports flakes in CI, and only there', () => {
  const configs = execFileSync('git', ['ls-files', '*playwright.config.ts'], { cwd: root, encoding: 'utf8' })
    .trim()
    .split('\n')

  it('finds the four configs', () => {
    expect(configs.length).toBeGreaterThanOrEqual(4)
  })

  for (const c of configs) {
    it(c, async () => {
      const text = readFileSync(join(root, c), 'utf8')
      expect(text).toContain('retries: process.env.CI_FLAKE_FILE ? 1 : 0')
      const path = /\[\['list'\], \.\.\.\(process\.env\.CI_FLAKE_FILE \? \[\['([^']+)'\] as const\] : \[\]\)\]/.exec(
        text,
      )?.[1]
      expect(path, 'the reporter line').toBeTruthy()
      expect(existsSync(join(root, dirname(c), path as string)), path).toBe(true)
    })
  }
})

describe('under ci-local every Chromium goes straight to localhost, past any proxy; outside it nothing changes', () => {
  // A proxy put in front of localhost on the CI Mac (web protection software) once failed page.goto with
  // ERR_UNEXPECTED_PROXY_AUTH. WebKit takes no Chromium flags: it gets the browser job's proxy-free environment only.
  type Use = { browserName?: string; defaultBrowserType?: string; launchOptions?: { args?: string[] } }
  type Config = { use?: Use; projects?: { name: string; use?: Use }[] }
  const CONFIGS = [
    '../apps/relay/playwright.config.ts',
    '../apps/web/playwright.config.ts',
    '../e2e/playwright.config.ts',
    '../packages/protocol/playwright.config.ts',
  ]
  /** Each project's browser and the Chromium args it would launch with (a project's launchOptions replaces the top level's). */
  const browsers = async (path: string, ci: boolean) => {
    const prev = process.env.CI_FLAKE_FILE
    if (ci) process.env.CI_FLAKE_FILE = join(temp(), 'flakes')
    else delete process.env.CI_FLAKE_FILE
    vi.resetModules()
    try {
      const config = ((await import(/* @vite-ignore */ join(here, path))) as { default: Config }).default
      const projects = config.projects ?? [{ name: '(top level)', use: {} }]
      return projects.map((p) => {
        const use = { ...config.use, ...p.use }
        return {
          name: p.name,
          browser: use.browserName ?? use.defaultBrowserType ?? 'chromium',
          args: use.launchOptions?.args ?? [],
        }
      })
    } finally {
      if (prev === undefined) delete process.env.CI_FLAKE_FILE
      else process.env.CI_FLAKE_FILE = prev
    }
  }

  for (const path of CONFIGS) {
    it(path, async () => {
      const ci = await browsers(path, true)
      expect(
        ci.some((p) => p.browser === 'chromium'),
        'has a Chromium project',
      ).toBe(true)
      for (const p of ci) {
        if (p.browser === 'chromium') expect(p.args, p.name).toContain('--no-proxy-server')
        else expect(p.args, p.name).not.toContain('--no-proxy-server')
      }
      for (const p of await browsers(path, false))
        expect(p.args, `${p.name}, outside ci-local`).not.toContain('--no-proxy-server')
    })
  }

  it("no spec replaces its project's launchOptions without the flag: a spec's test.use({ launchOptions }) replaces them whole", () => {
    // git grep exits 1 when nothing matches: that is no spec overriding launchOptions, not an error
    const found = spawnSync('git', ['grep', '-l', 'launchOptions', '--', '*.spec.ts'], { cwd: root, encoding: 'utf8' })
    expect(found.status === 0 || found.status === 1, found.stderr).toBe(true)
    const specs = found.stdout.trim().split('\n').filter(Boolean)
    for (const f of specs) {
      const code = readFileSync(join(root, f), 'utf8').replace(/\/\/.*$/gm, '') // comments may name it
      if (!/launchOptions\s*:/.test(code)) continue
      expect(code, f).toContain("CI_FLAKE_FILE ? ['--no-proxy-server'] : []")
    }
  })
})
