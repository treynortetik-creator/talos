// One deadline across the whole discovery (scutil, then every Chronos candidate's `api version` and `version`): a stuck
// Chronos, or two, can hold the scheduler's one-at-a-time queue for DISCOVERY_TOTAL_MS at most, which stays well inside the
// web app's schedules answer window. Fakes with controlled timing; every stalled child is checked gone by the pid it wrote.
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SCHEDULES_ANSWER_MS } from '@talos-app/protocol'
import { t } from '@talos-app/testkit'
import type { BridgeEnv } from '../../src/config.ts'
import { DISCOVERY_TIMEOUT_MS, DISCOVERY_TOTAL_MS, discover } from '../../src/schedules/discovery.ts'
import { killHeldPipes } from '../held-pipe.ts'

let dir = ''
const pidFiles: string[] = []
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'talos-disc-budget-'))
})
afterEach(() => {
  killHeldPipes(pidFiles.splice(0)) // a safety net only: the tests assert each stalled child is already gone
  rmSync(dir, { recursive: true, force: true })
})

const alive = (pid: number) => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}
/** The pids a fake recorded; none when it never ran (the deadline came first). */
const pidsIn = (f: string) =>
  (existsSync(f) ? readFileSync(f, 'utf8') : '')
    .split('\n')
    .map(Number)
    .filter((n) => n > 0)

/** `dir/sub/name`: records its pid, then becomes a 30 s sleep (the same pid), so a kill by pid or group ends it. */
function stalled(sub: string, name: string): { bin: string; pf: string } {
  const d = join(dir, sub)
  mkdirSync(d, { recursive: true })
  const pf = join(dir, `${sub}-${name}.pid`)
  pidFiles.push(pf)
  const bin = join(d, name)
  writeFileSync(bin, `#!/bin/sh\necho $$ >> '${pf}'\nexec /bin/sleep 30\n`, { mode: 0o755 })
  return { bin, pf }
}

const VERSION = '{"api":1,"chronos":"0.3.0","session_runner":"talos","approval_required":true}'
const env = (o: Partial<BridgeEnv>) =>
  ({
    scheduler: 'auto',
    chronosBin: undefined,
    chronosAutoDiscover: true,
    chronosConfig: undefined,
    schedulerTimeoutMs: 5000,
    chronosNow: undefined,
    pathDirs: [],
    userHome: dir, // no ~/.local/share/chronos here
    tz: 'UTC',
    ...o,
  }) as unknown as BridgeEnv
const deps = (o: { timeoutMs?: number; totalMs?: number; scutilBin?: string } = {}) =>
  ({
    meta: { threadOf: () => undefined, offerAgeS: () => null },
    now: () => Date.now(),
    clockIso: () => new Date().toISOString(),
    ...o,
  }) as unknown as Parameters<typeof discover>[1]
const elapsed = async <T>(f: () => Promise<T>) => {
  const t0 = Date.now()
  const r = await f()
  return { r, ms: Date.now() - t0 }
}

// Per call 2 s, in all 2.5 s: two stalled probes would take 4 s each on their own budgets; the total stops them at 2.5 s.
const PER_CALL = 2000
const TOTAL = 2500
const SLOP = 800 // spawn and timer latency on a busy Mac; still well under the 4 s the per-call budgets alone would take

