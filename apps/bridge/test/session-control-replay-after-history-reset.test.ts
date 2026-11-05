// A reset history forgets which owner controls it already handed over, so the relay's replay of one (the frame was dispatched,
// the bridge crashed, the frame was never consumed) used to run it again: `clear` reached the mod twice, `fresh` woke the
// thread's session twice. The reset time is kept in the new history and a control the owner signed before it (plus the
// 2 minutes of phone clock the bridge accepts) is refused with a recorded result and run by nothing. Real inbound, real mod
// link, real damaged file. A plain restart (no reset) is the control group and behaves as before.
import { Database } from 'bun:sqlite'
import { afterEach, describe, expect, test } from 'bun:test'
import { closeSync, existsSync, openSync, readFileSync, rmSync, writeFileSync, writeSync } from 'node:fs'
import { join } from 'node:path'
import type { ModControlT } from '@talos-app/protocol'
import { type FakeClock, FakeMod, fakeClock } from '@talos-app/testkit'
import { Bridge } from '../src/bridge.ts'
import { loadEnv } from '../src/config.ts'
import { pgidOf } from '../src/hub/server.ts'
import { nullLogger } from '../src/log.ts'
import { advanceSteps, type Harness, sleep, startHarness, tempHome, waitFor } from './helpers.ts'
import { signingLink } from './mod-sign.ts'

let h: Harness | undefined
let b2: Bridge | undefined
afterEach(async () => {
  await b2?.stop()
  b2 = undefined
  await h?.stop()
  h = undefined
})

const PAGE = 4096
function smashRoot(path: string, table: string) {
  const db = new Database(path)
  db.exec('PRAGMA wal_checkpoint(TRUNCATE)')
  const root = (db.query('SELECT rootpage AS r FROM sqlite_master WHERE name = ?').get(table) as { r: number }).r
  db.close()
  const fd = openSync(path, 'r+')
  writeSync(fd, Buffer.alloc(PAGE, 0xff), 0, PAGE, (root - 1) * PAGE)
  closeSync(fd)
}

function liveMod(bridge: Bridge, now: () => number) {
  const mod = new FakeMod({ clock: fakeClock() })
  const link = signingLink(bridge.ctx.mod, now)
  const file = () => readFileSync(bridge.ctx.paths.modKey, 'utf8').trim()
  expect(link.hello(file())).toEqual({ ok: true })
  const sync = (): ModControlT[] => {
    const r = link.sync(mod.syncRequest(file()))
    if (!r.ok) throw new Error(r.message)
    return r.response.controls
  }
  sync()
  return sync
}

const thread = (id: string, name: string, extra: Record<string, unknown> = {}) => ({
  id,
  name,
  kind: 'fixed',
  order: 5,
  notify: 'all',
  voice_context: 'recent',
  archived: false,
  created_at: '2026-10-28T00:00:00.000Z',
  ...extra,
})
function writeWorkers(home: string, heartbeatMs: number) {
  writeFileSync(
    join(home, 'workers.json'),
    JSON.stringify({
      v: 1,
      supervisor: { pid: 1, heartbeat_at: new Date(heartbeatMs).toISOString(), workers_supported: true },
      threads: {
        trip: {
          state: 'live',
          session_id: '6f1c2a9e-4b3d-4c8e-9a71-2d5e8f0b3c41',
          tmux: 't-trip',
          pane_pid: pgidOf(process.pid),
          cwd: home,
          error: null,
        },
      },
    }),
  )
}

async function start(extra: Parameters<typeof startHarness>[0] = {}) {
  h = await startHarness({
    home: tempHome('talos-hist-ctl-'),
    config: ((c: Record<string, unknown> & { threads: unknown[] }) => ({
      ...c,
      threads: [...c.threads, thread('trip', 'Trip', { session: 'dedicated' })],
      dedicated: { enabled: true },
    })) as never,
    ...extra,
  })
  return h
}

/** Stops the first bridge, optionally damages its history, and starts a second one on the same relay and a clock of its own. */
async function restart(x: Harness, damaged: boolean) {
  await x.bridge.stop()
  Bun.gc(true) // the stopped bridge's database handle must really be gone before its file is damaged and moved
  if (damaged) smashRoot(join(x.home, 'history.sqlite'), 'messages')
  const clock = fakeClock(new Date().toISOString())
  const env = loadEnv({
    TALOS_APP_HOME: x.home,
    TALOS_APP_RELAY_URL: x.relay.httpUrl,
    TALOS_APP_BRIDGE: '1',
  })
  const b = await Bridge.create({ env, logger: nullLogger, clock, inbound: { settleMs: 20, maxSettleMs: 200 } })
  b.setEmit(async () => {})
  b2 = b
  b.start()
  // the bridge's timers are on the injected clock: nudge it until the socket is up
  const t0 = Date.now()
  while (!b.client?.connected) {
    if (Date.now() - t0 > 20_000) throw new Error('the second bridge did not connect')
    clock.advance(50)
    await sleep(20)
  }
  // frames the app signs from here on carry the second bridge's time
  const app = x.app as unknown as { sign: (f: Record<string, unknown>) => Promise<Record<string, unknown>> }
  const realSign = app.sign.bind(x.app)
  app.sign = (f) => realSign({ ...f, ts: new Date(clock.now()).toISOString() })
  return { b, clock }
}

