// The deaf-thread alarm's bridge side (packages/protocol/src/deaf-thread.ts): what Main handled while a thread's session could not be
// typed into (the tally the Mac reads to say it), nothing lost and nothing delivered twice when typing works again, the supervisor's
// word reaching `workers.status` and `talos-app doctor`, and a hostile or old file saying nothing.
import { afterEach, describe, expect, setDefaultTimeout, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  DEAF_THREADS_FILE,
  MAIN_HANDLED_FILE,
  NEEDS_YOU_UNTYPEABLE,
  WorkerStatusItem,
  WorkersFile,
} from '@talos-app/protocol'
import { t } from '@talos-app/testkit'
import { deafThreadChecks } from '../src/doctor-deaf.ts'
import { pgidOf } from '../src/hub/server.ts'
import type { Notification } from '../src/notify.ts'
import { mainHandledKind, mainHandledSince, readDeafThreads, recordMainHandled } from '../src/router/deaf.ts'
import { ThreadRouter } from '../src/router/router.ts'
import { readInbound, workerStoreOf } from '../src/tools/read-inbound.ts'
import { type Harness, startHarness, waitFor } from './helpers.ts'

setDefaultTimeout(t(30_000))

const NOW = Date.parse('2026-11-22T10:00:00Z')
const home = () => mkdtempSync(join(tmpdir(), 'deaf-'))
const put = (h: string, file: string, body: unknown) =>
  writeFileSync(join(h, file), typeof body === 'string' ? body : JSON.stringify(body))

describe('the tally of what Main handled', () => {
  test('counts by kind per thread from a time on, and keeps one thread out of another', () => {
    const h = home()
    expect(recordMainHandled(h, 'delphi', 'message', NOW)).toBe(true)
    recordMainHandled(h, 'delphi', 'message', NOW + 1000)
    recordMainHandled(h, 'delphi', 'run', NOW + 2000)
    recordMainHandled(h, 'delphi', 'card', NOW + 3000)
    recordMainHandled(h, 'talos', 'run', NOW + 4000)
    expect(mainHandledSince(h, 'delphi', NOW)).toEqual({ message: 2, run: 1, card: 1 })
    expect(mainHandledSince(h, 'delphi', NOW + 1500)).toEqual({ message: 0, run: 1, card: 1 })
    expect(mainHandledSince(h, 'talos', NOW)).toEqual({ message: 0, run: 1, card: 0 })
  })

  test("only the owner's work counts: a wake or a handoff is not a message Main answered", () => {
    expect(mainHandledKind('text')).toBe('message')
    expect(mainHandledKind('file')).toBe('message')
    expect(mainHandledKind('schedule_run')).toBe('run')
    expect(mainHandledKind('card_action')).toBe('card')
    expect(mainHandledKind('wake')).toBeUndefined()
    expect(mainHandledKind('handoff')).toBeUndefined()
  })

  test('a damaged tally is started again, never a throw, and an unwritable folder says false', () => {
    const h = home()
    put(h, MAIN_HANDLED_FILE, '{not json')
    expect(recordMainHandled(h, 'delphi', 'message', NOW)).toBe(true)
    expect(mainHandledSince(h, 'delphi', 0).message).toBe(1)
    writeFileSync(join(h, 'afile'), 'x')
    expect(recordMainHandled(join(h, 'afile', 'inside'), 'delphi', 'message', NOW)).toBe(false) // a folder that cannot exist
  })

  test("every thread ages out on every write, each keeps the newest 100, and the file is compact and far under the reader's limit", () => {
    const h = home()
    recordMainHandled(h, 'old', 'message', NOW - 8 * 24 * 3600_000)
    recordMainHandled(h, 'delphi', 'message', NOW - 8 * 24 * 3600_000)
    for (let i = 0; i < 510; i++) recordMainHandled(h, 'delphi', 'run', NOW + i)
    const c = mainHandledSince(h, 'delphi', 0)
    expect(c.message).toBe(0)
    expect(c.run).toBe(100)
    const raw = readFileSync(join(h, MAIN_HANDLED_FILE), 'utf8')
    expect(Object.keys(JSON.parse(raw).threads)).toEqual(['delphi']) // another thread's week-old entry went with this write
    expect(raw).not.toContain('\n')
    expect(raw.length).toBeLessThan(8_000)
    // twenty threads at the cap still read whole
    for (let t = 0; t < 20; t++) for (let i = 0; i < 100; i++) recordMainHandled(h, `th${t}`, 'message', NOW + i)
    expect(mainHandledSince(h, 'th19', 0).message).toBe(100)
  })
})

