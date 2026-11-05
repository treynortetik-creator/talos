// The direct path through the live service: app-only tools on an http server, and the call-time label check on no-card calls.
import { afterEach, describe, expect, it } from 'bun:test'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { fakeClock } from '@talos-app/testkit'
import { readCatalog } from '../../src/apps/catalog.ts'
import {
  DirectAuthError,
  type DirectConfigT,
  type DirectConnector,
  type DirectSession,
  DirectTimeoutError,
  type DirectTool,
  DirectUnavailableError,
} from '../../src/apps/direct.ts'
import { serverIdOf } from '../../src/apps/keychain.ts'
import { listPending } from '../../src/apps/pending.ts'
import { ScheduleService } from '../../src/schedules/service.ts'
import { type AppsHarness, mkApps, THREAD } from './harness.ts'

const live: AppsHarness[] = []
afterEach(async () => {
  while (live.length) await live.pop()?.h.stop()
})
const T0 = '2026-10-30T12:00:00.000Z'

const TOOLS = [
  {
    name: 'peek',
    resource_uri: 'ui://probe/view.html',
    visibility: ['app'] as Array<'app'>,
    read_only: true,
    destructive: false,
    open_world: true,
  },
  {
    name: 'poll',
    resource_uri: 'ui://probe/view.html',
    visibility: ['app'] as Array<'app'>,
    read_only: false,
    destructive: true,
    open_world: true,
  },
  {
    name: 'read_note',
    resource_uri: 'ui://probe/view.html',
    visibility: ['model', 'app'] as Array<'model' | 'app'>,
    read_only: true,
    destructive: false,
    open_world: true,
  },
  {
    name: 'show_widget',
    resource_uri: 'ui://probe/view.html',
    visibility: ['model', 'app'] as Array<'model' | 'app'>,
    read_only: false,
    destructive: true,
    open_world: true,
  },
]
const rawOf = (t: (typeof TOOLS)[number]): DirectTool => ({
  name: t.name,
  annotations: t.read_only ? { readOnlyHint: true, destructiveHint: false } : undefined,
  _meta: { ui: { resourceUri: t.resource_uri, visibility: t.visibility } },
})

class Fake implements DirectConnector {
  connects = 0
  closes = 0
  calls: Array<{ name: string; args: Record<string, unknown> }> = []
  tools: DirectTool[] = TOOLS.map(rawOf)
  result: Record<string, unknown> = {
    content: [{ type: 'text', text: 'direct-secret-result' }],
    structuredContent: { secret: 'direct-secret-result' },
  }
  callError: Error | undefined
  connectError: Error | undefined
  gate: Promise<void> | undefined
  async connect(_c: DirectConfigT): Promise<DirectSession> {
    if (this.connectError) throw this.connectError
    this.connects++
    return {
      listTools: async () => this.tools,
      callTool: async (name, args) => {
        this.calls.push({ name, args })
        if (this.gate) await this.gate
        if (this.callError) throw this.callError
        return this.result as never
      },
      close: async () => {
        this.closes++
      },
      onClose: () => {},
    }
  }
}

async function boot(
  o: {
    connector?: Fake
    clock?: ReturnType<typeof fakeClock>
    direct?: 'http' | 'stdio' | 'unsupported'
    ownerDirect?: boolean
    keychain?: boolean
    strict?: boolean
  } = {},
) {
  const connector = o.connector ?? new Fake()
  const type = o.direct ?? 'http'
  const a = await mkApps({
    connector,
    ...(o.clock ? { clock: o.clock } : {}),
    fx: {
      tools: TOOLS,
      direct: { type, config_fingerprint: 'a'.repeat(64), auth: 'none' },
      ownerDirect: o.ownerDirect ?? type === 'http',
      ...(o.strict ? { strict: true } : {}),
    },
  })
  live.push(a)
  if (o.keychain !== false)
    await a.sec.secrets.saveConfig(serverIdOf('probe', 'local'), { type: 'http', url: 'https://mcp.example.com/mcp' })
  const v = await a.showView()
  return { a, connector, v }
}
const filesUnder = (dir: string): string[] => {
  const out: string[] = []
  for (const n of readdirSync(dir)) {
    const p = join(dir, n)
    const st = statSync(p)
    if (st.isDirectory()) out.push(...filesUnder(p))
    else if (st.isFile()) out.push(p) // the hub socket is not a file
  }
  return out
}

