// The per-thread "compact at" setting: session_opts.compact_window, null (unset) or 100000 to 1000000 tokens. Read: a bad value is
// unset and costs no other field. Written: a bad value is refused. An agent may propose it for its own thread (low risk).
import { describe, expect, it } from 'vitest'
import defaultConfig from '../../../examples/config.default.json' with { type: 'json' }
import {
  AgentConfig,
  agentConfigPatch,
  COMPACT_WINDOW_MAX,
  COMPACT_WINDOW_MIN,
  resolveConfigChanges,
  riskOfPath,
  sessionFieldsIssue,
  THREAD_FIELD_RULES,
  ThreadSessionOpts,
  ThreadSessionOptsStrict,
} from '../src/index.ts'

const withTrip = (session_opts: Record<string, unknown>) =>
  AgentConfig.parse({
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
        session_opts,
      },
    ],
  })
const path = 'threads.trip.compact_window'

describe('compact_window as written (config file, Strict)', () => {
  it('takes null, absent and an integer from 100000 to 1000000', () => {
    expect(COMPACT_WINDOW_MIN).toBe(100000)
    expect(COMPACT_WINDOW_MAX).toBe(1000000)
    for (const ok of [null, undefined, 100000, 400000, 1000000])
      expect(ThreadSessionOptsStrict.safeParse({ compact_window: ok }).success, String(ok)).toBe(true)
  })
  it('refuses too small, too big, fractional, text and NaN', () => {
    for (const bad of [0, 99999, 1000001, 400000.5, '400000', '400k', 'auto', Number.NaN, true, []])
      expect(ThreadSessionOptsStrict.safeParse({ compact_window: bad }).success, String(bad)).toBe(false)
  })
  it('the config check says so, naming the thread fields', () => {
    const t = { id: 'a', kind: 'agent', session_opts: { compact_window: 5 } }
    expect(sessionFieldsIssue({ threads: [t] })).toMatch(/not valid/)
    expect(sessionFieldsIssue({ threads: [{ ...t, session_opts: { compact_window: 400000 } }] })).toBeNull()
  })
})

describe('compact_window as read', () => {
  it('a good value stands; absent and null are unset', () => {
    expect(ThreadSessionOpts.parse({ compact_window: 400000 }).compact_window).toBe(400000)
    expect(ThreadSessionOpts.parse({}).compact_window).toBeUndefined()
    expect(ThreadSessionOpts.parse({ compact_window: null }).compact_window).toBeUndefined()
  })
  it('a bad value reads as unset and costs no other field', () => {
    for (const bad of [5, 99999, 1000001, 400000.5, '400000', 'auto', {}]) {
      const o = ThreadSessionOpts.parse({
        cwd: '/home/alex/trip',
        model: 'sonnet',
        idle_park_min: 90,
        compact_window: bad,
      })
      expect(o.compact_window, String(bad)).toBeUndefined()
      expect(o).toMatchObject({ cwd: '/home/alex/trip', model: 'sonnet', idle_park_min: 90 })
    }
  })
  it('a whole config with a bad value still parses, the thread keeping its other settings', () => {
    const c = withTrip({ cwd: '/home/alex/trip', compact_window: 'soon' })
    const t = c.threads.find((x) => x.id === 'trip')
    expect(t?.session_opts?.cwd).toBe('/home/alex/trip')
    expect(t?.session_opts?.compact_window).toBeUndefined()
  })
})

describe('threads.<id>.compact_window through config_propose', () => {
  const c = withTrip({ cwd: '/home/alex/trip', model: 'sonnet', compact_window: 300000, mcp_allow: ['github'] })
  it('is a low-risk thread field', () => {
    expect(THREAD_FIELD_RULES.compact_window.risk).toBe('low')
    expect(riskOfPath(path)).toBe('low')
  })
  it('reads the old value, takes the range and null, and writes only that key', () => {
    expect(resolveConfigChanges([{ path, value: 400000 }], c)).toEqual({
      ok: true,
      changes: [{ path, old: 300000, new: 400000 }],
    })
    expect(resolveConfigChanges([{ path, value: null }], c).ok).toBe(true)
    const patch = agentConfigPatch([{ path, new: 400000 }], c)
    const trip = (patch.threads as Array<{ id: string; session_opts?: Record<string, unknown> }>).find(
      (t) => t.id === 'trip',
    )
    expect(trip?.session_opts).toMatchObject({
      cwd: '/home/alex/trip',
      model: 'sonnet',
      compact_window: 400000,
      mcp_allow: ['github'],
    })
  })
  it('clearing it drops the key, the rest stays', () => {
    const patch = agentConfigPatch([{ path, new: null }], c)
    const trip = (patch.threads as Array<{ id: string; session_opts?: Record<string, unknown> }>).find(
      (t) => t.id === 'trip',
    )
    // a merge patch's null drops the key where it is applied
    expect(trip?.session_opts?.compact_window ?? null).toBeNull()
    expect(trip?.session_opts).toMatchObject({ cwd: '/home/alex/trip', model: 'sonnet' })
  })
  it('a field never set reads as null', () => {
    expect(resolveConfigChanges([{ path, value: 200000 }], withTrip({})).ok).toBe(true)
    const r = resolveConfigChanges([{ path, value: 200000 }], withTrip({}))
    expect(r.ok && r.changes[0]?.old).toBeNull()
  })
  it('refuses too small, too big, fractional and text', () => {
    for (const bad of [0, 99999, 1000001, 400000.5, '400000', '400k', 'auto'])
      expect(resolveConfigChanges([{ path, value: bad }], c).ok, String(bad)).toBe(false)
  })
  it("a thread session may set its own thread's, and no other's", () => {
    expect(resolveConfigChanges([{ path, value: 400000 }], c, { thread: 'trip' }).ok).toBe(true)
    expect(resolveConfigChanges([{ path, value: 400000 }], c, { thread: 'general' }).ok).toBe(false)
  })
})
