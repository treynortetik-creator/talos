// The three built-in sources (docs/HEARTBEAT.md). They run in the bridge, not as a process, but they answer exactly like a
// process would: the JSON text a source prints, which the runner reads with the same `parseHeartbeatSourceResponse`. So one
// parse (and one escape of untrusted text) covers every source, built in or not.
//
//   schedule-failures  failed, timed-out, restarted or missed runs of the bridge's own scheduled jobs (fyi)
//   inbox              things filed into the shared inbox since the last look (fyi)
//   github             PRs on the configured repos: red for 24 h (act), green and untouched for 24 h (fyi), and the
//                      notifications that name the owner (review requested, mention, assigned, security alert: act).
//                      `ci_activity` and every other reason raise nothing.
//
// Each one baselines first: with no cursor it records where it is and raises nothing (a source's first run is not news).
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  HEARTBEAT_SOURCE_MAX_ITEMS,
  HEARTBEAT_SOURCE_SCHEMA,
  type HeartbeatSourceConfigT,
  type HeartbeatSourceRequestT,
} from '@talos-app/protocol'
import type { RunNote } from '../schedules/sidecar.ts'
import { sharedInboxDir } from '../share/inbox-file.ts'
import { baseEnv, runSource } from './spawn.ts'

export type BuiltinDeps = {
  /** $TALOS_APP_HOME. */
  home: string
  /** The owner's home folder: `gh` finds its own sign-in there. */
  userHome: string
  /** The bridge's finished-run notes (the schedules sidecar). */
  runs(): Array<[string, RunNote]>
  /** Jobs whose slot was missed today, by the scheduler's own word. */
  missed(): Array<{ id: string; name: string; ds: string }>
  jobName(id: string): string
  /** The heartbeat job itself: its own failures are reported by the run, not as an item of its own run. */
  selfJobId: string
  /** The `gh` binary; found on a fixed PATH when absent. */
  ghBin?: string | undefined
}

type Answer = { cursor: Record<string, unknown> | null; items: Array<Record<string, unknown>> }
export const answerText = (a: Answer) =>
  JSON.stringify({ schema: HEARTBEAT_SOURCE_SCHEMA, status: 'ok', cursor: a.cursor, items: a.items })

const DAY_MS = 24 * 3600_000
const FAILED = new Set(['failed', 'timed_out', 'session_ended'])
const FAIL_WORDS: Record<string, string> = {
  failed: 'reported a failure',
  timed_out: 'ran out of time',
  session_ended: 'was cut off by a restart',
}

function scheduleFailures(req: HeartbeatSourceRequestT, d: BuiltinDeps): Answer {
  const at = Date.parse(req.now)
  if (req.cursor === null || typeof req.cursor.at !== 'number') return { cursor: { at }, items: [] }
  const since = req.cursor.at
  const items: Answer['items'] = []
  for (const [runId, note] of d.runs()) {
    if (note.id === d.selfJobId || !note.status || !FAILED.has(note.status)) continue
    const t = note.finished_at ? Date.parse(note.finished_at) : note.at
    if (!(t >= since)) continue
    items.push({
      key: `sched:${runId}`,
      sig: note.status,
      title: `Scheduled job "${d.jobName(note.id)}" ${FAIL_WORDS[note.status] ?? note.status}`,
      level: 'fyi',
      class: 'own',
      why: 'schedule.failed',
      deadline: null,
    })
  }
  for (const m of d.missed())
    if (m.id !== d.selfJobId)
      items.push({
        key: `sched:missed:${m.id}:${m.ds}`,
        sig: '1',
        title: `Scheduled job "${m.name}" was missed: no session was running in its window`,
        level: 'fyi',
        class: 'own',
        why: 'schedule.missed',
        deadline: null,
      })
  return { cursor: { at }, items: items.slice(0, HEARTBEAT_SOURCE_MAX_ITEMS) }
}

