// ci-runner.sh e2e-shadow (scripts/ci-runner/e2e-shadow.sh; docs/CI-MACHINES.md, "The e2e packages on Titan"): with
// CI_TITAN_BROWSER=e2e-shadow, Titan's report-ci/browser-e2e beside Lemnos's own result for the same packages on the same commit,
// one row of ~/.cache/talos-ci/logs/e2e-shadow.tsv, every disagreement named by its tests. Run for real with a fake `gh` that
// applies the script's own --jq to JSON files (so the filters are the real ones) and serves Titan's log artifact.
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

const SHA = 'c'.repeat(40)
const SHORT = SHA.slice(0, 7)
const A = 'https://github.com/owner/talos-app/actions/runs/9/attempts/2#'
const T0 = '2026-11-13T10:00:00Z' // the part's pending
const T0_EPOCH = Date.parse(T0) / 1000
type Status = { context: string; state: string; target_url: string; description: string; created_at: string }
const st = (state: string, at: string, description = '', link = `${A}browser-e2e`): Status => ({
  context: 'report-ci/browser-e2e',
  state,
  target_url: link,
  description,
  created_at: at,
})
const at = (s: number) => new Date((T0_EPOCH + s) * 1000).toISOString().replace('.000Z', 'Z')

/** Lemnos's browser log, as job_browser writes it in e2e-shadow (web first, then the rest, each marked). */
const lemnosLog = (opts: { web?: string[]; rest?: string[]; rc?: number; webEnd?: number } = {}) =>
  [
    '+ pnpm test:browser',
    '[step] 3s exit 0: pnpm test:browser',
    '+ pnpm -r --workspace-concurrency=1 --no-bail --if-present --filter @talos-app/web test:e2e',
    ...(opts.web ?? []),
    '[step] 400s exit 0: pnpm -r --workspace-concurrency=1 --no-bail --if-present --filter @talos-app/web test:e2e',
    `e2e-shadow: web ended at ${opts.webEnd ?? T0_EPOCH + 100}`,
    '+ pnpm -r --workspace-concurrency=1 --no-bail --if-present --filter !@talos-app/web test:e2e',
    ...(opts.rest ?? []),
    `[step] 300s exit ${opts.rc ?? 0}: pnpm -r --workspace-concurrency=1 --no-bail --if-present --filter !@talos-app/web test:e2e`,
    `e2e-shadow: the other e2e packages ended with exit ${opts.rc ?? 0}`,
    '',
  ].join('\n')
const RUN = 'Run the browser-e2e part (scripts/ci-local.sh)'
const red = (t: string) => `  ✘  3 ${t} (1.2s)`

