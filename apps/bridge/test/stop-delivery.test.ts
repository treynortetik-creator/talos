// A bridge that has started to stop hands nothing over (src/stopping.ts). Every path that ends a bridge, a restart of main, an
// update, a thread session being parked, a crash, goes through Bridge.stop() or through no stop at all, and in each an owner
// message the old bridge had not finished with must stay with the relay and be delivered ONCE by the next bridge: not lost
// (the old bridge consumed it for an agent that was going away) and not twice (the old bridge delivered it and the relay
// replayed it). Real bridges, FakeRelay, FakeApp, real git. The slow stop is Bridge's `stopDelay` seam; the undo hold that
// used to run out DURING a slow stop (5 s on the bridge's clock) is run out with a fake clock, so no test waits for it.
import { afterEach, describe, expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { existsSync, mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CLAIM_DEADLINE_MS, newId, runText } from '@talos-app/protocol'
import { fakeClock } from '@talos-app/testkit'
import { Bridge } from '../src/bridge.ts'
import { loadEnv } from '../src/config.ts'
import { statusFrame } from '../src/frames-out.ts'
import { pgidOf } from '../src/hub/server.ts'
import { installLifecycle } from '../src/lifecycle.ts'
import { createLogger, type Logger, nullLogger } from '../src/log.ts'
import { type Notification, systemNotification } from '../src/notify.ts'
import { UndoPoints } from '../src/undo/points.ts'
import { UNDO_HOLD_MS } from '../src/undo/service.ts'
import { type Snapshot, type SnapshotOpts, snapshotFolder } from '../src/undo/snapshot.ts'
import { advanceSteps, type Harness, sleep, startHarness, waitFor } from './helpers.ts'

let h: Harness | undefined
const later: Bridge[] = []
const open: Array<() => void> = []
const stopsBegun: Array<Promise<void>> = []
afterEach(async () => {
  for (const g of gates.splice(0)) g()
  for (const o of open.splice(0)) o()
  await Promise.allSettled(stopsBegun.splice(0)) // a stop the test left open is finished before the relay is torn down
  for (const b of later.splice(0)) await b.stop()
  await h?.stop()
  h = undefined
})

const scratch = mkdtempSync(join(tmpdir(), 'talos-stop-delivery-'))
let n = 0
const gitEnv = {
  ...process.env,
  GIT_AUTHOR_NAME: 'Alex Example',
  GIT_AUTHOR_EMAIL: 'alex@example.com',
  GIT_COMMITTER_NAME: 'Alex Example',
  GIT_COMMITTER_EMAIL: 'alex@example.com',
}
const git = (cwd: string, ...args: string[]) => spawnSync('git', args, { cwd, encoding: 'utf8', env: gitEnv })
function repo(name: string): string {
  const r = join(scratch, `${name}-${n++}`)
  mkdirSync(r, { recursive: true })
  git(r, 'init', '-q', '-b', 'main')
  writeFileSync(join(r, 'a.txt'), 'a\n')
  git(r, 'add', '-A')
  git(r, 'commit', '-q', '-m', 'one')
  return realpathSync(r)
}

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
function writeWorkers(home: string, now: number, cwd: string, state = 'live') {
  writeFileSync(
    join(home, 'workers.json'),
    JSON.stringify({
      v: 1,
      supervisor: { pid: 1, heartbeat_at: new Date(now).toISOString(), workers_supported: true },
      threads: {
        trip: {
          state,
          session_id: '6f1c2a9e-4b3d-4c8e-9a71-2d5e8f0b3c41',
          tmux: 't-trip',
          pane_pid: 0,
          cwd,
          error: null,
        },
      },
    }),
  )
}

/** Snapshots of `held` wait until the test lets them go; any other folder's run straight through. */
const gates: Array<() => void> = []
function holding(held: string) {
  const snapshot = async (o: SnapshotOpts): Promise<Snapshot> => {
    const s = await snapshotFolder(o)
    if (realpathSync(o.folder) === held) await new Promise<void>((res) => gates.push(res))
    return s
  }
  return { snapshot, release: () => gates.shift()?.() }
}

/** Moves a fake clock in small steps until a snapshot is being held (the bridge's own timers need the clock to move). */
async function untilHeld(clock: ReturnType<typeof fakeClock>) {
  const start = Date.now()
  while (gates.length === 0) {
    if (Date.now() - start > 10_000) throw new Error('the snapshot was never held')
    clock.advance(10) // small steps: the 5 s hold must not run out on a slow machine while the test waits for it to start
    await sleep(20)
  }
}

/** A stop that stays slow until the test says otherwise: the bridge is "stopping" for as long as it likes. */
function slowStop(): { delay: () => Promise<void>; finish: () => void } {
  let finish = () => {}
  const p = new Promise<void>((r) => {
    finish = r
  })
  open.push(finish)
  return { delay: () => p, finish }
}

async function setup(
  o: { clock?: ReturnType<typeof fakeClock>; hold?: boolean; stopDelay?: () => Promise<void>; logger?: Logger } = {},
) {
  const main = repo('main')
  const worker = repo('worker')
  const gate = holding(o.hold === false ? '/nowhere' : main)
  const home = mkdtempSync(join(tmpdir(), 'talos-stop-home-'))
  writeWorkers(home, o.clock?.now() ?? Date.now(), worker)
  h = await startHarness({
    home,
    ...(o.clock ? { clock: o.clock } : {}),
    bridge: {
      undo: { agentDir: main, snapshot: gate.snapshot },
      ...(o.stopDelay ? { stopDelay: o.stopDelay } : {}),
      ...(o.logger ? { logger: o.logger } : {}),
    },
    config: ((c: Record<string, unknown> & { threads: unknown[] }) => ({
      ...c,
      threads: [...c.threads, thread('trip', 'Trip', { session: 'dedicated' })],
      dedicated: { enabled: true },
    })) as never,
  })
  return { hh: h, main, worker, gate }
}

/** The next bridge on the same home, as a restart starts it. It delivers into `notes`. */
async function restart(hh: Harness, main: string, clock?: ReturnType<typeof fakeClock>) {
  const notes: Notification[] = []
  const b = await Bridge.create({
    env: loadEnv({ TALOS_APP_HOME: hh.home, TALOS_APP_RELAY_URL: hh.relay.httpUrl, TALOS_APP_BRIDGE: '1' }),
    logger: createLogger(null, 'error', () => {}), // its own: a tap is stored on the logger
    inbound: { settleMs: 20, maxSettleMs: 200 },
    undo: { agentDir: main },
    ...(clock ? { clock } : {}),
  })
  later.push(b)
  b.setEmit(async (x) => {
    notes.push(x)
  })
  b.start()
  return { b, notes }
}

const acksFor = (hh: Harness, frameId: string, stage: string) =>
  hh.relay.rec.frames.filter(
    (r) => r.direction === 'from_bridge' && r.raw.type === 'ack' && r.raw.ref === frameId && r.raw.stage === stage,
  )
const receiptsFor = (hh: Harness, messageId: string) =>
  hh.relay.rec.frames.filter(
    (r) => r.direction === 'from_bridge' && r.raw.type === 'receipt' && r.raw.message_id === messageId,
  )
const resultsFor = (hh: Harness, id: string) =>
  hh.relay.rec.frames.filter(
    (r) => r.direction === 'from_bridge' && r.raw.type === 'session.control.result' && r.raw.control_id === id,
  )

/**
 * Everything the bridge had queued has run, and everything it sent for that has reached the relay: the inbound queue and lanes
 * are idle, and a marker frame sent after them has been recorded (the socket keeps its order, so what came before it is in).
 */
let flushes = 0
async function settled(hh: Harness) {
  await hh.bridge.inbound?.idle()
  const label = `flush-${flushes++}`
  hh.bridge.ctx.transport.sendEphemeral(statusFrame(Date.now(), 'general', 'idle', label))
  await waitFor(
    () =>
      hh.relay.rec.frames.some(
        (r) => r.direction === 'from_bridge' && r.raw.type === 'status' && r.raw.label === label,
      ),
    4000,
    'the marker frame',
  )
}

/** What the old bridge did about one message: nothing the relay or the agent could take for "consumed". */
function expectUntouched(hh: Harness, sent: { id: string; client_msg_id: unknown }, storeOpen = true) {
  expect(hh.notes).toHaveLength(0)
  if (storeOpen) expect(hh.bridge.ctx.store.hasSeen(sent.client_msg_id as string)).toBe(false)
  expect(acksFor(hh, sent.id, 'consumed')).toHaveLength(0)
  expect(receiptsFor(hh, sent.client_msg_id as string).filter((r) => r.raw.state === 'delivered')).toHaveLength(0)
}

/** The relay gave the new bridge the message once, and it was consumed once. */
async function expectDeliveredOnce(
  hh: Harness,
  b: Bridge,
  notes: Notification[],
  sent: { id: string; client_msg_id: unknown },
) {
  const id = sent.client_msg_id as string
  await waitFor(() => notes.some((x) => x.meta.message_id === id), 8000, 'the replayed message')
  await b.inbound?.idle()
  expect(notes.filter((x) => x.meta.message_id === id)).toHaveLength(1)
  await waitFor(() => acksFor(hh, sent.id, 'consumed').length > 0, 4000, 'the consumed ack of the new bridge')
  expect(hh.notes).toHaveLength(0) // and the old one never did
}

/** A thread session's own bridge (worker mode) for 'trip', connected to main's hub: what a parked session's process runs. */
async function startWorkerBridge(hh: Harness): Promise<Bridge> {
  await waitFor(() => existsSync(join(hh.home, 'run', 'hub.sock')), 8000, 'the hub socket')
  const nonce = 'test-nonce-0123456789abcdef'
  const me = pgidOf(process.pid) as number
  const trip = {
    state: 'live',
    session_id: '6f1c2a9e-4b3d-4c8e-9a71-2d5e8f0b3c41',
    tmux: 't-trip',
    pane_pid: me,
    cwd: hh.home,
    restarts: [],
    error: null,
  }
  writeFileSync(
    join(hh.home, 'workers.json'),
    JSON.stringify({
      v: 1,
      supervisor: { pid: 1, heartbeat_at: new Date().toISOString(), workers_supported: true },
      threads: { trip },
    }),
  )
  mkdirSync(join(hh.home, 'workers', 'trip'), { recursive: true })
  writeFileSync(join(hh.home, 'workers', 'trip', 'nonce'), nonce)
  const worker = await Bridge.create({
    env: loadEnv({
      TALOS_APP_HOME: hh.home,
      TALOS_APP_RELAY_URL: hh.relay.httpUrl,
      TALOS_APP_WORKER_THREAD: 'trip',
      TALOS_APP_WORKER_NONCE: nonce,
    }),
    logger: createLogger(null, 'error', () => {}), // its own: a tap is stored on the logger
  })
  later.push(worker)
  expect(await worker.startWorker()).toBe(true)
  return worker
}

describe('a bridge that is stopping hands nothing over', () => {
  test('main restart (a slow stop): the hold that ran out during it delivers nothing, and the restart gets the message once', async () => {
    // Before: the 5 s undo hold ran out while stop() was still awaiting, and the stopping bridge delivered the message to its
    // agent, marked it seen and acked it consumed: the relay dropped it, the restart skipped it (seen), nobody was told.
    const clock = fakeClock(new Date().toISOString())
    const stop = slowStop()
    const { hh, main, gate } = await setup({ clock, stopDelay: stop.delay })
    const sent = await hh.app.sendMessage('general', 'held while the bridge stops')
    await untilHeld(clock)
    const stopping = hh.bridge.stop()
    clock.advance(UNDO_HOLD_MS + 1000) // the hold's own time is up while the stop is still going on
    await settled(hh)
    expectUntouched(hh, sent)
    // the snapshot that was waiting is let go late: a bridge that gave the message up records no point for it, or the restart
    // would find one and call the message "handed over before"
    gate.release()
    await settled(hh)
    expect(new UndoPoints(hh.bridge.ctx.store.db).get(sent.client_msg_id as string)).toBeUndefined()
    stop.finish()
    await stopping
    const { b, notes } = await restart(hh, main)
    await expectDeliveredOnce(hh, b, notes, sent)
    expect(new UndoPoints(b.ctx.store.db).get(sent.client_msg_id as string)?.state).toBe('ready')
  })

  test('update restart and a restart of main end in the same stop: stdin closed runs it, and a held message stays with the relay', async () => {
    // installLifecycle is what server.ts runs on SIGTERM, SIGINT, SIGHUP and a closed stdin (a restart, an update that
    // relaunches the session, the previous bridge told to go by a new one); its shutdown is bridge.stop().
    const clock = fakeClock(new Date().toISOString())
    const { hh, main } = await setup({ clock })
    const sent = await hh.app.sendMessage('general', 'held when the session is relaunched')
    await untilHeld(clock)
    const stdin = new EventEmitter() as unknown as NodeJS.ReadStream
    let exited: (code: number) => void = () => {}
    const exit = new Promise<number>((r) => {
      exited = r
    })
    const off = installLifecycle({
      log: nullLogger,
      stdin,
      exit: (c) => exited(c),
      shutdown: async () => {
        const stopping = hh.bridge.stop()
        clock.advance(UNDO_HOLD_MS + 1000)
        await stopping
      },
    })
    try {
      stdin.emit('end')
      expect(await exit).toBe(0)
    } finally {
      off()
    }
    expectUntouched(hh, sent, false) // stop finished: its store is closed, the relay's frames and the agent's notes tell the rest
    const { b, notes } = await restart(hh, main)
    await expectDeliveredOnce(hh, b, notes, sent)
  })

  test("a message that arrives while the bridge is stopping isn't taken up: no ack, no delivery, and the restart gets it", async () => {
    const stop = slowStop()
    const { hh, main } = await setup({ hold: false, stopDelay: stop.delay })
    const arrived: string[] = []
    const inbound = hh.bridge.inbound as unknown as { onFrame(raw: Record<string, unknown>, f: { id: string }): void }
    const real = inbound.onFrame.bind(inbound)
    inbound.onFrame = (raw, f) => {
      arrived.push(f.id)
      real(raw, f)
    }
    const stopping = hh.bridge.stop()
    const sent = await hh.app.sendMessage('general', 'sent while the bridge stops')
    await waitFor(() => arrived.includes(sent.id), 4000, 'the frame to reach the stopping bridge')
    await settled(hh)
    expect(hh.bridge.inbound?.inflight.has(sent.id)).toBe(false)
    expectUntouched(hh, sent)
    expect(acksFor(hh, sent.id, 'delivered')).toHaveLength(0)
    stop.finish()
    await stopping
    const { b, notes } = await restart(hh, main)
    await expectDeliveredOnce(hh, b, notes, sent)
  })

  test('a replay burst still waiting out its settle window when stop begins is not started', async () => {
    // The relay's replay after `ready` is collected for settleMs / maxSettleMs on the bridge's clock, and those timers fire
    // whenever they like: one that fires after stop began used to deliver and ack what it had collected.
    const clock = fakeClock(new Date().toISOString())
    const stop = slowStop()
    const main = repo('main')
    h = await startHarness({
      startBridge: false,
      clock,
      bridge: { undo: { agentDir: main }, stopDelay: stop.delay, inbound: { settleMs: 1000, maxSettleMs: 5000 } },
    })
    const hh = h
    const sent = await hh.app.sendMessage('general', 'waiting in the relay')
    hh.bridge.start()
    await hh.relay.expectFrame('ack', (x) => x.ref === sent.id && x.stage === 'delivered', { direction: 'from_bridge' })
    const stopping = hh.bridge.stop()
    clock.advance(10_000) // the settle timers fire now, in a stopping bridge
    await settled(hh)
    expectUntouched(hh, sent)
    stop.finish()
    await stopping
    const { b, notes } = await restart(hh, main)
    await expectDeliveredOnce(hh, b, notes, sent)
  })

  test("a control queued behind the held message doesn't run or answer in the stopping bridge; the restart answers it once", async () => {
    const clock = fakeClock(new Date().toISOString())
    const stop = slowStop()
    const { hh, main } = await setup({ clock, stopDelay: stop.delay })
    await hh.app.sendMessage('general', 'long job')
    await untilHeld(clock)
    const ctl = await hh.app.sendSessionControl('general', {
      action: 'compact',
      ts: new Date(clock.now()).toISOString(),
    })
    const stopping = hh.bridge.stop()
    clock.advance(UNDO_HOLD_MS + 1000)
    await settled(hh)
    expect(resultsFor(hh, ctl.control_id as string)).toHaveLength(0)
    expect(acksFor(hh, ctl.id as string, 'consumed')).toHaveLength(0)
    stop.finish()
    await stopping
    await restart(hh, main)
    await waitFor(
      () => resultsFor(hh, ctl.control_id as string).length === 1,
      8000,
      'the control result of the restart',
    )
    expect(resultsFor(hh, ctl.control_id as string)).toHaveLength(1)
  })

  test('a crash where stop never completes: the bridge that was killed mid-stop delivers nothing, ever, and the restart gets the message', async () => {
    // The stop never finishes (the process was killed). Whatever the old bridge still had running when the next one took the
    // socket must change nothing: the hold that is released late records no row and delivers nothing.
    const clock = fakeClock(new Date().toISOString())
    const stop = slowStop() // never finished until the test is over: the kill
    const { hh, main, gate } = await setup({ clock, stopDelay: stop.delay })
    const sent = await hh.app.sendMessage('general', 'survive a kill during stop')
    await untilHeld(clock)
    stopsBegun.push(hh.bridge.stop().catch(() => {})) // never finishes during the test: the process was killed
    const { b, notes } = await restart(hh, main) // takes the relay socket while the old one is still "stopping"
    await expectDeliveredOnce(hh, b, notes, sent)
    gate.release() // the zombie's snapshot finishes late
    clock.advance(UNDO_HOLD_MS + 1000)
    await hh.bridge.inbound?.idle()
    // the new bridge's one delivery is the only one: one consumed ack, one 'delivered' receipt, nothing in the old agent
    expect(acksFor(hh, sent.id, 'consumed')).toHaveLength(1)
    expect(receiptsFor(hh, sent.client_msg_id as string).filter((r) => r.raw.state === 'delivered')).toHaveLength(1)
    expect(hh.notes).toHaveLength(0)
    expect(notes.filter((x) => x.meta.message_id === sent.client_msg_id)).toHaveLength(1)
    expect(new UndoPoints(b.ctx.store.db).get(sent.client_msg_id as string)?.state).toBe('ready')
  })

  test('delivered and acked before stop began: the restart is not given it again', async () => {
    const { hh, main } = await setup({ hold: false })
    const sent = await hh.app.sendMessage('general', 'delivered before the stop')
    await hh.waitNotes(1)
    await waitFor(() => acksFor(hh, sent.id, 'consumed').length > 0, 4000, 'the consumed ack')
    await hh.bridge.stop()
    const before = hh.relay.rec.frames.length
    const { b, notes } = await restart(hh, main)
    await hh.relay.expectFrame('config.sync', () => true, { direction: 'from_bridge' })
    await waitFor(() => b.client?.connected === true, 10_000, 'the new bridge to be connected')
    await b.inbound?.idle()
    const replayed = hh.relay.rec.frames
      .slice(before)
      .filter((r) => r.direction === 'to_bridge' && r.raw.type === 'message' && r.raw.id === sent.id)
    expect(replayed).toHaveLength(0)
    // not given again. The agent never answered it, so the restart tells it so, once, in a system note (D39, posted after ready
    // without being awaited): wait for that note, then it is the only one
    await waitFor(() => notes.length > 0, 4000, 'the D39 note')
    expect(notes).toHaveLength(1)
    expect(notes[0]?.meta.kind).toBe('system')
    expect(notes[0]?.content).toStartWith('A message you sent may not have been answered')
    expect(hh.notes.filter((x) => x.meta.message_id === sent.client_msg_id)).toHaveLength(1)
  })

  test('a hand-over still unresolved when stop gives up waiting: its books are skipped cleanly, nothing is acked, and the restart gets it again (a duplicate, not a loss)', async () => {
    // The cap on stop's wait for hand-overs under way (1 s) can run out on a channel that answers slowly. The store is closed
    // then, and the write that returns afterwards must not throw (no error line, nothing half marked) or ack: the relay replays.
    const lines: string[] = []
    const { hh, main } = await setup({ hold: false, logger: createLogger(null, 'debug', (l) => lines.push(l)) })
    let finishWrite = () => {}
    const written = new Promise<void>((r) => {
      finishWrite = r
    })
    open.push(finishWrite)
    const started: string[] = []
    hh.bridge.setEmit(async (x) => {
      started.push(x.meta.message_id as string)
      await written
      hh.notes.push(x)
    })
    const sent = await hh.app.sendMessage('general', 'the channel answers after stop gave up')
    await waitFor(() => started.includes(sent.client_msg_id as string), 4000, 'the write to the agent to start')
    await hh.bridge.stop() // waits the cap, then closes the store with the write still open
    finishWrite()
    await hh.bridge.inbound?.idle()
    expect(hh.notes).toHaveLength(1) // the old agent has it
    expect(lines.filter((l) => JSON.parse(l).level === 'error')).toHaveLength(0)
    expect(acksFor(hh, sent.id, 'consumed')).toHaveLength(0)
    const next = await restart(hh, main)
    await waitFor(() => next.notes.some((x) => x.meta.message_id === sent.client_msg_id), 8000, 'the replay')
    expect(next.notes.filter((x) => x.meta.message_id === sent.client_msg_id)).toHaveLength(1)
  })

  test('handed to the agent but not finished when stop begins: it finishes its books first, so nobody gets it twice', async () => {
    // The agent's channel took the message (the write is slow to return) and stop began: marking it seen and acking it consumed
    // must happen before the store closes, or the relay replays a message the agent already has.
    const { hh, main } = await setup({ hold: false })
    const started: string[] = []
    let finishWrite = () => {}
    const written = new Promise<void>((r) => {
      finishWrite = r
    })
    open.push(finishWrite)
    hh.bridge.setEmit(async (x) => {
      started.push(x.meta.message_id as string)
      await written
      hh.notes.push(x)
    })
    const sent = await hh.app.sendMessage('general', 'being written when the bridge stops')
    await waitFor(() => started.includes(sent.client_msg_id as string), 4000, 'the write to the agent to start')
    let waitingForBooks: () => void = () => {}
    const asked = new Promise<void>((r) => {
      waitingForBooks = r
    })
    const ib = hh.bridge.inbound as { idle(): Promise<void> }
    const realIdle = ib.idle.bind(ib)
    ib.idle = () => {
      waitingForBooks()
      return realIdle()
    }
    const stopped = hh.bridge.stop()
    await Promise.race([asked, stopped]) // a stop that does not wait for the books ends here, with the write still open
    finishWrite()
    await stopped
    expect(hh.notes).toHaveLength(1)
    const before = hh.relay.rec.frames.length
    const { b, notes } = await restart(hh, main)
    expect(b.ctx.store.hasSeen(sent.client_msg_id as string)).toBe(true) // it was marked before the store closed
    await hh.relay.expectFrame('config.sync', () => true, { direction: 'from_bridge' })
    await waitFor(() => b.client?.connected === true, 10_000, 'the new bridge to be connected')
    await b.inbound?.idle()
    // not given again. The agent never answered it, so the restart tells it so, once, in a system note (D39, posted after ready
    // without being awaited): wait for that note, then it is the only one
    await waitFor(() => notes.length > 0, 4000, 'the D39 note')
    expect(notes).toHaveLength(1)
    expect(notes[0]?.meta.kind).toBe('system')
    expect(notes[0]?.content).toStartWith('A message you sent may not have been answered')
    expect(
      hh.relay.rec.frames.slice(before).filter((r) => r.direction === 'to_bridge' && r.raw.id === sent.id),
    ).toHaveLength(0)
  })

  test('stop does not wait out the hold: the lane that was waiting for a point is released at once', async () => {
    const clock = fakeClock(new Date().toISOString())
    const stop = slowStop()
    const { hh } = await setup({ clock, stopDelay: stop.delay })
    await hh.app.sendMessage('general', 'held')
    await untilHeld(clock)
    const stopping = hh.bridge.stop()
    // the clock does not move: only giving the hold up can free the lane (the stop itself is held open by the stall)
    const freed = await Promise.race([hh.bridge.inbound?.idle().then(() => true), sleep(1500).then(() => false)])
    expect(freed).toBe(true)
    stop.finish()
    await stopping
  })

  test('nothing reaches the agent once stop has begun, whoever asks (a hook, a schedule, a notice)', async () => {
    const stop = slowStop()
    const { hh } = await setup({ hold: false, stopDelay: stop.delay })
    const stopping = hh.bridge.stop()
    const note = systemNotification({
      thread: { id: 'general', name: 'General' } as never,
      text: 'a notice from something that is not an owner message',
      ts: new Date().toISOString(),
      id: 'late-notice',
    })
    await expect(hh.bridge.ctx.emit(note)).rejects.toThrow('stopping')
    expect(hh.notes).toHaveLength(0)
    stop.finish()
    await stopping
  })

  test('a message waiting for a restore of its folder when stop begins is not handed over when the restore ends', async () => {
    const stop = slowStop()
    const { hh, main } = await setup({ hold: false, stopDelay: stop.delay })
    const undo = hh.bridge.ctx.undo
    if (!undo) throw new Error('no undo seam')
    let reached = () => {}
    const waiting = new Promise<void>((r) => {
      reached = r
    })
    const realWait = undo.restoring.waitFor.bind(undo.restoring)
    undo.restoring.waitFor = (folder) => {
      reached()
      return realWait(folder)
    }
    let endRestore = () => {}
    const restore = new Promise<void>((r) => {
      endRestore = r
    })
    open.push(endRestore)
    const restoring = undo.restoring.hold(main, () => restore)
    const sent = await hh.app.sendMessage('general', 'waits for a restore')
    await waiting
    const stopping = hh.bridge.stop()
    endRestore()
    await restoring
    await settled(hh)
    expectUntouched(hh, sent)
    stop.finish()
    await stopping
    const next = await restart(hh, main)
    await expectDeliveredOnce(hh, next.b, next.notes, sent)
  })

  test("a route to a thread's session waiting for a restore when stop begins is not written when the restore ends; the restart routes it once", async () => {
    // This hand-over is a route row and a wake file, not a write to the agent's channel: the restore wait is what refuses it.
    const stop = slowStop()
    const { hh, main, worker } = await setup({ hold: false, stopDelay: stop.delay })
    const undo = hh.bridge.ctx.undo
    if (!undo) throw new Error('no undo seam')
    let reached = () => {}
    const waiting = new Promise<void>((r) => {
      reached = r
    })
    const realWait = undo.restoring.waitFor.bind(undo.restoring)
    undo.restoring.waitFor = (folder) => {
      reached()
      return realWait(folder)
    }
    let endRestore = () => {}
    const restore = new Promise<void>((r) => {
      endRestore = r
    })
    open.push(endRestore)
    const restoring = undo.restoring.hold(worker, () => restore)
    const sent = await hh.app.sendMessage('trip', 'for the thread session, behind a restore')
    await waiting
    const stopping = hh.bridge.stop()
    endRestore()
    await restoring
    await settled(hh)
    expect(hh.bridge.router?.store.unclaimed('trip')).toHaveLength(0)
    expect(acksFor(hh, sent.id, 'consumed')).toHaveLength(0)
    stop.finish()
    await stopping
    const next = await restart(hh, main)
    await waitFor(() => (next.b.router?.store.unclaimed('trip').length ?? 0) === 1, 8000, 'the route of the restart')
    await waitFor(() => acksFor(hh, sent.id, 'consumed').length === 1, 4000, 'the consumed ack of the restart')
    expect(next.b.router?.store.unclaimed('trip')).toHaveLength(1)
  })

  test("a thread session's own bridge (the process of a session being parked) hands nothing to its agent once it has begun to stop", async () => {
    // Parking a thread's session ends its process; the bridge in it (worker mode, no relay socket of its own) is stopped by
    // the same stop(). Whatever is still being written for its agent then is refused, and what was routed to the thread and
    // not read stays in main's route table for the deadline fallback (the route test below).
    const { hh } = await setup({ hold: false })
    const worker = await startWorkerBridge(hh)
    const wrote: Notification[] = []
    worker.setEmit(async (x) => {
      wrote.push(x)
    })
    const note = (id: string) =>
      systemNotification({
        thread: { id: 'trip', name: 'Trip' } as never,
        text: 'a note',
        ts: new Date().toISOString(),
        id,
      })
    await worker.ctx.emit(note('before-stop'))
    expect(wrote).toHaveLength(1) // the same call is written while the bridge runs
    void worker.stop()
    await expect(worker.ctx.emit(note('after-stop'))).rejects.toThrow('stopping')
    expect(wrote).toHaveLength(1)
  })

  test('a claim for a fallback is not taken once stop has begun (a poll tick that was mid-await would leak it past close())', async () => {
    const stop = slowStop()
    const { hh } = await setup({ hold: false, stopDelay: stop.delay })
    const router = hh.bridge.router as unknown as { claimForMain(id: string): boolean }
    expect(router.claimForMain('m_before')).toBe(true) // the same call takes the claim while the bridge runs
    const stopping = hh.bridge.stop()
    expect(hh.bridge.router?.store.claimedBy('m_before')).toBeUndefined() // close() gave it back
    expect(router.claimForMain('m_after')).toBe(false)
    expect(hh.bridge.router?.store.claimedBy('m_after')).toBeUndefined()
    stop.finish()
    await stopping
  })

  test('a session being parked reads nothing: read_inbound after stop began claims no message, so the route stays for main or the next session', async () => {
    const { hh } = await setup({ hold: false })
    const sent = await hh.app.sendMessage('trip', 'routed to the session that is being parked')
    const id = sent.client_msg_id as string
    await waitFor(() => (hh.bridge.router?.store.unclaimed('trip').length ?? 0) === 1, 4000, 'the route')
    const worker = await startWorkerBridge(hh)
    const stopping = worker.stop()
    const r = JSON.parse((await worker.callTool('read_inbound', {})).content[0]?.text ?? '{}')
    expect(r.messages).toEqual([])
    expect(hh.bridge.router?.store.claimedBy(id)).toBeUndefined()
    expect(hh.bridge.router?.store.unclaimed('trip')).toHaveLength(1)
    await stopping
  })

  test('stop waits for a read_inbound result that is still on its way to the agent, so the claim is not stranded by a park', async () => {
    // server.ts tells the bridge when a read_inbound response is handed to the transport (resultPending / resultWritten). A
    // stop that began in between waits for that write, within a cap, before the session's process goes.
    const { hh } = await setup({ hold: false })
    const sent = await hh.app.sendMessage('trip', 'read, but the answer is still being written')
    await waitFor(() => (hh.bridge.router?.store.unclaimed('trip').length ?? 0) === 1, 4000, 'the route')
    const worker = await startWorkerBridge(hh)
    worker.resultPending('req-1')
    const r = JSON.parse((await worker.callTool('read_inbound', {})).content[0]?.text ?? '{}')
    expect(r.messages).toHaveLength(1) // claimed
    expect(hh.bridge.router?.store.claimedBy(sent.client_msg_id as string)).toBe('worker:trip')
    const stopping = worker.stop().then(() => 'stopped')
    expect(await Promise.race([stopping, sleep(300).then(() => 'waiting')])).toBe('waiting')
    worker.resultWritten('req-1')
    expect(await stopping).toBe('stopped')
  })

  test('a read_inbound result that never lands does not hold stop beyond its cap', async () => {
    const { hh } = await setup({ hold: false })
    const worker = await startWorkerBridge(hh)
    worker.resultPending('req-never')
    const t0 = Date.now()
    await worker.stop()
    expect(Date.now() - t0).toBeLessThan(3500) // under the 4 s force-exit in lifecycle.ts
  })

  test("a Run tap held for main's point when stop begins is not spent: it is unmarked, and the restart runs it once", async () => {
    // A Run is marked seen BEFORE the agent is told (so a replay never runs a script twice). A refused hand-over told nobody
    // and ran nothing, so the mark must go back, or the relay's replay would be consumed as "already handled".
    const clock = fakeClock(new Date().toISOString())
    const stop = slowStop()
    const { hh, main } = await setup({ clock, stopDelay: stop.delay })
    const tap = await hh.app.buildMessage('general', runText('echo hello\n', 'sh') as string, {
      intent: 'run',
      run_block: { message_id: newId('m'), index: 0 },
    })
    hh.app.send(tap)
    await untilHeld(clock)
    expect(hh.bridge.ctx.store.hasSeen(tap.client_msg_id as string)).toBe(true) // marked before the hand-over, as designed
    const stopping = hh.bridge.stop()
    clock.advance(UNDO_HOLD_MS + 1000)
    await settled(hh)
    expectUntouched(hh, tap)
    expect(hh.bridge.ctx.store.hasSeen(tap.id as string)).toBe(false)
    stop.finish()
    await stopping
    const next = await restart(hh, main)
    await expectDeliveredOnce(hh, next.b, next.notes, tap)
    expect(next.notes.find((x) => x.meta.message_id === tap.client_msg_id)?.meta).toMatchObject({ run: 'tap' })
  })

  test("a message the router falls back to main, caught by stop while it waits for main's point, gives its claim back: the restart routes it to the worker once", async () => {
    // A message with no route row is claimed for main only AFTER main has it (nothing can claim it meanwhile: a worker reads route
    // rows only). A claim that stood from before the emit, with no route row behind it, would make the restart's route
    // unreadable by the worker and consumed all the same.
    const clock = fakeClock(new Date().toISOString())
    const stop = slowStop()
    const { hh, main, worker } = await setup({ clock, stopDelay: stop.delay })
    writeWorkers(hh.home, clock.now(), worker, 'stopping') // not reachable: the message falls back to main
    const sent = await hh.app.sendMessage('trip', 'for a session that is going down')
    const id = sent.client_msg_id as string
    await untilHeld(clock)
    expect(hh.bridge.router?.store.claimedBy(id)).toBeUndefined() // not claimed before main has it
    const stopping = hh.bridge.stop()
    clock.advance(UNDO_HOLD_MS + 1000)
    await settled(hh)
    expectUntouched(hh, sent)
    stop.finish()
    await stopping
    writeWorkers(hh.home, Date.now(), worker, 'live') // the session is back when the restart replays it
    const next = await restart(hh, main)
    await waitFor(() => (next.b.router?.store.unclaimed('trip').length ?? 0) === 1, 8000, 'the route of the restart')
    await waitFor(() => acksFor(hh, sent.id, 'consumed').length === 1, 4000, 'the consumed ack of the restart')
    expect(next.notes).toHaveLength(0)
    expect(hh.notes).toHaveLength(0)
  })

  test("park: a route whose fallback was waiting for main's point when main stopped is given back, and the restart falls back to main once", async () => {
    // A message routed to a thread session that was then parked is claimed by main at the route's deadline and handed to main
    // after main's undo point. Stop began in that wait: the claim had been taken, the hand-over refused. The claim goes back,
    // or `resume` would never fall the message back (it only re-arms unclaimed routes) and the owner would be left with silence.
    const clock = fakeClock(new Date().toISOString())
    const stop = slowStop()
    const { hh, main, worker } = await setup({ clock, stopDelay: stop.delay })
    const sent = await hh.app.sendMessage('trip', 'for a session that parks')
    const id = sent.client_msg_id as string
    const start = Date.now()
    while ((hh.bridge.router?.store.unclaimed('trip').length ?? 0) === 0) {
      if (Date.now() - start > 4000) throw new Error('not routed')
      clock.advance(10)
      await sleep(20)
    }
    writeWorkers(hh.home, clock.now(), worker, 'parked') // the supervisor parked the session before it read anything
    await advanceSteps(clock, CLAIM_DEADLINE_MS + 1_000, 10_000)
    await waitFor(() => gates.length === 1, 4000, "main's point for the fallback to be held")
    expect(hh.bridge.router?.store.claimedBy(id)).toBe('main')
    const stopping = hh.bridge.stop()
    expect(hh.bridge.router?.store.claimedBy(id)).toBeUndefined() // given back before stop() first yields
    clock.advance(UNDO_HOLD_MS + 1000)
    await settled(hh)
    expect(hh.notes).toHaveLength(0)
    expect(hh.bridge.router?.store.claimedBy(id)).toBeUndefined()
    stop.finish()
    await stopping
    const { b, notes } = await restart(hh, main, clock)
    const t0 = Date.now()
    while (!notes.some((x) => x.meta.message_id === id)) {
      if (Date.now() - t0 > 20_000) throw new Error('the restart never fell the message back')
      clock.advance(50) // the re-armed deadline is a timer on this clock
      await sleep(20)
    }
    await b.inbound?.idle()
    expect(notes.filter((x) => x.meta.message_id === id)).toHaveLength(1)
    expect(notes.find((x) => x.meta.message_id === id)?.meta).toMatchObject({ routed: 'fallback' })
    expect(b.router?.store.claimedBy(id)).toBe('main')
    expect(hh.notes).toHaveLength(0)
  })
})
