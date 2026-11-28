// A thread whose session is parked must not read as "working" (owner's report 54fcdc740fd6). The bridge says "Starting a session for
// this thread..." (a `working` status) when a message goes to a cold thread; it must take that row down once the session is not
// running and nothing waits for it, instead of leaving it until the app's six-hour staleness rule. Real bridge over the FakeRelay
// with a fake clock, as claim-wait.test.ts does it. No real claude.
import { afterEach, describe, expect, setDefaultTimeout, test } from 'bun:test'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fakeClock, t } from '@talos-app/testkit'
import { pgidOf } from '../src/hub/server.ts'
import { advanceSteps, type Harness, sleep, startHarness, waitFor } from './helpers.ts'

setDefaultTimeout(t(60_000))

const MIN = 60_000
let h: Harness | undefined
afterEach(async () => {
  await h?.stop()
  h = undefined
})

const thread = (id: string, name: string, extra: Record<string, unknown> = {}) => ({
  id,
  name,
  kind: 'fixed',
  order: 5,
  notify: 'all',
  archived: false,
  created_at: '2026-10-28T00:00:00.000Z',
  ...extra,
})

function writeWorkers(home: string, now: number, state: string) {
  writeFileSync(
    join(home, 'workers.json'),
    JSON.stringify({
      v: 1,
      supervisor: {
        pid: 1,
        heartbeat_at: new Date(now).toISOString(),
        workers_supported: true,
        reads_control: true,
      },
      threads: {
        trip: {
          state,
          session_id: '6f1c2a9e-4b3d-4c8e-9a71-2d5e8f0b3c41',
          tmux: 't-trip',
          pane_pid: pgidOf(process.pid) as number,
          cwd: home,
          error: null,
        },
      },
    }),
  )
}

async function hub(clock: ReturnType<typeof fakeClock>, state: string) {
  h = await startHarness({
    clock,
    config: ((c: Record<string, unknown> & { threads: unknown[] }) => ({
      ...c,
      threads: [...c.threads, thread('trip', 'Trip', { session: 'dedicated' })],
      dedicated: { enabled: true },
    })) as never,
  })
  await waitFor(() => existsSync(join(h?.home as string, 'run', 'hub.sock')))
  writeWorkers(h.home, clock.now(), state)
  mkdirSync(join(h.home, 'workers', 'trip'), { recursive: true })
  return h
}

const statuses = (hh: Harness) =>
  hh.relay.frames
    .filter((r) => r.direction === 'from_bridge' && r.frame.type === 'status')
    .map((r) => r.frame as { thread_id: string; state: string; label?: string })
    .filter((f) => f.thread_id === 'trip')
const lastStatus = (hh: Harness) => statuses(hh).at(-1)

/** Moves the fake clock in short steps, keeping the supervisor's heartbeat fresh so the bridge's polls keep running. */
async function moveTo(clock: ReturnType<typeof fakeClock>, hh: Harness, state: string, at: number) {
  const left = at - clock.now()
  if (left > 30_000) clock.set(at - 30_000)
  writeWorkers(hh.home, clock.now(), state)
  for (let l = Math.min(left, 30_000); l > 0; l -= 10_000) {
    await advanceSteps(clock, Math.min(10_000, l), 10_000)
    writeWorkers(hh.home, clock.now(), state)
  }
}

const waitForWake = (hh: Harness, clock: ReturnType<typeof fakeClock>) =>
  waitFor(() => {
    clock.advance(50)
    return existsSync(join(hh.home, 'workers', 'trip', 'wake'))
  }, 4000)

describe('a parked thread does not stay "working"', () => {
  test('the start row is taken down once Main has answered for a session that never started', async () => {
    const clock = fakeClock(new Date().toISOString())
    const hh = await hub(clock, 'parked')
    const t0 = clock.now()
    await hh.app.sendMessage('trip', 'Book it')
    await waitForWake(hh, clock)
    await waitFor(() => lastStatus(hh)?.state === 'working', 4000, 'the "Starting a session" row')
    // while the message waits for the session that is being started, the row is true: it stays
    await moveTo(clock, hh, 'parked', t0 + 2 * MIN)
    expect(lastStatus(hh)?.state).toBe('working')
    // three minutes: Main takes the message; the session is still parked and nothing waits for it
    await moveTo(clock, hh, 'parked', t0 + 3 * MIN)
    await waitFor(
      () => {
        clock.advance(50)
        return hh.notes.length >= 1
      },
      4000,
      'main taking the message',
    )
    await waitFor(
      () => {
        clock.advance(1_000)
        return lastStatus(hh)?.state === 'idle'
      },
      4000,
      `the thread to read idle (last frame: ${JSON.stringify(lastStatus(hh))})`,
    )
    // said once, not on every poll
    const idles = statuses(hh).filter((s) => s.state === 'idle').length
    await advanceSteps(clock, 60_000, 10_000)
    expect(statuses(hh).filter((s) => s.state === 'idle')).toHaveLength(idles)
  })

  test('a session that is starting keeps the row while its message waits, and while it lives', async () => {
    const clock = fakeClock(new Date().toISOString())
    const hh = await hub(clock, 'starting')
    const t0 = clock.now()
    await hh.app.sendMessage('trip', 'Book it')
    await waitForWake(hh, clock)
    await moveTo(clock, hh, 'starting', t0 + 90_000)
    await sleep(100) // timing-ok: a negative check: no idle frame may appear while the session is starting
    expect(statuses(hh).some((s) => s.state === 'idle')).toBe(false)
    expect(lastStatus(hh)?.state).toBe('working')
  })
})

describe("Main's own word on a thread is not wiped", () => {
  test('Main answered for a parked thread and set it working: the idle sweep leaves that alone', async () => {
    const clock = fakeClock(new Date().toISOString())
    const hh = await hub(clock, 'parked')
    const t0 = clock.now()
    await hh.app.sendMessage('trip', 'Book it')
    await waitForWake(hh, clock)
    await waitFor(() => lastStatus(hh)?.state === 'working', 4000, 'the "Starting a session" row')
    await moveTo(clock, hh, 'parked', t0 + 3 * MIN)
    await waitFor(
      () => {
        clock.advance(50)
        return hh.notes.length >= 1
      },
      4000,
      'main taking the message',
    )
    // Main is the one answering now, and says so
    const r = await hh.bridge.callTool('set_status', { thread_id: 'trip', state: 'working', label: 'Booking it' })
    expect((r as { isError?: boolean }).isError).not.toBe(true)
    await moveTo(clock, hh, 'parked', clock.now() + 60_000)
    expect(lastStatus(hh)).toMatchObject({ state: 'working', label: 'Booking it' })
  })
})
