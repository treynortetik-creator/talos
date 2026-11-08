// The MCP allow list of a thread's own session (`session_opts.mcp_allow`) and what the running worker was launched with
// (`WorkerEntry.launched`). No list is today's behaviour; a list, even an empty one, means only those servers; a list this
// build cannot read is the empty list, never "no list".
import { describe, expect, it } from 'vitest'
import {
  MCP_ALLOW_MAX,
  MCP_NAME_MAX,
  McpAllowList,
  parseWorkersFile,
  resolveThreadsPatch,
  sessionFieldsIssue,
  Thread,
  ThreadSessionOpts,
  ThreadSessionOptsStrict,
} from '../src/index.ts'

const base = {
  id: 'trip',
  name: 'Trip planning',
  kind: 'fixed',
  order: 2,
  notify: 'all',
  voice_context: 'recent',
  archived: false,
  created_at: '2026-10-28T00:00:00.000Z',
}
const issue = (session_opts: unknown) => sessionFieldsIssue({ threads: [{ ...base, session_opts }] })

describe('session_opts.mcp_allow, as written (strict)', () => {
  it('no list, an empty list and names (including claude.ai connectors and plugin servers) are accepted', () => {
    for (const mcp_allow of [undefined, [], ['github'], ['claude.ai Gmail', 'plugin:zoom:zoom-mcp', 'my_server-2']])
      expect(issue({ mcp_allow }), JSON.stringify(mcp_allow)).toBeNull()
  })
  it('refuses what is not a list of good names', () => {
    for (const mcp_allow of [
      'github',
      [1],
      [''],
      [' github'],
      ['github '],
      ['a,b'],
      ['bad\nname'],
      ['x'.repeat(MCP_NAME_MAX + 1)],
      ['github', 'github'],
      Array.from({ length: MCP_ALLOW_MAX + 1 }, (_, i) => `s${i}`),
    ])
      expect(issue({ mcp_allow }), JSON.stringify(mcp_allow).slice(0, 60)).toMatch(/not valid/)
  })
  it('takes exactly the cap and the longest name', () => {
    expect(McpAllowList.safeParse(Array.from({ length: MCP_ALLOW_MAX }, (_, i) => `s${i}`)).success).toBe(true)
    expect(McpAllowList.safeParse(['x'.repeat(MCP_NAME_MAX)]).success).toBe(true)
  })
  it('the strict shape keeps the list as written', () => {
    expect(ThreadSessionOptsStrict.parse({ mcp_allow: ['github'] }).mcp_allow).toEqual(['github'])
    expect(ThreadSessionOptsStrict.parse({}).mcp_allow).toBeUndefined()
  })
})

describe('session_opts.mcp_allow, as read (tolerant)', () => {
  it('no list stays no list, and a good list stays', () => {
    expect(ThreadSessionOpts.parse({}).mcp_allow).toBeUndefined()
    expect(ThreadSessionOpts.parse({ mcp_allow: [] }).mcp_allow).toEqual([])
    expect(
      Thread.parse({ ...base, session: 'dedicated', session_opts: { mcp_allow: ['github'] } }).session_opts,
    ).toEqual({ model: 'inherit', idle_park_min: 30, mcp_allow: ['github'] })
  })
  it('a list this build cannot read is the empty list (talos-app only), not "no list", and costs no other field', () => {
    for (const mcp_allow of ['github', [1], ['a,b'], ['x', 'x'], Array.from({ length: 99 }, (_, i) => `s${i}`)]) {
      const o = ThreadSessionOpts.parse({ cwd: '/Users/example/p', model: 'sonnet', mcp_allow })
      expect(o.mcp_allow).toEqual([])
      expect(o.cwd).toBe('/Users/example/p')
      expect(o.model).toBe('sonnet')
    }
  })
})

describe('names the list refuses', () => {
  it('bidi overrides, line and paragraph separators, zero-width marks and C0/C1 controls', () => {
    for (const bad of [
      'a\u202Eb',
      'a\u2066b',
      'a\u200Fb',
      'a\u2028b',
      'a\u2029b',
      'a\u0085b',
      'a\u009Fb',
      'a\u0007b',
      'a\u200Bb',
      'a\uFEFFb',
    ])
      expect(McpAllowList.safeParse([bad]).success, JSON.stringify(bad)).toBe(false)
    expect(McpAllowList.safeParse(['claude.ai Gmail', 'plugin:a:b', 'caf\u00e9']).success).toBe(true)
  })
})

describe('Thread.session_opts that is present but not an object', () => {
  const read = (session_opts: unknown) => Thread.parse({ ...base, session: 'dedicated', session_opts }).session_opts
  it('reads as the empty allow list (talos-app only), never as no list', () => {
    for (const junk of [null, 'github', 7, ['github'], true])
      expect(read(junk), JSON.stringify(junk)).toEqual({ model: 'inherit', idle_park_min: 30, mcp_allow: [] })
  })
  it('an absent session_opts stays absent', () => {
    expect(Thread.parse({ ...base, session: 'dedicated' }).session_opts).toBeUndefined()
  })
})