describe('app-only tool, read-only: no card, no gesture, no agent', () => {
  it("runs on the bridge's own connection; the result goes to the app and nowhere else", async () => {
    const { a, connector, v } = await boot()
    const notesBefore = a.h.notes.length
    const f = await a.call(v.viewId, 'peek', { zone: 'a' }, { user_gesture: false })
    const r = await a.response(f.request_id)
    expect(r.state).toBe('done')
    expect(r.result?.structuredContent).toEqual({ secret: 'direct-secret-result' })
    expect(connector.calls).toEqual([{ name: 'peek', args: { zone: 'a' } }])
    expect(a.h.notes.length).toBe(notesBefore) // the agent heard nothing
    expect(
      a.h.relay.frames.some(
        (x) => x.frame.type === 'card.create' && (x.frame as { card: { kind: string } }).card.kind === 'app_action',
      ),
    ).toBe(false)
    expect(listPending(a.fx.P, Date.now()).requests).toEqual([])
    // the result is in no notification, history row, capture, log, or file under the home
    expect(JSON.stringify(a.h.notes)).not.toContain('direct-secret-result')
    expect(JSON.stringify(a.h.bridge.ctx.store.page({ thread_id: THREAD, limit: 50 }).messages)).not.toContain(
      'direct-secret-result',
    )
    expect(a.logs.join('\n')).not.toContain('direct-secret-result')
    for (const file of filesUnder(a.h.home)) {
      if (/\.sqlite/.test(file)) continue
      expect({ file, has: readFileSync(file).includes('direct-secret-result') }).toEqual({ file, has: false })
    }
  })
  it('the 61st call in a minute is rate_limited; the limit is the direct one, not the agent one', async () => {
    const { a, v } = await boot()
    let done = 0
    for (let i = 0; i < 61; i++) {
      const f = await a.call(v.viewId, 'peek', {}, { user_gesture: false })
      const r = await a.response(f.request_id)
      if (r.state === 'done') done++
      else expect(r.error?.code).toBe('rate_limited')
    }
    expect(done).toBe(60)
  })
  it('an idle session is closed after five minutes (fake clock) and opened again on the next call', async () => {
    const clock = fakeClock(T0)
    const { a, connector, v } = await boot({ clock })
    const f = await a.call(v.viewId, 'peek', {})
    await a.response(f.request_id)
    expect(connector.connects).toBe(1)
    await a.advance(4 * 60_000)
    expect(connector.closes).toBe(0)
    await a.advance(61_000)
    await a.waitFor(() => connector.closes === 1, 2000, 'idle close')
    const g = await a.call(v.viewId, 'peek', {})
    await a.response(g.request_id)
    expect(connector.connects).toBe(2)
  }, 20_000)
  it('a result over 128 KiB is uploaded as JSON media and never written to the Mac media cache', async () => {
    const connector = new Fake()
    connector.result = { content: [{ type: 'text', text: 'x' }], structuredContent: { data: 'k'.repeat(200 * 1024) } }
    const { a, v } = await boot({ connector })
    const f = await a.call(v.viewId, 'peek', {})
    const r = await a.response(f.request_id)
    expect(r.result_media?.mime).toBe('application/json')
    expect(a.puts.some((p) => p.id === r.result_media?.media_id)).toBe(true)
    const cache = join(a.h.home, 'media')
    expect(
      existsSync(cache) ? readdirSync(cache).some((n) => n.startsWith(r.result_media?.media_id ?? '??')) : false,
    ).toBe(false)
  })
})

