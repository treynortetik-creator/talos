// scripts/gate-excuse.pl, the reader of one failed gate test step's log (gate.sh --push's excuse for tests already failing on
// main): every failing test with its file, and an "unaccounted" line for anything else that failed, so that nothing but named
// tests can ever be excused. The logs are in each runner's own format (bun via test-parallel, Vitest, Playwright), cut down.
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, describe, expect, it } from 'vitest'

const here = dirname(fileURLToPath(import.meta.url))
const dirs: string[] = []
afterAll(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

/** gate-excuse.pl on `log`, in a tree holding `files`: its test lines as [name, file] and its unaccounted reasons */
function read(log: string, files: string[] = []) {
  const T = mkdtempSync(join(tmpdir(), 'ge-'))
  dirs.push(T)
  for (const f of files) {
    mkdirSync(dirname(join(T, f)), { recursive: true })
    writeFileSync(join(T, f), 'x\n')
  }
  writeFileSync(join(T, 'step.log'), log)
  const r = spawnSync('perl', [join(here, 'gate-excuse.pl'), 'step.log', 'apps/web', 'scripts'], {
    cwd: T,
    encoding: 'utf8',
  })
  expect(r.status, r.stderr).toBe(0)
  const rows = r.stdout
    .split('\n')
    .filter(Boolean)
    .map((l) => l.split('\t'))
  return {
    tests: rows.filter((x) => x[0] === 'test').map((x) => [x[1], x[2]]),
    why: rows.filter((x) => x[0] === 'unaccounted').map((x) => x[1]),
  }
}
const bun = (blocks: Array<[string, string[]]>, total: number, bad: string[] = blocks.map((b) => b[0])) =>
  [
    ...blocks.flatMap(([f, fails]) => [
      `\n${f}: exit ${fails.length ? 1 : 0}`,
      'bun test v1.3.11',
      ...fails.map((n) => `(fail) ${n} [10.00ms]`),
      `\n 3 pass\n ${fails.length} fail`,
    ]),
    `\n 40 pass\n ${total} fail`,
    `Ran 41 tests across ${blocks.length} files. [9.00s]`,
    ...(bad.length ? [`test-parallel: FAILED (${bad.length} of 9):`, ...bad.map((b) => `- ${b}`)] : []),
  ].join('\n')

describe('gate-excuse.pl: failing tests and their files', () => {
  it('bun (test-parallel): each (fail) is in the file whose output it is part of', () => {
    const r = read(
      bun(
        [
          ['test/a.test.ts', ['a > fails']],
          ['test/b.test.ts', []],
        ],
        1,
        ['test/a.test.ts'],
      ),
    )
    expect(r.why).toEqual([])
    expect(r.tests).toEqual([['a > fails', 'apps/bridge/test/a.test.ts']])
  })

  it('Vitest: the file from the project label, in either form (plain |web|, or the coloured label CI logs)', () => {
    const log = [
      ' FAIL  |web| test/x.test.ts > x > fails',
      '\u001b[41m FAIL \u001b[49m \u001b[46m scripts \u001b[49m y.test.ts\u001b[2m > \u001b[22my > fails',
      ' Test Files  2 failed | 5 passed (7)',
      '      Tests  2 failed | 50 passed (52)',
    ].join('\n')
    const r = read(log, ['apps/web/test/x.test.ts', 'scripts/y.test.ts'])
    expect(r.why).toEqual([])
    expect(r.tests).toEqual([
      ['|web| test/x.test.ts > x > fails', 'apps/web/test/x.test.ts'],
      ['|scripts| y.test.ts > y > fails', 'scripts/y.test.ts'],
    ])
  })

  it('Playwright: a test that failed every try, with its spec; one that passed on retry is left out', () => {
    const log = [
      '  ✘   3 [desktop] › test/x.spec.ts:10:3 › x fails (1.0s)',
      '  ✘   4 [desktop] › test/x.spec.ts:10:3 › x fails (retry #1) (1.0s)',
      '  ✘   5 [desktop] › test/y.spec.ts:2:1 › y flakes (1.0s)',
      '  ✓   6 [desktop] › test/y.spec.ts:2:1 › y flakes (retry #1) (1.0s)',
      '  1 failed',
      '  1 flaky',
    ].join('\n')
    const r = read(log, ['apps/web/test/x.spec.ts', 'apps/web/test/y.spec.ts'])
    expect(r.why).toEqual([])
    expect(r.tests).toEqual([['[desktop] › test/x.spec.ts:10:3 › x fails', 'apps/web/test/x.spec.ts']])
  })
})

describe('gate-excuse.pl: anything but named tests failing is unaccounted (never excused)', () => {
  it('one name in two bun files: the count no longer matches', () => {
    const r = read(
      bun(
        [
          ['test/a.test.ts', ['same > name']],
          ['test/b.test.ts', ['same > name']],
        ],
        2,
      ),
    )
    expect(r.why).toContain('bun counts 2 failed test(s), and the log names 1')
  })

  it('a bun file killed at its limit, or one that failed with no test of it named', () => {
    const killed = read(
      bun([['test/a.test.ts', ['a > fails']]], 1, ['test/a.test.ts', 'test/b.test.ts (killed after 300 s)']),
    )
    expect(killed.why).toContain('a test file was killed at its time limit (test/b.test.ts)')
    const silent = read(bun([['test/a.test.ts', ['a > fails']]], 1, ['test/a.test.ts', 'test/c.test.ts']))
    expect(silent.why).toContain('apps/bridge/test/c.test.ts failed with no test of it named')
  })

  it("an unhandled error, in each runner's words; a passing test with the words in its name is not one", () => {
    const base = bun([['test/a.test.ts', ['a > fails']]], 1, ['test/a.test.ts'])
    expect(read(`${base}\n# Unhandled error between tests\n`).why).toContain('an unhandled error')
    expect(read(`${base}\n 1 error\n`).why).toContain('an unhandled error')
    expect(read(`${base}\n⎯⎯⎯⎯ Unhandled Errors ⎯⎯⎯⎯\n`).why).toContain('an unhandled error')
    expect(read(`(pass) errors > an unhandled rejection is filed [1.00ms]\n${base}`).why).toEqual([])
  })

  it('Playwright tests that did not run, were interrupted, or a step stopped at its time limit', () => {
    const one = '  ✘   3 [desktop] › test/x.spec.ts:10:3 › x fails (1.0s)\n  1 failed\n'
    const files = ['apps/web/test/x.spec.ts']
    expect(read(`${one}  50 did not run\n`, files).why).toContain('Playwright tests did not run or were interrupted')
    expect(read(`${one}  2 interrupted\n`, files).why).toContain('Playwright tests did not run or were interrupted')
    expect(read(`${one}gate: the web browser specs were stopped after 900 s (WEB_SPECS_LIMIT)\n`, files).why).toContain(
      'the step was stopped at its time limit',
    )
  })

  it('a Vitest file that failed to load, a count above the names, and a log that names nothing', () => {
    const load = read(' FAIL  |web| test/x.test.ts [ test/x.test.ts ]\n Test Files  1 failed (1)\n', [
      'apps/web/test/x.test.ts',
    ])
    expect(load.why[0]).toMatch(/^a Vitest file failed with no test named/)
    const more = read(' FAIL  |web| test/x.test.ts > x > a\n Test Files  1 failed (1)\n      Tests  2 failed (9)\n', [
      'apps/web/test/x.test.ts',
    ])
    expect(more.why).toContain('Vitest counts 2 failed test(s), and the log names 1')
    expect(read('error: something broke\n').why).toContain('no failing test is named')
  })
})
