// Agents panel (docs/SUBAGENTS.md): the bridge and view contracts run against the testkit's reference fakes (WP-A1 and
// WP-A2 run the SAME contracts against the real bridge and the real web store); FakeMod's task registry, `agents` on a
// sync and `agent_stop`; FakeRelay's last-snapshot `ready`.
import { AgentsSnapshot, ModSyncRequest } from '@talos-app/protocol'
import { describe, expect, it } from 'vitest'
import {
  defineAgentsBridgeContract,
  defineAgentsViewContract,
  FakeAgentsLink,
  FakeAgentsView,
  FakeMod,
  fakeClock,
} from '../src/index.ts'

defineAgentsBridgeContract('FakeAgentsLink', () => {
  const clock = fakeClock('2026-10-30T12:00:00.000Z')
  const link = new FakeAgentsLink(clock)
  return {
    clock,
    sync: (agents) => link.sync(agents),
    endSession: () => link.end(),
    emitted: () => link.sent,
    durableText: () => '', // the reference keeps nothing but memory
    stop: () => link.close(),
  }
})

defineAgentsViewContract('FakeAgentsView', () => {
  const view = new FakeAgentsView()
  return { receive: (f) => view.receive(f), agents: () => view.agents(), showsStop: (id) => view.showsStop(id) }
})

const ID = (n: number) => `01JBF3V7Q8K2M4N6P8R0S2T4${'0123456789ABCDEFGHJKMNPQRSTVWXYZ'[n % 32]}0`

describe('FakeMod agents', () => {
  const make = (opts: { missingMethods?: string[] } = {}) => {
    const clock = fakeClock('2026-10-30T12:00:00.000Z')
    const mod = new FakeMod({ clock, ...opts })
    return { clock, mod, engine: mod.engine }
  }

  it('reports agents and agent_stop from $.agent.list and $.tool.call; without them, neither', () => {
    expect(make().mod.capabilities()).toEqual(expect.arrayContaining(['sessions', 'agents', 'agent_stop']))
    const caps = make({ missingMethods: ['agent.list', 'tool.call'] }).mod.capabilities()
    expect(caps).not.toContain('agents')
    expect(caps).not.toContain('agent_stop')
  })

  it('a sync carries agents only when they changed; no tasks yet means no agents member', () => {
    const { mod, engine, clock } = make()
    const k = 'k'.repeat(43)
    expect(mod.syncRequest(k).agents).toBeUndefined()
    engine.spawnAgent({ id: 'a1', type: 'Explore', description: 'research mods API' })
    const first = mod.syncRequest(k)
    expect(ModSyncRequest.safeParse(first).success).toBe(true)
    expect(first.agents?.rows.map((r) => [r.id, r.kind, r.status, r.stoppable])).toEqual([
      ['a1', 'subagent', 'running', true],
    ])
    clock.advance(2000)
    expect(mod.syncRequest(k).agents).toBeUndefined() // only `at` moved
    engine.agentTool('a1', 'Read', { file_path: '/repo/hooks/register.ts' })
    const next = mod.syncRequest(k).agents
    expect(next?.rows[0]).toMatchObject({ activity: 'Read register.ts', activity_source: 'tool' })
    expect(next?.rows[0]?.recent.map((l) => l.text)).toEqual(['Read register.ts'])
  })

  it('the tee summary wins over the tool line when it differs from the description; shells are tracked', () => {
    const { mod, engine } = make()
    engine.spawnAgent({ id: 'a1', type: 'Explore', description: 'research' })
    engine.agentTool('a1', 'Bash', { description: 'Run vitest suites', command: 'pnpm test' })
    engine.agentSummary('a1', 'Running memory and search vitest suites')
    engine.agentUsage('a1', 12_300)
    engine.startShell('b1', 'Run the dev server')
    const s = mod.agents()
    expect(AgentsSnapshot.safeParse(s).success).toBe(true)
    expect(s?.source).toBe('mod+tee')
    expect(s?.rows[0]).toMatchObject({
      activity: 'Running memory and search vitest suites',
      activity_source: 'summary',
    })
    expect(s?.rows[0]?.tokens).toBe(12_300)
    expect(s?.rows[1]).toMatchObject({ id: 'b1', kind: 'shell', type: 'shell', background: true })
    engine.agentSummary('a1', 'research') // same as the description: the tool line shows
    expect(mod.agents()?.rows[0]).toMatchObject({ activity: 'Run vitest suites', activity_source: 'tool' })
  })

  it('recent keeps the last 8 tool lines; ended tasks leave after 10 minutes', () => {
    const { mod, engine, clock } = make()
    engine.spawnAgent({ id: 'a1', description: 'many reads' })
    for (let i = 0; i < 12; i++) engine.agentTool('a1', 'Read', { file_path: `/r/f${i}.ts` })
    expect(mod.agents()?.rows[0]?.recent.map((l) => l.text)).toEqual(
      Array.from({ length: 8 }, (_, i) => `Read f${i + 4}.ts`),
    )
    engine.setTaskStatus('a1', 'completed')
    expect(mod.agents()?.rows[0]).toMatchObject({ status: 'completed', stoppable: false })
    clock.advance(600_001)
    expect(mod.agents()?.rows).toEqual([])
  })

  it('agent_stop calls TaskStop with the id; an ended or unknown task is agent_not_found', async () => {
    const { mod, engine } = make()
    engine.spawnAgent({ id: 'a1', description: 'x' })
    expect(await mod.execute({ control_id: ID(1), action: 'agent_stop', agent_id: 'a1' })).toMatchObject({ ok: true })
    expect(engine.taskStops).toEqual(['a1'])
    expect(mod.agents()?.rows[0]).toMatchObject({ status: 'killed', stoppable: false })
    expect(await mod.execute({ control_id: ID(2), action: 'agent_stop', agent_id: 'a1' })).toMatchObject({
      ok: false,
      code: 'agent_not_found',
    })
    expect(await mod.execute({ control_id: ID(3), action: 'agent_stop', agent_id: 'nope' })).toMatchObject({
      ok: false,
      code: 'agent_not_found',
    })
  })

  it('agent_stop without $.tool.call is capability_missing; without agent_id it is not a valid control', async () => {
    const { mod, engine } = make({ missingMethods: ['tool.call'] })
    engine.spawnAgent({ id: 'a1', description: 'x' })
    expect(mod.agents()?.rows[0]?.stoppable).toBe(false)
    expect(await mod.execute({ control_id: ID(4), action: 'agent_stop', agent_id: 'a1' })).toMatchObject({
      code: 'capability_missing',
    })
    expect(await make().mod.execute({ control_id: ID(5), action: 'agent_stop' })).toMatchObject({
      code: 'args_invalid',
    })
  })
})