/** Nudges the injected clock until `cond` holds (the bridge's settle timers are on it). */
async function ticking(clock: FakeClock, cond: () => boolean, what: string) {
  const t0 = Date.now()
  while (!cond()) {
    if (Date.now() - t0 > 20_000) throw new Error(`timed out waiting for ${what}`)
    clock.advance(50)
    await sleep(20)
  }
}

const results = (x: Harness, controlId: string) =>
  x.relay.frames
    .filter(
      (r) => r.direction === 'from_bridge' && r.raw.type === 'session.control.result' && r.raw.control_id === controlId,
    )
    .map((r) => r.raw as { ok: boolean; code?: string })

const wake = (x: Harness) => join(x.home, 'workers', 'trip', 'wake')

describe('an owner control replayed after the history was reset', () => {
  test('session.control clear, dispatched before the crash, is not handed to the mod again; it is answered as stale', async () => {
    await start()
    const sync = liveMod((h as Harness).bridge, () => Date.now())
    const f = await (h as Harness).app.sendSessionControl('general', { action: 'clear' })
    const first: ModControlT[] = []
    await waitFor(() => first.push(...sync()) > 0, 5000, 'the first dispatch')
    expect(first.map((c) => c.action)).toEqual(['clear'])
    const { b, clock } = await restart(h as Harness, true)
    const syncAgain = liveMod(b, () => clock.now())
    ;(h as Harness).relay.sendToBridge(f as never)
    await ticking(clock, () => results(h as Harness, f.control_id as string).length > 0, 'the answer')
    expect(results(h as Harness, f.control_id as string)[0]).toMatchObject({ ok: false, code: 'control_stale' })
    expect(syncAgain()).toEqual([])
  })

  test('thread.session.control fresh, already acted on, does not write a second wake; it is answered as stale', async () => {
    await start()
    writeWorkers((h as Harness).home, Date.now())
    const f = await (h as Harness).app.sendThreadSessionControl('trip', 'fresh')
    await waitFor(() => results(h as Harness, f.control_id as string).length > 0, 5000, 'the first answer')
    expect(existsSync(wake(h as Harness))).toBe(true)
    rmSync(wake(h as Harness)) // the supervisor takes wakes
    const { clock } = await restart(h as Harness, true)
    writeWorkers((h as Harness).home, clock.now())
    ;(h as Harness).relay.sendToBridge(f as never)
    await ticking(
      clock,
      () => results(h as Harness, f.control_id as string).some((r) => r.code === 'control_stale'),
      'the answer',
    )
    expect(existsSync(wake(h as Harness))).toBe(false)
  })

  test('controls signed after the reset run: one signed inside the 2 minutes of phone clock is still refused, one after them runs', async () => {
    await start()
    const { b, clock } = await restart(h as Harness, true)
    await advanceSteps(clock, 60_000, 20_000, b.client) // a minute after the reset: inside the margin
    const early = await (h as Harness).app.sendSessionControl('general', { action: 'clear' })
    await ticking(clock, () => results(h as Harness, early.control_id as string).length > 0, 'the early answer')
    expect(results(h as Harness, early.control_id as string)[0]).toMatchObject({ ok: false, code: 'control_stale' })
    await advanceSteps(clock, 120_000, 20_000, b.client) // three minutes after the reset
    const syncLate = liveMod(b, () => clock.now()) // the mod says hello again after three minutes
    const late = await (h as Harness).app.sendSessionControl('general', { action: 'clear' })
    const got: ModControlT[] = []
    await ticking(clock, () => got.push(...syncLate()) > 0, 'the control to reach the mod')
    expect(got.map((c) => c.control_id)).toEqual([late.control_id]) // only the late one: the early one never reached the mod
    writeWorkers((h as Harness).home, clock.now())
    const fresh = await (h as Harness).app.sendThreadSessionControl('trip', 'fresh')
    await ticking(clock, () => existsSync(wake(h as Harness)), 'the wake')
    expect(results(h as Harness, fresh.control_id as string).every((r) => r.code !== 'control_stale')).toBe(true)
  })

  test('with no reset nothing changes: a replayed dispatched control is answered as unknown, not stale, and not handed over again', async () => {
    await start()
    const sync = liveMod((h as Harness).bridge, () => Date.now())
    const f = await (h as Harness).app.sendSessionControl('general', { action: 'clear' })
    await waitFor(() => sync().length > 0, 5000, 'the first dispatch')
    const { b, clock } = await restart(h as Harness, false)
    const syncAgain = liveMod(b, () => clock.now())
    ;(h as Harness).relay.sendToBridge(f as never)
    await ticking(clock, () => results(h as Harness, f.control_id as string).length > 0, 'the answer')
    expect(results(h as Harness, f.control_id as string)[0]?.code).toBe('internal')
    expect(syncAgain()).toEqual([])
    expect(b.ctx.store.kvGet('history_reset_at')).toBeUndefined()
  })
})
