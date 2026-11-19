// scripts/silent-ci.ts: the silent-failure sweep's rules on fixed data, and its command line against a gh that cannot be read.
import { execFileSync } from 'node:child_process'
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, test } from 'vitest'
import { analyze, type Input, NIGHTLY_STALE_MS, SAVE_GRACE_MS, STALE_MS } from './silent-ci.ts'

const NOW = Date.parse('2026-11-18T12:00:00Z')
const at = (msAgo: number) => new Date(NOW - msAgo).toISOString()
const H = 3600_000
const run = (conclusion: string, hAgo: number) => ({
  conclusion,
  created_at: at(hAgo * H),
  url: `https://example.com/run/${hAgo}`,
})
const st = (state: string, hAgo: number, sha = `${hAgo}`.padStart(40, 'a')) => ({
  state,
  created_at: at(hAgo * H),
  sha,
})
const none: Input = { workflows: {}, statuses: {} }
const ids = (i: Input) => analyze(i, NOW).map((f) => f.id)

describe('workflows', () => {
  test('the last 2 completed runs failed: one finding', () => {
    expect(
      ids({
        ...none,
        workflows: { 'Save the deployed web bundle': [run('failure', 1), run('failure', 5), run('success', 9)] },
      }),
    ).toEqual(['silent-wf-save-the-deployed-web-bundle-20261118-red'])
  })
  test('one failure, then a success: nothing', () => {
    expect(ids({ ...none, workflows: { ci: [run('failure', 1), run('success', 5)] } })).toEqual([])
  })
  test('skipped and cancelled runs do not count, either way', () => {
    expect(
      ids({
        ...none,
        workflows: { ci: [run('failure', 1), run('skipped', 2), run('cancelled', 3), run('timed_out', 4)] },
      }),
    ).toEqual(['silent-wf-ci-20261118-red'])
    expect(ids({ ...none, workflows: { seen: [run('skipped', 1), run('skipped', 2), run('success', 3)] } })).toEqual([])
  })
  test('a workflow whose newest run is over 8 days old no longer runs: its old red is history', () => {
    expect(ids({ ...none, workflows: { CI: [run('failure', 399), run('failure', 462)] } })).toEqual([])
    expect(ids({ ...none, workflows: { weekly: [run('failure', 7 * 24), run('failure', 14 * 24)] } })).toEqual([
      'silent-wf-weekly-20261118-red',
    ])
  })
  test('a single run that failed is not yet 2', () => {
    expect(ids({ ...none, workflows: { new: [run('failure', 1)] } })).toEqual([])
  })
})