describe("the supervisor's word that a thread is deaf", () => {
  const file = (over: Record<string, unknown> = {}) => ({
    v: 1,
    at: NOW,
    threads: { delphi: { since: NOW - 11 * 60_000, refusals_1h: 640 } },
    ...over,
  })

  test('a fresh file lists the thread with whole minutes and the count', () => {
    const h = home()
    put(h, DEAF_THREADS_FILE, file())
    expect(readDeafThreads(h, NOW)).toEqual([{ thread: 'delphi', since: NOW - 660_000, minutes: 11, refusals_1h: 640 }])
  })

  test('a stale file (the app stopped), a future-dated one, a damaged one and a wrong version say nothing', () => {
    const h = home()
    put(h, DEAF_THREADS_FILE, file({ at: NOW - 61_000 }))
    expect(readDeafThreads(h, NOW)).toEqual([])
    put(h, DEAF_THREADS_FILE, file({ at: NOW + 6_000 }))
    expect(readDeafThreads(h, NOW)).toEqual([])
    put(h, DEAF_THREADS_FILE, '{"v":1,')
    expect(readDeafThreads(h, NOW)).toEqual([])
    put(h, DEAF_THREADS_FILE, file({ v: 2 }))
    expect(readDeafThreads(h, NOW)).toEqual([])
    expect(readDeafThreads(home(), NOW)).toEqual([]) // no file at all
  })

  test('a thread id that is not one (a path, text posing as Talos) is refused with the whole file', () => {
    const h = home()
    put(h, DEAF_THREADS_FILE, file({ threads: { '../../etc': { since: NOW, refusals_1h: 1 } } }))
    expect(readDeafThreads(h, NOW)).toEqual([])
  })

  test("doctor: one WARN row per thread past the alarm's wait, with its minutes and count; a short blip has none", () => {
    const h = home()
    put(
      h,
      DEAF_THREADS_FILE,
      file({
        threads: {
          delphi: { since: NOW - 11 * 60_000, refusals_1h: 640 },
          talos: { since: NOW - 30_000, refusals_1h: 30 },
        },
      }),
    )
    const rows = deafThreadChecks(h, NOW)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ level: 'warn', name: 'thread delphi' })
    expect(rows[0]?.detail).toContain('11 min')
    expect(rows[0]?.detail).toContain('640 refused keys')
  })

  test('workers.status: an old page that strips the field, and an unreadable value, keep the rest of the item', () => {
    const base = { thread_id: 'delphi', state: 'live' }
    expect(WorkerStatusItem.parse({ ...base, deaf: { minutes: 11, refusals_1h: 640 } }).deaf).toEqual({
      minutes: 11,
      refusals_1h: 640,
    })
    const bad = WorkerStatusItem.parse({ ...base, deaf: { minutes: 'a lot' } })
    expect(bad.deaf).toBeUndefined()
    expect(bad.state).toBe('live')
  })
})

let h: Harness | undefined
afterEach(async () => {
  await h?.stop()
  h = undefined
})

async function hub() {
  h = await startHarness({
    config: ((c: Record<string, unknown> & { threads: unknown[] }) => ({
      ...c,
      threads: [
        ...c.threads,
        {
          id: 'trip',
          name: 'Trip',
          kind: 'fixed',
          order: 5,
          notify: 'all',
          archived: false,
          created_at: '2026-10-28T00:00:00.000Z',
          session: 'dedicated',
        },
        {
          id: 'trip_sub',
          name: 'Trip Sub',
          kind: 'fixed',
          order: 6,
          notify: 'all',
          archived: false,
          created_at: '2026-10-28T00:00:00.000Z',
          parent_id: 'trip',
        },
      ],
      dedicated: { enabled: true },
    })) as never,
  })
  await waitFor(() => existsSync(join((h as Harness).home, 'run', 'hub.sock')))
  return h
}

const owner = (id: string): Notification => ({
  content: 'Book it',
  meta: { message_id: id, thread_id: 'trip', kind: 'text', trust: 'owner' } as Notification['meta'],
})

function liveWorker(hh: Harness) {
  mkdirSync(hh.home, { recursive: true })
  writeFileSync(
    join(hh.home, 'workers.json'),
    JSON.stringify({
      v: 1,
      supervisor: { pid: 1, heartbeat_at: new Date().toISOString(), workers_supported: true },
      threads: {
        trip: {
          state: 'live',
          session_id: '6f1c2a9e-4b3d-4c8e-9a71-2d5e8f0b3c41',
          tmux: 't-trip',
          pane_pid: pgidOf(process.pid) as number,
          cwd: hh.home,
          error: null,
        },
      },
    }),
  )
}

