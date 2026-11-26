// scripts/push-latency.ts: read-only. For each push to main from this machine (by sha), three numbers kept apart, so the slowest
// part of a push is the one that gets fixed (the test-speed roadmap's V12):
//   wait     how long its gate waited for the heavy lock (logs/lock-waits.tsv, kind push: the gate's own row, "--base <sha>")
//   gate     the gate's own run: the time the full gate(s) took on this machine, minus that wait
//   regates  how many times the gate ran again because main moved during it (gate-push's "requeue")
//   node scripts/push-latency.ts                  the last 5 pushes that have data
//   node scripts/push-latency.ts --last 12 --logs <dir> --repo <dir> --ref origin/main
// Where the data comes from:
//   recorded  a row gate-push.sh writes to lock-waits.tsv when it pushes (lock push, kind pushed): "pushed <sha> requeues=N races=M
//             gate=<folder> bases=<sha>,<sha>", with the seconds of all its full gates in the seconds column. All three numbers are exact.
//   inferred  a push from before that row existed: the push time is the reflog's "update by push" of the ref, the gate is the
//             latest gate row of this machine whose --base is an ancestor of the push. Then "gate" is the time from the lock to the
//             push (the gate, plus any wait for the push lease, plus the push: an upper bound) and regates is "n/r" (not recorded).
// A wait under one second is not a row in lock-waits.tsv (ci_wait_log), so it reads as no wait. Never writes; never starts anything.
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

export interface WaitRow {
  at: number // epoch seconds
  lock: string
  what: string
  seconds: number
  kind: string
}
export interface Push {
  sha: string
  at: number // epoch seconds of the push
  ancestors: string[] // the commits below the pushed one, nearest first
}
export interface Latency {
  sha: string
  at: number
  waitS: number
  gateS: number
  regates: number | null // null: not recorded
  source: 'recorded' | 'inferred'
}

const INFER_WINDOW_S = 4 * 3600 // an inferred gate began at most this long before its push
const SLACK_S = 120 // a recorded gate's rows end within this long of the push row (clock reads, the push itself)

export function parseWaits(text: string): WaitRow[] {
  const rows: WaitRow[] = []
  for (const line of text.split('\n')) {
    const f = line.split('\t')
    if (f.length < 6) continue
    const at = Date.parse(f[0] as string) / 1000
    const seconds = Number(f[3])
    if (!Number.isFinite(at) || !Number.isFinite(seconds)) continue
    rows.push({ at, lock: f[1] as string, what: f[2] as string, seconds, kind: (f[5] as string).trim() })
  }
  return rows
}

/** The gate's own wait for the heavy lock: kind push, "gate (<label>): bash scripts/gate.sh --in-heavy-lock --base <40 hex>". */
const gateBase = (r: WaitRow): string | undefined =>
  r.kind === 'push' && r.lock === 'suites' ? /--in-heavy-lock\b.*--base ([0-9a-f]{40})/.exec(r.what)?.[1] : undefined

const pushedOf = (r: WaitRow): { sha: string; requeues: number; gate: string; bases: string[] } | undefined => {
  if (r.kind !== 'pushed') return undefined
  const m = /^pushed ([0-9a-f]{40}) requeues=(\d+) races=\d+ gate=(\S+) bases=([0-9a-f,]*)$/.exec(r.what)
  return m
    ? {
        sha: m[1] as string,
        requeues: Number(m[2]),
        gate: m[3] as string,
        bases: (m[4] as string).split(',').filter(Boolean),
      }
    : undefined
}

/** gate.sh's lock row is "gate (<folder>): ..."; gate-push writes the folder with anything but letters, digits and . _ - as _. */
const gateLabel = (r: WaitRow): string | undefined =>
  /^gate \((.*?)\): /.exec(r.what)?.[1]?.replace(/[^A-Za-z0-9._-]/g, '_')

const inferred = (push: Push, gate: WaitRow): Latency => ({
  sha: push.sha,
  at: push.at,
  waitS: gate.seconds,
  gateS: push.at - gate.at,
  regates: null,
  source: 'inferred',
})

/** A push's recorded numbers, or undefined when it has no pushed row. */
export function recordedOf(push: Push, rows: WaitRow[]): Latency | undefined {
  const done = rows.find((r) => pushedOf(r)?.sha === push.sha)
  const rec = done && pushedOf(done)
  if (!done || !rec) return undefined
  // the gates' own lock rows: a base this push gated on, ending inside the time its gates took
  const from = done.at - done.seconds - SLACK_S
  const waitS = rows
    .filter((r) => {
      const b = gateBase(r)
      return (
        b !== undefined &&
        rec.bases.includes(b) &&
        gateLabel(r) === rec.gate &&
        r.at >= from &&
        r.at <= done.at + SLACK_S
      )
    })
    .reduce((s, r) => s + r.seconds, 0)
  return {
    sha: push.sha,
    at: push.at,
    waitS,
    gateS: Math.max(0, done.seconds - waitS),
    regates: rec.requeues,
    source: 'recorded',
  }
}

