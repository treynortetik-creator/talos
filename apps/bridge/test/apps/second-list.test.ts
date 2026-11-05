// S1c: the direct path has a SECOND list (verifyAppOnly inside callTool) after the guard.
import { afterEach, describe, expect, it } from 'bun:test'
import { readCatalog, writeCatalog } from '../../src/apps/catalog.ts'
import type { DirectConfigT, DirectConnector, DirectSession, DirectTool } from '../../src/apps/direct.ts'
import { serverIdOf } from '../../src/apps/keychain.ts'
import { type AppsHarness, mkApps } from './harness.ts'

const live: AppsHarness[] = []
afterEach(async () => {
  while (live.length) await live.pop()?.h.stop()
})
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
  stallAt = 0
  gate: Promise<void> | undefined
  entered = false
  tools: DirectTool[] = TOOLS.map((t) => ({
    name: t.name,
    annotations: t.read_only ? { readOnlyHint: true, destructiveHint: false } : undefined,
    _meta: { ui: { resourceUri: t.resource_uri, visibility: t.visibility } },
  }))
  async connect(_c: DirectConfigT): Promise<DirectSession> {
    return {
      listTools: async () => {
        const n = ++this.lists
        const snap = this.tools
        if (n === this.stallAt && this.gate) {
          this.entered = true
          await this.gate
        }
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
function hold(c: Fake, at: number) {
  let release = () => {}
  c.gate = new Promise<void>((r) => {
    release = r
  })
  c.stallAt = at
  return () => release()
}
function scanSawRelabel(a: AppsHarness, name: string) {
  const r = readCatalog(a.fx.P)
  if (!r.ok || !r.catalog) throw new Error('catalog')
  const cat = structuredClone(r.catalog)
  const s = cat.servers[0] as (typeof cat.servers)[number]
  s.tools = s.tools.map((t) => (t.name === name ? { ...t, read_only: false, destructive: true } : t))
  for (const x of s.resources) x.state = 'needs_reapproval'
  writeCatalog(a.fx.P, cat)
}
describe('second list on the direct path', () => {
  it('D-off: labelCheck list passes the guard, verifyAppOnly list stalls, apps off + revoke, stale answer lands', async () => {
    const { a, c, v } = await boot()
    const base = c.lists
    const go = hold(c, base + 2)
    const f = await a.call(v.viewId, 'peek', { id: 'n1' })
    await a.waitFor(() => c.entered, 3000, 'second list in flight')
    a.enable(false)
    await a.svc.tick()
    await a.waitFor(
      () => a.updates(v.viewId).some((u) => u.state === 'revoked' || u.state === 'closed'),
      3000,
      'revoked',
    )
    go()
    await a.h.bridge.inbound?.appsIdle()
    await a.waitFor(
      () => a.responses(f.request_id).some((x) => x.error?.code === 'view_closed'),
      4000,
      'view_closed answer',
    )
    expect(a.responses(f.request_id).some((x) => x.error?.code === 'view_closed')).toBe(true)
    expect(c.calls).toEqual([])
  })
  it('D-scan: same, scan relabel + tick revokes', async () => {
    const { a, c, v } = await boot()
    const base = c.lists
    const go = hold(c, base + 2)
    await a.call(v.viewId, 'peek', { id: 'n1' })
    await a.waitFor(() => c.entered, 3000, 'second list in flight')
    scanSawRelabel(a, 'peek')
    await a.svc.tick()
    await a.waitFor(() => a.updates(v.viewId).some((u) => u.state === 'revoked'), 3000, 'revoked')
    go()
    await a.h.bridge.inbound?.appsIdle()
    await new Promise((r) => setTimeout(r, 80))
    expect(c.calls).toEqual([])
  })
  it('control: stall on first list is refused', async () => {
    const { a, c, v } = await boot()
    const go = hold(c, c.lists + 1)
    await a.call(v.viewId, 'peek', { id: 'n1' })
    await a.waitFor(() => c.entered, 3000, 'first list in flight')
    a.enable(false)
    await a.svc.tick()
    go()
    await a.h.bridge.inbound?.appsIdle()
    await new Promise((r) => setTimeout(r, 80))
    expect(c.calls).toEqual([])
  })
  it('no change: second-list stall released, call runs (test shape is sound)', async () => {
    const { a, c, v } = await boot()
    const go = hold(c, c.lists + 2)
    await a.call(v.viewId, 'peek', { id: 'n1' })
    await a.waitFor(() => c.entered, 3000, 'second list in flight')
    go()
    await a.waitFor(() => c.calls.length === 1, 3000, 'ran')
    expect(c.calls).toEqual(['peek'])
  })
})
