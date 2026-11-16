// The weekly figure went stale (27% shown, 35%+ real) because the app and the governor read main's reading only, and main's
// freezes while it sits idle and its thread sessions do the work. These drive the pool (router/usage-pool.ts) and the governor
// with real files in a temp Talos home, a worker's usage file written by the REAL recorder program (python3 -I), and a clock
// moved by hand.
import { afterEach, describe, expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  DedicatedConfig,
  type RateLimitT,
  type SessionStateT,
  USAGE_AS_OF_FEATURE,
  USAGE_FILE_MAX_BYTES,
  usageRecorderCommand,
  type WorkersFileT,
  workerUsagePath,
} from '@talos-app/protocol'
import { governor } from '../src/router/governor.ts'
import { UsagePool } from '../src/router/usage-pool.ts'

const SID = '6f1c2a9e-4b3d-4c8e-9a71-2d5e8f0b3c41'
const T0 = Date.parse('2026-11-12T18:00:00.000Z')
// Far ahead of every clock the tests use, T0 and the real one (the real-run test reads Date.now()): a fixed near date went
// red the minute it passed (2026-11-15T00:00Z).
const RESET = Date.parse('2099-11-15T00:00:00.000Z')
const iso = (ms: number) => new Date(ms).toISOString()
const dirs: string[] = []
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

function home() {
  const d = mkdtempSync(join(tmpdir(), 'usage-pool-'))
  dirs.push(d)
  return d
}
const workers = (threads: Record<string, string | undefined>): WorkersFileT =>
  ({
    v: 1,
    supervisor: { pid: 1, heartbeat_at: iso(T0), workers_supported: true },
    unavailable: [],
    threads: Object.fromEntries(
      Object.entries(threads).map(([id, sid]) => [
        id,
        { state: 'live', session_id: sid, tmux: `t-${id}`, pane_pid: 0, cwd: '/home/alex/x', error: null },
      ]),
    ),
  }) as unknown as WorkersFileT

/** A usage file as the recorder writes it, `atMs` its time (the file's mtime set to match). */
function writeUsage(h: string, thread: string, atMs: number, seven: number, extra: Record<string, unknown> = {}) {
  const p = workerUsagePath(h, thread)
  mkdirSync(join(p, '..'), { recursive: true })
  writeFileSync(
    p,
    JSON.stringify({
      v: 1,
      session_id: SID,
      at: atMs / 1000,
      rate_limits: { seven_day: { used_percentage: seven, resets_at: RESET / 1000 } },
      ...extra,
    }),
  )
  utimesSync(p, atMs / 1000, atMs / 1000)
}

const mainState = (seven: number | undefined, over: Partial<SessionStateT> = {}): SessionStateT => ({
  session_id: 'main-1',
  source: 'mod',
  capabilities: ['stop'],
  rate_limits: seven === undefined ? [] : [{ kind: 'seven_day', percent: seven, resets_at: iso(RESET) }],
  surfaces: [],
  at: iso(T0),
  ...over,
})
const seven = (rs: RateLimitT[]) => rs.find((r) => r.kind === 'seven_day')

function logger() {
  const warns: Array<{ m: string; f?: unknown }> = []
  const rec = (m: string, f?: unknown) => warns.push({ m, f })
  return { log: { debug() {}, info() {}, warn: rec, error: rec, security() {} } as never, warns }
}