describe('app-only tool without a read-only label: a bridge card', () => {
  it('card with executor bridge; PRIMARY runs it; the agent hears nothing; card.update says Ran poll; three waiting then too_many_pending', async () => {
    const { a, connector, v } = await boot()
    const f = await a.call(v.viewId, 'poll', {})
    const card = await a.cardFor(f.request_id)
    expect(card.payload).toMatchObject({ kind: 'app_request', executor: 'bridge', tool: 'poll' })
    // the ledger row belongs to the bridge, so the agent cannot send a card_result for it
    expect(a.h.bridge.ctx.ledger.get(card.id)?.actor).toBe('bridge')
    expect(
      (await a.h.bridge.callTool('card_result', { card_id: card.id, ok: true, text: 'x' })).content[0]?.text,
    ).toContain('the bridge reports its result')
    expect((await a.response(f.request_id)).state).toBe('pending_card')
    expect(connector.calls).toEqual([])
    expect(listPending(a.fx.P, Date.now()).requests).toEqual([]) // no pending file: the gate has nothing to do with it
    await a.resolve(card, 'primary')
    const r = await a.response(f.request_id, { final: true })
    expect(r.state).toBe('done')
    expect(connector.calls.length).toBe(1)
    await a.h.relay.expectFrame(
      'card.update',
      (u) => u.card_id === card.id && u.state === 'done' && u.result?.text === 'Ran poll',
      { direction: 'from_bridge' },
    )
    expect(a.notesOf('card_action')).toEqual([])
    expect(a.h.notes.filter((n) => n.meta.kind !== 'system')).toEqual([])
    // the next polls each ask again, and after three waiting the view is told
    for (let i = 0; i < 3; i++) await a.cardFor((await a.call(v.viewId, 'poll', {})).request_id)
    const g = await a.call(v.viewId, 'poll', {})
    expect((await a.response(g.request_id, { final: true })).error?.code).toBe('too_many_pending')
  })
  it('KILL: owner_killed, nothing called', async () => {
    const { a, connector, v } = await boot()
    const f = await a.call(v.viewId, 'poll', {})
    const card = await a.cardFor(f.request_id)
    await a.resolve(card, 'kill')
    expect((await a.response(f.request_id, { final: true })).error?.code).toBe('owner_killed')
    expect(connector.calls).toEqual([])
    expect(a.notesOf('card_action')).toEqual([])
  })
  it('an approved card whose view closed meanwhile still runs, and the result is discarded', async () => {
    const connector = new Fake()
    let release = () => {}
    connector.gate = new Promise<void>((r) => {
      release = r
    })
    const { a, v } = await boot({ connector })
    const f = await a.call(v.viewId, 'poll', {})
    const card = await a.cardFor(f.request_id)
    await a.response(f.request_id)
    await a.resolve(card, 'primary')
    await a.waitFor(() => connector.calls.length === 1, 3000, 'call started')
    await a.svc.revokeView(a.svc.store.getView(v.viewId) as never, 'closing')
    release()
    await a.waitFor(
      () =>
        a.h.relay.frames.some(
          (x) => x.frame.type === 'card.update' && (x.frame as { state?: string }).state === 'done',
        ),
      3000,
      'card done',
    )
    expect(a.responses(f.request_id).filter((r) => r.state === 'done')).toEqual([])
  })
})

