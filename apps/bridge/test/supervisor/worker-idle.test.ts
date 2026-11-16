// What resets a thread session's idle clock (P3d3, part 5; the Mac's WorkerIdle.swift, WorkerActivity.body and readsBusy):
// pure functions only. The manager's use of them is in workers.test.ts.
import { describe, expect, it } from 'bun:test'
import { WORKER_TIMING } from '@talos-app/protocol'
import {
  idleLimitPassed,
  idleParkDue,
  NEW_BUSY_WATCH,
  noteScreen,
  readsBusy,
  savedActivity,
  screenBody,
  seedLastActive,
} from '../../src/supervisor/worker-idle.ts'

const rule = '─'.repeat(40)
const screen = (history: string, box = '', status = 'model: sonnet  12% ctx') => [
  history,
  rule,
  `❯ ${box}`,
  rule,
  status,
]

describe('the screen body', () => {
  it('is the screen down to and including the input box’s lower rule; the status line under it is left out', () => {
    expect(screenBody(screen('hello'))).toBe(['hello', rule, '❯ ', rule].join('\n'))
  })
  it('with no input box on the screen (a dialog, a blank pane) it is the whole screen', () => {
    expect(screenBody(['Do you trust this folder?', '1. Yes', '2. No'])).toBe(
      'Do you trust this folder?\n1. Yes\n2. No',
    )
  })
})

describe('noting the screen', () => {
  // the two clocks agree here (monotonic s = wall ms / 1000) unless a test says otherwise
  const clock = (ms: number, body: string | null = null) => ({ lastActiveMs: ms, activeMono: ms / 1000, body })
  it('the first look is the baseline: it counts for nothing', () => {
    const c = noteScreen(clock(1000), screen('a'), 5000, 5)
    expect(c.lastActiveMs).toBe(1000)
    expect(c.body).not.toBeNull()
  })
  it('a changed body is activity on both clocks; a status line repainting is not', () => {
    const c0 = noteScreen(clock(1000), screen('a'), 2000, 2)
    expect(noteScreen(c0, screen('a', '', 'model: sonnet  13% ctx'), 3000, 3).lastActiveMs).toBe(1000)
    expect(noteScreen(c0, screen('a', 'h'), 3000, 3)).toMatchObject({ lastActiveMs: 3000, activeMono: 3 })
    expect(noteScreen(c0, screen('b'), 3000, 3).lastActiveMs).toBe(3000)
  })
  it('never moves the clock back', () => {
    const c0 = noteScreen(clock(9000), screen('a'), 2000, 2)
    expect(noteScreen(c0, screen('b'), 3000, 3).lastActiveMs).toBe(9000)
  })
})

describe('busy', () => {
  const w = WORKER_TIMING.busy_window_s
  it('output within busy_window_s is busy; older output is not', () => {
    const seeded = { seen: 1_000, changedAt: null }
    expect(readsBusy(seeded, 1_000, 1_000 + (w - 1) * 1000, 50).busy).toBe(true)
    expect(readsBusy(seeded, 1_000, 1_000 + w * 1000, 50).busy).toBe(false)
  })
  it('an unknown output time is busy', () => {
    expect(readsBusy(NEW_BUSY_WATCH, null, 1_000_000, 50).busy).toBe(true)
  })
  it('an output time that changed within busy_window_s on the monotonic clock is busy, whatever the wall clock says', () => {
    // straight after a sleep: the wall clock says the output is hours old, but it only just changed
    const r = readsBusy({ seen: 1_000, changedAt: null }, 2_000, 10_000_000, 50)
    expect(r.busy).toBe(true)
    expect(r.watch).toEqual({ seen: 2_000, changedAt: 50 })
    expect(readsBusy(r.watch, 2_000, 10_000_000, 50 + w - 1).busy).toBe(true)
    expect(readsBusy(r.watch, 2_000, 10_000_000, 50 + w).busy).toBe(false)
  })
  it('a first sighting counts as a change (a seeded watch does not)', () => {
    expect(readsBusy(NEW_BUSY_WATCH, 1_000, 10_000_000, 50).busy).toBe(true)
    expect(readsBusy({ seen: 1_000, changedAt: null }, 1_000, 10_000_000, 50).busy).toBe(false)
  })
})