describe('discovery: one deadline for the whole discovery', () => {
  test('the total stays well inside the web app schedules answer window', () => {
    expect(DISCOVERY_TOTAL_MS).toBeGreaterThanOrEqual(DISCOVERY_TIMEOUT_MS) // one healthy probe keeps its whole budget
    const SNAPSHOT_AFTER_MS = 5000 // the one `chronos api snapshot` a frame still needs once discovery has answered
    expect(DISCOVERY_TOTAL_MS + SNAPSHOT_AFTER_MS).toBeLessThanOrEqual(SCHEDULES_ANSWER_MS)
  })

  test('two Chronos candidates that both stall: unanswered within the total, and neither is left running', async () => {
    const a = stalled('a', 'chronos')
    const b = stalled('b', 'chronos')
    const e = env({ pathDirs: [join(dir, 'a'), join(dir, 'b')] })
    const { r, ms } = await elapsed(() => discover(e, deps({ timeoutMs: PER_CALL, totalMs: TOTAL })))
    expect(r.unanswered).toBe(true)
    expect(r.state).toBe('not_installed')
    expect(ms).toBeLessThan(TOTAL + SLOP)
    expect(pidsIn(a.pf).length).toBe(1)
    for (const pid of [...pidsIn(a.pf), ...pidsIn(b.pf)]) {
      for (let i = 0; i < 50 && alive(pid); i++) await Bun.sleep(20)
      expect(alive(pid)).toBe(false)
    }
  }, 15_000)

  test.if(process.platform === 'darwin')(
    "scutil's share counts against the total: a slow scutil leaves the probe only what is left",
    async () => {
      const s = stalled('s', 'scutil')
      const c = stalled('c', 'chronos')
      const e = env({ chronosBin: c.bin, chronosAutoDiscover: false })
      const { r, ms } = await elapsed(() =>
        discover(e, deps({ timeoutMs: PER_CALL, totalMs: TOTAL, scutilBin: s.bin })),
      )
      expect(r.unanswered).toBe(true)
      expect(ms).toBeLessThan(TOTAL + SLOP) // 2 s of scutil plus a 2 s probe would be 4 s
      for (const pid of [...pidsIn(s.pf), ...pidsIn(c.pf)]) {
        for (let i = 0; i < 50 && alive(pid); i++) await Bun.sleep(20)
        expect(alive(pid)).toBe(false)
      }
    },
    15_000,
  )

  test('an `api` that fails fast then a stalled `version`: unanswered within the total, the `version` call gone', async () => {
    const d = join(dir, 'v')
    mkdirSync(d)
    const pf = join(dir, 'v.pid')
    pidFiles.push(pf)
    const bin = join(d, 'chronos')
    // The `api` call fails at once, then `version` stalls: on its own 4 s per-call budget that is 4 s; the 3 s total stops it
    // first. The `api` failure used to take 1 s of the total (a sleep), which left `version` 1 s, then 2 s, to start and record
    // its pid, and a busy Mac hit the total before it started (red main at f141a02; 10 flakes to 11-14). A call that spends the
    // total before the next one is the scutil test's to show; here `version` gets the whole total to start, whatever the load.
    const perCall = 4000
    const total = 3000
    writeFileSync(
      bin,
      `#!/bin/sh\nif [ "$1" = api ]; then echo usage >&2; exit 2; fi\necho $$ >> '${pf}'\nexec /bin/sleep 30\n`,
      { mode: 0o755 },
    )
    const e = env({ chronosBin: bin, chronosAutoDiscover: false })
    const { r, ms } = await elapsed(() => discover(e, deps({ timeoutMs: perCall, totalMs: total })))
    expect(r.unanswered).toBe(true)
    expect(ms).toBeLessThan(total + SLOP)
    expect(pidsIn(pf).length).toBe(1)
    for (const pid of pidsIn(pf)) {
      for (let i = 0; i < 50 && alive(pid); i++) await Bun.sleep(20)
      expect(alive(pid)).toBe(false)
    }
  }, 15_000)

  test(
    'a Chronos 0.2 (no `api`) is still read as old within the total',
    async () => {
      const d = join(dir, 'old')
      mkdirSync(d)
      const bin = join(d, 'chronos')
      writeFileSync(bin, `#!/bin/sh\nif [ "$1" = api ]; then echo usage >&2; exit 2; fi\necho "chronos 0.2.2"\n`, {
        mode: 0o755,
      })
      // two real spawns (`api version`, then `version`) must both fit: on a loaded machine they take longer, so the total scales
      // with TALOS_TEST_TIME_FACTOR here (the product's own budgets stay as they are)
      const r = await discover(env({ chronosBin: bin, chronosAutoDiscover: false }), deps({ totalMs: t(TOTAL) }))
      expect(r.state).toBe('unsupported')
    },
    t(15_000),
  )

  test('a single healthy Chronos is unchanged: ready, with the default budgets', async () => {
    const d = join(dir, 'ok')
    mkdirSync(d)
    const bin = join(d, 'chronos')
    writeFileSync(bin, `#!/bin/sh\necho '${VERSION}'\n`, { mode: 0o755 })
    const r = await discover(env({ chronosBin: bin, chronosAutoDiscover: false }), deps())
    expect(r.state).toBe('ready')
    expect(r.unanswered).toBeUndefined()
  }, 15_000)
})
