// ci-runner.sh check-shadow (scripts/ci-runner/check-shadow.sh; docs/CI-MACHINES.md, "check on Titan"): with CI_TITAN_CHECK=shadow,
// Titan's report-ci/check beside Lemnos's own check on the same commit, test by test, from each side's per-test results file
// (<short>-check-tests.tsv, "# talos-check-tests v1"): one row of ~/.cache/talos-ci/logs/check-shadow.tsv and a detail file
// per commit. Run for real with a fake `gh` that applies the script's own --jq to JSON files and serves Titan's log artifact.
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, describe, expect, it } from 'vitest'
import { fakeTool } from './fake-tool'

const here = dirname(fileURLToPath(import.meta.url))
const hasJq = spawnSync('jq', ['--version']).status === 0
const dirs: string[] = []
afterAll(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

const SHA = 'd'.repeat(40)
const SHORT = SHA.slice(0, 7)
const A = 'https://github.com/owner/talos-app/actions/runs/9/attempts/2#'
const T0 = '2026-11-14T10:00:00Z' // the part's pending
const T0_EPOCH = Date.parse(T0) / 1000
const at = (s: number) => new Date((T0_EPOCH + s) * 1000).toISOString().replace('.000Z', 'Z')
type Status = { context: string; state: string; target_url: string; description: string; created_at: string }
const st = (context: string, state: string, when: string, description = '', link = `${A}check-titan`): Status => ({
  context,
  state,
  target_url: link,
  description,
  created_at: when,
})
const RUN = 'Run the check part (scripts/ci-local.sh)'

/** A per-test results file: the header, then sorted lines (suite, file, name, state). */
const results = (machine: string, lines: string[][], extra: string[] = []) =>
  `${[`# talos-check-tests v1 ${SHA} ${machine}`, ...extra, ...lines.map((l) => l.join('\t')).sort()].join('\n')}\n`

function setup() {
  const T = mkdtempSync(join(tmpdir(), 'cicshadow-'))
  dirs.push(T)
  const home = join(T, 'home')
  const logs = join(home, '.cache/talos-ci/logs')
  mkdirSync(logs, { recursive: true })
  const bin = join(T, 'bin')
  mkdirSync(bin)
  fakeTool(
    bin,
    'gh',
    `#!/bin/bash
echo "$*" >> "${T}/gh.log"
if [ "$1" = run ] && [ "$2" = download ]; then
  d=""; n=""; while [ $# -gt 0 ]; do case "$1" in -D) d="$2" ;; -n) n="$2" ;; esac; shift; done
  c=$(cat "${T}/dl" 2>/dev/null || echo 0); echo $((c + 1)) > "${T}/dl"
  [ "$c" -ge "$(cat "${T}/late" 2>/dev/null || echo 0)" ] || exit 1 # an upload that lands after Titan's status
  [ -d "${T}/artifact/$n" ] || exit 1
  mkdir -p "$d" && cp "${T}/artifact/$n"/* "$d/"; exit 0
fi
case "$*" in *"/statuses?"*) f="${T}/statuses.json" ;; *"/jobs?"*) f="${T}/jobs.json" ;; *) exit 1 ;; esac
[ -f "$f" ] || exit 1
q=""; while [ $# -gt 0 ]; do [ "$1" = --jq ] && q="$2"; shift; done
jq -r "$q" "$f"
`,
  )
  const statuses = (rows: Status[]) => writeFileSync(join(T, 'statuses.json'), JSON.stringify(rows))
  const part = (status: string, runAt = at(-30)) =>
    writeFileSync(
      join(T, 'jobs.json'),
      JSON.stringify({ jobs: [{ name: 'check-titan', status, steps: [{ name: RUN, started_at: runAt }] }] }),
    )
  const titan = (tsv: string, log = 'check: lock wait 12s\n') => {
    // the per-test artifact check-titan uploads on every run: its results file and its check log's lock-wait lines
    const d = join(T, 'artifact', 'ci-tests-check-titan-2')
    mkdirSync(d, { recursive: true })
    writeFileSync(join(d, `${SHORT}-check-tests.tsv`), tsv)
    writeFileSync(join(d, `${SHORT}-check-lock-wait.txt`), log)
  }
  const lemnos = (tsv: string) => writeFileSync(join(logs, `${SHORT}-check-tests.tsv`), tsv)
  const run = () => {
    const r = spawnSync('bash', [join(here, 'ci-runner.sh'), 'check-shadow'], {
      encoding: 'utf8',
      env: {
        PATH: `${bin}:${process.env.PATH}`,
        HOME: home,
        TMPDIR: T,
        GH_TOKEN: 't',
        GITHUB_REPOSITORY: 'owner/talos-app',
        GITHUB_SERVER_URL: 'https://github.com',
        GITHUB_RUN_ID: '9',
        GITHUB_RUN_ATTEMPT: '2',
        CI_PLAN_SHA: SHA,
        CI_CHECK_SHADOW_POLL: '1',
        CI_CHECK_SHADOW_WAIT: '3',
        CI_CHECK_SHADOW_QUEUED: '2',
        CI_PART_JOB: 'check-titan',
        CI_PART_RUN_STEP: RUN,
      },
      timeout: 60_000,
    })
    const tsv = join(logs, 'check-shadow.tsv')
    const rows = existsSync(tsv) ? readFileSync(tsv, 'utf8').trim().split('\n') : []
    const header = (rows[0] ?? '').split('\t')
    const last = (rows.at(-1) ?? '').split('\t')
    const row = Object.fromEntries(header.map((h, i) => [h, last[i] ?? '']))
    const detailPath = join(logs, 'check-shadow', `${SHORT}-2.txt`)
    const detail = existsSync(detailPath) ? readFileSync(detailPath, 'utf8') : ''
    return { code: r.status, out: r.stdout + r.stderr, rows, row, detail }
  }
  return { T, statuses, part, titan, lemnos, run }
}

const both = (extra: Status[] = []) => [
  st('report-ci/check', 'success', at(770), 'passed on titan in 760s'),
  st('report-ci/check', 'pending', T0),
  st('local-ci/desktop', 'success', at(600), 'passed on ci-runner in 640s', `${A}lemnos`),
  st('local-ci/check', 'success', at(700), 'passed on ci-runner in 690s', `${A}lemnos`),
  ...extra,
]
const V = (file: string, name: string, state: string) => ['vitest', file, name, state]
const B = (file: string, name: string, state: string) => ['bun', file, name, state]

describe.skipIf(!hasJq)('ci-runner.sh check-shadow: test by test, one row and one detail file per commit', () => {
  it('both sides the same (flaky counts as a pass): agree, with the part time, lock wait, start delay and desktop end', () => {
    const s = setup()
    s.part('completed')
    s.statuses(both())
    s.titan(results('titan', [V('a.test.ts', 'x > y', 'pass'), B('apps/bridge/test/b.test.ts', 'b', 'flaky')]))
    s.lemnos(results('lemnos', [V('a.test.ts', 'x > y', 'pass'), B('apps/bridge/test/b.test.ts', 'b', 'pass')]))
    const r = s.run()
    expect(r.code).toBe(0)
    expect(r.row).toMatchObject({
      sha: SHA,
      attempt: '2',
      titan: 'pass',
      lemnos: 'pass',
      compared: 'vitest+bun',
      tests_titan: '2',
      tests_lemnos: '2',
      disagree: '0',
      neither: '0',
      titan_part_s: '770',
      titan_lock_wait_s: '12',
      titan_start_delay_s: '30',
      titan_part_end: at(770),
      lemnos_desktop_end: at(600),
    })
    expect(r.out).not.toContain('::warning::')
    expect(s.run().rows).toHaveLength(3) // a second commit appends under the one header
  })

  it('a different state is a disagreement, named; skips are listed per side; a test only one side has is named', () => {
    const s = setup()
    s.part('completed')
    s.statuses(both())
    s.titan(
      results('titan', [
        V('a.test.ts', 'red on titan', 'fail'),
        B('apps/bridge/test/k.test.ts', 'keychain', 'skip'),
        V('t.test.ts', 'titan only', 'pass'),
      ]),
    )
    s.lemnos(
      results('lemnos', [
        V('a.test.ts', 'red on titan', 'pass'),
        B('apps/bridge/test/k.test.ts', 'keychain', 'pass'),
        V('l.test.ts', 'lemnos todo', 'todo'),
      ]),
    )
    const r = s.run()
    expect(r.row).toMatchObject({ disagree: '2', skip_titan: '1', skip_lemnos: '1', only_titan: '1', only_lemnos: '1' })
    expect(r.detail).toContain('vitest\ta.test.ts\tred on titan\ttitan=fail\tlemnos=pass')
    expect(r.detail).toContain('bun\tapps/bridge/test/k.test.ts\tkeychain\ttitan=skip\tlemnos=pass')
    expect(r.detail).toMatch(/skipped on titan:\nbun\tapps\/bridge\/test\/k\.test\.ts\tkeychain\tskip/)
    expect(r.detail).toMatch(/skipped on lemnos:\nvitest\tl\.test\.ts\tlemnos todo\ttodo/)
    expect(r.detail).toContain('vitest\tt.test.ts\ttitan only')
    expect(r.out).toContain('::warning::check-shadow')
  })

  it('a disagreement in a macOS-only file (bridge or Vitest, scripts/ci-local/macos-only.sh) is not one outside them', () => {
    const s = setup()
    s.part('completed')
    s.statuses(both())
    const lines = (state: string) => [
      V('scripts/root-install-v1.test.ts', 'on a Mac', state),
      B('apps/bridge/test/apps/keychain-real.test.ts', 'keychain', state),
      V('a.test.ts', 'anywhere', state),
    ]
    s.titan(results('titan', lines('skip')))
    s.lemnos(results('lemnos', lines('pass')))
    const r = s.run()
    expect(r.row).toMatchObject({ disagree: '3', disagree_outside_macos: '1' })
  })

  it('skipped on Titan but run on Lemnos, in a file outside the macOS-only list: runs nowhere in `on`, counted and named', () => {
    const s = setup()
    s.part('completed')
    s.statuses(both())
    s.titan(
      results('titan', [
        V('scripts/companion-art.test.ts', 'python deps missing', 'skip'), // a tool skip: Lemnos would not run it in `on`
        V('a.test.ts', 'todo here', 'todo'),
        B('apps/bridge/test/apps/keychain-real.test.ts', 'keychain', 'skip'), // in the macOS list: Lemnos runs it in `on`
        V('b.test.ts', 'skipped on both', 'skip'),
        V('c.test.ts', 'skipped on lemnos', 'pass'),
      ]),
    )
    s.lemnos(
      results('lemnos', [
        V('scripts/companion-art.test.ts', 'python deps missing', 'pass'),
        V('a.test.ts', 'todo here', 'flaky'),
        B('apps/bridge/test/apps/keychain-real.test.ts', 'keychain', 'pass'),
        V('b.test.ts', 'skipped on both', 'skip'),
        V('c.test.ts', 'skipped on lemnos', 'skip'),
      ]),
    )
    const r = s.run()
    expect(r.row.runs_nowhere_in_on).toBe('2')
    const sec = r.detail.split('not in the macOS-only list):\n')[1]?.split('\n\n')[0] ?? ''
    expect(sec).toContain('vitest\tscripts/companion-art.test.ts\tpython deps missing\ttitan=skip\tlemnos=pass')
    expect(sec).toContain('vitest\ta.test.ts\ttodo here\ttitan=todo\tlemnos=flaky')
    expect(sec).not.toContain('keychain')
    expect(sec).not.toContain('skipped on')
    expect(r.out).toMatch(/::warning::check-shadow .*2 run nowhere in `on`/)
    // none: 0, and no warning for it
    const n = setup()
    n.part('completed')
    n.statuses(both())
    n.titan(results('titan', [B('apps/bridge/test/apps/keychain-real.test.ts', 'keychain', 'skip')]))
    n.lemnos(results('lemnos', [B('apps/bridge/test/apps/keychain-real.test.ts', 'keychain', 'pass')]))
    const z = n.run()
    expect(z.row.runs_nowhere_in_on).toBe('0')
    expect(z.out).toContain(', 0 run nowhere in `on`') // the keychain disagreement still warns; it names none
  })

  it('an older check-shadow.tsv (no runs_nowhere_in_on): its header gains the column at the end, its rows are kept as they were', () => {
    const s = setup()
    s.part('completed')
    s.statuses(both())
    s.titan(results('titan', [V('a.test.ts', 'a', 'pass')]))
    s.lemnos(results('lemnos', [V('a.test.ts', 'a', 'pass')]))
    const first = s.run().rows
    const oldHeader = first[0]?.split('\t').filter((h) => h !== 'runs_nowhere_in_on') ?? []
    const oldRow = (first[1] ?? '').split('\t').slice(0, oldHeader.length).join('\t')
    const tsv = join(s.T, 'home/.cache/talos-ci/logs/check-shadow.tsv')
    writeFileSync(tsv, `${oldHeader.join('\t')}\n${oldRow}\n`)
    const r = s.run()
    expect(r.rows[0]).toBe(`${oldHeader.join('\t')}\truns_nowhere_in_on`)
    expect(r.rows[1]).toBe(oldRow)
    expect(r.row.runs_nowhere_in_on).toBe('0')
    expect(r.rows).toHaveLength(3)
  })

  it('a test that ran on NEITHER side (skipped or todo on both), and a file that crashed, are findings', () => {
    const s = setup()
    s.part('completed')
    s.statuses(both())
    s.titan(results('titan', [V('a.test.ts', 'never runs', 'skip'), B('apps/bridge/test/c.test.ts', '*', 'fail')]))
    s.lemnos(results('lemnos', [V('a.test.ts', 'never runs', 'todo'), B('apps/bridge/test/c.test.ts', 'c', 'pass')]))
    const r = s.run()
    expect(r.row.neither).toBe('2')
    expect(r.detail).toMatch(/ran on neither side:\n(.*\n)*vitest\ta\.test\.ts\tnever runs\ttitan=skip\tlemnos=todo/)
    expect(r.detail).toMatch(/ran on neither side:\n(.*\n)*bun\tapps\/bridge\/test\/c\.test\.ts\t\*\tcrashed on titan/)
    expect(r.out).toContain('::warning::check-shadow')
    expect(r.out).toContain('ran on neither side')
  })

  it('a side with "# no bun results": vitest only is compared, and the row says so', () => {
    const s = setup()
    s.part('completed')
    s.statuses(both())
    s.titan(results('titan', [V('a.test.ts', 'a', 'pass'), B('apps/bridge/test/b.test.ts', 'b', 'fail')]))
    s.lemnos(results('lemnos', [V('a.test.ts', 'a', 'pass')], ['# no bun results']))
    const r = s.run()
    expect(r.row).toMatchObject({ compared: 'vitest only (no bun results)', disagree: '0', only_titan: '0' })
  })

  it('a side with no test lines never reached the suites: recorded, and no per-test comparison', () => {
    const s = setup()
    s.part('completed')
    s.statuses([...both().slice(1, 3), st('report-ci/check', 'failure', at(90), 'failed on titan: pnpm typecheck')])
    s.titan(results('titan', [], ['# no bun results']))
    s.lemnos(results('lemnos', [V('a.test.ts', 'a', 'pass')]))
    const r = s.run()
    expect(r.row).toMatchObject({
      titan: 'fail',
      compared: 'not compared: titan never reached the suites',
      neither: '-',
    })
    expect(r.row.disagree).toBe('-')
  })

  it('no answer, "not tested", or no results file: a row all the same, never a failure', () => {
    const s = setup()
    s.part('completed')
    s.statuses([
      st('report-ci/check', 'error', at(5), 'not tested: setup failed on titan (pnpm install)'),
      both()[1] as Status,
    ])
    s.lemnos(results('lemnos', [V('a.test.ts', 'a', 'pass')]))
    let r = s.run()
    expect(r.code).toBe(0)
    expect(r.row).toMatchObject({ titan: 'not-tested', compared: 'not compared: no per-test file from titan' })
    s.statuses([])
    r = s.run()
    expect(r.code).toBe(0)
    expect(r.row.titan).toBe('none')
  })

  it('"# parts elsewhere" on a side: those suites\' tests are not "only on the other side"; the row names the parts; all leading # lines skipped', () => {
    const s = setup()
    s.part('completed')
    s.statuses(both())
    s.titan(results('titan', [V('a.test.ts', 'a', 'pass'), B('apps/bridge/test/b.test.ts', 'b', 'pass')]))
    s.lemnos(
      results('lemnos', [B('apps/bridge/test/b.test.ts', 'b', 'pass')], ['# parts elsewhere: vitest:delphi', '# x: y']),
    )
    const r = s.run()
    expect(r.row).toMatchObject({
      only_titan: '0',
      only_lemnos: '0',
      neither: '0',
      parts_elsewhere: 'lemnos: vitest:delphi',
    })
    expect(r.detail).toMatch(
      /in a part run elsewhere \(lemnos: vitest:delphi\), so not compared:\nvitest\ta\.test\.ts\ta\tpass/,
    )
  })

  it('duplicate names (" #2") are joined exactly; a pass never masks the other one\'s fail', () => {
    const s = setup()
    s.part('completed')
    s.statuses(both())
    s.titan(results('titan', [V('a.test.ts', 'same', 'pass'), V('a.test.ts', 'same #2', 'fail')]))
    s.lemnos(results('lemnos', [V('a.test.ts', 'same', 'pass'), V('a.test.ts', 'same #2', 'pass')]))
    const r = s.run()
    expect(r.row.disagree).toBe('1')
    expect(r.detail).toContain('vitest\ta.test.ts\tsame #2\ttitan=fail\tlemnos=pass')
  })

  it("Titan's artifact uploaded after its status: tried again until it is there", () => {
    const s = setup()
    s.part('in_progress')
    s.statuses(both())
    s.titan(results('titan', [V('a.test.ts', 'a', 'pass')]))
    s.lemnos(results('lemnos', [V('a.test.ts', 'a', 'pass')]))
    writeFileSync(join(s.T, 'late'), '3')
    const r = s.run()
    expect(r.row).toMatchObject({ compared: 'vitest+bun', disagree: '0', tests_titan: '1' })
  })
})

describe('check-shadow.sh compare <A> <B>: the join by hand (a take-back against a normal check of the same commit)', () => {
  const cmp = (a: string, b: string) => {
    const T = mkdtempSync(join(tmpdir(), 'cicmp-'))
    dirs.push(T)
    writeFileSync(join(T, 'a.tsv'), a)
    writeFileSync(join(T, 'b.tsv'), b)
    const r = spawnSync(
      'bash',
      [join(here, 'ci-runner/check-shadow.sh'), 'compare', join(T, 'a.tsv'), join(T, 'b.tsv')],
      {
        encoding: 'utf8',
      },
    )
    return { code: r.status, out: r.stdout + r.stderr }
  }
  it('the same tests in the same states (flaky counts as pass): exit 0, zero differences', () => {
    const r = cmp(
      results('lemnos', [V('a.test.ts', 'x', 'pass'), B('apps/bridge/test/b.test.ts', 'b', 'flaky')]),
      results('lemnos', [V('a.test.ts', 'x', 'pass'), B('apps/bridge/test/b.test.ts', 'b', 'pass')]),
    )
    expect(r.code, r.out).toBe(0)
    expect(r.out).toMatch(/: vitest\+bun; 0 differ, only on a 0, only on b 0, ran on neither 0, runs nowhere in on 0$/m)
  })
  it('skipped on a (Titan) but run on b (Lemnos), outside the macOS-only list: exit 1, listed as running nowhere in `on`', () => {
    const r = cmp(
      results('titan', [
        V('scripts/companion-art.test.ts', 'x', 'skip'),
        B('apps/bridge/test/apps/keychain-real.test.ts', 'k', 'skip'),
      ]),
      results('lemnos', [
        V('scripts/companion-art.test.ts', 'x', 'pass'),
        B('apps/bridge/test/apps/keychain-real.test.ts', 'k', 'pass'),
      ]),
    )
    expect(r.code).toBe(1)
    expect(r.out).toMatch(/runs nowhere in on .*:\nvitest\tscripts\/companion-art\.test\.ts\tx\ta=skip\tb=pass\n\n/)
    expect(r.out).toContain('runs nowhere in on: 1 (listed above)')
  })
  it('a different state, or a test only one side has: exit 1, each named', () => {
    const r = cmp(
      results('lemnos', [V('a.test.ts', 'x', 'pass'), V('a.test.ts', 'gone', 'pass')]),
      results('lemnos', [V('a.test.ts', 'x', 'fail')]),
    )
    expect(r.code).toBe(1)
    expect(r.out).toContain('vitest\ta.test.ts\tx\ta=pass\tb=fail')
    expect(r.out).toMatch(/only on a:\nvitest\ta\.test\.ts\tgone\tpass/)
  })
  it('a side with no bun results: a partial compare, never exit 0, and it says which side', () => {
    const r = cmp(
      results('lemnos', [V('a.test.ts', 'x', 'pass')]),
      results('lemnos', [V('a.test.ts', 'x', 'pass')], ['# no bun results']),
    )
    expect(r.code).toBe(2)
    expect(r.out).toMatch(/^partial compare: bun results missing on b /m)
  })
  it('a test that ran on neither side (skipped on both, or a file crashed on both): exit 1, listed', () => {
    const skipped = cmp(
      results('lemnos', [V('a.test.ts', 'x', 'pass'), V('a.test.ts', 'never', 'skip')]),
      results('lemnos', [V('a.test.ts', 'x', 'pass'), V('a.test.ts', 'never', 'todo')]),
    )
    expect(skipped.code).toBe(1)
    expect(skipped.out).toMatch(/ran on neither side:\nvitest\ta\.test\.ts\tnever\ta=skip\tb=todo/)
    expect(skipped.out).toContain('ran on neither side: 1 (listed above)')
    const crashed = cmp(
      results('lemnos', [V('a.test.ts', 'x', 'pass'), B('apps/bridge/test/c.test.ts', '*', 'fail')]),
      results('lemnos', [V('a.test.ts', 'x', 'pass'), B('apps/bridge/test/c.test.ts', '*', 'fail')]),
    )
    expect(crashed.code).toBe(1)
    expect(crashed.out).toContain('bun\tapps/bridge/test/c.test.ts\t*\tcrashed on a')
  })
  it('a side whose parts ran elsewhere: a partial compare, never exit 0', () => {
    const r = cmp(
      results('lemnos', [B('apps/bridge/test/b.test.ts', 'b', 'pass')], ['# parts elsewhere: vitest:delphi']),
      results('lemnos', [B('apps/bridge/test/b.test.ts', 'b', 'pass'), V('a.test.ts', 't2', 'pass')]),
    )
    expect(r.code).toBe(2)
    expect(r.out).toContain('partial compare: parts run elsewhere (a: vitest:delphi)')
  })
  it('a side that never reached the suites: exit 2; no files: usage, 64', () => {
    expect(
      cmp(results('lemnos', [V('a.test.ts', 'x', 'pass')]), results('lemnos', [], ['# no bun results'])).code,
    ).toBe(2)
    expect(spawnSync('bash', [join(here, 'ci-runner/check-shadow.sh'), 'compare']).status).toBe(64)
  })
})