describe('the idle park', () => {
  const idle = { busy: false, owed: false, needsYou: false, activeMono: 0, nowMono: 30 * 60, idleParkMin: 30 }
  it('is due when quiet, nothing owed, nothing asking the owner, and idle for idle_park_min on the monotonic clock', () => {
    expect(idleParkDue(idle)).toBe(true)
    expect(idleParkDue({ ...idle, nowMono: 30 * 60 - 1 })).toBe(false)
    expect(idleParkDue({ ...idle, busy: true })).toBe(false)
    expect(idleParkDue({ ...idle, owed: true })).toBe(false)
    expect(idleParkDue({ ...idle, needsYou: true })).toBe(false)
    expect(idleParkDue({ ...idle, idleParkMin: 31 })).toBe(false)
  })
  it('an attached client’s key extends the clock; an unreadable client list says no', () => {
    const c = (ms: number) => ({ lastActiveMs: ms, activeMono: ms / 1000, body: null })
    expect(idleLimitPassed(c(0), [], 1800_000, 1800, 1800).passed).toBe(true)
    expect(idleLimitPassed(c(0), [60_000, 1000], 1800_000, 1800, 1800)).toMatchObject({
      passed: false,
      clock: { lastActiveMs: 60_000, activeMono: 60 },
    })
    expect(idleLimitPassed(c(5000), [1000], 1800_000, 1800, 1800).passed).toBe(false)
    expect(idleLimitPassed(c(0), null, 1800_000, 1800, 1800).passed).toBe(false)
  })
  it('a key from tmux’s “future” (the wall clock was set back) counts as now, never later', () => {
    const r = idleLimitPassed({ lastActiveMs: 0, activeMono: 0, body: null }, [9_999_999_999], 1800_000, 1800, 1800)
    expect(r.clock).toMatchObject({ lastActiveMs: 1800_000, activeMono: 1800 })
  })
  it('the wall clock alone never decides: three hours of wall time with no monotonic time is no idle time', () => {
    expect(idleParkDue({ ...idle, activeMono: 100, nowMono: 101 })).toBe(false)
  })
})

describe('the idle clock in workers.json', () => {
  it('is saved while the worker has a pane, and not once it is parked, failed or off', () => {
    for (const s of ['starting', 'live', 'busy', 'parking', 'stopping'] as const)
      expect(savedActivity(s, Date.parse('2026-11-10T12:00:00.000Z'))).toBe('2026-11-10T12:00:00.000Z')
    for (const s of ['parked', 'failed', 'off'] as const) expect(savedActivity(s, 1)).toBeUndefined()
    expect(savedActivity('live', 0)).toBeUndefined()
  })
  it('an adopted worker carries the clock on: the newest of the saved activity, the last turn and the start', () => {
    const now = Date.parse('2026-11-10T12:00:00.000Z')
    const ago = (s: number) => new Date(now - s * 1000).toISOString()
    // the Mac's anAdoptedWorkerIsSeededFromTheFileAndNotFromThePane rows: started, last pointer, saved (seconds ago)
    expect(seedLastActive({ saved: undefined, lastTurn: ago(3600), started: ago(3600), nowMs: now })).toBe(
      now - 3600_000,
    )
    expect(seedLastActive({ saved: ago(3600), lastTurn: ago(3600), started: ago(3600), nowMs: now })).toBe(
      now - 3600_000,
    )
    expect(seedLastActive({ saved: ago(5), lastTurn: ago(3600), started: ago(3600), nowMs: now })).toBe(now - 5000)
    expect(seedLastActive({ saved: ago(3600), lastTurn: ago(5), started: ago(3600), nowMs: now })).toBe(now - 5000)
    expect(seedLastActive({ saved: ago(3600), lastTurn: ago(3600), started: ago(5), nowMs: now })).toBe(now - 5000)
  })
  it('a time in the future is no later than now; nothing readable is now', () => {
    const now = Date.parse('2026-11-10T12:00:00.000Z')
    expect(seedLastActive({ saved: '2027-01-01T00:00:00.000Z', lastTurn: null, started: null, nowMs: now })).toBe(now)
    expect(seedLastActive({ saved: undefined, lastTurn: null, started: null, nowMs: now })).toBe(now)
  })
})

describe('a wall clock that jumps (worker-idle.ts wallJump)', () => {
  it('is seen against the monotonic clock, tick to tick: a jump either way, never slow correction', async () => {
    const { wallJump, WALL_JUMP_MS } = await import('../../src/supervisor/worker-idle.ts')
    const a = wallJump(null, 1_000_000, 10)
    expect(a.jumpMs).toBe(0)
    expect(wallJump(a.offset, 1_001_000, 11).jumpMs).toBe(0) // both moved 1 s
    expect(wallJump(a.offset, 1_000_000 + 3_600_000, 11).jumpMs).toBe(3_599_000)
    expect(wallJump(a.offset, 1_000_000 - 60_000, 11).jumpMs).toBe(-61_000)
    expect(wallJump(a.offset, 1_001_000 + WALL_JUMP_MS, 11).jumpMs).toBe(0) // within the margin
  })
})