describe('a bridge-run card and the things that can happen to it mid-run', () => {
  const gated = async () => {
    const connector = new Fake()
    let release = () => {}
    connector.gate = new Promise<void>((r) => {
      release = r
    })
    const { a, v } = await boot({ connector })
    const f = await a.call(v.viewId, 'poll', {})
    const card = await a.cardFor(f.request_id)
    await a.response(f.request_id)
    return { a, connector, card, release }
  }
  const sweepStuck = (a: AppsHarness) =>
    // the schedules start-up sweep, run on the real ledger (it needs only ctx, now and iso)
    (ScheduleService.prototype as unknown as { failStuckCards(this: unknown): Promise<void> }).failStuckCards.call({
      stopped: false,
      ctx: a.h.bridge.ctx,
      now: () => Date.now(),
      iso: () => new Date().toISOString(),
    })

  it('closed by something else mid-run (not the owner), the real tool result still reaches the card', async () => {
    const { a, connector, card, release } = await gated()
    await a.resolve(card, 'primary')
    await a.waitFor(() => connector.calls.length === 1, 3000, 'call started')
    a.h.bridge.ctx.ledger.finish(card.id, false) // what a sweep that closes "stuck" cards would do
    release()
    await a.h.relay.expectFrame(
      'card.update',
      (u) => u.card_id === card.id && u.state === 'done' && u.result?.text === 'Ran poll',
      { direction: 'from_bridge' },
    )
  })

  it('the start-up sweep leaves a card alone while this process is still running its tool', async () => {
    const { a, connector, card, release } = await gated()
    await a.resolve(card, 'primary')
    await a.waitFor(() => connector.calls.length === 1, 3000, 'call started')
    await sweepStuck(a)
    expect(a.h.bridge.ctx.ledger.get(card.id)?.state).toBe('resolved')
    release()
    await a.waitFor(() => a.h.bridge.ctx.ledger.get(card.id)?.state === 'done', 3000, 'card done')
    // and once it has finished, it is no longer "in flight" and the sweep has nothing to take
    await sweepStuck(a)
    expect(a.h.bridge.ctx.ledger.get(card.id)?.state).toBe('done')
  })

  it('the sweep still closes an approved card that nothing in this process is running (left by a restart)', async () => {
    const { a, card } = await gated()
    a.h.bridge.ctx.store.db.query("UPDATE cards SET state = 'resolved', resolution_json = ? WHERE id = ?").run(
      JSON.stringify({
        action: 'primary',
        at: new Date().toISOString(),
        edited: false,
        payload_hash: card.payload_hash,
      }),
      card.id,
    )
    await sweepStuck(a)
    expect(a.h.bridge.ctx.ledger.get(card.id)?.state).toBe('failed')
  })

  it('approved while Apps are off: nothing runs, and the card says Apps are off, not "this app changed"', async () => {
    const connector = new Fake()
    const { a, v } = await boot({ connector })
    const f = await a.call(v.viewId, 'poll', {})
    const card = await a.cardFor(f.request_id)
    await a.response(f.request_id)
    a.flag.on = false
    await a.resolve(card, 'primary')
    const upd = await a.h.relay.expectFrame('card.update', (u) => u.card_id === card.id && u.state === 'failed', {
      direction: 'from_bridge',
    })
    expect(upd.result).toMatchObject({ ok: false, ran: false })
    expect(upd.result?.text).toContain('Apps are turned off on this Mac')
    expect(upd.result?.text).not.toContain('changed')
    expect(connector.calls).toEqual([])
  })
})

