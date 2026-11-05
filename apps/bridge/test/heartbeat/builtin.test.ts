// The three built-in sources, run through the real runner. `gh` is a small script that answers like GitHub's API (response
// shapes checked against real `gh api` output for pulls, commit status, check-runs and notifications on 2026-11-04) and
// refuses like `gh` does (a path it has no answer for is a 404 and exit 1; signed out is exit 4 with the login hint).
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fakeClock } from '@talos-app/testkit'
import type { RunNote } from '../../src/schedules/sidecar.ts'
import { fileShare } from '../../src/share/inbox-file.ts'
import { type Harness, startHarness } from '../helpers.ts'
import { config, type Kit, kit, MON_1000_UTC, sourceOf, tmpDir } from './kit.ts'

let h: Harness
let clock: ReturnType<typeof fakeClock>
let dir: string
let k: Kit
const NOW = Date.parse(MON_1000_UTC)
const ago = (hours: number) => new Date(NOW - hours * 3600_000).toISOString()

async function start(
  extra: {
    runs?: () => Array<[string, RunNote]>
    missed?: () => Array<{ id: string; name: string; ds: string }>
    ghBin?: string
  } = {},
) {
  clock = fakeClock(MON_1000_UTC)
  h = await startHarness({ clock, config: (c) => ({ ...c, timezone: 'UTC', quiet_window: null }) })
  const ctx = h.bridge.ctx
  k = kit(h, clock, {
    builtin: (self) => ({
      home: ctx.paths.home,
      userHome: ctx.env.userHome,
      runs: extra.runs ?? (() => []),
      missed: extra.missed ?? (() => []),
      jobName: (id) => `Job ${id}`,
      selfJobId: self,
      ...(extra.ghBin ? { ghBin: extra.ghBin } : {}),
    }),
  })
}
beforeEach(() => {
  dir = tmpDir('hb-gh-')
})
afterEach(async () => {
  await h?.stop()
})

const fileFor = (path: string) => `${path.replace(/[/?&=#]/g, '_')}.json`
/** A fake `gh`: answers from <dir>/answers/, logs every call to <dir>/calls.log. */
function fakeGh(answers: Record<string, unknown>, opts: { signedOut?: boolean; hang?: boolean } = {}): string {
  const ans = join(dir, 'answers')
  mkdirSync(ans, { recursive: true })
  for (const [path, body] of Object.entries(answers)) writeFileSync(join(ans, fileFor(path)), JSON.stringify(body))
  const bin = join(dir, 'gh')
  writeFileSync(
    bin,
    `#!/bin/sh
echo "$@" >> '${join(dir, 'calls.log')}'
[ "$1" = api ] || { echo "unknown command" >&2; exit 2; }
${opts.signedOut ? 'echo "To get started with GitHub CLI, please run:  gh auth login" >&2; exit 4' : ''}
${opts.hang ? 'sleep 300' : ''}
f="${ans}/$(printf '%s' "$2" | tr '/?&=#' '_____').json"
if [ -f "$f" ]; then cat "$f"; else echo "gh: Not Found (HTTP 404)" >&2; exit 1; fi
`,
  )
  chmodSync(bin, 0o755)
  return bin
}
const calls = () => {
  try {
    return readFileSync(join(dir, 'calls.log'), 'utf8').trim().split('\n')
  } catch {
    return []
  }
}

const ghSource = (over: Record<string, unknown> = {}) => ({
  id: 'gh',
  kind: 'github' as const,
  enabled: true,
  args: { repos: ['acme/widgets'] },
  timeout_s: 5,
  ...over,
})

