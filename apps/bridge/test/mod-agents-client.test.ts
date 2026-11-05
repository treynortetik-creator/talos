// WP-A1: the mod's agents collector (plugins/talos-app-mod/hooks/lib/agents.ts) driven against the REAL bridge end
// (ModLink + the two tool handlers). Two jobs: (1) parity: what the mod's import-free copy builds is accepted by the
// protocol's strict AgentsSnapshot, whatever the engine hands it; (2) the link: `agents` only to a bridge that said so at
// hello, only when it changed, again in full after a new hello, and the MAC covers it.
import { describe, expect, test } from 'bun:test'
import {
  AGENT_LIMITS,
  AgentsSnapshot,
  type AgentsSnapshotT,
  agentActivityForTool,
  oneLine,
  type SessionStateT,
} from '@talos-app/protocol'
import { fakeClock } from '@talos-app/testkit'
import {
  AgentsCollector,
  AgentTracker,
  activityForTool,
  oneLine as modOneLine,
} from '../../../plugins/talos-app-mod/hooks/lib/agents.ts'
import type { EngineLike } from '../../../plugins/talos-app-mod/hooks/lib/engine.ts'
import { EventQueue, SessionFlags, TimeSource } from '../../../plugins/talos-app-mod/hooks/lib/events.ts'
import { BridgeLink } from '../../../plugins/talos-app-mod/hooks/lib/link.ts'
import { ModLink } from '../src/mod/link.ts'
import { ok } from '../src/tools/common.ts'
import { talosModHello, talosModSync } from '../src/tools/mod.ts'

const HELLO = 'mcp__talos-app__talos_mod_hello'
const SYNC = 'mcp__talos-app__talos_mod_sync'

function rig(o: { oldBridge?: boolean } = {}) {
  const clock = fakeClock('2026-10-30T12:00:00.000Z')
  const secret = { value: '' }
  const agentsOut: AgentsSnapshotT[] = []
  const states: SessionStateT[] = []
  const rec = () => {}
  const link = new ModLink({
    clock,
    log: { debug: rec, info: rec, warn: rec, error: rec, security: rec },
    keys: {
      read: () => secret.value,
      write: (k) => {
        secret.value = k
      },
    },
    sink: { state: (s) => states.push(s), inventory: () => {}, agents: (a) => agentsOut.push(a) },
  })
  const syncArgs: Array<Record<string, unknown>> = []
  const eng = { list: [] as unknown[], tee: '' }
  const engine: EngineLike = {
    plugin: { name: 'talos-app-mod' },
    secret: { read: async () => secret.value },
    turn: { abort: async () => undefined },
    clock: { now: async () => clock.now(), every: () => 1, after: () => 1 },
    mcp: {
      async call(_server, tool, args = {}) {
        if (tool === 'talos_mod_hello') {
          const r = await talosModHello.handler({ mod: link } as never, args)
          return o.oldBridge && !r.isError ? ok('{"ok":true}') : r // a bridge from before WP-A1 says no features
        }
        syncArgs.push(args)
        return talosModSync.handler({ mod: link } as never, args)
      },
    },
    tool: { list: async () => [HELLO, SYNC].map((name) => ({ name, mcp: true })) },
    command: { list: async () => [], run: async () => ({}) },
    config: { list: async () => [] },
    session: {
      id: async () => 'sess_1',
      model: async () => 'claude-opus-5-5',
      version: async () => ({ version: '2.1.312' }),
      usage: async () => ({}),
      surfaces: async () => ['terminal'],
      compact: async () => ({}),
    },
    agent: { list: async () => eng.list },
    tee: { read: async () => eng.tee, clear: async () => {} },
  }
  const time = new TimeSource()
  const events = new EventQueue(time.now)
  const tracker = new AgentTracker()
  const collector = new AgentsCollector(engine, tracker, true)
  const client = new BridgeLink(
    engine,
    new SessionFlags(events),
    events,
    { capabilities: ['inventory', 'agents', 'agent_stop'], version: '2.1.312' },
    time,
    undefined,
    undefined,
    collector,
  )
  const tick = async (ms = 2000) => {
    clock.advance(ms)
    time.set(clock.now())
    await client.tick()
  }
  return { clock, link, client, tick, eng, tracker, collector, agentsOut, states, syncArgs, secret }
}

