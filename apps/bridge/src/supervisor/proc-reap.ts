// What a session that died mid-turn left running. Claude Code starts a tool (a Bash command) as a detached child: its own process
// group and session, so the kill of the pane's group never reaches it, and when claude is killed the tool is left behind. Run
// the turn again and that work would run twice. What ties such a child to the dead launch is its environment: it inherited
// TALOS_APP_WORKER_NONCE=<that launch's nonce>, a random value this supervisor made and wrote for that one start. Nothing
// without it is touched. Linux and WSL only (/proc); elsewhere there is nothing to find and nothing is done.
import { spawnSync } from 'node:child_process'
import { readdirSync, readFileSync } from 'node:fs'
import { parseProcStat, processGroup, processStartTime } from '../proc-identity.ts'

/** A process counts as started at or after the bound when it started no more than this before it (the clock's resolution). */
export const REAP_START_SLACK_MS = 1000
/** TERM first, then one KILL for what is still there after this long. */
export const REAP_GRACE_MS = 2000
const POLL_MS = 100
const NONCE = /^[0-9a-f]{32,}$/

/** How the reap looks at the process table and signals; a test gives a fake one. */
export type ReapDeps = {
  pids(): number[]
  /** /proc/<pid>/environ as one NUL-separated text; null when it cannot be read (gone, or not ours to read). */
  environ(pid: number): string | null
  /** When the process started, in ms since boot (never the wall clock); null when it cannot be read. */
  startedBootMs(pid: number): number | null
  /** A value that never changes for one process; null when it is gone. */
  start(pid: number): string | null
  pgid(pid: number): number | null
  /** Running (a zombie is not). */
  alive(pid: number): boolean
  /** A signal to a pid, or to a whole group (a negative target). */
  kill(target: number, signal: 'SIGTERM' | 'SIGKILL'): boolean
  self: { pid: number; pgid: number }
  graceMs: number
  sleep(ms: number): Promise<void>
  now?(): number
}

export type Found = { pid: number; start: string; pgid: number }

const isLinux = () => process.platform === 'linux'

function readOrNull(path: string): string | null {
  try {
    return readFileSync(path, 'latin1')
  } catch {
    return null
  }
}

let clockTicks: number | null = null
function clkTck(): number {
  if (clockTicks !== null) return clockTicks
  const r = spawnSync('getconf', ['CLK_TCK'], { encoding: 'utf8', timeout: 2000 })
  const n = Number(r.stdout?.trim())
  clockTicks = r.status === 0 && Number.isInteger(n) && n > 0 ? n : 100 // 100 on every Linux we run on
  return clockTicks
}

/**
 * When a process started, in milliseconds since boot: stat field 22 (clock ticks since boot) over CLK_TCK. No wall clock is
 * involved at any point (the wall clock steps on WSL when the host resumes, and /proc/stat's btime drifts with it: proc-identity.ts),
 * so the turn's start must be on the same clock: bootMsNow().
 */
export function processStartedBootMs(pid: number): number | null {
  const stat = readOrNull(`/proc/${pid}/stat`)
  const parsed = stat === null ? null : parseProcStat(stat)
  return parsed ? (Number(parsed.startTicks) / clkTck()) * 1000 : null
}

/** Milliseconds since boot now (/proc/uptime): the clock a process's start is on. Null where there is none (not Linux). */
export function bootMsNow(): number | null {
  const up = readOrNull('/proc/uptime')
  const s = up === null ? Number.NaN : Number(up.split(' ')[0])
  return Number.isFinite(s) ? s * 1000 : null
}

export function systemReapDeps(): ReapDeps {
  return {
    pids: () => {
      if (!isLinux()) return []
      try {
        return readdirSync('/proc')
          .filter((n) => /^\d+$/.test(n))
          .map(Number)
      } catch {
        return []
      }
    },
    environ: (pid) => readOrNull(`/proc/${pid}/environ`),
    start: (pid) => processStartTime(pid),
    pgid: (pid) => processGroup(pid),
    startedBootMs: (pid) => processStartedBootMs(pid),
    alive: (pid) => {
      const text = readOrNull(`/proc/${pid}/stat`)
      if (text === null) return false
      const state = text.slice(text.lastIndexOf(')') + 1).trim()[0]
      return parseProcStat(text) !== null && state !== 'Z' && state !== 'X'
    },
    kill: (target, signal) => {
      try {
        process.kill(target, signal)
        return true
      } catch {
        return false
      }
    },
    self: { pid: process.pid, pgid: processGroup(process.pid) ?? process.pid },
    graceMs: REAP_GRACE_MS,
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
  }
}