describe('the newest reading of any session is the one shown', () => {
  test('a busy worker’s newer reading replaces idle main’s older one', () => {
    const h = home()
    const pool = new UsagePool()
    let now = T0
    // main ran a turn and has been idle since: its reading is timed at the end of that turn
    pool.readings(mainState(27, { busy: true }), now)
    pool.readings(mainState(27), now)
    now += 40 * 60_000
    expect(seven(pool.readings(mainState(27), now))).toEqual({
      kind: 'seven_day',
      percent: 27,
      resets_at: iso(RESET),
      as_of: iso(T0),
    })
    // a worker heard 35% a minute ago
    writeUsage(h, 'trip', now - 60_000, 35)
    pool.readThreads(h, workers({ trip: SID }), now)
    expect(seven(pool.readings(mainState(27), now))).toEqual({
      kind: 'seven_day',
      percent: 35,
      resets_at: iso(RESET),
      as_of: iso(now - 60_000),
    })
    // main runs again and hears 36%: now main's is the newest
    now += 120_000
    expect(seven(pool.readings(mainState(36, { busy: true, at: iso(now) }), now))?.percent).toBe(36)
  })

  test('main’s first reading while idle has no time, so a timed worker reading wins; main’s change gets one', () => {
    const h = home()
    const pool = new UsagePool()
    expect(seven(pool.readings(mainState(27), T0))?.as_of).toBeUndefined()
    writeUsage(h, 'trip', T0 - 3 * 3_600_000, 31) // three hours old, still the only timed one
    pool.readThreads(h, workers({ trip: SID }), T0)
    expect(seven(pool.readings(mainState(27), T0))?.percent).toBe(31)
    // main's figure moves: that is a fresh reading
    expect(seven(pool.readings(mainState(28, { at: iso(T0 + 1000) }), T0 + 1000))).toMatchObject({
      percent: 28,
      as_of: iso(T0 + 1000),
    })
    // and staying the same while idle keeps its time
    expect(seven(pool.readings(mainState(28, { at: iso(T0 + 600_000) }), T0 + 600_000))?.as_of).toBe(iso(T0 + 1000))
  })

  test('a reading past its reset is dropped: after the weekly reset, the old high figure is gone', () => {
    const h = home()
    const pool = new UsagePool()
    writeUsage(h, 'trip', RESET - 60_000, 99)
    pool.readThreads(h, workers({ trip: SID }), RESET - 30_000)
    expect(seven(pool.readings(undefined, RESET - 30_000))?.percent).toBe(99)
    expect(seven(pool.readings(undefined, RESET + 1))).toBeUndefined()
  })

  test('a worker that parks keeps its reading; one that leaves workers.json, or starts a new session, takes it away', () => {
    const h = home()
    const pool = new UsagePool()
    writeUsage(h, 'trip', T0, 35)
    pool.readThreads(h, workers({ trip: SID }), T0)
    expect(seven(pool.readings(undefined, T0))?.percent).toBe(35)
    pool.readThreads(h, workers({ trip: 'aaaaaaaa-0000-4000-8000-000000000000' }), T0)
    expect(seven(pool.readings(undefined, T0))).toBeUndefined() // the file is the earlier session's
    pool.readThreads(h, workers({ trip: SID }), T0)
    pool.readThreads(h, workers({}), T0)
    expect(seven(pool.readings(undefined, T0))).toBeUndefined()
  })

  test('main’s untimed reading feeds nothing once its mod lapses; a timed one stays and ages', () => {
    const pool = new UsagePool()
    pool.readings(mainState(27), T0)
    expect(pool.readings(undefined, T0)).toEqual([])
    // back, and its figure moves: timed (by the state's own time)
    pool.readings(mainState(27, { at: iso(T0 + 500) }), T0 + 500)
    pool.readings(mainState(30, { at: iso(T0 + 1000) }), T0 + 1200)
    expect(seven(pool.readings(undefined, T0 + 2000))).toMatchObject({ percent: 30, as_of: iso(T0 + 1000) })
  })
})

describe('the app gets as_of only through a relay that reads it', () => {
  test('without usage-as-of/1 the state has no as_of; with it, it does', () => {
    const h = home()
    const pool = new UsagePool()
    writeUsage(h, 'trip', T0 - 60_000, 35)
    pool.readThreads(h, workers({ trip: SID }), T0)
    pool.setRelayFeatures(['thread-sessions/1'])
    expect(pool.forApp(mainState(27), T0).rate_limits).toEqual([
      { kind: 'seven_day', percent: 35, resets_at: iso(RESET) },
    ])
    pool.setRelayFeatures(['thread-sessions/1', USAGE_AS_OF_FEATURE])
    expect(pool.forApp(mainState(27), T0).rate_limits).toEqual([
      { kind: 'seven_day', percent: 35, resets_at: iso(RESET), as_of: iso(T0 - 60_000) },
    ])
  })
})

