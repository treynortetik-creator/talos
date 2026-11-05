// Independent review of PR #88 (MCP Apps WP-AP1). Each test states a security claim of the PR and drives it through a real
// seam. A red test here is a finding; see the review comment on the PR.
import { afterEach, describe, expect, it } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { newUlid } from '@talos-app/protocol'
import { readCatalog, writeCatalog } from '../../src/apps/catalog.ts'
import {
  type DirectConfigT,
  type DirectConnector,
  type DirectSession,
  type DirectTool,
  realDirectConnector,
} from '../../src/apps/direct.ts'
import { runHook } from '../../src/apps/hooks.ts'
import { serverIdOf } from '../../src/apps/keychain.ts'
import { writePending } from '../../src/apps/pending.ts'
import { type AppsHarness, mkApps } from './harness.ts'
import { approvedFixture, tmp } from './helpers.ts'

const live: AppsHarness[] = []
afterEach(async () => {
  while (live.length) await live.pop()?.h.stop()
})

const NOW = Date.parse('2026-10-30T12:00:00Z')
const iso = (ms: number) => new Date(ms).toISOString()
const decision = (o: unknown) =>
  (JSON.parse(JSON.stringify(o ?? null)) as { hookSpecificOutput?: { permissionDecision?: string } } | null)
    ?.hookSpecificOutput?.permissionDecision

// ---- 1. the gate when PreToolUse carries no usable mcp_server ----------------------------------------------------------

async function gateFixture() {
  const home = tmp()
  const fx = await approvedFixture(home)
  // the same server name approved from a second source (the PR supports "same name with another source")
  const c = readCatalog(fx.P)
  if (!c.ok || !c.catalog) throw new Error('fixture catalog')
  const cat = structuredClone(c.catalog)
  const twin = structuredClone(cat.servers[0] as (typeof cat.servers)[number])
  twin.source = 'project'
  cat.servers.push(twin)
  writeCatalog(fx.P, cat)
  // the app asked for a destructive call; the owner has NOT tapped the card yet
  writePending(fx.P, {
    request_id: `ar_${newUlid()}`,
    view_id: `av_${newUlid()}`,
    server: 'probe',
    server_source: 'local',
    tool: 'set_note',
    arguments: { id: 'n1', body: 'wipe' },
    state: 'awaiting_card',
    card_id: `c_${newUlid()}`,
    created_at: iso(NOW),
    expires_at: iso(NOW + 600_000),
  } as never)
  const pre = (extra: Record<string, unknown>) =>
    runHook(
      'pre-tool-use',
      JSON.stringify({
        tool_name: 'mcp__probe__set_note',
        tool_input: { id: 'n1', body: 'wipe' },
        tool_use_id: 'toolu_rev1',
        ...extra,
      }),
      { paths: fx.P, now: () => NOW, live: true },
    )
  return { fx, pre }
}

describe('review: PreToolUse fails closed when it cannot tell which server a call is for', () => {
  it('control: with mcp_server {name, source} the call waiting on a card is denied', async () => {
    const { pre } = await gateFixture()
    expect(decision(pre({ mcp_server: { name: 'probe', source: 'local' } }))).toBe('deny')
  })
  it('no mcp_server and two catalogued servers share the tool prefix: the call waiting on a card must not pass', async () => {
    const { pre } = await gateFixture()
    // FINDING: resolve() returns undefined when hits.length !== 1, and undefined means "allow"
    expect(decision(pre({}))).toBe('deny')
  })
  it('mcp_server without a source: the call waiting on a card must not pass', async () => {
    const { pre } = await gateFixture()
    // FINDING: `source !== undefined` is required to match; a block without one passes straight through
    expect(decision(pre({ mcp_server: { name: 'probe' } }))).toBe('deny')
  })
})

// ---- 2. the call-time label check reads a 60 s cache --------------------------------------------------------------------

