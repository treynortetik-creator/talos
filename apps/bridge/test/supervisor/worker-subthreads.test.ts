// Sub-threads, the pure half (P3d5, part A): the effective options a sub-thread starts with and what its launch needs, case for
// case with the Mac's SubThreadsTests.swift (SubThreadEffectiveTests), on config.json threads as raw JSON.
import { describe, expect, it } from 'bun:test'
import { effectiveOpts, subLaunch } from '../../src/supervisor/worker-subthreads.ts'

type Raw = Record<string, unknown>
const thread = (id: string, o: { parent?: unknown; archived?: boolean; opts?: unknown } = {}): Raw => ({
  id,
  name: id,
  kind: 'fixed',
  session: 'dedicated',
  ...(o.parent !== undefined ? { parent_id: o.parent } : {}),
  ...(o.archived ? { archived: true } : {}),
  ...(o.opts !== undefined ? { session_opts: o.opts } : {}),
})
const eff = (id: string, all: Raw[]) => effectiveOpts(all.find((t) => t.id === id) as Raw, all)
const launch = (t: Raw, all: Raw[]) => {
  const l = subLaunch(t, all)
  if (!l) throw new Error('not a sub-thread')
  return l
}

describe('sub-threads: effective options', () => {
  it('a thread with no parent is its own options', () => {
    const all = [thread('a', { opts: { cwd: '/home/alex/a', model: 'sonnet', effort: 'high', mcp_allow: ['x'] } })]
    expect(eff('a', all)).toMatchObject({
      cwd: '/home/alex/a',
      model: 'sonnet',
      effort: 'high',
      mcpAllow: ['x'],
      inherited: [],
    })
    expect(subLaunch(all[0] as Raw, all)).toBeNull()
  })
  it('a sub inherits what it does not set from its live parent', () => {
    const all = [
      thread('p', { opts: { cwd: '/home/alex/p', model: 'opus', effort: 'low', mcp_allow: ['a', 'b'] } }),
      thread('s', { parent: 'p' }),
    ]
    expect(eff('s', all)).toMatchObject({
      cwd: '/home/alex/p',
      model: 'opus',
      effort: 'low',
      mcpAllow: ['a', 'b'],
      inherited: ['cwd', 'model', 'effort', 'mcp_allow'],
    })
  })
  it('what the sub sets it keeps, and only the rest is inherited', () => {
    const all = [
      thread('p', { opts: { cwd: '/home/alex/p', model: 'opus', effort: 'low' } }),
      thread('s', { parent: 'p', opts: { model: 'haiku', effort: 'high' } }),
    ]
    expect(eff('s', all)).toMatchObject({ model: 'haiku', effort: 'high', cwd: '/home/alex/p', inherited: ['cwd'] })
  })
  it('a parent with nothing set gives nothing to inherit', () => {
    const o = eff('s', [thread('p'), thread('s', { parent: 'p' })])
    expect(o).toEqual({ inherited: [], dropped: [], unreadable: {} })
  })
  it('a parent that has a parent is not followed', () => {
    const all = [
      thread('g', { opts: { model: 'opus', cwd: '/home/alex/g', mcp_allow: ['a', 'b', 'c'] } }),
      thread('p', { parent: 'g', opts: { effort: 'low' } }),
      thread('s', { parent: 'p' }),
      thread('t', { parent: 'p', opts: { mcp_allow: ['a'] } }),
    ]
    const o = eff('s', all)
    expect([o.model, o.cwd, o.effort, o.inherited]).toEqual([undefined, undefined, undefined, []])
    expect(o.mcpAllow).toEqual([]) // like an orphan: no list of its own is the empty list
    expect(eff('t', all).mcpAllow).toEqual(['a']) // like an orphan: its own list is its own
    const l = launch(all[2] as Raw, all)
    expect(l.refusal).not.toBeNull()
    expect(l.parentCwd).toBeNull()
  })
  it('the MCP list is the sub’s own limited to the parent’s, and says what was dropped', () => {
    const all = [
      thread('p', { opts: { mcp_allow: ['a', 'b'] } }),
      thread('s', { parent: 'p', opts: { mcp_allow: ['z', 'b', 'y', 'a'] } }),
    ]
    const o = eff('s', all)
    expect(o.mcpAllow).toEqual(['b', 'a']) // the sub's own order
    expect(o.dropped).toEqual(['z', 'y'])
    expect(o.inherited).not.toContain('mcp_allow')
  })
  it('a parent with no list is no limit, and an empty list is all limit', () => {
    const open = [thread('p'), thread('s', { parent: 'p', opts: { mcp_allow: ['a'] } })]
    expect(eff('s', open)).toMatchObject({ mcpAllow: ['a'], dropped: [] })
    const shut = [thread('p', { opts: { mcp_allow: [] } }), thread('s', { parent: 'p', opts: { mcp_allow: ['a'] } })]
    expect(eff('s', shut)).toMatchObject({ mcpAllow: [], dropped: ['a'] })
    const shutInherit = [thread('p', { opts: { mcp_allow: [] } }), thread('s', { parent: 'p' })]
    expect(eff('s', shutInherit).mcpAllow).toEqual([]) // inherited as an empty list, not as no list
  })
  it('a parent list that cannot be read leaves the sub nothing', () => {
    for (const bad of ['github', [1, 2], ['a', 'a'], null]) {
      const all = [
        thread('p', { opts: { mcp_allow: bad } }),
        thread('s', { parent: 'p', opts: { mcp_allow: ['a'] } }),
        thread('t', { parent: 'p' }),
      ]
      expect([bad, eff('s', all).mcpAllow]).toEqual([bad, []])
      expect([bad, eff('t', all).mcpAllow]).toEqual([bad, []])
    }
    const notAnObject = [thread('p', { opts: 'oops' }), thread('s', { parent: 'p', opts: { mcp_allow: ['a'] } })]
    expect(eff('s', notAnObject).mcpAllow).toEqual([])
    // the sub's own settings that cannot be read are the empty list too, not its parent's list
    const ownBroken = [thread('p', { opts: { mcp_allow: ['a', 'b'] } }), thread('s', { parent: 'p', opts: 'oops' })]
    expect(eff('s', ownBroken).mcpAllow).toEqual([])
  })
  it('a list with one name spelled two canonically equal ways is a list that cannot be read (Swift’s Set): nothing', () => {
    const nfc = 'caf\u00e9'
    const nfd = 'cafe\u0301'
    for (const bad of [
      ['github', 'x;', 'x\u037e'],
      [nfc, nfd],
    ]) {
      const all = [
        thread('p', { opts: { cwd: '/a', mcp_allow: bad } }),
        thread('c', { parent: 'p', opts: { cwd: '/a/c' } }),
      ]
      expect(eff('c', all).mcpAllow).toEqual([])
      expect(eff('p', all).mcpAllow).toEqual([])
    }
  })
  it('an orphan with no list of its own gets the empty list', () => {
    const archived = [
      thread('p', { archived: true, opts: { mcp_allow: ['a'], model: 'opus' } }),
      thread('s', { parent: 'p' }),
    ]
    const o = eff('s', archived)
    expect(o.mcpAllow).toEqual([]) // not the archived parent's list and not no list
    expect([o.model, o.inherited]).toEqual([undefined, []])
    expect(eff('s', [thread('s', { parent: 'nope' })]).mcpAllow).toEqual([])
    expect(eff('s', [thread('s', { parent: 'nope', opts: { mcp_allow: ['a'] } })]).mcpAllow).toEqual(['a'])
  })
  it('a parent link that cannot be read fails closed', () => {
    for (const bad of [7, ['p'], 'BAD ID', '', 'all']) {
      const all = [
        thread('p', { opts: { mcp_allow: ['a'] } }),
        thread('s', { parent: bad, opts: { mcp_allow: ['a'] } }),
        thread('t', { parent: bad }),
      ]
      expect([bad, eff('s', all).mcpAllow]).toEqual([bad, []])
      expect([bad, eff('t', all).mcpAllow]).toEqual([bad, []])
      expect(subLaunch(all[1] as Raw, all)).not.toBeNull() // still a sub-thread
    }
  })
  it('a parent is the first thread with that id, and anything but false or absent archives it', () => {
    const dup = [
      thread('p', { archived: true, opts: { model: 'opus', mcp_allow: ['a'] } }),
      thread('p', { opts: { model: 'haiku', mcp_allow: ['a', 'b'] } }),
      thread('s', { parent: 'p' }),
    ]
    expect(eff('s', dup)).toMatchObject({ mcpAllow: [] }) // an orphan, not the second copy
    expect(eff('s', dup).model).toBeUndefined()
    for (const archived of ['yes', 1, ['x'], true]) {
      const p = { ...thread('p', { opts: { model: 'opus', mcp_allow: ['a'] } }), archived }
      const o = eff('s', [p, thread('s', { parent: 'p' })])
      expect([archived, o.model, o.mcpAllow]).toEqual([archived, undefined, []])
    }
    for (const live of [false, 0, null]) {
      const p = { ...thread('p', { opts: { model: 'opus' } }), archived: live }
      expect([live, eff('s', [p, thread('s', { parent: 'p' })]).model]).toEqual([live, 'opus'])
    }
  })
  it('a loop is a parent that has a parent', () => {
    const loop = [thread('a', { parent: 'b', opts: { mcp_allow: ['x'] } }), thread('b', { parent: 'a' })]
    expect(eff('a', loop).mcpAllow).toEqual(['x'])
    expect(eff('b', loop).mcpAllow).toEqual([])
    expect(eff('a', [thread('a', { parent: 'a' })]).mcpAllow).toEqual([])
    // its own parent: not even its own list stands
    const selfWithList = [thread('a', { parent: 'a', opts: { mcp_allow: ['x', 'y'], model: 'opus' } })]
    expect(eff('a', selfWithList)).toMatchObject({ mcpAllow: [], dropped: ['x', 'y'], model: 'opus' })
  })
  it('the launch says whether the folder is the sub’s own and what it must be inside', () => {
    const all = [
      thread('p', { opts: { cwd: '/home/alex/p' } }),
      thread('own', { parent: 'p', opts: { cwd: '/home/alex/p/own' } }),
      thread('inh', { parent: 'p' }),
      thread('orphan', { parent: 'x', opts: { cwd: '/home/alex/x' } }),
      thread('orphaninh', { parent: 'x' }),
    ]
    expect(launch(all[1] as Raw, all)).toMatchObject({
      ownCwd: true,
      parentCwd: '/home/alex/p',
      refusal: null,
      parentId: 'p',
    })
    const inh = launch(all[2] as Raw, all)
    expect(inh).toMatchObject({ ownCwd: false, inherited: ['cwd'] }) // the options still inherit the folder
    expect(inh.refusal).toContain('folder of its own') // but a session never shares the parent's folder
    expect(launch(all[3] as Raw, all).refusal).not.toBeNull()
    expect(launch(all[4] as Raw, all).refusal).not.toBeNull()
  })
  it('a folder setting that is not text is refused, naming it, and never takes the parent’s folder', () => {
    const cases: Array<[unknown, string]> = [
      [7, '7'],
      [true, '1'],
      [['a'], 'a'],
      [{ x: 1 }, 'x'],
    ]
    for (const [bad, said] of cases) {
      const all = [thread('p', { opts: { cwd: '/home/alex/p' } }), thread('s', { parent: 'p', opts: { cwd: bad } })]
      const o = eff('s', all)
      expect([bad, o.cwd, o.inherited.includes('cwd')]).toEqual([bad, undefined, false])
      const l = launch(all[1] as Raw, all)
      expect(l.refusal).toContain(said)
      expect(l.refusal).toContain("can't be read")
    }
    // null is not set: no folder of its own
    const unset = [thread('p', { opts: { cwd: '/home/alex/p' } }), thread('s', { parent: 'p', opts: { cwd: null } })]
    expect(launch(unset[1] as Raw, unset).refusal).toContain('folder of its own')
    const notObject = [thread('p', { opts: { cwd: '/home/alex/p' } }), thread('s', { parent: 'p', opts: 'oops' })]
    expect(eff('s', notObject).cwd).toBeUndefined()
    expect(launch(notObject[1] as Raw, notObject).refusal).toContain('oops')
  })
  it('a model or effort setting that is not valid takes the parent’s and is said', () => {
    const bad: Array<[string, unknown, string]> = [
      ['model', 7, '7'],
      ['model', ['x'], 'x'],
      ['model', '-no', '-no'],
      ['model', 'has space', 'has space'],
      ['model', '', ''],
      ['effort', 7, '7'],
      ['effort', 'High', 'High'],
      ['effort', '', ''],
      ['effort', 'abcdefghijklmnopq', 'abcdefghijklmnopq'],
    ]
    for (const [key, value, said] of bad) {
      const all = [
        thread('p', { opts: { cwd: '/home/alex/p', model: 'opus', effort: 'low' } }),
        thread('s', { parent: 'p', opts: { cwd: '/home/alex/p/s', [key]: value } }),
      ]
      expect([key, value, eff('s', all).model, eff('s', all).effort]).toEqual([key, value, 'opus', 'low'])
      const l = launch(all[1] as Raw, all)
      expect(l.refusal).toBeNull()
      expect(l.unreadable).toEqual({ [key]: said })
    }
    const fine = [
      thread('p', { opts: { cwd: '/home/alex/p' } }),
      thread('s', { parent: 'p', opts: { cwd: '/home/alex/p/s', model: 'claude-opus-4.1[1m]', effort: 'high' } }),
    ]
    expect(launch(fine[1] as Raw, fine).unreadable).toEqual({})
    expect(eff('s', fine)).toMatchObject({ model: 'claude-opus-4.1[1m]', effort: 'high' })
  })
  it('a model of inherit means not set, and takes the parent’s', () => {
    const all = [
      thread('p', { opts: { cwd: '/home/alex/p', model: 'opus' } }),
      thread('s', { parent: 'p', opts: { cwd: '/home/alex/p/s', model: 'inherit' } }),
    ]
    expect(eff('s', all).model).toBe('opus')
    expect(eff('s', all).inherited).toContain('model')
    expect(launch(all[1] as Raw, all).unreadable).toEqual({}) // inherit is not junk
    expect(eff('a', [thread('a', { opts: { model: 'inherit' } })]).model).toBeUndefined()
  })
  it('a sub with its own folder under a parent that is itself a sub is refused', () => {
    const all = [
      thread('g', { opts: { cwd: '/home/alex/g' } }),
      thread('p', { parent: 'g', opts: { cwd: '/home/alex/g/p' } }),
      thread('s', { parent: 'p', opts: { cwd: '/home/alex/g/p/s' } }),
    ]
    const l = launch(all[2] as Raw, all)
    expect(l.refusal).toContain('itself a sub-thread')
    expect(l.parentCwd).toBeNull()
    expect(launch(all[1] as Raw, all).refusal).toBeNull() // a sub of a top-level thread is fine
  })
  it('a parent with no folder of its own means its subs are refused', () => {
    const all = [thread('p'), thread('s', { parent: 'p', opts: { cwd: '/home/alex/p/s' } })]
    expect(launch(all[1] as Raw, all).refusal).toContain('give the parent a folder first')
    const junkParent = [
      thread('p', { opts: { cwd: 7 } }),
      thread('s', { parent: 'p', opts: { cwd: '/home/alex/p/s' } }),
    ]
    expect(launch(junkParent[1] as Raw, junkParent).refusal).toContain('give the parent a folder first')
  })
})
