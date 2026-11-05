import { describe, expect, it } from 'bun:test'
import { newUlid } from '@talos-app/protocol'
import { readCatalog } from '../../src/apps/catalog.ts'
import { type DecideCtx, decideCall, Limits, takeMessage } from '../../src/apps/policy.ts'
import { AppStore, type ViewRow } from '../../src/apps/views.ts'
import { openHistory } from '../../src/history-store.ts'
import { approvedFixture, tmp } from './helpers.ts'

const NOW0 = Date.parse('2026-10-30T12:00:00Z')

async function mk(over: { direct?: never; fx?: Parameters<typeof approvedFixture>[1] } = {}) {
  const home = tmp()
  const fx = await approvedFixture(home, over.fx ?? {})
  const store = new AppStore(openHistory(`${home}/h.sqlite`))
  let now = NOW0
  const limits = new Limits(() => now)
  const thread = 'general'
  const view: ViewRow = {
    view_id: `av_${newUlid()}`,
    thread_id: thread,
    server: 'probe',
    source: 'local',
    tool: 'show_widget',
    resource_uri: 'ui://probe/view.html',
    approval_key: fx.key,
    shown_at: new Date(now).toISOString(),
    calls_until: new Date(now + 24 * 3600_000).toISOString(),
    state: 'active',
  }
  store.addView(view)
  let pending = 0
  let label: 'identical' | 'changed' | 'failed' = 'identical'
  let labelCalls = 0
  const cat = readCatalog(fx.P)
  const ctx = (): DecideCtx => ({
    now,
    catalog: cat.ok ? cat.catalog : undefined,
    store,
    limits,
    pendingCount: () => pending,
    labelCheck: async () => {
      labelCalls++
      return label
    },
    hasLabelConnection: (s, r) => (s.direct?.type === 'http' || s.direct?.type === 'sse') && r.owner.direct,
  })
  const req = (toolName: string, over2: Record<string, unknown> = {}) => ({
    viewId: view.view_id,
    threadId: thread,
    toolName,
    gesture: true,
    argsBytes: 10,
    ...over2,
  })
  return {
    fx,
    store,
    limits,
    view,
    req,
    decide: (toolName: string, o: Record<string, unknown> = {}) => decideCall(ctx(), req(toolName, o)),
    setNow: (t: number) => {
      now = t
    },
    advance: (ms: number) => {
      now += ms
    },
    getNow: () => now,
    setPending: (n: number) => {
      pending = n
    },
    setLabel: (l: typeof label) => {
      label = l
    },
    labelCalls: () => labelCalls,
    ctx,
  }
}
const code = (d: Awaited<ReturnType<typeof decideCall>>) =>
  d.kind === 'fail' ? d.code : d.kind === 'run' ? (d.card ? 'card' : 'run') : '?'

