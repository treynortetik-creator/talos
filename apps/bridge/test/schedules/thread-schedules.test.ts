// Thread-owned schedules (docs/OPTION-C.md "Thread schedules"): a job of a thread that has its own session fires in that
// session; a parked one is woken; a failed one falls back to main with a plain note; a heartbeat stays main's; and a thread
// session proposes, lists, changes and deletes only its own thread's jobs. Real bridges (main = the hub, workers in worker
// mode) over real Chronos and the FakeRelay, on an injected clock; a workers.json written the way the supervisor writes it.
import { afterEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { createConnection } from 'node:net'
import { join } from 'node:path'
import { type CardT, CLAIM_DEADLINE_MS, HEARTBEAT_META_KEY, ScheduleCardPayload, WakeFile } from '@talos-app/protocol'
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
  longTimeouts,
  readSidecar,
  restartBridge,
  type SchedHarness,
  sleep,
  startSched,
  waitFor,
} from './harness.ts'

longTimeouts()

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
  voice_context: 'recent',
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
  await waitFor(() => existsSync(join(h.home, 'hub.sock')))
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

describe('routing: a thread job fires in its own session', () => {
  test('a dedicated thread job reaches its worker, never main; the others stay where they were', async () => {
    await start()
    const { trip } = await connected()
    await h.advance(90_000)
    await offered(3)
    await eventually(() => expect(h.notesOf('schedule_run').map((n) => n.meta.schedule_id)).toEqual(['main-brief']))
    const got = await inbound(trip)
    expect(got.messages).toHaveLength(1)
    const m = got.messages[0]
    expect(m?.meta).toMatchObject({
      kind: 'schedule_run',
      trust: 'owner',
      thread_id: 'trip',
      schedule_id: 'trip-digest',
    })
    expect(m?.content).toContain('Summarise yesterday and post it.')
    expect(m?.meta.run_id).toMatch(/^r_/)
    // garden's session has not read its own: nothing of trip's job is in main either
    expect(h.notes.some((n) => n.meta.schedule_id === 'trip-digest')).toBe(false)
  })

  test('a parked worker is woken for it: a wake file names the run, and the thread says a session is starting', async () => {
    await start()
    writeWorkers(h, { trip: { state: 'parked' }, garden: { state: 'parked' } })
    await h.advance(90_000)
    await offered(3)
    const wakePath = join(h.home, 'workers', 'trip', 'wake')
    await waitFor(() => existsSync(wakePath))
    const wake = WakeFile.parse(JSON.parse(await Bun.file(wakePath).text()))
    expect(wake.thread_id).toBe('trip')
    expect(wake.action).toBe('pointer')
    expect(wake.message_ids).toHaveLength(1)
    expect(wake.message_ids[0]).toMatch(/^r_/)
    expect(JSON.stringify(wake)).not.toContain('Summarise') // ids only, never the job text
    await h.relay.expectFrame('status', (f) => f.thread_id === 'trip' && f.state === 'working', {
      direction: 'from_bridge',
    })
    expect(h.notes.some((n) => n.meta.schedule_id === 'trip-digest')).toBe(false)
  })

  test('a supervisor that is not running: the job falls back to main with the plain note', async () => {
    await start()
    writeWorkers(h, live(), { stale: true })
    await h.advance(90_000)
    await offered(3)
    await eventually(() =>
      expect(
        h
          .notesOf('schedule_run')
          .map((n) => n.meta.schedule_id)
          .sort(),
      ).toEqual(['garden-water', 'main-brief', 'trip-digest']),
    )
    const n = h.notesOf('schedule_run').find((x) => x.meta.schedule_id === 'trip-digest')
    expect(n?.meta).toMatchObject({ routed: 'fallback', reason: 'worker_unavailable', thread_id: 'trip' })
    expect(n?.content).toContain('Summarise yesterday and post it.') // main can run it as it always did
    await h.relay.expectFrame(
      'reply',
      (f) =>
        f.message.author === 'system' &&
        f.message.thread_id === 'trip' &&
        /Thread session didn't pick this up/.test(f.message.text ?? ''),
      { direction: 'from_bridge' },
    )
    expect(existsSync(join(h.home, 'workers', 'trip', 'wake'))).toBe(false)
  })

  test('a failed worker falls back too, and says why', async () => {
    await start()
    writeWorkers(h, {
      trip: { state: 'failed', error: { code: 'needs_mac', at: new Date(h.clock.now()).toISOString() } },
      garden: { state: 'live' },
    })
    await h.advance(90_000)
    await offered(3)
    await eventually(() =>
      expect(h.notesOf('schedule_run').find((x) => x.meta.schedule_id === 'trip-digest')?.meta).toMatchObject({
        routed: 'fallback',
        reason: 'needs_mac',
      }),
    )
    await h.relay.expectFrame('reply', (f) => /needs you at the Mac/.test(f.message.text ?? ''), {
      direction: 'from_bridge',
    })
  })

  test('a worker that never reads it: past the deadline main gets it once, and the late worker is told main has it', async () => {
    await start()
    const { trip } = await connected()
    await h.advance(60_000) // the job is offered at 07:30; the worker has not read it
    await offered(3)
    await waitFor(() => existsSync(join(h.home, 'workers', 'trip', 'wake')))
    expect(h.notes.some((n) => n.meta.schedule_id === 'trip-digest')).toBe(false)
    await h.advance(CLAIM_DEADLINE_MS + 5_000)
    await eventually(() =>
      expect(h.notesOf('schedule_run').find((x) => x.meta.schedule_id === 'trip-digest')?.meta.routed).toBe('fallback'),
    )
    const run = h.notesOf('schedule_run').find((x) => x.meta.schedule_id === 'trip-digest')?.meta.run_id as string
    const late = await inbound(trip)
    expect(late.messages).toHaveLength(0)
    expect(late.already_handled_by_main).toContain(run)
    // main runs it; the late worker may not touch the run
    expect(text(await trip.callTool('schedule_run_start', { run_id: run }))).toContain(
      'SKIP: the main session took that run',
    )
    expect(await h.agent.start(run)).toBe('GO')
    expect(h.notesOf('schedule_run').filter((x) => x.meta.schedule_id === 'trip-digest')).toHaveLength(1)
  })

  test("a heartbeat wake stays main's even in a dedicated thread; so does a run with no dedicated thread", async () => {
    await start()
    await connected()
    const router = h.bridge.router
    const ref = { id: 'trip', name: 'Trip' }
    const hb = heartbeatWakeNotification({
      thread: ref,
      runId: 'r_01JBF3V7Q8K2M4N6P8R0S2T4AA',
      jobId: 'trip-heartbeat',
      name: 'Trip check-in',
      hitsPath: '/home/alex/hits.json',
      counts: { total: 1, by_source: { mail: 1 }, left_for_next_wake: 0 },
      ts: new Date(h.clock.now()).toISOString(),
    })
    expect(router?.decide(hb)).toEqual({ to: 'main' })
    const plain = scheduleRunNotification({
      thread: ref,
      runId: 'r_01JBF3V7Q8K2M4N6P8R0S2T4AB',
      jobId: 'trip-digest',
      name: 'Trip Digest',
      ds: undefined,
      fireAt: undefined,
      windowEnds: undefined,
      guard: null,
      prompt: 'x',
      ts: new Date(h.clock.now()).toISOString(),
    })
    expect(router?.decide(plain)).toMatchObject({ to: 'worker', thread: 'trip' })
    expect(router?.decide({ ...plain, meta: { ...plain.meta, thread_id: 'shared_one' } })).toEqual({ to: 'main' })
    expect(router?.decide({ ...plain, meta: { ...plain.meta, thread_id: 'general' } })).toEqual({ to: 'main' })
    // through the real route(): the heartbeat wake reaches main's emit and no worker route is made
    await router?.route(hb)
    expect(h.notes.some((n) => n.meta.run_id === 'r_01JBF3V7Q8K2M4N6P8R0S2T4AA')).toBe(true)
    expect(router?.store.route('r_01JBF3V7Q8K2M4N6P8R0S2T4AA')).toBeUndefined()
  })

  test('a held notice and a non-owner schedule_run are not handed to the worker', async () => {
    await start()
    const router = h.bridge.router
    const base = scheduleRunNotification({
      thread: { id: 'trip', name: 'Trip' },
      runId: 'r_01JBF3V7Q8K2M4N6P8R0S2T4AC',
      jobId: 'trip-digest',
      name: 'Trip Digest',
      ds: undefined,
      fireAt: undefined,
      windowEnds: undefined,
      guard: null,
      prompt: 'x',
      ts: new Date(h.clock.now()).toISOString(),
    })
    expect(router?.decide({ ...base, meta: { ...base.meta, trust: 'external' } })).toEqual({ to: 'main' })
    expect(router?.decide({ ...base, meta: { ...base.meta, kind: 'schedule_held' } })).toEqual({ to: 'main' })
  })
})

