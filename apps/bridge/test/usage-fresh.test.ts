// The owner's report: the weekly figure said 27% when it was 35%+. Main sat idle, so its reading froze, while its thread
// sessions did the work; the app and the governor read main's only. Real bridge over the FakeRelay, workers.json as the Mac's
// supervisor writes it, each worker's usage file as its status line writes it (the recorder's format), main's mod state set
// on the link. No real claude.
import { afterEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  SessionState,
  type SessionStateT,
  THREAD_SESSIONS_FEATURE,
  USAGE_AS_OF_FEATURE,
  WakeFile,
  workerUsagePath,
} from '@talos-app/protocol'
import { pgidOf } from '../src/hub/server.ts'
import { type Harness, startHarness, waitFor } from './helpers.ts'

const SID = '6f1c2a9e-4b3d-4c8e-9a71-2d5e8f0b3c41'
const RESET = Math.floor(Date.now() / 1000 + 2 * 86_400) * 1000
let h: Harness | undefined
afterEach(async () => {
  await h?.stop()
  h = undefined
})

const thread = (id: string, extra: Record<string, unknown> = {}) => ({
  id,
  name: id,
  kind: 'fixed',
  order: 5,
  notify: 'all',
  archived: false,
  created_at: '2026-10-28T00:00:00.000Z',
  ...extra,
})

async function hub(relayFeatures: string[]) {
  h = await startHarness({
    relay: { relayFeatures },
    config: ((c: Record<string, unknown> & { threads: unknown[] }) => ({
      ...c,
      threads: [...c.threads, thread('trip', { session: 'dedicated' }), thread('garden', { session: 'dedicated' })],
      dedicated: { enabled: true },
    })) as never,
  })
  await waitFor(() => existsSync(join(h?.home as string, 'run', 'hub.sock')))
  return h
}

function writeWorkers(home: string, threads: Record<string, { state: string; pane_pid?: number }>) {
  const t: Record<string, unknown> = {}
  for (const [id, e] of Object.entries(threads))
    t[id] = { state: e.state, session_id: SID, tmux: `t-${id}`, pane_pid: e.pane_pid ?? 0, cwd: home, error: null }
  writeFileSync(
    join(home, 'workers.json'),
    JSON.stringify({
      v: 1,
      supervisor: { pid: 1, heartbeat_at: new Date().toISOString(), workers_supported: true, reads_control: true },
      threads: t,
    }),
  )
}

/** The worker's status line wrote this `agoMs` ago (the recorder's format: epoch seconds). */
function writeUsage(home: string, thread: string, seven: number, agoMs = 30_000) {
  const p = workerUsagePath(home, thread)
  mkdirSync(join(p, '..'), { recursive: true })
  writeFileSync(
    p,
    JSON.stringify({
      v: 1,
      session_id: SID,
      at: (Date.now() - agoMs) / 1000,
      rate_limits: { seven_day: { used_percentage: seven, resets_at: RESET / 1000 } },
    }),
  )
}

/** Main idle on 27% since a turn that ended 50 minutes ago. */
function mainIdle(hh: Harness, pct = 27) {
  const ended = new Date(Date.now() - 50 * 60_000).toISOString()
  const state = (busy: boolean): SessionStateT => ({
    session_id: 'main-1',
    source: 'mod',
    capabilities: ['stop'],
    busy,
    rate_limits: [{ kind: 'seven_day', percent: pct, resets_at: new Date(RESET).toISOString() }],
    surfaces: [],
    at: ended,
  })
  // the bridge saw the turn run and end then
  hh.bridge.ctx.usage?.readings(state(true), Date.parse(ended))
  hh.bridge.ctx.usage?.readings(state(false), Date.parse(ended))
  hh.bridge.ctx.mod.liveState = () => state(false)
}

const mainStates = (hh: Harness) =>
  hh.relay.frames
    .filter(
      (f) =>
        f.direction === 'from_bridge' &&
        f.frame.type === 'session.state' &&
        (f.frame as { state?: { scope?: unknown } }).state?.scope === undefined,
    )
    .map((f) => (f.frame as unknown as { state: SessionStateT }).state)