describe('M4.3, row by row', () => {
  it('step 2: unknown view, wrong thread, closed view, expired window', async () => {
    const m = await mk()
    expect(code(await decideCall(m.ctx(), { ...m.req('show_widget'), viewId: `av_${newUlid()}` }))).toBe('view_unknown')
    expect(code(await decideCall(m.ctx(), { ...m.req('show_widget'), threadId: 'other' }))).toBe('view_unknown')
    m.advance(24 * 3600_000 + 1)
    expect(code(await m.decide('show_widget'))).toBe('view_closed')
    const m2 = await mk()
    m2.store.setViewState(m2.view.view_id, 'closed')
    expect(code(await m2.decide('show_widget'))).toBe('view_closed')
    const m3 = await mk()
    m3.store.setViewState(m3.view.view_id, 'superseded')
    expect(code(await m3.decide('show_widget'))).toBe('view_closed')
  })
  it("step 3: a view whose approval key is not the catalog's is approval_changed and asks for the server's views to go", async () => {
    const m = await mk()
    const stale = await mk()
    stale.store.setViewState(stale.view.view_id, 'closed')
    const d = await decideCall({ ...m.ctx(), catalog: undefined }, m.req('show_widget'))
    expect(d).toMatchObject({ kind: 'fail', code: 'approval_changed', revoke: 'server' })
    const other = { ...m.view, view_id: `av_${newUlid()}`, approval_key: 'f'.repeat(64) }
    m.store.addView(other)
    const d2 = await decideCall(m.ctx(), { ...m.req('show_widget'), viewId: other.view_id })
    expect(d2).toMatchObject({ kind: 'fail', code: 'approval_changed', revoke: 'server' })
  })
  it('step 3: a resource that is no longer approved refuses', async () => {
    const m = await mk()
    const c = m.ctx()
    const cat = structuredClone(c.catalog)
    if (cat) (cat.servers[0] as { resources: Array<{ state: string }> }).resources[0]!.state = 'declined'
    expect(await decideCall({ ...c, catalog: cat }, m.req('show_widget'))).toMatchObject({
      kind: 'fail',
      code: 'approval_changed',
    })
  })
  it('step 4: three pending is too_many_pending', async () => {
    const m = await mk()
    m.setPending(3)
    expect(code(await m.decide('show_widget'))).toBe('too_many_pending')
    m.setPending(2)
    expect(code(await m.decide('show_widget'))).toBe('card')
  })
  it("step 5: another server's tool is cross_server, an unknown tool not_in_catalog", async () => {
    const m = await mk()
    const c = m.ctx()
    const cat = structuredClone(c.catalog)
    cat?.servers.push({
      ...(cat.servers[0] as object),
      server: 'other',
      source: 'user',
      tool_prefix: 'mcp__other__',
      tools: [
        { name: 'their_tool', visibility: ['model', 'app'], read_only: true, destructive: false, open_world: true },
      ],
      resources: [],
    } as never)
    expect(code(await decideCall({ ...c, catalog: cat }, m.req('their_tool')))).toBe('cross_server')
    expect(code(await decideCall({ ...c, catalog: cat }, m.req('nope')))).toBe('not_in_catalog')
  })
  it('step 6: a model-only tool is not_app_visible; app-only without a direct connection is app_only_unsupported', async () => {
    const m = await mk()
    expect(code(await m.decide('model_only'))).toBe('not_app_visible')
    expect(code(await m.decide('app_only_refresh'))).toBe('app_only_unsupported')
    for (const t of ['stdio', 'unsupported'] as const) {
      const x = await mk({ fx: { direct: { type: t, auth: 'none' }, ownerDirect: false } })
      expect(code(await x.decide('app_only_refresh'))).toBe('app_only_unsupported')
    }
    const noOwnerDirect = await mk({ fx: { direct: { type: 'http', auth: 'none' }, ownerDirect: false } })
    expect(code(await noOwnerDirect.decide('app_only_refresh'))).toBe('app_only_unsupported')
  })
  it('step 7: arguments over 16 KiB are too_large', async () => {
    const m = await mk()
    expect(code(await m.decide('show_widget', { argsBytes: 16 * 1024 + 1 }))).toBe('too_large')
  })
})