describe('the run claim protocol from the worker', () => {
  test('start, reply and done work from the worker; start is repeatable for its own claim, not after done; main records it', async () => {
    await start()
    const { trip, garden } = await connected()
    await h.advance(90_000)
    await offered(3)
    await eventually(() => expect(h.notesOf('schedule_run')).toHaveLength(1))
    const [m] = (await inbound(trip)).messages
    const runId = m?.meta.run_id as string
    // another thread's session cannot start or finish trip's run
    expect(text(await garden.callTool('schedule_run_start', { run_id: runId }))).toContain(
      'SKIP: that run was not handed to this thread session',
    )
    expect(text(await garden.callTool('schedule_run_done', { run_id: runId, ok: true, summary: 'stolen' }))).toContain(
      'not yours',
    )
    expect(text(await trip.callTool('schedule_run_start', { run_id: runId }))).toBe('GO')
    // asking again for a run this session already claimed is GO (its answer may have been lost), never "running elsewhere"
    expect(text(await trip.callTool('schedule_run_start', { run_id: runId }))).toBe('GO')
    const said = await trip.callTool('reply', { thread_id: 'trip', text: 'Trip digest posted.' })
    expect(said.isError).toBeFalsy()
    await h.relay.expectFrame('reply', (f) => f.message.text === 'Trip digest posted.', { direction: 'from_bridge' })
    expect(text(await trip.callTool('schedule_run_done', { run_id: runId, ok: true, summary: 'Posted' }))).toBe(
      'recorded',
    )
    expect(text(await trip.callTool('schedule_run_start', { run_id: runId }))).toContain('already done')
    // main's own list shows the run closed ok
    const one = text(await h.bridge.callTool('schedules_list', { id: 'trip-digest' }))
    expect(one).toMatch(/ok/)
  })

  test('a run id nobody routed, and a bad one, are refused in words', async () => {
    await start()
    const { trip } = await connected()
    expect(text(await trip.callTool('schedule_run_start', { run_id: 'r_NOPE' }))).toContain('SKIP')
    expect(text(await trip.callTool('schedule_run_done', { run_id: 'r_NOPE', ok: true, summary: 'x' }))).toContain(
      'not yours',
    )
    expect((await trip.callTool('schedule_run_start', {})).isError).toBe(true)
  })
})