const SHARE_HEAD = /^## (\d{2}:\d{2}) · Shared via (.+?) · share (\S+)\s*$/gm
const SEEN_KEEP = 300
function inbox(req: HeartbeatSourceRequestT, d: BuiltinDeps): Answer {
  const dir = sharedInboxDir(d.home)
  const found: Array<{ id: string; label: string; time: string; day: string }> = []
  if (existsSync(dir)) {
    // newest day files first; three days is more than a heartbeat's look-back needs
    const days = readdirSync(dir)
      .filter((f) => /^\d{4}-\d{2}-\d{2}\.md$/.test(f))
      .sort()
      .reverse()
      .slice(0, 3)
    for (const f of days) {
      const text = readFileSync(join(dir, f), 'utf8')
      for (const m of text.matchAll(SHARE_HEAD))
        found.push({ id: m[3] as string, label: m[2] as string, time: m[1] as string, day: f.slice(0, 10) })
    }
  }
  const prior = req.cursor?.seen
  const seenBefore = Array.isArray(prior) ? new Set(prior.map(String)) : null
  const ids = found.map((f) => f.id)
  const seen = [...new Set([...ids, ...(seenBefore ?? [])])].slice(0, SEEN_KEEP)
  if (seenBefore === null) return { cursor: { seen }, items: [] }
  const items = found
    .filter((f) => !seenBefore.has(f.id))
    .slice(0, HEARTBEAT_SOURCE_MAX_ITEMS)
    .map((f) => ({
      key: `inbox:share:${f.id}`,
      sig: '1',
      title: `Shared via ${f.label} at ${f.time}`,
      level: 'fyi',
      class: 'own',
      why: 'inbox.share',
      deadline: null,
    }))
  return { cursor: { seen }, items }
}

// ---- github

const ACT_REASONS = new Set(['review_requested', 'mention', 'assign', 'security_alert'])
/** Open PRs looked at per repo, and in all per run: each one costs two `gh` calls. */
const PRS_PER_REPO = 10
const PR_CHECK_BUDGET = 30

type Json = Record<string, unknown>
const isObj = (x: unknown): x is Json => x !== null && typeof x === 'object' && !Array.isArray(x)
const str = (x: unknown): string | undefined => (typeof x === 'string' && x !== '' ? x : undefined)
const httpsOnly = (u: string | undefined) => (u && /^https:\/\/[^\s]+$/.test(u) ? u : undefined)

function ghFailure(stderr: string): string {
  if (/gh auth login|not logged in|authentication|GH_TOKEN|HTTP 401/i.test(stderr))
    return 'gh is not signed in on this Mac'
  const line = stderr.split('\n').find((l) => l.trim() !== '') ?? 'no details'
  return `gh failed: ${line.trim().slice(0, 120)}`
}

function bin(d: BuiltinDeps): string {
  if (d.ghBin) return d.ghBin
  const found = Bun.which('gh', { PATH: baseEnv(d.userHome).PATH ?? '' })
  if (!found) throw new Error('gh (the GitHub command line) is not installed on this Mac')
  return found
}

async function ghJson(path: string, d: BuiltinDeps, deadline: number, signal: AbortSignal): Promise<unknown> {
  const left = deadline - Date.now()
  if (left <= 0) throw new Error('ran out of time before every PR was checked')
  const r = await runSource({
    argv: [bin(d), 'api', path],
    env: baseEnv(d.userHome, { GH_PROMPT_DISABLED: '1', NO_COLOR: '1', GH_NO_UPDATE_NOTIFIER: '1' }),
    stdin: '',
    timeoutMs: left,
    signal,
    maxBytes: 4 * 1024 * 1024,
  })
  if (!r.ok) throw new Error(`gh ${r.reason}: ${r.message}`)
  if (r.code !== 0) throw new Error(ghFailure(r.stderr))
  try {
    return JSON.parse(r.stdout)
  } catch {
    throw new Error('gh printed something that is not JSON')
  }
}

function htmlUrlOf(subjectUrl: string | undefined, repoUrl: string | undefined): string | undefined {
  const m = /^https:\/\/api\.github\.com\/repos\/([^/]+\/[^/]+)\/(pulls|issues)\/(\d+)$/.exec(subjectUrl ?? '')
  if (m) return `https://github.com/${m[1]}/${m[2] === 'pulls' ? 'pull' : 'issues'}/${m[3]}`
  return httpsOnly(repoUrl)
}

type Ci = { red: Array<{ name: string; at: number }>; pending: boolean; total: number }
async function prCi(repo: string, sha: string, d: BuiltinDeps, deadline: number, signal: AbortSignal): Promise<Ci> {
  const status = await ghJson(`repos/${repo}/commits/${sha}/status`, d, deadline, signal)
  const checks = await ghJson(`repos/${repo}/commits/${sha}/check-runs?per_page=100`, d, deadline, signal)
  const ci: Ci = { red: [], pending: false, total: 0 }
  for (const s of isObj(status) && Array.isArray(status.statuses) ? status.statuses : []) {
    if (!isObj(s)) continue
    ci.total++
    if (s.state === 'pending') ci.pending = true
    if ((s.state === 'failure' || s.state === 'error') && str(s.context))
      ci.red.push({ name: str(s.context) as string, at: Date.parse(str(s.updated_at) ?? '') })
  }
  for (const c of isObj(checks) && Array.isArray(checks.check_runs) ? checks.check_runs : []) {
    if (!isObj(c)) continue
    ci.total++
    if (c.status !== 'completed') ci.pending = true
    else if ((c.conclusion === 'failure' || c.conclusion === 'timed_out') && str(c.name))
      ci.red.push({ name: str(c.name) as string, at: Date.parse(str(c.completed_at) ?? '') })
  }
  return ci
}