describe('report-ci, hostile-ci and web-bundle/save statuses', () => {
  test('the 2 newest reports failed (failure or error): one finding', () => {
    expect(
      ids({ ...none, statuses: { 'report-ci/fast': [st('failure', 1), st('error', 3), st('success', 6)] } }),
    ).toEqual(['silent-st-report-ci-fast-20261118-red'])
  })
  const pushed = [{ sha: 'c'.repeat(40), at: at(3 * H) }] // a commit landed on main 3 h ago
  test('no report for over 26 h though a commit landed since: a stale finding; just under: nothing', () => {
    expect(
      ids({ ...none, commits: pushed, statuses: { 'report-ci/fast': [st('success', STALE_MS / H + 1)] } }),
    ).toEqual(['silent-st-report-ci-fast-20261118-stale'])
    expect(
      ids({ ...none, commits: pushed, statuses: { 'report-ci/fast': [st('success', STALE_MS / H - 1)] } }),
    ).toEqual([])
  })
  test('a nightly context needs no push, and is stale only after two missed nights (50 h)', () => {
    expect(ids({ ...none, statuses: { 'nightly-ci/check': [st('success', 34)] } })).toEqual([])
    expect(ids({ ...none, statuses: { 'hostile-ci/check': [st('success', NIGHTLY_STALE_MS / H + 1)] } })).toEqual([
      'silent-st-hostile-ci-check-20261118-stale',
    ])
  })
  test('a quiet weekend: no commit since the last report, so nothing is stale, even with the nightly reporting', () => {
    expect(
      ids({
        ...none,
        commits: [{ sha: 'd'.repeat(40), at: at(40 * H) }],
        statuses: { 'report-ci/fast': [st('success', 30)], 'nightly-ci/check': [st('success', 2)] },
      }),
    ).toEqual([])
  })
  test('a commit that landed under 2 h ago has not had its CI yet', () => {
    expect(
      ids({
        ...none,
        commits: [{ sha: 'e'.repeat(40), at: at(1 * H) }],
        statuses: { 'report-ci/fast': [st('success', 30)] },
      }),
    ).toEqual([])
  })
  test('an outage: commits keep landing and nothing reports at all, so each context is stale', () => {
    expect(
      ids({
        ...none,
        commits: pushed,
        statuses: { 'report-ci/fast': [st('success', 30)], 'report-ci/linux': [st('success', 30)] },
      }),
    ).toEqual(['silent-st-report-ci-fast-20261118-stale', 'silent-st-report-ci-linux-20261118-stale'])
  })
  test('a job with two names (shadow report-ci/*, on ci-part/*) is alive while either reports; stale only when both are quiet', () => {
    // the part switched on: report-ci/check went quiet, ci-part/check reports
    expect(
      ids({
        ...none,
        commits: pushed,
        statuses: { 'report-ci/check': [st('success', 46)], 'ci-part/check': [st('success', 1)] },
      }),
    ).toEqual([])
    // switched back to shadow: the reverse
    expect(
      ids({
        ...none,
        commits: pushed,
        statuses: { 'report-ci/check': [st('success', 1)], 'ci-part/check': [st('success', 46)] },
      }),
    ).toEqual([])
    // the nightly twins the same
    expect(
      ids({
        ...none,
        commits: pushed,
        statuses: {
          'nightly-ci/report-browser-e2e': [st('success', 61)],
          'nightly-ci/part-browser-e2e': [st('success', 20)],
        },
      }),
    ).toEqual([])
    // both quiet: each name is said, and the text names its other name
    const f = analyze(
      {
        ...none,
        commits: pushed,
        statuses: { 'report-ci/check': [st('success', 46)], 'ci-part/check': [st('success', 30)] },
      },
      NOW,
    )
    expect(f.map((x) => x.id)).toEqual([
      'silent-st-report-ci-check-20261118-stale',
      'silent-st-ci-part-check-20261118-stale',
    ])
    expect(f[0]?.text).toContain('(or ci-part/check, the same job')
    expect(f[0]?.text).toContain('no report on main for 30 h')
    // ci-part/* is watched by itself too, so it is covered after its shadow name leaves the window
    expect(ids({ ...none, commits: pushed, statuses: { 'ci-part/browser-e2e': [st('success', 30)] } })).toEqual([
      'silent-st-ci-part-browser-e2e-20261118-stale',
    ])
  })
  test('nightly-ci/* is watched like report-ci/*', () => {
    expect(ids({ ...none, statuses: { 'nightly-ci/full': [st('failure', 2), st('failure', 26)] } })).toEqual([
      'silent-st-nightly-ci-full-20261118-red',
    ])
  })
  test("other contexts and the superseded marker are not this sweep's", () => {
    expect(
      ids({
        ...none,
        statuses: {
          'local-ci/check': [st('failure', 1), st('failure', 2)],
          'report-ci/superseded': [st('failure', 30), st('failure', 31)],
          'talos-app - relay': [st('failure', 40)],
        },
      }),
    ).toEqual([])
  })
  test('web-bundle/save has no clock of its own: a quiet day is not stale', () => {
    expect(ids({ ...none, statuses: { 'web-bundle/save': [st('success', 50)] } })).toEqual([])
  })
})

