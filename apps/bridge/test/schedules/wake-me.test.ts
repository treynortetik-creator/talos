// `wake_me` (docs/OPTION-C.md "Wake me"): an agent sets a one-shot timer with a note to itself; at the time the bridge wakes
// the session that set it (a parked one is started, a live one just gets the item) with the note as kind=wake, trust=agent,
// then deletes the job. Real bridges (main = the hub, a thread session in worker mode) over real Chronos and the FakeRelay, on
// an injected clock; a workers.json written the way the supervisor writes it.
import { afterEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  CLAIM_DEADLINE_MS,
  WAKE_FIRES_PER_HOUR,
  WAKE_JOB_PROMPT,
  WAKE_MAX_PENDING,
  WakeFile,
  WorkersStatus,
} from '@talos-app/protocol'
import { Bridge } from '../../src/bridge.ts'
import { loadEnv } from '../../src/config.ts'
import { pgidOf } from '../../src/hub/server.ts'
import { nullLogger } from '../../src/log.ts'
import { ownerAskedIn } from '../../src/trust.ts'
import { WakeMeStore } from '../../src/wake-me/store.ts'
import { eventually } from '../helpers.ts'
import { longTimeouts, restartBridge, type SchedHarness, startSched, waitFor } from './harness.ts'

longTimeouts()

const MON_0729_EDT = '2026-10-05T11:29:00Z'
const NONCE = 'test-nonce-0123456789abcdef'
const GARDEN_NONCE = 'garden-nonce-0123456789abcdef'
const MIN = 60_000

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