describe('typing works again: nothing lost, nothing delivered twice', () => {
  test('a message past its deadline went to Main (and is counted once); one still inside it goes to the thread; neither comes twice', async () => {
    const hh = await hub()
    liveWorker(hh)
    const store = workerStoreOf(hh.bridge.ctx)
    const got: Notification[] = []
    const r = new ThreadRouter(hh.bridge.ctx, async (n) => void got.push(n), { store })
    const now = Date.now()
    // A: the Mac could not type its pointer; the hub's deadline passed
    store.addRoute({
      message_id: 'm-old',
      thread_id: 'trip',
      notification: owner('m-old'),
      woke_at: now - 60_000,
      deadline_at: now - 1,
      cold: false,
    })
    r.resume()
    await waitFor(() => got.length === 1, 4000, 'Main took the late one')
    expect(got[0]?.meta).toMatchObject({ message_id: 'm-old', routed: 'fallback' })
    // B: typing recovered, a new message is routed to the thread's own session
    await r.route(owner('m-new'))
    expect(got).toHaveLength(1)
    const read = readInbound(hh.bridge.ctx, 'trip')
    expect(read.messages.map((m) => m.meta.message_id)).toEqual(['m-new']) // the new one, and only it
    expect(read.messages).toHaveLength(1) // only the new one: the old one is Main's
    expect(read.already_handled_by_main).toContain('m-old')
    // asked again, and the relay replays both: nothing is delivered a second time
    expect(readInbound(hh.bridge.ctx, 'trip').messages).toHaveLength(0)
    await r.route(owner('m-old'))
    await r.route(owner('m-new'))
    expect(got).toHaveLength(1)
    expect(mainHandledSince(hh.home, 'trip', 0)).toEqual({ message: 1, run: 0, card: 0 })
    r.close()
  })

  test("a sub-thread's message Main took is the LEAD's tally (the lead is the session that could not be reached)", async () => {
    const hh = await hub()
    liveWorker(hh)
    const store = workerStoreOf(hh.bridge.ctx)
    const got: Notification[] = []
    const r = new ThreadRouter(hh.bridge.ctx, async (n) => void got.push(n), { store })
    const now = Date.now()
    const base = owner('m-sub')
    const n = { ...base, meta: { ...base.meta, thread_id: 'trip_sub' } } as Notification
    store.addRoute({
      message_id: 'm-sub',
      thread_id: 'trip',
      notification: n,
      woke_at: now - 60_000,
      deadline_at: now - 1,
      cold: false,
    })
    r.resume()
    await waitFor(() => got.length === 1, 4000, 'Main took it')
    expect(mainHandledSince(hh.home, 'trip', 0).message).toBe(1)
    expect(mainHandledSince(hh.home, 'trip_sub', 0).message).toBe(0)
    r.close()
  })

  test("the Mac's needs_you for a deaf thread, as workers.json carries it, reaches workers.status with its kind and its step", async () => {
    const hh = await hub()
    liveWorker(hh)
    const raw = JSON.parse(readFileSync(join(hh.home, 'workers.json'), 'utf8'))
    const now = Date.now()
    raw.threads.trip.needs_you = { kind: NEEDS_YOU_UNTYPEABLE, since: new Date(now - 11 * 60_000).toISOString() }
    writeFileSync(join(hh.home, 'workers.json'), JSON.stringify(raw))
    const file = WorkersFile.parse(JSON.parse(readFileSync(join(hh.home, 'workers.json'), 'utf8')))
    const r = new ThreadRouter(hh.bridge.ctx, async () => {}, { store: workerStoreOf(hh.bridge.ctx) })
    const item = r.status(file, { state: 'open' } as never, now).threads[0]
    expect(item?.needs_you?.kind).toBe(NEEDS_YOU_UNTYPEABLE) // a known kind: named, not "a prompt"
    expect(item?.needs_you?.since).toBe(raw.threads.trip.needs_you.since)
    expect(item?.needs_you?.step).toContain('your main agent')
    r.close()
  })

  test("workers.status carries the supervisor's word, only while its file is fresh and the supervisor is online", async () => {
    const hh = await hub()
    liveWorker(hh)
    const file = WorkersFile.parse(JSON.parse(readFileSync(join(hh.home, 'workers.json'), 'utf8')))
    const r = new ThreadRouter(hh.bridge.ctx, async () => {}, { store: workerStoreOf(hh.bridge.ctx) })
    const g = { state: 'open' } as never
    const now = Date.now()
    put(hh.home, DEAF_THREADS_FILE, { v: 1, at: now, threads: { trip: { since: now - 700_000, refusals_1h: 12 } } })
    expect(r.status(file, g, now).threads[0]?.deaf).toEqual({ minutes: 11, refusals_1h: 12 })
    put(hh.home, DEAF_THREADS_FILE, {
      v: 1,
      at: now - 120_000,
      threads: { trip: { since: now - 700_000, refusals_1h: 12 } },
    })
    expect(r.status(file, g, now).threads[0]?.deaf).toBeUndefined() // the app stopped: an old wait is not now
    r.close()
  })
})
