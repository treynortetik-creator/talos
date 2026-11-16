// scripts/ci-swift-retry.sh: in CI a failed `swift test` is followed by one run of only the tests that failed (--filter). A pass
// then is green and those tests go to CI_FLAKE_FILE; a second failure stays red. The command under it is a fake that prints what
// swift-testing and XCTest print, fails its first run, and on the rerun writes down the arguments it got.

import { spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, describe, expect, it } from 'vitest'
import { cleanEnv } from './ci-test-env'

const here = dirname(fileURLToPath(import.meta.url))
const wrapper = join(here, 'ci-swift-retry.sh')
const dirs: string[] = []
afterAll(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

const SWIFT_TESTING = [
  '✔ Test steadyOne() passed after 0.01 seconds.',
  '✘ Test aDialogIsHeld(goesAway:) recorded an issue with 1 argument goesAway → false at A.swift:9:5: Expectation failed',
  '✘ Test aDialogIsHeld(goesAway:) with 2 test cases failed after 58.581 seconds with 4 issues.',
  '✘ Suite "Idle parking follows real activity" failed after 198.323 seconds with 4 issues.',
  '✘ Test run with 584 tests in 83 suites failed after 237.964 seconds with 5 issues (including 1 known issue).',
]
const XCTEST = [
  "Test Case '-[BridgeGuardTests.GuardTests testRefusesAnOldKey]' failed (0.004 seconds).",
  '\t Executed 12 tests, with 1 failure (0 unexpected) in 0.020 (0.021) seconds',
  "Test Suite 'All tests' failed at 2026-11-10 18:18:10.084.",
]
// byte copies of lines from a real desktop CI log: one `swift test` that ran two test products, so two end-of-run summaries,
// each with known issues ("━", withKnownIssue) that belong to no failed test
const TWO_PRODUCTS = [
  '━ Test FINDING_aToolProcessThatLeftTheGroupDoesNotOutliveACrash() recorded a known issue at ReviewOC3R2IntegrationTests.swift:458:7: Expectation failed: kill(tool, 0) != 0',
  '━ Test FINDING_aToolProcessThatLeftTheGroupDoesNotOutliveACrash() passed after 13.219 seconds with 1 known issue.',
  '✘ Test switchedOffNothingRestartsAndSwitchedOnItWaitsForTheNextRelease() recorded an issue at WorkerUpdateRestartTests.swift:263:5: Expectation failed: r.starts.count == 1',
  '✘ Test switchedOffNothingRestartsAndSwitchedOnItWaitsForTheNextRelease() failed after 9.288 seconds with 1 issue.',
  '✘ Test aCursorMovedByTheOwnerStillGetsTheLabelClickedAndNothingElse() recorded an issue at NeedsYouPopupTests.swift:235:5: Expectation failed: click(r, o, choice: 1) == .pressed(choice: 1, label: "Yes, I trust this folder")',
  '✘ Test aCursorMovedByTheOwnerStillGetsTheLabelClickedAndNothingElse() recorded an issue at NeedsYouPopupTests.swift:236:5: Expectation failed: keys.keys == ["DOWN", "ENTER"]',
  '✘ Test aCursorMovedByTheOwnerStillGetsTheLabelClickedAndNothingElse() failed after 1.443 seconds with 2 issues.',
  '✘ Suite "Restart on update (Mac)" failed after 132.210 seconds with 1 issue.',
  '✘ Suite "Needs-you popup: the click" failed after 178.858 seconds with 2 issues.',
  '✘ Test run with 916 tests in 145 suites failed after 260.348 seconds with 4 issues (including 1 known issue).',
  '✔ Test run with 495 tests in 52 suites passed after 0.005 seconds.',
  '━ Test aRecordRewrittenByTheSecurityToolLetsARemovedApprovalBack() recorded a known issue at ScreenConsentTests.swift:856:7: Expectation failed: restarted.allowedApps().isEmpty',
  '✘ Test aRecordedCloneInASessionFolderOrWithALinkOrLooseModesIsRefused() recorded an issue at AgentFolderSetupTests.swift:210:5: Expectation failed: AgentFolderSetup.recordedCloneProblem(clone, recordFile: record, unsafe: GuardsRefresh.tmpRoots)?.contains("agent sessions work in") == true',
  '━ Test aRecordRewrittenByTheSecurityToolLetsARemovedApprovalBack() passed after 2.753 seconds with 1 known issue.',
  '✘ Test aRecordedCloneInASessionFolderOrWithALinkOrLooseModesIsRefused() failed after 2.753 seconds with 1 issue.',
  '✘ Suite "Agent folder: Create, Adopt, Choose" failed after 2.788 seconds with 1 issue.',
  '✘ Test run with 1721 tests in 265 suites failed after 5.720 seconds with 3 issues (including 2 known issues).',
]
// what a real rerun prints when the one test it was given passed
const ST_PASS = [
  '✔ Test aDialogIsHeld(goesAway:) with 2 test cases passed after 30.1 seconds.',
  '✔ Test run with 1 test in 1 suite passed after 30.2 seconds.',
].join('\n')
const XC_PASS = [
  "Test Case '-[BridgeGuardTests.GuardTests testRefusesAnOldKey]' passed (0.001 seconds).",
  '\t Executed 1 test, with 0 failures (0 unexpected) in 0.001 (0.001) seconds',
].join('\n')

/** A fake `swift test`: `first` is what its first run prints (it then exits 1); `rerun` is the exit code of any later run, which
 * prints `said` (by default what a real one prints when the tests it was given ran). */
function fake(first: string[], rerun: number, said = ST_PASS) {
  const d = mkdtempSync(join(tmpdir(), 'csr-'))
  dirs.push(d)
  const cmd = join(d, 'fake-swift')
  writeFileSync(
    cmd,
    `#!/bin/bash
if [ ! -f "${d}/ran" ]; then : > "${d}/ran"; printf '%s\\n' ${first.map((l) => `'${l.replaceAll("'", "'\\''")}'`).join(' ')}; exit 1; fi
printf '%s\\n' "$*" >> "${d}/rerun"
printf '%s\\n' ${said
      .split('\n')
      .map((l) => `'${l.replaceAll("'", "'\\''")}'`)
      .join(' ')}
exit ${rerun}
`,
  )
  chmodSync(cmd, 0o755)
  const run = (env: Record<string, string> = { CI_FLAKE_FILE: join(d, 'flakes') }) =>
    spawnSync('bash', [wrapper, cmd, 'test', '--cache-path', '/c'], {
      cwd: d,
      encoding: 'utf8',
      env: { ...cleanEnv(), ...env },
    })
  const read = (f: string) => (existsSync(join(d, f)) ? readFileSync(join(d, f), 'utf8').trim().split('\n') : [])
  return { run, reruns: () => read('rerun'), flakes: () => read('flakes') }
}

describe('ci-swift-retry.sh', () => {
  it('reruns only the failed swift-testing test, by an escaped --filter, and a pass then is green and logged', () => {
    const f = fake(SWIFT_TESTING, 0)
    const r = f.run()
    expect(r.status, r.stdout + r.stderr).toBe(0)
    expect(f.reruns()).toEqual(['test --cache-path /c --filter aDialogIsHeld\\(goesAway:\\)'])
    expect(f.flakes()).toEqual([expect.stringMatching(/^aDialogIsHeld\(goesAway:\)\t/)])
    expect(r.stdout).toContain('passed on retry')
  })

  it('a rerun whose --filter matched no test is red: swift test exits 0 when nothing ran', () => {
    const f = fake(SWIFT_TESTING, 0, 'warning: No matching test cases were run')
    const r = f.run()
    expect(r.status).toBe(1)
    expect(r.stdout).toContain('did not pass on the rerun')
    expect(f.flakes()).toEqual([])
  })

  it('a run that crashed is not rerun: the tests after the crash never ran, so a pass of the named one proves nothing', () => {
    const crash = [...SWIFT_TESTING.slice(0, 3), 'error: Exited with unexpected signal code 11']
    const f = fake(crash, 0)
    expect(f.run().status).toBe(1)
    expect(f.reruns()).toEqual([])
  })

  it('a run with no end-of-run summary is not rerun: it stopped before every test had run', () => {
    const f = fake(SWIFT_TESTING.slice(0, 3), 0)
    expect(f.run().status).toBe(1)
    expect(f.reruns()).toEqual([])
  })

  it("each framework needs its own end-of-run summary: XCTest's empty one in a swift-testing package does not count", () => {
    const early = [
      ...SWIFT_TESTING.slice(0, 3),
      '\t Executed 0 tests, with 0 failures (0 unexpected) in 0.000 (0.000) seconds',
    ]
    const f = fake(early, 0)
    expect(f.run().status).toBe(1)
    expect(f.reruns()).toEqual([])
    // and an XCTest failure with only a per-class "Executed" line, no "All tests" line, is not rerun either
    const x = fake(XCTEST.slice(0, 2), 0, XC_PASS)
    expect(x.run().status).toBe(1)
    expect(x.reruns()).toEqual([])
  })

  it('an issue no failed test accounts for (a suite-level one) means no rerun', () => {
    const more = [
      ...SWIFT_TESTING.slice(0, 4),
      '✘ Test run with 584 tests in 83 suites failed after 237.964 seconds with 6 issues.',
    ]
    const f = fake(more, 0)
    expect(f.run().status).toBe(1)
    expect(f.reruns()).toEqual([])
  })

  it('two test products print two run summaries: their issues add up, known issues left out, and only the failed tests rerun', () => {
    const passed = [
      '✔ Test switchedOffNothingRestartsAndSwitchedOnItWaitsForTheNextRelease() passed after 9.1 seconds.',
      '✔ Test aCursorMovedByTheOwnerStillGetsTheLabelClickedAndNothingElse() passed after 1.4 seconds.',
      '✔ Test run with 2 tests in 2 suites passed after 9.2 seconds.',
      '✔ Test aRecordedCloneInASessionFolderOrWithALinkOrLooseModesIsRefused() passed after 2.7 seconds.',
      '✔ Test run with 1 test in 1 suite passed after 2.8 seconds.',
    ].join('\n')
    const f = fake(TWO_PRODUCTS, 0, passed)
    const r = f.run()
    expect(r.stdout).not.toContain('not rerun')
    expect(r.status, r.stdout + r.stderr).toBe(0)
    expect(f.reruns()).toEqual([
      'test --cache-path /c --filter switchedOffNothingRestartsAndSwitchedOnItWaitsForTheNextRelease\\(\\) --filter aCursorMovedByTheOwnerStillGetsTheLabelClickedAndNothingElse\\(\\) --filter aRecordedCloneInASessionFolderOrWithALinkOrLooseModesIsRefused\\(\\)',
    ])
    expect(f.flakes()).toHaveLength(3)
  })

  it('with two run summaries, a genuine issue no failed test accounts for still means no rerun', () => {
    const more = TWO_PRODUCTS.map((l) =>
      l.startsWith('✘ Test run with 1721 ') ? l.replace('with 3 issues', 'with 4 issues') : l,
    )
    const f = fake(more, 0)
    const r = f.run()
    expect(r.status).toBe(1)
    expect(r.stdout).toContain('not rerun: 5 issue(s) in the run, 4 in the failed tests')
    expect(f.reruns()).toEqual([])
  })

  it('a rerun that ran some test but not each failed one is red', () => {
    const f = fake(
      SWIFT_TESTING,
      0,
      '✔ Test somethingElse() passed after 0.1 seconds.\n✔ Test run with 1 test in 1 suite passed after 0.1 seconds.',
    )
    const r = f.run()
    expect(r.status).toBe(1)
    expect(r.stdout).toContain('did not pass on the rerun: aDialogIsHeld(goesAway:)')
    expect(f.flakes()).toEqual([])
  })

  it('an XCTest failure is rerun as Module.Class/test', () => {
    const f = fake(XCTEST, 0, XC_PASS)
    expect(f.run().status).toBe(0)
    expect(f.reruns()).toEqual(['test --cache-path /c --filter BridgeGuardTests\\.GuardTests/testRefusesAnOldKey'])
    expect(f.flakes()).toEqual([expect.stringMatching(/^BridgeGuardTests\.GuardTests\/testRefusesAnOldKey\t/)])
  })

  it('a test that fails on the rerun too stays red, and nothing is logged as a flake', () => {
    const f = fake(SWIFT_TESTING, 1)
    expect(f.run().status).toBe(1)
    expect(f.reruns()).toHaveLength(1)
    expect(f.flakes()).toEqual([])
  })

  it('a failure it cannot name for --filter is not rerun: a test with only a display name, or a build that failed', () => {
    for (const first of [['✘ Test "does a thing" failed after 1.0 seconds with 1 issue.'], ['error: compile failed']]) {
      const f = fake(first, 0)
      expect(f.run().status, first[0]).toBe(1)
      expect(f.reruns(), first[0]).toEqual([])
    }
  })

  it('without CI_FLAKE_FILE (a run by hand) it runs the command once, as it is', () => {
    const f = fake(SWIFT_TESTING, 0)
    expect(f.run({}).status).toBe(1)
    expect(f.reruns()).toEqual([])
  })
})

describe('the Swift test runs CI makes go through it', () => {
  const root = join(here, '..')
  it("the desktop job's main swift-testing run (apps/desktop/scripts/ci.sh), both the plain and the GUI branch", () => {
    const ci = readFileSync(join(root, 'apps/desktop/scripts/ci.sh'), 'utf8')
    const runs = ci.split('\n').filter((l) => /bash scripts\/test\.sh\s*$/.test(l))
    expect(runs).toHaveLength(2)
    for (const l of runs) expect(l).toContain('bash ../../scripts/ci-swift-retry.sh ')
  })
  it("the mobile job's swift test runs (job_mobile, scripts/ci-local/jobs-swift.sh)", () => {
    const text = readFileSync(join(root, 'scripts/ci-local/jobs-swift.sh'), 'utf8')
    const job = text.slice(text.indexOf('job_mobile() {'), text.indexOf('\n}\n', text.indexOf('job_mobile() {')))
    const swift = job.split('\n').filter((l) => /swift test|TalosShareCore\/test\.sh/.test(l))
    expect(swift.length).toBeGreaterThanOrEqual(2)
    for (const l of swift) expect(l).toContain('ci-swift-retry.sh')
  })
})
