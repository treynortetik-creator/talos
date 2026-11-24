// scripts/ci-subset-report.ts: read-only. One row per run in which check ran the macOS-only subset here (its log says "the macOS-only
// tests, here:"; CI_TITAN_CHECK=on): how long the subset step took, how many of its tests ended with a 20 s timeout or failed, its
// slowest tests, and the wall times of the jobs that ran beside it (logs/timings.tsv), so the effect of a change in how the subset is
// scheduled (docs/CI-LOCAL.md, "The macOS-only subset and the machine's load") can be read from real runs. Run before and after:
//   node scripts/ci-subset-report.ts --since 2026-11-20 --until 2026-11-21     (the logs' dates are local, as the logs' own times)
//   node scripts/ci-subset-report.ts --sha b340427,fb7426b                    (named runs; --logs <dir> reads another logs folder)
// Reads <logs>/<sha>-check.log, timings.tsv and green.tsv. Never writes; never starts or stops anything.
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const ANSI = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, 'g') // Vitest's colours
const TIMEOUT_MS = 20_000 // bun's per-test limit in check (apps/bridge bunfig)
export interface TestTime {
  file: string
  name: string
  ms: number
  failed: boolean
}
export interface SubsetRun {
  sha: string
  stepSeconds: number | null
  stepExit: number | null
  timeouts: number
  failed: number
  slowest: TestTime[]
  vitestSeconds: number | null // the root Vitest run's own "Duration" (the contract run's is the next one)
  loads: string[] // the 1-minute load average at the subset's start, between its parts and at its end (after this change; else none)
}

const lineMs = (v: string, unit: string): number => (unit === 's' ? Number(v) * 1000 : Number(v))

// Every bun test line of a log: "(pass) <name> [12.3ms]" or "(fail) ...", under "::group::<file>:". The runner prints a failed test again in
// its summary, so a test is counted once, by file and name.
export function parseTests(log: string): TestTime[] {
  const seen = new Map<string, TestTime>()
  let file = ''
  for (const line of log.split('\n')) {
    const g = line.match(/^::group::(.+?):$/)
    if (g) {
      file = g[1]
      continue
    }
    const m = line.match(/^\((pass|fail)\) (.*) \[([0-9.]+)(ms|s)\]$/)
    if (!m) continue
    const key = `${file}\u0000${m[2]}`
    seen.set(key, { file, name: m[2], ms: lineMs(m[3], m[4]), failed: m[1] === 'fail' })
  }
  return [...seen.values()]
}

export function parseRun(sha: string, rawLog: string): SubsetRun {
  const log = rawLog.replace(ANSI, '')
  const step = log.match(/^\[step\] (\d+)s exit (\d+): ci_mutex_all .* step_macos_subset$/m)
  const tests = parseTests(log)
  const timedOut = new Set<string>()
  for (const t of tests) if (t.failed && t.ms >= TIMEOUT_MS - 100) timedOut.add(`${t.file}\u0000${t.name}`)
  // the error annotation names the test the runner gave up on, even when the (fail) line shows a hook's time
  for (const m of log.matchAll(/^::error title=error: Test "(.+?)" timed out after 20000ms::$/gm)) {
    const hit = tests.find((t) => t.failed && t.name.endsWith(decodeURIComponent(m[1].replace(/%3A/g, ':'))))
    timedOut.add(hit ? `${hit.file}\u0000${hit.name}` : `?\u0000${m[1]}`)
  }
  return {
    sha,
    stepSeconds: step ? Number(step[1]) : null,
    stepExit: step ? Number(step[2]) : null,
    timeouts: timedOut.size,
    failed: tests.filter((t) => t.failed).length,
    slowest: [...tests].sort((a, b) => b.ms - a.ms).slice(0, 3),
    vitestSeconds: Number(log.match(/^\s+Duration\s+([0-9.]+)s/m)?.[1] ?? NaN) || null,
    loads: [...log.matchAll(/^subset load [^:]*: ([0-9.,]+)/gm)].map((m) =>
      m[1].replace(/[.,]+$/, '').replace(',', '.'),
    ),
  }
}

