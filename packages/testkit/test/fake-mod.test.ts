// FakeMod + FakeEngine stand in for the Talos mod inside a Claude Code session (docs/CLAUDE-CODE.md C2.3, C4). The mod
// control contract runs here against the fake; WP-C2 runs the SAME contract against the real mod via `claude plugin
// test` with a driver that implements ModDriver.
import { ModSyncRequest, SessionInventory, SessionState } from '@talos-app/protocol'
import { describe, expect, it } from 'vitest'
import { defineModControlContract, FakeMod, fakeClock, type ModEngineOptions } from '../src/index.ts'

const make = (opts: ModEngineOptions) => {
  const clock = fakeClock('2026-10-29T12:00:00.000Z')
  const mod = new FakeMod({ clock, ...opts })
  return { mod, engine: mod.engine, clock }
}

defineModControlContract('FakeMod', make)

describe('FakeMod reports', () => {
  it('state and inventory parse as the strict outbound models; capabilities come from typeof checks', () => {
    const { mod } = make({ missingMethods: ['turn.abort'] })
    const s = mod.state()
    expect(SessionState.safeParse(s).success).toBe(true)
    expect(s.capabilities).not.toContain('stop')
    expect(s.capabilities).toContain('compact')
    expect(SessionInventory.safeParse(mod.inventory()).success).toBe(true)
  })
  it('below the floor version the mod reports no capabilities at all', () => {
    const { mod } = make({ version: '2.1.296' })
    expect(mod.state().capabilities).toEqual([])
  })
  it('a sync request carries state, inventory on the first sync, and drained events', () => {
    const { mod, engine } = make({})
    engine.startTurn('t1')
    const first = mod.syncRequest('k'.repeat(43))
    expect(ModSyncRequest.safeParse(first).success).toBe(true)
    expect(first.inventory).toBeDefined()
    expect(first.events?.map((e) => e.type)).toEqual(['turn_start'])
    const second = mod.syncRequest('k'.repeat(43))
    expect(second.inventory).toBeUndefined()
    expect(second.events ?? []).toEqual([])
  })
  it('the guard denies every model and subagent call to talos_mod_*, and a throwing guard still denies', async () => {
    const { mod } = make({})
    expect(await mod.guard({ toolName: 'mcp__talos-app__talos_mod_sync' })).toEqual({ decision: 'deny' })
    expect(await mod.guard({ toolName: 'mcp__x__talos_mod_hello', agentId: 'sub_1' })).toEqual({ decision: 'deny' })
    expect(await mod.guard({ toolName: 'mcp__talos-app__reply' })).toBeUndefined()
    expect(await mod.guard({ toolName: null as never })).toEqual({ decision: 'deny' })
  })
})
