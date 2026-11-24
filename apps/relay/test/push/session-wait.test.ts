// A session that waits on the owner too long gets one push (core/session-wait.ts): when it is due, once per wait, several in
// one push, never for a pending card, a usage limit about to reset, a Mac that is not reporting, or a thread that is off.
import type { AgentConfigT, PushIntent, WorkerStatusItemT, WorkersStatusT } from '@talos-app/protocol'
import { fakeClock, sleep, waitFor } from '@talos-app/testkit'
import { describe, expect, it } from 'vitest'
import { DEFAULT_AGENT_CONFIG } from '../../src/core/default-config.ts'
import type { PushCounts } from '../../src/core/push.ts'
import { SESSION_WAIT_PUSH_MS, SessionWait } from '../../src/core/session-wait.ts'
import type { Store } from '../../src/core/store.ts'
import type { RichPushInput } from '../../src/services.ts'
import { startTestRelay } from '../core/harness.ts'
import { kit } from '../core/helpers.ts'

const MIN = 60_000
const T0 = Date.parse('2026-11-13T17:00:00.000Z')

const thread = (id: string, over: Record<string, unknown> = {}) => ({
  id,
  name: id === 'trip' ? 'Trip planning' : id,
  icon: '💬',
  kind: 'fixed' as const,
  order: 5,
  notify: 'all' as const,
  archived: false,
  created_at: '2026-10-28T00:00:00.000Z',
  ...over,
})
const CFG = {
  ...DEFAULT_AGENT_CONFIG,
  timezone: 'Europe/Paris',
  threads: [thread('trip'), thread('garden'), thread('music'), thread('quiet', { notify: 'off' })],
} as unknown as AgentConfigT

function setup(o: { result?: PushCounts | null; cards?: string[] } = {}) {
  const clock = fakeClock(new Date(T0).toISOString())
  const state = new Map<string, string>()
  const store = {
    openCards: () => (o.cards ?? []).map((t) => ({ thread_id: t })),
    getState: (k: string) => state.get(k) ?? null,
    setState: (k: string, v: string) => void state.set(k, v),
    deleteState: (k: string) => void state.delete(k),
    stateKeys: (p: string) => [...state.keys()].filter((k) => k.startsWith(p)),
  } as unknown as Store
  const sent: Array<{ intent: PushIntent; rich?: RichPushInput | undefined }> = []
  let result: PushCounts | null = o.result === undefined ? { sent: 1, ok: 1, native: { sent: 0, ok: 0 } } : o.result
  const push = {
    async notifyCounted(intent: PushIntent, opts?: { rich?: RichPushInput }) {
      sent.push({ intent, rich: opts?.rich })
      return result
    },
  }
  const w = new SessionWait({ store, clock, log: { error() {}, info() {} } as never, push, config: () => CFG })
  w.start()
  return {
    w,
    clock,
    state,
    sent,
    setResult: (r: PushCounts | null) => {
      result = r
    },
  }
}

const waiting = (thread_id: string, minAgo: number, over: Partial<WorkerStatusItemT> = {}): WorkerStatusItemT => ({
  thread_id,
  state: 'live',
  needs_you: { kind: 'trust this folder', since: new Date(T0 - minAgo * MIN).toISOString() },
  ...over,
})
const status = (threads: WorkerStatusItemT[], online = true): WorkersStatusT => ({
  supported: true,
  supervisor_online: online,
  threads,
  governor: { state: 'ok' },
  at: new Date(T0).toISOString(),
})
/** One look at `at` minutes after T0 (the clock only moves forward). */
const look = async (s: ReturnType<typeof setup>, st: WorkersStatusT | undefined, at = 0) => {
  const target = T0 + at * MIN
  if (s.clock.now() < target) s.clock.advance(target - s.clock.now())
  s.w.update(st)
  await s.w.tick()
}