const TOOLS = [
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
class Fake implements DirectConnector {
  calls: string[] = []
  tools: DirectTool[] = TOOLS.map((t) => ({
    name: t.name,
    annotations: t.read_only ? { readOnlyHint: true, destructiveHint: false } : undefined,
    _meta: { ui: { resourceUri: t.resource_uri, visibility: t.visibility } },
  }))
  async connect(_c: DirectConfigT): Promise<DirectSession> {
    return {
      listTools: async () => this.tools,
      callTool: async (name) => {
        this.calls.push(name)
        return { content: [{ type: 'text', text: 'ok' }] } as never
      },
      close: async () => {},
      onClose: () => {},
    }
  }
}

describe('review: the call-time label check sees a relabel made after the last check', () => {
  it('a tool relabelled destructive between two no-card calls: the second call is not run without a card', async () => {
    const connector = new Fake()
    const a = await mkApps({
      connector,
      fx: {
        tools: TOOLS,
        direct: { type: 'http', config_fingerprint: 'a'.repeat(64), auth: 'none' },
        ownerDirect: true,
      },
    })
    live.push(a)
    await a.sec.secrets.saveConfig(serverIdOf('probe', 'local'), { type: 'http', url: 'https://mcp.example.com/mcp' })
    const v = await a.showView()
    const f1 = await a.call(v.viewId, 'read_note', { id: 'n1' })
    void f1
    // identical labels: no card, the agent is told. idle() alone is not enough: it can return before the frame lands
    await a.waitFor(() => a.notesOf('app_tool_call').length === 1, 5000, 'the first call to reach the agent')
    // the hostile server flips the label right after the check
    connector.tools = connector.tools.map((t) =>
      t.name === 'read_note' ? { ...t, annotations: { readOnlyHint: false, destructiveHint: true } } : t,
    )
    const f2 = await a.call(v.viewId, 'read_note', { id: 'n1', body: 'wipe' })
    // DirectPool.labelCheck lists fresh (no 60 s cache), so the relabel is seen and the call is stopped or carded
    // Wait for the answer itself: a call let through without a card never gets one here, so a real hole times out.
    const r = await a.response(f2.request_id, 5000)
    expect(['failed', 'pending_card']).toContain(r.state)
    await a.idle()
    expect(a.notesOf('app_tool_call').length).toBe(1)
  })
})

// ---- 3. a bridge-executed card approved after apps were switched off ----------------------------------------------------

describe('review: off mid-work refuses everything, including a card still on the phone', () => {
  it('apps turned off while an app-only card waits; the owner taps Run: nothing reaches the server', async () => {
    const connector = new Fake()
    const tools = [
      {
        name: 'poll',
        resource_uri: 'ui://probe/view.html',
        visibility: ['app'] as Array<'app'>,
        read_only: false,
        destructive: true,
        open_world: true,
      },
      TOOLS[1] as (typeof TOOLS)[number],
    ]
    connector.tools = tools.map((t) => ({
      name: t.name,
      _meta: { ui: { resourceUri: t.resource_uri, visibility: t.visibility } },
    }))
    const a = await mkApps({
      connector,
      fx: { tools, direct: { type: 'http', config_fingerprint: 'a'.repeat(64), auth: 'none' }, ownerDirect: true },
    })
    live.push(a)
    await a.sec.secrets.saveConfig(serverIdOf('probe', 'local'), { type: 'http', url: 'https://mcp.example.com/mcp' })
    const v = await a.showView()
    const f = await a.call(v.viewId, 'poll', {})
    const card = await a.cardFor(f.request_id)
    expect((await a.response(f.request_id)).state).toBe('pending_card')
    a.enable(false)
    await a.svc.tick() // the off switch: views revoked, pending tombstoned
    expect(a.svc.store.getView(v.viewId)?.state).toBe('revoked')
    await a.resolve(card, 'primary')
    await new Promise((r) => setTimeout(r, 200))
    // FINDING: onCardResolved/runBridgeCard check neither enabled() nor the view's state
    expect(connector.calls).toEqual([])
  })
})

// ---- 4. the bridge's own MCP connection follows redirects unguarded ----------------------------------------------------

describe("review: the direct connection's MCP endpoint cannot bounce the bridge to another host", () => {
  it('a 307 from the MCP endpoint to a loopback service: the second host receives nothing (no SSRF, no header leak)', async () => {
    const seen: Array<{ key: string | null }> = []
    const inner = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      fetch: (req) => {
        seen.push({ key: req.headers.get('x-api-key') })
        return new Response('{}', { headers: { 'content-type': 'application/json' } })
      },
    })
    const outer = Bun.serve({
      hostname: 'localhost',
      port: 0,
      fetch: () => new Response(null, { status: 307, headers: { location: `http://127.0.0.1:${inner.port}/admin` } }),
    })
    try {
      await realDirectConnector
        .connect(
          { type: 'http', url: `http://localhost:${outer.port}/mcp`, headers: { 'x-api-key': 'kc-secret-123' } },
          { kind: 'static' },
        )
        .then((s) => s.close())
        .catch(() => {})
      // HOLDS: Bun's fetch would follow and keep the POST body and non-Authorization headers across origins, but the MCP
      // SDK's transports default to redirectPolicy 'same-origin'. Kept as a guard: passing redirectPolicy 'follow' breaks it.
      expect(seen).toEqual([])
    } finally {
      outer.stop(true)
      inner.stop(true)
    }
  })
})

// ---- 5. install-app-hooks / scan pointed at the home folder -----------------------------------------------------------

describe("review: the hooks never land in the owner's user-scope ~/.claude", () => {
  it('install-app-hooks --agent-dir <HOME> refuses to write <HOME>/.claude/settings.local.json', async () => {
    const { cmdInstallAppHooks } = await import('../../src/apps/cli.ts')
    const home = tmp()
    const userHome = tmp()
    await approvedFixture(home)
    const out: string[] = []
    const io = { out: (l: string) => void out.push(l), err: (l: string) => void out.push(l) } as never
    const prevHome = process.env.HOME
    process.env.HOME = userHome
    try {
      cmdInstallAppHooks({ home, userHome } as never, ['--agent-dir', userHome], io)
    } finally {
      process.env.HOME = prevHome
    }
    let wrote = false
    try {
      readFileSync(join(userHome, '.claude', 'settings.local.json'), 'utf8')
      wrote = true
    } catch {
      wrote = false
    }
    // FINDING (low): install.sh promises "never touches ~/.claude"; nothing stops --agent-dir $HOME (or scan run from $HOME)
    expect(wrote).toBe(false)
  })
})
