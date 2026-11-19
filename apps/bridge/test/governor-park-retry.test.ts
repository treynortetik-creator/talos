// The governor's park-all (router.ts): a park wake the reader refused or dropped is written again while the thread stays live, so
// the bridge never believes a thread parked that did not. Driven with the clock stepped ahead then corrected, and set back. The
// reader is the shared decision (wake-decision.ts) over the real Linux takeWake, on the reader's own clock.
import { afterEach, describe, expect, test } from 'bun:test'
import { existsSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { type WakeFileT, wakeDecision } from '@talos-app/protocol'
import { fakeClock } from '@talos-app/testkit'
import { GOVERNOR_PARK_RETRY_MS } from '../src/router/router.ts'
import { takeWake } from '../src/supervisor/workers-file.ts'
import { type Harness, startHarness, waitFor } from './helpers.ts'

let h: Harness | undefined
afterEach(async () => {
  await h?.stop()
  h = undefined
})
const HOUR = 3_600_000

const thread = (id: string, name: string, x: Record<string, unknown> = {}) => ({
  id,
  name,
  kind: 'fixed',
  order: 5,
  notify: 'all',
  voice_context: 'recent',
  archived: false,
  created_at: '2026-10-28T00:00:00.000Z',
  ...x,
})
const dedicatedConfig = (c: Record<string, unknown> & { threads: unknown[] }) => ({
  ...c,
  threads: [...c.threads, thread('trip', 'Trip', { session: 'dedicated' })],
  dedicated: { enabled: true },
})

function writeWorkers(home: string, now: number, state: string) {
  writeFileSync(
    join(home, 'workers.json'),
    JSON.stringify({
      v: 1,
      supervisor: { pid: 1, heartbeat_at: new Date(now).toISOString(), workers_supported: true, reads_control: true },
      threads: {
        trip: {
          state,
          session_id: '6f1c2a9e-4b3d-4c8e-9a71-2d5e8f0b3c41',
          tmux: 't-trip',
          pane_pid: 0,
          cwd: home,
          error: null,
        },
      },
    }),
  )
}

async function setup() {
  const clock = fakeClock(new Date().toISOString())
  h = await startHarness({ clock, config: dedicatedConfig as never })
  await waitFor(() => existsSync(join(h?.home as string, 'run', 'hub.sock')))
  const hh = h
  // plan limits past park-all (95 %), read just now on whatever the clock says
  hh.bridge.ctx.mod.liveState = () => ({
    session_id: 's',
    source: 'mod' as const,
    capabilities: [],
    rate_limits: [{ kind: 'five_hour', percent: 97 }],
    surfaces: [],
    at: new Date(clock.now()).toISOString(),
  })
  /** One bridge tick with the thread `state` as the supervisor last published it, at the clock's time. */
  const tick = (state = 'live') => {
    writeWorkers(hh.home, clock.now(), state)
    hh.bridge.optionCTick()
  }
  /** The reader: takes the wake file (rename, read, delete) and decides on its own clock. */
  const reader = (now: number) => {
    const w = takeWake(hh.home, 'trip') as WakeFileT | null
    return w ? { wake: w, d: wakeDecision({ wake: w, now, recentTaken: [], threadIdle: true }) } : null
  }
  return { clock, hh, tick, reader, wakeFile: join(hh.home, 'workers', 'trip', 'control') }
}

describe('governor park-all: a park that did not take is written again', () => {
  test('clock ahead, then corrected: the park written ahead is refused as in the future, and the next tick writes a good one', async () => {
    const { clock, tick, reader, wakeFile } = await setup()
    const T = clock.now()
    clock.set(T + HOUR) // the machine clock is an hour fast
    tick()
    expect(existsSync(wakeFile)).toBe(true)
    clock.set(T) // corrected before the reader got to it
    const first = reader(T)
    expect(first?.wake.action).toBe('park')
    expect(first?.d).toEqual({ take: false, audit: 'wake_stale', why: 'in_future' })
    tick() // still live: the park did not take
    const second = reader(T)
    expect(second?.wake).toMatchObject({ action: 'park', reason: 'governor', at: new Date(T).toISOString() })
    expect(second?.d).toMatchObject({
      take: true,
      notice: "Talos parked this thread's session (plan limits are close).",
    })
    tick('parked')
    tick('parked')
    expect(existsSync(wakeFile)).toBe(false) // parked: nothing more
  })

  test('clock set back: a park the reader dropped is written again at once, dated on the new clock', async () => {
    const { clock, tick, reader, wakeFile } = await setup()
    const T = clock.now()
    tick()
    expect(reader(T)).not.toBeNull() // taken, then lost (the reader stopped before acting on it)
    clock.set(T - HOUR)
    tick()
    const again = reader(T - HOUR)
    expect(again?.wake.at).toBe(new Date(T - HOUR).toISOString())
    expect(again?.d).toMatchObject({ take: true })
    tick()
    expect(existsSync(wakeFile)).toBe(false) // inside the retry window on the new clock: no third
  })

  test('steady clock: no second park inside the retry window; one after it while the thread stays live', async () => {
    const { clock, tick, reader, wakeFile } = await setup()
    const T = clock.now()
    tick()
    expect(reader(T)).not.toBeNull()
    clock.set(T + GOVERNOR_PARK_RETRY_MS - 1)
    tick()
    expect(existsSync(wakeFile)).toBe(false)
    clock.set(T + GOVERNOR_PARK_RETRY_MS)
    tick()
    expect(existsSync(wakeFile)).toBe(true)
    // a busy session is live too: it is parked again until it is not
    reader(clock.now())
    clock.set(clock.now() + GOVERNOR_PARK_RETRY_MS)
    tick('busy')
    expect(existsSync(wakeFile)).toBe(true)
  })
})