describe('failures (M5.6 table)', () => {
  const run = async (o: Parameters<typeof boot>[0], tool = 'peek') => {
    const { a, connector, v } = await boot(o)
    return { a, connector, v, go: async () => a.response((await a.call(v.viewId, tool, {})).request_id) }
  }
  it('unreachable: direct_unavailable, and the next call reconnects', async () => {
    const connector = new Fake()
    connector.callError = new DirectUnavailableError('down')
    const { go } = await run({ connector })
    expect((await go()).error?.code).toBe('direct_unavailable')
    connector.callError = undefined
    expect((await go()).state).toBe('done')
  })
  it('three failures in ten minutes raise one notice; after three drops the server is paused, so the check cannot run and calls become cards', async () => {
    const connector = new Fake()
    connector.callError = new DirectUnavailableError('down')
    const { a, v, go } = await run({ connector })
    for (let i = 0; i < 3; i++) expect((await go()).error?.code).toBe('direct_unavailable')
    await a.h.relay.expectFrame(
      'reply',
      (f) => f.message.author === 'system' && /not answering/.test(f.message.text ?? ''),
      { direction: 'from_bridge' },
    )
    connector.callError = undefined
    const f = await a.call(v.viewId, 'peek', {})
    const card = await a.cardFor(f.request_id)
    expect(card.warning).toContain("couldn't check")
  })
  it('sign-in needed: direct_auth and one notice per server per day', async () => {
    const clock = fakeClock(T0)
    const connector = new Fake()
    connector.callError = new DirectAuthError('401')
    const { a, go } = await run({ connector, clock })
    expect((await go()).error?.code).toBe('direct_auth')
    expect((await go()).error?.code).toBe('direct_auth')
    const notices = () =>
      a.h.relay.frames.filter(
        (x) =>
          x.direction === 'from_bridge' &&
          x.frame.type === 'reply' &&
          /need sign-in/.test((x.frame as { message?: { text?: string } }).message?.text ?? ''),
      ).length
    await a.waitFor(() => notices() === 1, 3000, 'one notice')
    await a.idle()
    expect(notices()).toBe(1)
    clock.set(Date.parse(T0) + 25 * 3600_000)
    const later = await a.showView() // the first view's 24 h are over; a new one, a day later
    const f2 = await a.call(later.viewId, 'peek', {})
    expect((await a.response(f2.request_id)).error?.code).toBe('direct_auth')
    await a.waitFor(() => notices() === 2, 3000, 'a second notice a day later')
  })
  it('a missing or locked Keychain is direct_auth when a card is approved (and the text names no secret); a no-card call falls back to the card first', async () => {
    const { a, v } = await boot({ keychain: false })
    const f = await a.call(v.viewId, 'poll', {})
    const card = await a.cardFor(f.request_id)
    await a.resolve(card, 'primary')
    const r = await a.response(f.request_id, { final: true })
    expect(r.error?.code).toBe('direct_auth')
    expect(JSON.stringify(r)).not.toContain('mcp.example.com')
    const g = await a.call(v.viewId, 'peek', {})
    expect((await a.cardFor(g.request_id)).warning).toContain("couldn't check")
  })
  it('timeout and an oversize server result are their own codes', async () => {
    const connector = new Fake()
    connector.callError = new DirectTimeoutError('slow')
    const { go } = await run({ connector })
    expect((await go()).error?.code).toBe('timeout')
  })
  it('a server error text never reaches the app through the failure message', async () => {
    const connector = new Fake()
    connector.callError = new Error('SQL error near password=hunter2 in /srv/db')
    const { go } = await run({ connector })
    const r = await go()
    expect(r.error).toEqual({ code: 'tool_failed', message: 'The tool call failed.' })
  })
  it("the server's tool list drifted at connect: approval_changed, no call, the catalog is marked, a notice says rescan", async () => {
    const connector = new Fake()
    const { a, v } = await boot({ connector })
    connector.tools = TOOLS.map((t) =>
      t.name === 'peek' ? { ...rawOf(t), annotations: { readOnlyHint: false } } : rawOf(t),
    )
    const f = await a.call(v.viewId, 'peek', {})
    expect((await a.response(f.request_id)).error?.code).toBe('approval_changed')
    expect(connector.calls).toEqual([])
    const cat = readCatalog(a.fx.P)
    expect(cat.ok && cat.catalog?.servers[0]?.resources[0]).toMatchObject({
      state: 'needs_reapproval',
      reapproval_diff: '`peek` is labelled differently than when you approved it',
    })
    await a.waitFor(() => a.updates(v.viewId).some((u) => u.state === 'revoked'), 3000, 'revoked')
    await a.h.relay.expectFrame(
      'reply',
      (m) =>
        m.message.author === 'system' &&
        m.message.text ===
          'Probe view changed how it labels its tools. Run talos-app apps scan on the Mac to re-approve.',
      { direction: 'from_bridge' },
    )
    const g = await a.call(v.viewId, 'peek', {})
    expect((await a.response(g.request_id)).error?.code).toBe('view_closed') // the views are revoked: refused until re-approved
  })
  it('stdio and sdk/proxy servers: app_only_unsupported, and no connection is ever made', async () => {
    for (const direct of ['stdio', 'unsupported'] as const) {
      const { a, connector, v } = await boot({ direct, ownerDirect: false })
      const f = await a.call(v.viewId, 'peek', {})
      expect((await a.response(f.request_id)).error?.code).toBe('app_only_unsupported')
      expect(connector.connects).toBe(0)
      await a.h.stop()
      live.pop()
    }
  })
})