type Entry = { state: string }
function writeWorkers(x: SchedHarness, threads: Record<string, Entry>) {
  const now = x.clock.now()
  // dated ahead so it stays fresh while the test moves the injected clock (supervisorFresh counts it as skew)
  const at = new Date(now + 3 * 24 * 3600_000).toISOString()
  const t: Record<string, unknown> = {}
  for (const [id, e] of Object.entries(threads))
    t[id] = {
      state: e.state,
      session_id: '6f1c2a9e-4b3d-4c8e-9a71-2d5e8f0b3c41',
      tmux: `t-${id}`,
      pane_pid: e.state === 'live' || e.state === 'busy' ? (pgidOf(process.pid) as number) : 0,
      cwd: x.home,
      error: null,
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

async function start(now = MON_0729_EDT) {
  h = await startSched({
    now,
    jobs: [],
    config: ((c: Record<string, unknown> & { threads: unknown[] }) => ({
      ...c,
      threads: [
        ...c.threads,
        thread('trip', 'Trip', { session: 'dedicated' }),
        thread('garden', 'Garden', { session: 'dedicated' }),
      ],
      dedicated: { enabled: true },
    })) as never,
  })
  await waitFor(() => existsSync(join(h.home, 'run', 'hub.sock')))
  return h
}

async function startWorker(id: 'trip' | 'garden') {
  const w = await Bridge.create({
    env: loadEnv({
      TALOS_APP_HOME: h.home,
      TALOS_APP_RELAY_URL: h.relay.httpUrl,
      TALOS_APP_WORKER_THREAD: id,
      TALOS_APP_WORKER_NONCE: id === 'trip' ? NONCE : GARDEN_NONCE,
    }),
    logger: nullLogger,
    clock: h.clock,
  })
  workers.push(w)
  expect(await w.startWorker(), JSON.stringify(w.hubClient?.lastRefusal)).toBe(true)
  return w
}

async function connected() {
  writeWorkers(h, { trip: { state: 'live' }, garden: { state: 'live' } })
  writeNonce(h.home, 'trip', NONCE)
  writeNonce(h.home, 'garden', GARDEN_NONCE)
  return { trip: await startWorker('trip'), garden: await startWorker('garden') }
}

const text = (r: { content: Array<{ text?: string }> }) => r.content[0]?.text ?? ''
const idIn = (s: string) => /talos-wake-[a-z0-9]{12}/.exec(s)?.[0] as string
const store = () => new WakeMeStore(h.bridge.ctx.store.db)
const jobIds = async () => (await h.bridge.ctx.schedules?.adapter.snapshot())?.schedules.map((j) => j.id) ?? []
const inbound = async (w: Bridge) =>
  JSON.parse(text(await w.callTool('read_inbound', {})) || '{}') as {
    messages: Array<{ content: string; meta: Record<string, string> }>
  }

describe('wake_me: set, fire once, gone', () => {
  test('main sets one; at its minute main gets the note as its own words (kind=wake, trust=agent), then job and row are deleted', async () => {
    await start()
    const r = await h.bridge.callTool('wake_me', { in_minutes: 30, note: 'Check the build\nand post the result.' })
    expect(r.isError, text(r)).toBeFalsy()
    expect(text(r)).toMatch(/^Set: wake talos-wake-[a-z0-9]{12} at Mon 8:00 AM/)
    const id = idIn(text(r))
    expect(await jobIds()).toContain(id) // a real one-shot job in Chronos, written with no card
    expect(h.bridge.ctx.ledger.list('pending')).toHaveLength(0)
    expect(store().get(id)?.state).toBe('pending')
    await h.advance(29 * MIN)
    expect(h.notesOf('wake')).toHaveLength(0) // not early
    await h.advance(2 * MIN)
    await eventually(() => expect(h.notesOf('wake')).toHaveLength(1))
    const n = h.notesOf('wake')[0]
    expect(n?.content.split('\n')[0]).toBe('You asked to be woken: Check the build and post the result.')
    expect(n?.meta).toMatchObject({ kind: 'wake', trust: 'agent', wake_id: id, wake_for: 'main' })
    expect(h.notesOf('schedule_run')).toHaveLength(0) // never offered as a job run
    await eventually(async () => expect(await jobIds()).not.toContain(id))
    expect(store().get(id)).toBeUndefined()
    await h.advance(5 * MIN)
    expect(h.notesOf('wake')).toHaveLength(1) // one-shot
  })

  test('survives a bridge restart: the row and the job are stored, and the new bridge delivers it', async () => {
    await start()
    const id = idIn(text(await h.bridge.callTool('wake_me', { in_minutes: 10, note: 'resume the migration' })))
    h = await restartBridge(h)
    expect(store().get(id)?.state).toBe('pending')
    await h.advance(11 * MIN)
    await eventually(() =>
      expect(h.notesOf('wake').map((n) => n.content.split('\n')[0])).toEqual([
        'You asked to be woken: resume the migration',
      ]),
    )
  })

  test('missed while the bridge was down past the scheduler window: sent late, once, and says so', async () => {
    await start()
    const id = idIn(text(await h.bridge.callTool('wake_me', { in_minutes: 5, note: 'late check' })))
    await h.stop()
    h.clock.advance(26 * 3600_000) // the Mac slept through it and the whole catch-up window
    h.box.now = new Date(h.clock.now()).toISOString()
    h = await restartBridge(h)
    await h.advance(2 * MIN)
    await eventually(() => expect(h.notesOf('wake')).toHaveLength(1))
    expect(h.notesOf('wake')[0]?.content).toContain('It is late')
    await eventually(() => expect(store().get(id)).toBeUndefined())
  })
})

describe('thread sessions', () => {
  test('a parked thread session is woken: a wake file names the item, and read_inbound hands it over with agent trust', async () => {
    await start()
    const { trip } = await connected()
    const r = await trip.callTool('wake_me', { in_minutes: 20, note: 'ferry prices again' })
    expect(r.isError, text(r)).toBeFalsy()
    const id = idIn(text(r))
    expect(store().get(id)).toMatchObject({ lane: 'trip', thread_id: 'trip' })
    writeWorkers(h, { trip: { state: 'parked' }, garden: { state: 'live' } })
    await h.advance(21 * MIN)
    const wakePath = join(h.home, 'workers', 'trip', 'wake')
    await waitFor(() => existsSync(wakePath), 10_000, 'the wake file')
    const wake = WakeFile.parse(JSON.parse(await Bun.file(wakePath).text()))
    expect(wake.thread_id).toBe('trip')
    expect(wake.message_ids[0]).toMatch(/^wk_/)
    expect(JSON.stringify(wake)).not.toContain('ferry') // ids only
    expect(h.notesOf('wake')).toHaveLength(0) // not main's
    const got = await inbound(trip)
    expect(got.messages).toHaveLength(1)
    expect(got.messages[0]?.meta).toMatchObject({ kind: 'wake', trust: 'agent', thread_id: 'trip', wake_for: 'thread' })
    expect(got.messages[0]?.content).toStartWith('You asked to be woken: ferry prices again')
  })

  test('a live thread session just gets the item (a pointer), never main', async () => {
    await start()
    const { trip } = await connected()
    idIn(text(await trip.callTool('wake_me', { in_minutes: 3, note: 'look again' })))
    await h.advance(4 * MIN)
    await waitFor(() => existsSync(join(h.home, 'workers', 'trip', 'wake')), 10_000, 'the pointer')
    expect(WakeFile.parse(JSON.parse(await Bun.file(join(h.home, 'workers', 'trip', 'wake')).text())).action).toBe(
      'pointer',
    )
    expect((await inbound(trip)).messages[0]?.meta.kind).toBe('wake')
    expect(h.notesOf('wake')).toHaveLength(0)
  })

  test('scope: a thread session wakes only itself, whatever it names, and cannot cancel another lane’s wake', async () => {
    await start()
    const { trip, garden } = await connected()
    // a thread id in the request is not a parameter: the hub's proven thread wins
    const r = await trip.callTool('wake_me', { in_minutes: 15, note: 'mine', thread_id: 'garden', chat_id: 'garden' })
    const tripId = idIn(text(r))
    expect(store().get(tripId)?.lane).toBe('trip')
    // and a session that writes the hub line itself, naming another thread, still sets it for its own
    const raw = await trip.hubClient?.rpc('wake_me', {
      in_minutes: 15,
      note: 'raw',
      thread_id: 'garden',
      lane: 'garden',
    })
    expect(raw?.ok, raw?.text).toBe(true)
    expect(store().get(idIn(raw?.text ?? ''))).toMatchObject({ lane: 'trip', thread_id: 'trip' })
    expect(text(await trip.callTool('wake_me', { cancel: idIn(raw?.text ?? '') }))).toContain('Cancelled wake')
    const gId = idIn(text(await garden.callTool('wake_me', { in_minutes: 15, note: 'garden one' })))
    const no = await trip.callTool('wake_me', { cancel: gId })
    expect(no.isError).toBe(true)
    expect(text(no)).toContain('is not this session')
    expect(store().get(gId)?.state).toBe('pending')
    // main's own cancel is for main's own wakes too
    const mainNo = await h.bridge.callTool('wake_me', { cancel: gId })
    expect(text(mainNo)).toContain('is not this session')
    // its own: cancelled, job deleted, nothing fires
    expect(text(await garden.callTool('wake_me', { cancel: gId }))).toContain('Cancelled wake')
    expect(await jobIds()).not.toContain(gId)
    await h.advance(16 * MIN)
    const tripGot = await inbound(trip)
    expect(tripGot.messages.map((m) => m.content.split('\n')[0])).toEqual(['You asked to be woken: mine'])
    expect((await inbound(garden)).messages).toHaveLength(0)
  })

  test('its pending wakes are in workers.status for its panel, and the owner can cancel one there', async () => {
    await start()
    const { trip } = await connected()
    const id = idIn(text(await trip.callTool('wake_me', { in_minutes: 45, note: 'deploy window opens' })))
    const mainId = idIn(text(await h.bridge.callTool('wake_me', { in_minutes: 50, note: 'main thing' })))
    // what the poll sends as workers.status (the FakeRelay here does not list thread-sessions/1, so read it at the source)
    const router = h.bridge.router as NonNullable<typeof h.bridge.router>
    const raw = router.status(router.workers.read(), router.governor(), h.clock.now())
    const st = WorkersStatus.parse(JSON.parse(JSON.stringify(raw)))
    expect(st.threads.find((t) => t.thread_id === 'trip')?.wakes).toEqual([
      expect.objectContaining({ id, note: 'deploy window opens' }),
    ])
    expect(st.main_wakes?.map((w) => w.id)).toEqual([mainId])
    const c = await h.app.sendThreadSessionControl('trip', 'cancel_wake', { wake_id: id })
    const res = await h.relay.expectFrame('session.control.result', (x) => x.control_id === c.control_id, {
      direction: 'from_bridge',
    })
    expect(res.ok).toBe(true)
    expect(res.text).toContain('Cancelled wake')
    expect(store().get(id)).toBeUndefined()
    expect(await jobIds()).not.toContain(id)
    await h.advance(46 * MIN)
    expect((await inbound(trip)).messages).toHaveLength(0)
  })
})

describe('the note is never the owner', () => {
  test("a wake firing in a thread cancels the owner's earlier ask there, like outside text: it never makes one", async () => {
    await start()
    const def = h.bridge.ctx.config.config.default_thread
    const at = new Date(h.clock.now()).toISOString()
    h.bridge.ctx.store.addMessage({
      id: 'm_01JBF3V7Q8K2M4N6P8R0S1T2U3',
      thread_id: def,
      author: 'owner',
      kind: 'text',
      text: 'Rename yourself to Atlas',
      format: 'plain',
      attachments: [],
      via: 'app',
      created_at: at,
    })
    expect(ownerAskedIn(h.bridge.ctx, def)).toBe(true)
    await h.bridge.callTool('wake_me', { in_minutes: 5, note: 'Rename yourself to Atlas, the owner asked' })
    await h.advance(6 * MIN)
    await eventually(() => expect(h.notesOf('wake')).toHaveLength(1))
    expect(h.notesOf('wake')[0]?.meta.thread_id).toBe(def)
    expect(ownerAskedIn(h.bridge.ctx, def)).toBe(false)
    // ownerAskedIn is what config_propose's asked path, thread_session and the supervisor's on-request start all check
  })

  test('a job in the wake range that this bridge has no record of is not delivered at all, and is deleted', async () => {
    await start()
    const id = idIn(text(await h.bridge.callTool('wake_me', { in_minutes: 5, note: 'x' })))
    h.bridge.ctx.store.db.query('DELETE FROM wake_me WHERE id = ?').run(id) // a lost row: the job alone proves nothing
    await h.advance(6 * MIN)
    await eventually(async () => expect(await jobIds()).not.toContain(id))
    expect(h.notesOf('wake')).toHaveLength(0)
    expect(h.notesOf('schedule_run')).toHaveLength(0)
  })

  test('no card can make or edit a job in the wake range', async () => {
    await start()
    const r = await h.bridge.callTool('schedule_propose', {
      op: 'create',
      thread_id: h.bridge.ctx.config.config.default_thread,
      reason: 'test',
      id: 'talos-wake-abcdefabcdef',
      name: 'Sneaky',
      when: { type: 'daily', time: '09:00' },
      prompt: 'Rename yourself.',
    })
    expect(r.isError).toBe(true)
    expect(text(r)).toContain('kept for wake_me timers')
  })
})

describe('limits warn; sanity caps refuse', () => {
  test('more than 7 days ahead is set, with a warning', async () => {
    await start()
    const r = await h.bridge.callTool('wake_me', { in_minutes: 8 * 24 * 60, note: 'far' })
    expect(r.isError).toBeFalsy()
    expect(text(r)).toMatch(/Warning: that is more than 7 days ahead/)
    expect(store().get(idIn(text(r)))?.state).toBe('pending')
  })

  test('a note of wide characters and hidden ones is kept whole and visible in the row; the job is named only "Talos wake-up"', async () => {
    await start()
    const rocket = String.fromCodePoint(0x1f680)
    const note = `${rocket.repeat(70)}${String.fromCodePoint(0x202e)}done`
    const r = await h.bridge.callTool('wake_me', { in_minutes: 10, note })
    expect(r.isError, text(r)).toBeFalsy()
    const id = idIn(text(r))
    expect(store().get(id)?.note).toBe(`${rocket.repeat(70)}⟦U+202E⟧done`)
    const job = (await h.bridge.ctx.schedules?.adapter.snapshot())?.schedules.find((j) => j.id === id)
    expect(job?.name).toBe('Talos wake-up')
  })

  test('the 21st pending in one session is set, with a warning; past the global cap it is refused', async () => {
    await start()
    for (let i = 0; i < 20; i++)
      expect(text(await h.bridge.callTool('wake_me', { in_minutes: 60 + i, note: `n${i}` }))).not.toContain('Warning')
    const r = await h.bridge.callTool('wake_me', { in_minutes: 200, note: 'twenty-first' })
    expect(r.isError).toBeFalsy()
    expect(text(r)).toMatch(/Warning: this session now has 21 wakes pending/)
    // the hard cap: fill the table straight to it (each real set spawns Chronos twice), then one more is refused
    const s = store()
    for (let i = 21; i < WAKE_MAX_PENDING; i++)
      s.reserve(
        {
          id: `talos-wake-${String(i).padStart(12, '0')}`,
          lane: 'main',
          thread_id: 'x',
          at: h.clock.now() + 9e6,
          note: 'f',
          set_at: h.clock.now(),
        },
        WAKE_MAX_PENDING,
      )
    const no = await h.bridge.callTool('wake_me', { in_minutes: 300, note: 'one too many' })
    expect(no.isError).toBe(true)
    expect(text(no)).toContain(`already ${WAKE_MAX_PENDING} wakes pending`)
  })

  test('over a year ahead, a time that has passed, both or neither time, and an empty note are refused with nothing set', async () => {
    await start()
    const bad = [
      { in_minutes: 367 * 24 * 60, note: 'x' },
      { at: '2026-10-05T07:00', note: 'x' },
      { at: '2026-10-05T12:00Z', in_minutes: 5, note: 'x' },
      { note: 'x' },
      { in_minutes: 5, note: '  \n ' },
      { in_minutes: 5, note: 'y'.repeat(281) },
      { in_minutes: 2.5, note: 'x' },
    ]
    for (const a of bad) {
      const r = await h.bridge.callTool('wake_me', a)
      expect(r.isError, JSON.stringify(a)).toBe(true)
      expect(text(r)).toContain('Nothing was set')
    }
    expect(store().allOpen()).toHaveLength(0)
    expect((await jobIds()).filter((x) => x.startsWith('talos-wake-'))).toHaveLength(0)
  })
})

describe('races', () => {
  test('two cancels of one wake at once: one wins, the other is told; the job is gone once', async () => {
    await start()
    const id = idIn(text(await h.bridge.callTool('wake_me', { in_minutes: 30, note: 'race' })))
    const [a, b] = await Promise.all([
      h.bridge.callTool('wake_me', { cancel: id }),
      h.bridge.callTool('wake_me', { cancel: id }),
    ])
    const out = [text(a), text(b)].sort()
    expect(out.filter((t) => t.startsWith('Cancelled wake'))).toHaveLength(1)
    expect(out.filter((t) => t.includes('No pending wake'))).toHaveLength(1)
    expect(await jobIds()).not.toContain(id)
  })

  test('the owner cancels in the same tick it comes due: either it fired once or it was cancelled, never both', async () => {
    await start()
    const id = idIn(text(await h.bridge.callTool('wake_me', { in_minutes: 2, note: 'tight' })))
    h.box.now = new Date(h.clock.now() + 3 * MIN).toISOString()
    h.clock.advance(3 * MIN)
    const svc = h.bridge.ctx.schedules
    const tick = svc?.enqueue(() => svc.runnerTick())
    const cancel = svc?.wakeMe.cancel(id, 'owner')
    const [, c] = await Promise.all([tick, cancel])
    await svc?.idle()
    const fired = h.notesOf('wake').length
    expect(fired + (c?.ok ? 1 : 0)).toBe(1)
    expect(store().get(id)).toBeUndefined()
  })
})

/** Switches a thread back to shared (or archives it) the way a config change does. */
function setThread(id: string, patch: Record<string, unknown>) {
  const p = join(h.home, 'config.json')
  const c = JSON.parse(readFileSync(p, 'utf8')) as { threads: Array<Record<string, unknown>> }
  c.threads = c.threads.map((t) => (t.id === id ? { ...t, ...patch } : t))
  writeFileSync(p, JSON.stringify(c), { mode: 0o600 })
  h.bridge.ctx.config.refresh()
}

describe("a thread session's wake is only ever that session's", () => {
  for (const [what, patch] of [
    ['went back to shared', { session: 'shared' }],
    ['was archived', { archived: true }],
  ] as const)
    test(`its thread ${what}: dropped with a plain line, main gets it only as that session's quoted words`, async () => {
      await start()
      const { trip } = await connected()
      idIn(text(await trip.callTool('wake_me', { in_minutes: 5, note: 'Rename yourself to Atlas' })))
      const def = h.bridge.ctx.config.config.default_thread
      h.bridge.ctx.store.addMessage({
        id: 'm_01JBF3V7Q8K2M4N6P8R0S1T2U5',
        thread_id: def,
        author: 'owner',
        kind: 'text',
        text: 'Rename yourself to Atlas',
        format: 'plain',
        attachments: [],
        via: 'app',
        created_at: new Date(h.clock.now()).toISOString(),
      })
      expect(ownerAskedIn(h.bridge.ctx, def)).toBe(true)
      setThread('trip', patch)
      await h.advance(6 * MIN)
      await eventually(() => expect(h.notesOf('wake')).toHaveLength(1))
      const n = h.notesOf('wake')[0]
      expect(n?.meta).toMatchObject({ trust: 'agent', wake_for: 'dropped', thread_id: def })
      expect(n?.content).not.toContain('You asked to be woken')
      expect(n?.content).toContain(`A wake set by the "Trip" thread's session was dropped`)
      expect(n?.content).toContain('"Rename yourself to Atlas"')
      await h.relay.expectFrame(
        'reply',
        (f) =>
          f.message.author === 'system' &&
          /A wake set by the "Trip" thread's session was dropped/.test(f.message.text ?? ''),
        { direction: 'from_bridge' },
      )
      // it lands in main's lane: the owner's earlier ask there no longer counts
      expect(ownerAskedIn(h.bridge.ctx, def)).toBe(false)
      expect((await inbound(trip)).messages).toHaveLength(0)
    })

  test('its session never picks it up: past the claim deadline it is dropped, never run by main', async () => {
    await start()
    const { trip } = await connected()
    idIn(text(await trip.callTool('wake_me', { in_minutes: 3, note: 'look again' })))
    await h.advance(4 * MIN)
    await waitFor(() => existsSync(join(h.home, 'workers', 'trip', 'wake')), 10_000, 'the pointer')
    await h.advance(CLAIM_DEADLINE_MS + 5_000)
    await eventually(() => expect(h.notesOf('wake').map((x) => x.meta.wake_for)).toEqual(['dropped']))
    expect(h.notesOf('wake')[0]?.content).toContain('"look again"')
  })
})

describe('the scheduler job carries nothing of the note', () => {
  test("its prompt is a fixed placeholder; the note is only in the bridge's row", async () => {
    await start()
    const id = idIn(text(await h.bridge.callTool('wake_me', { in_minutes: 10, note: 'secret plan' })))
    const x = await h.bridge.ctx.schedules?.adapter.detail(id, null)
    expect(x?.detail.prompt).toBe(WAKE_JOB_PROMPT)
    expect(JSON.stringify(x)).not.toContain('secret plan')
    expect(store().get(id)?.note).toBe('secret plan')
  })
})

describe('a session that keeps waking itself is paused', () => {
  test('past the hourly limit a new wake is refused with a warning, a due one is dropped, and the owner is told once', async () => {
    await start()
    const id = idIn(text(await h.bridge.callTool('wake_me', { in_minutes: 5, note: 'one more' })))
    const id2 = idIn(text(await h.bridge.callTool('wake_me', { in_minutes: 6, note: 'and another' })))
    for (let i = 0; i < WAKE_FIRES_PER_HOUR; i++) store().recordFire('main', h.clock.now() - i * MIN)
    const no = await h.bridge.callTool('wake_me', { in_minutes: 30, note: 'again' })
    expect(no.isError).toBe(true)
    expect(text(no)).toMatch(/^Warning: this session has woken itself .* paused until .* Nothing was set/)
    await h.advance(7 * MIN)
    await eventually(() => expect(store().get(id) ?? store().get(id2)).toBeUndefined())
    expect(h.notesOf('wake')).toHaveLength(0)
    const told = h.relay.frames.filter(
      (r) =>
        r.direction === 'from_bridge' &&
        r.frame.type === 'reply' &&
        /keeps waking itself/.test((r.frame as { message: { text?: string } }).message.text ?? ''),
    )
    expect(told).toHaveLength(1)
  })
})