describe('SessionWait', () => {
  it('pushes once when a wait reaches 10 minutes, not before, and never again for the same wait', async () => {
    const s = setup()
    const st = status([waiting('trip', 9)])
    await look(s, st)
    expect(s.sent).toHaveLength(0)
    await look(s, st, 1)
    expect(s.sent.map((x) => x.intent)).toEqual([
      { template: 'session_waiting', thread_id: 'trip', expires_at: new Date(T0 + MIN + 2 * 60 * MIN).toISOString() },
    ])
    await look(s, st, 2)
    await look(s, st, 40)
    expect(s.sent).toHaveLength(1)
  })

  it("the deaf-thread alarm's Needs you (since = when the refusals began) pushes at once when it is already 10 minutes old, once", async () => {
    const s = setup()
    const deaf = { kind: 'something Talos does not type into', since: new Date(T0 - 11 * MIN).toISOString() }
    const st = status([{ thread_id: 'trip', state: 'live', needs_you: deaf }])
    await look(s, st)
    expect(s.sent.map((x) => x.intent.template)).toEqual(['session_waiting'])
    await look(s, st, 5)
    expect(s.sent).toHaveLength(1)
  })

  it('a new wait (a new since) is a new notice; a wait that ended leaves nothing behind', async () => {
    const s = setup()
    await look(s, status([waiting('trip', 12)]))
    await look(s, status([{ thread_id: 'trip', state: 'live' }]), 1)
    await look(s, status([{ thread_id: 'trip', state: 'live' }]), 3) // gone for 2 minutes: forgotten
    expect([...s.state.keys()]).toEqual([])
    await look(s, status([waiting('trip', -1)]), 15) // a new wait that began 1 min after T0
    expect(s.sent).toHaveLength(2)
  })

  it('a restart of the watcher (the relay) repeats nothing: the mark is in the store', async () => {
    const s = setup()
    const st = status([waiting('trip', 12)])
    await look(s, st)
    const store = (s.w as unknown as { d: { store: Store } }).d.store
    s.w.stop()
    const again = new SessionWait({
      store,
      clock: s.clock,
      log: { error() {}, info() {} } as never,
      push: { notifyCounted: async (i: PushIntent) => (s.sent.push({ intent: i }), null) },
      config: () => CFG,
    })
    again.start()
    s.clock.advance(MIN)
    again.update(st)
    await again.tick()
    expect(s.sent).toHaveLength(1)
  })

  it('several sessions due in one look: one push with the count, each wait marked', async () => {
    const s = setup()
    const st = status([waiting('trip', 15), waiting('garden', 12), waiting('music', 11)])
    await look(s, st)
    expect(s.sent.map((x) => x.intent)).toEqual([
      { template: 'session_waiting', count: 3, expires_at: new Date(T0 + 2 * 60 * MIN).toISOString() },
    ])
    expect([...s.state.values()]).toEqual(['sent', 'sent', 'sent'])
    await look(s, st, 1)
    expect(s.sent).toHaveLength(1)
  })

  it('a thread with a pending card is skipped (the card already pushed); so is a thread whose notifications are off', async () => {
    const s = setup({ cards: ['trip'] })
    await look(s, status([waiting('trip', 30), waiting('quiet', 30)]))
    expect(s.sent).toHaveLength(0)
  })

  it('a usage limit that resets within 10 minutes is not pushed; one that resets later is', async () => {
    const s = setup()
    const limit = (thread_id: string, resetIn: number) =>
      waiting(thread_id, 20, {
        needs_you: {
          kind: 'usage limit',
          since: new Date(T0 - 20 * MIN).toISOString(),
          resets_at: new Date(T0 + resetIn * MIN).toISOString(),
        },
      })
    await look(s, status([limit('garden', 9)]))
    expect(s.sent).toHaveLength(0)
    await look(s, status([limit('trip', 45)]))
    expect(s.sent).toHaveLength(1)
    // a usage limit's push lives only until the limit resets
    expect(s.sent[0]?.intent.expires_at).toBe(new Date(T0 + 45 * MIN).toISOString())
  })

  it('the Mac not reporting (or gone): nothing is pushed and nothing forgotten', async () => {
    const s = setup()
    const w = waiting('trip', 30)
    await look(s, status([w], false))
    await look(s, undefined, 1)
    expect(s.sent).toHaveLength(0)
    await look(s, status([w]), 2)
    expect(s.sent).toHaveLength(1)
  })

  it('held back by a rule (the quiet window): not marked, so it goes out on a later look if still waiting', async () => {
    const s = setup({ result: null })
    const st = status([waiting('trip', 30)])
    await look(s, st)
    expect([...s.state.keys()]).toEqual([])
    s.setResult({ sent: 1, ok: 1, native: { sent: 0, ok: 0 } })
    await look(s, st, 1)
    expect([...s.state.values()]).toEqual(['sent'])
    const n = s.sent.length
    await look(s, st, 2)
    expect(s.sent).toHaveLength(n)
  })

  it('every service refused: tried again after 1, 2, 4 and 8 minutes, five sends in all; a burst of frames sends no more', async () => {
    const s = setup({ result: { sent: 1, ok: 0, native: { sent: 0, ok: 0 } } })
    const st = status([waiting('trip', 30)])
    await look(s, st)
    for (let i = 0; i < 5; i++) await look(s, st) // the bridge sends frames often: no send before the backoff is up
    expect(s.sent).toHaveLength(1)
    for (let m = 1; m <= 30; m++) await look(s, st, m)
    expect(s.sent).toHaveLength(5)
  })

  it('/healthz reads it: running while started, not once stopped', () => {
    const s = setup()
    expect(s.w.health()).toEqual({ running: true, after_ms: 600_000, tick_ms: 60_000 })
    s.w.stop()
    expect(s.w.health().running).toBe(false)
  })

  it('it also looks on its own once a minute', async () => {
    const s = setup()
    await look(s, status([waiting('trip', 9)]))
    expect(s.sent).toHaveLength(0)
    s.clock.advance(SESSION_WAIT_PUSH_MS)
    await s.w.tick()
    expect(s.sent).toHaveLength(1)
  })
})

