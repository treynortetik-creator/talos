// The no-card decision is re-checked after the awaited label check (S1), and name matching is exact (S7, S8).
import { afterEach, describe, expect, it } from 'bun:test'
import { readCatalog, writeCatalog } from '../../src/apps/catalog.ts'
import type { DirectConfigT, DirectConnector, DirectSession, DirectTool } from '../../src/apps/direct.ts'
import { serverIdOf } from '../../src/apps/keychain.ts'
import { readPending } from '../../src/apps/pending.ts'
import { type AppsHarness, mkApps } from './harness.ts'

const live: AppsHarness[] = []
afterEach(async () => {
  while (live.length) await live.pop()?.h.stop()
})
const dec = (o: unknown) =>
  (JSON.parse(JSON.stringify(o ?? null)) as { hookSpecificOutput?: { permissionDecision?: string } } | null)
    ?.hookSpecificOutput?.permissionDecision ?? 'pass-through'

const URI = 'ui://probe/view.html'
const TOOLS = [
  {
    name: 'peek',
    resource_uri: URI,
    visibility: ['app'] as Array<'model' | 'app'>,
    read_only: true,
    destructive: false,
    open_world: true,
  },
  {
    name: 'read_note',
    resource_uri: URI,
    visibility: ['model', 'app'] as Array<'model' | 'app'>,
    read_only: true,
    destructive: false,
    open_world: true,
  },
  {
    name: 'show_widget',
    resource_uri: URI,
    visibility: ['model', 'app'] as Array<'model' | 'app'>,
    read_only: false,
    destructive: true,
    open_world: true,
  },
]
class Fake implements DirectConnector {
  calls: string[] = []
  lists = 0
  stall: Promise<void> | undefined
  tools: DirectTool[] = TOOLS.map((t) => ({
    name: t.name,
    annotations: t.read_only ? { readOnlyHint: true, destructiveHint: false } : undefined,
    _meta: { ui: { resourceUri: t.resource_uri, visibility: t.visibility } },
  }))
  async connect(_c: DirectConfigT): Promise<DirectSession> {
    return {
      // the server answers with what it says now; the answer reaches the bridge after `stall`
      listTools: async () => {
        this.lists++
        const snap = this.tools
        const g = this.stall
        if (g) await g
        return snap
      },
      callTool: async (name) => {
        this.calls.push(name)
        return { content: [{ type: 'text', text: 'ok' }] } as never
      },
      close: async () => {},
      onClose: () => {},
    }
  }
}
const destructive = (c: Fake, name: string) => {
  c.tools = c.tools.map((t) =>
    t.name === name ? { ...t, annotations: { readOnlyHint: false, destructiveHint: true } } : t,
  )
}
async function boot() {
  const c = new Fake()
  const a = await mkApps({
    connector: c,
    fx: { tools: TOOLS, direct: { type: 'http', config_fingerprint: 'a'.repeat(64), auth: 'none' }, ownerDirect: true },
  })
  live.push(a)
  await a.sec.secrets.saveConfig(serverIdOf('probe', 'local'), { type: 'http', url: 'https://mcp.example.com/mcp' })
  const v = await a.showView()
  return { a, c, v }
}
function hold(c: Fake) {
  let release = () => {}
  c.stall = new Promise<void>((r) => {
    release = r
  })
  return () => {
    c.stall = undefined
    release()
  }
}
/** What a `talos-app apps scan` leaves when it sees the relabel: catalog carries the new labels, app needs re-approval. */
function scanSawRelabel(a: AppsHarness, name: string) {
  const r = readCatalog(a.fx.P)
  if (!r.ok || !r.catalog) throw new Error('catalog')
  const cat = structuredClone(r.catalog)
  const s = cat.servers[0] as (typeof cat.servers)[number]
  s.tools = s.tools.map((t) => (t.name === name ? { ...t, read_only: false, destructive: true } : t))
  for (const x of s.resources) x.state = 'needs_reapproval'
  writeCatalog(a.fx.P, cat)
}
const pre = (a: AppsHarness, tool: string, args: Record<string, unknown>, id: string) =>
  dec(a.hook('pre-tool-use', { tool_name: `mcp__probe__${tool}`, tool_input: args, tool_use_id: id }))
const settle = async (a: AppsHarness, id: string) => {
  await a.h.bridge.inbound?.appsIdle()
  // the outcome travels over the socket after the bridge is idle: an app.response (refused) or the tool-call note
  // (authorised). Wait for whichever comes, not for a fixed delay.
  await a.waitFor(
    () => a.responses(id).length > 0 || a.notesOf('app_tool_call').length > 0,
    4000,
    `an outcome for ${id}`,
  )
  return {
    notes: a.notesOf('app_tool_call').length,
    resp: a.responses(id).map((x) => `${x.state}:${x.error?.code ?? ''}`),
    pending: readPending(a.fx.P, id)?.state,
  }
}

