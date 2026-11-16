// What resets a thread session's idle clock, and when a quiet one is parked (P3d3, part 5; the Mac's WorkerIdle.swift,
// WorkerActivity.body, readsBusy and its idle check in WorkerManager.advance). Pure: the manager (workers.ts) feeds it what the
// pane said and acts on the answer.
//
// Activity is the screen above the input box changing (a turn, a typed key), a pointer typed, or a key from an attached tmux
// client. Raw pane output is not: a status line that repaints every second would keep a worker up for ever. Output does make a
// worker busy, and a busy worker is never parked (nor the cap's choice, worker-cap.ts).
import { WORKER_LIVE_STATES, WORKER_TIMING, type WorkerStateT } from '@talos-app/protocol'
import { inputBox } from './screen.ts'

/**
 * The screen down to and including the lower rule of Claude's input box. The footer and the status line are drawn under that
 * rule and are left out. With no box on the screen (a dialog, a blank pane) it is the whole screen: nothing is known about where
 * the status line would be, and the clock errs toward activity.
 */
export function screenBody(rows: string[]): string {
  const box = inputBox(rows)
  return rows.slice(0, box ? box[1] + 1 : rows.length).join('\n')
}

/** A wall clock that moved this much more (or less) than the monotonic one between two ticks has been set or has jumped. */
export const WALL_JUMP_MS = 2000

/**
 * The wall clock against the monotonic one: wall ms less monotonic ms, which only moves when the wall clock is set, jumps (a
 * correction, a hand change) or runs on through a suspend the monotonic clock does not count. Compared tick to tick, so slow
 * correction never adds up to a jump. `jumpMs` is how far the wall clock moved beyond the monotonic one, or 0.
 */
export function wallJump(prevOffset: number | null, wallMs: number, monoS: number): { offset: number; jumpMs: number } {
  const offset = wallMs - monoS * 1000
  const moved = prevOffset === null ? 0 : offset - prevOffset
  return { offset, jumpMs: Math.abs(moved) > WALL_JUMP_MS ? moved : 0 }
}

/**
 * The idle clock: the last real activity on the monotonic clock (`activeMono`, s: what decides a park, so a wall clock that is
 * set or jumps changes nothing), the same in wall ms (`lastActiveMs`: for workers.json and the cap's ranking), and the body last
 * seen (null before the first look at this pane).
 */
export type IdleClock = { lastActiveMs: number; activeMono: number; body: string | null }

/** A wall time (a tmux client's key, a time from workers.json) on the monotonic clock as the clock reads now; never in the future. */
export const monoOf = (wallMs: number, nowMs: number, nowMono: number): number =>
  nowMono - Math.max(0, nowMs - wallMs) / 1000

/** Activity now: both clocks. */
export const activeNow = (c: IdleClock, nowMs: number, nowMono: number): IdleClock => ({
  ...c,
  lastActiveMs: Math.max(c.lastActiveMs, nowMs),
  activeMono: Math.max(c.activeMono, nowMono),
})

/** One look at the screen: a body that is not what it was is activity. The first look is the baseline and counts for nothing. */
export function noteScreen(c: IdleClock, rows: string[], nowMs: number, nowMono: number): IdleClock {
  const body = screenBody(rows)
  const changed = c.body !== null && c.body !== body
  return { ...(changed ? activeNow(c, nowMs, nowMono) : c), body }
}

/** What busy last read: the pane's output time as last seen, and when (monotonic s) it was seen to change. */
export type BusyWatch = { seen: number | null; changedAt: number | null }
export const NEW_BUSY_WATCH: BusyWatch = { seen: null, changedAt: null }

/**
 * Output newer than busy_window_s is busy; an unknown output time is busy. Quiet by the wall clock alone is not quiet: straight
 * after a sleep or a clock change, a turn that was printing looks silent for hours, so the output time must also have held still
 * for busy_window_s on the monotonic clock. A first sighting counts as a change (a watch seeded at adoption does not).
 */
export function readsBusy(
  w: BusyWatch,
  outputMs: number | null,
  nowMs: number,
  mono: number,
): { busy: boolean; watch: BusyWatch } {
  if (outputMs === null) return { busy: true, watch: w }
  const watch = w.seen !== outputMs ? { seen: outputMs, changedAt: mono } : w
  const win = WORKER_TIMING.busy_window_s
  const busy = nowMs - outputMs < win * 1000 || (watch.changedAt !== null && mono - watch.changedAt < win)
  return { busy, watch }
}

/**
 * The idle limit has passed on the clock, with nothing that holds a park: not busy, no owed pointer (the message is what it is
 * for), nothing on the pane asking the owner (the answer is what it waits for). The attached clients are asked after this.
 */
export function idleParkDue(o: {
  busy: boolean
  owed: boolean
  needsYou: boolean
  activeMono: number
  nowMono: number
  idleParkMin: number
}): boolean {
  return !o.busy && !o.owed && !o.needsYou && o.nowMono - o.activeMono >= o.idleParkMin * 60
}

/**
 * Once a park is due: the attached clients' keys (wall ms) are counted, since a key typed in a client may change nothing on the
 * screen. A list that cannot be read says no: unread is not "nobody is typing".
 */
export function idleLimitPassed(
  c: IdleClock,
  clients: number[] | null,
  nowMs: number,
  nowMono: number,
  idleS: number,
): { passed: boolean; clock: IdleClock } {
  if (clients === null) return { passed: false, clock: c }
  // the keys are tmux's wall times: on the monotonic clock as it reads now (one from "the future", after a clock set back, is now)
  const keyMono = Math.max(c.activeMono, ...clients.map((k) => monoOf(k, nowMs, nowMono)))
  const keyWall = Math.max(c.lastActiveMs, ...clients.map((k) => Math.min(k, nowMs)))
  const clock = { ...c, activeMono: keyMono, lastActiveMs: keyWall }
  return { passed: nowMono - keyMono >= idleS, clock }
}

/** What workers.json keeps of the clock: the last activity while the worker has a pane; nothing once it has none. */
export function savedActivity(state: WorkerStateT, lastActiveMs: number): string | undefined {
  const hasPane = WORKER_LIVE_STATES.includes(state) || state === 'parking' || state === 'stopping'
  return hasPane && lastActiveMs > 0 ? new Date(lastActiveMs).toISOString() : undefined
}

/**
 * An adopted worker's clock carries on (a supervisor restart buys it no extra idle time): the newest of the saved activity, the
 * last turn and the start, each no later than now. The file's times, never the pane's own output.
 */
export function seedLastActive(o: {
  saved: string | undefined
  lastTurn: string | null
  started: string | null
  nowMs: number
}): number {
  const times = [o.saved, o.lastTurn, o.started]
    .map((s) => (s ? Date.parse(s) : Number.NaN))
    .filter((t) => Number.isFinite(t))
    .map((t) => Math.min(t, o.nowMs))
  return times.length > 0 ? Math.max(...times) : o.nowMs
}
