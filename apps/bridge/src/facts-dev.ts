// The `main` row of `talos-app facts`: is the newest finished commit on main green? Only for a developer: a source checkout of this
// repository (a git work tree with a file that is never in the public tree) with `gh` signed in. Anything else is unknown, with the
// reason, and a user's install never asks GitHub anything for this. Read-only: GET requests through `gh api`, nothing posted, and
// nothing printed from what GitHub answers except the commit ids, ages and the names of the six CI jobs.
import { existsSync } from 'node:fs'
import { join } from 'node:path'

/** The six jobs the CI verdict is made of: `scripts/ci-runner.sh` CI_CONTEXTS (a test keeps the two the same), posted as `local-ci/<job>`. */
export const MAIN_CI_CONTEXTS: readonly string[] = ['check', 'mod', 'browser', 'image', 'desktop', 'mobile']
/** How many recent commits of main are looked at. */
export const MAIN_LOOK = 10

/** Runs `gh` with these arguments. `missing`: there is no such program. The output is only ever parsed, never shown. */
export type GhRun = (
  args: string[],
  o: { signal: AbortSignal },
) => Promise<{ code: number | null; out: string; missing?: boolean }>

const MAX_OUT = 2 * 1024 * 1024

/**
 * Runs a program and returns its trimmed stdout when it exits 0, else undefined. When `signal` aborts the child is killed (Bun
 * sends it SIGTERM) and the answer is undefined: nothing started here outlives the command's time limit.
 */
export async function realRunAsync(
  cmd: string,
  args: string[],
  o: { cwd?: string; signal: AbortSignal },
): Promise<string | undefined> {
  try {
    const p = Bun.spawn([cmd, ...args], {
      ...(o.cwd ? { cwd: o.cwd } : {}),
      stdin: 'ignore',
      stdout: 'pipe',
      stderr: 'ignore',
      signal: o.signal,
    })
    const out = await new Response(p.stdout).text()
    return (await p.exited) === 0 && out.length <= MAX_OUT ? out.trim() || undefined : undefined
  } catch {
    return undefined
  }
}

/** The git (or plutil) call of the checkout test: the arguments and the folder; the signal kills it. */
export type GitRun = (args: string[], cwd: string, o: { signal: AbortSignal }) => Promise<string | undefined>

export const realGh: GhRun = async (args, { signal }) => {
  try {
    const p = Bun.spawn(['gh', ...args], {
      stdin: 'ignore',
      stdout: 'pipe',
      stderr: 'ignore',
      signal,
      env: { ...process.env, GH_PROMPT_DISABLED: '1', NO_COLOR: '1' },
    })
    const out = await new Response(p.stdout).text()
    const code = await p.exited
    return out.length > MAX_OUT ? { code: 1, out: '' } : { code, out }
  } catch (e) {
    return { code: null, out: '', missing: (e as NodeJS.ErrnoException).code === 'ENOENT' }
  }
}

