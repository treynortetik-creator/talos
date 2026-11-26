// D39: an owner message in flight when the Claude session dies stayed "Delivered" forever and was never answered: the
// pending list lived in memory and receipts stop at delivered. Real Bridge + FakeRelay + FakeApp; a "restart" is a second
// Bridge on the same home (a new process run id). Also pinned: a plain socket reconnect never reports (`ready` fires on every
// reconnect), an answered message never reports, old entries are dropped, and the message is not sent again.
import { afterEach, describe, expect, setDefaultTimeout, test } from 'bun:test'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { t } from '@talos-app/testkit'
import { Bridge } from '../src/bridge.ts'
import { loadEnv } from '../src/config.ts'
import { SeenTracker, UNANSWERED_MAX_AGE_MS } from '../src/context.ts'
import { nullLogger } from '../src/log.ts'
import type { Notification } from '../src/notify.ts'
import { HARNESS_START_MS, type Harness, sleep, startHarness, waitFor } from './helpers.ts'

// the harness start, a restart (its connect wait is 30 s at x3) and the waits add up past bun's 5 s default
setDefaultTimeout(t(30_000))

let h: Harness | undefined
let second: Bridge | undefined
afterEach(async () => {
  await second?.stop()
  second = undefined
  await h?.stop()
  h = undefined
})

const NOTICE = /may not have been answered/
const noticeRows = (x: Harness) =>
  x.relay.frames.filter(
    (r) =>
      r.direction === 'from_bridge' &&
      r.raw.type === 'reply' &&
      (r.raw.message as { author?: string; text?: string }).author === 'system' &&
      NOTICE.test((r.raw.message as { text: string }).text),
  )

/** The Mac's session dies: stop the bridge, then a fresh one (a new process run) comes up on the same home and relay. */
async function restart(x: Harness): Promise<{ bridge: Bridge; notes: Notification[] }> {
  await x.bridge.stop()
  const env = loadEnv({
    TALOS_APP_HOME: x.home,
    TALOS_APP_RELAY_URL: x.relay.httpUrl,
    TALOS_APP_BRIDGE: '1',
  })
  const bridge = await Bridge.create({ env, logger: nullLogger, inbound: { settleMs: 20, maxSettleMs: 200 } })
  const notes: Notification[] = []
  bridge.setEmit(async (n) => {
    notes.push(n)
  })
  second = bridge
  bridge.start()
  await waitFor(() => bridge.client?.connected === true, 10_000, 'the second bridge to connect')
  return { bridge, notes }
}