const short = (f: string): string => f.replace(/^test\//, '').replace(/\.test\.ts$/, '')
const secs = (ms: number): string => `${(ms / 1000).toFixed(1)}s`

interface Wall {
  jobs: number
  check: string
  desktop: string
  browser: string
  mobile: string
}
// the newest timings.tsv row of the commit (a rerun appends): jobs' wall time, then "<job>=<wall>/<own steps>" columns
export function timingsFor(tsv: string, sha: string): Wall | null {
  const rows = tsv.split('\n').filter((l) => l.split('\t')[1] === sha)
  const row = rows[rows.length - 1]
  if (!row) return null
  const c = row.split('\t')
  const job = (n: string): string =>
    (c[8] ?? '')
      .split(',')
      .find((p) => p.startsWith(`${n}=`))
      ?.replace(/^.*=/, '')
      .replace(/\/.*$/, '') ?? '-'
  return {
    jobs: Number(c[6]),
    check: job('check'),
    desktop: job('desktop'),
    browser: job('browser'),
    mobile: job('mobile'),
  }
}
export function verdictFor(green: string, sha: string): string {
  const rows = green.split('\n').filter((l) => l.split('\t')[1]?.startsWith(sha))
  const last = rows[rows.length - 1]?.split('\t')[3] ?? ''
  return last === 'moved'
    ? 'green'
    : last.startsWith('unchanged: verdict ')
      ? last.slice('unchanged: verdict '.length)
      : '-'
}

export function report(logsDir: string, opts: { since?: string; until?: string; shas?: string[] }): string {
  const read = (f: string): string => (existsSync(join(logsDir, f)) ? readFileSync(join(logsDir, f), 'utf8') : '')
  const tsv = read('timings.tsv')
  const green = read('green.tsv')
  const day = (ms: number): string => {
    const d = new Date(ms)
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
  }
  const rows: { when: number; text: string; run: SubsetRun }[] = []
  for (const f of readdirSync(logsDir)) {
    const m = f.match(/^([0-9a-f]{7,40})-check\.log$/)
    if (!m) continue
    const sha = m[1]
    if (opts.shas && !opts.shas.some((s) => sha.startsWith(s) || s.startsWith(sha))) continue
    const when = statSync(join(logsDir, f)).mtimeMs
    if (!opts.shas && ((opts.since && day(when) < opts.since) || (opts.until && day(when) > opts.until))) continue
    const log = readFileSync(join(logsDir, f), 'utf8')
    if (!log.includes('the macOS-only tests, here:')) continue
    const run = parseRun(sha, log)
    const w = timingsFor(tsv, sha)
    const slow = run.slowest.map((t) => `${short(t.file)} ${secs(t.ms)}`).join('; ')
    const cells = [
      new Date(when).toLocaleString('sv').slice(0, 16),
      sha,
      run.stepSeconds === null ? '?' : `${run.stepSeconds}s${run.stepExit ? ' (red)' : ''}`,
      String(run.timeouts),
      String(run.failed),
      slow,
      run.vitestSeconds === null ? '-' : `${Math.round(run.vitestSeconds)}s`,
      run.loads.length ? run.loads.join('/') : '-',
      w ? `${w.check}/${w.desktop}/${w.browser}/${w.mobile}` : '-',
      verdictFor(green, sha),
    ]
    rows.push({ when, text: `| ${cells.join(' | ')} |`, run })
  }
  rows.sort((a, b) => a.when - b.when)
  const head = [
    '| finished | sha | subset step | 20 s timeouts | failed | slowest 3 tests | Vitest | load 1 min (start/mid/end) | check/desktop/browser/mobile wall (s) | verdict |',
    '|---|---|---|---|---|---|---|---|---|---|',
  ]
  const steps = rows.map((r) => r.run.stepSeconds).filter((s): s is number => s !== null)
  const sum = `${rows.length} runs; subset step: median ${median(steps)}s, max ${Math.max(0, ...steps)}s; runs with a 20 s timeout: ${
    rows.filter((r) => r.run.timeouts > 0).length
  }; timeouts in all: ${rows.reduce((n, r) => n + r.run.timeouts, 0)}`
  return [...head, ...rows.map((r) => r.text), '', sum].join('\n')
}
function median(xs: number[]): number {
  if (xs.length === 0) return 0
  const s = [...xs].sort((a, b) => a - b)
  return s[Math.floor(s.length / 2)]
}

if (process.argv[1]?.endsWith('ci-subset-report.ts')) {
  const a = process.argv.slice(2)
  const arg = (n: string): string | undefined => (a.indexOf(n) >= 0 ? a[a.indexOf(n) + 1] : undefined)
  const logs = arg('--logs') ?? join(process.env.TALOS_CI_CACHE ?? join(homedir(), '.cache', 'talos-ci'), 'logs')
  console.log(report(logs, { since: arg('--since'), until: arg('--until'), shas: arg('--sha')?.split(',') }))
}
