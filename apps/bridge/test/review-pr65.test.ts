// Adversarial review of PR #65 (Option C WP-OC1 + WP-OC2). Each test asserts the CORRECT behaviour. The ones marked
// FINDING fail on the PR head (e03d30a); the rest document what holds. Real bridges (one live = the hub, one in worker
// mode) over the FakeRelay, a fake Bot API, the real hub socket and a workers.json written the way the supervisor writes it.
import { afterEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createConnection } from 'node:net'
import { join } from 'node:path'
import { CLAIM_DEADLINE_MS, DedicatedConfig, newUlid, THREAD_SESSIONS_FEATURE, WakeFile } from '@talos-app/protocol'
import { fakeClock, mkFrame } from '@talos-app/testkit'
import { Bridge } from '../src/bridge.ts'
import { loadEnv } from '../src/config.ts'
import { cardCreateFrame, cardUpdateFrame } from '../src/frames-out.ts'
import { HubClient } from '../src/hub/client.ts'
import { pgidOf } from '../src/hub/server.ts'
import { nullLogger } from '../src/log.ts'
import type { Notification } from '../src/notify.ts'
import { allowsStart, governor } from '../src/router/governor.ts'
import { advanceSteps, type Harness, sleep, startHarness, waitFor } from './helpers.ts'

const NONCE = 'test-nonce-0123456789abcdef'
let h: Harness | undefined
let worker: Bridge | undefined
let extra: Bridge | undefined
let clients: HubClient[] = []
afterEach(async () => {
  for (const c of clients) c.close()
  clients = []
  await worker?.stop()
  worker = undefined
  await extra?.stop().catch(() => {})
  extra = undefined
  await h?.stop()
  h = undefined
})

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

type Entry = { state: string; pane_pid?: number }
function writeWorkers(home: string, now: number, threads: Record<string, Entry>) {
  const t: Record<string, unknown> = {}
  for (const [id, e] of Object.entries(threads))
    t[id] = {
      state: e.state,
      session_id: '6f1c2a9e-4b3d-4c8e-9a71-2d5e8f0b3c41',
      tmux: `t-${id}`,
      pane_pid: e.pane_pid ?? 0,
      cwd: home,
      error: null,
    }
  writeFileSync(
    join(home, 'workers.json'),
    JSON.stringify({
      v: 1,
      supervisor: { pid: 1, heartbeat_at: new Date(now).toISOString(), workers_supported: true },
      threads: t,
    }),
  )
}
function writeNonce(home: string, id: string) {
  mkdirSync(join(home, 'workers', id), { recursive: true })
  writeFileSync(join(home, 'workers', id, 'nonce'), NONCE)
}
const myPgid = () => pgidOf(process.pid) as number

async function waitTicking(clock: ReturnType<typeof fakeClock>, cond: () => boolean, ms = 4000) {
  const start = Date.now()
  while (!cond()) {
    if (Date.now() - start > ms) throw new Error('timed out waiting for condition')
    clock.advance(50)
    await sleep(20)
  }
}

const dedicatedConfig = (c: Record<string, unknown> & { threads: unknown[] }) => ({
  ...c,
  threads: [
    ...c.threads,
    thread('trip', 'Trip', { session: 'dedicated' }),
    thread('garden', 'Garden', { session: 'dedicated' }),
    thread('shared_one', 'Shared'),
  ],
  dedicated: { enabled: true },
})

async function hub(opts: { clock?: ReturnType<typeof fakeClock>; home?: string; trust?: boolean } = {}) {
  h = await startHarness({
    ...(opts.clock ? { clock: opts.clock } : {}),
    ...(opts.home ? { home: opts.home } : {}),
    config: (opts.trust ? (c: never) => ({ ...dedicatedConfig(c), trust_mode: true }) : dedicatedConfig) as never,
  })
  await waitFor(() => existsSync(join(h?.home as string, 'hub.sock')))
  return h
}

