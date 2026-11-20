// Undo points through the real bridge: an owner message's point is taken of the folder its turn runs in and is recorded
// BEFORE the message is handed over. The wait happens on that session's lane, so other sessions go on, while a control
// for the same session keeps its place behind the message. Replays keep their guarantees: a crash mid-wait replays, a
// replay during the wait is skipped and nothing is lost. Real bridge, FakeRelay, FakeApp, real git.
import { afterEach, describe, expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  CLAIM_DEADLINE_MS,
  createPhoneKeys,
  nativeReplyMessageId,
  newId,
  newUlid,
  signNativeAct,
  signNativeGrant,
} from '@talos-app/protocol'
import { fakeClock } from '@talos-app/testkit'
import { Bridge } from '../src/bridge.ts'
import { loadEnv } from '../src/config.ts'
import { nullLogger } from '../src/log.ts'
import type { Notification } from '../src/notify.ts'
import { UndoPoints } from '../src/undo/points.ts'
import { type Snapshot, type SnapshotOpts, snapshotFolder } from '../src/undo/snapshot.ts'
import { advanceSteps, type Harness, sleep, startHarness, waitFor } from './helpers.ts'

let h: Harness | undefined
let b2: Bridge | undefined
const gates: Array<() => void> = []
afterEach(async () => {
  for (const g of gates.splice(0)) g()
  await b2?.stop()
  b2 = undefined
  await h?.stop()
  h = undefined
})

const scratch = mkdtempSync(join(tmpdir(), 'talos-undo-delivery-'))
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

/** Snapshots of `held` wait until the test releases them; any other folder's run straight through. */
function holding(held: string) {
  const started: string[] = []
  const snapshot = async (o: SnapshotOpts): Promise<Snapshot> => {
    started.push(o.turn)
    const s = await snapshotFolder(o)
    if (realpathSync(o.folder) === held) await new Promise<void>((res) => gates.push(res))
    return s
  }
  return { snapshot, started, release: () => gates.shift()?.() }
}

async function setup(o: { clock?: ReturnType<typeof fakeClock>; hold?: boolean } = {}) {
  const main = repo('main')
  const worker = repo('worker')
  const gate = holding(o.hold === false ? '/nowhere' : main)
  const home = mkdtempSync(join(tmpdir(), 'talos-undo-home-'))
  writeWorkers(home, o.clock?.now() ?? Date.now(), worker)
  h = await startHarness({
    home,
    ...(o.clock ? { clock: o.clock } : {}),
    bridge: { undo: { agentDir: main, snapshot: gate.snapshot } },
    config: ((c: Record<string, unknown> & { threads: unknown[] }) => ({
      ...c,
      threads: [...c.threads, thread('trip', 'Trip', { session: 'dedicated' })],
      dedicated: { enabled: true },
    })) as never,
  })
  const points = new UndoPoints(h.bridge.ctx.store.db)
  return { hh: h, main, worker, gate, points }
}

const routedToTrip = (hh: Harness) => (hh.bridge.router?.store.unclaimed('trip').length ?? 0) > 0
const resultsFor = (hh: Harness, id: string) =>
  hh.relay.rec.frames.filter(
    (r) => r.direction === 'from_bridge' && r.raw.type === 'session.control.result' && r.raw.control_id === id,
  )

