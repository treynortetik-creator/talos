// Thread schedules, review rounds 1 and 2 and the kv rows (split from thread-schedules.test.ts so the two halves run in parallel; the setup below is the same).
// Thread-owned schedules (docs/OPTION-C.md "Thread schedules"): a job of a thread that has its own session fires in that
// session; a parked one is woken; a failed one falls back to main with a plain note; a heartbeat stays main's; and a thread
// session proposes, lists, changes and deletes only its own thread's jobs. Real bridges (main = the hub, workers in worker
// mode) over real Chronos and the FakeRelay, on an injected clock; a workers.json written the way the supervisor writes it.
import { afterEach, describe, expect, setDefaultTimeout, test } from 'bun:test'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { createConnection } from 'node:net'
import { join } from 'node:path'
import {
  type CardT,
  CLAIM_DEADLINE_MS,
  HEARTBEAT_META_KEY,
  newUlid,
  ScheduleCardPayload,
  WakeFile,
} from '@talos-app/protocol'
import { t } from '@talos-app/testkit'
import { Bridge } from '../../src/bridge.ts'
import { loadEnv } from '../../src/config.ts'
import { HubClient } from '../../src/hub/client.ts'
import { pgidOf } from '../../src/hub/server.ts'
import { nullLogger } from '../../src/log.ts'
import { heartbeatWakeNotification, scheduleRunNotification } from '../../src/notify.ts'
import { WORKER_BRIDGE_TOOLS } from '../../src/tools/table.ts'
import { eventually } from '../helpers.ts'
import {
  draft,
  readSidecar,
  restartBridge,
  SCHED_START_MS,
  type SchedHarness,
  sleep,
  startSched,
  waitFor,
} from './harness.ts'

// real Chronos processes and minutes of injected time: what longTimeouts() sets (60 s), written out so timing-lint can see it;
// a test that starts a bridge says SCHED_START_MS plus its own waits itself
setDefaultTimeout(t(60_000))

/** Every frame the relay sent before this has REACHED the bridge (it answers a ping at once, in order, and its pong comes back after anything the bridge had already written); its queues may still be working. */
const pinged = async (x: SchedHarness) => {
  const nonce = `after-${newUlid().slice(-12)}`
  x.relay.sendToBridge({ type: 'ping', nonce }, { durable: false })
  await x.relay.expectFrame('pong', (f) => f.nonce === nonce, { direction: 'from_bridge' })
}

const BEFORE_0730 = '2026-10-05T11:29:00Z' // 07:29 EDT, Monday
const NONCE = 'test-nonce-0123456789abcdef'
const GARDEN_NONCE = 'garden-nonce-0123456789abcdef'