describe('a usage file that cannot be used is said, and never reads as a fresh figure', () => {
  test('garbage, a link, a huge file and a future time each: no reading, one log line per problem, main’s shown with its real time', () => {
    const h = home()
    const { log, warns } = logger()
    const pool = new UsagePool(log)
    pool.readings(mainState(27, { busy: true, at: iso(T0 - 50 * 60_000) }), T0 - 50 * 60_000)
    pool.readings(mainState(27, { at: iso(T0 - 50 * 60_000) }), T0 - 50 * 60_000)
    const p = workerUsagePath(h, 'trip')
    mkdirSync(join(p, '..'), { recursive: true })
    writeFileSync(p, '{not json')
    pool.readThreads(h, workers({ trip: SID }), T0)
    pool.readThreads(h, workers({ trip: SID }), T0) // same file: no second line
    expect(warns.filter((w) => w.m === 'thread usage reading not used')).toHaveLength(1)
    const shown = seven(pool.readings(mainState(27), T0))
    expect(shown).toMatchObject({ percent: 27, as_of: iso(T0 - 50 * 60_000) }) // the old time travels with it
    // a link (a session's shell could plant one) is not followed
    rmSync(p)
    const elsewhere = join(h, 'elsewhere.json')
    writeFileSync(
      elsewhere,
      JSON.stringify({ session_id: SID, at: T0 / 1000, rate_limits: { seven_day: { used_percentage: 1 } } }),
    )
    symlinkSync(elsewhere, p)
    pool.readThreads(h, workers({ trip: SID }), T0)
    expect(seven(pool.readings(mainState(27), T0))?.percent).toBe(27)
    rmSync(p)
    writeFileSync(p, ' '.repeat(USAGE_FILE_MAX_BYTES + 1))
    pool.readThreads(h, workers({ trip: SID }), T0)
    writeUsage(h, 'trip', T0 + 3_600_000, 1) // stamped an hour ahead (file time too)
    pool.readThreads(h, workers({ trip: SID }), T0)
    expect(seven(pool.readings(mainState(27), T0))?.percent).toBe(27)
    expect(warns.map((w) => (w.f as { problem: string }).problem)).toEqual([
      expect.stringMatching(/^unreadable/),
      'not a plain file',
      'too big',
      'time ahead of the clock',
    ])
  })
})

describe('the governor with readings of mixed age', () => {
  const settings = DedicatedConfig.parse({ enabled: true })
  const at = (pct: number, ageMin: number, over: Partial<RateLimitT> = {}): RateLimitT => ({
    kind: 'seven_day',
    percent: pct,
    resets_at: iso(RESET),
    as_of: iso(T0 - ageMin * 60_000),
    ...over,
  })

  test('a fresh high reading parks; the same reading 31 minutes old is no reading (unknown, as a missing one is today)', () => {
    expect(governor(settings, { rate_limits: [at(96, 5)] }, T0)).toEqual({ state: 'park_all', resets_at: iso(RESET) })
    expect(governor(settings, { rate_limits: [at(96, 31)] }, T0)).toEqual({ state: 'unknown' })
    expect(governor(settings, { rate_limits: [] }, T0)).toEqual({ state: 'unknown' })
  })

  test('a stale high reading does not outvote a fresh low one, and a stale low one does not hide a fresh high one', () => {
    expect(governor(settings, { rate_limits: [at(96, 45), at(40, 2)] }, T0).state).toBe('ok')
    expect(governor(settings, { rate_limits: [at(10, 300), at(86, 2)] }, T0).state).toBe('paused')
  })

  test('after a reset the old high reading is gone, even a fresh-looking one', () => {
    expect(governor(settings, { rate_limits: [at(99, 1, { resets_at: iso(T0 - 1000) })] }, T0).state).toBe('unknown')
  })

  test('an untimed reading (main’s first) is used as before: no limit loosened', () => {
    expect(governor(settings, { rate_limits: [{ kind: 'five_hour', percent: 81 }] }, T0).state).toBe('paused')
    expect(governor(settings, { rate_limits: [{ kind: 'seven_day', percent: 95 }] }, T0).state).toBe('park_all')
  })

  test('through the pool: a busy worker at 96% parks everything though idle main still says 27%', () => {
    const h = home()
    const pool = new UsagePool()
    // main's turn ended an hour ago (the idle state the mod sent then, first looked at now)
    pool.readings(mainState(27, { busy: true, at: iso(T0 - 3_600_000) }), T0 - 3_600_000)
    pool.readings(mainState(27, { at: iso(T0 - 3_595_000) }), T0)
    writeUsage(h, 'trip', T0 - 60_000, 96)
    pool.readThreads(h, workers({ trip: SID }), T0)
    expect(governor(settings, { rate_limits: pool.readings(mainState(27), T0) }, T0).state).toBe('park_all')
  })
})

