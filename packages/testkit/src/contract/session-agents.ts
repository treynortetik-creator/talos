// Agents panel contracts (docs/SUBAGENTS.md). Two halves, each run here against the testkit's reference fakes:
//
//  - defineAgentsBridgeContract: what the bridge (WP-A1) does with `talos_mod_sync.agents` before anything reaches the
//    relay. The WP-A1 driver wraps the real ModLink + frames-out (and its history store for `durableText`).
//  - defineAgentsViewContract: what the app's session store (WP-A2) does with `ready.session_agents`, `session.agents`
//    and `session.state`. The WP-A2 driver wraps the real store (`features/session/store.ts`).
//
// The relay half (last snapshot in memory, `ready.session_agents`, never stored or pushed) is tested on the real relay
// directly (apps/relay/test/session.test.ts and test/core/session.test.ts).
import {
  AGENT_LIMITS,
  AGENTS_EMIT_INTERVAL_MS,
  AGENTS_HEARTBEAT_MS,
  type AgentRowT,
  type AgentsSnapshotT,
  agentsSnapshotBytes,
  MOD_LIVE_WINDOW_MS,
  parseFrame,
} from '@talos-app/protocol'
import { afterEach, describe, expect, it } from 'vitest'
import type { FakeClock } from '../clock.ts'
import { mkFrame } from '../frame-utils.ts'

type Raw = Record<string, unknown>

export interface AgentsBridgeDriver {
  readonly clock: FakeClock
  /** One authenticated mod sync. `agents` undefined = no `agents` member (the mod had nothing new). */
  sync(agents?: unknown): void | Promise<void>
  /** `session.end` reached the bridge. */
  endSession(): void | Promise<void>
  /** The `agents` of every `session.agents` frame the bridge sent toward the relay, in order, with the clock time. */
  emitted(): Array<{ at: number; agents: unknown }>
  /** Everything the bridge wrote durably so far (history store, outbox, files), as one string. */
  durableText(): string
  stop?(): void | Promise<void>
}
export type AgentsBridgeHarness = () => AgentsBridgeDriver | Promise<AgentsBridgeDriver>

export interface AgentsViewDriver {
  /** A raw relay -> app frame, exactly as the socket would deliver it. */
  receive(frame: Raw): void | Promise<void>
  /** The snapshot the panel draws from. */
  agents(): AgentsSnapshotT | undefined
  /** Whether the row's detail shows Stop. */
  showsStop(rowId: string): boolean
  stop?(): void | Promise<void>
}
export type AgentsViewHarness = () => AgentsViewDriver | Promise<AgentsViewDriver>

// ---- sample data -------------------------------------------------------------------------------------------------

const T0 = Date.parse('2026-10-30T12:00:00.000Z')
const iso = (ms: number) => new Date(ms).toISOString()

export function agentRowSample(over: Partial<AgentRowT> = {}): AgentRowT {
  return {
    id: 'a00f4f30ac1399f7f',
    kind: 'subagent',
    type: 'Explore',
    title: 'research mods API',
    status: 'running',
    activity: 'Running memory and search vitest suites',
    activity_source: 'summary',
    tokens: 12_300,
    started_at: iso(T0 - 134_000),
    background: true,
    stoppable: true,
    recent: [],
    ...over,
  }
}

export function agentsSnapshotSample(rows: AgentRowT[] = [agentRowSample()], over: Partial<AgentsSnapshotT> = {}) {
  return {
    session_id: 'sess_contract',
    source: 'mod',
    can_stop: true,
    rows,
    at: iso(T0),
    ...over,
  } satisfies AgentsSnapshotT
}

/** Schema-valid and over the frame cap: 50 rows, half ended, every one with 8 full recent lines. */
export function oversizeAgentsSnapshot(): AgentsSnapshotT {
  const full = (ch: string) => ch.repeat(AGENT_LIMITS.text)
  return agentsSnapshotSample(
    Array.from({ length: AGENT_LIMITS.rows }, (_, i) =>
      agentRowSample({
        id: `a${i}`,
        title: full('x'),
        activity: full('z'),
        status: i % 2 ? 'completed' : 'running',
        stoppable: i % 2 === 0,
        started_at: iso(T0 - (100 - i) * 1000),
        ...(i % 2 ? { ended_at: iso(T0 - (50 - i) * 1000) } : {}),
        recent: Array.from({ length: AGENT_LIMITS.recent }, (_, j) => ({ at: iso(T0 - 60_000 + j), text: full('y') })),
      }),
    ),
  )
}

