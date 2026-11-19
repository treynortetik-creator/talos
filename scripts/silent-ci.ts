// The silent-failure sweep: a CI job that keeps failing, or stops reporting, is told to the lead's inbox (scripts/lead-inbox.sh)
// instead of waiting for someone to look. Two broke unseen in one week of 2026-11: the web-bundle publish (2 days) and
// report-ci/fast (30 h). Read-only towards CI: it reads workflow runs, commit statuses and deployments, and only posts alerts.
//
//   bun scripts/silent-ci.ts            read GitHub, post each finding (one alert per finding per UTC day: reruns post nothing new)
//   bun scripts/silent-ci.ts --dry-run  print the findings, post nothing
//
// The rules (analyze() below, which the tests drive with fixed data):
//   - a workflow whose last 2 completed runs on main both failed, the newest within 8 days (skipped and cancelled runs do not
//     count; a workflow that stopped running long ago is history);
//   - a report-ci/*, hostile-ci/* or nightly-ci/* status whose 2 newest reports on main both failed, or whose newest report on
//     main is more than 26 h old while CI is running (report-ci/superseded is a marker, not a verdict, and is left out);
//   - web-bundle/save: its 2 newest reports failed, or the live production deploy is more than 90 minutes old and its commit has
//     no successful web-bundle/save (a save follows each deploy, so a clock alone would cry wolf on quiet days).
// nightly-ci/* and ci-part/* are watched like report-ci/*. A push-only context is stale only when a commit landed after its last
// report (over 2 h ago) and it still said nothing: a weekend with no pushes is quiet, an outage with pushes is not. The nightly
// ones get 50 h. Statuses are read for 72 h of main.
// When GitHub cannot be read, that is a finding too: a sweep that cannot look must not look like a quiet week.
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

export const STALE_MS = 26 * 3600_000
/** nightly-ci/* and hostile-ci/* report once a night (and GitHub can delay a scheduled run): two missed nights is stale. */
export const NIGHTLY_STALE_MS = 50 * 3600_000
export const SAVE_GRACE_MS = 90 * 60_000
/** A workflow whose newest run is older than this no longer runs: its old red is history, not a silent failure (weekly jobs fit). */
export const RECENT_MS = 8 * 24 * 3600_000
const FAILED_RUN = new Set(['failure', 'timed_out', 'startup_failure'])
const UNCOUNTED_RUN = new Set(['skipped', 'cancelled', 'neutral', 'action_required', 'stale'])
const FAILED_STATUS = new Set(['failure', 'error'])
/** The statuses this sweep watches; and those whose reports show CI is running at all. */
const WATCHED = /^(?:(?:report-ci|hostile-ci|nightly-ci|ci-part)\/.+|web-bundle\/save)$/
/** A push-only context has this long after a newer commit lands before its silence counts (CI takes a while). */
export const CI_GRACE_MS = 2 * 3600_000
/**
 * One job, two names: a CI part posts report-ci/* (or nightly-ci/report-*) in shadow mode and ci-part/* (nightly-ci/part-*)
 * when it is on (ci-runner.yml, CI_TITAN_CHECK and its e2e twin). Either name reporting is the job alive, so a pair goes stale
 * only when both are quiet, and a mode flipped back to shadow is not a new alert.
 */
const PAIRS: [string, string][] = [
  ['report-ci/check', 'ci-part/check'],
  ['report-ci/browser-e2e', 'ci-part/browser-e2e'],
  ['nightly-ci/report-check', 'nightly-ci/part-check'],
  ['nightly-ci/report-browser-e2e', 'nightly-ci/part-browser-e2e'],
]
export const PAIRED: Record<string, string> = Object.fromEntries(
  PAIRS.flatMap(([x, y]) => [
    [x, y],
    [y, x],
  ]),
)
/** How far back main's commit statuses are read: a context newer than this and older than STALE_MS is the one gone quiet. */
export const WINDOW_MS = 72 * 3600_000

export type Run = { conclusion: string; created_at: string; url: string }
export type Status = { state: string; created_at: string; sha: string; url?: string }
export type Input = {
  /** workflow name -> its completed runs on main, newest first */
  workflows: Record<string, Run[]>
  /** status context -> the newest report of it on each main commit that has one, newest commit first */
  statuses: Record<string, Status[]>
  /** the live production deploy (newest success), if any, and its commit's web-bundle/save state (read for that commit) */
  liveDeploy?: { sha: string; at: string; save?: string }
  /** main's commits of the statuses window, newest first, with their commit time */
  commits?: { sha: string; at: string }[]
  /** the parts of GitHub that could not be read (each part is read on its own, so the rest is still checked) */
  unreadable?: string[]
}
export type Finding = { id: string; text: string }