describe('the recorder program, run for real', () => {
  const python = spawnSync('python3', ['-c', 'import sys; print(sys.executable)'], { encoding: 'utf8' }).stdout.trim()
  // the documented status-line JSON (code.claude.com statusline, "Available data"): rate_limits with epoch-second resets
  const STATUS = {
    session_id: SID,
    model: { id: 'claude-opus-5-5', display_name: 'Opus' },
    context_window: { used_percentage: 12 },
    rate_limits: {
      five_hour: { used_percentage: 23.5, resets_at: 1763000000 },
      seven_day: { used_percentage: 35.2, resets_at: RESET / 1000 },
    },
  }
  const run = (cmd: string, input: string) =>
    spawnSync('/bin/sh', ['-c', cmd], { input, encoding: 'utf8', timeout: 10_000 })

  test('writes the reading with its time and prints the short line; the bridge reads it back', () => {
    expect(python.startsWith('/')).toBe(true)
    const h = home()
    const p = workerUsagePath(h, 'trip')
    mkdirSync(join(p, '..'), { recursive: true })
    const before = Date.now()
    const r = run(usageRecorderCommand(python, p), JSON.stringify(STATUS))
    expect(r.status).toBe(0)
    expect(r.stdout.trim()).toBe('Talos: Opus | 7d: 35%')
    const file = JSON.parse(readFileSync(p, 'utf8'))
    expect(file.session_id).toBe(SID)
    expect(file.rate_limits).toEqual(STATUS.rate_limits)
    expect(file.at * 1000).toBeGreaterThanOrEqual(before - 1000)
    const pool = new UsagePool()
    pool.readThreads(h, workers({ trip: SID }), Date.now())
    expect(seven(pool.readings(undefined, Date.now()))).toMatchObject({ percent: 35.2, resets_at: iso(RESET) })
  })

  test('garbage in, or no rate_limits yet: exit 0, the last good file kept', () => {
    const h = home()
    const p = workerUsagePath(h, 'trip')
    mkdirSync(join(p, '..'), { recursive: true })
    expect(run(usageRecorderCommand(python, p), JSON.stringify(STATUS)).status).toBe(0)
    const good = readFileSync(p, 'utf8')
    const mtime = statSync(p).mtimeMs
    for (const input of ['not json', '[]', JSON.stringify({ session_id: SID, model: { display_name: 'Opus' } }), '']) {
      const r = run(usageRecorderCommand(python, p), input)
      expect(r.status).toBe(0)
      expect(r.stderr).toBe('')
    }
    expect(readFileSync(p, 'utf8')).toBe(good)
    expect(statSync(p).mtimeMs).toBe(mtime)
  })

  test('a folder it cannot write: exit 0 and the line still prints (the status line never breaks)', () => {
    const r = run(usageRecorderCommand(python, '/nonexistent-dir/usage.json'), JSON.stringify(STATUS))
    expect(r.status).toBe(0)
    expect(r.stdout.trim()).toBe('Talos: Opus | 7d: 35%')
  })
})