const note = (repo: string, id: string, reason: string, title: string, over: Record<string, unknown> = {}) => ({
  id,
  unread: true,
  reason,
  updated_at: ago(1),
  last_read_at: null,
  url: `https://api.github.com/notifications/threads/${id}`,
  subscription_url: `https://api.github.com/notifications/threads/${id}/subscription`,
  subject: {
    title,
    url: `https://api.github.com/repos/${repo}/pulls/7`,
    latest_comment_url: null,
    type: 'PullRequest',
  },
  repository: { full_name: repo, html_url: `https://github.com/${repo}` },
  ...over,
})
const pr = (n: number, over: Record<string, unknown> = {}) => ({
  number: n,
  title: `PR number ${n}`,
  state: 'open',
  draft: false,
  updated_at: ago(30),
  html_url: `https://github.com/acme/widgets/pull/${n}`,
  head: { sha: `sha${n}` },
  ...over,
})
const status = (sha: string, statuses: Array<{ context: string; state: string; updated_at: string }>) => ({
  sha,
  state: statuses.length ? (statuses.some((s) => s.state !== 'success') ? 'failure' : 'success') : 'pending',
  statuses,
})
const checks = (
  runs: Array<{ name: string; status: string; conclusion: string | null; completed_at: string | null }>,
) => ({
  total_count: runs.length,
  check_runs: runs,
})