async function startWorker(home: string, relayUrl: string, connect = true) {
  worker = await Bridge.create({
    env: loadEnv({
      TALOS_APP_HOME: home,
      TALOS_APP_RELAY_URL: relayUrl,
      TALOS_APP_WORKER_THREAD: 'trip',
      TALOS_APP_WORKER_NONCE: NONCE,
    }),
    logger: nullLogger,
  })
  if (connect) {
    const ok = await worker.startWorker()
    expect(ok, `the worker was refused: ${JSON.stringify(worker.hubClient?.lastRefusal)}`).toBe(true)
  }
  return worker
}

/** The real worker-side hub client, used the way any process in the pane group with the nonce could use it. */
async function rawClient(home: string, threadId = 'trip') {
  const c = new HubClient({
    sockPath: join(home, 'hub.sock'),
    threadId,
    nonce: NONCE,
    log: nullLogger,
    reconnectMs: 60_000,
  })
  clients.push(c)
  return { c, ok: await c.connect() }
}

const CARD_ARGS = {
  kind: 'decision',
  title: 'Pay the invoice',
  primary_label: 'Pay',
  kill_label: 'Kill it',
  risk: 'low',
  origin: 'chat',
  destination: [],
}
/** Main (the live bridge) raises a card in `threadId`; returns the card as the relay saw it. */
async function mainCard(hh: Harness, threadId: string, args: Record<string, unknown> = {}) {
  const r = await hh.bridge.callTool('card', { thread_id: threadId, ...CARD_ARGS, ...args })
  expect(r.isError, r.content[0]?.text).toBeFalsy()
  const id = /card (c_[0-9A-Z]+)/.exec(r.content[0]?.text ?? '')?.[1] as string
  const f = await hh.relay.expectFrame('card.create', (x) => x.card.id === id, { direction: 'from_bridge' })
  return f.card
}

const json = (r: { content: Array<{ text?: string }> }) => JSON.parse(r.content[0]?.text ?? '{}')

// ---------------------------------------------------------------------------------------------------------------------
// 1. Card routing and card ownership
// ---------------------------------------------------------------------------------------------------------------------