let h = undefined as unknown as SchedHarness
const workers: Bridge[] = []
afterEach(async () => {
  for (const w of workers.splice(0)) await w.stop()
  await h?.stop()
  h = undefined as unknown as SchedHarness
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

type Entry = { state: string; error?: unknown }
function writeWorkers(x: SchedHarness, threads: Record<string, Entry>, opts: { stale?: boolean } = {}) {
  const now = x.clock.now()
  // a heartbeat dated ahead stays fresh while the test moves the injected clock (supervisorFresh counts it as skew)
  const at = new Date(opts.stale ? now - 60_000 : now + 30 * 60_000).toISOString()
  const t: Record<string, unknown> = {}
  for (const [id, e] of Object.entries(threads))
    t[id] = {
      state: e.state,
      session_id: '6f1c2a9e-4b3d-4c8e-9a71-2d5e8f0b3c41',
      tmux: `t-${id}`,
      pane_pid: e.state === 'live' || e.state === 'busy' ? (pgidOf(process.pid) as number) : 0,
      cwd: x.home,
      error: e.error ?? null,
    }
  writeFileSync(
    join(x.home, 'workers.json'),
    JSON.stringify({ v: 1, supervisor: { pid: 1, heartbeat_at: at, workers_supported: true }, threads: t }),
  )
}
function writeNonce(home: string, id: string, nonce: string) {
  mkdirSync(join(home, 'workers', id), { recursive: true })
  writeFileSync(join(home, 'workers', id, 'nonce'), nonce)
}

/** A main bridge with two dedicated threads (trip, garden), a shared one and real Chronos jobs; trip's job runs in trip, garden's in garden. */
async function start(o: { jobs?: Parameters<typeof draft>[0][]; now?: string } = {}) {
  h = await startSched({
    now: o.now ?? BEFORE_0730,
    jobs: (
      o.jobs ?? [
        { id: 'trip-digest', name: 'Trip Digest' },
        { id: 'garden-water', name: 'Garden Water' },
        { id: 'main-brief', name: 'Main Brief' },
      ]
    ).map((j) => draft(j)),
    config: ((c: Record<string, unknown> & { threads: unknown[] }) => ({
      ...c,
      threads: [
        ...c.threads,
        thread('trip', 'Trip', { session: 'dedicated' }),
        thread('garden', 'Garden', { session: 'dedicated' }),
        thread('shared_one', 'Shared'),
      ],
      dedicated: { enabled: true },
    })) as never,
  })
  await waitFor(() => existsSync(join(h.home, 'run', 'hub.sock')))
  const side = h.bridge.ctx.schedules?.sidecar
  // a job whose id starts with trip- / garden- runs in that thread
  for (const j of o.jobs ?? [{ id: 'trip-digest' }, { id: 'garden-water' }]) {
    const id = j?.id ?? ''
    if (id.startsWith('trip-')) expect(side?.setThread(id, 'trip')).toBe(true)
    if (id.startsWith('garden-')) expect(side?.setThread(id, 'garden')).toBe(true)
  }
  return h
}

async function startWorker(id: 'trip' | 'garden', connect = true) {
  const w = await Bridge.create({
    env: loadEnv({
      TALOS_APP_HOME: h.home,
      TALOS_APP_RELAY_URL: h.relay.httpUrl,
      TALOS_APP_WORKER_THREAD: id,
      TALOS_APP_WORKER_NONCE: id === 'trip' ? NONCE : GARDEN_NONCE,
    }),
    logger: nullLogger,
    clock: h.clock, // the same injected time as main: claims are dated by it
  })
  workers.push(w)
  if (connect) expect(await w.startWorker(), JSON.stringify(w.hubClient?.lastRefusal)).toBe(true)
  return w
}

/** Waits until the bridge has offered `n` jobs (they go out one after another). */
const offered = (n: number) =>
  waitFor(
    () => Object.keys((readSidecar(h) as { offers?: object } | undefined)?.offers ?? {}).length >= n,
    15_000,
    `${n} offers`,
  )

const live = (extra: Record<string, Entry> = {}) => ({ trip: { state: 'live' }, garden: { state: 'live' }, ...extra })
const inbound = async (w: Bridge) =>
  JSON.parse((await w.callTool('read_inbound', {})).content[0]?.text ?? '{}') as {
    messages: Array<{ content: string; meta: Record<string, string> }>
    already_handled_by_main: string[]
  }
const text = (r: { content: Array<{ text?: string }> }) => r.content[0]?.text ?? ''

async function connected() {
  writeWorkers(h, live())
  writeNonce(h.home, 'trip', NONCE)
  writeNonce(h.home, 'garden', GARDEN_NONCE)
  return { trip: await startWorker('trip'), garden: await startWorker('garden') }
}

const propose = (extra: Record<string, unknown> = {}) => ({
  op: 'create',
  thread_id: 'trip',
  reason: 'The owner asked for it.',
  name: 'Packing Check',
  when: { type: 'weekdays', time: '07:45' },
  prompt: 'Check the packing list and post what is missing.\n',
  ...extra,
})
const pendingCards = () => h.bridge.ctx.ledger.list('pending').filter((r) => r.binding.kind === 'schedule')
const cardOf = async (res: { content: Array<{ text?: string }> }) => {
  const id = /card (c_\S+) pending/.exec(text(res))?.[1]
  expect(id, text(res)).toBeDefined()
  return (await h.app.expectFrame('card.create', (c) => c.card.id === id, { direction: 'in' })).card as CardT
}
const approveCard = async (card: CardT) => {
  await h.app.resolveCard(card, 'primary', card.payload_hash, { stepup_token: h.relay.mintStepup(`card:${card.id}`) })
  return h.app.expectFrame(
    'card.update',
    (u) => u.card_id === card.id && (u.state === 'done' || u.state === 'failed'),
    {
      direction: 'in',
    },
  )
}

describe("review round 1: a thread session's job runs in the session", () => {
  test(
    'R1-1: a worker cannot ask for a background runner, other permissions or a tool list; nothing is proposed',
    async () => {
      await start()
      const { trip } = await connected()
      for (const extra of [
        { runner: 'headless' },
        { runner: 'both' },
        { permissions: 'restricted' },
        { runner: 'headless', permissions: 'restricted', allowed_tools: ['Read'] },
        { allowed_tools: ['Read'] },
      ]) {
        const r = await trip.callTool('schedule_propose', propose(extra))
        expect(r.isError, JSON.stringify(extra)).toBe(true)
        expect(text(r), JSON.stringify(extra)).toContain('Nothing was proposed')
      }
      const upd = await trip.callTool('schedule_propose', {
        op: 'update',
        id: 'trip-digest',
        thread_id: 'trip',
        reason: 'x',
        runner: 'headless',
      })
      expect(upd.isError).toBe(true)
      expect(pendingCards()).toHaveLength(0)
      // a create that names the session runner is pinned to it, and its card says so truthfully
      const ok = await trip.callTool('schedule_propose', propose({ runner: 'session' }))
      expect(ok.isError, text(ok)).toBeFalsy()
      const card = await cardOf(ok)
      const p = ScheduleCardPayload.parse(card.payload)
      expect(p.change.op === 'create' && p.change.draft.runner).toBe('session')
    },
    SCHED_START_MS + t(60_000),
  )

  test(
    "R1-1: a background job in the thread is not the session's: not listed, not changeable, never routed to it",
    async () => {
      await start({ jobs: [{ id: 'trip-digest' }, { id: 'trip-bg', runner: 'headless', permissions: 'full' }] })
      const { trip } = await connected()
      const mine = text(await trip.callTool('schedules_list', {}))
      expect(mine).toContain('trip-digest')
      expect(mine).not.toContain('trip-bg')
      for (const op of ['update', 'delete']) {
        const r = await trip.callTool('schedule_propose', {
          op,
          id: 'trip-bg',
          thread_id: 'trip',
          reason: 'x',
          name: 'n',
        })
        expect(r.isError, op).toBe(true)
        expect(text(r), op).toMatch(/not one of this thread's jobs/)
      }
      expect((await trip.callTool('schedules_list', { id: 'trip-bg' })).isError).toBe(true)
      // the router keeps a run of such a job with main, whatever thread it names
      const n = scheduleRunNotification({
        thread: { id: 'trip', name: 'Trip' },
        runId: 'r_01JBF3V7Q8K2M4N6P8R0S2T4AD',
        jobId: 'trip-bg',
        name: 'x',
        ds: undefined,
        fireAt: undefined,
        windowEnds: undefined,
        guard: null,
        prompt: 'x',
        ts: new Date(h.clock.now()).toISOString(),
      })
      expect(h.bridge.router?.decide(n)).toEqual({ to: 'main' })
      expect(h.bridge.router?.decide({ ...n, meta: { ...n.meta, schedule_id: 'trip-digest' } })).toMatchObject({
        to: 'worker',
      })
    },
    SCHED_START_MS + t(60_000),
  )

  test(
    "R1-3 / R1-11: a worker supersedes only its own cards; main's cards in its thread are not its to replace or count",
    async () => {
      await start()
      const { trip } = await connected()
      const mains = []
      for (const n of ['One', 'Two', 'Three'])
        mains.push(await cardOf(await h.bridge.callTool('schedule_propose', propose({ name: `Main ${n}` }))))
      // main's three cards are in trip's thread, and still leave the session its own three
      const steal = await trip.callTool('schedule_propose', propose({ supersedes: mains[0]?.id }))
      expect(steal.isError).toBe(true)
      expect(text(steal)).toContain('own pending')
      const first = await cardOf(await trip.callTool('schedule_propose', propose({ name: 'Mine One' })))
      const replaced = await trip.callTool('schedule_propose', propose({ name: 'Mine One v2', supersedes: first.id }))
      expect(replaced.isError, text(replaced)).toBeFalsy()
      for (const n of ['Two', 'Three'])
        expect((await trip.callTool('schedule_propose', propose({ name: `Mine ${n}` }))).isError, n).toBeFalsy()
      expect((await trip.callTool('schedule_propose', propose({ name: 'Mine Four' }))).isError).toBe(true)
    },
    SCHED_START_MS + t(60_000),
  )

  test(
    "R1-10: the lanes have their own allowance: a full worker does not stop main, and main's cards do not stop a worker",
    async () => {
      await start()
      const { trip, garden } = await connected()
      for (const n of ['One', 'Two', 'Three'])
        expect((await trip.callTool('schedule_propose', propose({ name: `T ${n}` }))).isError).toBeFalsy()
      expect((await trip.callTool('schedule_propose', propose({ name: 'T Four' }))).isError).toBe(true)
      // main still can, in its own thread, and garden still can
      expect(
        (await h.bridge.callTool('schedule_propose', propose({ name: 'M One', thread_id: 'general' }))).isError,
      ).toBeFalsy()
      expect(
        (await garden.callTool('schedule_propose', propose({ name: 'G One', thread_id: 'garden' }))).isError,
      ).toBeFalsy()
    },
    SCHED_START_MS + t(60_000),
  )

  test(
    "R1-4: approving a worker's delete or change after the job moved to another thread changes nothing",
    async () => {
      await start({ jobs: [{ id: 'trip-digest' }, { id: 'trip-two', name: 'Trip Two' }] })
      const { trip } = await connected()
      const del = await cardOf(
        await trip.callTool('schedule_propose', {
          op: 'delete',
          id: 'trip-digest',
          thread_id: 'trip',
          reason: 'Not needed',
        }),
      )
      const upd = await cardOf(
        await trip.callTool('schedule_propose', {
          op: 'update',
          id: 'trip-two',
          thread_id: 'trip',
          reason: 'Rename',
          name: 'Renamed By Trip',
        }),
      )
      const side = h.bridge.ctx.schedules?.sidecar
      expect(side?.setThread('trip-digest', 'garden')).toBe(true)
      expect(side?.setThread('trip-two', 'garden')).toBe(true)
      for (const c of [del, upd]) {
        const u = await approveCard(c)
        expect(u.state).toBe('failed')
        expect(u.result?.text).toBe('This job moved to another thread; nothing changed.')
      }
      const ids = h.box.api<{ schedules: Array<{ id: string; name?: string }> }>(['snapshot']).schedules
      expect(ids.map((x) => x.id).sort()).toContain('trip-digest')
      expect(
        h.box
          .api<{ schedules: Array<{ id: string; name: string }> }>(['snapshot'])
          .schedules.find((x) => x.id === 'trip-two')?.name,
      ).toBe('Trip Two')
    },
    SCHED_START_MS + t(60_000),
  )

  test(
    'R1-4: the same cards still apply while the job stays in the thread',
    async () => {
      await start()
      const { trip } = await connected()
      const del = await cardOf(
        await trip.callTool('schedule_propose', {
          op: 'delete',
          id: 'trip-digest',
          thread_id: 'trip',
          reason: 'Not needed',
        }),
      )
      expect((await approveCard(del)).state).toBe('done')
      expect(h.box.api<{ schedules: Array<{ id: string }> }>(['snapshot']).schedules.map((x) => x.id)).not.toContain(
        'trip-digest',
      )
    },
    SCHED_START_MS + t(60_000),
  )

  test(
    'R1-1: a card whose proposer row is missing cannot change a session job: nothing changes, and the owner is told',
    async () => {
      await start()
      const { trip } = await connected()
      const del = await cardOf(
        await trip.callTool('schedule_propose', {
          op: 'delete',
          id: 'trip-digest',
          thread_id: 'trip',
          reason: 'Not needed',
        }),
      )
      expect(h.bridge.ctx.store.kvGet(`schedule_card_proposer/${del.id}`)).toBe('trip')
      h.bridge.ctx.store.kvDelete(`schedule_card_proposer/${del.id}`)
      const done = await approveCard(del)
      expect(done.state).toBe('failed')
      expect(JSON.stringify(done)).toContain("origin can't be checked")
      expect(h.box.api<{ schedules: Array<{ id: string }> }>(['snapshot']).schedules.map((x) => x.id)).toContain(
        'trip-digest',
      )
    },
    SCHED_START_MS + t(60_000),
  )

  test(
    "R1-1: main's own card records 'main' and still applies to a session job",
    async () => {
      await start()
      const res = await h.bridge.callTool('schedule_propose', {
        op: 'update',
        id: 'trip-digest',
        thread_id: 'trip',
        reason: 'Rename',
        name: 'Trip Digest Two',
      })
      expect(res.isError, text(res)).toBeFalsy()
      const card = await cardOf(res)
      expect(h.bridge.ctx.store.kvGet(`schedule_card_proposer/${card.id}`)).toBe('main')
      expect((await approveCard(card)).state).toBe('done')
      expect(
        h.box
          .api<{ schedules: Array<{ id: string; name: string }> }>(['snapshot'])
          .schedules.find((x) => x.id === 'trip-digest')?.name,
      ).toBe('Trip Digest Two')
    },
    SCHED_START_MS + t(60_000),
  )
})

describe('review round 1: delivery', () => {
  test(
    'R1-6: an older worker (its hello names no schedule capability) is never handed a run; main gets it, nothing is lost',
    async () => {
      await start()
      writeWorkers(h, live())
      writeNonce(h.home, 'trip', NONCE)
      const old = new HubClient({
        sockPath: join(h.home, 'run', 'hub.sock'),
        threadId: 'trip',
        nonce: NONCE,
        log: nullLogger,
        features: [],
      })
      expect(await old.connect()).toBe(true)
      expect(h.bridge.hub?.featuresOf('trip')).toEqual([])
      await h.advance(90_000)
      await offered(3)
      await eventually(() =>
        expect(h.notesOf('schedule_run').find((n) => n.meta.schedule_id === 'trip-digest')?.meta).toMatchObject({
          routed: 'fallback',
          reason: 'worker_unavailable',
        }),
      )
      expect(existsSync(join(h.home, 'workers', 'trip', 'wake'))).toBe(false)
      const run = h.notesOf('schedule_run').find((n) => n.meta.schedule_id === 'trip-digest')?.meta.run_id as string
      expect(await h.agent.start(run)).toBe('GO') // main can run it
      old.close()
    },
    SCHED_START_MS + t(60_000),
  )

  test(
    'R1-6: a worker that names the capability is handed the run',
    async () => {
      await start()
      const { trip } = await connected()
      expect(h.bridge.hub?.featuresOf('trip')).toContain('schedules/1')
      await h.advance(90_000)
      await offered(3)
      await eventually(() => expect(h.notes.some((n) => n.meta.schedule_id === 'trip-digest')).toBe(false))
      expect((await inbound(trip)).messages.map((m) => m.meta.schedule_id)).toContain('trip-digest')
    },
    SCHED_START_MS + t(60_000),
  )

  test(
    'R1-6: against an older hub that refuses a hello with extra fields, the worker says hello the old way',
    async () => {
      const { createServer } = await import('node:net')
      await start()
      const path = join(h.home, 'strict.sock')
      const seen: string[] = []
      const srv = createServer((s) => {
        s.on('data', (d) => {
          const hello = JSON.parse(String(d).split('\n')[0] as string)
          seen.push(Object.keys(hello).sort().join(','))
          if ('features' in hello)
            s.write(`${JSON.stringify({ t: 'refused', code: 'bad_frame', message: 'not a hub line' })}\n`)
          else s.write(`${JSON.stringify({ t: 'welcome', thread_id: 'trip' })}\n`)
        })
      })
      await new Promise<void>((res) => srv.listen(path, () => res()))
      const c = new HubClient({ sockPath: path, threadId: 'trip', nonce: NONCE, log: nullLogger, reconnectMs: 30 })
      expect(await c.connect()).toBe(false)
      await waitFor(() => c.connected, 5000, 'the plain hello to be welcomed')
      expect(seen[0]).toContain('features')
      expect(seen.at(-1)).not.toContain('features')
      c.close()
      srv.close()
    },
    SCHED_START_MS + t(60_000),
  )

  test(
    'R1-7: a run finished with done(ok) and no reply leaves no "stopped before it finished" notice when the session parks',
    async () => {
      await start()
      const { trip } = await connected()
      await h.advance(90_000)
      await offered(3)
      const [m] = (await inbound(trip)).messages
      const runId = m?.meta.run_id as string
      expect(text(await trip.callTool('schedule_run_start', { run_id: runId }))).toBe('GO')
      expect(text(await trip.callTool('schedule_run_done', { run_id: runId, ok: true, summary: 'Done quietly' }))).toBe(
        'recorded',
      )
      writeWorkers(h, { trip: { state: 'parked' }, garden: { state: 'live' } })
      h.bridge.optionCTick()
      // the tick runs synchronously, and a notice it posts is written to the socket before optionCTick returns (postSystemNotice ->
      // sendDurable sends before its first await), so the pong of a ping sent after it comes behind any notice: a real start point
      await pinged(h)
      await sleep(t(400))
      h.bridge.optionCTick()
      await pinged(h)
      await sleep(t(400))
      expect(
        h.relay.frames.some((r) => r.direction === 'from_bridge' && /stopped before it/.test(JSON.stringify(r.frame))),
      ).toBe(false)
    },
    SCHED_START_MS + t(60_000),
  )

  test(
    'R1-7: a session that parks without finishing the run does leave the plain notice',
    async () => {
      await start()
      const { trip } = await connected()
      await h.advance(90_000)
      await offered(3)
      const [m] = (await inbound(trip)).messages
      expect(m).toBeDefined()
      writeWorkers(h, { trip: { state: 'parked' }, garden: { state: 'live' } })
      h.bridge.optionCTick()
      await h.relay.expectFrame(
        'reply',
        (f) => /stopped before it finished a scheduled job/.test(f.message.text ?? ''),
        {
          direction: 'from_bridge',
        },
      )
    },
    SCHED_START_MS + t(60_000),
  )

  test(
    'R1-8: an answer that never comes says what to do next, per tool',
    async () => {
      const { createServer } = await import('node:net')
      await start()
      const path = join(h.home, 'quiet.sock')
      const srv = createServer((s) => {
        s.on('data', (d) => {
          if (String(d).includes('"hello"')) s.write(`${JSON.stringify({ t: 'welcome', thread_id: 'trip' })}\n`)
        })
      })
      await new Promise<void>((res) => srv.listen(path, () => res()))
      const c = new HubClient({ sockPath: path, threadId: 'trip', nonce: NONCE, log: nullLogger })
      expect(await c.connect()).toBe(true)
      const start1 = await c.rpc('schedule_run_start', { run_id: 'r_x' }, 100)
      expect(start1.text).toContain("Check schedules_list for the run's state")
      expect(start1.text).toContain('safe')
      const prop = await c.rpc('schedule_propose', {}, 100)
      expect(prop.text).toContain('A card may be waiting in this thread')
      expect(prop.text).toContain("don't propose the same thing again")
      c.close()
      srv.close()
    },
    SCHED_START_MS + t(60_000),
  )
})

describe('review round 2', () => {
  test(
    'R2-1: a session job with restricted permissions runs headless: not the session\'s to list or change, not routed, never "own session"',
    async () => {
      // Chronos refuses to create this combination, so it is what a hand-edited jobs.json looks like: a restricted background job
      // whose runner field was changed to "session". It still always runs headless.
      await start({
        jobs: [
          { id: 'trip-digest' },
          { id: 'trip-ro', runner: 'headless', permissions: 'restricted', allowed_tools: ['Read'] },
        ],
      })
      const file = join(h.box.home, '.config', 'chronos', 'jobs.json')
      const list = JSON.parse(readFileSync(file, 'utf8')) as Array<Record<string, unknown>>
      const row = list.find((x) => x.id === 'trip-ro')
      expect(row).toBeDefined()
      if (row) Object.assign(row, { in_session: true, headless: false })
      writeFileSync(file, JSON.stringify(list))
      await h.advance(3_000)
      // the job really is what the test says it is, so the checks below are not vacuous
      expect(text(await h.bridge.callTool('schedules_list', {}))).toMatch(/trip-ro .*\| session \| restricted \|/)
      const { trip } = await connected()
      const mine = text(await trip.callTool('schedules_list', {}))
      expect(mine).toContain('trip-digest')
      expect(mine).not.toContain('trip-ro')
      expect((await trip.callTool('schedules_list', { id: 'trip-ro' })).isError).toBe(true)
      for (const op of ['update', 'delete']) {
        const r = await trip.callTool('schedule_propose', {
          op,
          id: 'trip-ro',
          thread_id: 'trip',
          reason: 'x',
          prompt: 'Do something else.\n',
        })
        expect(r.isError, op).toBe(true)
        expect(text(r), op).toMatch(/not one of this thread's jobs/)
      }
      expect(pendingCards()).toHaveLength(0)
      expect(h.bridge.ctx.schedules?.sessionOnly('trip-ro')).toBe(false)
      expect(h.bridge.ctx.schedules?.sessionOnly('trip-digest')).toBe(true)
    },
    SCHED_START_MS + t(60_000),
  )

  test(
    'R2-2: a retry of schedule_run_start while the first is still queued answers GO, not SKIP',
    async () => {
      await start()
      const { trip } = await connected()
      await h.advance(90_000)
      await offered(3)
      const [m] = (await inbound(trip)).messages
      const runId = m?.meta.run_id as string
      const [a, b, c] = await Promise.all([1, 2, 3].map(() => trip.callTool('schedule_run_start', { run_id: runId })))
      expect([text(a as never), text(b as never), text(c as never)]).toEqual(['GO', 'GO', 'GO'])
      expect(text(await trip.callTool('schedule_run_done', { run_id: runId, ok: true, summary: 'ok' }))).toBe(
        'recorded',
      )
    },
    SCHED_START_MS + t(60_000),
  )
})

describe('R2-4: the kv rows of a card and a run go when the card or run is over', () => {
  const create = (extra: Record<string, unknown> = {}) => ({
    op: 'create',
    thread_id: 'trip',
    reason: 'The owner asked for a weekly packing check.',
    name: 'Packing Check',
    when: { type: 'weekdays', time: '07:45' },
    prompt: 'Check the packing list and post what is missing.\n',
    ...extra,
  })
  const proposerRow = (id: string) => h.bridge.ctx.store.kvGet(`schedule_card_proposer/${id}`)
  const startedRow = (id: string) => h.bridge.ctx.store.kvGet(`schedule_run_started/${id}`)
  async function propose(w: Bridge, extra: Record<string, unknown> = {}) {
    const res = await w.callTool('schedule_propose', create(extra))
    expect(res.isError, text(res)).toBeFalsy()
    const id = /card (c_\S+) pending/.exec(text(res))?.[1] as string
    const cc = await h.app.expectFrame('card.create', (c) => c.card.id === id, { direction: 'in' })
    return cc.card as CardT
  }

  test(
    'declined: the proposer row is removed',
    async () => {
      await start()
      const { trip } = await connected()
      const card = await propose(trip)
      expect(proposerRow(card.id)).toBe('trip')
      await h.app.resolveCard(card, 'kill', card.payload_hash)
      await eventually(() => expect(proposerRow(card.id)).toBeUndefined())
    },
    SCHED_START_MS + t(60_000),
  )

  test(
    'approved and applied: the proposer row is removed',
    async () => {
      await start()
      const { trip } = await connected()
      const card = await propose(trip, { when: { type: 'daily', time: '07:40' } })
      await h.app.resolveCard(card, 'primary', card.payload_hash, {
        stepup_token: h.relay.mintStepup(`card:${card.id}`),
      })
      await h.app.expectFrame('card.update', (u) => u.card_id === card.id && u.state === 'done', { direction: 'in' })
      await eventually(() => expect(proposerRow(card.id)).toBeUndefined())
    },
    SCHED_START_MS + t(60_000),
  )

  test(
    'expired: the proposer row is removed',
    async () => {
      await start()
      const { trip } = await connected()
      const card = await propose(trip)
      expect(proposerRow(card.id)).toBe('trip')
      // what the card's expiry timer runs at expires_at (card-expiry.ts; when it fires is card expiry's own test). Moving the
      // fake clock a whole day there took 2,000+ ping round trips, ~17 s, for nothing this test is about.
      await h.bridge.ctx.expiry?.expire(card.id, 'expired')
      await h.app.expectFrame('card.update', (u) => u.card_id === card.id && u.state === 'expired', { direction: 'in' })
      await eventually(() => expect(proposerRow(card.id)).toBeUndefined())
    },
    SCHED_START_MS + t(60_000),
  )

  test(
    'replaced: the old card loses its row, the new one has its own',
    async () => {
      await start()
      const { trip } = await connected()
      const old = await propose(trip)
      const next = await propose(trip, { supersedes: old.id })
      await eventually(() => expect(proposerRow(old.id)).toBeUndefined())
      expect(proposerRow(next.id)).toBe('trip')
    },
    SCHED_START_MS + t(60_000),
  )

  test(
    'a run: the started row is there while it is open and gone when it is done',
    async () => {
      await start()
      const { trip } = await connected()
      await h.advance(90_000)
      await offered(3)
      const [m] = (await inbound(trip)).messages
      const runId = m?.meta.run_id as string
      expect(text(await trip.callTool('schedule_run_start', { run_id: runId }))).toBe('GO')
      expect(startedRow(runId)).toBe('trip')
      expect(text(await trip.callTool('schedule_run_done', { run_id: runId, ok: true, summary: 'ok' }))).toBe(
        'recorded',
      )
      expect(startedRow(runId)).toBeUndefined()
      // a late start for the closed run is still answered in words
      expect(text(await trip.callTool('schedule_run_start', { run_id: runId }))).toContain('already done')
    },
    SCHED_START_MS + t(60_000),
  )

  test(
    'a restart sweeps rows of unknown, finished and week-old things and keeps a card that still waits',
    async () => {
      await start()
      const { trip } = await connected()
      const waiting = await propose(trip)
      const store = h.bridge.ctx.store
      store.kvSet('schedule_card_proposer/c_never_existed', 'trip')
      store.kvSet('schedule_run_started/r_never_existed', 'trip')
      store.kvSet('unrelated/key', 'stays')
      for (const w of workers.splice(0)) await w.stop()
      h = await restartBridge(h)
      const after = h.bridge.ctx.store
      expect(after.kvGet('schedule_card_proposer/c_never_existed')).toBeUndefined()
      expect(after.kvGet('schedule_run_started/r_never_existed')).toBeUndefined()
      expect(after.kvGet(`schedule_card_proposer/${waiting.id}`)).toBe('trip')
      expect(after.kvGet('unrelated/key')).toBe('stays')
    },
    SCHED_START_MS + t(60_000),
  )
})
