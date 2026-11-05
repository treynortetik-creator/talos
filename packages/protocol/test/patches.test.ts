import { describe, expect, it } from 'vitest'
import defaultConfig from '../../../examples/config.default.json' with { type: 'json' }
import { AgentConfig, applyMergePatch, CONFIG_PATCH_ALLOWLIST, checkConfigPatch } from '../src/index.ts'

describe('applyMergePatch (RFC 7386 appendix A vectors)', () => {
  const vectors: Array<[unknown, unknown, unknown]> = [
    [{ a: 'b' }, { a: 'c' }, { a: 'c' }],
    [{ a: 'b' }, { b: 'c' }, { a: 'b', b: 'c' }],
    [{ a: 'b' }, { a: null }, {}],
    [{ a: 'b', b: 'c' }, { a: null }, { b: 'c' }],
    [{ a: ['b'] }, { a: 'c' }, { a: 'c' }],
    [{ a: 'c' }, { a: ['b'] }, { a: ['b'] }],
    [{ a: { b: 'c' } }, { a: { b: 'd', c: null } }, { a: { b: 'd' } }],
    [{ a: [{ b: 'c' }] }, { a: [1] }, { a: [1] }],
    [
      ['a', 'b'],
      ['c', 'd'],
      ['c', 'd'],
    ],
    [{ a: 'b' }, ['c'], ['c']],
    [{ a: 'foo' }, null, null],
    [{ a: 'foo' }, 'bar', 'bar'],
    [{ e: null }, { a: 1 }, { e: null, a: 1 }],
    [[1, 2], { a: 'b', c: null }, { a: 'b' }],
    [{}, { a: { bb: { ccc: null } } }, { a: { bb: {} } }],
  ]
  it.each(vectors)('MergePatch(%j, %j) = %j', (target, patch, expected) => {
    expect(applyMergePatch(target, patch)).toEqual(expected)
  })
  it('never mutates its inputs', () => {
    const t = { a: { b: 1 } }
    const p = { a: { b: null, c: 2 } }
    applyMergePatch(t, p)
    expect(t).toEqual({ a: { b: 1 } })
    expect(p).toEqual({ a: { b: null, c: 2 } })
  })
  it('a __proto__ key in a patch is dropped and pollutes nothing', () => {
    const out = applyMergePatch({}, JSON.parse('{"__proto__":{"polluted":true}}')) as Record<string, unknown>
    expect(({} as Record<string, unknown>).polluted).toBeUndefined()
    expect(Object.hasOwn(out, '__proto__')).toBe(false)
  })
})

describe('checkConfigPatch', () => {
  it('accepts every top-level entry of the allowlist', () => {
    for (const k of CONFIG_PATCH_ALLOWLIST.filter((e) => !e.includes('.'))) {
      expect(checkConfigPatch({ [k]: {} }), k).toMatchObject({ ok: true, touchesWorkEnabled: false })
    }
    expect(checkConfigPatch({ quiet_window: null, timezone: 'UTC', default_thread: 'general' })).toMatchObject({
      ok: true,
    })
  })
  it('accepts only the listed leaves under work', () => {
    expect(checkConfigPatch({ mirror: { telegram: 'on' } })).toEqual({ ok: false, path: 'mirror' })
    expect(checkConfigPatch({ work: { thread: 'work' } })).toEqual({ ok: true, touchesWorkEnabled: false })
    expect(checkConfigPatch({ work: { label: 'x' } })).toEqual({ ok: true, touchesWorkEnabled: false })
    expect(checkConfigPatch({ work: { ask_note: 'x' } })).toEqual({ ok: true, touchesWorkEnabled: false })
    // a key that is still Mac-only
    expect(checkConfigPatch({ work: { surprise: 1 } })).toEqual({ ok: false, path: 'work.surprise' })
  })
  it('work.retention is allowed but asks for the same step-up as turning a work system on', () => {
    expect(checkConfigPatch({ work: { retention: 'buffer' } })).toEqual({ ok: true, touchesWorkEnabled: true })
    expect(checkConfigPatch({ work: { label: 'x', retention: 'passthrough' } })).toEqual({
      ok: true,
      touchesWorkEnabled: true,
    })
  })
  it('reports work.enabled so the caller can demand step-up config:work', () => {
    expect(checkConfigPatch({ work: { enabled: ['slack'] } })).toEqual({ ok: true, touchesWorkEnabled: true })
    expect(checkConfigPatch({ work: { enabled: null, thread: 'x' } })).toMatchObject({
      ok: true,
      touchesWorkEnabled: true,
    })
  })
  it('forbids version, rev, unknown keys and deleting a leaf-only section', () => {
    for (const k of ['version', 'rev', 'nope']) expect(checkConfigPatch({ [k]: 1 })).toEqual({ ok: false, path: k })
    expect(checkConfigPatch({ work: null })).toEqual({ ok: false, path: 'work' })
  })
  it('reports the first forbidden path in a mixed patch and rejects non-objects', () => {
    expect(checkConfigPatch({ agent: {}, rev: 3, work: { label: 'x' } })).toEqual({ ok: false, path: 'rev' })
    for (const bad of [null, [], 'x', 3]) expect(checkConfigPatch(bad)).toEqual({ ok: false, path: '' })
  })
})

describe('applyMergePatch drops prototype-pollution keys', () => {
  it('never copies __proto__, constructor or prototype into the output', () => {
    const patch = JSON.parse('{"__proto__":{"polluted":true},"constructor":{"x":1},"prototype":2,"ok":1}')
    const out = applyMergePatch({ keep: true }, patch) as Record<string, unknown>
    expect(Object.keys(out).sort()).toEqual(['keep', 'ok'])
    expect(Object.hasOwn(out, '__proto__')).toBe(false)
    expect(({} as Record<string, unknown>).polluted).toBeUndefined()
  })
})

describe('turning the quiet window off (audit D33)', () => {
  it('a null merge patch over a config with a window still parses, and reads as off', () => {
    const on = AgentConfig.parse({ ...defaultConfig, quiet_window: { start: '22:00', end: '07:00' } })
    const merged = applyMergePatch(on, { quiet_window: null })
    expect(Object.hasOwn(merged as object, 'quiet_window')).toBe(false) // RFC 7386: null deletes the key
    const r = AgentConfig.safeParse(merged)
    expect(r.success).toBe(true)
    expect(r.success && r.data.quiet_window).toBeNull()
  })
})

describe('R2-2: work.enabled is read leniently and written strictly', () => {
  const cfg = (enabled: unknown) => ({ ...defaultConfig, work: { ...defaultConfig.work, enabled } })
  it('reading drops an id this build does not know, and keeps the rest (a newer peer does not kill the frame)', () => {
    const r = AgentConfig.safeParse(cfg(['gmail_work', 'some-future-switch', 'heartbeat']))
    expect(r.success).toBe(true)
    if (r.success) expect(r.data.work.enabled).toEqual(['gmail_work', 'heartbeat'])
  })
  it('a list that is not a list is still refused on read', () => {
    expect(AgentConfig.safeParse(cfg('heartbeat')).success).toBe(false)
  })
  it('writing: a patch with an unknown id in work.enabled is refused', () => {
    expect(checkConfigPatch({ work: { enabled: ['heartbeat'] } }).ok).toBe(true)
    expect(checkConfigPatch({ work: { enabled: ['some-future-switch'] } })).toEqual({ ok: false, path: 'work.enabled' })
    expect(checkConfigPatch({ work: { enabled: 'heartbeat' } })).toEqual({ ok: false, path: 'work.enabled' })
  })
})
