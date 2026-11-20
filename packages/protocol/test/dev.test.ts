// The Developer page's table (dev.ts) and the per-thread idle_park_min the agent may now change (Pantheon 2026-11-15).
import { describe, expect, it } from 'vitest'
import defaultConfig from '../../../examples/config.default.json' with { type: 'json' }
import { AgentConfig, agentConfigPatch, DEV_ROWS, devPath, resolveConfigChanges, SETTINGS_TABLE } from '../src/index.ts'

const config = AgentConfig.parse(defaultConfig)

describe('the Developer rows', () => {
  it('every row is a setting with a row of its own in the settings table, the same default, and the schema gives that default', () => {
    for (const r of DEV_ROWS) {
      const row = (SETTINGS_TABLE as Record<string, { default: unknown; agent: boolean }>)[devPath(r.key)]
      expect(row, r.key).toBeDefined()
      expect(row?.default).toBe(r.default)
      // a file with no `dev` at all (every install before this) reads the default: the guard on
      const { dev: _dev, ...noDev } = defaultConfig as Record<string, unknown>
      expect(AgentConfig.parse(noDev).dev[r.key]).toBe(r.default)
    }
  })
  it('every row says its value in Developer mode: the fence open (off), the notes lookup left on', () => {
    for (const r of DEV_ROWS) expect(typeof r.open, r.key).toBe('boolean')
    expect(Object.fromEntries(DEV_ROWS.map((r) => [r.key, r.open]))).toEqual({ thread_fence: false, note_lookup: true })
  })
  it('a garbled dev section reads as the guard on, never off', () => {
    for (const dev of [null, 'off', { thread_fence: 'false' }, { thread_fence: 0 }, []])
      expect(AgentConfig.parse({ ...defaultConfig, dev }).dev.thread_fence).toBe(true)
    expect(AgentConfig.parse({ ...defaultConfig, dev: { thread_fence: false } }).dev.thread_fence).toBe(false)
  })
  it('turning the fence off is a change the agent may propose (the service decides: asked and unlocked, or a card)', () => {
    expect(resolveConfigChanges([{ path: 'dev.thread_fence', value: false }], config)).toEqual({
      ok: true,
      changes: [{ path: 'dev.thread_fence', old: true, new: false }],
    })
    expect(agentConfigPatch([{ path: 'dev.thread_fence', new: false }], config)).toEqual({
      dev: { thread_fence: false },
    })
    // a thread session may only change its own thread: never the fence
    const r = resolveConfigChanges([{ path: 'dev.thread_fence', value: false }], config, { thread: 'general' })
    expect(r.ok).toBe(false)
  })
})

describe('the notes lookup row (dev.note_lookup)', () => {
  it('on by default, a garbled value reads on, and a garbled neighbour does not turn it off', () => {
    expect(config.dev.note_lookup).toBe(true)
    for (const dev of [null, 'off', { note_lookup: 'false' }, { note_lookup: 0 }, []])
      expect(AgentConfig.parse({ ...defaultConfig, dev }).dev.note_lookup).toBe(true)
    expect(AgentConfig.parse({ ...defaultConfig, dev: { note_lookup: false } }).dev.note_lookup).toBe(false)
    expect(AgentConfig.parse({ ...defaultConfig, dev: { thread_fence: 1, note_lookup: false } }).dev).toEqual({
      thread_fence: true,
      note_lookup: false,
    })
  })
  it('the agent may propose turning it off; it opens nothing, so it is the low-risk kind and a thread session may not name it', () => {
    expect(resolveConfigChanges([{ path: 'dev.note_lookup', value: false }], config)).toEqual({
      ok: true,
      changes: [{ path: 'dev.note_lookup', old: true, new: false }],
    })
    expect(agentConfigPatch([{ path: 'dev.note_lookup', new: false }], config)).toEqual({
      dev: { note_lookup: false },
    })
    expect((SETTINGS_TABLE as Record<string, { risk: string }>)['dev.note_lookup']?.risk).toBe('low')
    expect(resolveConfigChanges([{ path: 'dev.note_lookup', value: false }], config, { thread: 'general' }).ok).toBe(
      false,
    )
  })
})

describe('threads.<id>.idle_park_min', () => {
  const withTrip = AgentConfig.parse({
    ...defaultConfig,
    threads: [
      ...defaultConfig.threads,
      {
        id: 'trip',
        name: 'Trip',
        kind: 'agent',
        order: 5,
        notify: 'all',
        archived: false,
        created_at: '2026-10-28T00:00:00.000Z',
        session: 'dedicated',
        session_opts: { cwd: '/home/alex/trip', model: 'sonnet', idle_park_min: 30, mcp_allow: ['github'] },
      },
    ],
  })
  it('reads the old value, takes 5-720, and writes only that key: the folder, model and MCP list stay', () => {
    const r = resolveConfigChanges([{ path: 'threads.trip.idle_park_min', value: 90 }], withTrip)
    expect(r).toEqual({ ok: true, changes: [{ path: 'threads.trip.idle_park_min', old: 30, new: 90 }] })
    const patch = agentConfigPatch([{ path: 'threads.trip.idle_park_min', new: 90 }], withTrip)
    const trip = (patch.threads as Array<{ id: string; session_opts?: Record<string, unknown> }>).find(
      (t) => t.id === 'trip',
    )
    expect(trip?.session_opts).toEqual({
      cwd: '/home/alex/trip',
      model: 'sonnet',
      idle_park_min: 90,
      mcp_allow: ['github'],
    })
    for (const bad of [4, 721, 30.5, '60'])
      expect(resolveConfigChanges([{ path: 'threads.trip.idle_park_min', value: bad }], withTrip).ok, String(bad)).toBe(
        false,
      )
  })
  it("a thread session may set its own thread's, and no other's", () => {
    expect(
      resolveConfigChanges([{ path: 'threads.trip.idle_park_min', value: 60 }], withTrip, { thread: 'trip' }).ok,
    ).toBe(true)
    expect(
      resolveConfigChanges([{ path: 'threads.trip.idle_park_min', value: 60 }], withTrip, { thread: 'general' }).ok,
    ).toBe(false)
  })
})