describe('the call-time label check on a no-card agent-path call (D3)', () => {
  it('identical labels: no card, the agent is told', async () => {
    const { a, v } = await boot()
    await a.call(v.viewId, 'read_note', { id: 'n1' })
    await a.waitFor(() => a.notesOf('app_tool_call').length === 1, 3000, 'note')
  })
  it('relabelled to destructive with no rescan: approval_changed, the views are revoked, needs_reapproval, a thread notice, and the agent gets no app_tool_call', async () => {
    const connector = new Fake()
    const { a, v } = await boot({ connector })
    connector.tools = TOOLS.map((t) =>
      t.name === 'read_note' ? { ...rawOf(t), annotations: { readOnlyHint: true, destructiveHint: true } } : rawOf(t),
    )
    const f = await a.call(v.viewId, 'read_note', { id: 'n1' })
    expect((await a.response(f.request_id)).error?.code).toBe('approval_changed')
    await a.waitFor(() => a.updates(v.viewId).some((u) => u.state === 'revoked'), 3000, 'revoked')
    expect(a.notesOf('app_tool_call')).toEqual([])
    const cat = readCatalog(a.fx.P)
    expect(cat.ok && cat.catalog?.servers[0]?.resources[0]?.state).toBe('needs_reapproval')
    await a.h.relay.expectFrame(
      'reply',
      (m) => m.message.author === 'system' && /changed how it labels its tools/.test(m.message.text ?? ''),
      { direction: 'from_bridge' },
    )
  })
  it('the check cannot run: the call becomes a card whose warning says so', async () => {
    const connector = new Fake()
    connector.connectError = new DirectUnavailableError('down')
    const { a, v } = await boot({ connector })
    const f = await a.call(v.viewId, 'read_note', { id: 'n1' })
    const card = await a.cardFor(f.request_id)
    expect(card.warning).toBe(
      "Asked for by an app, not by you or Talos. Talos couldn't check this tool's current labels.",
    )
    expect(a.notesOf('app_tool_call')).toEqual([])
  })
  it('a locked Keychain makes the same fall-back to a card', async () => {
    const { a, v } = await boot({ keychain: false })
    const f = await a.call(v.viewId, 'read_note', { id: 'n1' })
    const card = await a.cardFor(f.request_id)
    expect(card.warning).toContain("couldn't check")
  })
  it('stdio: no label-check connection, so it runs on the approved labels; with strict on it becomes a card', async () => {
    const { a, connector, v } = await boot({ direct: 'stdio', ownerDirect: false })
    await a.call(v.viewId, 'read_note', { id: 'n1' })
    await a.waitFor(() => a.notesOf('app_tool_call').length === 1, 3000, 'runs without a card')
    expect(connector.connects).toBe(0)
    const s = await boot({ direct: 'stdio', ownerDirect: false, strict: true })
    const f = await s.a.call(s.v.viewId, 'read_note', { id: 'n1' })
    const card = await s.a.cardFor(f.request_id)
    expect(card.warning).toContain("couldn't check")
    expect(s.a.notesOf('app_tool_call')).toEqual([])
  })
})