/**
 * The newest `last` pushes that have data, newest first. A push without a pushed row is matched to a gate row whose --base is one of
 * its commits' ancestors and that began before it, the nearest ancestor first, then the shortest time; a gate row belongs to one push
 * (the next push on the same base is another builder's, and its own gate is its own row).
 */
export function latencies(pushes: Push[], rows: WaitRow[], last: number): Latency[] {
  const found = new Map<string, Latency>()
  const open: Push[] = []
  for (const p of pushes) {
    const rec = recordedOf(p, rows)
    if (rec) found.set(p.sha, rec)
    else open.push(p)
  }
  const gates = rows.filter((r) => gateBase(r) !== undefined)
  const pairs = open.flatMap((p) =>
    gates.flatMap((g) => {
      const k = p.ancestors.indexOf(gateBase(g) as string)
      return k >= 0 && g.at <= p.at && p.at - g.at <= INFER_WINDOW_S ? [{ p, g, k, d: p.at - g.at }] : []
    }),
  )
  const usedPush = new Set<string>()
  const usedGate = new Set<WaitRow>()
  for (const { p, g } of pairs.sort((x, y) => x.k - y.k || x.d - y.d)) {
    if (usedPush.has(p.sha) || usedGate.has(g)) continue
    usedPush.add(p.sha)
    usedGate.add(g)
    found.set(p.sha, inferred(p, g))
  }
  return [...found.values()].sort((a, b) => b.at - a.at).slice(0, last)
}

const dur = (s: number): string =>
  s < 60 ? `${Math.round(s)}s` : `${Math.floor(s / 60)}m${String(Math.round(s % 60)).padStart(2, '0')}s`

export function table(ls: Latency[]): string {
  const head = ['push', 'pushed (UTC)', 'lock wait', 'gate run', 're-gates', 'data']
  const rows = ls.map((l) => [
    l.sha.slice(0, 7),
    new Date(l.at * 1000).toISOString().slice(0, 16).replace('T', ' '),
    dur(l.waitS),
    l.source === 'inferred' ? `<=${dur(l.gateS)}` : dur(l.gateS),
    l.regates === null ? 'n/r' : String(l.regates),
    l.source,
  ])
  const w = head.map((h, i) => Math.max(h.length, ...rows.map((r) => (r[i] as string).length)))
  const fmt = (r: string[]) =>
    r
      .map((c, i) => c.padEnd(w[i] as number))
      .join('  ')
      .trimEnd()
  return [fmt(head), ...rows.map(fmt)].join('\n')
}

// ---- reading the real thing ----------------------------------------------------------------------------------------------------
const git = (repo: string, args: string[]) =>
  execFileSync('git', args, { cwd: repo, encoding: 'utf8', maxBuffer: 1 << 26 })

/** The ref's "update by push" reflog entries: this machine's pushes, with the time each one happened. */
export function readPushes(repo: string, ref: string, ancestors = 6): Push[] {
  const out: Push[] = []
  const log = git(repo, ['reflog', 'show', '--date=unix', '--format=%H%x09%gd%x09%gs', ref])
  for (const line of log.split('\n')) {
    const [sha, gd, subject] = line.split('\t')
    const at = /@\{(\d+)\}/.exec(gd ?? '')?.[1]
    if (!sha || !at || !/update by push/.test(subject ?? '')) continue
    let chain: string[] = []
    try {
      chain = git(repo, ['rev-list', '--first-parent', '-n', String(ancestors), sha])
        .split('\n')
        .filter(Boolean)
        .slice(1)
    } catch {
      // the commit is gone from this clone: it can still match a recorded row
    }
    out.push({ sha, at: Number(at), ancestors: chain })
  }
  return out
}

export function main(argv: string[]): number {
  let last = 5
  let logs = join(process.env.TALOS_CI_CACHE ?? join(homedir(), '.cache/talos-ci'), 'logs')
  let repo = process.cwd()
  let ref = 'origin/main'
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--last') last = Number(argv[++i])
    else if (a === '--logs') logs = argv[++i] ?? logs
    else if (a === '--repo') repo = argv[++i] ?? repo
    else if (a === '--ref') ref = argv[++i] ?? ref
    else {
      console.error(`push-latency: unknown argument ${a}`)
      return 2
    }
  }
  if (!Number.isInteger(last) || last < 1) {
    console.error('push-latency: --last needs a whole number of 1 or more')
    return 2
  }
  const file = join(logs, 'lock-waits.tsv')
  if (!existsSync(file)) {
    console.error(`push-latency: no ${file}`)
    return 1
  }
  const ls = latencies(readPushes(repo, ref), parseWaits(readFileSync(file, 'utf8')), last)
  if (ls.length === 0) {
    console.log('push-latency: no push of this machine has data in lock-waits.tsv')
    return 0
  }
  console.log(table(ls))
  return 0
}

if (process.argv[1] === fileURLToPath(import.meta.url)) process.exitCode = main(process.argv.slice(2))
