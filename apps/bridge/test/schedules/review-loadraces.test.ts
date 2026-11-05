// Re-review of PR #97 at 54c2cb9. Each test below FAILS at 54c2cb9 and names the finding it pins. Real bridge, real Chronos,
// injected clock; a wrapper around `chronos` stalls one `api version`, the same way read-path.test.ts does.
import { afterEach, describe, expect, test } from 'bun:test'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { ScheduleSnapshot } from '@talos-app/protocol'
import type { BridgeEnv } from '../../src/config.ts'
import { discover } from '../../src/schedules/discovery.ts'
import {
  ChronosBox,
  draft,
  leaveDeadInstance,
  longTimeouts,
  MON_0700_EDT,
  type Req,
  type SchedHarness,
  sleep,
  startSched,
  tempHome,
  waitFor,
} from './harness.ts'

longTimeouts()

let h = undefined as unknown as SchedHarness
afterEach(async () => {
  await h?.stop()
  h = undefined as unknown as SchedHarness
})

const AFTER_0730 = '2026-10-05T11:31:00Z' // 07:31 EDT: the 07:30 job is due
const BUDGET_MS = 3000 // comfortably above a real `api version`; the stalled call sleeps 30 s, so it still times out

async function snapshotOf(x: SchedHarness) {
  const f = await x.app.listSchedules()
  const s = await x.app.expectFrame('schedules.snapshot', (r) => r.request_id === (f as unknown as Req).request_id, {
    direction: 'in',
    timeoutMs: 10_000,
  })
  return ScheduleSnapshot.parse(s.snapshot)
}

/** A `chronos` whose next `api version` stalls, once, whenever `arm()` was called. */
function stallable(box: ChronosBox) {
  const dir = mkdtempSync(join(tmpdir(), 'talos-stall-'))
  const bin = join(dir, 'chronos')
  const flag = join(dir, 'stall-next')
  writeFileSync(
    bin,
    `#!/bin/sh\nif [ "$1" = api ] && [ "$2" = version ] && [ -e '${flag}' ]; then rm -f '${flag}'; exec sleep 30; fi\nexec '${box.bin}' "$@"\n`,
  )
  chmodSync(bin, 0o755)
  return {
    bin,
    arm: () => writeFileSync(flag, ''),
    fired: () => !existsSync(flag),
  }
}

/** The first look after start: `start()` holds the queue, so this returns once discovery and the start-up work are done. */
async function startedWith(x: SchedHarness) {
  const snap = await snapshotOf(x)
  await sleep(50) // arm() runs just after the queue drains
  return snap
}

const note = (x: SchedHarness) => x.bridge.ctx.schedules?.discoveryNote() ?? 'no schedule service'

describe('a Chronos that is merely slow (finding H1, H2, H3)', () => {
  test('H1: one slow periodic re-discovery keeps the working adapter, the job list, and sends no `removed`', async () => {
    const box = new ChronosBox(MON_0700_EDT)
    box.configure({ sessionRunner: 'talos', approvalRequired: true })
    box.create(draft())
    const s = stallable(box)
    h = await startSched({ box, env: { TALOS_APP_CHRONOS_BIN: s.bin }, discoveryTimeoutMs: BUDGET_MS })
    expect((await startedWith(h)).schedules.map((j) => j.id)).toEqual(['daily-digest'])
    s.arm()
    await h.advance(5 * 60_000 + 1_000) // the 5-minute rediscover asks, and this one probe misses its budget
    await waitFor(s.fired, 10_000, 'the stalled probe')
    const during = await snapshotOf(h) // queued behind the rediscover, so this is what the owner sees after it
    expect(during.schedules.map((j) => j.id)).toEqual(['daily-digest'])
    expect(note(h)).toStartWith('discovery=ready')
    await h.advance(31_000) // the next 30 s refresh, still before the 60 s retry
    await snapshotOf(h)
    await h.relay.expectNoFrame('schedule.status', (f) => f.removed.length > 0, 100)
  })

  test('H2: a Chronos that did not answer is not reported as not_installed (the install screen)', async () => {
    const box = new ChronosBox(MON_0700_EDT)
    box.configure({ sessionRunner: 'talos', approvalRequired: true })
    box.create(draft())
    const s = stallable(box)
    s.arm()
    h = await startSched({ box, env: { TALOS_APP_CHRONOS_BIN: s.bin }, discoveryTimeoutMs: BUDGET_MS })
    const snap = await startedWith(h)
    expect(snap.health.issues.map((i) => i.code)).toContain('adapter_timeout')
    // emptyKind (apps/web/src/features/schedules/logic.ts) keys on this field: not_installed is the Chronos install screen
    expect(snap.health.state).not.toBe('not_installed')
  })

  test('H3: recovering from an unanswered discovery offers nothing on a Chronos Talos does not manage (S3.7)', async () => {
    const box = new ChronosBox(AFTER_0730)
    box.configure({ sessionRunner: 'hook', approvalRequired: false })
    box.create(draft())
    const s = stallable(box)
    s.arm()
    h = await startSched({ box, now: AFTER_0730, env: { TALOS_APP_CHRONOS_BIN: s.bin }, discoveryTimeoutMs: BUDGET_MS })
    await startedWith(h)
    expect(note(h)).toContain('unanswered')
    await h.advance(61_000) // the runner timer fires ahead of the refresh, and its ensure() recovers
    await waitFor(() => note(h).startsWith('discovery=ready'), 10_000, 'discovery to recover')
    const snap = await snapshotOf(h) // queued behind that runner tick
    await sleep(200)
    expect(snap.health.issues.map((i) => i.code)).toContain('session_runner_conflict') // control: it is unmanaged
    expect(h.notesOf('schedule_run').length).toBe(0)
  })
})