async function github(
  args: { repos: string[] },
  req: HeartbeatSourceRequestT,
  d: BuiltinDeps,
  deadline: number,
  signal: AbortSignal,
): Promise<Answer> {
  const nowMs = Date.parse(req.now)
  const since = typeof req.cursor?.since === 'string' ? req.cursor.since : null
  // The first look only proves `gh` works and is signed in; it raises nothing.
  if (since === null) {
    await ghJson('notifications?per_page=1', d, deadline, signal)
    return { cursor: { since: req.now }, items: [] }
  }
  const items: Answer['items'] = []
  const notes = await ghJson(`notifications?per_page=50&since=${encodeURIComponent(since)}`, d, deadline, signal)
  if (!Array.isArray(notes)) throw new Error('gh notifications did not come back as a list')
  for (const n of notes) {
    if (!isObj(n) || !isObj(n.repository) || !isObj(n.subject)) continue
    const reason = str(n.reason)
    const repo = str(n.repository.full_name)
    const id = str(n.id)
    if (!reason || !ACT_REASONS.has(reason) || !repo || !id || !args.repos.includes(repo)) continue
    items.push({
      key: `gh:${id}`,
      sig: str(n.updated_at) ?? '1',
      title: `${repo}: ${str(n.subject.title) ?? 'a notification'}`,
      level: 'act',
      class: 'own',
      why: `github.${reason}`.replace(/_/g, '-'),
      url: htmlUrlOf(str(n.subject.url), str(n.repository.html_url)),
      deadline: null,
    })
  }
  let budget = PR_CHECK_BUDGET
  for (const repo of args.repos) {
    if (budget <= 0) break
    const prs = await ghJson(
      `repos/${repo}/pulls?state=open&sort=updated&direction=desc&per_page=${PRS_PER_REPO}`,
      d,
      deadline,
      signal,
    )
    if (!Array.isArray(prs)) throw new Error(`gh pulls for ${repo} did not come back as a list`)
    for (const pr of prs) {
      if (budget <= 0) break
      if (!isObj(pr) || pr.draft === true || !isObj(pr.head)) continue
      const n = typeof pr.number === 'number' ? pr.number : undefined
      const sha = str(pr.head.sha)
      if (n === undefined || !sha) continue
      budget--
      const ci = await prCi(repo, sha, d, deadline, signal)
      const url = httpsOnly(str(pr.html_url))
      const title = str(pr.title) ?? `PR ${n}`
      // "red for 24 h" is counted from the LATEST failure: a fresh red is someone mid-work, not a stuck PR
      const redSince = ci.red.length ? Math.max(...ci.red.map((r) => r.at)) : Number.NaN
      if (ci.red.length && Number.isFinite(redSince) && nowMs - redSince >= DAY_MS) {
        for (const r of ci.red)
          items.push({
            key: `gh:pr:${repo}#${n}:${r.name}`,
            sig: sha,
            title: `${repo}#${n} ${r.name} red for over 24 h: ${title}`,
            level: 'act',
            class: 'own',
            why: 'github.ci-red-24h',
            url,
            deadline: null,
          })
      } else if (!ci.red.length && !ci.pending && ci.total > 0) {
        const touched = Date.parse(str(pr.updated_at) ?? '')
        if (Number.isFinite(touched) && nowMs - touched >= DAY_MS)
          items.push({
            key: `gh:pr:${repo}#${n}:green`,
            sig: sha,
            title: `${repo}#${n} is green and untouched for a day: ${title}`,
            level: 'fyi',
            class: 'own',
            why: 'github.pr-green-24h',
            url,
            deadline: null,
          })
      }
    }
  }
  const rank = (i: Json) => (i.level === 'act' ? 0 : 1)
  items.sort((a, b) => rank(a) - rank(b))
  return { cursor: { since: req.now }, items: items.slice(0, HEARTBEAT_SOURCE_MAX_ITEMS) }
}

/** The JSON text a built-in source "prints". Throws a plain Error for a source error. */
export async function runBuiltin(
  cfg: Extract<HeartbeatSourceConfigT, { kind: 'github' | 'schedule-failures' | 'inbox' }>,
  req: HeartbeatSourceRequestT,
  d: BuiltinDeps,
  signal: AbortSignal,
  timeoutMs: number,
): Promise<string> {
  if (cfg.kind === 'schedule-failures') return answerText(scheduleFailures(req, d))
  if (cfg.kind === 'inbox') return answerText(inbox(req, d))
  return answerText(await github(cfg.args, req, d, Date.now() + timeoutMs, signal))
}