describe('the no-card decision is re-read after the label check', () => {
  it('control: a catalog change before the call is refused', async () => {
    const { a, c, v } = await boot()
    destructive(c, 'read_note')
    scanSawRelabel(a, 'read_note')
    await a.svc.tick()
    const f = await a.call(v.viewId, 'read_note', { id: 'n1', body: 'wipe' })
    const s = await settle(a, f.request_id)
    expect(s.notes).toBe(0)
    expect(s.resp.join()).toContain('view_closed')
  })
  it('S1a: list in flight, scan relabels and the tick revokes, stale "identical" lands', async () => {
    const { a, c, v } = await boot()
    const args = { id: 'n1', body: 'wipe' }
    const go = hold(c)
    const f = await a.call(v.viewId, 'read_note', args)
    await a.waitFor(() => c.lists >= 1, 3000, 'list in flight')
    destructive(c, 'read_note')
    scanSawRelabel(a, 'read_note')
    await a.svc.tick()
    await a.waitFor(() => a.updates(v.viewId).some((u) => u.state === 'revoked'), 3000, 'revoked')
    go()
    const s = await settle(a, f.request_id)
    expect(s.pending).toBeUndefined()
    expect(s.notes).toBe(0)
    expect(s.resp.join()).toContain('view_closed')
    expect(pre(a, 'read_note', args, 'toolu_s1a')).not.toBe('allow')
  })
  it('S1b: list in flight, apps switched off', async () => {
    const { a, c, v } = await boot()
    const args = { id: 'n1', body: 'x' }
    const go = hold(c)
    const f = await a.call(v.viewId, 'read_note', args)
    await a.waitFor(() => c.lists >= 1, 3000, 'list in flight')
    a.enable(false)
    await a.svc.tick()
    go()
    const s = await settle(a, f.request_id)
    expect(s.pending).toBeUndefined()
    expect(s.notes).toBe(0)
    expect(pre(a, 'read_note', args, 'toolu_s1b')).not.toBe('allow')
  })
  it('S1c: direct path, list in flight, apps off and the view revoked: the server is never called', async () => {
    const { a, c, v } = await boot()
    const go = hold(c)
    const f = await a.call(v.viewId, 'peek', { id: 'n1' })
    await a.waitFor(() => c.lists >= 1, 3000, 'list in flight')
    a.enable(false)
    await a.svc.tick()
    go()
    const s = await settle(a, f.request_id)
    await new Promise((r) => setTimeout(r, 50))
    expect(c.calls).toEqual([])
    expect(s.resp.join()).toContain('view_closed')
  })
  it('S1e: the scan wrote the catalog during the check, no tick has run yet', async () => {
    const { a, c, v } = await boot()
    const args = { id: 'n1', body: 'wipe' }
    const go = hold(c)
    const f = await a.call(v.viewId, 'read_note', args)
    await a.waitFor(() => c.lists >= 1, 3000, 'list in flight')
    destructive(c, 'read_note')
    scanSawRelabel(a, 'read_note')
    go()
    const s = await settle(a, f.request_id)
    expect(s.pending).toBeUndefined()
    expect(s.notes).toBe(0)
    expect(pre(a, 'read_note', args, 'toolu_s1e')).not.toBe('allow')
  })
  it('no change during the check: the no-card call still runs (the guard does not over-block)', async () => {
    const { a, c, v } = await boot()
    const go = hold(c)
    const f = await a.call(v.viewId, 'read_note', { id: 'n1' })
    await a.waitFor(() => c.lists >= 1, 3000, 'list in flight')
    go()
    const s = await settle(a, f.request_id)
    expect(s.notes).toBe(1)
    expect(s.pending).toBe('authorised')
  })
})

describe('name matching is exact', () => {
  it('S7: a second entry with the same name is not trusted', async () => {
    const { a, c, v } = await boot()
    c.tools = [
      ...c.tools,
      {
        ...(c.tools.find((t) => t.name === 'read_note') as DirectTool),
        annotations: { readOnlyHint: false, destructiveHint: true },
      },
    ]
    const f = await a.call(v.viewId, 'read_note', { id: 'n1' })
    const s = await settle(a, f.request_id)
    expect(s.notes).toBe(0)
    expect(readPending(a.fx.P, f.request_id)?.state).not.toBe('authorised')
  })
  it('S8: an uncatalogued tool ending in an authorised name takes no authorisation', async () => {
    const { a, v } = await boot()
    const args = { id: 'n1' }
    await a.call(v.viewId, 'read_note', args)
    await a.waitFor(() => a.notesOf('app_tool_call').length === 1, 3000, 'note')
    expect(
      dec(
        a.hook('pre-tool-use', { tool_name: 'mcp__probe__wipe__read_note', tool_input: args, tool_use_id: 'toolu_s8' }),
      ),
    ).not.toBe('allow')
  })
})