describe('worker tool scope', () => {
  test("the worker has the four schedule tools; main's are unchanged", async () => {
    await start()
    const trip = await startWorker('trip', false)
    const names = trip.tools.map((t) => t.name)
    expect(names.sort()).toEqual([...WORKER_BRIDGE_TOOLS].sort())
    for (const t of ['schedules_list', 'schedule_propose', 'schedule_run_start', 'schedule_run_done'])
      expect(names).toContain(t)
    expect(h.bridge.tools.map((t) => t.name)).toContain('create_thread')
  })

  test("schedules_list shows only the worker's own thread; main's list shows every job", async () => {
    await start()
    const { trip, garden } = await connected()
    const mine = text(await trip.callTool('schedules_list', {}))
    expect(mine).toContain('trip-digest')
    expect(mine).not.toContain('garden-water')
    expect(mine).not.toContain('main-brief')
    expect(text(await garden.callTool('schedules_list', {}))).not.toContain('trip-digest')
    const all = text(await h.bridge.callTool('schedules_list', {}))
    for (const id of ['trip-digest', 'garden-water', 'main-brief']) expect(all).toContain(id)
    // one job in full: its own yes, another thread's the same words as a job that does not exist
    expect(text(await trip.callTool('schedules_list', { id: 'trip-digest' }))).toContain(
      'Summarise yesterday and post it.',
    )
    const other = await trip.callTool('schedules_list', { id: 'garden-water' })
    const none = await trip.callTool('schedules_list', { id: 'nope' })
    expect(other.isError).toBe(true)
    expect(text(other).replace('garden-water', 'X')).toBe(text(none).replace('nope', 'X'))
  })

  const create = (extra: Record<string, unknown> = {}) => ({
    op: 'create',
    thread_id: 'trip',
    reason: 'The owner asked for a weekly packing check.',
    name: 'Packing Check',
    when: { type: 'weekdays', time: '07:45' },
    prompt: 'Check the packing list and post what is missing.\n',
    ...extra,
  })

  test('a worker cannot propose into another thread, nor a job that runs in another thread', async () => {
    await start()
    const { trip } = await connected()
    const wrongCard = await trip.callTool('schedule_propose', create({ thread_id: 'garden' }))
    expect(wrongCard.isError).toBe(true)
    expect(text(wrongCard)).toContain('Valid thread ids: trip')
    const general = await trip.callTool('schedule_propose', create({ thread_id: 'general' }))
    expect(general.isError).toBe(true)
    const wrongRun = await trip.callTool('schedule_propose', create({ result_thread_id: 'garden' }))
    expect(wrongRun.isError).toBe(true)
    expect(text(wrongRun)).toContain('own thread')
    expect(h.bridge.ctx.ledger.list('pending').filter((r) => r.binding.kind === 'schedule')).toHaveLength(0)
  })

  test("a worker cannot update or delete a job that is not its thread's: another thread's, main's, a heartbeat", async () => {
    await start()
    const { trip } = await connected()
    for (const id of ['garden-water', 'main-brief', 'nope']) {
      for (const op of ['update', 'delete']) {
        const r = await trip.callTool('schedule_propose', {
          op,
          id,
          thread_id: 'trip',
          reason: 'trying',
          ...(op === 'update' ? { name: 'Hijacked' } : {}),
        })
        expect(r.isError, `${op} ${id}`).toBe(true)
        expect(text(r), `${op} ${id}`).toMatch(/not one of this thread's jobs|no scheduled job/)
      }
    }
    // the same call from the worker's own job works
    const mine = await trip.callTool('schedule_propose', {
      op: 'update',
      id: 'trip-digest',
      thread_id: 'trip',
      reason: 'Rename',
      name: 'Trip Digest v2',
    })
    expect(mine.isError, text(mine)).toBeFalsy()
    expect(text(mine)).toMatch(/^card c_/)
    expect(h.bridge.ctx.ledger.list('pending').filter((r) => r.binding.kind === 'schedule')).toHaveLength(1)
    // a heartbeat is main's: refused to create, and an existing one in the thread is neither listed nor changeable
    const hb = await trip.callTool('schedule_propose', create({ meta: { [HEARTBEAT_META_KEY]: { v: 1 } } }))
    expect(hb.isError).toBe(true)
    expect(text(hb)).toContain('heartbeat')
  })

  test("a worker cannot supersede another session's card, and is capped at three waiting cards", async () => {
    await start()
    const { trip, garden } = await connected()
    const theirs = text(
      await garden.callTool('schedule_propose', { ...create({ name: 'Water Plants', thread_id: 'garden' }) }),
    )
    const theirCard = /card (c_\S+) pending/.exec(theirs)?.[1]
    expect(theirCard).toBeDefined()
    const steal = await trip.callTool('schedule_propose', create({ supersedes: theirCard }))
    expect(steal.isError).toBe(true)
    expect(text(steal)).toContain('own pending')
    for (const n of ['One', 'Two', 'Three'])
      expect((await trip.callTool('schedule_propose', create({ name: `Check ${n}` }))).isError, n).toBeFalsy()
    const fourth = await trip.callTool('schedule_propose', create({ name: 'Check Four' }))
    expect(fourth.isError).toBe(true)
    expect(text(fourth)).toContain('3 schedule cards')
    // garden still can: the cap is per session
    expect(
      (await garden.callTool('schedule_propose', create({ name: 'Water More', thread_id: 'garden' }))).isError,
    ).toBeFalsy()
  })

  test('the whole way: propose, approve the card, the job fires in that session, it reports done', async () => {
    await start()
    const { trip } = await connected()
    const res = await trip.callTool('schedule_propose', create({ when: { type: 'daily', time: '07:40' } }))
    expect(res.isError, text(res)).toBeFalsy()
    const id = /card (c_\S+) pending/.exec(text(res))?.[1]
    const cc = await h.app.expectFrame('card.create', (c) => c.card.id === id, { direction: 'in' })
    const card = cc.card as CardT
    // the card lands in the proposing thread and says who wants what, where it runs, when, and what it does
    expect(card.thread_id).toBe('trip')
    expect(card.title).toBe("Trip's session wants to schedule Packing Check")
    expect(card.primary_label).toBe('Approve')
    expect(card.kill_label).toBe('Not now')
    const rows = Object.fromEntries(card.destination.map((d) => [d.label, d.value]))
    expect(rows['Runs in']).toBe(
      "This thread's own session (wakes it if parked), or Main if that session can't take it",
    )
    expect(rows.As).toMatch(/permissions/i)
    expect(rows.When).toMatch(/7:40/)
    expect(rows.Does).toBe('Check the packing list and post what is missing.')
    expect(rows['Proposed by']).toBe("Trip's session")
    expect(rows['Posts to']).toBe('Trip')
    const payload = ScheduleCardPayload.parse(card.payload)
    expect(payload.proposed_by).toBe('agent')
    expect(payload.change.op === 'create' && payload.change.draft.thread_id).toBe('trip')
    // nothing is written until the owner approves
    expect(h.box.api<{ schedules: Array<{ id: string }> }>(['snapshot']).schedules.map((s) => s.id)).not.toContain(
      'packing-check',
    )
    await h.app.resolveCard(card, 'primary', card.payload_hash, { stepup_token: h.relay.mintStepup(`card:${card.id}`) })
    await h.app.expectFrame('card.update', (u) => u.card_id === card.id && u.state === 'done', { direction: 'in' })
    expect(h.bridge.ctx.schedules?.sidecar.threadOf('packing-check')).toBe('trip')
    await h.advance(15 * 60_000)
    let runId = ''
    for (let i = 0; i < 100 && !runId; i++) {
      for (const m of (await inbound(trip)).messages)
        if (m.meta.schedule_id === 'packing-check') runId = m.meta.run_id as string
      if (!runId) await sleep(100)
    }
    expect(runId).toMatch(/^r_/)
    expect(text(await trip.callTool('schedule_run_start', { run_id: runId }))).toBe('GO')
    expect(
      text(await trip.callTool('schedule_run_done', { run_id: runId, ok: true, summary: 'Packing list checked' })),
    ).toBe('recorded')
    expect(h.notes.some((n) => n.meta.schedule_id === 'packing-check')).toBe(false)
  })

  test("switched back to shared: the session's schedule requests are refused and the job is main's again", async () => {
    await start()
    const { trip } = await connected()
    h.bridge.ctx.config.update((c) => ({
      ...c,
      threads: c.threads.map((t) => (t.id === 'trip' ? { ...t, session: 'shared' } : t)),
    }))
    const r = await trip.callTool('schedules_list', {})
    expect(r.isError).toBe(true)
    expect(text(r)).toContain('no longer has its own session')
    await h.advance(90_000)
    await offered(3)
    await eventually(() => expect(h.notesOf('schedule_run').map((n) => n.meta.schedule_id)).toContain('trip-digest'))
  })

  test('switched back to shared mid-run: the run the session already claimed can still be finished, a new start cannot', async () => {
    await start()
    const { trip } = await connected()
    await h.advance(90_000)
    await offered(3)
    const [m] = (await inbound(trip)).messages
    const runId = m?.meta.run_id as string
    expect(text(await trip.callTool('schedule_run_start', { run_id: runId }))).toBe('GO')
    h.bridge.ctx.config.update((c) => ({
      ...c,
      threads: c.threads.map((t) => (t.id === 'trip' ? { ...t, session: 'shared' } : t)),
    }))
    expect(
      text(await trip.callTool('schedule_run_done', { run_id: runId, ok: true, summary: 'Finished after the switch' })),
    ).toBe('recorded')
    const again = await trip.callTool('schedule_run_start', { run_id: runId })
    expect(again.isError).toBe(true)
    expect(text(again)).toContain('no longer has its own session')
  })

  test('a scheduler that is switched off gives the worker no schedule tools', async () => {
    await start()
    const off = await Bridge.create({
      env: loadEnv({
        TALOS_APP_HOME: h.home,
        TALOS_APP_RELAY_URL: h.relay.httpUrl,
        TALOS_APP_WORKER_THREAD: 'trip',
        TALOS_APP_WORKER_NONCE: NONCE,
        TALOS_APP_SCHEDULER: 'off',
      }),
      logger: nullLogger,
    })
    workers.push(off)
    expect(off.tools.map((t) => t.name).filter((n) => n.startsWith('schedule'))).toEqual([])
  })
})

describe('the hub socket for schedule requests', () => {
  test('a connection that never said hello cannot ask', async () => {
    await start()
    const sock = createConnection(join(h.home, 'hub.sock'))
    const lines: string[] = []
    sock.setEncoding('utf8')
    sock.on('data', (d: string) => lines.push(d))
    await new Promise((r) => sock.on('connect', r))
    sock.write(`${JSON.stringify({ t: 'rpc', id: 'x', tool: 'schedules_list', args: {} })}\n`)
    await eventually(() => expect(lines.join('')).toContain('unauthorized'))
    sock.destroy()
  })

  test("the thread is the connection's: a request that names another thread in its args gets its own", async () => {
    await start()
    const { trip } = await connected()
    const r = await trip.hubClient?.rpc('schedules_list', { thread_id: 'garden', id: 'garden-water' })
    expect(r?.ok).toBe(false)
    expect(r?.text).toContain('no scheduled job')
  })

  test('an unknown tool is one refused answer, not a dropped line', async () => {
    await start()
    const { trip } = await connected()
    const r = await trip.hubClient?.rpc('schedules_nuke', {})
    expect(r).toEqual({ ok: false, text: 'unknown tool schedules_nuke' })
    expect((await trip.hubClient?.rpc('schedules_list', {}))?.ok).toBe(true) // the connection is still good
  })

  test('hub down or silent reads as a failure in words, never an empty answer', async () => {
    await start()
    const down = new HubClient({ sockPath: join(h.home, 'nope.sock'), threadId: 'trip', nonce: NONCE, log: nullLogger })
    const r = await down.rpc('schedules_list', {})
    expect(r.ok).toBe(false)
    expect(r.text).toContain("isn't reachable")
    // a hub that never answers
    const { createServer } = await import('node:net')
    const path = join(h.home, 'silent.sock')
    const srv = createServer((s) => {
      s.on('data', (d) => {
        if (String(d).includes('"hello"')) s.write(`${JSON.stringify({ t: 'welcome', thread_id: 'trip' })}\n`)
      })
    })
    await new Promise<void>((res) => srv.listen(path, () => res()))
    const quiet = new HubClient({ sockPath: path, threadId: 'trip', nonce: NONCE, log: nullLogger })
    expect(await quiet.connect()).toBe(true)
    const slow = await quiet.rpc('schedules_list', {}, 150)
    expect(slow.ok).toBe(false)
    expect(slow.text).toContain('did not answer in time')
    expect(slow.text).toContain('schedules_list')
    quiet.close()
    srv.close()
    await sleep(10)
  })
})

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
  test('R1-1: a worker cannot ask for a background runner, other permissions or a tool list; nothing is proposed', async () => {
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
  })

  test("R1-1: a background job in the thread is not the session's: not listed, not changeable, never routed to it", async () => {
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
  })

  test("R1-3 / R1-11: a worker supersedes only its own cards; main's cards in its thread are not its to replace or count", async () => {
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
  })

  test("R1-10: the lanes have their own allowance: a full worker does not stop main, and main's cards do not stop a worker", async () => {
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
  })

  test("R1-4: approving a worker's delete or change after the job moved to another thread changes nothing", async () => {
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
  })

  test('R1-4: the same cards still apply while the job stays in the thread', async () => {
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
  })

  test('R1-1: a card whose proposer row is missing cannot change a session job: nothing changes, and the owner is told', async () => {
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
  })

  test("R1-1: main's own card records 'main' and still applies to a session job", async () => {
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
  })
})