describe('D39 a message in flight when the session dies', () => {
  test(
    'is reported once after a restart: a line in the thread and a system notification to the agent, and not sent again',
    async () => {
      h = await startHarness()
      await h.app.sendMessage('general', 'please do the thing')
      await h.waitNotes(1)
      const sentId = h.notes[0]?.meta.message_id
      expect(sentId).toBeTruthy()
      expect(noticeRows(h)).toHaveLength(0)

      const next = await restart(h)
      await waitFor(() => noticeRows(h as Harness).length === 1, 5000, 'the unanswered line')
      const row = noticeRows(h)[0]?.raw.message as { thread_id: string; text: string }
      expect(row.thread_id).toBe('general')
      expect(row.text).toContain('may not have been answered')
      await waitFor(() => next.notes.some((n) => n.meta.kind === 'system'), 5000, 'the agent notification')
      const sys = next.notes.find((n) => n.meta.kind === 'system')
      expect(sys?.content).toMatch(NOTICE)
      expect(sys?.meta.thread_id).toBe('general')
      // the agent decides: the original message is not delivered again
      await sleep(t(300)) // timing-ok: negative window, from the unanswered line and the agent's notification both seen: no redelivery, still one line
      expect(next.notes.some((n) => n.meta.message_id === sentId)).toBe(false)
      expect(noticeRows(h)).toHaveLength(1)
    },
    HARNESS_START_MS + t(75_000),
  )

  test(
    'a message the agent answered is never reported',
    async () => {
      h = await startHarness()
      await h.app.sendMessage('general', 'a question')
      await h.waitNotes(1)
      await h.bridge.callTool('reply', { thread_id: 'general', text: 'the answer' })
      await restart(h)
      await sleep(t(500)) // timing-ok: negative window, from the new bridge authed (its ready, and the once-per-process check, have run): no report
      expect(noticeRows(h)).toHaveLength(0)
    },
    HARNESS_START_MS + t(45_000),
  )

  test(
    'a socket drop and reconnect inside one session never reports, with a message pending',
    async () => {
      h = await startHarness()
      await h.app.sendMessage('general', 'still pending')
      await h.waitNotes(1)
      for (let i = 0; i < 2; i++) {
        const before = h.relay.frames.filter((r) => r.direction === 'from_bridge' && r.raw.type === 'hello').length
        h.relay.dropBridge()
        await waitFor(
          () =>
            h?.relay.frames.filter((r) => r.direction === 'from_bridge' && r.raw.type === 'hello').length ===
            before + 1,
          15_000,
          'reconnect',
        )
        await waitFor(() => h?.bridge.client?.connected === true, 10_000, 'authed again')
      }
      await sleep(t(500)) // timing-ok: negative window, from the last reconnect authed (its ready has run): no report, no system notification
      expect(noticeRows(h)).toHaveLength(0)
      expect(h.notes.filter((n) => n.meta.kind === 'system')).toHaveLength(0)
    },
    HARNESS_START_MS + t(165_000),
  )

  test(
    'after the report, a later reconnect of the new session does not repeat it',
    async () => {
      h = await startHarness()
      await h.app.sendMessage('general', 'lost')
      await h.waitNotes(1)
      const next = await restart(h)
      await waitFor(() => noticeRows(h as Harness).length === 1, 5000, 'the unanswered line')
      h.relay.dropBridge()
      await waitFor(() => next.bridge.client?.connected !== true, 5000, 'dropped').catch(() => {})
      await waitFor(() => next.bridge.client?.connected === true, 15_000, 'reconnected')
      await sleep(t(500)) // timing-ok: negative window, from the reconnect authed (one line seen before "still one"): not repeated
      expect(noticeRows(h)).toHaveLength(1)
    },
    HARNESS_START_MS + t(120_000),
  )

  test(
    'a session that marked the thread working, or read it, and then died is still reported',
    async () => {
      for (const touch of ['set_status', 'read_thread'] as const) {
        h = await startHarness()
        await h.app.sendMessage('general', 'a long task')
        await h.waitNotes(1)
        const r = await h.bridge.callTool(
          touch,
          touch === 'set_status' ? { thread_id: 'general', state: 'working' } : { thread_id: 'general' },
        )
        expect(r.isError, touch).toBeFalsy()
        expect(JSON.parse(h.bridge.ctx.store.kvGet('unanswered_v1') ?? '{}')).not.toEqual({})
        await restart(h)
        await waitFor(() => noticeRows(h as Harness).length === 1, 5000, `the unanswered line after ${touch}`)
        await second?.stop()
        second = undefined
        await h.stop()
        h = undefined
      }
    },
    HARNESS_START_MS * 2 + t(115_000),
  )

  test(
    'a card raised in the thread counts as an answer',
    async () => {
      h = await startHarness()
      await h.app.sendMessage('general', 'ship it?')
      await h.waitNotes(1)
      const c = await h.bridge.callTool('card', {
        thread_id: 'general',
        kind: 'generic',
        title: 'T',
        primary_label: 'OK',
        kill_label: 'Kill T',
        risk: 'low',
        origin: 'chat',
      })
      expect(c.isError, c.content[0]?.text).toBeFalsy()
      await restart(h)
      await sleep(t(500)) // timing-ok: negative window, from the new bridge authed (its ready, and the once-per-process check, have run): no report
      expect(noticeRows(h)).toHaveLength(0)
    },
    HARNESS_START_MS + t(45_000),
  )

  describe('a dedicated thread', () => {
    const dedicated = () =>
      startHarness({
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
          ],
          dedicated: { enabled: true },
        })) as never,
      })
    const workers = (home: string, stale: boolean) =>
      writeFileSync(
        join(home, 'workers.json'),
        JSON.stringify({
          v: 1,
          supervisor: {
            pid: 1,
            heartbeat_at: new Date(Date.now() - (stale ? 60_000 : 0)).toISOString(),
            workers_supported: true,
          },
          threads: {
            trip: {
              state: 'live',
              session_id: '6f1c2a9e-4b3d-4c8e-9a71-2d5e8f0b3c41',
              tmux: 't-trip',
              pane_pid: process.pid,
              cwd: home,
              error: null,
            },
          },
        }),
      )

    test(
      'a message that fell back to main is reported if main dies with it',
      async () => {
        h = await dedicated()
        workers(h.home, true) // no fresh supervisor heartbeat: main takes it
        await h.app.sendMessage('trip', 'anyone there?')
        await h.waitNotes(1)
        expect(h.notes[0]?.meta.routed).toBe('fallback')
        await restart(h)
        await waitFor(() => noticeRows(h as Harness).length === 1, 5000, 'the unanswered line for the fallback')
        const row = noticeRows(h)[0]?.raw.message as { thread_id: string }
        expect(row.thread_id).toBe('trip')
      },
      HARNESS_START_MS + t(60_000),
    )

    test(
      "a message handed to the thread worker is the router's: main stores nothing for it",
      async () => {
        h = await dedicated()
        workers(h.home, false)
        const sent = await h.app.sendMessage('trip', 'for the worker')
        // the bridge's delivered receipt comes after the router took the message and the unanswered list was told of it
        await h.relay.expectFrame('receipt', (f) => f.message_id === sent.client_msg_id && f.state === 'delivered', {
          direction: 'from_bridge',
        })
        await sleep(t(600)) // timing-ok: negative window, from the delivered receipt: main is told nothing and stores nothing
        expect(h.notes).toHaveLength(0) // waiting for the worker's claim, not delivered to main
        expect(h.bridge.ctx.store.kvGet('unanswered_v1') ?? '{}').toBe('{}')
      },
      HARNESS_START_MS + t(20_000),
    )
  })

  test(
    'an entry more than a day old is dropped without a word',
    async () => {
      h = await startHarness()
      h.bridge.ctx.store.kvSet(
        'unanswered_v1',
        JSON.stringify({
          m_old: { thread: 'general', at: Date.now() - UNANSWERED_MAX_AGE_MS - 60_000, run: 'run_earlier', pid: 1 },
        }),
      )
      const next = await restart(h)
      await sleep(t(500)) // timing-ok: negative window, from the new bridge authed (its ready, and the once-per-process check, have run): no report
      expect(noticeRows(h)).toHaveLength(0)
      expect(next.bridge.ctx.store.kvGet('unanswered_v1')).toBe('{}')
    },
    HARNESS_START_MS + t(35_000),
  )
})