describe('the live deploy has its bundle', () => {
  const sha = 'b'.repeat(40)
  const live = (save?: string, msAgo = SAVE_GRACE_MS + 60_000) => ({ sha, at: at(msAgo), save })
  test('no save for the live deploy after 90 minutes: one finding, named by the deploy', () => {
    const f = analyze({ ...none, liveDeploy: live() }, NOW)
    expect(f.map((x) => x.id)).toEqual(['silent-web-bundle-bbbbbbbb-red'])
    expect(f[0]?.text).toContain(`gh workflow run web-bundle.yml -f sha=${sha}`)
  })
  test('a failed save for it: a finding; a successful one: nothing', () => {
    expect(ids({ ...none, liveDeploy: live('failure') })).toEqual(['silent-web-bundle-bbbbbbbb-red'])
    expect(ids({ ...none, liveDeploy: live('success') })).toEqual([])
  })
  test('inside the 90 minutes a save is not expected yet', () => {
    expect(ids({ ...none, liveDeploy: live(undefined, SAVE_GRACE_MS - 60_000) })).toEqual([])
  })
})

test('a part that could not be read is a finding, and the rest is still checked', () => {
  expect(
    ids({
      ...none,
      workflows: { ci: [run('failure', 1), run('failure', 2)] },
      unreadable: ["main's commit statuses (HTTP 502)"],
    }),
  ).toEqual(['silent-wf-ci-20261118-red', 'silent-sweep-unreadable-20261118'])
})

test('an id is the same all day, so a second run the same day posts nothing new', () => {
  const i: Input = { ...none, workflows: { ci: [run('failure', 1), run('failure', 2)] } }
  expect(analyze(i, NOW)[0]?.id).toBe(analyze(i, NOW + 11 * H)[0]?.id)
  expect(analyze(i, NOW)[0]?.id).not.toBe(analyze(i, NOW + 13 * H)[0]?.id)
})

test('the command line: a gh that cannot be read is a finding, not a quiet run (--dry-run posts nothing)', () => {
  const bin = mkdtempSync(join(tmpdir(), 'silent-ci-gh-'))
  writeFileSync(join(bin, 'gh'), '#!/bin/sh\necho "HTTP 502: bad gateway" >&2\nexit 1\n')
  chmodSync(join(bin, 'gh'), 0o755)
  const out = execFileSync('bun', [join(import.meta.dirname, 'silent-ci.ts'), '--dry-run'], {
    encoding: 'utf8',
    env: {
      ...process.env,
      PATH: `${bin}:${process.env.PATH}`,
      LEAD_INBOX_REPO: 'example/repo',
      SILENT_CI_RETRY_S: '0',
    },
  })
  expect(out).toMatch(
    /^silent-sweep-unreadable-\d{8}: The silent-failure sweep could not read the workflow runs .*main's commit statuses .*the production deploys/m,
  )
})

test('the workflow: twice a day and by hand, main only, read-only but the inbox, no token left behind, only the sweep runs', () => {
  const wf = readFileSync(join(import.meta.dirname, '..', '.github', 'workflows', 'silent-ci.yml'), 'utf8')
  const y = JSON.parse(
    execFileSync(
      'bun',
      [
        '-e',
        'console.log(JSON.stringify(Bun.YAML.parse(await Bun.file(process.argv[1]).text())))',
        join(import.meta.dirname, '..', '.github', 'workflows', 'silent-ci.yml'),
      ],
      { encoding: 'utf8' },
    ),
  ) as {
    on: Record<string, unknown>
    permissions: unknown
    jobs: { sweep: { permissions: Record<string, string>; steps: Record<string, unknown>[] } }
  }
  expect(Object.keys(y.on).sort()).toEqual(['schedule', 'workflow_dispatch']) // never a pull request
  expect(y.permissions).toEqual({})
  expect(y.jobs.sweep.permissions).toEqual({
    contents: 'read',
    actions: 'read',
    statuses: 'read',
    deployments: 'read',
    issues: 'write',
  })
  const checkout = y.jobs.sweep.steps.find((s) => String(s.uses).startsWith('actions/checkout@')) as {
    with: Record<string, unknown>
  }
  expect(checkout.with.ref).toBe('main')
  expect(checkout.with['persist-credentials']).toBe(false)
  expect(y.jobs.sweep.steps.filter((s) => s.run).map((s) => s.run)).toEqual(['bun scripts/silent-ci.ts'])
  expect(wf).not.toMatch(/pnpm|npm install|bun install/) // installs nothing: the script needs only bun and gh
})