describe('the app is shown the newest reading of any session', () => {
  test('idle main says 27%, a busy worker heard 35%: main’s state goes out again with 35% and its time', async () => {
    const hh = await hub([THREAD_SESSIONS_FEATURE, USAGE_AS_OF_FEATURE])
    mainIdle(hh)
    writeWorkers(hh.home, { trip: { state: 'live' } })
    hh.bridge.optionCTick()
    await waitFor(() => mainStates(hh).length > 0)
    const s = mainStates(hh).at(-1) as SessionStateT
    expect(s.session_id).toBe('main-1')
    expect(s.rate_limits).toHaveLength(1)
    expect(s.rate_limits[0]).toMatchObject({ kind: 'seven_day', percent: 27 })
    // the worker hears 35%
    writeUsage(hh.home, 'trip', 35)
    hh.bridge.optionCTick()
    await waitFor(() => mainStates(hh).at(-1)?.rate_limits[0]?.percent === 35)
    const fresh = mainStates(hh).at(-1) as SessionStateT
    const asOf = Date.parse(fresh.rate_limits[0]?.as_of ?? '')
    expect(Math.abs(Date.now() - 30_000 - asOf)).toBeLessThan(5_000)
    // what the relay passed, the app's strict parser takes
    expect(SessionState.safeParse(fresh).success).toBe(true)
    // nothing changed: nothing more is sent
    const n = mainStates(hh).length
    hh.bridge.optionCTick()
    await new Promise((r) => setTimeout(r, 200))
    expect(mainStates(hh).length).toBe(n)
  })

  test('a relay that does not list usage-as-of/1 gets the same figure without as_of (its app would refuse the state)', async () => {
    const hh = await hub([THREAD_SESSIONS_FEATURE])
    mainIdle(hh)
    writeWorkers(hh.home, { trip: { state: 'live' } })
    writeUsage(hh.home, 'trip', 35)
    hh.bridge.optionCTick()
    await waitFor(() => mainStates(hh).at(-1)?.rate_limits[0]?.percent === 35)
    expect(mainStates(hh).at(-1)?.rate_limits[0]).toEqual({
      kind: 'seven_day',
      percent: 35,
      resets_at: new Date(RESET).toISOString(),
    })
  })
})

describe('the governor acts on the newest reading, on every path that starts or parks a thread session', () => {
  test('a worker at 96%: the poll parks the live ones, a message to a parked thread falls back, and a resume is refused', async () => {
    const hh = await hub([THREAD_SESSIONS_FEATURE, USAGE_AS_OF_FEATURE])
    mainIdle(hh) // main still says 27%: before, nothing would have stopped
    writeWorkers(hh.home, {
      trip: { state: 'live', pane_pid: pgidOf(process.pid) as number },
      garden: { state: 'parked' },
    })
    writeUsage(hh.home, 'trip', 96)
    hh.bridge.optionCTick()
    expect(existsSync(join(hh.home, 'workers', 'trip', 'wake'))).toBe(false) // the governor's park never writes a wake
    const wake = WakeFile.parse(JSON.parse(readFileSync(join(hh.home, 'workers', 'trip', 'control'), 'utf8')))
    expect(wake).toMatchObject({ action: 'park', reason: 'governor' })
    // routing: an owner message to the parked thread is answered by main, with the reason
    await hh.app.sendMessage('garden', 'wake up')
    await hh.waitNotes(1)
    expect(hh.notes[0]?.meta).toMatchObject({ thread_id: 'garden', routed: 'fallback', reason: 'usage_governor' })
    // the app's resume button (thread.session.control)
    const f = await hh.app.sendThreadSessionControl('garden', 'resume')
    const res = await hh.relay.expectFrame('session.control.result', (x) => x.control_id === f.control_id, {
      direction: 'from_bridge',
    })
    expect(res).toMatchObject({ ok: false, code: 'usage_governor' })
  })

  test('the same 96% reading 31 minutes old stops nothing (unknown, as no reading does)', async () => {
    const hh = await hub([THREAD_SESSIONS_FEATURE])
    hh.bridge.ctx.mod.liveState = () => undefined
    writeWorkers(hh.home, { garden: { state: 'parked' } })
    writeUsage(hh.home, 'garden', 96, 31 * 60_000)
    hh.bridge.optionCTick()
    expect(hh.bridge.router?.governor().state).toBe('unknown')
    await hh.app.sendMessage('garden', 'wake up')
    await waitFor(() => existsSync(join(hh.home, 'workers', 'garden', 'wake')))
    expect(hh.notes).toHaveLength(0)
  })
})
