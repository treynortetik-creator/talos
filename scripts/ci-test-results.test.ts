import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { cleanEnv } from './ci-test-env'
import { build, bunRows, parseJunit, summary } from './ci-test-results.ts'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

// bun 1.3's junit for one file, as `bun test --reporter=junit` writes it: the file's suite, a describe inside it, the cases
const junit = (cases: string) => `<?xml version="1.0" encoding="UTF-8"?>
<testsuites name="bun test" tests="5" assertions="0" failures="0" skipped="3" time="0.03">
  <testsuite name="test/a.test.ts" file="test/a.test.ts" tests="5" assertions="0" failures="0" skipped="3" time="0">
    <testsuite name="grp" file="test/a.test.ts" line="2" tests="4">
      <testsuite name="inner &amp; deep" file="test/a.test.ts" line="3" tests="1">
${cases}
      </testsuite>
      <testcase name="skipped one" classname="grp" time="0" file="test/a.test.ts" line="4" assertions="0">
        <skipped />
      </testcase>
      <testcase name="todo one" classname="grp" time="0" file="test/a.test.ts" line="5" assertions="0">
        <skipped message="TODO" />
      </testcase>
    </testsuite>
    <testcase name="top &quot;quoted&quot; &lt;x&gt;" classname="" time="0.00001" file="test/a.test.ts" line="8" assertions="0" />
  </testsuite>
</testsuites>
`
const passing = `<testcase name="ok one" classname="inner" time="0.01" file="test/a.test.ts" line="3" assertions="1" />`
const failing = `<testcase name="ok one" classname="inner" time="0.01" file="test/a.test.ts" line="3" assertions="1">
          <failure message="expected 1 to be 2" type="AssertionError" />
        </testcase>`

const dirs: string[] = []
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})
function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), 'ci-test-results-'))
  dirs.push(d)
  return d
}