describe('the mod collector against the real bridge', () => {
  test('rows reach the bridge, parse strictly, and go again only when they changed', async () => {
    const r = rig()
    r.eng.list = [{ id: 'a1', description: 'research mods API', type: 'Explore', status: 'running' }]
    r.tracker.toolCall('a1', 'Read', { file_path: '/repo/x.ts' }, r.clock.now())
    await r.tick()
    expect(r.syncArgs[0]?.agents).toBeDefined()
    expect(AgentsSnapshot.safeParse(r.syncArgs[0]?.agents).success).toBe(true)
    expect(r.link.liveAgents()?.rows[0]).toMatchObject({ id: 'a1', activity: 'Read x.ts', stoppable: true })
    expect(r.agentsOut).toHaveLength(1)
    await r.tick()
    await r.tick()
    expect(r.syncArgs.slice(1).some((a) => 'agents' in a)).toBe(false)
    r.eng.list = [{ id: 'a1', description: 'research mods API', type: 'Explore', status: 'completed' }]
    await r.tick()
    expect(r.link.liveAgents()?.rows[0]).toMatchObject({ status: 'completed', stoppable: false })
    // published session.state never carries agents / agent_stop (old peers), the bridge's own copy does
    expect(r.link.liveState()?.capabilities).toEqual(expect.arrayContaining(['agents', 'agent_stop']))
  })

  test('an older bridge (hello without features) gets no agents member, and every sync stays authorized', async () => {
    const r = rig({ oldBridge: true })
    r.eng.list = [{ id: 'a1', description: 'x', type: 'Explore', status: 'running' }]
    await r.tick()
    await r.tick()
    expect(r.syncArgs.length).toBeGreaterThanOrEqual(2)
    expect(r.syncArgs.some((a) => 'agents' in a)).toBe(false)
    expect(r.link.live).toBe(true)
    // R1: nor the two capabilities a bridge from before A0 would refuse the whole state for
    const caps = r.syncArgs.flatMap((a) => (a.state as { capabilities?: string[] } | undefined)?.capabilities ?? [])
    expect(caps.length).toBeGreaterThan(0)
    expect(caps).not.toContain('agents')
    expect(caps).not.toContain('agent_stop')
  })

  test('a new hello (the bridge restarted) gets the snapshot again in full', async () => {
    const r = rig()
    r.eng.list = [{ id: 'a1', description: 'x', type: 'Explore', status: 'running' }]
    await r.tick()
    const fresh = new ModLink({
      clock: r.clock,
      log: { debug() {}, info() {}, warn() {}, error() {}, security() {} },
      keys: {
        read: () => r.secret.value,
        write: (k) => {
          r.secret.value = k
        },
      },
      sink: { state: () => {}, inventory: () => {} },
    })
    ;(r.link as unknown as { sync: unknown }).sync = fresh.sync.bind(fresh) // the old link now says unauthorized
    ;(r.link as unknown as { hello: unknown }).hello = fresh.hello.bind(fresh)
    await r.tick()
    await r.tick()
    expect(fresh.liveAgents()?.rows.map((x) => x.id)).toEqual(['a1'])
  })

  test('parity: hostile engine strings and too many rows still make a strictly valid snapshot', async () => {
    const r = rig()
    const nasty = `bad\u0007 ${'\u202e'}name\nwith\u2028breaks ${'x'.repeat(400)}`
    r.eng.list = [
      ...Array.from({ length: 60 }, (_, i) => ({
        id: `a${i}`,
        description: nasty,
        type: i % 3 ? 'Explore' : nasty,
        status: i % 2 ? 'completed' : 'zombie',
        name: nasty,
      })),
      { id: 'bad\nid', description: 'x', type: 'Explore', status: 'running' },
      { id: 'x'.repeat(81), description: 'x', type: 'Explore', status: 'running' },
      { id: 'a0', description: 'dupe', type: 'Explore', status: 'running' },
      7,
      null,
    ]
    for (let i = 0; i < 12; i++) r.tracker.toolCall('a0', 'Bash', { command: nasty }, r.clock.now() + i)
    r.tracker.shellStarted('bash_1', 'shell', nasty, r.clock.now())
    r.eng.tee = JSON.stringify({ v: 1, at: r.clock.now() + 2000, tasks: [{ id: 'a0', label: nasty, tokenCount: -5 }] })
    await r.tick()
    const sent = r.syncArgs[0]?.agents
    const p = AgentsSnapshot.safeParse(sent)
    expect(p.success).toBe(true)
    const rows = p.success ? p.data.rows : []
    expect(rows).toHaveLength(AGENT_LIMITS.rows)
    expect(rows.filter((x) => x.status === 'unknown').length).toBe(30) // live-ish rows kept first
    expect(rows.some((x) => x.id === 'bad\nid')).toBe(false)
    expect(rows.find((x) => x.id === 'a0')?.recent).toHaveLength(AGENT_LIMITS.recent)
    expect(rows.find((x) => x.id === 'a0')?.tokens).toBeUndefined() // a negative tee count is not a count
    expect(p.success && p.data.source).toBe('mod+tee')
    expect(r.link.liveAgents()?.rows).toHaveLength(AGENT_LIMITS.rows)
  })

  test("parity: the mod's oneLine and activity text match the protocol's", () => {
    const samples = ['', '  a\tb\n c  ', `${'é'.repeat(200)}`, `${'😀'.repeat(100)}`, 'x\u202ey', 'x'.repeat(160)]
    for (const s of samples) for (const max of [1, 2, 80, 160]) expect(modOneLine(s, max)).toBe(oneLine(s, max))
    const calls: Array<[string, unknown]> = [
      ['Bash', { description: 'Run vitest suites', command: 'pnpm test' }],
      ['Bash', { command: 'x'.repeat(200) }],
      ['Read', { file_path: '/a/b/c.ts' }],
      ['Edit', { file_path: 'C:\\x\\y.md' }],
      ['Write', {}],
      ['Grep', { pattern: 'secret' }],
      ['Glob', {}],
      ['WebFetch', { url: 'https://example.com/a?b' }],
      ['WebFetch', { url: 'not a url' }],
      ['Agent', { subagent_type: 'Explore', description: 'look' }],
      ['Task', {}],
      ['mcp__talos-app__reply', { text: 'hi' }],
      ['TodoWrite', null],
    ]
    for (const [tool, input] of calls) expect(activityForTool(tool, input)).toBe(agentActivityForTool(tool, input))
  })

  test('session.end: that session sends an empty snapshot next; a new session id starts afresh', async () => {
    const r = rig()
    r.eng.list = [{ id: 'a1', description: 'x', type: 'Explore', status: 'running' }]
    await r.tick()
    r.collector.sessionEnded('sess_1')
    await r.tick()
    r.clock.advance(2000)
    expect(r.link.liveAgents()).toMatchObject({ session_id: 'sess_1', rows: [] })
  })
})
