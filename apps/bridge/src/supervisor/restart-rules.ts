// Main's restart rules, from the contract's MAIN_RESTART: the TypeScript port of the Mac's Backoff.swift, CrashLoop.swift and
// ResumeRewrite.swift. Pure: times are seconds on a monotonic clock (never the wall clock, so a clock change cannot fake a
// healthy run), and the jitter's random number is passed in.
import { MAIN_RESTART } from '@talos-app/protocol'

/** Delay before restart `attempt` (0-based): 2, 5, 15, 30, 60 s, ±20 %, at most 60. `unit` is a random number in [-1, 1]. */
export function backoffDelay(attempt: number, unit: number): number {
  const steps = MAIN_RESTART.backoff_s
  const base = steps[Math.min(Math.max(attempt, 0), steps.length - 1)] as number
  const u = Math.min(Math.max(unit, -1), 1)
  const cap = steps[steps.length - 1] as number
  return Math.max(0, Math.min(cap, base * (1 + MAIN_RESTART.jitter * u)))
}

/** The attempt after a crash at `crashAt` of a run started at `runStartedAt`: a run healthy for 10 minutes starts over at 0. */
export function nextAttempt(previous: number, runStartedAt: number, crashAt: number): number {
  return crashAt - runStartedAt >= MAIN_RESTART.healthy_after_s ? 0 : previous + 1
}

/**
 * The crash-loop cap: MAIN_RESTART.crash_loop restarts in its window, and auto-confirmed warnings per hour, counted apart for
 * restarts after a crash and for cold starts (an owner's resets never spend the crash loop's budget). An entry counts while
 * `now - t < window`; one "in the future" (a clock that moved back) counts too.
 */
export class CrashLoop {
  restarts: number[] = []
  crashConfirms: number[] = []
  coldConfirms: number[] = []

  private static count(list: number[], now: number, window: number) {
    return list.filter((t) => now - t < window).length
  }

  restartsInWindow(now: number): number {
    return CrashLoop.count(this.restarts, now, MAIN_RESTART.crash_loop.window_s)
  }
  mayRestart(now: number): boolean {
    return this.restartsInWindow(now) < MAIN_RESTART.crash_loop.count
  }
  mayAutoConfirm(now: number, kind: 'cold' | 'crash_restart'): boolean {
    return kind === 'cold'
      ? CrashLoop.count(this.coldConfirms, now, 3600) < MAIN_RESTART.cold_auto_confirms_per_hour
      : CrashLoop.count(this.crashConfirms, now, 3600) < MAIN_RESTART.auto_confirms_per_hour
  }
  recordRestart(now: number): void {
    this.restarts = [...this.restarts, now].filter((t) => now - t < MAIN_RESTART.crash_loop.window_s)
  }
  recordAutoConfirm(now: number, kind: 'cold' | 'crash_restart'): void {
    const keep = (l: number[]) => [...l, now].filter((t) => now - t < 3600)
    if (kind === 'cold') this.coldConfirms = keep(this.coldConfirms)
    else this.crashConfirms = keep(this.crashConfirms)
  }
}

const VALUED = new Set(['--resume', '-r', '--session-id'])
const BARE = new Set(['--continue', '-c', '--fork-session'])

/** The stored args never carry a session flag: every start strips them and appends exactly one. */
export function stripSessionFlags(args: string[]): string[] {
  const out: string[] = []
  for (let i = 0; i < args.length; i++) {
    const a = args[i] as string
    if (VALUED.has(a)) {
      // `--resume` with no id (it opens a picker) is dropped; a following flag is not its value
      if (i + 1 < args.length && !(args[i + 1] as string).startsWith('-')) i++
      continue
    }
    if (a.startsWith('--resume=') || a.startsWith('--session-id=') || BARE.has(a)) continue
    out.push(a)
  }
  return out
}

export type SessionMode = { resume: string } | { newSession: string }

/**
 * The args with exactly one session flag, its id joined to it (`--resume=<id>`): an id is never read as a flag of its own,
 * whatever it says (Fable R3-4; supervisor.json's session.id must also be a UUID, cli.ts).
 */
export function withSession(args: string[], mode: SessionMode): string[] {
  const out = stripSessionFlags(args)
  return 'resume' in mode ? [...out, `--resume=${mode.resume}`] : [...out, `--session-id=${mode.newSession}`]
}
