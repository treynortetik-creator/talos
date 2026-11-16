// config_propose `threads.<id>.parent`: always high (a card), never from the thread's own session, and the parent itself is
// judged even when the thread being moved is archived (the whole-change sub-thread rule skips archived threads).
import { describe, expect, it } from 'vitest'
import defaultConfig from '../../../examples/config.default.json' with { type: 'json' }
import { AgentConfig, type AgentConfigT, resolveConfigChanges, riskOfChange } from '../src/index.ts'

const T = (id: string, over: Record<string, unknown> = {}) => ({
  id,
  name: id,
  kind: 'agent',
  order: 5,
  notify: 'all',
  voice_context: 'recent',
  archived: false,
  created_at: '2026-10-28T00:00:00.000Z',
  ...over,
})
const cfg: AgentConfigT = AgentConfig.parse({
  ...defaultConfig,
  threads: [
    ...defaultConfig.threads,
    T('work'),
    T('daily'),
    T('trip'),
    T('visas', { parent_id: 'trip' }),
    T('old', { archived: true }),
    T('gone', { archived: true }),
  ],
})
const resolve = (path: string, value: unknown, opts: { thread?: string } = {}) =>
  resolveConfigChanges([{ path, value }], cfg, opts)

describe('threads.<id>.parent', () => {
  it('reads the current parent as old, null for a top-level thread, and is high either way', () => {
    const r = resolve('threads.daily.parent', 'work')
    expect(r).toEqual({ ok: true, changes: [{ path: 'threads.daily.parent', old: null, new: 'work' }] })
    expect(riskOfChange({ path: 'threads.daily.parent', new: 'work' }, cfg)).toBe('high')
    expect(riskOfChange({ path: 'threads.visas.parent', new: null }, cfg)).toBe('high')
    expect(resolve('threads.visas.parent', null)).toMatchObject({ ok: true, changes: [{ old: 'trip', new: null }] })
  })

  it('refuses a thread under itself, and nothing for a thread already at the top level', () => {
    expect(resolve('threads.daily.parent', 'daily')).toMatchObject({
      ok: false,
      error: expect.stringContaining('own parent'),
    })
    expect(resolve('threads.daily.parent', null).ok).toBe(false) // already that value
  })

  it.each([
    ['a missing thread', 'nowhere', 'there is no thread "nowhere"'],
    ['an archived thread', 'gone', 'is archived'],
    ['the inbox', 'inbox', "the inbox can't have sub-threads"],
    ['a sub-thread', 'visas', 'is a sub-thread itself'],
  ])('refuses a parent that is %s, even for an archived thread being moved', (_what, parent, words) => {
    for (const child of ['daily', 'old'])
      expect(resolve(`threads.${child}.parent`, parent)).toMatchObject({
        ok: false,
        error: expect.stringContaining(words),
      })
  })

  it("is never open to a thread's own session, not even for its own thread", () => {
    const r = resolve('threads.visas.parent', null, { thread: 'visas' })
    expect(r).toMatchObject({ ok: false, error: expect.stringContaining("can't move its thread") })
    // its other fields still are
    expect(resolve('threads.visas.topic', 'Visa papers', { thread: 'visas' }).ok).toBe(true)
  })

  it('takes a thread id or null, nothing else', () => {
    for (const bad of ['Not An Id', 3, true, ''])
      expect(resolve('threads.daily.parent', bad).ok, String(bad)).toBe(false)
  })
})
