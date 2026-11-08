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
/**
 * A fake `gh` (a small bun script): logs every call to <dir>/calls.log and answers like GitHub's API.
 * - `notifications`: the whole list. A request is answered the way GitHub does: only rows updated after `since` and before
 *   `before` (both exclusive, to the second), newest first, `per_page` rows of page `page`. `opts.shift` swaps the list for another
 *   once that many notification calls have been made, so a list can change while it is being read.
 * - every other key is an exact path -> body (a path with no answer is a 404 and exit 1).
 */
function fakeGh(
  answers: Record<string, unknown>,
  opts: {
    signedOut?: boolean
    hang?: boolean
    commitDelaySec?: number
    /** A commit lookup whose path holds this text answers at once (the rest take `commitDelaySec`). */
    quickFor?: string
    shift?: { after: number; notes: unknown[] }
  } = {},
): string {
  const ans = join(dir, 'answers')
  mkdirSync(ans, { recursive: true })
  const { notifications, ...exact } = answers
  for (const [path, body] of Object.entries(exact)) writeFileSync(join(ans, fileFor(path)), JSON.stringify(body))
  writeFileSync(join(dir, 'notifications.json'), JSON.stringify(notifications ?? []))
  if (opts.shift) writeFileSync(join(dir, 'shift.json'), JSON.stringify(opts.shift))
  const bin = join(dir, 'gh')
  writeFileSync(
    bin,
    `#!${process.execPath}
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
const dir = ${JSON.stringify(dir)}
const [cmd, path = ''] = process.argv.slice(2)
const logFile = dir + '/calls.log'
const before = existsSync(logFile) ? readFileSync(logFile, 'utf8').split('\\n').filter((l) => l.startsWith('api notifications?per_page=50')).length : 0
appendFileSync(logFile, process.argv.slice(2).join(' ') + '\\n')
if (cmd !== 'api') { console.error('unknown command'); process.exit(2) }
if (${JSON.stringify(Boolean(opts.signedOut))}) { console.error('To get started with GitHub CLI, please run:  gh auth login'); process.exit(4) }
if (${JSON.stringify(Boolean(opts.hang))}) await Bun.sleep(300000)
if (path.startsWith('notifications?')) {
  const q = new URLSearchParams(path.slice('notifications?'.length))
  if (q.get('per_page') === '1') { process.stdout.write('[]'); process.exit(0) }
  let list = JSON.parse(readFileSync(dir + '/notifications.json', 'utf8'))
  if (existsSync(dir + '/shift.json')) {
    const sh = JSON.parse(readFileSync(dir + '/shift.json', 'utf8'))
    if (before >= sh.after) list = sh.notes
  }
  const at = (n) => Date.parse(n.updated_at)
  if (q.get('since')) list = list.filter((n) => at(n) > Date.parse(q.get('since')))
  if (q.get('before')) list = list.filter((n) => at(n) < Date.parse(q.get('before')))
  list = [...list].sort((a, b) => at(b) - at(a) || String(b.id).localeCompare(String(a.id)))
  const per = Number(q.get('per_page') ?? 30)
  const page = Number(q.get('page') ?? 1)
  process.stdout.write(JSON.stringify(list.slice((page - 1) * per, page * per)))
  process.exit(0)
}
if (path.startsWith('repos/') && path.includes('/commits/') && ${JSON.stringify(opts.commitDelaySec ?? 0)} > 0 && !(${JSON.stringify(opts.quickFor ?? null)} && path.includes(${JSON.stringify(opts.quickFor ?? '')}))) {
  // a commit lookup takes a while, and the log says how many were in flight at the same moment
  mkdirSync(dir + '/inflight', { recursive: true })
  writeFileSync(dir + '/inflight/' + process.pid, '')
  appendFileSync(dir + '/inflight.log', readdirSync(dir + '/inflight').length + '\\n')
  await Bun.sleep(${JSON.stringify((opts.commitDelaySec ?? 0) * 1000)})
  rmSync(dir + '/inflight/' + process.pid, { force: true })
  appendFileSync(dir + '/finished.log', path + '\\n') // only a lookup that was left to run to the end gets here
}
const f = dir + '/answers/' + path.replace(/[/?&=#]/g, '_') + '.json'
if (existsSync(f)) process.stdout.write(readFileSync(f, 'utf8'))
else { console.error('gh: Not Found (HTTP 404)'); process.exit(1) }
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

/** The most commit lookups that were running at the same moment. */
const mostAtOnce = () => {
  try {
    return Math.max(...readFileSync(join(dir, 'inflight.log'), 'utf8').trim().split('\n').map(Number))
  } catch {
    return 0
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
  updated_at: new Date(NOW + 60_000).toISOString(), // after the first look, like a notification that came in since
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
    notifications: nowNotes,
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

  describe('more notifications than one page', () => {
    const at = (sec: number) => new Date(NOW + sec * 1000).toISOString()
    /** A notification updated `sec` seconds after the first look. */
    const mk = (id: string, sec: number, reason = 'subscribed') =>
      note('acme/widgets', id, reason, `${reason} ${id}`, { updated_at: at(sec) })
    const mine = (id: string, sec: number) => mk(id, sec, 'review_requested')
    const notifCalls = () => calls().filter((c) => c.startsWith('api notifications?per_page=50'))
    const found = () =>
      Object.keys(k.store().items)
        .filter((i) => i.startsWith('gh|gh:') && !i.includes('truncated'))
        .map((i) => i.slice(6))
        .sort()
    const src = ghSource({ timeout_s: 20 }) // 4 s in these tests: every call starts a process
    const cursor = () => k.store().sources.gh.cursor
    const iso = () => new Date(clock.now()).toISOString()
    const HOUR = 3600_000

    test('120 notifications over three pages are all read', async () => {
      const all = Array.from({ length: 120 }, (_, i) => mk(`n${i + 1}`, 3500 - i))
      all[3] = mine('p1', 3500 - 3)
      all[60] = mine('p2', 3500 - 60)
      all[119] = mine('p3', 3500 - 119)
      await start({ ghBin: fakeGh(answersFor(all, [], {})) })
      await k.run(config([src]))
      clock.advance(HOUR)
      const out = await k.run(config([src]))
      expect(out.result.items_new).toBe(3)
      expect(found()).toEqual(['p1', 'p2', 'p3'])
      expect(notifCalls().length).toBe(3) // a short last page ends it
      expect(cursor()).toEqual({ since: iso() })
    })

    test('a page cap says so and leaves the cursor behind what was not read; the next look reads the rest', async () => {
      const all = Array.from({ length: 300 }, (_, i) => mk(`n${i + 1}`, 3500 - i))
      all[9] = mine('near', 3500 - 9)
      all[279] = mine('far', 3500 - 279)
      await start({ ghBin: fakeGh(answersFor(all, [], {})) })
      await k.run(config([src]))
      clock.advance(HOUR)
      const runAt = iso()
      await k.run(config([src]))
      expect(notifCalls().length).toBe(5)
      const truncated = k.store().items['gh|gh:notifications-truncated']
      expect(truncated.level).toBe('fyi')
      expect(truncated.title).toContain('5 pages')
      expect(found()).toEqual(['near'])
      // 5 pages of 50, each starting at the row the last one ended on, reach the 246th row: everything older is unread, and
      // `before` is one second past that row, so a tie at its second is read again
      expect(cursor()).toEqual({ since: MON_1000_UTC, before: at(3500 - 245 + 1), upto: runAt })
      clock.advance(HOUR)
      await k.run(config([src]))
      expect(found()).toEqual(['far', 'near'])
      expect(cursor()).toEqual({ since: iso() })
    })

    test('notifications that share a second across the cut are not skipped, and the ones read twice are not raised twice', async () => {
      // ranks 244 to 252 all carry the same time, and the page cap (which reaches the 246th row) cuts through them
      const tie = (i: number) => i >= 243 && i <= 251
      const all = Array.from({ length: 300 }, (_, i) =>
        tie(i) ? mine(`n${1000 - i}`, 3253) : mk(`n${1000 - i}`, 3500 - i),
      )
      const ties = all.filter((_, i) => tie(i)).map((n) => (n as { id: string }).id)
      await start({ ghBin: fakeGh(answersFor(all, [], {})) })
      await k.run(config([src]))
      clock.advance(HOUR)
      await k.run(config([src]))
      expect(found().length).toBe(3) // the cut fell inside the tie
      clock.advance(HOUR)
      const out = await k.run(config([src]))
      expect(found()).toEqual([...ties].sort())
      expect(out.result.items_new).toBe(6) // the three read twice are the same items, not new ones
    })

    test('more than 50 act items: the answer stops at the cap, says so, and the rest come on the next looks', async () => {
      const all = Array.from({ length: 70 }, (_, i) => mine(`a${i + 1}`, 3500 - i))
      await start({ ghBin: fakeGh(answersFor(all, [], {})) })
      await k.run(config([src]))
      clock.advance(HOUR)
      await k.run(config([src]))
      expect(found().length).toBe(49) // one slot of the 50 is kept for the line that says so
      expect(k.store().items['gh|gh:notifications-truncated']).toBeDefined()
      expect(cursor()).toMatchObject({ since: MON_1000_UTC, before: at(3500 - 48 + 1) })
      clock.advance(HOUR)
      await k.run(config([src]))
      expect(found().length).toBe(70)
      expect(cursor()).toEqual({ since: iso() })
    })

    test('a list that changes between pages loses nothing', async () => {
      const all = Array.from({ length: 120 }, (_, i) => mk(`n${i + 1}`, 3500 - i))
      for (let i = 50; i < 55; i++) all[i] = mine(`m${i}`, 3500 - i) // ranks 51 to 55: the ones a page-number walk would skip
      // after the first page is read, five notes from page 1 are marked read
      const shifted = all.filter((_, i) => i < 2 || i > 6)
      await start({ ghBin: fakeGh(answersFor(all, [], {}), { shift: { after: 1, notes: shifted } }) })
      await k.run(config([src]))
      clock.advance(HOUR)
      await k.run(config([src]))
      expect(found()).toEqual(['m50', 'm51', 'm52', 'm53', 'm54'])
    })

    test('two unread spans merge into one, and every item is found by the end', async () => {
      const olds = Array.from({ length: 300 }, (_, i) => mk(`o${String(i).padStart(3, '0')}`, 399 - i))
      olds[299] = mine('old-first', 100) // the oldest of the first batch
      olds[150] = mine('old-mid', 399 - 150)
      const news = Array.from({ length: 300 }, (_, i) => mk(`w${String(i).padStart(3, '0')}`, 7599 - i))
      news[299] = mine('new-first', 7300)
      news[0] = mine('new-last', 7599)
      const all = [...olds]
      await start({ ghBin: fakeGh(answersFor(all, [], {})) })
      await k.run(config([src]))
      clock.advance(2 * HOUR) // 7200 s
      await k.run(config([src])) // reads the newest 250 of the first batch
      expect(cursor()).toMatchObject({ since: MON_1000_UTC, upto: iso() })
      expect(found()).toEqual(['old-mid'])
      // 300 more arrive; the budget goes to the newer span, and the older one is still unread
      const ans = JSON.parse(readFileSync(join(dir, 'notifications.json'), 'utf8'))
      writeFileSync(join(dir, 'notifications.json'), JSON.stringify([...ans, ...news]))
      clock.advance(HOUR)
      await k.run(config([src]))
      expect(cursor()).toMatchObject({ since: MON_1000_UTC, upto: iso() }) // one span, from the older start
      expect(found()).toEqual(['new-last', 'old-mid'])
      for (let i = 0; i < 3; i++) {
        clock.advance(HOUR)
        await k.run(config([src]))
      }
      expect(found()).toEqual(['new-first', 'new-last', 'old-first', 'old-mid'])
      expect(cursor()).toEqual({ since: iso() })
    })

    test('PR lookups run side by side, a few at a time', async () => {
      const prs = Array.from({ length: 8 }, (_, i) => pr(i + 1))
      const per = Object.fromEntries(prs.map((p) => [`sha${p.number}`, [status(`sha${p.number}`, []), checks([])]]))
      const bin = fakeGh(answersFor([], prs, per as never), { commitDelaySec: 0.2 })
      await start({ ghBin: bin })
      await k.run(config([src]))
      const out = await k.run(config([src]))
      expect(sourceOf(out.result, 'gh')?.ok).toBe(true)
      expect(mostAtOnce()).toBeGreaterThan(1)
      expect(mostAtOnce()).toBeLessThanOrEqual(6)
    })
  })

  test('one failed PR lookup stops the lookups still running: they end at once instead of running to the end', async () => {
    const prs = Array.from({ length: 6 }, (_, i) => pr(i + 1))
    // sha1 has no answer (a 404, at once); the other five take 3 s each
    const per = Object.fromEntries(
      prs.slice(1).map((p) => [`sha${p.number}`, [status(`sha${p.number}`, []), checks([])]]),
    )
    const bin = fakeGh(answersFor([], prs, per as never), { commitDelaySec: 3, quickFor: 'sha1/' })
    await start({ ghBin: bin })
    await k.run(config([ghSource({ timeout_s: 60 })]))
    const t0 = Date.now()
    const out = await k.run(config([ghSource({ timeout_s: 60 })]))
    expect(sourceOf(out.result, 'gh')?.ok).toBe(false)
    expect(sourceOf(out.result, 'gh')?.error).toContain('gh failed')
    expect(Date.now() - t0).toBeLessThan(2500) // waiting out the siblings would take 3 s or more
    await Bun.sleep(3500)
    let finished = ''
    try {
      finished = readFileSync(join(dir, 'finished.log'), 'utf8')
    } catch {
      // none finished: what the test wants
    }
    expect(finished).toBe('') // the siblings were killed, not left to finish
  }, 15_000)

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
  }, 15_000) // the 5 s source limit has to run out first: over bun's 5 s default

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