describe('step 8 in trust mode: approve the app once', () => {
  const tool = (name: string, read_only: boolean, destructive: boolean, open_world = true) => ({
    name,
    resource_uri: 'ui://probe/view.html',
    visibility: ['model' as const, 'app' as const],
    read_only,
    destructive,
    open_world,
  })
  const tools = [
    tool('read_note', true, false),
    tool('write_note', false, false, false), // a local write: changes something, not destructively, reaches nothing outside
    tool('post_message', false, false, true), // not destructive, but it reaches the outside world (sends as the owner)
    tool('wipe_notes', false, true),
    tool('read_but_asked', true, false),
  ]
  const on = (m: Awaited<ReturnType<typeof mk>>) => ({ ...m.ctx(), trust: true })

  it('off: the write tool asks, as before', async () => {
    const m = await mk({ fx: { tools } })
    expect(code(await decideCall(m.ctx(), m.req('write_note')))).toBe('card')
    expect(code(await decideCall({ ...m.ctx(), trust: false }, m.req('write_note')))).toBe('card')
  })
  it('on: a tool that reaches the outside world (open_world) still draws a card, with or without a gesture', async () => {
    const m = await mk({ fx: { tools } })
    expect(code(await decideCall(on(m), m.req('post_message')))).toBe('card')
    expect(code(await decideCall(on(m), m.req('post_message', { gesture: false })))).toBe('card')
  })
  it('on: a local write draws a card even when user_gesture is true (a view can fake the tap)', async () => {
    const m = await mk({ fx: { tools } })
    expect(code(await decideCall(on(m), m.req('write_note', { gesture: false })))).toBe('card')
    expect(code(await decideCall(on(m), m.req('write_note', { gesture: true })))).toBe('card')
  })
  it('on: a read-only tool still runs without a card, even open-world and without a gesture', async () => {
    const m = await mk({ fx: { tools } })
    expect(code(await decideCall(on(m), m.req('read_note', { gesture: false })))).toBe('run')
  })
  it('on: a read-only tool runs; a write, a destructive tool and an ask-each-time tool draw a card', async () => {
    const m = await mk({ fx: { tools, askEach: ['read_but_asked'] } })
    expect(code(await decideCall(on(m), m.req('write_note')))).toBe('card')
    expect(code(await decideCall(on(m), m.req('read_note', { gesture: true })))).toBe('run')
    expect(code(await decideCall(on(m), m.req('wipe_notes')))).toBe('card')
    expect(code(await decideCall(on(m), m.req('read_but_asked')))).toBe('card')
  })
  it('on: an unlabelled tool is destructive by the label rules, so it still asks', async () => {
    const m = await mk({ fx: { tools: [{ ...tool('mystery', false, true) }] } })
    expect(code(await decideCall(on(m), m.req('mystery')))).toBe('card')
  })
  it('on: the approval key, the rate limits and a changed label still refuse first', async () => {
    const http = {
      direct: { type: 'http' as const, config_fingerprint: 'a'.repeat(64), auth: 'none' as const },
      ownerDirect: true,
    }
    const m = await mk({ fx: { tools, ...http } })
    m.setLabel('changed')
    expect(await decideCall(on(m), m.req('read_note'))).toMatchObject({ kind: 'fail', code: 'approval_changed' })
    m.setLabel('failed')
    expect(await decideCall(on(m), m.req('read_note'))).toMatchObject({ kind: 'run', card: true, couldntCheck: true })
    const gone = await decideCall({ ...on(m), catalog: undefined }, m.req('read_note'))
    expect(gone).toMatchObject({ kind: 'fail', code: 'approval_changed' })
  })
  it('on: a strict server still asks (the owner chose strict)', async () => {
    const m = await mk({ fx: { tools, strict: true } })
    expect(await decideCall(on(m), m.req('read_note'))).toMatchObject({ kind: 'run', card: true, couldntCheck: true })
  })
})