/** `owner/repo` of a GitHub remote address (https, ssh or scp form; a user or token in it is dropped), or undefined. */
export function parseGitHubRepo(remote: string): string | undefined {
  const m =
    /^(?:https?:\/\/(?:[^/@]*@)?|ssh:\/\/(?:[^/@]*@)?|[^/@:]+@)github\.com[/:]([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?\/?$/.exec(
      remote.trim(),
    )
  // `.` and `..` match the character class but are folders in a request path, never a name
  return m && ![m[1], m[2]].some((x) => x === '.' || x === '..') ? `${m[1]}/${m[2]}` : undefined
}

type Status = { context?: unknown; state?: unknown }
type Verdict = 'green' | 'red' | 'pending' | 'partial' | 'interrupted' | 'none'

/** The verdict of one commit from its statuses (newest first, as GitHub lists them); the first of each of the six wins, others are not read. */
export function classifyStatuses(rows: readonly Status[]): { verdict: Verdict; failed: string[]; pending: string[] } {
  const seen = new Map<string, string>()
  for (const r of rows) {
    if (typeof r.context !== 'string' || !r.context.startsWith('local-ci/')) continue
    const c = r.context.slice('local-ci/'.length)
    if (MAIN_CI_CONTEXTS.includes(c) && !seen.has(c)) seen.set(c, String(r.state))
  }
  const of = (s: string) => MAIN_CI_CONTEXTS.filter((c) => seen.get(c) === s)
  // an `error` state (cancelled, timed out, a runner that broke) is a red job too: it never reads as a pass
  const failed = MAIN_CI_CONTEXTS.filter((c) => seen.get(c) === 'failure' || seen.get(c) === 'error')
  const pending = of('pending')
  const out = (verdict: Verdict) => ({ verdict, failed, pending })
  if (seen.size === 0) return out('none')
  if (pending.length) return out('pending')
  if (failed.length) return out('red')
  if (seen.size < MAIN_CI_CONTEXTS.length) return out('partial')
  if (of('success').length < MAIN_CI_CONTEXTS.length) return out('interrupted')
  return out('green')
}

export type MainDeps = { checkout: string; git: GitRun; gh: GhRun; now: () => number; signal: AbortSignal }
export type MainResult = { value: Record<string, unknown> } | { unknown: string }

/** Is `dir` in a git work tree of this repository, one that has the maintainer's files? The repo's `owner/repo` when so. */
export async function sourceCheckoutRepo(
  d: Pick<MainDeps, 'checkout' | 'git' | 'signal'>,
): Promise<{ repo: string } | { unknown: string }> {
  const top = await d.git(['rev-parse', '--show-toplevel'], d.checkout, { signal: d.signal })
  // docs/CI-MACHINES.md is left out of the public tree on purpose (scripts/export-public.sh), so a user's clone has none
  if (
    !top ||
    !existsSync(join(top, 'apps', 'bridge', 'src', 'version.ts')) ||
    !existsSync(join(top, 'docs', 'CI-MACHINES.md'))
  )
    return { unknown: 'not a source checkout' }
  const repo = parseGitHubRepo((await d.git(['remote', 'get-url', 'origin'], top, { signal: d.signal })) ?? '')
  return repo ? { repo } : { unknown: 'origin is not a GitHub repository' }
}

const sha7 = (s: string) => s.slice(0, 7)

export async function mainRow(repo: string, d: MainDeps): Promise<MainResult> {
  const call = (path: string) => d.gh(['api', path], { signal: d.signal })
  const auth = await d.gh(['auth', 'status'], { signal: d.signal })
  if (auth.missing) return { unknown: 'gh is not installed' }
  if (auth.code !== 0) return { unknown: 'gh not signed in' }
  const list = await call(`repos/${repo}/commits?sha=main&per_page=${MAIN_LOOK}`)
  let commits: Array<{ sha: string; at: number }> = []
  try {
    if (list.code !== 0) throw new Error('no list')
    const raw = JSON.parse(list.out) as Array<{ sha?: unknown; commit?: { committer?: { date?: unknown } } }>
    if (!Array.isArray(raw)) throw new Error('no list')
    commits = raw
      .slice(0, MAIN_LOOK)
      .map((c) => ({ sha: String(c.sha), at: Date.parse(String(c.commit?.committer?.date)) }))
      .filter((c) => /^[0-9a-f]{40}$/.test(c.sha) && Number.isFinite(c.at))
  } catch {
    return { unknown: 'GitHub did not give the commit list' }
  }
  const rows = await Promise.all(
    commits.map(async (c) => {
      const r = await call(`repos/${repo}/commits/${c.sha}/statuses?per_page=100`)
      try {
        if (r.code !== 0) return undefined
        const parsed = JSON.parse(r.out) as unknown
        return Array.isArray(parsed) ? (parsed as Status[]) : undefined
      } catch {
        return undefined
      }
    }),
  )
  if (rows.some((r) => r === undefined)) return { unknown: "GitHub did not give a commit's statuses" }
  const now = d.now()
  const age = (at: number) => Math.max(0, Math.floor((now - at) / 1000))
  const newer: Array<Record<string, unknown>> = []
  let newest: Record<string, unknown> | null = null
  let lastGreen: Record<string, unknown> | undefined
  commits.forEach((c, i) => {
    const v = classifyStatuses(rows[i] as Status[])
    if (v.verdict === 'green' || v.verdict === 'red') {
      newest ??= { sha: sha7(c.sha), age_s: age(c.at), verdict: v.verdict, failed: v.failed }
      if (v.verdict === 'green') lastGreen ??= { sha: sha7(c.sha), age_s: age(c.at) }
    } else if (!newest) {
      const state = v.verdict === 'none' ? 'no status yet' : v.verdict
      newer.push({
        sha: sha7(c.sha),
        age_s: age(c.at),
        state,
        ...(v.verdict === 'pending' ? { pending: v.pending } : {}),
      })
    }
  })
  return {
    value: {
      newest_finished: newest,
      newer,
      ...(lastGreen ? { last_green: lastGreen } : {}),
      looked_at: commits.length,
    },
  }
}