describe('undo points before delivery', () => {
  test("main's message: the point of main's folder is recorded before main is told", async () => {
    const { hh, main, gate, points } = await setup()
    const sent = await hh.app.sendMessage('general', 'tidy the notes')
    await waitFor(() => gates.length === 1, 4000, 'the snapshot to be held')
    await sleep(50)
    expect(hh.notes).toHaveLength(0)
    gate.release()
    await hh.waitNotes(1)
    const row = points.get(sent.client_msg_id as string)
    expect(row).toMatchObject({ state: 'ready', kind: 'git', root: main, thread_id: 'general' })
    expect(git(main, 'rev-parse', '-q', '--verify', row?.ref ?? '').status).toBe(0)
  })

  test("a thread worker's message: the point is of the worker's folder, and it does not wait for main's", async () => {
    const { hh, worker, gate, points } = await setup()
    await hh.app.sendMessage('general', 'held one')
    await waitFor(() => gates.length === 1, 4000, 'the snapshot to be held')
    const trip = await hh.app.sendMessage('trip', 'book it')
    await waitFor(() => routedToTrip(hh), 4000, 'the trip message to be routed while main waits')
    expect(points.get(trip.client_msg_id as string)).toMatchObject({ state: 'ready', root: worker })
    expect(hh.notes).toHaveLength(0)
    gate.release()
    await hh.waitNotes(1)
  })

  test('a control sent after a message waits for that message, while other sessions go on', async () => {
    const { hh, gate } = await setup()
    await hh.app.sendMessage('general', 'long job')
    await waitFor(() => gates.length === 1, 4000, 'the snapshot to be held')
    const ctl = await hh.app.sendSessionControl('general', { action: 'compact', ts: new Date().toISOString() })
    await hh.app.sendMessage('trip', 'unrelated')
    await waitFor(() => routedToTrip(hh), 4000, 'the queue to move past the control')
    expect(resultsFor(hh, ctl.control_id as string)).toHaveLength(0)
    gate.release()
    await hh.waitNotes(1)
    await waitFor(() => resultsFor(hh, ctl.control_id as string).length === 1, 4000, 'the control result')
  })

  test('a replay while the message waits is skipped, and the message is delivered once', async () => {
    const { hh, gate } = await setup()
    const sent = await hh.app.sendMessage('general', 'once only')
    await waitFor(() => gates.length === 1, 4000, 'the snapshot to be held')
    hh.relay.sendToBridge(sent)
    await hh.app.sendMessage('trip', 'marker')
    await waitFor(() => routedToTrip(hh), 4000, 'the queue to move past the replay')
    gate.release()
    await hh.waitNotes(1)
    await hh.bridge.inbound?.idle()
    expect(hh.notes.filter((x) => x.meta.message_id === sent.client_msg_id)).toHaveLength(1)
    await waitFor(
      () =>
        hh.relay.rec.frames.some(
          (r) =>
            r.direction === 'from_bridge' &&
            r.raw.type === 'ack' &&
            r.raw.ref === sent.id &&
            r.raw.stage === 'consumed',
        ),
      4000,
      'the consumed ack',
    )
  })

  test('a bridge that stops while the message waits gets it again on restart', async () => {
    const { hh, main } = await setup()
    const sent = await hh.app.sendMessage('general', 'survive a crash')
    await waitFor(() => gates.length === 1, 4000, 'the snapshot to be held')
    expect(hh.bridge.ctx.store.hasSeen(sent.client_msg_id as string)).toBe(false)
    await hh.bridge.stop()
    Bun.gc(true)
    const notes: Notification[] = []
    b2 = await Bridge.create({
      env: loadEnv({ TALOS_APP_HOME: hh.home, TALOS_APP_RELAY_URL: hh.relay.httpUrl, TALOS_APP_BRIDGE: '1' }),
      logger: nullLogger,
      inbound: { settleMs: 20, maxSettleMs: 200 },
      undo: { agentDir: main },
    })
    b2.setEmit(async (x) => {
      notes.push(x)
    })
    b2.start()
    await waitFor(() => notes.some((x) => x.meta.message_id === sent.client_msg_id), 8000, 'the replayed message')
    expect(new UndoPoints(b2.ctx.store.db).get(sent.client_msg_id as string)?.state).toBe('ready')
  })

  test('a worker that never claims: main takes it, and the point is of the folder main runs in', async () => {
    const clock = fakeClock(new Date().toISOString())
    const { hh, main, worker, points } = await setup({ clock, hold: false })
    const sent = await hh.app.sendMessage('trip', 'nobody home')
    const id = sent.client_msg_id as string
    const start = Date.now()
    while (!routedToTrip(hh)) {
      if (Date.now() - start > 4000) throw new Error('not routed')
      clock.advance(50)
      await sleep(20)
    }
    expect(points.get(id)?.root).toBe(worker)
    const workerRef = points.get(id)?.ref ?? ''
    await advanceSteps(clock, CLAIM_DEADLINE_MS + 1_000, 10_000)
    await hh.waitNotes(1)
    expect(hh.notes[0]?.meta).toMatchObject({ routed: 'fallback', message_id: id })
    expect(points.get(id)).toMatchObject({ state: 'ready', root: main })
    // the worker's point goes right after the new one is recorded, while delivery goes ahead
    await waitFor(() => git(worker, 'rev-parse', '-q', '--verify', workerRef).status !== 0, 4000, "the worker's point")
  })

  test('a card answer sent after a message waits for it; a config change waits for every session', async () => {
    const { hh, gate } = await setup()
    const res = await hh.bridge.callTool('card', {
      thread_id: 'general',
      kind: 'message',
      title: 'Send the update',
      primary_label: 'Send',
      kill_label: 'Kill draft',
      risk: 'low',
      origin: 'chat',
      destination: [{ label: 'To', value: 'alex@example.com' }],
      body: 'Draft body',
    })
    const id = /card (c_[0-9A-HJKMNP-TV-Z]{26})/.exec(res.content[0]?.text ?? '')?.[1] as string
    const card = (await hh.relay.expectFrame('card.create', (f) => f.card.id === id, { direction: 'from_bridge' })).card
    await hh.app.sendMessage('general', 'held one')
    await waitFor(() => gates.length === 1, 4000, 'the snapshot to be held')
    await hh.app.resolveCard(card, 'kill', card.payload_hash)
    await hh.app.sendMessage('trip', 'marker')
    await waitFor(() => routedToTrip(hh), 4000, 'the queue to move past the card answer')
    expect(hh.bridge.ctx.ledger.get(card.id)?.state).toBe('pending')
    const rev = hh.bridge.ctx.config.config.rev
    await hh.app.sendConfigPatch(rev, { agent: { name: 'Atlas' } })
    await sleep(200)
    expect(hh.bridge.ctx.config.config.agent.name).not.toBe('Atlas')
    gate.release()
    await hh.waitNotes(1)
    await waitFor(() => hh.bridge.ctx.ledger.get(card.id)?.state !== 'pending', 4000, 'the card answer')
    await waitFor(() => hh.bridge.ctx.config.config.agent.name === 'Atlas', 4000, 'the config change')
  })

  test("a backlog: one point of main's folder for every message in it, recorded before main is told", async () => {
    const clock = fakeClock(new Date().toISOString())
    const main = repo('main')
    const gate = holding(main)
    h = await startHarness({ startBridge: false, clock, bridge: { undo: { agentDir: main, snapshot: gate.snapshot } } })
    const hh = h
    const old = new Date(clock.now() - 20 * 60_000).toISOString()
    const a = await hh.app.buildMessage('general', 'first while away')
    const b = await hh.app.buildMessage('inbox', 'second while away')
    hh.relay.sendToBridge({ ...a, relay: { seq: 1, received_at: old } })
    hh.relay.sendToBridge({ ...b, relay: { seq: 2, received_at: old } })
    hh.bridge.start()
    for (const f of [a, b])
      await hh.relay.expectFrame('ack', (x) => x.ref === f.id && x.stage === 'delivered', { direction: 'from_bridge' })
    // past the replay's settle window once; then real time only, so the 5 s hold (on this clock) cannot run out first
    clock.advance(1000)
    await waitFor(() => gates.length > 0, 8000, 'the backlog point to start')
    expect(hh.notes).toHaveLength(0)
    gate.release()
    await hh.waitNotes(1)
    expect(hh.notes[0]?.meta.kind).toBe('backlog')
    const points = new UndoPoints(hh.bridge.ctx.store.db)
    const ra = points.get(a.client_msg_id as string)
    const rb = points.get(b.client_msg_id as string)
    expect(ra).toMatchObject({ state: 'ready', root: main, thread_id: 'general' })
    expect(rb).toMatchObject({ state: 'ready', root: main, thread_id: 'inbox' })
    expect(ra?.ref).toBe(rb?.ref as string)
  })

  test('a Reply from a notification waits for its point on its lane, not on the queue', async () => {
    const { hh, gate, main, points } = await setup()
    const dev = hh.app.device
    const keys = await createPhoneKeys()
    const now = Date.now()
    const grant = await signNativeGrant({
      deviceId: dev.deviceId,
      devicePrivateKey: dev.privateKey,
      encPub: keys.encPub,
      actPub: keys.actPub,
      nowMs: now,
    })
    const tap = await signNativeAct({
      deviceId: dev.deviceId,
      id: newUlid(),
      ts: new Date(now).toISOString(),
      grant,
      body: { a: 'reply', thread_id: 'general', text: 'on my way' },
      actPrivateKey: keys.act.privateKey,
    })
    hh.relay.sendToBridge({ ...tap, relay: { seq: 1, received_at: new Date(now).toISOString() } }, { durable: true })
    await waitFor(() => gates.length === 1, 4000, 'the reply point to be held')
    await hh.app.sendMessage('trip', 'marker')
    await waitFor(() => routedToTrip(hh), 4000, 'the queue to move past the reply')
    expect(hh.notes).toHaveLength(0)
    gate.release()
    await hh.waitNotes(1)
    expect(points.get(nativeReplyMessageId(tap.id))).toMatchObject({ state: 'ready', root: main })
  })

  test('the last owner time never goes back when an older message is delivered after a newer one', async () => {
    const { hh, gate } = await setup()
    await hh.app.sendMessage('general', 'older', { ts: new Date(Date.now() - 1000).toISOString() })
    await waitFor(() => gates.length === 1, 4000, 'the snapshot to be held')
    const newer = await hh.app.sendMessage('trip', 'newer')
    await waitFor(() => hh.bridge.ctx.store.kvGet('last_owner_ts') === newer.ts, 4000, 'the newer time')
    gate.release()
    await hh.waitNotes(1)
    await hh.bridge.inbound?.idle()
    expect(hh.bridge.ctx.store.kvGet('last_owner_ts')).toBe(newer.ts as string)
  })

  test("a control typed in a thread worker's thread still waits behind main's message (controls act on main)", async () => {
    const { hh, gate } = await setup()
    await hh.app.sendMessage('general', 'held one')
    await waitFor(() => gates.length === 1, 4000, 'the snapshot to be held')
    const ctl = await hh.app.sendSessionControl('trip', { action: 'compact', ts: new Date().toISOString() })
    await sleep(300)
    expect(resultsFor(hh, ctl.control_id as string)).toHaveLength(0)
    gate.release()
    await waitFor(() => resultsFor(hh, ctl.control_id as string).length === 1, 4000, 'the control result')
  })

  test("a thread worker's message that falls back to main keeps its place ahead of an event sent after it", async () => {
    const { hh, gate } = await setup()
    writeWorkers(hh.home, Date.now(), realpathSync(hh.home), 'stopping') // the worker cannot take it: main will
    await hh.app.sendMessage('trip', 'for the worker, answered by main')
    await waitFor(() => gates.length === 1, 4000, "main's point to be held")
    hh.relay.sendToBridge({
      type: 'hook.event',
      delivery: 'live',
      event: {
        id: newId('e'),
        source: 'github',
        connection: 'cn_8fK2aBcDeFgHiJkLmNoPqR',
        kind: 'github.review_requested',
        title: 'Review requested',
        summary: 'sent after the message',
        actor: { name: 'octocat' },
        ts: new Date().toISOString(),
        thread: 'inbox',
        work: false,
        priority: 'high',
        dedup_key: 'github:behind',
      },
    })
    await sleep(300)
    expect(hh.notes).toHaveLength(0)
    gate.release()
    await hh.waitNotes(2)
    expect(hh.notes.map((n) => n.meta.kind)).toEqual(['text', 'hook_event'])
  })

  test('a restore that starts while the point is being taken: the message waits for it before main is told', async () => {
    const { hh, main, gate } = await setup()
    await hh.app.sendMessage('general', 'caught between point and restore')
    await waitFor(() => gates.length === 1, 4000, 'the snapshot to be held')
    let open = () => {}
    const restore = new Promise<void>((r) => {
      open = r
    })
    const undo = hh.bridge.ctx.undo
    if (!undo) throw new Error('no undo seam')
    const held = undo.restoring.hold(main, () => restore)
    gate.release()
    await sleep(300)
    expect(hh.notes).toHaveLength(0)
    open()
    await held
    await hh.waitNotes(1)
  })

  test('no agent folder known: the message is delivered at once and its row says not_saved', async () => {
    const home = mkdtempSync(join(tmpdir(), 'talos-undo-home-'))
    h = await startHarness({ home, bridge: { undo: { agentDir: undefined } } })
    const sent = await h.app.sendMessage('general', 'no folder')
    await h.waitNotes(1)
    const pts = new UndoPoints(h.bridge.ctx.store.db)
    await waitFor(() => pts.get(sent.client_msg_id as string) !== undefined, 4000, 'the row')
    expect(pts.get(sent.client_msg_id as string)?.state).toBe('not_saved')
    expect(existsSync(join(home, 'undo'))).toBe(false)
  })
})