describe('step 8: the run rule', () => {
  it('a tool with no annotations or a destructive one asks (card); read-only and not destructive runs without one', async () => {
    const m = await mk()
    expect(code(await m.decide('show_widget'))).toBe('card')
    expect(code(await m.decide('set_note'))).toBe('card')
    expect(code(await m.decide('read_note'))).toBe('run')
    expect(m.labelCalls()).toBe(0) // stdio: no label-check connection
  })
  it('strict sends a no-label-check server to a card with the "couldn\'t check" mark', async () => {
    const m = await mk({ fx: { strict: true } })
    expect(await m.decide('read_note')).toMatchObject({ kind: 'run', card: true, couldntCheck: true })
  })
  it('ask_each_time forces a card even on a read-only label', async () => {
    const m = await mk({ fx: { askEach: ['read_note'] } })
    expect(code(await m.decide('read_note'))).toBe('card')
  })
  const http = {
    direct: { type: 'http' as const, config_fingerprint: 'a'.repeat(64), auth: 'none' as const },
    ownerDirect: true,
  }
  it('with a label-check connection: identical runs, changed refuses and re-asks at a rescan, failed becomes a card', async () => {
    const m = await mk({ fx: http })
    expect(await m.decide('read_note')).toMatchObject({ kind: 'run', card: false, path: 'agent' })
    expect(m.labelCalls()).toBe(1)
    m.setLabel('changed')
    expect(await m.decide('read_note')).toMatchObject({ kind: 'fail', code: 'approval_changed', revoke: 'server' })
    m.setLabel('failed')
    expect(await m.decide('read_note')).toMatchObject({ kind: 'run', card: true, couldntCheck: true })
  })
  it('card-gated calls need no label check', async () => {
    const m = await mk({ fx: http })
    m.setLabel('changed')
    expect(code(await m.decide('set_note'))).toBe('card')
    expect(m.labelCalls()).toBe(0)
  })
  it('app-only tools take the direct path: a card unless read-only, never an agent notification', async () => {
    const x = await mk({
      fx: {
        ...http,
        tools: [
          {
            name: 'poll',
            resource_uri: 'ui://probe/view.html',
            visibility: ['app'],
            read_only: false,
            destructive: false,
            open_world: true,
          },
          {
            name: 'peek',
            resource_uri: 'ui://probe/view.html',
            visibility: ['app'],
            read_only: true,
            destructive: false,
            open_world: true,
          },
        ],
      },
    })
    expect(await x.decide('poll')).toMatchObject({ kind: 'run', path: 'direct', card: true })
    expect(await x.decide('peek')).toMatchObject({ kind: 'run', path: 'direct', card: false })
    x.setLabel('changed')
    expect(await x.decide('peek')).toMatchObject({ kind: 'fail', code: 'approval_changed' })
  })
})