/** The processes whose environment holds exactly `TALOS_APP_WORKER_NONCE=<nonce>` (never ourselves, our group, or pid 1). */
export function findLaunchProcs(nonce: string, d: ReapDeps, notBeforeBootMs?: number): Found[] {
  return scan(nonce, d, notBeforeBootMs).found
}

type Scan = { found: Found[]; groups: Map<number, number[]> }

function scan(nonce: string, d: ReapDeps, notBeforeBootMs?: number): Scan {
  const out: Scan = { found: [], groups: new Map() }
  if (!NONCE.test(nonce)) return out
  const want = `TALOS_APP_WORKER_NONCE=${nonce}`
  for (const pid of d.pids()) {
    if (!Number.isInteger(pid) || pid <= 1 || pid === d.self.pid) continue
    const pgid = d.pgid(pid)
    if (pgid === null) continue
    // every process of every group is counted, matched or not: a group is signalled as a group only when all of it is ours
    const members = out.groups.get(pgid) ?? []
    members.push(pid)
    out.groups.set(pgid, members)
    if (pgid === d.self.pgid) continue
    const env = d.environ(pid)
    if (env === null || !env.split('\0').includes(want)) continue
    // only what started at or after the bound: a dev server an earlier turn left running is not this turn's (and one whose start
    // cannot be read is not provably this turn's either)
    if (notBeforeBootMs !== undefined) {
      const at = d.startedBootMs(pid)
      if (at === null || at < notBeforeBootMs - REAP_START_SLACK_MS) continue
    }
    const start = d.start(pid)
    if (start === null) continue
    out.found.push({ pid, start, pgid })
  }
  return out
}

export type ReapResult = { found: number; killed: number[] }

/**
 * Ends what the launch `nonce` left running, once: TERM, then after the grace one KILL for what is still there. A group whose
 * every process holds the nonce is signalled as a group; any other match is signalled by its pid alone. A pid is checked again
 * (its start time) right before each signal, so a number reused meanwhile is never hit.
 */
export async function reapLaunch(
  nonce: string,
  d: ReapDeps = systemReapDeps(),
  notBeforeBootMs?: number,
): Promise<ReapResult> {
  const { found, groups } = scan(nonce, d, notBeforeBootMs)
  if (found.length === 0) return { found: 0, killed: [] }
  const mine = new Set(found.map((f) => f.pid))
  // the signals to send: a whole group when all of it is ours, else the pid alone
  const targets: Array<{ target: number; members: Found[] }> = []
  const byGroup = new Map<number, Found[]>()
  for (const f of found) byGroup.set(f.pgid, [...(byGroup.get(f.pgid) ?? []), f])
  for (const [pgid, members] of byGroup) {
    // a group that one of the launch's own processes leads (a tool starts as the leader of its own group), with nobody in it that
    // we can read and that is not the launch's. A member we cannot read (a binary with file capabilities, like ping, hides its
    // environment) is in a group the launch made: it is the launch's too, and left alone it would run on.
    const whole =
      pgid > 1 && mine.has(pgid) && (groups.get(pgid) ?? []).every((p) => mine.has(p) || d.environ(p) === null)
    if (whole) targets.push({ target: -pgid, members })
    else for (const m of members) targets.push({ target: m.pid, members: [m] })
  }
  const same = (f: Found) => d.start(f.pid) === f.start
  const send = (t: { target: number; members: Found[] }, sig: 'SIGTERM' | 'SIGKILL') => {
    if (!t.members.every(same)) return false
    return d.kill(t.target, sig)
  }
  const termed = targets.filter((t) => send(t, 'SIGTERM'))
  const now = d.now ?? Date.now
  const until = now() + d.graceMs
  const left = () => termed.filter((t) => t.members.some((m) => d.alive(m.pid) && same(m)))
  while (left().length > 0 && now() < until) await d.sleep(POLL_MS)
  const killed: number[] = []
  for (const t of left()) {
    const still = t.members.filter((m) => d.alive(m.pid)).map((m) => m.pid)
    if (send(t, 'SIGKILL')) killed.push(...still)
  }
  return { found: found.length, killed }
}
