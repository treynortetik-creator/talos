// How long a thread's own session gets to pick up a routed message before the main session takes it: ten minutes for a
// session that is alive (busy, mid-turn, compacting, or not typeable right now), three for one being started for the
// message, none for a thread with no session. Real bridge over the FakeRelay with a fake clock; the long jumps use
// clock.set, only short moves use advance. No real claude.

import { Database } from 'bun:sqlite'
import { afterEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { ThreadStatus, type WorkerEntryT } from '@talos-app/protocol'
import { fakeClock, t } from '@talos-app/testkit'
import { Bridge } from '../src/bridge.ts'
import { loadEnv } from '../src/config.ts'
import { pgidOf } from '../src/hub/server.ts'
import { nullLogger } from '../src/log.ts'
import { goneRows } from '../src/router/reasons.ts'
import { syncWaitLines, waitingLine } from '../src/worker/busy-line.ts'
import { type RouteRow, WorkerStore } from '../src/worker/store.ts'
import { advanceSteps, type Harness, sleep, startHarness, waitFor } from './helpers.ts'

const NONCE = 'test-nonce-0123456789abcdef'
const MIN = 60_000
let h: Harness | undefined
let fake: ReturnType<typeof fakeClock> | undefined
let shown = 'live' // the state the test wrote for the thread's session
let extra: Record<string, unknown> = {} // and what else its entry says (pointer_hold, needs_you)
let top: Record<string, unknown> = {} // and what else the file says at its top (unreadable_threads)
let worker: Bridge | undefined
afterEach(async () => {
  top = {}
  await worker?.stop()
  worker = undefined
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

function writeWorkers(home: string, now: number, state: string, beatAt = now) {
  writeFileSync(
    join(home, 'workers.json'),
    JSON.stringify({
      v: 1,
      ...top,
      supervisor: {
        pid: 1,
        heartbeat_at: new Date(beatAt).toISOString(),
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
          error: state === 'failed' ? { code: 'crash_loop', message: 'it keeps stopping' } : null,
          ...extra,
        },
      },
    }),
  )
}

async function hub(clock: ReturnType<typeof fakeClock>, state: string, more: Record<string, unknown> = {}) {
  extra = more
  h = await startHarness({
    clock,
    config: ((c: Record<string, unknown> & { threads: unknown[] }) => ({
      ...c,
      threads: [...c.threads, thread('trip', 'Trip', { session: 'dedicated' })],
      dedicated: { enabled: true },
    })) as never,
  })
  await waitFor(() => existsSync(join(h?.home as string, 'run', 'hub.sock')))
  shown = state
  fake = clock
  writeWorkers(h.home, clock.now(), state)
  mkdirSync(join(h.home, 'workers', 'trip'), { recursive: true })
  writeFileSync(join(h.home, 'workers', 'trip', 'nonce'), NONCE)
  return h
}

async function startWorker(hh: Harness) {
  writeWorkers(hh.home, fake?.now() ?? Date.now(), shown) // the hub checks the heartbeat on its (fake) clock
  worker = await Bridge.create({
    env: loadEnv({
      TALOS_APP_HOME: hh.home,
      TALOS_APP_RELAY_URL: hh.relay.httpUrl,
      TALOS_APP_WORKER_THREAD: 'trip',
      TALOS_APP_WORKER_NONCE: NONCE,
    }),
    logger: nullLogger,
  })
  const ok = await worker.startWorker()
  expect(ok, `refused: ${JSON.stringify(worker.hubClient?.lastRefusal)}`).toBe(true)
  return worker
}

/** Rewrites workers.json as the supervisor would at `clock.now()` (the heartbeat can be left old with `beatAt`). */
function setEntry(state: string, more: Record<string, unknown> = {}, beatAt?: number) {
  shown = state
  extra = more
  if (h && fake) writeWorkers(h.home, fake.now(), state, beatAt)
}

/** Moves the fake clock to `at`: a long jump with set, then short steps (the supervisor's heartbeat kept fresh) so the bridge's timers keep up. */
async function moveTo(clock: ReturnType<typeof fakeClock>, at: number, beat = true) {
  const left = at - clock.now()
  if (left > 30_000) clock.set(at - 30_000)
  if (beat) setEntry(shown, extra)
  for (let l = Math.min(left, 30_000); l > 0; l -= 10_000) {
    await advanceSteps(clock, Math.min(10_000, l), 10_000)
    if (beat) setEntry(shown, extra)
  }
}

/** waitNotes that nudges the fake clock, so the inbound settle window can end. */
const gotNotes = (hh: Harness, clock: ReturnType<typeof fakeClock>, n: number) =>
  waitFor(
    () => {
      clock.advance(50)
      return hh.notes.length >= n
    },
    4000,
    `${n} notifications (have ${hh.notes.length})`,
  )

const waitForWake = (hh: Harness, clock: ReturnType<typeof fakeClock>) =>
  waitFor(() => {
    clock.advance(50)
    return existsSync(join(hh.home, 'workers', 'trip', 'wake'))
  }, 4000)

const statuses = (hh: Harness) =>
  hh.relay.frames
    .filter((r) => r.direction === 'from_bridge' && r.frame.type === 'status')
    .map((r) => r.frame as { thread_id: string; state: string; label?: string })
    .filter((f) => f.thread_id === 'trip')
const lastStatus = (hh: Harness) => statuses(hh).at(-1)
const BUSY_LINE = "Trip is busy; it'll see this when it's free."
const at = '2026-11-13T12:00:00.000Z'

/** Waits (nudging the fake clock so the hub's poll runs) for the thread's newest status frame to satisfy `ok`. */
const waitStatus = (
  hh: Harness,
  clock: ReturnType<typeof fakeClock>,
  ok: (f?: { state: string; label?: string }) => boolean,
  what: string,
) =>
  waitFor(
    () => {
      clock.advance(1_000)
      return ok(lastStatus(hh))
    },
    4000,
    what,
  )

/** The system rows posted in the thread (what the owner reads). */
const systemRows = (hh: Harness) =>
  hh.relay.frames
    .filter((r) => r.direction === 'from_bridge' && r.frame.type === 'reply')
    .map((r) => (r.frame as { message: { author: string; text?: string } }).message)
    .filter((m) => m.author === 'system')
    .map((m) => m.text ?? '')

async function readInbound(w: Bridge) {
  return JSON.parse((await w.callTool('read_inbound', {})).content[0]?.text ?? '{}')
}

describe('a session that is alive gets ten minutes', () => {
  for (const state of ['busy', 'live'])
    test(`${state}: not taken at 9:59, taken at 10:00, once`, async () => {
      const clock = fakeClock(new Date().toISOString())
      const hh = await hub(clock, state)
      const t0 = clock.now()
      await hh.app.sendMessage('trip', 'Book it')
      await waitForWake(hh, clock)
      await moveTo(clock, t0 + 10 * MIN - 1_000)
      await sleep(100) // timing-ok: a negative check, nothing may arrive; the hub reacts in-process
      expect(hh.notes).toHaveLength(0)
      await moveTo(clock, t0 + 10 * MIN)
      await gotNotes(hh, clock, 1)
      expect(hh.notes[0]?.meta).toMatchObject({ routed: 'fallback' })
      await advanceSteps(clock, 2 * MIN, 30_000)
      expect(hh.notes).toHaveLength(1)
    })

  test('mid-turn at 2 minutes is still the session’s: the old 90 s and 120 s marks pass without a hand-over', async () => {
    const clock = fakeClock(new Date().toISOString())
    const hh = await hub(clock, 'busy')
    const t0 = clock.now()
    await hh.app.sendMessage('trip', 'Book it')
    await waitForWake(hh, clock)
    await moveTo(clock, t0 + 2 * MIN + 5_000)
    await sleep(100) // timing-ok: a negative check, nothing may arrive; the hub reacts in-process
    expect(hh.notes).toHaveLength(0)
  })
})

describe('a session being started for the message gets three minutes', () => {
  for (const state of ['parked', 'off'])
    test(`${state}: not taken at 2:59 (not dead: the start is expected), taken at 3:00`, async () => {
      const clock = fakeClock(new Date().toISOString())
      const hh = await hub(clock, state)
      const t0 = clock.now()
      await hh.app.sendMessage('trip', 'Book it')
      await waitForWake(hh, clock)
      await moveTo(clock, t0 + 3 * MIN - 1_000)
      await sleep(100) // timing-ok: a negative check, nothing may arrive; the hub reacts in-process
      expect(hh.notes).toHaveLength(0)
      await moveTo(clock, t0 + 3 * MIN)
      await gotNotes(hh, clock, 1)
      expect(hh.notes[0]?.meta).toMatchObject({ routed: 'fallback' })
    })
})

describe('no session at all: main takes it at once', () => {
  for (const state of ['failed', 'stopping'])
    test(state, async () => {
      const clock = fakeClock(new Date().toISOString())
      const hh = await hub(clock, state)
      await hh.app.sendMessage('trip', 'Book it')
      await gotNotes(hh, clock, 1)
      expect(hh.notes[0]?.meta).toMatchObject({ routed: 'fallback' })
      expect(existsSync(join(hh.home, 'workers', 'trip', 'wake'))).toBe(false)
    })
})

describe('a session that dies while a message waits: main takes it then, not at the deadline', () => {
  for (const dead of ['failed', 'stopping'])
    test(`busy, then ${dead} at 1 minute: main has it by 2 minutes; nothing says "was busy"`, async () => {
      const clock = fakeClock(new Date().toISOString())
      const hh = await hub(clock, 'busy')
      const t0 = clock.now()
      await hh.app.sendMessage('trip', 'Book it')
      await waitForWake(hh, clock)
      await moveTo(clock, t0 + 1 * MIN)
      await sleep(100) // timing-ok: a negative check, nothing may arrive; the hub reacts in-process
      expect(hh.notes).toHaveLength(0)
      setEntry(dead) // the heartbeat stays fresh: only the session died
      await moveTo(clock, t0 + 2 * MIN)
      await gotNotes(hh, clock, 1)
      expect(hh.notes[0]?.meta).toMatchObject({ routed: 'fallback', reason: 'worker_unavailable' })
      expect(systemRows(hh).some((x) => x.includes('was busy'))).toBe(false)
      await moveTo(clock, t0 + 11 * MIN)
      expect(hh.notes).toHaveLength(1) // never twice
    })

  test('the supervisor gone: a heartbeat only just stale is a restart (grace); 45 s stale is gone', async () => {
    const clock = fakeClock(new Date().toISOString())
    const hh = await hub(clock, 'busy')
    const t0 = clock.now()
    await hh.app.sendMessage('trip', 'Book it')
    await waitForWake(hh, clock)
    await moveTo(clock, t0 + 1 * MIN)
    // the last heartbeat 20 s ago: stale (15 s) but inside the 30 s grace
    setEntry('busy', {}, clock.now() - 20_000)
    await moveTo(clock, clock.now() + 5_000, false)
    await sleep(100) // timing-ok: a negative check, nothing may arrive; the hub reacts in-process
    expect(hh.notes).toHaveLength(0)
    await moveTo(clock, clock.now() + 30_000, false) // now 55 s since the last heartbeat
    await gotNotes(hh, clock, 1)
    expect(hh.notes[0]?.meta).toMatchObject({ routed: 'fallback' })
    expect(clock.now() - t0).toBeLessThan(10 * MIN)
  })
})

describe('never both', () => {
  test('the session starts taking messages again at 5 minutes and claims it: main never answers', async () => {
    const clock = fakeClock(new Date().toISOString())
    const hh = await hub(clock, 'busy')
    const t0 = clock.now()
    const sent = await hh.app.sendMessage('trip', 'Book it')
    await waitForWake(hh, clock)
    await moveTo(clock, t0 + 5 * MIN)
    const w = await startWorker(hh)
    const r = await readInbound(w)
    expect(r.messages).toHaveLength(1)
    expect(r.messages[0].meta.message_id).toBe(sent.client_msg_id)
    await moveTo(clock, t0 + 11 * MIN)
    await sleep(100) // timing-ok: a negative check, nothing may arrive; the hub reacts in-process
    expect(hh.notes).toHaveLength(0)
  })

  test('main took it at 10 minutes: the session does not get it too', async () => {
    const clock = fakeClock(new Date().toISOString())
    const hh = await hub(clock, 'busy')
    const t0 = clock.now()
    const sent = await hh.app.sendMessage('trip', 'Book it')
    await waitForWake(hh, clock)
    await moveTo(clock, t0 + 10 * MIN)
    await gotNotes(hh, clock, 1)
    const w = await startWorker(hh)
    const r = await readInbound(w)
    expect(r.messages).toHaveLength(0)
    expect(r.already_handled_by_main).toEqual([sent.client_msg_id])
    expect(hh.notes).toHaveLength(1)
  })
})

describe('the phone is not silent while a message waits for a session that is alive', () => {
  test(
    'busy: the busy line, taken down with idle (not working) when the session claims it',
    async () => {
      const clock = fakeClock(new Date().toISOString())
      const hh = await hub(clock, 'busy')
      await hh.app.sendMessage('trip', 'Book it')
      await waitForWake(hh, clock)
      await waitFor(() => statuses(hh).some((s) => s.label === BUSY_LINE), 4000, 'the busy line')
      expect(statuses(hh).find((s) => s.label === BUSY_LINE)?.state).toBe('working')
      const w = await startWorker(hh)
      await readInbound(w)
      await waitStatus(hh, clock, (f) => f?.state === 'idle', 'idle after the claim')
      expect(lastStatus(hh)).toMatchObject({ state: 'idle' })
      expect(lastStatus(hh)?.label).toBeUndefined()
      // a later poll sends nothing more: nothing waits there now
      const n = statuses(hh).length
      await advanceSteps(clock, 30_000, 10_000)
      expect(statuses(hh)).toHaveLength(n)
    },
    t(60_000),
  )

  test(
    'the session claims and sets its own working status before the hub notices: no late idle wipes it',
    async () => {
      const clock = fakeClock(new Date().toISOString())
      const hh = await hub(clock, 'busy')
      await hh.app.sendMessage('trip', 'Book it')
      await waitForWake(hh, clock)
      await waitFor(() => statuses(hh).some((s) => s.label === BUSY_LINE), 4000, 'the busy line')
      const w = await startWorker(hh)
      await readInbound(w)
      const r = await w.callTool('set_status', { thread_id: 'trip', state: 'working', label: 'Booking the hotel' })
      expect(r.isError, r.content[0]?.text).toBeFalsy()
      await waitFor(() => statuses(hh).some((s) => s.label === 'Booking the hotel'), 4000, 'the own status')
      await advanceSteps(clock, 30_000, 10_000) // several hub polls
      expect(lastStatus(hh)).toMatchObject({ state: 'working', label: 'Booking the hotel' })
      expect(statuses(hh).some((s) => s.state === 'idle')).toBe(false)
    },
    t(60_000),
  )

  test(
    'busy: when main takes it at the deadline the line goes idle, and ONE row says "was busy, so the main agent answered."',
    async () => {
      const clock = fakeClock(new Date().toISOString())
      const hh = await hub(clock, 'busy')
      const t0 = clock.now()
      await hh.app.sendMessage('trip', 'Book it')
      await waitForWake(hh, clock)
      await waitFor(() => statuses(hh).some((s) => s.label === BUSY_LINE), 4000, 'the busy line')
      await moveTo(clock, t0 + 10 * MIN)
      await gotNotes(hh, clock, 1)
      await waitStatus(hh, clock, (f) => f?.state === 'idle', 'idle after Main took it')
      await waitFor(() => systemRows(hh).includes('Trip was busy, so the main agent answered.'), 4000, 'the row')
      expect(
        systemRows(hh).filter((x) => x.includes('Main answered') || x.includes('main agent answered')),
      ).toHaveLength(1)
    },
    t(60_000),
  )

  test('an idle live session gets no line (it reads the message in seconds)', async () => {
    const clock = fakeClock(new Date().toISOString())
    const hh = await hub(clock, 'live')
    await hh.app.sendMessage('trip', 'Book it')
    await waitForWake(hh, clock)
    await advanceSteps(clock, 20_000, 10_000)
    expect(statuses(hh).some((s) => s.state === 'working' && s.label)).toBe(false)
  })

  const HOLDS = [
    ['typed_unseen', 'Trip is waiting for you: not picked up', 'Trip was waiting for you, so the main agent answered.'],
    ['draft', 'Trip is waiting for you: unsent text', 'Trip was waiting for you, so the main agent answered.'],
    ['scrolled', 'Trip is waiting for you: scrolled back', 'Trip was waiting for you, so the main agent answered.'],
    ['refused', "Trip can't take messages right now.", "Trip couldn't take messages, so the main agent answered."],
    ['tea_break', 'Trip is waiting for you.', 'Trip was waiting for you, so the main agent answered.'],
  ] as const
  for (const [reason, line, row] of HOLDS)
    test(
      `pointer_hold ${reason}: the line while it waits (even on a live session), the row when main takes it`,
      async () => {
        const clock = fakeClock(new Date().toISOString())
        const hh = await hub(clock, 'live', { pointer_hold: { reason, since: at } })
        const t0 = clock.now()
        await hh.app.sendMessage('trip', 'Book it')
        await waitForWake(hh, clock)
        await waitFor(() => statuses(hh).some((s) => s.label === line), 4000, `the line "${line}"`)
        expect(statuses(hh).some((s) => s.label === BUSY_LINE)).toBe(false) // not "busy"
        await moveTo(clock, t0 + 10 * MIN)
        await gotNotes(hh, clock, 1)
        await waitFor(() => systemRows(hh).includes(row), 4000, `the row "${row}"`)
        await waitStatus(hh, clock, (f) => f?.state === 'idle', 'idle')
        expect(systemRows(hh).some((x) => x.includes('probably gone to the main session'))).toBe(false)
      },
      t(60_000),
    )

  test(
    'the wording is picked again on each poll: busy, then a hold, then busy again, then idle when it is claimed',
    async () => {
      const clock = fakeClock(new Date().toISOString())
      const hh = await hub(clock, 'busy')
      await hh.app.sendMessage('trip', 'Book it')
      await waitForWake(hh, clock)
      await waitFor(() => statuses(hh).some((s) => s.label === BUSY_LINE), 4000, 'the busy line')
      setEntry('busy', { pointer_hold: { reason: 'draft', since: at } })
      await waitStatus(hh, clock, (f) => f?.label === 'Trip is waiting for you: unsent text', 'the draft line')
      setEntry('busy', {})
      await waitStatus(hh, clock, (f) => f?.label === BUSY_LINE, 'busy again')
      const w = await startWorker(hh)
      await readInbound(w)
      await waitStatus(hh, clock, (f) => f?.state === 'idle', 'idle')
    },
    t(60_000),
  )

  test('needs_you wins over pointer_hold: the hold says nothing (the phone already says what the session waits on)', async () => {
    const clock = fakeClock(new Date().toISOString())
    const hh = await hub(clock, 'live', {
      pointer_hold: { reason: 'draft', since: at },
      needs_you: { kind: 'trust this folder', since: at },
    })
    await hh.app.sendMessage('trip', 'Book it')
    await waitForWake(hh, clock)
    await advanceSteps(clock, 20_000, 10_000)
    expect(statuses(hh).some((s) => s.label?.includes('Trip'))).toBe(false)
  })
})

describe('the line is for the owner’s own messages only', () => {
  const rows = (kind: string) =>
    [
      {
        message_id: `m_${kind}`,
        thread_id: 'trip',
        notification: { content: 'x', meta: { kind } },
        woke_at: 0,
        deadline_at: 0,
        cold: false,
      },
    ] as never
  for (const [kind, shows] of [
    ['text', true],
    ['file', true],
    ['card_action', true],
    ['schedule_run', false],
    ['wake', false],
    ['handoff', false],
  ] as const)
    test(`${kind}: ${shows ? 'shown' : 'not shown'}`, () => {
      const sent: string[] = []
      const ctx = {
        clock: { now: () => 0 },
        config: { thread: () => ({ name: 'Trip' }) },
        transport: { sendEphemeral: (f: { label?: string }) => sent.push(f.label ?? '(idle)') },
      } as never
      syncWaitLines(ctx, rows(kind), { trip: { state: 'busy' } as never }, (_n, lead) => lead)
      expect(sent).toEqual(shows ? [BUSY_LINE] : [])
    })
})

describe('a card tap held for a session that does not claim it goes to main at the deadline, as the design says', () => {
  test(
    'with main reachable: nothing before 10 minutes; at the deadline main gets it as a fallback, once',
    async () => {
      const clock = fakeClock(new Date().toISOString())
      const hh = await hub(clock, 'busy')
      const t0 = clock.now()
      const w = await startWorker(hh)
      const res = await w.callTool('card', {
        thread_id: 'trip',
        kind: 'decision',
        title: 'Book the hotel',
        primary_label: 'Book',
        kill_label: 'Kill it',
        risk: 'low',
        origin: 'chat',
        destination: [],
      })
      expect(res.isError, res.content[0]?.text).toBeFalsy()
      const created = await hh.relay.expectFrame('card.create', (f) => f.card.thread_id === 'trip', {
        direction: 'from_bridge',
      })
      const sentToMain: Array<{ meta: Record<string, unknown> }> = []
      hh.bridge.setEmit(async (n) => {
        sentToMain.push(n as never)
      })
      await hh.app.resolveCard(created.card, 'kill', created.card.payload_hash)
      await waitForWake(hh, clock)
      await moveTo(clock, t0 + 10 * MIN - 1_000)
      expect(sentToMain).toHaveLength(0)
      await moveTo(clock, t0 + 10 * MIN + 1_000)
      await waitFor(() => sentToMain.length > 0, 4000, 'the tap at Main')
      expect(sentToMain[0]?.meta).toMatchObject({ kind: 'card_action', routed: 'fallback', card_id: created.card.id })
      await advanceSteps(clock, 2 * MIN, 30_000)
      expect(sentToMain).toHaveLength(1)
    },
    t(60_000),
  )
})

describe('the status label always fits the status frame (80 UTF-16 units)', () => {
  const entry = (state: string, hold?: { reason: string }) =>
    ({ state, pointer_hold: hold ? { ...hold, since: at } : undefined }) as unknown as WorkerEntryT
  const names = ['Trip', 'a'.repeat(40), '😀'.repeat(40), 'é'.repeat(40) + 'x', 'ab😀'.repeat(13), '字'.repeat(40)]
  const cases: [string, WorkerEntryT][] = [
    ['busy', entry('busy')],
    ['typed_unseen', entry('live', { reason: 'typed_unseen' })],
    ['draft', entry('live', { reason: 'draft' })],
    ['scrolled', entry('live', { reason: 'scrolled' })],
    ['refused', entry('live', { reason: 'refused' })],
    ['a newer reason', entry('live', { reason: 'something_new' })],
  ]
  for (const [what, e] of cases)
    test(`${what}: every name up to 40 characters parses as a ThreadStatus`, () => {
      for (const name of names) {
        const line = waitingLine(name, e)
        expect(line).not.toBeNull()
        const parsed = ThreadStatus.safeParse({ thread_id: 'trip', state: 'working', label: line, since: at })
        expect(parsed.success, `${what} / ${JSON.stringify(name)}: ${line?.length} units`).toBe(true)
        // a clipped name is cut on a whole character, never through a surrogate pair
        expect(line).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/)
      }
    })
  test('a short name is left whole', () => {
    expect(waitingLine('Trip', entry('busy'))).toBe(BUSY_LINE)
  })
})

const wakePath = (hh: Harness) => join(hh.home, 'workers', 'trip', 'wake')

describe('a session that dies after its pointer was typed and before it read the message', () => {
  /** busy for a minute (seen), then the entry goes to `after` with `more` and the supervisor's wake file is taken (deleted). */
  async function died(after: string, more: Record<string, unknown>) {
    const clock = fakeClock(new Date().toISOString())
    const hh = await hub(clock, 'busy')
    const t0 = clock.now()
    await hh.app.sendMessage('trip', 'Book it')
    await waitForWake(hh, clock)
    await moveTo(clock, t0 + 1 * MIN)
    unlinkSync(wakePath(hh)) // the supervisor took the first wake
    setEntry(after, more)
    return { clock, hh, t0 }
  }

  test('parked after a crash: the hub writes the wake again, once; main is not given it', async () => {
    const { clock, hh, t0 } = await died('parked', { stopped_why: 'crash' })
    await waitForWake(hh, clock)
    unlinkSync(wakePath(hh)) // taken again by the supervisor, which has not resumed the session yet
    await moveTo(clock, t0 + 4 * MIN)
    expect(existsSync(wakePath(hh)), 'a third wake for one death').toBe(false)
    expect(hh.notes).toHaveLength(0)
  })

  test('the second death goes to main at once, with the usual line; no third wake', async () => {
    const { clock, hh, t0 } = await died('parked', { stopped_why: 'crash' })
    await waitForWake(hh, clock)
    unlinkSync(wakePath(hh))
    setEntry('live') // the supervisor resumed it
    await moveTo(clock, t0 + 2 * MIN)
    setEntry('parked', { stopped_why: 'crash' }) // and it died again before reading
    await moveTo(clock, t0 + 4 * MIN)
    await gotNotes(hh, clock, 1)
    expect(hh.notes[0]?.meta).toMatchObject({ routed: 'fallback', reason: 'worker_unavailable' })
    expect(existsSync(wakePath(hh))).toBe(false)
    expect(systemRows(hh).some((x) => x.includes("Thread session didn't pick this up"))).toBe(true)
    await moveTo(clock, t0 + 12 * MIN)
    expect(hh.notes).toHaveLength(1) // never twice
  })

  test('parked by the owner (stopped_why owner): not restarted, main has it at once with the usual line', async () => {
    const { clock, hh, t0 } = await died('parked', { stopped_why: 'owner' })
    await moveTo(clock, t0 + 2 * MIN)
    await gotNotes(hh, clock, 1)
    expect(hh.notes[0]?.meta).toMatchObject({ routed: 'fallback', reason: 'worker_unavailable' })
    expect(existsSync(wakePath(hh)), 'a session the owner stopped was woken').toBe(false)
    expect(systemRows(hh).some((x) => x.includes("Thread session didn't pick this up"))).toBe(true)
  })

  test('a session that was only ever asked to start (parked, never seen live) is not woken again', async () => {
    const clock = fakeClock(new Date().toISOString())
    const hh = await hub(clock, 'parked')
    const t0 = clock.now()
    await hh.app.sendMessage('trip', 'Book it')
    await waitForWake(hh, clock)
    unlinkSync(wakePath(hh))
    await moveTo(clock, t0 + 2 * MIN)
    expect(existsSync(wakePath(hh))).toBe(false)
    expect(hh.notes).toHaveLength(0)
  })

  test('a claimed message is never woken for: the session read it, then parked', async () => {
    const { clock, hh, t0 } = await died('live', {})
    const w = await startWorker(hh)
    expect((await readInbound(w)).messages).toHaveLength(1)
    setEntry('parked', { stopped_why: 'crash' })
    await moveTo(clock, t0 + 4 * MIN)
    expect(existsSync(wakePath(hh))).toBe(false)
    expect(hh.notes).toHaveLength(0)
  })
})

describe('the re-wake is once per message, in the database (a restart or a second hub does not add one)', () => {
  const route = (id: string): RouteRow =>
    ({
      message_id: id,
      thread_id: 'trip',
      notification: { content: 'x', meta: {} },
      woke_at: 1,
      deadline_at: 2,
      cold: true,
    }) as never
  test('seen live first; the first caller wins, a new store over the same file loses', () => {
    const db = new Database(':memory:')
    const a = new WorkerStore(db)
    a.addRoute(route('m1'))
    expect(a.rewakeOnce('m1', 10), 'not seen live: no re-wake').toBe(false)
    a.noteSeenLive('m1', 5)
    expect(a.rewakeOnce('m1', 10)).toBe(true)
    expect(a.rewakeOnce('m1', 11)).toBe(false)
    const b = new WorkerStore(db) // a restart
    expect(b.rewakeOnce('m1', 12)).toBe(false)
    expect(b.diedAgain('m1')).toBe(false)
    b.noteSeenLive('m1', 20) // seen live again after the re-wake
    expect(b.diedAgain('m1')).toBe(true)
  })
})

describe('a supervisor heartbeat counts as gone only when the same stale one was seen on an earlier poll', () => {
  const now = 1_000_000
  const file = (beat: number) =>
    ({
      v: 1,
      supervisor: { pid: 1, heartbeat_at: new Date(beat).toISOString(), workers_supported: true },
      threads: {},
      unavailable: [],
    }) as never
  const row = { message_id: 'm1', thread_id: 'trip', notification: { content: 'x', meta: {} } } as never
  const reach = () => ({ to: 'fallback', reason: 'worker_unavailable' }) as never
  test('stale past the grace once: nothing; confirmed: the message goes to main', () => {
    expect(goneRows(file(now - 60_000), now, [row], reach, false)).toHaveLength(0)
    expect(goneRows(file(now - 60_000), now, [row], reach, true)).toHaveLength(1)
  })
})

describe('a message routed to a warm session counts as seen live from the start (R2-2)', () => {
  const route = (id: string, cold: boolean): RouteRow =>
    ({
      message_id: id,
      thread_id: 'trip',
      notification: { content: 'x', meta: {} },
      woke_at: 7,
      deadline_at: 9,
      cold,
    }) as never
  test('warm: seen at once, so it can be woken once; cold: not', () => {
    const store = new WorkerStore(new Database(':memory:'))
    store.addRoute(route('warm', false))
    store.addRoute(route('cold', true))
    expect(store.wasSeenLive('warm')).toBe(true)
    expect(store.wasSeenLive('cold')).toBe(false)
    expect(store.rewakeOnce('warm', 8)).toBe(true)
    expect(store.rewakeOnce('cold', 8)).toBe(false)
  })
  test('the same id routed again does not turn a sighting into a new one', () => {
    const store = new WorkerStore(new Database(':memory:'))
    store.addRoute(route('m', false))
    store.rewakeOnce('m', 8)
    store.addRoute({ ...route('m', false), woke_at: 50 }) // ignored: the row is never replaced
    expect(store.diedAgain('m')).toBe(false)
  })
})

describe('a parked session the hub would not start goes to main with that reason, not a re-wake (R2-1)', () => {
  test('unavailable entry: main answers; and a thread that is merely parked is woken', async () => {
    const clock = fakeClock(new Date().toISOString())
    const hh = await hub(clock, 'busy')
    const t0 = clock.now()
    await hh.app.sendMessage('trip', 'Book it')
    await waitForWake(hh, clock)
    await moveTo(clock, t0 + 1 * MIN)
    unlinkSync(wakePath(hh))
    setEntry('parked', { stopped_why: 'crash' })
    // the supervisor says it set this entry aside: the hub could not start it, so a re-wake would sit there unread
    top = { unreadable_threads: { trip: { at: new Date(clock.now()).toISOString() } } }
    await moveTo(clock, t0 + 3 * MIN)
    await gotNotes(hh, clock, 1)
    expect(hh.notes[0]?.meta).toMatchObject({ routed: 'fallback', reason: 'worker_unavailable' })
    expect(existsSync(wakePath(hh)), 'a re-wake for a session the hub cannot start').toBe(false)
  })
})