function setup() {
  const T = mkdtempSync(join(tmpdir(), 'cishadow-'))
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
  [ -f "${T}/artifact/$n" ] || exit 1
  mkdir -p "$d" && cp "${T}/artifact/$n" "$d/${SHORT}-browser-e2e.log"; exit 0
fi
case "$*" in *"/statuses?"*) f="${T}/statuses.json" ;; *"/jobs?"*) f="${T}/jobs.json" ;; *) exit 1 ;; esac
[ -f "$f" ] || exit 1
q=""; while [ $# -gt 0 ]; do [ "$1" = --jq ] && q="$2"; shift; done
jq -r "$q" "$f"
`,
  )
  const statuses = (rows: Status[]) => writeFileSync(join(T, 'statuses.json'), JSON.stringify(rows))
  /** The part's job; its run step started `runAt` (the pending comes after any wait for a slot or for load). */
  const part = (status: string, runAt = at(-45)) =>
    writeFileSync(
      join(T, 'jobs.json'),
      JSON.stringify({
        jobs: [
          { name: 'local-ci on ci-runner', status: 'in_progress', steps: [{ name: RUN, started_at: at(-500) }] },
          {
            name: 'browser-e2e',
            status,
            steps: [
              { name: 'Guard (same repo, plain ref, its own jobs)', started_at: at(-60) },
              { name: RUN, started_at: runAt },
            ],
          },
        ],
      }),
    )
  const titanLog = (lines: string[]) => {
    mkdirSync(join(T, 'artifact'), { recursive: true })
    writeFileSync(join(T, 'artifact', 'ci-logs-browser-e2e-2'), `${lines.join('\n')}\n`)
  }
  const lemnos = (text: string) => writeFileSync(join(logs, `${SHORT}-browser.log`), text)
  const run = (env: Record<string, string> = {}) => {
    const r = spawnSync('bash', [join(here, 'ci-runner.sh'), 'e2e-shadow'], {
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
        CI_E2E_SHADOW_POLL: '1',
        CI_PART_JOB: 'browser-e2e',
        CI_PART_RUN_STEP: RUN,
        ...env,
      },
      timeout: 60_000,
    })
    const tsv = join(logs, 'e2e-shadow.tsv')
    const rows = existsSync(tsv) ? readFileSync(tsv, 'utf8').trim().split('\n') : []
    return { code: r.status, out: r.stdout + r.stderr, rows, row: (rows.at(-1) ?? '').split('\t') }
  }
  return { T, statuses, part, titanLog, lemnos, run }
}
// the columns, in order
const COL = {
  date: 0,
  sha: 1,
  attempt: 2,
  titan: 3,
  lemnos: 4,
  agree: 5,
  tests: 6,
  titanSecs: 7,
  titanDelay: 8,
  titanEnd: 9,
  webEnd: 10,
  afterWeb: 11,
} as const

describe.skipIf(!hasJq)('ci-runner.sh e2e-shadow: one row per shadow commit, every disagreement named', () => {
  it('both green: a row that agrees, with the part time, its end, Lemnos web end and the gap between them', () => {
    const s = setup()
    s.part('completed')
    s.statuses([st('success', at(330), 'passed on titan in 320s'), st('pending', T0, 'running')])
    s.lemnos(lemnosLog())
    const r = s.run()
    expect(r.code).toBe(0)
    expect(r.rows[0]).toBe(
      'date\tsha\tattempt\ttitan\tlemnos\tagree\tdisagreeing_tests\ttitan_part_s\ttitan_start_delay_s\ttitan_part_end\tlemnos_web_end\tpart_end_minus_web_end_s',
    )
    expect(r.row[COL.sha]).toBe(SHA)
    expect(r.row[COL.attempt]).toBe('2')
    expect([r.row[COL.titan], r.row[COL.lemnos], r.row[COL.agree], r.row[COL.tests]]).toEqual([
      'pass',
      'pass',
      'yes',
      '',
    ])
    expect(r.row[COL.titanSecs]).toBe('330')
    expect(r.row[COL.titanDelay]).toBe('45') // its run step began 45 s before the pending: a slot, or Titan's load
    expect(r.row[COL.titanEnd]).toBe(at(330))
    expect(r.row[COL.webEnd]).toBe(at(100))
    expect(r.row[COL.afterWeb]).toBe('230')
    // a second commit appends, under the one header
    expect(s.run().rows).toHaveLength(3)
  })

  it("Titan red, Lemnos green: a disagreement, with Titan's failing tests from its log artifact; said in the job's log", () => {
    const s = setup()
    s.part('completed')
    s.statuses([st('failure', at(300), 'failed on titan; see ~/.cache/talos-ci/logs/x.log'), st('pending', T0)])
    s.titanLog([
      red('tests/relay-a.spec.ts:5:1 › reconnects'),
      red('[chromium] › test/b.spec.ts:9:3 › loads'),
      '  ✓  4 tests/c.spec.ts:1:1 › fine',
    ])
    s.lemnos(lemnosLog())
    const r = s.run()
    expect([r.row[COL.titan], r.row[COL.lemnos], r.row[COL.agree]]).toEqual(['fail', 'pass', 'no'])
    expect(r.row[COL.tests]).toBe(
      'titan only: [chromium] › test/b.spec.ts:9:3 › loads | tests/relay-a.spec.ts:5:1 › reconnects',
    )
    expect(r.out).toContain('::warning::e2e-shadow')
    expect(r.out).toContain('tests/relay-a.spec.ts:5:1 › reconnects')
  })

  it("Lemnos red in the other packages: its tests from that call only (web's own reds are not the part's)", () => {
    const s = setup()
    s.part('completed')
    s.statuses([st('success', at(300), 'passed on titan in 290s'), st('pending', T0)])
    s.lemnos(
      lemnosLog({
        web: [red('[iphone] › test/web-only.spec.ts:1:1 › web red')],
        rest: [red('tests/e2e-x.spec.ts:2:1 › x')],
        rc: 1,
      }),
    )
    const r = s.run()
    expect([r.row[COL.titan], r.row[COL.lemnos], r.row[COL.agree]]).toEqual(['pass', 'fail', 'no'])
    expect(r.row[COL.tests]).toBe('lemnos only: tests/e2e-x.spec.ts:2:1 › x')
  })

  it('both red on the same tests: they agree; on different ones, each side named', () => {
    const s = setup()
    s.part('completed')
    s.statuses([st('failure', at(300)), st('pending', T0)])
    s.titanLog([red('tests/a.spec.ts:1:1 › a')])
    s.lemnos(lemnosLog({ rest: [red('tests/a.spec.ts:1:1 › a')], rc: 1 }))
    expect(s.run().row.slice(COL.titan, COL.tests + 1)).toEqual(['fail', 'fail', 'yes', ''])
    s.titanLog([red('tests/a.spec.ts:1:1 › a'), red('tests/b.spec.ts:1:1 › b')])
    s.lemnos(lemnosLog({ rest: [red('tests/a.spec.ts:1:1 › a'), red('tests/c.spec.ts:1:1 › c')], rc: 1 }))
    const r = s.run()
    expect(r.row[COL.agree]).toBe('no')
    expect(r.row[COL.tests]).toBe('titan only: tests/b.spec.ts:1:1 › b; lemnos only: tests/c.spec.ts:1:1 › c')
  })

  it('a red side whose tests cannot be named is never counted as agreeing', () => {
    const s = setup()
    s.part('completed')
    s.statuses([st('failure', at(300)), st('pending', T0)]) // and no artifact
    s.lemnos(lemnosLog({ rest: [red('tests/a.spec.ts:1:1 › a')], rc: 1 }))
    const r = s.run()
    expect(r.row[COL.agree]).toBe('unknown')
    expect(r.out).toContain('::warning::e2e-shadow')
    expect(r.row[COL.tests]).toContain('titan red, no test named')
  })

  it('a "skipped" success ran nothing: not a pass, not compared; "not tested" and no answer are recorded the same way', () => {
    const s = setup()
    s.lemnos(lemnosLog())
    s.part('completed')
    s.statuses([st('success', at(10), 'skipped: no browser-e2e inputs changed since abc1234'), st('pending', T0)])
    expect(s.run().row.slice(COL.titan, COL.tests + 1)).toEqual(['skipped', 'pass', '-', 'not compared: titan skipped'])
    s.statuses([st('error', at(10), 'not tested: setup failed on titan (pnpm install)'), st('pending', T0)])
    expect(s.run().row[COL.titan]).toBe('not-tested')
    s.statuses([])
    const none = s.run()
    expect(none.row.slice(COL.titan, COL.tests + 1)).toEqual(['none', 'pass', '-', 'not compared: titan none'])
    expect(none.row[COL.titanDelay]).toBe('-')
    expect(none.out).toContain('::warning::e2e-shadow') // no answer from Titan is the lead's to see too
  })

  it('an empty status field does not shift the others (no target link, no description)', () => {
    const s = setup()
    s.lemnos(lemnosLog())
    s.part('completed')
    s.statuses([st('success', at(200), ''), st('pending', T0, '')])
    const r = s.run()
    expect(r.row.slice(COL.titan, COL.agree + 1)).toEqual(['pass', 'pass', 'yes'])
    expect(r.row[COL.titanEnd]).toBe(at(200))
    // a run step that seems to start after the pending (clocks apart): no delay rather than a negative one
    s.part('completed', at(30))
    expect(s.run().row[COL.titanDelay]).toBe('-')
  })

  it("only this attempt's status: an earlier attempt's answer is not this one's", () => {
    const s = setup()
    s.lemnos(lemnosLog())
    s.part('completed')
    s.statuses([
      st(
        'success',
        at(10),
        'passed on titan',
        'https://github.com/owner/talos-app/actions/runs/9/attempts/1#browser-e2e',
      ),
    ])
    expect(s.run().row[COL.titan]).toBe('none')
  })

  it('no browser log here, or one without the shadow lines: Lemnos none, not compared, no web end', () => {
    const s = setup()
    s.part('completed')
    s.statuses([st('success', at(300), 'passed on titan'), st('pending', T0)])
    let r = s.run()
    expect(r.row.slice(COL.titan, COL.tests + 1)).toEqual(['pass', 'none', '-', 'not compared: lemnos none'])
    expect(r.row[COL.webEnd]).toBe('-')
    s.lemnos('+ pnpm -r --workspace-concurrency=1 --no-bail --if-present test:e2e\n[step] 500s exit 0: x\n')
    r = s.run()
    expect(r.row[COL.lemnos]).toBe('none')
  })

  it("waits for Titan's answer while its job works; its job queued past CI_E2E_SHADOW_QUEUED, or done with no answer: none, at once", () => {
    const s = setup()
    s.lemnos(lemnosLog())
    s.part('queued')
    s.statuses([])
    const t = Date.now()
    expect(s.run({ CI_E2E_SHADOW_QUEUED: '2' }).row[COL.titan]).toBe('none')
    expect(Date.now() - t).toBeLessThan(15_000)
    s.part('in_progress')
    const w = Date.now()
    expect(s.run({ CI_E2E_SHADOW_WAIT: '2' }).row[COL.titan]).toBe('none')
    expect(Date.now() - w).toBeGreaterThanOrEqual(1000) // waited at least a poll (the limit counts whole seconds)
  })

  it('never fails the job: missing inputs say so and exit 0', () => {
    const s = setup()
    for (const v of ['CI_PLAN_SHA', 'GITHUB_REPOSITORY', 'GITHUB_RUN_ID']) {
      const r = s.run({ [v]: '' })
      expect(r.code, v).toBe(0)
      expect(r.out, v).toContain('nothing recorded')
      expect(r.rows, v).toEqual([])
    }
  })
})
