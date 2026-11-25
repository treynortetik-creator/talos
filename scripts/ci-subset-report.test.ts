// scripts/ci-subset-report.ts reads check's logs for the macOS-only subset (the step's time, the tests that hit bun's 20 s limit,
// the slowest tests, the machine's load) so a change to how the subset is scheduled can be measured from real runs.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { parseRun, report, timingsFor, verdictFor } from './ci-subset-report.ts'

const dirs: string[] = []
afterAll(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

const LOG = `+ ci_mutex_all /c/locks suites step_macos_subset
the macOS-only tests, here: apps/bridge/test/talos.test.ts
subset load start: 4.10 3.00 2.50
::group::test/talos.test.ts:
(pass) talos doctor and status > doctor works [310.5ms]
(fail) talos doctor and status > status works [21722.57ms]
::endgroup::
(fail) talos doctor and status > status works [21722.57ms]
::group::test/restart-main.test.ts:
(pass) restart > a slow one [2.5s]
(fail) hook > stuck in a hook [20011.0ms]
::endgroup::
::error title=error: Test "stuck in a hook" timed out after 20000ms::
subset load after the bun files: 9.50 5.00 3.00
 Test Files  1 passed (1)
\u001b[2m   Duration \u001b[22m 333.67s\u001b[2m (tests 99%)\u001b[22m
subset load end: 8,00 6,00 4,00 (a locale with comma decimals)
[step] 1216s exit 1: ci_mutex_all /c/locks suites step_macos_subset
`

describe('ci-subset-report', () => {
  it('reads the step, the 20 s timeouts (each test once), the failures, the slowest tests, Vitest and the load', () => {
    const run = parseRun('b340427', LOG)
    expect(run).toMatchObject({ stepSeconds: 1216, stepExit: 1, timeouts: 2, failed: 2, vitestSeconds: 333.67 })
    expect(run.loads).toEqual(['4.10', '9.50', '8.00'])
    expect(run.slowest.map((t) => [t.file, t.ms])).toEqual([
      ['test/talos.test.ts', 21722.57],
      ['test/restart-main.test.ts', 20011],
      ['test/restart-main.test.ts', 2500],
    ])
  })

  it('a log that never reached the step says so, not zero', () => {
    expect(parseRun('abc1234', 'the macOS-only tests, here: x\n').stepSeconds).toBeNull()
  })

  it("takes a commit's newest timings row and its green or red from green.tsv", () => {
    const tsv =
      't\tb340427\t1\tj\t0\t15\t900\t1\tcheck=1/1\n' +
      't\tb340427\t1\tj\t0\t15\t1566\t1\tmod=5/5,check=1216/1216,desktop=1377/1377,browser=1563/1563,mobile=130/130\n'
    expect(timingsFor(tsv, 'b340427')).toEqual({
      jobs: 1566,
      check: '1216',
      desktop: '1377',
      browser: '1563',
      mobile: '130',
    })
    expect(timingsFor(tsv, 'zzzzzzz')).toBeNull()
    const green = 't\tb3404273513\tp\tunchanged: verdict red\nt\tb3404273513\tp\tmoved\n'
    expect(verdictFor(green, 'b340427')).toBe('green')
    expect(verdictFor('t\tb3404273513\tp\tunchanged: verdict red\n', 'b340427')).toBe('red')
  })

  it('one row per run that ran the subset here, picked by the log’s local date, and a summary', () => {
    const d = mkdtempSync(join(tmpdir(), 'cisr-'))
    dirs.push(d)
    writeFileSync(join(d, 'b340427-check.log'), LOG)
    writeFileSync(join(d, 'aaaaaaa-check.log'), 'a check with no subset in it (Titan off)\n')
    const now = new Date()
    const day = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`
    const out = report(d, { since: day, until: day })
    expect(out).toContain('| b340427 | 1216s (red) | 2 | 2 |')
    expect(out).not.toContain('aaaaaaa')
    expect(out).toContain(
      '1 runs; subset step: median 1216s, max 1216s; runs with a 20 s timeout: 1; timeouts in all: 2',
    )
    expect(report(d, { since: '2000-01-01', until: '2000-01-02' })).toContain('0 runs')
  })
  it("a hostile or nightly run's folder (logs/hostile/, logs/nightly/) is never read as the push run's: its log, its walls", () => {
    const d = mkdtempSync(join(tmpdir(), 'cisr-'))
    dirs.push(d)
    const row = (check: string) => `t\tb340427\t1\tcheck\t0\t10\t100\t0\tcheck=${check}/${check}\t-\tbun=1\tchronos=-\n`
    writeFileSync(join(d, 'b340427-check.log'), LOG)
    writeFileSync(join(d, 'timings.tsv'), row('111'))
    for (const k of ['hostile', 'nightly']) {
      mkdirSync(join(d, k))
      writeFileSync(join(d, k, 'b340427-check.log'), LOG)
      writeFileSync(join(d, k, 'timings.tsv'), row('999'))
    }
    const out = report(d, { shas: ['b340427'] })
    expect(out).toContain('| 111/-/-/- |')
    expect(out).not.toContain('999')
    expect(out).toContain('1 runs;')
  })
})