describe('T10 one combined line', () => {
  test(
    'messages left in two threads, one of them days old, give ONE line that counts all of them',
    async () => {
      h = await startHarness()
      const DEAD_PID = 2_147_483_646
      const old = Date.now() - 3 * 24 * 3600_000
      h.bridge.ctx.store.kvSet(
        'unanswered_v1',
        JSON.stringify({
          m_a: { thread: 'general', at: old, run: 'run_earlier', pid: DEAD_PID },
          m_b: { thread: 'work', at: Date.now() - 1000, run: 'run_earlier', pid: DEAD_PID },
          m_c: { thread: 'work', at: Date.now() - 2000, run: 'run_earlier', pid: DEAD_PID },
        }),
      )
      await restart(h)
      await waitFor(() => noticeRows(h as Harness).length >= 1, 5000, 'the unanswered line')
      await sleep(t(500)) // timing-ok: negative window, from the first line seen: no second line follows
      expect(noticeRows(h)).toHaveLength(1)
      const row = noticeRows(h)[0]?.raw.message as { text: string } | undefined
      expect(row?.text).toContain('3 messages in 2 threads')
    },
    HARNESS_START_MS + t(45_000),
  )
})

describe('T10 how long an unanswered message is remembered', () => {
  const memStore = () => {
    const m = new Map<string, string>()
    return { kvGet: (k: string) => m.get(k), kvSet: (k: string, v: string) => void m.set(k, v) }
  }
  const DAY = 24 * 3600_000
  const NOW = 100 * DAY
  const seed = (store: ReturnType<typeof memStore>, ages: Record<string, [string, number]>) =>
    store.kvSet(
      'unanswered_v1',
      JSON.stringify(
        Object.fromEntries(
          Object.entries(ages).map(([id, [thread, ageMs]]) => [
            id,
            { thread, at: NOW - ageMs, run: 'run_earlier', pid: 1 },
          ]),
        ),
      ),
    )

  test('a message two days old and one thirteen days old are still reported; one fifteen days old is dropped', () => {
    const store = memStore()
    seed(store, { m_2d: ['general', 2 * DAY], m_13d: ['work', 13 * DAY], m_15d: ['work', 15 * DAY] })
    const me = new SeenTracker({ store, clock: { now: () => NOW } as never })
    const out = me.takeUnansweredFromEarlierRuns(() => false)
    expect(out.get('general')).toEqual(['m_2d'])
    expect(out.get('work')).toEqual(['m_13d'])
    expect(store.kvGet('unanswered_v1')).toBe('{}')
  })
})