describe("SessionWait: Main's own wait", () => {
  const mainWaits = (minAgo: number) => ({
    kind: 'trust this folder',
    since: new Date(T0 - minAgo * MIN).toISOString(),
  })

  it('Main waiting 10 minutes: one push that opens the default thread; once per wait', async () => {
    const s = setup()
    const st = { ...status([]), main_needs_you: mainWaits(12) }
    await look(s, st)
    expect(s.sent.map((x) => x.intent.thread_id)).toEqual([CFG.default_thread ?? 'general'])
    expect([...s.state.keys()]).toEqual([`session_waited:@main:${mainWaits(12).since}`])
    await look(s, st, 1)
    expect(s.sent).toHaveLength(1)
  })

  it('Main and a thread due together: one push for two', async () => {
    const s = setup()
    await look(s, { ...status([waiting('trip', 15)]), main_needs_you: mainWaits(12) })
    expect(s.sent.map((x) => x.intent)).toMatchObject([{ template: 'session_waiting', count: 2 }])
  })

  it('one look that misses the wait (a flap) does not make it a new notice', async () => {
    const s = setup()
    const st = { ...status([]), main_needs_you: mainWaits(12) }
    await look(s, st)
    await look(s, status([]), 1) // the Mac app's file read between writes
    await look(s, st, 2)
    expect(s.sent).toHaveLength(1)
  })

  it('a thread named "main" and Main are two waits', async () => {
    const s = setup()
    const since = mainWaits(12).since
    await look(s, {
      ...status([{ thread_id: 'main', state: 'live', needs_you: { kind: 'sign in', since } }]),
      main_needs_you: mainWaits(12),
    })
    expect(s.sent.map((x) => x.intent)).toMatchObject([{ count: 2 }])
  })

  it('the default thread set to "off" silences Main too', async () => {
    const home = CFG.default_thread ?? 'general'
    const quiet = { ...CFG, threads: [...CFG.threads.filter((t) => t.id !== home), thread(home, { notify: 'off' })] }
    const s = setup()
    ;(s.w as unknown as { d: { config: () => unknown } }).d.config = () => quiet
    await look(s, { ...status([]), main_needs_you: mainWaits(30) })
    expect(s.sent).toHaveLength(0)
  })

  it('a pending card in the default thread covers Main (the card already pushed)', async () => {
    const s = setup({ cards: [CFG.default_thread ?? 'general'] })
    await look(s, { ...status([]), main_needs_you: mainWaits(30) })
    expect(s.sent).toHaveLength(0)
  })
})

describe('SessionWait in a running relay', () => {
  it('a workers.status from the bridge with a 10-minute wait reaches the phone as one fixed-text push that opens the thread', async () => {
    const clock = fakeClock(new Date(T0).toISOString())
    const r = await startTestRelay({ clock })
    try {
      r.runtime.store.putSub({
        endpoint: 'https://push.example.com/send/session-wait',
        keys: { p256dh: 'a', auth: 'b' },
      })
      const b = await kit(r).bridge({ autoReply: false }).connect()
      b.send({
        type: 'config.sync',
        config: { ...CFG, quiet_window: { start: '22:00', end: '06:00' }, rev: 2 },
        rev: 2,
      })
      await waitFor(() => r.runtime.hub.agentConfig()?.rev === 2, 3000, 'config')
      b.send({ type: 'workers.status', status: status([waiting('trip', 12)]) })
      await waitFor(() => r.transport.sent.length > 0, 3000, 'the push')
      const p = r.transport.sent[0]?.payload
      expect(p?.notification.body).toBe('A session in Trip planning is waiting on you')
      expect(p?.notification.navigate).toBe('/t/trip')
      expect(JSON.stringify(p)).not.toContain('trust this folder') // the kind never rides in the fixed payload
      b.send({ type: 'workers.status', status: status([waiting('trip', 12)]) })
      await sleep(50) // real time: a second push, if any, would have gone by now
      expect(r.transport.sent).toHaveLength(1)
      await b.close()
    } finally {
      await r.stop()
    }
  })
})