describe('rate limits and budgets (M4.6)', () => {
  it('30 calls a minute per view: the 31st is rate_limited; a minute later it is fine', async () => {
    const m = await mk()
    for (let i = 0; i < 30; i++) expect(code(await m.decide('show_widget'))).toBe('card')
    expect(code(await m.decide('show_widget'))).toBe('rate_limited')
    m.advance(60_001)
    expect(code(await m.decide('show_widget'))).toBe('card')
  })
  it('60 a day per view: the 61st is rate_limited though each minute was fine', async () => {
    const m = await mk()
    for (let i = 0; i < 60; i++) {
      expect(code(await m.decide('show_widget'))).toBe('card')
      m.advance(61_000)
    }
    expect(code(await m.decide('show_widget'))).toBe('rate_limited')
    m.advance(24 * 3600_000)
    // the view's own 24 h window has passed too, so the view is closed, not limited
    expect(code(await m.decide('show_widget'))).toBe('view_closed')
  })
  it('a failed call spends nothing: a refused request does not eat the budget it did not use', () => {
    const l = new Limits(() => NOW0)
    expect(
      l.take([
        ['a', 60_000, 1],
        ['b', 60_000, 1],
      ]).ok,
    ).toBe(true)
    expect(
      l.take([
        ['c', 60_000, 5],
        ['a', 60_000, 1],
      ]),
    ).toEqual({ ok: false, key: 'a' })
    expect(l.count('c', 60_000)).toBe(0) // c was not charged for a call that was refused on a
  })
  it('without a gesture the per-view limit is 6 a minute; with a gesture the normal limit', async () => {
    const m = await mk()
    for (let i = 0; i < 6; i++) expect(code(await m.decide('read_note', { gesture: false }))).toBe('run')
    expect(code(await m.decide('read_note', { gesture: false }))).toBe('rate_limited')
    expect(code(await m.decide('read_note', { gesture: true }))).toBe('run')
  })
  it('global 120 a minute, 300 a day, and 60 a minute per server', async () => {
    const limits = new Limits(() => NOW0)
    let n = 0
    for (let v = 0; v < 12; v++)
      for (let i = 0; i < 10; i++)
        if (
          limits.take([
            [`v${v}`, 60_000, 30],
            ['g', 60_000, 120],
          ]).ok
        )
          n++
    expect(n).toBe(120)
    const m = await mk()
    // per server: 60 across several views of one server
    const ids: string[] = []
    for (let i = 0; i < 4; i++) {
      const v = { ...m.view, view_id: `av_${newUlid()}` }
      m.store.addView(v)
      ids.push(v.view_id)
    }
    let ok = 0
    for (const id of ids)
      for (let i = 0; i < 20; i++)
        if ((await decideCall(m.ctx(), { ...m.req('show_widget'), viewId: id })).kind === 'run') ok++
    expect(ok).toBe(60)
  })
  it('three limit hits by one view in ten minutes close it (abuse rule); two do not', async () => {
    const m = await mk()
    for (let i = 0; i < 30; i++) await m.decide('show_widget')
    const a = await m.decide('show_widget')
    const b = await m.decide('show_widget')
    const c = await m.decide('show_widget')
    expect(a).toMatchObject({ kind: 'fail', code: 'rate_limited' })
    expect((a as { closeView?: boolean }).closeView).toBeUndefined()
    expect((b as { closeView?: boolean }).closeView).toBeUndefined()
    expect((c as { closeView?: boolean }).closeView).toBe(true)
  })
  it('the direct path has its own, higher limits and does not spend the agent budget', async () => {
    const x = await mk({
      fx: {
        direct: { type: 'http', config_fingerprint: 'a'.repeat(64), auth: 'none' },
        ownerDirect: true,
        tools: [
          {
            name: 'peek',
            resource_uri: 'ui://probe/view.html',
            visibility: ['app'],
            read_only: true,
            destructive: false,
            open_world: true,
          },
          {
            name: 'show_widget',
            resource_uri: 'ui://probe/view.html',
            visibility: ['model', 'app'],
            read_only: false,
            destructive: true,
            open_world: true,
          },
        ],
      },
    })
    for (let i = 0; i < 60; i++) expect((await x.decide('peek')).kind).toBe('run')
    expect(code(await x.decide('peek'))).toBe('rate_limited') // the 61st in a minute
    expect(code(await x.decide('show_widget'))).toBe('card') // agent budget untouched
  })
  it('ui/message: 6 a minute and 30 a day per view, 30 an hour overall', () => {
    let now = NOW0
    const l = new Limits(() => now)
    for (let i = 0; i < 6; i++) expect(takeMessage(l, 'v').ok).toBe(true)
    expect(takeMessage(l, 'v').ok).toBe(false)
    now += 61_000
    expect(takeMessage(l, 'v').ok).toBe(true)
    const g = new Limits(() => now)
    let ok = 0
    for (let v = 0; v < 10; v++) for (let i = 0; i < 6; i++) if (takeMessage(g, `view${v}`).ok) ok++
    expect(ok).toBe(30)
  })
  it('clock jumps: a jump forward frees the window, a jump back keeps the old hits and never throws', async () => {
    const m = await mk()
    for (let i = 0; i < 30; i++) await m.decide('show_widget')
    expect(code(await m.decide('show_widget'))).toBe('rate_limited')
    m.setNow(NOW0 - 3600_000) // the clock went back an hour: the hits are in the "future", still counted
    expect(code(await m.decide('show_widget'))).toBe('rate_limited')
    m.setNow(NOW0 + 2 * 60_000) // forward past the minute window
    expect(code(await m.decide('show_widget'))).toBe('card')
    m.setNow(Number.NaN)
    await expect(m.decide('show_widget')).resolves.toBeDefined()
  })
  it('forgetting a view drops its counters', () => {
    const l = new Limits(() => NOW0)
    l.take([['v:av_1:call:m', 60_000, 5]])
    l.forgetView('av_1')
    expect(l.count('v:av_1:call:m', 60_000)).toBe(0)
  })
})
