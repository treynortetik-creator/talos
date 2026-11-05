// The two REAL reference servers (npm @modelcontextprotocol/server-basic-vanillajs and server-system-monitor, 2.0.3, built on MCP SDK v2)
// driven by this repo's pinned MCP SDK 1.32.2 client: what Claude Code would list, the real views through the static check,
// the system monitor's HTTP mode, and the direct path against it.
import { afterEach, describe, expect, it } from 'bun:test'
import { type ChildProcess, spawn } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { join } from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { AppCsp, buildAppCsp, fromSpecCsp } from '@talos-app/protocol'
import { fakeClock } from '@talos-app/testkit'
import { normaliseAnnotations, runsWithoutTap } from '../../src/apps/catalog.ts'
import { DirectPool, realDirectConnector, toCatalogTool } from '../../src/apps/direct.ts'
import { checkHtml } from '../../src/apps/html-check.ts'
import { serverIdOf } from '../../src/apps/keychain.ts'
import { appPaths } from '../../src/apps/paths.ts'
import { runScan } from '../../src/apps/scan.ts'
import { nullLogger } from '../../src/log.ts'
import { type AppsHarness, mkApps, THREAD } from './harness.ts'
import { memSecrets, ScriptedSource, scriptedIO, sdkToolOf, tmp } from './helpers.ts'

const dist = (pkg: string) =>
  join(import.meta.dir, '..', '..', '..', '..', 'e2e', 'node_modules', pkg, 'dist', 'index.js')
const BASIC = dist('@modelcontextprotocol/server-basic-vanillajs')
const MONITOR = dist('@modelcontextprotocol/server-system-monitor')

const cleanups: Array<() => Promise<void> | void> = []
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()?.()
})
const live: AppsHarness[] = []
afterEach(async () => {
  while (live.length) await live.pop()?.h.stop()
})

async function stdio(script: string) {
  const t = new StdioClientTransport({
    command: process.execPath,
    args: [script, '--stdio'],
    env: { PATH: process.env.PATH ?? '' },
    stderr: 'pipe',
  })
  const c = new Client({ name: 'apps-ref', version: '1' }, { capabilities: {} })
  await c.connect(t)
  cleanups.push(() => c.close())
  return c
}
const freePort = () =>
  new Promise<number>((resolve, reject) => {
    const s = createServer()
    s.listen(0, '127.0.0.1', () => {
      const p = (s.address() as { port: number }).port
      s.close(() => resolve(p))
    })
    s.on('error', reject)
  })