describe('PR65 review: card routing is exact', () => {
  test("FINDING: a worker cannot take over main's card in another thread by re-using its id in a card.create", async () => {
    const hh = await hub()
    writeWorkers(hh.home, Date.now(), { trip: { state: 'live', pane_pid: myPgid() } })
    writeNonce(hh.home, 'trip')
    const card = await mainCard(hh, 'general')
    const { c, ok } = await rawClient(hh.home)
    expect(ok).toBe(true)
    // the worker re-announces main's card id as a card in its own thread
    await c.out(cardCreateFrame(Date.now(), { ...card, thread_id: 'trip' }))
    // the owner approves main's card in `general`: main must hear it, never trip's worker
    await hh.app.resolveCard(card, 'kill', card.payload_hash)
    await sleep(400)
    expect(existsSync(join(hh.home, 'workers', 'trip', 'wake'))).toBe(false)
    expect(hh.notes.filter((n) => n.meta.kind === 'card_action' && n.meta.card_id === card.id)).toHaveLength(1)
  })

  test("FINDING: a worker cannot card.update main's card in its own thread over the hub", async () => {
    const hh = await hub()
    writeWorkers(hh.home, Date.now(), { trip: { state: 'live', pane_pid: myPgid() } })
    writeNonce(hh.home, 'trip')
    const card = await mainCard(hh, 'trip')
    const { c, ok } = await rawClient(hh.home)
    expect(ok).toBe(true)
    const ack = await c.out(
      cardUpdateFrame(Date.now(), { card_id: card.id, state: 'superseded', reason: 'superseded' }),
    )
    expect(ack.state).toBe('refused')
  })

  test("FINDING: a worker's card_result is refused for a card main raised in the worker's thread", async () => {
    const hh = await hub()
    writeWorkers(hh.home, Date.now(), { trip: { state: 'live', pane_pid: myPgid() } })
    writeNonce(hh.home, 'trip')
    const card = await mainCard(hh, 'trip')
    await hh.app.resolveCard(card, 'primary', card.payload_hash)
    await hh.waitNotes(1)
    expect(hh.notes[0]?.meta).toMatchObject({ kind: 'card_action', card_id: card.id }) // main got it, as it should
    const w = await startWorker(hh.home, hh.relay.httpUrl)
    const r = await w.callTool('card_result', { card_id: card.id, ok: true, text: 'paid' })
    expect(r.isError).toBe(true)
    expect(hh.bridge.ctx.ledger.get(card.id)?.state).toBe('resolved')
  })

  test("FINDING: a worker's card `supersedes` cannot retire main's pending card in another thread", async () => {
    const hh = await hub()
    writeWorkers(hh.home, Date.now(), { trip: { state: 'live', pane_pid: myPgid() } })
    writeNonce(hh.home, 'trip')
    const card = await mainCard(hh, 'general')
    const w = await startWorker(hh.home, hh.relay.httpUrl)
    await w.callTool('card', { thread_id: 'trip', ...CARD_ARGS, title: 'Mine', supersedes: card.id })
    await sleep(200)
    expect(hh.bridge.ctx.ledger.get(card.id)?.state).toBe('pending')
  })

  test("holds: a card_action for a card raised by trip's worker never goes to garden or main", async () => {
    const hh = await hub()
    writeWorkers(hh.home, Date.now(), {
      trip: { state: 'live', pane_pid: myPgid() },
      garden: { state: 'live', pane_pid: myPgid() },
    })
    writeNonce(hh.home, 'trip')
    const w = await startWorker(hh.home, hh.relay.httpUrl)
    const res = await w.callTool('card', { thread_id: 'trip', ...CARD_ARGS })
    expect(res.isError, res.content[0]?.text).toBeFalsy()
    const created = await hh.relay.expectFrame('card.create', (f) => f.card.thread_id === 'trip', {
      direction: 'from_bridge',
    })
    await hh.app.resolveCard(created.card, 'kill', created.card.payload_hash)
    await waitFor(() => existsSync(join(hh.home, 'workers', 'trip', 'wake')))
    expect(existsSync(join(hh.home, 'workers', 'garden', 'wake'))).toBe(false)
    expect(hh.notes.filter((n) => n.meta.kind === 'card_action')).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------------------------------------------------
// 2. Routing safety: switch flips, claims, deadlines
// ---------------------------------------------------------------------------------------------------------------------

describe('PR65 review: routing and claims', () => {
  test('FINDING: after the master switch is turned off, read_inbound no longer hands out messages routed before', async () => {
    const hh = await hub()
    writeWorkers(hh.home, Date.now(), { trip: { state: 'live', pane_pid: myPgid() } })
    writeNonce(hh.home, 'trip')
    const w = await startWorker(hh.home, hh.relay.httpUrl)
    await hh.app.sendMessage('trip', 'Find a hotel')
    await waitFor(() => existsSync(join(hh.home, 'workers', 'trip', 'wake')))
    // the owner turns thread sessions off: main answers every thread from now on
    hh.bridge.ctx.config.update((c) => ({ ...c, dedicated: DedicatedConfig.parse({ enabled: false }) }))
    const r = json(await w.callTool('read_inbound', {}))
    expect(r.messages).toHaveLength(0)
  })

  test("FINDING: after the master switch is turned off, the hub refuses the old worker's replies", async () => {
    const hh = await hub()
    writeWorkers(hh.home, Date.now(), { trip: { state: 'live', pane_pid: myPgid() } })
    writeNonce(hh.home, 'trip')
    const w = await startWorker(hh.home, hh.relay.httpUrl)
    hh.bridge.ctx.config.update((c) => ({ ...c, dedicated: DedicatedConfig.parse({ enabled: false }) }))
    const r = await w.callTool('reply', { thread_id: 'trip', text: 'still here' })
    expect(r.isError).toBe(true)
  })

  test("holds: trip's worker read_inbound never returns garden's messages", async () => {
    const hh = await hub()
    writeWorkers(hh.home, Date.now(), {
      trip: { state: 'live', pane_pid: myPgid() },
      garden: { state: 'live', pane_pid: myPgid() },
    })
    writeNonce(hh.home, 'trip')
    const w = await startWorker(hh.home, hh.relay.httpUrl)
    await hh.app.sendMessage('garden', 'water the tomatoes')
    await waitFor(() => existsSync(join(hh.home, 'workers', 'garden', 'wake')))
    const r = json(await w.callTool('read_inbound', {}))
    expect(r.messages).toHaveLength(0)
    expect(hh.bridge.router?.store.unclaimed('garden')).toHaveLength(1)
  })

  test('holds: a deadline routed before a live-bridge restart is re-armed; main is told once, with fallback meta and a system row', async () => {
    const clock = fakeClock(new Date().toISOString())
    const hh = await hub({ clock })
    writeWorkers(hh.home, clock.now(), { trip: { state: 'live', pane_pid: myPgid() } })
    const sent = await hh.app.sendMessage('trip', 'Before the restart')
    await waitTicking(clock, () => existsSync(join(hh.home, 'workers', 'trip', 'wake')))
    expect(hh.notes).toHaveLength(0)
    await hh.bridge.stop()
    // a new live bridge on the same home and relay
    const notes: Notification[] = []
    extra = await Bridge.create({
      env: loadEnv({
        TALOS_APP_HOME: hh.home,
        TALOS_APP_RELAY_URL: hh.relay.httpUrl,
        TALOS_APP_BRIDGE: '1',
      }),
      logger: nullLogger,
      clock,
      inbound: { settleMs: 20, maxSettleMs: 200 },
    })
    extra.setEmit(async (n) => {
      notes.push(n)
    })
    extra.start()
    writeWorkers(hh.home, clock.now(), { trip: { state: 'live', pane_pid: myPgid() } })
    await advanceSteps(clock, CLAIM_DEADLINE_MS + 1_000, 10_000)
    await waitFor(() => notes.some((n) => n.meta.message_id === sent.client_msg_id))
    await advanceSteps(clock, CLAIM_DEADLINE_MS, 10_000)
    const mine = notes.filter((n) => n.meta.message_id === sent.client_msg_id)
    expect(mine).toHaveLength(1)
    expect(mine[0]?.meta).toMatchObject({ routed: 'fallback', reason: 'worker_unavailable' })
    await hh.relay.expectFrame(
      'reply',
      (f) =>
        f.message.author === 'system' && f.message.thread_id === 'trip' && /Main answered/.test(f.message.text ?? ''),
      { direction: 'from_bridge' },
    )
    // stop the replaced bridge cleanly in afterEach
    h = {
      ...hh,
      stop: async () => {
        await hh.app.close()
        ;(hh.relay as unknown as { server?: { closeAllConnections?: () => void } }).server?.closeAllConnections?.()
        await hh.relay.stop()
      },
    }
  })

  test('holds: master switch off, a thread flagged dedicated still goes straight to main with no wake file', async () => {
    h = await startHarness({
      config: ((c: Record<string, unknown> & { threads: unknown[] }) => ({
        ...dedicatedConfig(c),
        dedicated: { enabled: false },
      })) as never,
    })
    writeWorkers(h.home, Date.now(), { trip: { state: 'live', pane_pid: myPgid() } })
    await h.app.sendMessage('trip', 'plain old main')
    await h.waitNotes(1)
    expect(h.notes[0]?.meta.routed).toBeUndefined()
    expect(existsSync(join(h.home, 'workers', 'trip', 'wake'))).toBe(false)
  })
})

// ---------------------------------------------------------------------------------------------------------------------
// 3. Delivery: one reply per post
// ---------------------------------------------------------------------------------------------------------------------

describe('PR65 review: delivery', () => {
  test('FINDING: the hub sent a reply but the socket closed before the ack: the relay still gets it once', async () => {
    const hh = await hub()
    writeWorkers(hh.home, Date.now(), { trip: { state: 'live', pane_pid: myPgid() } })
    writeNonce(hh.home, 'trip')
    const w = await startWorker(hh.home, hh.relay.httpUrl)
    // the live bridge is superseded (or restarts) right after it sent the frame: its hub socket closes before the ack
    const t = hh.bridge.ctx.transport
    const orig = t.sendDurable.bind(t)
    t.sendDurable = async (f) => {
      const r = await orig(f)
      void hh.bridge.hub?.close()
      return r
    }
    const r = await w.callTool('reply', { thread_id: 'trip', text: 'Booked the train.' })
    expect(r.isError, r.content[0]?.text).toBeFalsy()
    t.sendDurable = orig
    await sleep(300)
    const booked = () =>
      hh.relay.frames.filter(
        (x) =>
          x.direction === 'from_bridge' &&
          x.frame.type === 'reply' &&
          (x.frame as { message: { text?: string } }).message.text === 'Booked the train.',
      )
    // the worker re-posts after the lost ack; the relay dedupes by frame id, so one id is what counts
    expect(new Set(booked().map((x) => x.frame.id)).size).toBe(1)
  })

  test('FINDING: card_result with the hub down fails without consuming the card (it can be retried)', async () => {
    const hh = await hub()
    writeWorkers(hh.home, Date.now(), { trip: { state: 'live', pane_pid: myPgid() } })
    writeNonce(hh.home, 'trip')
    const w = await startWorker(hh.home, hh.relay.httpUrl)
    const res = await w.callTool('card', { thread_id: 'trip', ...CARD_ARGS })
    expect(res.isError, res.content[0]?.text).toBeFalsy()
    const created = await hh.relay.expectFrame('card.create', (f) => f.card.thread_id === 'trip', {
      direction: 'from_bridge',
    })
    await hh.app.resolveCard(created.card, 'primary', created.card.payload_hash)
    await waitFor(() => existsSync(join(hh.home, 'workers', 'trip', 'wake')))
    expect(json(await w.callTool('read_inbound', {})).messages).toHaveLength(1)
    await hh.bridge.hub?.close() // the hub goes away
    await waitFor(() => w.hubClient?.connected === false)
    const r = await w.callTool('card_result', { card_id: created.card.id, ok: true, text: 'paid' })
    expect(r.isError).toBe(true) // card.update has no HTTP path
    expect(hh.bridge.ctx.ledger.get(created.card.id)?.state).toBe('resolved')
  })
})

// ---------------------------------------------------------------------------------------------------------------------
// 4. The hub socket
// ---------------------------------------------------------------------------------------------------------------------

/** Opens hub.sock, writes lines, collects what comes back until the hub closes it (or `ms` passes). */
async function rawLines(home: string, lines: string[], ms = 800): Promise<{ got: string[]; closed: boolean }> {
  return new Promise((resolve) => {
    const got: string[] = []
    let buf = ''
    let closed = false
    const s = createConnection(join(home, 'hub.sock'))
    s.setEncoding('utf8')
    s.on('connect', () => {
      for (const l of lines) s.write(l)
    })
    s.on('data', (d: string) => {
      buf += d
      let i = buf.indexOf('\n')
      while (i >= 0) {
        got.push(buf.slice(0, i))
        buf = buf.slice(i + 1)
        i = buf.indexOf('\n')
      }
    })
    s.on('error', () => {})
    s.on('close', () => {
      closed = true
    })
    setTimeout(() => {
      s.destroy()
      resolve({ got, closed })
    }, ms)
  })
}

describe('PR65 review: hub socket', () => {
  test('FINDING: a second connection for a thread that already has a welcomed worker is not welcomed too', async () => {
    const hh = await hub()
    writeWorkers(hh.home, Date.now(), { trip: { state: 'live', pane_pid: myPgid() } })
    writeNonce(hh.home, 'trip')
    const a = await rawClient(hh.home)
    expect(a.ok).toBe(true)
    await rawClient(hh.home)
    await sleep(100)
    expect(hh.bridge.hub?.connectedThreads().filter((t) => t === 'trip').length).toBe(1)
  })

  test('holds: the socket file is 0600; an out before hello is refused and closed', async () => {
    const hh = await hub()
    const { statSync } = await import('node:fs')
    expect(statSync(join(hh.home, 'hub.sock')).mode & 0o777).toBe(0o600)
    const frame = { ...mkFrame('status'), thread_id: 'trip', state: 'working', since: new Date().toISOString() }
    const r = await rawLines(hh.home, [`${JSON.stringify({ t: 'out', frame })}\n`])
    expect(r.got.map((l) => JSON.parse(l))).toEqual([expect.objectContaining({ t: 'refused', code: 'unauthorized' })])
    expect(r.closed).toBe(true)
  })

  test('holds: a hello with a too-short or wrong nonce is refused; a hello for a shared thread is refused', async () => {
    const hh = await hub()
    writeWorkers(hh.home, Date.now(), {
      trip: { state: 'live', pane_pid: myPgid() },
      shared_one: { state: 'live', pane_pid: myPgid() },
    })
    writeNonce(hh.home, 'trip')
    writeNonce(hh.home, 'shared_one')
    const hello = (thread_id: string, nonce: string) =>
      `${JSON.stringify({ t: 'hello', thread_id, pid: process.pid, nonce })}\n`
    const short = await rawLines(hh.home, [hello('trip', '')])
    expect(JSON.parse(short.got[0] ?? '{}')).toMatchObject({ t: 'refused' })
    const wrong = await rawLines(hh.home, [hello('trip', 'y'.repeat(26))])
    expect(JSON.parse(wrong.got[0] ?? '{}')).toMatchObject({ t: 'refused', code: 'not_owner' })
    const shared = await rawLines(hh.home, [hello('shared_one', NONCE)])
    expect(JSON.parse(shared.got[0] ?? '{}')).toMatchObject({ t: 'refused', code: 'not_owner' })
  })

  test('holds: after hello, a permission card, a reply for another thread and a non-agent reply are refused', async () => {
    const hh = await hub()
    writeWorkers(hh.home, Date.now(), { trip: { state: 'live', pane_pid: myPgid() } })
    writeNonce(hh.home, 'trip')
    const card = await mainCard(hh, 'trip')
    const { c } = await rawClient(hh.home)
    const perm = await c.out(
      cardCreateFrame(Date.now(), { ...card, id: `c_${newUlid()}`, kind: 'permission' } as never),
    )
    expect(perm.state).toBe('refused')
    const reply = (thread_id: string, author: string) => ({
      ...mkFrame('reply'),
      message: {
        id: `m_${newUlid()}`,
        thread_id,
        author,
        text: 'x',
        format: 'plain',
        attachments: [],
        ts: new Date().toISOString(),
      },
    })
    expect((await c.out(reply('general', 'agent') as never)).state).toBe('refused')
    expect((await c.out(reply('trip', 'owner') as never)).state).toBe('refused')
  })

  test('holds: an oversized line drops the connection', async () => {
    const hh = await hub()
    // Observed at the hub, not the client: on macOS, Bun's client socket never reports `close` while it still has
    // unsent bytes for a peer that went away (the hub really did drop it; the raw net test shows the same).
    let open = -1
    const lines = rawLines(hh.home, ['x'.repeat(320 * 1024)], 1500)
    await sleep(800)
    open = hh.bridge.hub?.connections ?? -1
    await lines
    expect(open).toBe(0)
  })
})

// ---------------------------------------------------------------------------------------------------------------------
// 5. Governor
// ---------------------------------------------------------------------------------------------------------------------

const rl = (five?: number, week?: number) => ({
  session_id: 's',
  source: 'mod' as const,
  capabilities: [],
  rate_limits: [
    ...(five === undefined ? [] : [{ kind: 'five_hour', percent: five }]),
    ...(week === undefined ? [] : [{ kind: 'seven_day', percent: week }]),
  ],
  surfaces: [],
  at: new Date().toISOString(),
})

describe('PR65 review: usage governor', () => {
  const d = DedicatedConfig.parse({ enabled: true })
  test('holds: boundaries are "at or above": 79.9/80 five-hour, 84.9/85 weekly, 94.9/95 park-all', () => {
    expect(governor(d, rl(79.9, 0)).state).toBe('ok')
    expect(governor(d, rl(80, 0)).state).toBe('paused')
    expect(governor(d, rl(0, 84.9)).state).toBe('ok')
    expect(governor(d, rl(0, 85)).state).toBe('paused') // weekly-only crossing
    expect(governor(d, rl(undefined, 85)).state).toBe('paused')
    expect(governor(d, rl(94.9, 0)).state).toBe('paused')
    expect(governor(d, rl(95, 0)).state).toBe('park_all')
    expect(governor(d, rl(0, 95)).state).toBe('park_all')
  })
  test('holds: off, custom thresholds, no reading never blocks', () => {
    expect(governor(DedicatedConfig.parse({ governor: { off: true } }), rl(99, 99)).state).toBe('off')
    const custom = DedicatedConfig.parse({ governor: { five_hour: 50, weekly: 60, park_all: 70 } })
    expect(governor(custom, rl(50, 0)).state).toBe('paused')
    expect(governor(custom, rl(0, 60)).state).toBe('paused')
    expect(governor(custom, rl(70, 0)).state).toBe('park_all')
    expect(governor(d, undefined).state).toBe('unknown')
    expect(allowsStart(governor(d, undefined))).toBe(true)
    expect(allowsStart(governor(d, rl(80, 0)))).toBe(false)
    // trust mode: the warning band lets a start through, the park-all mark does not
    expect(allowsStart(governor(d, rl(80, 0)), { trust: true })).toBe(true)
    expect(allowsStart(governor(d, rl(0, 85)), { trust: true })).toBe(true)
    expect(allowsStart(governor(d, rl(95, 0)), { trust: true })).toBe(false)
    expect(allowsStart(governor(d, rl(0, 95)), { trust: true })).toBe(false)
    expect(allowsStart(governor(d, rl(84, 0)), { trust: false })).toBe(false)
  })

  test('holds: park-all writes one park wake per live worker per crossing, and re-arms after dropping below', async () => {
    const hh = await hub()
    writeWorkers(hh.home, Date.now(), {
      trip: { state: 'live', pane_pid: myPgid() },
      garden: { state: 'busy', pane_pid: myPgid() },
    })
    let pct = 96
    hh.bridge.ctx.mod.liveState = () => rl(pct, 0)
    const wake = (t: string) => join(hh.home, 'workers', t, 'wake')
    hh.bridge.optionCTick()
    for (const t of ['trip', 'garden'])
      expect(WakeFile.parse(JSON.parse(readFileSync(wake(t), 'utf8')))).toMatchObject({ action: 'park' })
    rmSync(wake('trip'))
    rmSync(wake('garden'))
    hh.bridge.optionCTick()
    expect(existsSync(wake('trip'))).toBe(false) // once per crossing
    pct = 50
    hh.bridge.optionCTick()
    pct = 97
    hh.bridge.optionCTick()
    expect(existsSync(wake('trip'))).toBe(true)
  })
})

// ---------------------------------------------------------------------------------------------------------------------
// 6. thread.session.control
// ---------------------------------------------------------------------------------------------------------------------

describe('PR65 review: thread.session.control', () => {
  test('holds: a replay of the same control_id under a new frame id gets the stored result and runs nothing again', async () => {
    const hh = await hub()
    writeWorkers(hh.home, Date.now(), { trip: { state: 'live', pane_pid: myPgid() } })
    const f = await hh.app.sendThreadSessionControl('trip', 'park')
    const first = await hh.relay.expectFrame('session.control.result', (x) => x.control_id === f.control_id, {
      direction: 'from_bridge',
    })
    expect(first.ok).toBe(true)
    rmSync(join(hh.home, 'workers', 'trip', 'wake'))
    const again = await hh.app.sign({
      ...mkFrame('thread.session.control'),
      control_id: f.control_id,
      thread_id: 'trip',
      action: 'park',
    })
    hh.app.send(again)
    await waitFor(
      () =>
        hh.relay.frames.filter(
          (r) =>
            r.direction === 'from_bridge' &&
            r.frame.type === 'session.control.result' &&
            (r.frame as { control_id?: string }).control_id === f.control_id,
        ).length >= 2,
    )
    expect(existsSync(join(hh.home, 'workers', 'trip', 'wake'))).toBe(false)
  })

  test('trust mode: at 84 percent a resume starts with a warning; at 95 it is still refused; off, 84 is refused', async () => {
    const hh = await hub({ trust: true })
    writeWorkers(hh.home, Date.now(), { trip: { state: 'parked' } })
    hh.bridge.ctx.mod.liveState = () => rl(84, 0)
    const f = await hh.app.sendThreadSessionControl('trip', 'resume')
    const ok = await hh.relay.expectFrame('session.control.result', (x) => x.control_id === f.control_id, {
      direction: 'from_bridge',
    })
    expect(ok).toMatchObject({ ok: true })
    expect(ok.text).toMatch(/Plan limits are close/)
    await waitFor(() => existsSync(join(hh.home, 'workers', 'trip', 'wake')))
    rmSync(join(hh.home, 'workers', 'trip', 'wake'), { force: true })
    hh.bridge.ctx.mod.liveState = () => rl(95, 0)
    const g = await hh.app.sendThreadSessionControl('trip', 'resume')
    const no = await hh.relay.expectFrame('session.control.result', (x) => x.control_id === g.control_id, {
      direction: 'from_bridge',
    })
    expect(no).toMatchObject({ ok: false, code: 'usage_governor' })
    expect(existsSync(join(hh.home, 'workers', 'trip', 'wake'))).toBe(false)
  })

  test('trust mode: three messages to a parked thread at 84 percent post the limits notice exactly once', async () => {
    const hh = await hub({ trust: true })
    writeWorkers(hh.home, Date.now(), { trip: { state: 'parked' } })
    hh.bridge.ctx.mod.liveState = () => rl(84, 0)
    const notices = () =>
      hh.bridge.ctx.store
        .page({ thread_id: 'trip', limit: 50 })
        .messages.filter((m) => m.author === 'system' && /Plan limits are close/.test(m.text ?? '')).length
    await hh.app.sendMessage('trip', 'start it')
    await waitFor(() => existsSync(join(hh.home, 'workers', 'trip', 'wake')))
    await waitFor(() => notices() === 1)
    await hh.app.sendMessage('trip', 'and again')
    await hh.app.sendMessage('trip', 'and once more')
    await waitFor(
      () =>
        hh.bridge.ctx.store.page({ thread_id: 'trip', limit: 50 }).messages.filter((m) => m.author === 'owner')
          .length >= 3,
    )
    await new Promise((r) => setTimeout(r, 300))
    expect(notices()).toBe(1)
  })

  test('trust mode off: 84 percent is refused exactly as before', async () => {
    const hh = await hub()
    writeWorkers(hh.home, Date.now(), { trip: { state: 'parked' } })
    hh.bridge.ctx.mod.liveState = () => rl(84, 0)
    const f = await hh.app.sendThreadSessionControl('trip', 'resume')
    const res = await hh.relay.expectFrame('session.control.result', (x) => x.control_id === f.control_id, {
      direction: 'from_bridge',
    })
    expect(res).toMatchObject({ ok: false, code: 'usage_governor' })
  })

  test('holds: resume under the governor and a control for an unknown thread are refused', async () => {
    const hh = await hub()
    writeWorkers(hh.home, Date.now(), { trip: { state: 'parked' } })
    hh.bridge.ctx.mod.liveState = () => rl(85, 0)
    const f = await hh.app.sendThreadSessionControl('trip', 'resume')
    const res = await hh.relay.expectFrame('session.control.result', (x) => x.control_id === f.control_id, {
      direction: 'from_bridge',
    })
    expect(res).toMatchObject({ ok: false, code: 'usage_governor' })
    const g = await hh.app.sendThreadSessionControl('no_such_thread', 'park')
    const no = await hh.relay.expectFrame('session.control.result', (x) => x.control_id === g.control_id, {
      direction: 'from_bridge',
    })
    expect(no).toMatchObject({ ok: false, code: 'worker_unavailable' })
    expect(existsSync(join(hh.home, 'workers', 'trip', 'wake'))).toBe(false)
  })
})

// ---------------------------------------------------------------------------------------------------------------------
// 7. Compatibility
// ---------------------------------------------------------------------------------------------------------------------

describe('PR65 review: compatibility', () => {
  test('FINDING: the live bridge advertises thread-sessions/1 in hello.client.features (the app hides the switch without it)', async () => {
    const hh = await hub()
    const features = (hh.relay as unknown as { bridgeFeatures: string[] }).bridgeFeatures
    expect(features).toContain(THREAD_SESSIONS_FEATURE)
  })

  test('FINDING: workers.status is not sent to a relay that does not list thread-sessions/1', async () => {
    h = await startHarness({ relay: { relayFeatures: ['schedules/1'] } })
    h.bridge.optionCTick()
    await sleep(200)
    const sent = h.relay.frames.filter((r) => r.direction === 'from_bridge' && r.frame.type === 'workers.status')
    expect(sent).toHaveLength(0)
  })
})
