// The owner's rule: nothing is run twice to make it green. A test that fails fails, whichever job runs it (check, fast, the hostile
// nightly's loud suites, browser, desktop) and in the gate, so a flake is seen and fixed at its cause. On 2026-11-21 the hostile run's
// Vitest step retried scripts/root-install-v1-gate.test.ts after 862 s and spent another 862 s on it, holding a CI slot for two hours.
// This reads every place that can set a retry, so none comes back: Vitest, Vite and Playwright configs (every one, by name), shell
// and workflow commands, per-test options and calls in the test files, and xcodebuild. `retryFindings` is the reader; the last test
// shows it fails on each pattern. (A download's own curl --retry is not a test retry.) The tests of each command line are in
// ci-local-jobs.test.ts, ci-affected.test.ts and ci-local-check-titan.test.ts.
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
// Not read: this file (it holds the patterns), and the flake reporters' own test, which configures a retry of its own in a scratch
// project to feed them (the reporters are idle now: nothing in CI retries)
const NOT_READ = ['scripts/ci-no-retries.test.ts', 'scripts/ci-flake-reporters.test.ts']
const tracked = () =>
  spawnSync('git', ['ls-files', '-z'], { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
    .stdout.split('\0')
    .filter(Boolean)

const isComment = (l: string) => /^\s*(#|\/\/|\*|\/\*)/.test(l)
const isConfig = (f: string) => /(^|\/)(vitest|vite|playwright)[^/]*\.[cm]?[jt]s$|\.config\.[cm]?[jt]s$/.test(f)
const isTest = (f: string) => /\.(test|spec)\.[cm]?[jt]sx?$/.test(f)
const isCommandFile = (f: string) => /\.(sh|ya?ml|pl|json|cjs|mjs)$/.test(f) && !/(^|\/)(pnpm-lock|tsconfig)/.test(f)
const isScript = (f: string) => /\.[cm]?[jt]s$/.test(f) && !isTest(f) && !isConfig(f)

// The retry settings in one file's text: "path:line: text" for each.
function retryFindings(file: string, text: string): string[] {
  const out: string[] = []
  const lines = text.split('\n')
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i]
    if (isComment(l)) continue
    const before = out.length
    const hit = (why: string) => {
      if (out.length === before) out.push(`${file}:${i + 1}: ${why}: ${l.trim().slice(0, 120)}`)
    }
    // a config: any retry or retries key that is not the literal 0 (an environment test, a variable, a number)
    if (isConfig(file) && /\bretr(y|ies)\b/.test(l) && !/\bretr(y|ies)\s*:\s*0\s*,?\s*(\/\/.*)?$/.test(l))
      hit('a config retry')
    // a test file: a per-test option, describe.configure, vi.retry, test.retry
    if (isTest(file) && !NOT_READ.includes(file)) {
      if (/\bretr(y|ies)\s*:\s*((?!0\b)\d|process\.|Number\(|[A-Za-z_]+\s*\?)/.test(l)) hit('a per-test retry option')
      if (/\.configure\(\s*\{[^}]*\bretr/.test(l)) hit('describe.configure retries')
      if (/\bvi\.retry\b|\b(it|test|describe)\.retry\b/.test(l)) hit('vi.retry')
    }
    // a command (a shell script, a workflow, package.json, a script that builds one): a flag, unless curl's own for a download
    if ((isCommandFile(file) || isScript(file)) && !/\bcurl\b/.test(l)) {
      if (/--retry-failed|--retries\b/.test(l)) hit('a retry flag')
      if (/--retry(=|\s+)(?!0\b)\S/.test(l)) hit('a retry flag with a value other than 0')
    }
    // xcodebuild reruns a failed test by itself
    if (!isTest(file) && /-retry-tests-on-failure|-test-repetition-mode|-test-iterations/.test(l))
      hit('an xcodebuild retry')
  }
  return out
}

describe('no retries anywhere', () => {
  it('no tracked file sets a retry: configs, commands, per-test options, xcodebuild', () => {
    const found: string[] = []
    const files = tracked().filter(
      (f) => isConfig(f) || isTest(f) || isCommandFile(f) || isScript(f) || /\.swift$/.test(f),
    )
    expect(files.length).toBeGreaterThan(500)
    for (const f of files) {
      let text: string
      try {
        text = readFileSync(join(root, f), 'utf8')
      } catch {
        continue // deleted in the working tree
      }
      found.push(...retryFindings(f, text))
    }
    expect(found).toEqual([])
  })

  it('the configs it reads include every vitest, vite and playwright one', () => {
    const configs = tracked().filter(isConfig)
    for (const f of [
      'vitest.config.ts',
      'packages/protocol/vitest.config.ts',
      'apps/bridge/vitest.contract.config.ts',
      'apps/web/vite.config.ts',
      'apps/web/playwright.config.ts',
      'apps/relay/playwright.config.ts',
      'e2e/playwright.config.ts',
      'packages/protocol/playwright.config.ts',
    ])
      expect(configs, f).toContain(f)
  })

  it('the CI scripts run every Vitest with --retry=0: check, the hostile nightly’s loud suites, the contract suite, report-ci/fast, the Linux report', () => {
    const f = 'scripts/ci-local/jobs-check.sh'
    const src = readFileSync(join(root, f), 'utf8').split('\n')
    let n = 0
    for (let i = 0; i < src.length; i++) {
      if (isComment(src[i]) || !/pnpm test |vitest run|test:contract/.test(src[i])) continue
      let cmd = src[i]
      for (let k = i; /\\$/.test(src[k]) && k + 1 < src.length; k++) cmd += ` ${src[k + 1]}`
      expect(cmd, `${f}:${i + 1}`).toMatch(/--retry=0\b/)
      n++
    }
    expect(n).toBeGreaterThanOrEqual(5) // step_vitest, step_contract, the Linux file, the silent-skip run, report-ci/fast
  })

  it('ci-swift-retry.sh runs a failing command once, with or without CI_FLAKE_FILE, and gives its exit code', () => {
    const d = mkdtempSync(join(tmpdir(), 'no-retry-'))
    try {
      const count = join(d, 'count')
      const cmd = [
        'bash',
        join(root, 'scripts/ci-swift-retry.sh'),
        'sh',
        '-c',
        `echo x >> "${count}"; echo "Test Case '-[M.C testA]' failed (0.1 seconds)."; echo "Test Suite 'All tests' failed at 2026-11-21 07:00:00."; exit 3`,
      ]
      for (const env of [{ CI_FLAKE_FILE: join(d, 'flakes') }, {}]) {
        writeFileSync(count, '')
        const r = spawnSync(cmd[0], cmd.slice(1), { env: { PATH: process.env.PATH ?? '', ...env }, encoding: 'utf8' })
        expect(r.status).toBe(3)
        expect(readFileSync(count, 'utf8').trim().split('\n')).toEqual(['x'])
      }
    } finally {
      rmSync(d, { recursive: true, force: true })
    }
  })

  it('the reader fails on each pattern, and passes the clean forms', () => {
    const bad: Array<[string, string]> = [
      ['vitest.config.ts', 'test: { retry: 1 }'],
      ['packages/protocol/vitest.config.ts', '    retry: Number(process.env.R),'],
      ['apps/bridge/vitest.contract.config.ts', 'retry: process.env.CI ? 2 : 0,'],
      ['apps/web/vite.config.ts', '  test: { retry: 3 },'],
      ['apps/web/playwright.config.ts', '  retries: process.env.CI_FLAKE_FILE ? 1 : 0,'],
      ['e2e/playwright.config.ts', '  retries: 2,'],
      ['x/ci.sh', 'pnpm test --retry=1 --reporter=default'],
      ['x/ci.sh', 'pnpm test --retry 1'],
      ['x/ci.sh', 'pnpm test --retry=$RETRIES'],
      ['x/ci.sh', 'bun run test-parallel.ts --retry-failed'],
      ['x/ci.sh', 'playwright test --retries=2'],
      ['x/ci.sh', 'xcodebuild test -retry-tests-on-failure'],
      ['x/ci.sh', 'xcodebuild test -test-repetition-mode retry-on-failure'],
      ['.github/workflows/ci.yml', '        run: pnpm test --retry=2'],
      ['scripts/gate-x.ts', "const cmd = ['vitest', '--retry=1']"],
      ['apps/a/test/a.test.ts', "it('x', { retry: 2 }, () => {})"],
      ['apps/a/test/a.test.ts', "test('x', () => {}, { retry: 2 })"],
      ['apps/a/test/a.test.ts', 'describe.configure({ retries: 2 })'],
      ['apps/a/test/a.test.ts', 'vi.retry(3)'],
      ['apps/a/test/a.spec.ts', 'test.describe.configure({ retries: 1 })'],
    ]
    for (const [f, l] of bad) expect(retryFindings(f, l), `${f}: ${l}`).toHaveLength(1)
    const clean: Array<[string, string]> = [
      ['vitest.config.ts', 'retry: 0,'],
      ['apps/web/playwright.config.ts', '  retries: 0,'],
      ['x/ci.sh', 'pnpm test --retry=0 --reporter=default'],
      ['x/ci.sh', 'curl -fsSL --retry 2 -o f.part "$url"'],
      ['x/ci.sh', '# pnpm test --retry=1 (a comment)'],
      ['apps/a/test/a.test.ts', 'expect(x).toBe(1)'],
      ['apps/a/src/net.ts', 'const retries = 3'],
    ]
    for (const [f, l] of clean) expect(retryFindings(f, l), `${f}: ${l}`).toEqual([])
  })
})