const slug = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
const day = (now: number) => new Date(now).toISOString().slice(0, 10).replace(/-/g, '')
const ago = (now: number, at: string) => `${Math.round((now - Date.parse(at)) / 3600_000)} h ago`

export function analyze(input: Input, now: number): Finding[] {
  const out: Finding[] = []
  const d = day(now)
  for (const [name, runs] of Object.entries(input.workflows)) {
    const counted = runs.filter((r) => !UNCOUNTED_RUN.has(r.conclusion))
    const [a, b] = counted
    if (
      a &&
      b &&
      FAILED_RUN.has(a.conclusion) &&
      FAILED_RUN.has(b.conclusion) &&
      now - Date.parse(a.created_at) <= RECENT_MS
    )
      out.push({
        id: `silent-wf-${slug(name)}-${d}-red`,
        text: `Workflow "${name}": its last 2 completed runs on main failed (${a.conclusion} ${ago(now, a.created_at)}, ${b.conclusion} ${ago(now, b.created_at)}). Newest: ${a.url}`,
      })
  }
  // a push-only context (report-ci, ci-part) has gone quiet when a commit landed after its last report, long enough ago for CI
  // to have run on it, and it still said nothing: a weekend with no pushes is not stale, and an outage with pushes is. The
  // nightly ones (nightly-ci, hostile-ci) run every day whatever is pushed: two missed nights is stale.
  const quietSince = (ctx: string, last: number) =>
    /^(?:nightly-ci|hostile-ci)\//.test(ctx)
      ? now - last > NIGHTLY_STALE_MS
      : now - last > STALE_MS &&
        (input.commits ?? []).some((c) => Date.parse(c.at) > last && now - Date.parse(c.at) > CI_GRACE_MS)
  for (const [ctx, list] of Object.entries(input.statuses)) {
    if (!WATCHED.test(ctx) || ctx === 'report-ci/superseded') continue
    const [a, b] = list
    // the newest report of this job under either of its names
    const twin = PAIRED[ctx] ? input.statuses[PAIRED[ctx] as string]?.[0] : undefined
    const newest = twin && a && Date.parse(twin.created_at) > Date.parse(a.created_at) ? twin : a
    if (a && b && FAILED_STATUS.has(a.state) && FAILED_STATUS.has(b.state))
      out.push({
        id: `silent-st-${slug(ctx)}-${d}-red`,
        text: `Status ${ctx}: its 2 newest reports on main failed (${a.sha.slice(0, 8)} ${ago(now, a.created_at)}, ${b.sha.slice(0, 8)} ${ago(now, b.created_at)}).${a.url ? ` Newest: ${a.url}` : ''}`,
      })
    else if (ctx !== 'web-bundle/save' && newest && quietSince(ctx, Date.parse(newest.created_at)))
      out.push({
        id: `silent-st-${slug(ctx)}-${d}-stale`,
        text: `Status ${ctx}${PAIRED[ctx] ? ` (or ${PAIRED[ctx]}, the same job's other name)` : ''}: no report on main for ${ago(now, newest.created_at).replace(' ago', '')} (newest on ${newest.sha.slice(0, 8)}) while main moved on; its job may have stopped running (or was retired: then this stops once it is 3 days old).`,
      })
  }
  const live = input.liveDeploy
  if (live && now - Date.parse(live.at) > SAVE_GRACE_MS && live.save !== 'success')
    out.push({
      id: `silent-web-bundle-${live.sha.slice(0, 8)}-red`,
      text: `web-bundle/save: the live production deploy ${live.sha.slice(0, 8)} (${ago(now, live.at)}) has ${live.save ? `a ${live.save} save` : 'no save'}; old-client tests an older bundle. Save it: gh workflow run web-bundle.yml -f sha=${live.sha}`,
    })
  out.push(...neverReported(input, now))
  if (input.unreadable?.length)
    out.push({
      id: `silent-sweep-unreadable-${d}`,
      text: `The silent-failure sweep could not read ${input.unreadable.join(', ')} from GitHub; the rest was checked.`,
    })
  return out
}

/**
 * A commit whose CI ran but never reported one of its parts (5bc52817, 2026-11-18: local-ci/desktop's post failed, green's
 * verdict stayed partial and green stuck for 2 h unseen). A commit's CI ran when it carries local-ci/* statuses and did not
 * stand aside (report-ci/superseded); once its newest local-ci status is over CI_GRACE_MS old, a local-ci/* context it lacks
 * is a finding when the CI-run commits next to it carry that context (the newer and the older one; the older alone for the
 * newest), so a part added or removed later is no finding. Only one or two parts missing from a run that reported at least 3
 * (most missing is a run that moved on to a newer commit). Within 26 h only; one finding per commit and context.
 */
function neverReported(input: Input, now: number): Finding[] {
  const byCommit = new Map<string, Map<string, Status>>()
  for (const [ctx, list] of Object.entries(input.statuses))
    for (const st of list) {
      const m = byCommit.get(st.sha) ?? new Map<string, Status>()
      m.set(ctx, st)
      byCommit.set(st.sha, m)
    }
  const ran = (input.commits ?? [])
    .map((c) => ({ sha: c.sha, st: byCommit.get(c.sha) }))
    .filter(
      (c): c is { sha: string; st: Map<string, Status> } =>
        !!c.st && !c.st.has('report-ci/superseded') && [...c.st.keys()].some((k) => k.startsWith('local-ci/')),
    ) // newest first, as input.commits is
  const out: Finding[] = []
  ran.forEach((c, i) => {
    const local = [...c.st.entries()].filter(([k]) => k.startsWith('local-ci/'))
    const last = Math.max(...local.map(([, v]) => Date.parse(v.created_at)))
    if (now - last <= CI_GRACE_MS || now - last > STALE_MS) return
    const newer = ran[i - 1]
    const older = ran[i + 1]
    if (!older) return
    const expected = [...older.st.keys()].filter(
      (k) => k.startsWith('local-ci/') && (!newer || newer.st.has(k)) && !c.st.has(k),
    )
    // a lost post is one or two parts missing from a run that clearly ran; most parts missing is a run that moved on to a
    // newer commit (only the remote parts got there: bda23449), which green does not wait for
    if (expected.length > 2 || local.length < 3) return
    for (const ctx of expected)
      out.push({
        id: `silent-partial-${c.sha.slice(0, 8)}-${slug(ctx)}-red`,
        text: `${c.sha.slice(0, 8)}: CI ran (${local.length} local-ci parts reported, the last ${ago(now, new Date(last).toISOString())}) but never reported ${ctx}, which the commits around it carry; green's verdict for it stays partial until it does.`,
      })
  })
  return out
}

// ---- reading GitHub -----------------------------------------------------------------------------------------------------
const REPO = process.env.LEAD_INBOX_REPO ?? process.env.GITHUB_REPOSITORY ?? 'treynortetik-creator/talos-app'
/** One gh call, tried 3 times (a single 502 must not cost the whole sweep). */
function gh(args: string[]): unknown {
  for (let i = 1; ; i++)
    try {
      return JSON.parse(
        execFileSync('gh', args, {
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'pipe'],
          timeout: 60_000,
          maxBuffer: 64 << 20,
        }),
      )
    } catch (e) {
      if (i >= 3) throw e
      execFileSync('sleep', [String(Number(process.env.SILENT_CI_RETRY_S ?? 2) * i)]) // the tests set 0
    }
}
const api = (path: string) => gh(['api', path])