describe('resolveThreadsPatch keeps what a thread patch leaves out of session_opts', () => {
  const cur = [
    {
      id: 'trip',
      name: 'Trip',
      color: 'teal',
      session: 'dedicated',
      session_opts: { cwd: '/home/alex/trip', model: 'sonnet', mcp_allow: ['github'] },
    },
    { id: 'garden', name: 'Garden' },
  ]
  const opts = (out: unknown, id = 'trip') =>
    ((out as Array<{ id: string; session_opts?: Record<string, unknown> }>).find((t) => t.id === id) ?? {}).session_opts
  it('an old client that does not know mcp_allow keeps the list on a rename, a reorder and a colour change', () => {
    const oldShaped = (change: Record<string, unknown>) => [
      { ...cur[1] },
      {
        id: 'trip',
        name: 'Trip',
        color: 'teal',
        session: 'dedicated',
        session_opts: { cwd: '/home/alex/trip', model: 'sonnet' },
        ...change,
      },
    ]
    for (const change of [{ name: 'Trips' }, { color: 'pink' }, { order: 1 }])
      expect(opts(resolveThreadsPatch(cur, oldShaped(change))), JSON.stringify(change)).toEqual({
        cwd: '/home/alex/trip',
        model: 'sonnet',
        mcp_allow: ['github'],
      })
  })
  it('a client that sends no session_opts at all keeps all of them (as before)', () => {
    expect(opts(resolveThreadsPatch(cur, [{ id: 'trip', name: 'Trips' }]))).toEqual(cur[0]?.session_opts)
  })
  it('a key sent as null is removed, the others stay', () => {
    expect(opts(resolveThreadsPatch(cur, [{ id: 'trip', session_opts: { mcp_allow: null } }]))).toEqual({
      cwd: '/home/alex/trip',
      model: 'sonnet',
    })
    expect(opts(resolveThreadsPatch(cur, [{ id: 'trip', session_opts: { cwd: null, effort: null } }]))).toEqual({
      model: 'sonnet',
      mcp_allow: ['github'],
    })
  })
  it('a key sent with a value replaces it, including an empty list', () => {
    expect(opts(resolveThreadsPatch(cur, [{ id: 'trip', session_opts: { mcp_allow: [] } }]))?.mcp_allow).toEqual([])
    expect(opts(resolveThreadsPatch(cur, [{ id: 'trip', session_opts: { model: 'opus' } }]))).toEqual({
      cwd: '/home/alex/trip',
      model: 'opus',
      mcp_allow: ['github'],
    })
  })
  it('a new thread, or one with no session_opts yet, just drops nulls; junk passes through for the schema to refuse', () => {
    expect(
      opts(resolveThreadsPatch(cur, [{ id: 'garden', session_opts: { mcp_allow: null, model: 'sonnet' } }]), 'garden'),
    ).toEqual({ model: 'sonnet' })
    expect(opts(resolveThreadsPatch(cur, [{ id: 'new_one', session_opts: { mcp_allow: ['x'] } }]), 'new_one')).toEqual({
      mcp_allow: ['x'],
    })
    expect(opts(resolveThreadsPatch(cur, [{ id: 'trip', session_opts: 'junk' }]))).toBe('junk')
    expect(opts(resolveThreadsPatch(cur, [{ id: 'trip', session_opts: ['junk'] }]))).toEqual(['junk'])
  })
  it('does not touch its inputs', () => {
    const before = JSON.stringify(cur)
    resolveThreadsPatch(cur, [{ id: 'trip', session_opts: { mcp_allow: null } }])
    expect(JSON.stringify(cur)).toBe(before)
  })
})

describe('WorkerEntry.launched', () => {
  const entry = (extra: Record<string, unknown>) => ({
    v: 1,
    supervisor: { pid: 1, heartbeat_at: '2026-10-30T00:00:00.000Z', workers_supported: true },
    threads: {
      trip: {
        state: 'live',
        tmux: 't-trip',
        cwd: '/home/alex/trip',
        session_id: null,
        ...extra,
      },
    },
  })
  const launched = (extra: Record<string, unknown>) =>
    parseWorkersFile(JSON.stringify(entry(extra)))?.threads.trip?.launched
  it('is optional: an entry without it parses as before', () => {
    expect(launched({})).toBeUndefined()
  })
  it('carries the folder, model, effort and MCP list the worker started with', () => {
    expect(
      launched({ launched: { cwd: '/home/alex/trip', model: 'sonnet', effort: 'high', mcp_allow: ['github'] } }),
    ).toEqual({ cwd: '/home/alex/trip', model: 'sonnet', effort: 'high', mcp_allow: ['github'] })
  })
  it('a launch with no list has none', () => {
    expect(launched({ launched: { cwd: '/home/alex/trip', model: 'inherit' } })?.mcp_allow).toBeUndefined()
  })
  it('a value that does not fit reads as none and never makes workers.json unreadable', () => {
    const f = parseWorkersFile(JSON.stringify(entry({ launched: { cwd: 'relative', model: 5 } })))
    expect(f).not.toBeNull()
    expect(f?.threads.trip?.launched).toBeUndefined()
    expect(launched({ launched: 'x' })).toBeUndefined()
  })
  it('a list in it that cannot be read is the empty list', () => {
    expect(launched({ launched: { cwd: '/home/alex/trip', model: 'inherit', mcp_allow: [1] } })?.mcp_allow).toEqual([])
  })
})