describe('review round 1: delivery', () => {
  test('R1-6: an older worker (its hello names no schedule capability) is never handed a run; main gets it, nothing is lost', async () => {
    await start()
    writeWorkers(h, live())
    writeNonce(h.home, 'trip', NONCE)
    const old = new HubClient({
      sockPath: join(h.home, 'hub.sock'),
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
  })

  test('R1-6: a worker that names the capability is handed the run', async () => {
    await start()
    const { trip } = await connected()
    expect(h.bridge.hub?.featuresOf('trip')).toContain('schedules/1')
    await h.advance(90_000)
    await offered(3)
    await eventually(() => expect(h.notes.some((n) => n.meta.schedule_id === 'trip-digest')).toBe(false))
    expect((await inbound(trip)).messages.map((m) => m.meta.schedule_id)).toContain('trip-digest')
  })

  test('R1-6: against an older hub that refuses a hello with extra fields, the worker says hello the old way', async () => {
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
  })

  test('R1-7: a run finished with done(ok) and no reply leaves no "stopped before it finished" notice when the session parks', async () => {
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
    await sleep(400)
    h.bridge.optionCTick()
    await sleep(400)
    expect(
      h.relay.frames.some((r) => r.direction === 'from_bridge' && /stopped before it/.test(JSON.stringify(r.frame))),
    ).toBe(false)
  })

  test('R1-7: a session that parks without finishing the run does leave the plain notice', async () => {
    await start()
    const { trip } = await connected()
    await h.advance(90_000)
    await offered(3)
    const [m] = (await inbound(trip)).messages
    expect(m).toBeDefined()
    writeWorkers(h, { trip: { state: 'parked' }, garden: { state: 'live' } })
    h.bridge.optionCTick()
    await h.relay.expectFrame('reply', (f) => /stopped before it finished a scheduled job/.test(f.message.text ?? ''), {
      direction: 'from_bridge',
    })
  })

  test('R1-8: an answer that never comes says what to do next, per tool', async () => {
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
  })
})

describe('review round 2', () => {
  test('R2-1: a session job with restricted permissions runs headless: not the session\'s to list or change, not routed, never "own session"', async () => {
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
  })

  test('R2-2: a retry of schedule_run_start while the first is still queued answers GO, not SKIP', async () => {
    await start()
    const { trip } = await connected()
    await h.advance(90_000)
    await offered(3)
    const [m] = (await inbound(trip)).messages
    const runId = m?.meta.run_id as string
    const [a, b, c] = await Promise.all([1, 2, 3].map(() => trip.callTool('schedule_run_start', { run_id: runId })))
    expect([text(a as never), text(b as never), text(c as never)]).toEqual(['GO', 'GO', 'GO'])
    expect(text(await trip.callTool('schedule_run_done', { run_id: runId, ok: true, summary: 'ok' }))).toBe('recorded')
  })
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

  test('declined: the proposer row is removed', async () => {
    await start()
    const { trip } = await connected()
    const card = await propose(trip)
    expect(proposerRow(card.id)).toBe('trip')
    await h.app.resolveCard(card, 'kill', card.payload_hash)
    await eventually(() => expect(proposerRow(card.id)).toBeUndefined())
  })

  test('approved and applied: the proposer row is removed', async () => {
    await start()
    const { trip } = await connected()
    const card = await propose(trip, { when: { type: 'daily', time: '07:40' } })
    await h.app.resolveCard(card, 'primary', card.payload_hash, { stepup_token: h.relay.mintStepup(`card:${card.id}`) })
    await h.app.expectFrame('card.update', (u) => u.card_id === card.id && u.state === 'done', { direction: 'in' })
    await eventually(() => expect(proposerRow(card.id)).toBeUndefined())
  })

  test('expired: the proposer row is removed', async () => {
    await start()
    const { trip } = await connected()
    const card = await propose(trip)
    expect(proposerRow(card.id)).toBe('trip')
    await h.advance(Date.parse(card.expires_at) - h.clock.now() + 2000)
    await h.app.expectFrame('card.update', (u) => u.card_id === card.id && u.state === 'expired', { direction: 'in' })
    await eventually(() => expect(proposerRow(card.id)).toBeUndefined())
  })

  test('replaced: the old card loses its row, the new one has its own', async () => {
    await start()
    const { trip } = await connected()
    const old = await propose(trip)
    const next = await propose(trip, { supersedes: old.id })
    await eventually(() => expect(proposerRow(old.id)).toBeUndefined())
    expect(proposerRow(next.id)).toBe('trip')
  })

  test('a run: the started row is there while it is open and gone when it is done', async () => {
    await start()
    const { trip } = await connected()
    await h.advance(90_000)
    await offered(3)
    const [m] = (await inbound(trip)).messages
    const runId = m?.meta.run_id as string
    expect(text(await trip.callTool('schedule_run_start', { run_id: runId }))).toBe('GO')
    expect(startedRow(runId)).toBe('trip')
    expect(text(await trip.callTool('schedule_run_done', { run_id: runId, ok: true, summary: 'ok' }))).toBe('recorded')
    expect(startedRow(runId)).toBeUndefined()
    // a late start for the closed run is still answered in words
    expect(text(await trip.callTool('schedule_run_start', { run_id: runId }))).toContain('already done')
  })

  test('a restart sweeps rows of unknown, finished and week-old things and keeps a card that still waits', async () => {
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
  })
})