describe('SeenTracker persistence', () => {
  const memStore = () => {
    const m = new Map<string, string>()
    return { kvGet: (k: string) => m.get(k), kvSet: (k: string, v: string) => void m.set(k, v) }
  }
  const clock = { now: () => 1_000_000 } as never

  test('entries of this run and of a still-living other process stay; a dead one is reported once', () => {
    const store = memStore()
    const earlier = new SeenTracker({ store, clock })
    earlier.add('general', 'm_a')
    earlier.add('work', 'm_b')
    const me = new SeenTracker({ store, clock })
    me.add('general', 'm_mine')
    // the earlier process is another pid and it is alive: a worker session, or a superseded bridge. Not ours to report.
    const raw = JSON.parse(store.kvGet('unanswered_v1') as string)
    raw.m_a.pid = 424242
    raw.m_b.pid = 424243
    store.kvSet('unanswered_v1', JSON.stringify(raw))
    expect(me.takeUnansweredFromEarlierRuns((pid) => pid === 424242).size).toBe(1) // only m_b's process is dead
    const kept = JSON.parse(store.kvGet('unanswered_v1') as string)
    expect(Object.keys(kept).sort()).toEqual(['m_a', 'm_mine'])
    expect(me.takeUnansweredFromEarlierRuns(() => false).get('general')).toEqual(['m_a'])
    expect(me.takeUnansweredFromEarlierRuns(() => false).size).toBe(0) // at most once
    expect(Object.keys(JSON.parse(store.kvGet('unanswered_v1') as string))).toEqual(['m_mine'])
  })

  test("take() (a touch) keeps the persisted ids; answered() drops this run's for that thread only; no store behaves as before", () => {
    const store = memStore()
    const t = new SeenTracker({ store, clock })
    t.add('general', 'm_1')
    t.add('general', 'm_2', { persist: false })
    t.add('work', 'm_w')
    expect(t.count('general')).toBe(2)
    expect(t.take('general')).toEqual(['m_1', 'm_2'])
    expect(Object.keys(JSON.parse(store.kvGet('unanswered_v1') as string)).sort()).toEqual(['m_1', 'm_w'])
    t.answered('general')
    expect(Object.keys(JSON.parse(store.kvGet('unanswered_v1') as string))).toEqual(['m_w'])
    const plain = new SeenTracker()
    plain.add('general', 'm_3')
    expect(plain.take('general')).toEqual(['m_3'])
    plain.answered('general')
    expect(plain.takeUnansweredFromEarlierRuns().size).toBe(0)
  })

  test('routerOwns keeps a worker-routed id out of the store; track() puts a fallback id in', () => {
    const store = memStore()
    const t = new SeenTracker({ store, clock })
    t.routerOwns('m_w')
    t.add('trip', 'm_w')
    expect(store.kvGet('unanswered_v1') ?? '{}').toBe('{}')
    t.track('trip', 'm_w') // the router fell back to this session
    expect(Object.keys(JSON.parse(store.kvGet('unanswered_v1') as string))).toEqual(['m_w'])
    expect(t.count('trip')).toBe(1)
  })
})
