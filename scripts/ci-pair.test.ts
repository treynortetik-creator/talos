// scripts/ci-pair.sh, Lemnos's side of re-running browser with Titan's browser-e2e part (docs/CI-MACHINES.md, "The e2e packages
// on Titan"): Lemnos's ci job fails when the part's job does, so "Re-run failed jobs" of the part re-runs browser too. Titan
// never waits for Lemnos. Run for real with a fake `gh` that applies the script's own --jq to a jobs JSON (so the filter is the real one).
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, describe, expect, it } from 'vitest'
import { fakeTool } from './fake-tool'

const here = dirname(fileURLToPath(import.meta.url))
const script = join(here, 'ci-pair.sh')
const hasJq = spawnSync('jq', ['--version']).status === 0
const dirs: string[] = []
afterAll(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

const LEMNOS = 'local-ci on ci-runner'
const PART = 'browser-e2e'
type Step = { name: string; status: string; conclusion?: string | null }
type Job = { name: string; status: string; conclusion?: string | null; steps?: Step[] }

/** Each poll serves the next of `polls` (the last one repeats); `null` is a failed read. */
function run(sub: string, polls: (Job[] | null)[], env: Record<string, string> = {}) {
  const T = mkdtempSync(join(tmpdir(), 'cipair-'))
  dirs.push(T)
  const bin = join(T, 'bin')
  mkdirSync(bin)
  for (const [i, p] of polls.entries())
    writeFileSync(join(T, `poll.${i}`), p === null ? 'FAIL' : JSON.stringify({ jobs: p }))
  fakeTool(
    bin,
    'gh',
    `#!/bin/bash
n=$(cat "${T}/n" 2>/dev/null || echo 0); echo $((n + 1)) > "${T}/n"
f="${T}/poll.$n"; [ -f "$f" ] || f="${T}/poll.${polls.length - 1}"
[ "$(cat "$f")" = FAIL ] && exit 1
q=""; while [ $# -gt 0 ]; do [ "$1" = --jq ] && q="$2"; shift; done
jq -r "$q" "$f"
`,
  )
  const r = spawnSync('bash', [script, sub], {
    encoding: 'utf8',
    env: {
      PATH: `${bin}:${process.env.PATH}`,
      GITHUB_REPOSITORY: 'owner/talos-app',
      GITHUB_RUN_ID: '9',
      GH_TOKEN: 't',
      CI_PART_JOB: PART,
      CI_BROWSER_E2E_PART: PART, // e2e, the fold: the only mode that pairs (the ci job sets it then, and only then)
      CI_PAIR_POLL: '1',
      ...env,
    },
    timeout: 60_000,
  })
  const polled = existsSync(join(T, 'n')) ? Number(readFileSync(join(T, 'n'), 'utf8')) : 0
  return { code: r.status, out: r.stdout + r.stderr, polled }
}
const lemnos = (status: string): Job => ({ name: LEMNOS, status })
const ok = (name: string): Step => ({ name, status: 'completed', conclusion: 'success' })
const RUN = 'Run the browser-e2e part (scripts/ci-local.sh)'
/** The part's job: its setup step, then its run step. */
const part = (status: string, run: Step, conclusion: string | null = null): Job => ({
  name: PART,
  status,
  conclusion,
  steps: [ok('Guard (same repo, plain ref, its own jobs)'), run],
})

describe.skipIf(!hasJq)("ci-pair.sh part (Lemnos's ci): it fails when the part's job fails", () => {
  it('waits while the part works, then exit 0 on its success', () => {
    const r = run('part', [
      [part('in_progress', { name: RUN, status: 'in_progress' })],
      [part('in_progress', ok(RUN))],
      [part('completed', ok(RUN), 'success')],
    ])
    expect(r.code).toBe(0)
    expect(r.polled).toBe(3)
  })

  it('a step of the part failed (its run red, its setup failed): exit 1 at once, so a re-run of the part re-runs browser', () => {
    const red = run('part', [[part('in_progress', { name: RUN, status: 'completed', conclusion: 'failure' })]])
    expect(red.code).toBe(1)
    expect(red.polled).toBe(1)
    expect(red.out).toContain('Re-run failed jobs')
    const setup = run('part', [
      [{ name: PART, status: 'in_progress', steps: [{ name: 'Guard', status: 'completed', conclusion: 'failure' }] }],
    ])
    expect(setup.code).toBe(1)
  })

  it('the part ended any other way than success: exit 1', () => {
    for (const c of ['failure', 'cancelled', 'timed_out', null])
      expect(run('part', [[part('completed', ok(RUN), c)]]).code, String(c)).toBe(1)
  })

  it('the part never started (Titan off or busy) or is not in the run: exit 0, nothing to pair (close cancels it)', () => {
    for (const st of ['queued', 'waiting', 'pending', 'requested']) {
      const r = run('part', [[lemnos('in_progress'), { name: PART, status: st }]])
      expect(r.code, st).toBe(0)
      expect(r.out, st).toContain('never started')
    }
    expect(run('part', [[lemnos('in_progress')]]).code).toBe(0)
  })

  it("another job's failed step does not count", () => {
    const r = run('part', [
      [
        part('in_progress', { name: RUN, status: 'in_progress' }),
        { ...lemnos('in_progress'), steps: [{ name: 'x', status: 'completed', conclusion: 'failure' }] },
      ],
      [part('completed', ok(RUN), 'success')],
    ])
    expect(r.code).toBe(0)
    expect(r.polled).toBe(2)
  })

  it('GitHub unreadable five times in a row: exit 1; one lapse is not enough', () => {
    const r = run('part', [null])
    expect(r.code).toBe(1)
    expect(r.polled).toBe(5)
    const lapse = run('part', [
      null,
      null,
      [part('in_progress', ok(RUN))],
      null,
      null,
      null,
      null,
      [part('completed', ok(RUN), 'success')],
    ])
    expect(lapse.code).toBe(0)
    expect(lapse.polled).toBe(8)
  })
})

// e2e-shadow (run 43549764317): Titan's part is report-only there, so its red (an infra one: no Playwright host libraries)
// must never fail Lemnos's job; nor off, nor e2e without its wait (plan then hands Titan nothing, so CI_BROWSER_E2E_PART is unset)
describe.skipIf(!hasJq)('ci-pair.sh part pairs only when Lemnos folds the part (CI_BROWSER_E2E_PART)', () => {
  const failed = [part('completed', { name: RUN, status: 'completed', conclusion: 'failure' }, 'failure')]
  it('shadow, off, or e2e without its wait (no CI_BROWSER_E2E_PART): a failed part leaves Lemnos green, nothing read', () => {
    const r = run('part', [failed], { CI_BROWSER_E2E_PART: '' })
    expect(r.code).toBe(0)
    expect(r.polled).toBe(0)
    expect(r.out).toContain('does not fold the part')
  })
  it('e2e (CI_BROWSER_E2E_PART set): a failed part still fails Lemnos', () => {
    expect(run('part', [failed]).code).toBe(1)
  })
})

describe('ci-pair.sh: its inputs', () => {
  it('the part job must be named, the poll is whole seconds, and part is the only side (Titan never waits for Lemnos)', () => {
    for (const v of ['CI_PART_JOB', 'GITHUB_RUN_ID', 'GITHUB_REPOSITORY'])
      expect(run('part', [[]], { [v]: '' }).code, v).toBe(64)
    for (const p of ['0', 'x', '1.5']) expect(run('part', [[]], { CI_PAIR_POLL: p }).code, p).toBe(64)
    for (const sub of ['lemnos', 'pair', 'nope']) expect(run(sub, [[]]).code, sub).toBe(64)
  })
})

// check on Titan (CI_TITAN_CHECK): the same pair for check-titan, keyed on CI_CHECK_PART (set by the ci job in `on` only). In
// shadow the part is report-only and must never fail Lemnos's job, and the browser-e2e fold's variable does not count for it.
describe.skipIf(!hasJq)('ci-pair.sh part for check-titan pairs only when Lemnos folds check (CI_CHECK_PART)', () => {
  const CHECK = 'check-titan'
  const failed = [
    {
      name: CHECK,
      status: 'completed',
      conclusion: 'failure',
      steps: [
        ok('Guard (same repo, plain ref, its own jobs)'),
        { name: 'Run', status: 'completed', conclusion: 'failure' },
      ],
    },
  ]
  it('on (CI_CHECK_PART set): a failed check-titan fails Lemnos, so a re-run takes both', () => {
    const r = run('part', [failed], { CI_PART_JOB: CHECK, CI_CHECK_PART: CHECK, CI_BROWSER_E2E_PART: '' })
    expect(r.code).toBe(1)
    expect(r.out).toContain(`${CHECK}'s step 'Run' failed`)
  })
  it('shadow or off (no CI_CHECK_PART): a failed check-titan leaves Lemnos green, nothing read, even with the e2e fold on', () => {
    for (const e2e of ['', PART]) {
      const r = run('part', [failed], { CI_PART_JOB: CHECK, CI_CHECK_PART: '', CI_BROWSER_E2E_PART: e2e })
      expect(r.code, e2e).toBe(0)
      expect(r.polled, e2e).toBe(0)
      expect(r.out).toContain('does not fold the part')
    }
  })
  it('the browser-e2e pair is not opened by CI_CHECK_PART', () => {
    const r = run('part', [[part('completed', { name: RUN, status: 'completed', conclusion: 'failure' }, 'failure')]], {
      CI_BROWSER_E2E_PART: '',
      CI_CHECK_PART: CHECK,
    })
    expect(r.code).toBe(0)
    expect(r.polled).toBe(0)
  })
})