const asSnap = (x: unknown) => x as AgentsSnapshotT

// ---- bridge --------------------------------------------------------------------------------------------------------

export function defineAgentsBridgeContract(name: string, harness: AgentsBridgeHarness) {
  describe(`agents bridge contract: ${name}`, () => {
    let d: AgentsBridgeDriver | null = null
    const start = async () => {
      d = await harness()
      return d
    }
    afterEach(async () => {
      await d?.stop?.()
      d = null
    })
    /** Keeps the mod live while time passes (a sync every 2 s, without `agents`). */
    const passLive = async (drv: AgentsBridgeDriver, ms: number) => {
      for (let t = 0; t < ms; t += 2000) {
        drv.clock.advance(Math.min(2000, ms - t))
        await drv.sync()
      }
    }

    it('a valid snapshot goes out once, as a valid session.agents frame', async () => {
      const b = await start()
      const s = agentsSnapshotSample()
      await b.sync(s)
      const out = b.emitted()
      expect(out).toHaveLength(1)
      expect(asSnap(out[0]?.agents).rows.map((r) => r.id)).toEqual([s.rows[0]?.id])
      expect(
        parseFrame({ ...mkFrame('session.agents'), agents: out[0]?.agents }, { direction: 'bridge_to_relay' }).ok,
      ).toBe(true)
    })

    it(`a live mod's unchanged snapshot goes out again at least every ${AGENTS_HEARTBEAT_MS} ms (a restarted relay refills ready)`, async () => {
      const b = await start()
      await b.sync(agentsSnapshotSample([agentRowSample({ id: 'shell1', kind: 'shell', type: 'shell' })]))
      await passLive(b, 3 * AGENTS_HEARTBEAT_MS + 2000)
      const out = b.emitted()
      expect(out.length).toBeGreaterThanOrEqual(4)
      for (let i = 1; i < out.length; i++)
        expect((out[i]?.at ?? 0) - (out[i - 1]?.at ?? 0)).toBeLessThanOrEqual(AGENTS_HEARTBEAT_MS + 2000)
      expect(out.every((o) => asSnap(o.agents).rows[0]?.id === 'shell1')).toBe(true)
    })

    it(`unchanged (or only \`at\` changed) inside ${AGENTS_HEARTBEAT_MS} ms, or a sync without agents: nothing new goes out`, async () => {
      const b = await start()
      const s = agentsSnapshotSample()
      await b.sync(s)
      await passLive(b, 4000)
      await b.sync({ ...s, at: iso(T0 + 4000) })
      await passLive(b, 4000)
      expect(b.emitted()).toHaveLength(1)
    })

    it(`at most one frame per ${AGENTS_EMIT_INTERVAL_MS} ms, and the latest change still goes out`, async () => {
      const b = await start()
      await b.sync(agentsSnapshotSample([agentRowSample({ tokens: 1 })]))
      b.clock.advance(300)
      await b.sync(agentsSnapshotSample([agentRowSample({ tokens: 2 })]))
      b.clock.advance(300)
      await b.sync(agentsSnapshotSample([agentRowSample({ tokens: 3 })]))
      expect(b.emitted()).toHaveLength(1)
      await passLive(b, AGENTS_EMIT_INTERVAL_MS + 100)
      const out = b.emitted()
      expect(out.map((o) => asSnap(o.agents).rows[0]?.tokens)).toEqual([1, 3])
      for (let i = 1; i < out.length; i++)
        expect((out[i]?.at ?? 0) - (out[i - 1]?.at ?? 0)).toBeGreaterThanOrEqual(AGENTS_EMIT_INTERVAL_MS)
    })

    it('an invalid snapshot is dropped; the last good one stays and nothing goes out', async () => {
      const b = await start()
      await b.sync(agentsSnapshotSample())
      await passLive(b, 3000)
      for (const bad of [
        { nope: true },
        agentsSnapshotSample([agentRowSample({ status: 'zombie' as never })]),
        agentsSnapshotSample([agentRowSample({ title: 'x'.repeat(AGENT_LIMITS.text + 1) })]),
        { ...agentsSnapshotSample(), extra: 1 },
      ]) {
        await b.sync(bad)
        await passLive(b, 3000)
      }
      const out = b.emitted().map((o) => JSON.stringify(asSnap(o.agents).rows))
      expect(out.length).toBeGreaterThan(0)
      expect(new Set(out).size).toBe(1) // only the good one (re-sent on the beat), never a bad one
    })

    it('an oversize snapshot is trimmed under the cap, in order: recent on ended rows first, no row lost here', async () => {
      const b = await start()
      const big = oversizeAgentsSnapshot()
      expect(agentsSnapshotBytes(big)).toBeGreaterThan(AGENT_LIMITS.frameBytes)
      await b.sync(big)
      const sent = asSnap(b.emitted()[0]?.agents)
      expect(agentsSnapshotBytes(sent)).toBeLessThanOrEqual(AGENT_LIMITS.frameBytes)
      expect(sent.rows).toHaveLength(AGENT_LIMITS.rows)
      expect(sent.rows.filter((r) => r.status === 'completed').every((r) => r.recent.length === 0)).toBe(true)
      expect(parseFrame({ ...mkFrame('session.agents'), agents: sent }, { direction: 'bridge_to_relay' }).ok).toBe(true)
    })

    it('the mod lapses: one last snapshot with live rows unknown and no Stop; ended rows as they were', async () => {
      const b = await start()
      const done = agentRowSample({ id: 'done', status: 'completed', stoppable: false, ended_at: iso(T0) })
      await b.sync(agentsSnapshotSample([agentRowSample(), done]))
      b.clock.advance(MOD_LIVE_WINDOW_MS + 5000) // no sync at all
      const out = b.emitted()
      expect(out).toHaveLength(2)
      const last = asSnap(out[1]?.agents)
      expect(last.rows.map((r) => [r.id, r.status, r.stoppable])).toEqual([
        [agentRowSample().id, 'unknown', false],
        ['done', 'completed', false],
      ])
      b.clock.advance(MOD_LIVE_WINDOW_MS * 3)
      expect(b.emitted()).toHaveLength(2) // once
    })

    it('a mod that comes back after a lapse gets its live rows back', async () => {
      const b = await start()
      const s = agentsSnapshotSample()
      await b.sync(s)
      b.clock.advance(MOD_LIVE_WINDOW_MS + 5000)
      await b.sync(s)
      await passLive(b, AGENTS_EMIT_INTERVAL_MS + 100)
      const last = asSnap(b.emitted().at(-1)?.agents)
      expect(last.rows[0]?.status).toBe('running')
    })

    it('session.end: an empty snapshot for that session goes out', async () => {
      const b = await start()
      await b.sync(agentsSnapshotSample())
      await b.endSession()
      await passLive(b, AGENTS_EMIT_INTERVAL_MS + 100)
      const last = asSnap(b.emitted().at(-1)?.agents)
      expect(last.session_id).toBe('sess_contract')
      expect(last.rows).toEqual([])
    })

    it('a new session id: from then on, no frame carries the old session or its rows', async () => {
      const b = await start()
      await b.sync(agentsSnapshotSample([agentRowSample({ id: 'old' })]))
      b.clock.advance(500)
      await b.sync(agentsSnapshotSample([agentRowSample({ id: 'old', tokens: 9 })]))
      b.clock.advance(500)
      await b.sync(agentsSnapshotSample([agentRowSample({ id: 'new' })], { session_id: 'sess_next' }))
      await passLive(b, AGENTS_EMIT_INTERVAL_MS + 100)
      const out = b.emitted().map((o) => asSnap(o.agents))
      const firstNew = out.findIndex((s) => s.session_id === 'sess_next')
      expect(firstNew).toBeGreaterThan(-1)
      for (const s of out.slice(firstNew)) {
        expect(s.session_id).toBe('sess_next')
        expect(s.rows.some((r) => r.id === 'old')).toBe(false)
      }
    })

    it('nothing durable: no snapshot text reaches storage', async () => {
      const b = await start()
      const SENTINEL = 'agents-contract-sentinel-91c4'
      await b.sync(agentsSnapshotSample([agentRowSample({ title: SENTINEL, activity: SENTINEL })]))
      await passLive(b, 3000)
      await b.endSession()
      await passLive(b, 3000)
      expect(b.durableText()).not.toContain(SENTINEL)
    })
  })
}