async function monitorHttp() {
  const port = await freePort()
  const child: ChildProcess = spawn(process.execPath, [MONITOR], {
    env: { PATH: process.env.PATH ?? '', PORT: String(port) },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  cleanups.push(() => void child.kill('SIGKILL'))
  await new Promise<void>((resolve, reject) => {
    child.stdout?.on('data', (d) => /listening on/.test(String(d)) && resolve())
    child.on('exit', () => reject(new Error('monitor exited')))
  })
  return { port, url: `http://127.0.0.1:${port}/mcp` }
}

const uiOf = (t: { _meta?: unknown }) =>
  (t._meta as { ui?: { resourceUri?: string; visibility?: string[] } } | undefined)?.ui

describe('server-basic-vanillajs (stdio)', () => {
  it('get-time declares a view and no annotations, so it is never auto-run', async () => {
    const c = await stdio(BASIC)
    const tools = (await c.listTools()).tools
    const t = tools.find((x) => x.name === 'get-time')
    const ui = (t?._meta as { ui?: { resourceUri?: string; visibility?: string[] } } | undefined)?.ui
    expect(ui?.resourceUri).toMatch(/^ui:\/\//)
    expect(t?.annotations).toBeUndefined()
    expect(runsWithoutTap(normaliseAnnotations(t?.annotations))).toBe(false)
    expect(toCatalogTool({ name: t?.name ?? '', annotations: t?.annotations, _meta: t?._meta as never })).toMatchObject(
      { visibility: ['model', 'app'], read_only: false, destructive: true },
    )
  })
  it('its real view passes the static check although the bundle contains the string "javascript:"; the CSP it declares is accepted', async () => {
    const c = await stdio(BASIC)
    const t = (await c.listTools()).tools.find((x) => x.name === 'get-time')
    const uri = uiOf(t as never)?.resourceUri as string
    const res = await c.readResource({ uri })
    const item = res.contents[0] as { mimeType?: string; text?: string; _meta?: { ui?: { csp?: unknown } } }
    expect(item.mimeType).toBe('text/html;profile=mcp-app')
    const html = item.text ?? ''
    expect(html).toContain('javascript:') // inside script text, never in a URL attribute
    const spec = fromSpecCsp(item._meta?.ui?.csp)
    expect(spec.problems).toEqual([])
    const checked = await checkHtml(html, spec.csp)
    expect(checked.ok).toBe(true)
    if (checked.ok) {
      expect(checked.script_hashes.length).toBeGreaterThanOrEqual(1)
      const csp = AppCsp.parse({
        ...spec.csp,
        script_hashes: checked.script_hashes,
        script_urls: checked.script_urls,
        style_urls: checked.style_urls,
      })
      expect(buildAppCsp(csp)).not.toMatch(/script-src[^;]*'unsafe-inline'/)
    }
  })
})

describe('server-system-monitor', () => {
  it('stdio: get-system-info shows the view; poll-system-stats is app-only with no annotations', async () => {
    const c = await stdio(MONITOR)
    const tools = (await c.listTools()).tools
    const info = tools.find((t) => t.name === 'get-system-info')
    const poll = tools.find((t) => t.name === 'poll-system-stats')
    expect(uiOf(info as never)?.resourceUri).toBe('ui://system-monitor/mcp-app.html')
    expect(uiOf(poll as never)?.visibility).toEqual(['app'])
    expect(poll?.annotations).toBeUndefined()
    expect(
      toCatalogTool({ name: 'poll-system-stats', annotations: poll?.annotations, _meta: poll?._meta as never }),
    ).toMatchObject({ visibility: ['app'], read_only: false, destructive: true })
  })
  it('its 400 KB view is one inline script, no remote URLs, no inline handlers: the static check accepts it', async () => {
    const c = await stdio(MONITOR)
    const res = await c.readResource({ uri: 'ui://system-monitor/mcp-app.html' })
    const item = res.contents[0] as { text?: string; _meta?: { ui?: { csp?: unknown } } }
    const html = item.text ?? ''
    expect(html.length).toBeGreaterThan(300_000)
    const spec = fromSpecCsp(item._meta?.ui?.csp)
    const checked = await checkHtml(html, spec.csp)
    expect(checked.ok).toBe(true)
    if (checked.ok) {
      expect(checked.script_hashes.length).toBe(1)
      expect(checked.script_urls).toEqual([])
    }
  })
  it('HTTP mode, recorded: no --stdio flag; Streamable HTTP at /mcp on PORT (default 3001), stateless; the 1.32.2 client talks to it', async () => {
    const m = await monitorHttp()
    const c = new Client({ name: 'apps-ref-http', version: '1' }, { capabilities: {} })
    await c.connect(new StreamableHTTPClientTransport(new URL(m.url)))
    cleanups.push(() => c.close())
    const tools = (await c.listTools()).tools
    expect(tools.map((t) => t.name).sort()).toEqual(['get-system-info', 'poll-system-stats'])
    const r = (await c.callTool({ name: 'poll-system-stats', arguments: {} })) as {
      structuredContent?: Record<string, unknown>
      content: unknown[]
    }
    expect(r.structuredContent ?? r.content).toBeDefined()
    // the HTTP endpoint is /mcp and nothing else answers
    expect((await fetch(`http://127.0.0.1:${m.port}/other`)).status).toBe(404)
  })
  it("the bridge's direct path against the real HTTP server: tools, an app-only call, and the manifest check", async () => {
    const m = await monitorHttp()
    const probe = await (async () => {
      const c = new Client({ name: 'x', version: '1' }, { capabilities: {} })
      await c.connect(new StreamableHTTPClientTransport(new URL(m.url)))
      const tools = (await c.listTools()).tools.map((t) =>
        toCatalogTool({ name: t.name, annotations: t.annotations, _meta: t._meta as never }),
      )
      await c.close()
      return tools
    })()
    const { secrets } = memSecrets()
    const server = {
      server: 'sysmon',
      source: 'local',
      tool_prefix: 'mcp__sysmon__',
      direct: { type: 'http' as const, auth: 'none' as const },
      tools: probe,
      resources: [],
    }
    await secrets.saveConfig(serverIdOf('sysmon', 'local'), { type: 'http', url: m.url })
    const pool = new DirectPool({ connector: realDirectConnector, secrets, clock: fakeClock(), log: nullLogger })
    cleanups.push(() => pool.closeAll())
    const res = await pool.callTool(server as never, 'poll-system-stats', {})
    expect(res.structuredContent ?? res.content).toBeDefined()
  })
})

describe("E15 at the bridge: the real system monitor over HTTP, a card, the bridge's own session, no agent", () => {
  it("scan with the real servers' output, show the view, tap Start (poll-system-stats) -> card executor bridge -> real call -> the stats reach the app only", async () => {
    const m = await monitorHttp()
    const c = await stdio(MONITOR)
    const tools = (await c.listTools()).tools
    const res = await c.readResource({ uri: 'ui://system-monitor/mcp-app.html' })
    const info = await c.callTool({ name: 'get-system-info', arguments: {} })
    const home = tmp('home-')
    const a = await mkApps({})
    live.push(a)
    const home2 = a.h.home
    void home
    const secrets = a.sec.secrets
    const src = new ScriptedSource(
      '2.1.312',
      [
        {
          name: 'sysmon',
          status: 'connected',
          source: 'local',
          config: { type: 'http', url: m.url },
          tools: tools.map((t) => sdkToolOf(t as never)) as never,
        },
      ],
      { 'sysmon:ui://system-monitor/mcp-app.html': res.contents as never },
    )
    const t = scriptedIO({ ask: [true], text: ['System monitor', 'auto'] })
    const agentDir = tmp('agent-')
    await runScan({
      paths: appPaths(home2),
      source: src,
      io: t.io,
      now: () => Date.now(),
      sleep: async () => {},
      secrets,
      connector: realDirectConnector,
      relayUrl: undefined,
      agentDir,
      bridgeDir: '/x',
      liveVersion: undefined,
      check: false,
      agentNames: [],
    })
    const text = t.text()
    expect(text).toContain('poll-system-stats  [app only]  asks you each time')
    expect(text).toContain("Talos keeps a copy of this server's settings")
    // show: the agent called get-system-info (stdio, its own copy); the hook captured it
    const out = a.hook('post-tool-use', {
      mcp_server: { name: 'sysmon', source: 'local' },
      tool_name: 'mcp__sysmon__get-system-info',
      tool_input: {},
      tool_use_id: 'toolu_info',
      tool_response: JSON.stringify(info.structuredContent ?? { ok: true }),
    })
    expect(JSON.stringify(out)).toContain('call app_show')
    const shown = await a.h.bridge.callTool('app_show', { thread_id: THREAD, capture_id: 'toolu_info' })
    const viewId = /view (av_\S+)\)/.exec(shown.content[0]?.text ?? '')?.[1] as string
    expect(viewId).toBeDefined()
    // Start: poll-system-stats is app-only with no annotations -> a card with executor 'bridge'
    const f = await a.call(viewId, 'poll-system-stats', {})
    const card = await a.cardFor(f.request_id)
    expect(card.payload).toMatchObject({ executor: 'bridge', tool: 'poll-system-stats' })
    const notesBefore = a.h.notes.length
    await a.resolve(card, 'primary')
    const r = await a.response(f.request_id, { final: true })
    expect(r.state).toBe('done')
    expect(r.result).toBeDefined()
    expect(a.h.notes.length).toBe(notesBefore) // zero notifications for the agent
    expect(readFileSync(appPaths(home2).catalog, 'utf8')).not.toContain(m.url.replace('/mcp', '')) // the URL is a Keychain secret, not a catalog field
  }, 60_000)
})