describe('github', () => {
  const answersFor = (nowNotes: unknown[], prs: unknown[], per: Record<string, [unknown, unknown]>) => ({
    'notifications?per_page=1': [],
    [`notifications?per_page=50&since=${encodeURIComponent(MON_1000_UTC)}`]: nowNotes,
    'repos/acme/widgets/pulls?state=open&sort=updated&direction=desc&per_page=10': prs,
    ...Object.fromEntries(
      Object.entries(per).flatMap(([sha, [s, c]]) => [
        [`repos/acme/widgets/commits/${sha}/status`, s],
        [`repos/acme/widgets/commits/${sha}/check-runs?per_page=100`, c],
      ]),
    ),
  })

  test('the first look only proves gh works and raises nothing; the next one finds what named the owner', async () => {
    const bin = fakeGh(
      answersFor(
        [
          note('acme/widgets', '11', 'review_requested', 'Please review the widget'),
          note('acme/widgets', '12', 'mention', 'You were mentioned'),
          note('acme/widgets', '13', 'ci_activity', 'CI ACTIVITY NOISE'),
          note('acme/widgets', '14', 'subscribed', 'SUBSCRIBED NOISE'),
          note('acme/other', '15', 'mention', 'WRONG REPO'),
        ],
        [],
        {},
      ),
    )
    await start({ ghBin: bin })
    const cfg = config([ghSource()])
    const first = await k.run(cfg)
    expect(first.result.outcome).toBe('silent')
    expect(calls()).toEqual(['api notifications?per_page=1'])
    clock.advance(0)
    const second = await k.run(cfg)
    expect(second.result.items_new).toBe(2)
    const text = k
      .rows()
      .map((r) => r.text)
      .join('\n')
    expect(text).toContain('Please review the widget')
    expect(text).toContain('You were mentioned')
    expect(text).not.toContain('NOISE') // ci_activity and every other reason raise nothing
    expect(text).not.toContain('WRONG REPO')
    expect(k.store().items['gh|gh:11'].level).toBe('act')
    expect(k.store().items['gh|gh:11'].url).toBe('https://github.com/acme/widgets/pull/7')
  })

  test('ci_activity alone raises nothing at all: the slot is silent', async () => {
    const bin = fakeGh(answersFor([note('acme/widgets', '21', 'ci_activity', 'build finished')], [], {}))
    await start({ ghBin: bin })
    await k.run(config([ghSource()]))
    const out = await k.run(config([ghSource()]))
    expect(out.result.outcome).toBe('silent')
    expect(out.result.items_seen).toBe(0)
    expect(k.rows()).toEqual([])
  })

  test('a PR red for over 24 h is act; green and untouched for 24 h is fyi; fresh red, pending, drafts and quiet PRs raise nothing', async () => {
    const prs = [
      pr(1),
      pr(2),
      pr(3, { updated_at: ago(2) }),
      pr(4),
      pr(5, { draft: true }),
      pr(6, { updated_at: ago(3) }),
      pr(7),
    ]
    const bin = fakeGh(
      answersFor([], prs, {
        sha1: [status('sha1', [{ context: 'local-ci/test', state: 'failure', updated_at: ago(30) }]), checks([])],
        sha2: [
          status('sha2', []),
          checks([{ name: 'build', status: 'completed', conclusion: 'success', completed_at: ago(30) }]),
        ],
        sha3: [status('sha3', [{ context: 'local-ci/test', state: 'failure', updated_at: ago(2) }]), checks([])],
        sha4: [
          status('sha4', []),
          checks([{ name: 'build', status: 'in_progress', conclusion: null, completed_at: null }]),
        ],
        sha6: [
          status('sha6', []),
          checks([{ name: 'build', status: 'completed', conclusion: 'success', completed_at: ago(3) }]),
        ],
        sha7: [
          status('sha7', []),
          checks([{ name: 'unit', status: 'completed', conclusion: 'failure', completed_at: ago(40) }]),
        ],
      }),
    )
    await start({ ghBin: bin })
    await k.run(config([ghSource()]))
    const out = await k.run(config([ghSource()]))
    const keys = Object.keys(k.store().items).sort()
    expect(keys).toEqual([
      'gh|gh:pr:acme/widgets#1:local-ci/test',
      'gh|gh:pr:acme/widgets#2:green',
      'gh|gh:pr:acme/widgets#7:unit', // a failing check-run counts like a failing status
    ])
    expect(k.store().items[keys[0] as string].level).toBe('act')
    expect(k.store().items[keys[1] as string].level).toBe('fyi')
    expect(out.result.items_new).toBe(3)
    expect(calls().some((c) => c.includes('sha5'))).toBe(false) // drafts are not looked at
  })

  test('signed out is a source error that names the problem, never a silent slot', async () => {
    await start({ ghBin: fakeGh({}, { signedOut: true }) })
    const out = await k.run(config([ghSource()]))
    expect(out.result.outcome).toBe('failed')
    expect(sourceOf(out.result, 'gh')?.error).toBe('gh is not signed in on this Mac')
    expect(k.rows()[0]?.text).toContain('gh is not signed in')
  })

  test('gh missing from the machine is a source error', async () => {
    await start({ ghBin: join(dir, 'no-gh-here') })
    const out = await k.run(config([ghSource()]))
    expect(out.result.outcome).toBe('failed')
    expect(sourceOf(out.result, 'gh')?.error).toContain('could not start')
  })

  test('one PR whose status call fails fails the source, so a red PR is never quietly skipped', async () => {
    const bin = fakeGh(answersFor([], [pr(1), pr(2)], { sha1: [status('sha1', []), checks([])] })) // sha2 has no answer: 404
    await start({ ghBin: bin })
    await k.run(config([ghSource()]))
    const out = await k.run(config([ghSource()]))
    expect(out.result.outcome).toBe('failed')
    expect(sourceOf(out.result, 'gh')?.error).toContain('gh failed')
  })

  test('a hanging gh is killed at the source timeout', async () => {
    await start({ ghBin: fakeGh({}, { hang: true }) })
    const out = await k.run(config([ghSource()]))
    expect(sourceOf(out.result, 'gh')?.error).toContain('no answer within 5 s')
  })

  test('hostile PR and notification text is escaped; a malformed row does not take the others down', async () => {
    const bin = fakeGh(
      answersFor(
        [
          note('acme/widgets', '31', 'mention', 'Evil‮ title\u001b[31m'),
          'not an object',
          { id: 'x', reason: 'mention', repository: 'nope', subject: null },
          note('acme/widgets', '32', 'review_requested', 'Fine one'),
        ],
        [],
        {},
      ),
    )
    await start({ ghBin: bin })
    await k.run(config([ghSource()]))
    await k.run(config([ghSource()]))
    const text = k
      .rows()
      .map((r) => r.text)
      .join('\n')
    expect(text).toContain('Fine one')
    expect(text).toContain('⟦U+202E⟧')
    expect(text).not.toContain('‮')
  })
})