// ---- web -----------------------------------------------------------------------------------------------------------

const stateFrame = (capabilities: string[], source = 'mod', session_id = 'sess_contract') => ({
  ...mkFrame('session.state'),
  state: { session_id, source, capabilities, rate_limits: [], surfaces: [], at: iso(T0) },
})
const agentsFrame = (agents: unknown) => ({ ...mkFrame('session.agents'), agents })
const readyFrame = (extra: Raw) => ({
  ...mkFrame('ready'),
  session_id: 'sess_ready',
  policy: { max_frame_bytes: 262144, ping_ms: 25000 },
  server_seq: 0,
  presence: { bridge_online: true, last_seen: iso(T0), queue_depth: 0 },
  ...extra,
})

export function defineAgentsViewContract(name: string, harness: AgentsViewHarness) {
  describe(`agents view contract: ${name}`, () => {
    let v: AgentsViewDriver | null = null
    const start = async () => {
      v = await harness()
      return v
    }
    afterEach(async () => {
      await v?.stop?.()
      v = null
    })

    it('ready.session_agents fills the panel', async () => {
      const view = await start()
      expect(view.agents()).toBeUndefined()
      await view.receive(readyFrame({ session_agents: agentsSnapshotSample() }))
      expect(view.agents()?.rows.map((r) => r.id)).toEqual([agentRowSample().id])
    })

    it('each session.agents replaces the snapshot wholesale (rows are never merged)', async () => {
      const view = await start()
      await view.receive(agentsFrame(agentsSnapshotSample([agentRowSample({ id: 'a' }), agentRowSample({ id: 'b' })])))
      await view.receive(agentsFrame(agentsSnapshotSample([agentRowSample({ id: 'c', status: 'idle' })])))
      expect(view.agents()?.rows.map((r) => `${r.id}:${r.status}`)).toEqual(['c:idle'])
    })

    it('an empty snapshot clears the rows', async () => {
      const view = await start()
      await view.receive(agentsFrame(agentsSnapshotSample()))
      await view.receive(agentsFrame(agentsSnapshotSample([])))
      expect(view.agents()?.rows).toEqual([])
    })

    it('a frame that does not parse is ignored and the last good snapshot stays', async () => {
      const view = await start()
      await view.receive(agentsFrame(agentsSnapshotSample()))
      await view.receive(agentsFrame({ ...agentsSnapshotSample([]), rows: 'nope' }))
      await view.receive(agentsFrame(oversizeAgentsSnapshot())) // untrimmed: over the frame cap
      expect(view.agents()?.rows).toHaveLength(1)
    })

    it("a snapshot of another session than the state's is not shown (no rows, no Stop)", async () => {
      const view = await start()
      await view.receive(
        readyFrame({
          session_state: stateFrame(['stop'], 'mod', 'sess_next').state,
          session_agents: agentsSnapshotSample([agentRowSample({ id: 'old' })]),
        }),
      )
      expect(view.agents()?.rows ?? []).toHaveLength(0)
      expect(view.showsStop('old')).toBe(false)
      await view.receive(stateFrame(['stop'])) // back on the snapshot's session
      expect(view.agents()?.rows.map((r) => r.id)).toEqual(['old'])
    })

    it('Stop shows only for a stoppable live row of a can_stop snapshot, with a live mod state of that session', async () => {
      const view = await start()
      const rows = [
        agentRowSample({ id: 'live' }),
        agentRowSample({ id: 'no-stop', stoppable: false }),
        agentRowSample({ id: 'done', status: 'completed', stoppable: false }),
      ]
      await view.receive(agentsFrame(agentsSnapshotSample(rows, { can_stop: false })))
      await view.receive(stateFrame(['stop']))
      expect(view.showsStop('live')).toBe(false) // the mod cannot stop agents
      await view.receive(agentsFrame(agentsSnapshotSample(rows)))
      await view.receive(stateFrame(['stop'], 'hooks'))
      expect(view.showsStop('live')).toBe(false) // not the mod
      await view.receive(stateFrame(['stop']))
      expect(view.showsStop('live')).toBe(true)
      expect(view.showsStop('no-stop')).toBe(false)
      expect(view.showsStop('done')).toBe(false)
      expect(view.showsStop('missing')).toBe(false)
      await view.receive(stateFrame([], 'mod')) // the bridge's "mod offline" state
      expect(view.showsStop('live')).toBe(false)
    })
  })
}