describe('start-up work after a slow first discovery (finding M5)', () => {
  test('M5: the orphan sweep skipped at start runs once discovery recovers', async () => {
    const box = new ChronosBox(MON_0700_EDT)
    box.configure({ sessionRunner: 'talos', approvalRequired: true })
    box.create(draft())
    // what a bridge that died right after `GO` leaves behind (N11, as in session-runner.test.ts)
    const claimed = box.api<{ ok: boolean }>(
      ['claim', 'daily-digest'],
      {
        run_id: 'r_01JBF3V7Q8K2M4N6P8R0S2T4V6',
        ds: '2026-10-05',
        fire_at: '2026-10-05T07:30:00-04:00',
        manual: true,
        again: false,
        runner: 'session',
        bridge_instance: 'bi_dead',
      },
      AFTER_0730,
    )
    expect(claimed.ok).toBe(true)
    const s = stallable(box)
    s.arm()
    const home = tempHome()
    leaveDeadInstance(home, 'bi_dead')
    h = await startSched({
      box,
      home,
      now: AFTER_0730,
      instance: 'bi_next',
      env: { TALOS_APP_CHRONOS_BIN: s.bin },
      discoveryTimeoutMs: BUDGET_MS,
    })
    await startedWith(h)
    expect(note(h)).toContain('unanswered')
    await h.advance(125_000) // the retry, then one more runner tick
    await waitFor(() => note(h).startsWith('discovery=ready'), 10_000, 'discovery to recover')
    await snapshotOf(h)
    await waitFor(
      () => readdirSync(box.stateDir()).includes('failed-daily-digest-2026-10-05'),
      3_000,
      'the orphan closed',
    )
  })
})

describe('discovery calling a live Chronos old (finding M4)', () => {
  const env = (pathDir: string, home: string) =>
    ({
      scheduler: 'auto',
      chronosBin: undefined,
      chronosAutoDiscover: true, // a fake PATH and home: discovery by PATH is what this tests
      chronosConfig: undefined,
      schedulerTimeoutMs: 5000,
      chronosNow: undefined,
      pathDirs: [pathDir],
      userHome: home,
      tz: 'America/New_York',
    }) as unknown as BridgeEnv
  const deps = {
    meta: { threadOf: () => undefined, offerAgeS: () => null },
    now: () => Date.now(),
    clockIso: () => new Date().toISOString(),
    timeoutMs: BUDGET_MS,
  } as unknown as Parameters<typeof discover>[1]
  const script = (path: string, body: string) => {
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, `#!/bin/sh\n${body}\n`)
    chmodSync(path, 0o755)
  }
  const OLD_02 = `if [ "$1" = api ]; then echo "usage: chronos <command>" >&2; exit 2; fi\necho "chronos 0.2.2"`

  test('M4: a slow Chronos on PATH beside a stale 0.2 is unanswered, not unsupported', async () => {
    const root = mkdtempSync(join(tmpdir(), 'talos-slow-beside-old-'))
    script(join(root, 'path', 'chronos'), `if [ "$1" = api ]; then exec /bin/sleep 30; fi\necho "chronos 0.3.0"`)
    script(join(root, 'home', '.local', 'share', 'chronos', 'bin', 'chronos'), OLD_02)
    const d = await discover(env(join(root, 'path'), join(root, 'home')), deps)
    expect(d.state).not.toBe('unsupported')
    expect(d.unanswered).toBe(true)
  })

  test('M4: a transient bad answer from a healthy 0.3 is not "Chronos 0.3 is installed, Talos needs 0.3 or newer"', async () => {
    const root = mkdtempSync(join(tmpdir(), 'talos-parse-03-'))
    mkdirSync(join(root, 'home'))
    script(join(root, 'path', 'chronos'), `if [ "$1" = api ]; then echo "not json"; exit 0; fi\necho "chronos 0.3.0"`)
    const d = await discover(env(join(root, 'path'), join(root, 'home')), deps)
    expect(d.state).not.toBe('unsupported')
  })
})