describe('inbox', () => {
  const file = (n: string, text: string) =>
    fileShare(h.bridge.ctx, {
      shareId: `sh_${n}`,
      label: 'Safari',
      message: {
        id: `m_${n}`,
        thread_id: 'inbox',
        author: 'owner',
        kind: 'text',
        text,
        format: 'plain',
        attachments: [],
        via: 'share',
        created_at: MON_1000_UTC,
      } as never,
      files: [],
    })

  test('shares filed since the last look are one fyi update each; the first look is a baseline', async () => {
    await start()
    file('one', 'old share')
    const cfg = config([{ id: 'inbox', kind: 'inbox', enabled: true, args: {}, timeout_s: 5 }])
    expect((await k.run(cfg)).result.outcome).toBe('silent') // baseline: what was already there is not news
    expect(k.rows()).toEqual([])
    file('two', 'a new share')
    const out = await k.run(cfg)
    expect(out.result.outcome).toBe('fyi')
    expect(out.result.items_new).toBe(1)
    expect(k.rows()[0]?.text).toContain('Shared via Safari')
    expect(k.rows()[0]?.silent).toBe(true)
    expect((await k.run(cfg)).result.outcome).toBe('silent')
  })

  test('no shared-inbox folder yet is fine, not an error', async () => {
    await start()
    const out = await k.run(config([{ id: 'inbox', kind: 'inbox', enabled: true, args: {}, timeout_s: 5 }]))
    expect(out.result.outcome).toBe('silent')
    expect(sourceOf(out.result, 'inbox')?.ok).toBe(true)
  })
})

describe('schedule-failures', () => {
  const sf = config([{ id: 'sched-failures', kind: 'schedule-failures', enabled: true, args: {}, timeout_s: 5 }])
  test('a run that failed since the last look is one fyi update; the first look is a baseline; the heartbeat itself is left out', async () => {
    const runs: Array<[string, RunNote]> = []
    await start({ runs: () => runs })
    runs.push([
      'r_old',
      {
        id: 'digest',
        ds: '2026-10-04',
        status: 'failed',
        started_at: ago(30),
        trigger: 'clock',
        at: NOW - 30 * 3600_000,
      },
    ])
    expect((await k.run(sf)).result.outcome).toBe('silent')
    clock.advance(3600_000)
    runs.push([
      'r_new',
      { id: 'digest', ds: '2026-10-05', status: 'timed_out', started_at: ago(0), trigger: 'clock', at: NOW + 1000 },
    ])
    runs.push([
      'r_self',
      { id: 'beat', ds: '2026-10-05', status: 'failed', started_at: ago(0), trigger: 'clock', at: NOW + 1000 },
    ])
    runs.push([
      'r_ok',
      { id: 'digest', ds: '2026-10-05', status: 'ok', started_at: ago(0), trigger: 'clock', at: NOW + 1000 },
    ])
    const out = await k.run(sf)
    expect(out.result.items_new).toBe(1)
    expect(k.rows()[0]?.text).toContain('Scheduled job "Job digest" ran out of time')
  })

  test('a missed slot is reported once per job and day', async () => {
    const missed = [{ id: 'digest', name: 'Digest', ds: '2026-10-05' }]
    await start({ missed: () => missed })
    expect((await k.run(sf)).result.outcome).toBe('silent') // the first look is a baseline
    const second = await k.run(sf)
    expect(second.result.outcome).toBe('fyi')
    expect(k.rows()[0]?.text).toContain('Scheduled job "Digest" was missed')
    expect((await k.run(sf)).result.outcome).toBe('silent') // same job, same day: said once
    expect(k.rows().length).toBe(1)
  })
})