const HISTORY = `query($owner: String!, $name: String!, $since: GitTimestamp!, $cursor: String) {
  repository(owner: $owner, name: $name) { ref(qualifiedName: "refs/heads/main") { target { ... on Commit {
    history(first: 100, since: $since, after: $cursor) { pageInfo { hasNextPage endCursor }
      nodes { oid committedDate status { contexts { context state createdAt targetUrl } } } } } } } } }`

function readWorkflows(into: Input['workflows']) {
  const wfs = (
    api(`repos/${REPO}/actions/workflows?per_page=100`) as { workflows: { id: number; name: string; state: string }[] }
  ).workflows
  for (const w of wfs.filter((x) => x.state === 'active')) {
    // 100: a workflow that is mostly skipped runs (web-bundle's trigger) must still show its last 2 counted ones
    const runs = (
      api(`repos/${REPO}/actions/workflows/${w.id}/runs?branch=main&status=completed&per_page=100`) as {
        workflow_runs: { conclusion: string; created_at: string; html_url: string }[]
      }
    ).workflow_runs
    into[w.name] = runs.map((r) => ({ conclusion: r.conclusion, created_at: r.created_at, url: r.html_url }))
  }
}

/** Every commit on main of the last WINDOW_MS with its statuses, 100 commits a query (main takes a few hundred a day). */
function readStatuses(into: Input['statuses'], commits: NonNullable<Input['commits']>, now: number) {
  const [owner, name] = REPO.split('/') as [string, string]
  const since = new Date(now - WINDOW_MS).toISOString()
  let cursor: string | undefined
  for (let page = 0; page < 15; page++) {
    const args = [
      'api',
      'graphql',
      '-f',
      `query=${HISTORY}`,
      '-F',
      `owner=${owner}`,
      '-F',
      `name=${name}`,
      '-f',
      `since=${since}`,
    ]
    if (cursor) args.push('-f', `cursor=${cursor}`)
    const h = (
      gh(args) as {
        data: {
          repository: {
            ref: {
              target: {
                history: {
                  pageInfo: { hasNextPage: boolean; endCursor: string }
                  nodes: {
                    oid: string
                    committedDate: string
                    status: {
                      contexts: { context: string; state: string; createdAt: string; targetUrl?: string }[]
                    } | null
                  }[]
                }
              }
            }
          }
        }
      }
    ).data.repository.ref.target.history
    for (const n of h.nodes) {
      commits.push({ sha: n.oid, at: n.committedDate })
      for (const c of n.status?.contexts ?? []) {
        const list = into[c.context] ?? []
        list.push({ state: c.state.toLowerCase(), created_at: c.createdAt, sha: n.oid, url: c.targetUrl })
        into[c.context] = list
      }
    }
    if (!h.pageInfo.hasNextPage) return
    cursor = h.pageInfo.endCursor
  }
  // what was read is kept; the cap is said, not silent
  throw new Error('more than 1,500 commits in 72 h: the oldest were not read')
}