describe("check's per-test file (scripts/ci-test-results.ts)", () => {
  it('reads bun junit: the describe path, skip, todo, a failure, and the escaped names', () => {
    expect(parseJunit(junit(failing))).toEqual([
      ['bun', 'apps/bridge/test/a.test.ts', 'grp > inner & deep > ok one', 'fail'],
      ['bun', 'apps/bridge/test/a.test.ts', 'grp > skipped one', 'skip'],
      ['bun', 'apps/bridge/test/a.test.ts', 'grp > todo one', 'todo'],
      ['bun', 'apps/bridge/test/a.test.ts', 'top "quoted" <x>', 'pass'],
    ])
    expect(parseJunit(junit(passing))[0][3]).toBe('pass')
  })

  it('a retried file: a test that failed the first time and passes now is flaky; a crashed file is one "*" fail line', () => {
    const d = tmp()
    writeFileSync(join(d, 'test_a.test.ts.first.xml'), junit(failing))
    writeFileSync(join(d, 'test_a.test.ts.xml'), junit(passing))
    writeFileSync(join(d, 'test_b.test.ts.crashed'), 'test/b.test.ts\n')
    // crashed on its first run, reported on the retry: the report wins
    writeFileSync(join(d, 'test_c.test.ts.crashed'), 'test/c.test.ts\n')
    writeFileSync(join(d, 'test_c.test.ts.xml'), junit(passing).replaceAll('test/a.test.ts', 'test/c.test.ts'))
    const { rows, any } = bunRows(d)
    expect(any).toBe(true)
    expect(rows).toContainEqual(['bun', 'apps/bridge/test/a.test.ts', 'grp > inner & deep > ok one', 'flaky'])
    expect(rows).toContainEqual(['bun', 'apps/bridge/test/b.test.ts', '*', 'fail'])
    expect(rows.filter((r) => r[1] === 'apps/bridge/test/c.test.ts' && r[2] === '*')).toEqual([])
  })

  it('the file: its header, the rows of both suites sorted, "# no bun results" when no bun file reported', () => {
    const d = tmp()
    writeFileSync(
      join(d, 'vitest.tsv'),
      'vitest\tscripts/z.test.ts\tz > one\tpass\nvitest\tscripts/b.test.ts\tb > one\tskip\nvitest\tscripts/x.test.ts\t*\tfail\n',
    )
    expect(build(d, 'abc123', 'titan').text).toBe(
      [
        '# talos-check-tests v1 abc123 titan',
        '# no bun results',
        'vitest\tscripts/b.test.ts\tb > one\tskip',
        'vitest\tscripts/x.test.ts\t*\tfail',
        'vitest\tscripts/z.test.ts\tz > one\tpass',
        '',
      ].join('\n'),
    )
    mkdirSync(join(d, 'bun'))
    writeFileSync(join(d, 'bun', 'test_a.test.ts.xml'), junit(passing))
    const { text, rows } = build(d, 'abc123', 'titan')
    expect(text.split('\n').slice(0, 3)).toEqual([
      '# talos-check-tests v1 abc123 titan',
      'bun\tapps/bridge/test/a.test.ts\tgrp > inner & deep > ok one\tpass',
      'bun\tapps/bridge/test/a.test.ts\tgrp > skipped one\tskip',
    ])
    expect(summary(rows)).toBe('check-tests: 7 tests, 3 pass, 1 fail, 2 skip, 1 todo, 0 flaky')
  })

  it('two tests of one name in one file are told apart by order, and only the one that failed first is flaky', () => {
    const d = tmp()
    const two = (a: string, b: string) =>
      `<testsuites><testsuite name="test/d.test.ts" file="test/d.test.ts">${a}${b}</testsuite></testsuites>`
    const ok = '<testcase name="same" file="test/d.test.ts" />'
    const bad = '<testcase name="same" file="test/d.test.ts"><failure message="x" /></testcase>'
    writeFileSync(join(d, 'test_d.test.ts.first.xml'), two(ok, bad))
    writeFileSync(join(d, 'test_d.test.ts.xml'), two(ok, ok))
    expect(bunRows(d).rows).toEqual([
      ['bun', 'apps/bridge/test/d.test.ts', 'same', 'pass'],
      ['bun', 'apps/bridge/test/d.test.ts', 'same #2', 'flaky'],
    ])
  })

  it('sorted by bytes, as LC_ALL=C sort does; the parts another machine ran are named in the header', () => {
    const d = tmp()
    // U+FF5E sorts after U+1F600's surrogate pair in UTF-16 but before its four UTF-8 bytes
    writeFileSync(join(d, 'vitest.tsv'), 'vitest\ts.test.ts\t\u{1F600}\tpass\nvitest\ts.test.ts\t～\tpass\n')
    const text = build(d, 'abc', 'lemnos', ['vitest:delphi', 'bridge-shard-2:cyclops']).text
    expect(text.split('\n')).toEqual([
      '# talos-check-tests v1 abc lemnos',
      '# parts elsewhere: vitest:delphi bridge-shard-2:cyclops',
      '# no bun results',
      'vitest\ts.test.ts\t～\tpass',
      'vitest\ts.test.ts\t\u{1F600}\tpass',
      '',
    ])
    const sorted = spawnSync('sort', [], {
      input: text.split('\n').slice(3, 5).reverse().join('\n'),
      encoding: 'utf8',
      env: { ...process.env, LC_ALL: 'C' },
    })
    expect(sorted.stdout.trim().split('\n')).toEqual(text.split('\n').slice(3, 5))
  })

  it("the bridge's runner (test-parallel.ts) with TALOS_TEST_JUNIT_DIR: a flaky file, a crashed one, a skip, all in the file", () => {
    const d = tmp()
    const fx = join(d, 'fx')
    mkdirSync(join(fx, 'test'), { recursive: true })
    const mark = join(d, 'ran-once')
    writeFileSync(
      join(fx, 'test', 'flaky.test.ts'),
      `import { existsSync, writeFileSync } from 'node:fs'
import { describe, expect, test } from 'bun:test'
describe('grp', () => {
  test('second time lucky', () => {
    const again = existsSync(${JSON.stringify(mark)})
    writeFileSync(${JSON.stringify(mark)}, '')
    expect(again).toBe(true)
  })
  test.skip('not today', () => {})
})
`,
    )
    writeFileSync(
      join(fx, 'test', 'crash.test.ts'),
      `import { test } from 'bun:test'\ntest('x', () => {})\nprocess.exit(3)\n`,
    )
    const out = join(d, 'results')
    const r = spawnSync(
      'bun',
      ['run', join(ROOT, 'apps/bridge/scripts/test-parallel.ts'), '--jobs', '2', '--retry-failed', fx],
      { cwd: ROOT, encoding: 'utf8', env: { ...cleanEnv(), TALOS_TEST_JUNIT_DIR: join(out, 'bun') } },
    )
    expect(r.status, r.stdout + r.stderr).not.toBe(0) // the crashed file is red
    expect(build(out, 'abc123', 'titan').text.split('\n')).toEqual([
      '# talos-check-tests v1 abc123 titan',
      'bun\tapps/bridge/test/crash.test.ts\t*\tfail',
      'bun\tapps/bridge/test/flaky.test.ts\tgrp > not today\tskip',
      'bun\tapps/bridge/test/flaky.test.ts\tgrp > second time lucky\tflaky',
      '',
    ])
  })

  it('the Vitest reporter writes one line per test, and "*" fail for a file that threw at import', () => {
    const d = tmp()
    const proj = join(d, 'proj')
    mkdirSync(proj)
    writeFileSync(
      join(proj, 'a.test.ts'),
      `import { describe, it, expect } from 'vitest'
describe('grp', () => {
  it('passes', () => expect(1).toBe(1))
  it('fails', () => expect(1).toBe(2))
  it.skip('skipped', () => {})
  it.todo('later')
})
let n = 0
it('flaky\\twith tab', () => { n++; expect(n).toBe(2) })
`,
    )
    writeFileSync(join(proj, 'b.test.ts'), `throw new Error('import broke')\n`)
    const out = join(d, 'results')
    const r = spawnSync(
      join(ROOT, 'node_modules/.bin/vitest'),
      [
        'run',
        '--root',
        proj,
        '--retry=1',
        '--reporter=default',
        `--reporter=${join(ROOT, 'scripts/ci-test-results-vitest.ts')}`,
      ],
      { cwd: ROOT, encoding: 'utf8', env: { ...cleanEnv(), CI_TEST_RESULTS_DIR: out } },
    )
    expect(r.status, r.stdout + r.stderr).toBe(1)
    const lines = readFileSync(join(out, 'vitest.tsv'), 'utf8').trim().split('\n').sort()
    expect(lines).toEqual([
      'vitest\ta.test.ts\tflaky with tab\tflaky',
      'vitest\ta.test.ts\tgrp > fails\tfail',
      'vitest\ta.test.ts\tgrp > later\ttodo',
      'vitest\ta.test.ts\tgrp > passes\tpass',
      'vitest\ta.test.ts\tgrp > skipped\tskip',
      'vitest\tb.test.ts\t*\tfail',
    ])
  })
})