describe('a part CI never reported (green stays partial)', () => {
  const PARTS = [
    'local-ci/browser',
    'local-ci/check',
    'local-ci/desktop',
    'local-ci/image',
    'local-ci/mobile',
    'local-ci/mod',
  ]
  const sha = (c: string) => c.repeat(40).slice(0, 40)
  const T = `5bc52817${'a'.repeat(32)}` // 5bc52817's statuses as recorded before local-ci/desktop was re-posted
  // statuses for a list of commits: [sha, hours ago, parts it carries]
  const make = (rows: [string, number, string[]][]): Input => {
    const statuses: Input['statuses'] = {}
    for (const [s, h, parts] of rows)
      for (const p of parts) {
        const list = statuses[p] ?? []
        list.push({ state: 'success', created_at: at(h * H), sha: s })
        statuses[p] = list
      }
    return { ...none, statuses, commits: rows.map(([s, h]) => ({ sha: s, at: at((h + 0.5) * H) })) }
  }
  const without = (p: string) => PARTS.filter((x) => x !== p)
  test('5bc52817 without local-ci/desktop, both neighbours with it: one finding naming both', () => {
    const f = analyze(
      make([
        [sha('c'), 1, PARTS],
        [T, 3, without('local-ci/desktop')],
        [sha('b'), 5, PARTS],
      ]),
      NOW,
    )
    expect(f.map((x) => x.id)).toEqual(['silent-partial-5bc52817-local-ci-desktop-red'])
    expect(f[0]?.text).toContain('never reported local-ci/desktop')
  })
  test('the newest commit is judged by the one before it', () => {
    expect(
      ids(
        make([
          [T, 3, without('local-ci/desktop')],
          [sha('b'), 5, PARTS],
        ]),
      ),
    ).toEqual(['silent-partial-5bc52817-local-ci-desktop-red'])
  })
  test('within 2 h CI may still be posting; after 26 h it is history', () => {
    expect(
      ids(
        make([
          [T, 1, without('local-ci/desktop')],
          [sha('b'), 5, PARTS],
        ]),
      ),
    ).toEqual([])
    expect(
      ids(
        make([
          [T, 27, without('local-ci/desktop')],
          [sha('b'), 29, PARTS],
        ]),
      ),
    ).toEqual([])
  })
  test('a run that stood aside (report-ci/superseded) reports nothing on purpose', () => {
    const i = make([
      [sha('c'), 1, PARTS],
      [T, 3, ['local-ci/check', 'report-ci/superseded']],
      [sha('b'), 5, PARTS],
    ])
    expect(ids(i)).toEqual([])
  })
  test('a part added later (the older commit lacks it) or dropped later (the newer lacks it) is no finding', () => {
    const added = make([
      [sha('c'), 1, [...PARTS, 'local-ci/new']],
      [T, 3, PARTS],
      [sha('b'), 5, PARTS],
    ])
    expect(ids(added)).toEqual([])
    const dropped = make([
      [sha('c'), 1, without('local-ci/image')],
      [T, 3, without('local-ci/image')],
      [sha('b'), 5, PARTS],
    ])
    expect(ids(dropped)).toEqual([])
  })
  test('a run that moved on (only a remote part reached the commit, 1 of 6: bda23449) is not a lost post', () => {
    expect(
      ids(
        make([
          [sha('c'), 1, PARTS],
          [T, 3, ['local-ci/image']],
          [sha('b'), 5, PARTS],
        ]),
      ),
    ).toEqual([])
  })
  test('once the part is re-posted the gap is gone', () => {
    expect(
      ids(
        make([
          [sha('c'), 1, PARTS],
          [T, 3, PARTS],
          [sha('b'), 5, PARTS],
        ]),
      ),
    ).toEqual([])
  })
})