function readLiveDeploy(): Input['liveDeploy'] {
  let live: Input['liveDeploy']
  const deps = api(
    `repos/${REPO}/deployments?environment=${encodeURIComponent('talos-app / production')}&per_page=30`,
  ) as {
    id: number
    sha: string
  }[]
  for (const dep of deps) {
    const ok = (
      api(`repos/${REPO}/deployments/${dep.id}/statuses?per_page=100`) as { state: string; created_at: string }[]
    )
      .filter((s) => s.state === 'success')
      .map((s) => s.created_at)
      .sort()
      .pop()
    if (ok && (!live || ok > live.at)) live = { sha: dep.sha, at: ok }
  }
  if (!live) return undefined
  // that commit's own save, read directly: production can lag main by more than any window
  const st = (
    api(`repos/${REPO}/commits/${live.sha}/status?per_page=100`) as { statuses: { context: string; state: string }[] }
  ).statuses
  return { ...live, save: st.find((x) => x.context === 'web-bundle/save')?.state }
}

function read(now: number): Input {
  const input: Input = { workflows: {}, statuses: {}, commits: [], unreadable: [] }
  const part = (what: string, f: () => void) => {
    try {
      f()
    } catch (e) {
      input.unreadable?.push(`${what} (${String((e as Error).message).split('\n')[0]})`)
    }
  }
  part('the workflow runs', () => readWorkflows(input.workflows))
  part("main's commit statuses", () => readStatuses(input.statuses, input.commits ?? [], now))
  part('the production deploys', () => {
    input.liveDeploy = readLiveDeploy()
  })
  return input
}

function post(findings: Finding[]): number {
  const dir = mkdtempSync(join(tmpdir(), 'talos-silent-ci-'))
  let failed = 0
  try {
    for (const f of findings) {
      const file = join(dir, `${f.id}.txt`)
      writeFileSync(file, `${f.text}\n`)
      try {
        execFileSync('bash', [join(import.meta.dirname, 'lead-inbox.sh'), 'post', f.id, file], { stdio: 'inherit' })
      } catch {
        failed++
      }
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
  return failed
}

if (import.meta.main) {
  const dry = process.argv.includes('--dry-run')
  const now = Date.now()
  const findings = analyze(read(now), now)
  for (const f of findings) console.log(`${f.id}: ${f.text}`)
  if (findings.length === 0) console.log('silent-ci: nothing silent')
  if (!dry && findings.length) process.exit(post(findings) ? 1 : 0)
}
