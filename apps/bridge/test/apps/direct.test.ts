import { afterEach, describe, expect, it } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { UnauthorizedError } from '@modelcontextprotocol/sdk/client/auth.js'
import { ErrorCode, McpError } from '@modelcontextprotocol/sdk/types.js'
import { fakeClock } from '@talos-app/testkit'
import type { CatalogServerT } from '../../src/apps/catalog.ts'
import {
  DIRECT_CAPABILITIES,
  DirectAuthError,
  type DirectConfigT,
  type DirectConnector,
  DirectManifestChanged,
  DirectNotRunnable,
  DirectPool,
  type DirectSession,
  DirectTimeoutError,
  type DirectTool,
  DirectUnavailableError,
  IDLE_CLOSE_MS,
  LABEL_CHECK_TIMEOUT_MS,
  LIST_CACHE_MS,
  mapDirectError,
  realDirectConnector,
  toCatalogTool,
} from '../../src/apps/direct.ts'
import { serverIdOf } from '../../src/apps/keychain.ts'
import { nullLogger } from '../../src/log.ts'
import { approvedFixture, memSecrets, probeHttp, tmp } from './helpers.ts'

const cleanups: Array<() => Promise<void> | void> = []
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()?.()
})

const HTTP = { type: 'http' as const, config_fingerprint: 'a'.repeat(64), auth: 'static' as const }
// the catalog's view of the probe's app-only tool, as the real probe serves it (no annotations: asks each time)
const REAL_TOOLS = [
  {
    name: 'app_only_refresh',
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
]
async function serverOf(opts: Parameters<typeof approvedFixture>[1] = {}): Promise<CatalogServerT> {
  const fx = await approvedFixture(tmp(), { direct: HTTP, ownerDirect: true, tools: REAL_TOOLS, ...opts })
  return fx.cat.servers[0] as CatalogServerT
}

async function poolWith(
  server: CatalogServerT,
  cfg: DirectConfigT | undefined,
  connector: DirectConnector = realDirectConnector,
) {
  const { secrets, kc } = memSecrets()
  if (cfg) await secrets.saveConfig(serverIdOf(server.server, server.source), cfg)
  const clock = fakeClock()
  const pool = new DirectPool({ connector, secrets, clock, log: nullLogger })
  cleanups.push(() => pool.closeAll())
  return { pool, clock, kc, secrets }
}

describe('against the real probe over HTTP (real MCP SDK client, real peer output)', () => {
  it("connects lazily, mirrors Claude Code's capabilities (no UI extension), lists tools in catalog shape, calls an app-only tool", async () => {
    const dir = tmp()
    const log = join(dir, 'probe.jsonl')
    const probe = await probeHttp({ PROBE_LOG: log })
    cleanups.push(() => void probe.kill())
    const server = await serverOf({})
    const { pool } = await poolWith(server, { type: 'http', url: probe.url })
    expect(pool.openCount).toBe(0) // lazy: nothing connected yet
    const tools = await pool.tools(server)
    expect(pool.openCount).toBe(1)
    const refresh = tools.find((t) => t.name === 'app_only_refresh')
    expect(refresh).toMatchObject({
      visibility: ['app'],
      resource_uri: 'ui://probe/view.html',
      read_only: false,
      destructive: true,
    })
    expect(tools.find((t) => t.name === 'read_note')).toMatchObject({ read_only: true, destructive: false })
    const res = await pool.callTool(server, 'app_only_refresh', {})
    expect(res.structuredContent).toEqual({ tool: 'app_only_refresh', ok: true })
    const init = readFileSync(log, 'utf8')
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l))
      .find((l) => l.event === 'initialize')
    expect(init.clientInfo.name).toBe('talos-app')
    expect(init.capabilities.extensions['io.modelcontextprotocol/ui']).toBeUndefined()
    expect(init.capabilities.extensions).toEqual(DIRECT_CAPABILITIES.extensions)
  })
  it('a static bearer header from the stored config is sent; a wrong one is direct_auth; a missing item is direct_auth', async () => {
    const probe = await probeHttp({ PROBE_BEARER: 'good-token-1234' })
    cleanups.push(() => void probe.kill())
    const server = await serverOf({})
    const ok = await poolWith(server, {
      type: 'http',
      url: probe.url,
      headers: { Authorization: 'Bearer good-token-1234' },
    })
    expect((await ok.pool.tools(server)).length).toBeGreaterThan(3)
    const bad = await poolWith(server, { type: 'http', url: probe.url, headers: { Authorization: 'Bearer nope' } })
    await expect(bad.pool.tools(server)).rejects.toBeInstanceOf(DirectAuthError)
    const none = await poolWith(server, { type: 'http', url: probe.url })
    await expect(none.pool.tools(server)).rejects.toBeInstanceOf(DirectAuthError)
    const missing = await poolWith(server, undefined)
    await expect(missing.pool.tools(server)).rejects.toBeInstanceOf(DirectAuthError)
    const locked = await poolWith(server, { type: 'http', url: probe.url })
    locked.kc.failWith = new Error('locked')
    await expect(locked.pool.tools(server)).rejects.toBeInstanceOf(DirectAuthError)
  })
  it('the probe dies under a call: direct_unavailable, and the next call reconnects once it is back', async () => {
    const first = await probeHttp()
    const server = await serverOf({})
    const { pool } = await poolWith(server, { type: 'http', url: first.url })
    await pool.callTool(server, 'app_only_refresh', {})
    first.kill()
    await new Promise((r) => setTimeout(r, 100))
    await expect(pool.callTool(server, 'app_only_refresh', {})).rejects.toBeInstanceOf(DirectUnavailableError)
    expect(pool.openCount).toBe(0)
    const second = await (async () => {
      // same port, new process
      const { spawn } = await import('node:child_process')
      const { PROBE } = await import('./helpers.ts')
      const child = spawn(process.execPath, [PROBE, '--http', String(first.port)], {
        stdio: ['ignore', 'pipe', 'ignore'],
      })
      cleanups.push(() => void child.kill('SIGKILL'))
      await new Promise<void>((resolve) =>
        child.stdout.on('data', (d) => /PROBE_LISTENING/.test(String(d)) && resolve()),
      )
    })()
    void second
    const r = await pool.callTool(server, 'app_only_refresh', {})
    expect(r.structuredContent).toEqual({ tool: 'app_only_refresh', ok: true })
  })
})

// ---- a scripted connector for the rest -------------------------------------------------------------------------------

class Script implements DirectConnector {
  connects = 0
  closes = 0
  listCalls = 0
  toolCalls = 0
  tools: DirectTool[] = [
    {
      name: 'peek',
      annotations: { readOnlyHint: true, destructiveHint: false },
      _meta: { ui: { resourceUri: 'ui://probe/view.html', visibility: ['app'] } },
    },
    {
      name: 'read_note',
      annotations: { readOnlyHint: true, destructiveHint: false },
      _meta: { ui: { resourceUri: 'ui://probe/view.html', visibility: ['model', 'app'] } },
    },
  ]
  hangList = false
  failConnect: Error | undefined
  callError: Error | undefined
  closeHandlers: Array<() => void> = []
  async connect(_c: DirectConfigT): Promise<DirectSession> {
    if (this.failConnect) throw this.failConnect
    this.connects++
    return {
      listTools: async () => {
        this.listCalls++
        if (this.hangList) await new Promise(() => {})
        return this.tools
      },
      callTool: async () => {
        this.toolCalls++
        if (this.callError) throw this.callError
        return { content: [{ type: 'text', text: 'ok' }] }
      },
      close: async () => {
        this.closes++
      },
      onClose: (cb) => {
        this.closeHandlers.push(cb)
      },
    }
  }
}
const CFG: DirectConfigT = { type: 'http', url: 'https://mcp.example.com/mcp' }
const peekServer = (over: Parameters<typeof approvedFixture>[1] = {}) =>
  serverOf({
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
        name: 'read_note',
        resource_uri: 'ui://probe/view.html',
        visibility: ['model', 'app'],
        read_only: true,
        destructive: false,
        open_world: true,
      },
    ],
    ...over,
  })

describe('lifecycle', () => {
  it('reuses the session, closes it after 5 idle minutes, and connects again afterwards', async () => {
    const script = new Script()
    const server = await peekServer()
    const { pool, clock } = await poolWith(server, CFG, script)
    await pool.callTool(server, 'peek', {})
    await pool.callTool(server, 'peek', {})
    expect(script.connects).toBe(1)
    clock.advance(IDLE_CLOSE_MS - 1000)
    expect(pool.openCount).toBe(1)
    clock.advance(1500)
    await new Promise((r) => setTimeout(r, 5))
    expect(pool.openCount).toBe(0)
    expect(script.closes).toBe(1)
    await pool.callTool(server, 'peek', {})
    expect(script.connects).toBe(2)
  })
  it('activity pushes the idle close back', async () => {
    const script = new Script()
    const server = await peekServer()
    const { pool, clock } = await poolWith(server, CFG, script)
    await pool.callTool(server, 'peek', {})
    clock.advance(IDLE_CLOSE_MS - 1000)
    await pool.callTool(server, 'peek', {})
    clock.advance(IDLE_CLOSE_MS - 1000)
    expect(pool.openCount).toBe(1)
    clock.advance(2000)
    await new Promise((r) => setTimeout(r, 5))
    expect(pool.openCount).toBe(0)
  })
  it('two first calls at once share one connect', async () => {
    const script = new Script()
    const server = await peekServer()
    const { pool } = await poolWith(server, CFG, script)
    await Promise.all([
      pool.callTool(server, 'peek', {}),
      pool.callTool(server, 'peek', {}),
      pool.callTool(server, 'peek', {}),
    ])
    expect(script.connects).toBe(1)
  })
  it('at most 3 at once: the oldest idle closes for a 4th', async () => {
    const script = new Script()
    const { secrets } = memSecrets()
    const clock = fakeClock()
    const pool = new DirectPool({ connector: script, secrets, clock, log: nullLogger })
    cleanups.push(() => pool.closeAll())
    const servers: CatalogServerT[] = []
    for (let i = 0; i < 4; i++) {
      const s = { ...(await peekServer()), server: `s${i}` }
      await secrets.saveConfig(serverIdOf(s.server, s.source), CFG)
      servers.push(s)
    }
    for (const s of servers.slice(0, 3)) {
      await pool.tools(s)
      clock.advance(1000)
    }
    expect(pool.openCount).toBe(3)
    await pool.tools(servers[3] as CatalogServerT)
    expect(pool.openCount).toBe(3)
    expect(script.closes).toBe(1)
    // the oldest (s0) is the one that went: using s0 connects again
    const before = script.connects
    await pool.tools(servers[0] as CatalogServerT)
    expect(script.connects).toBe(before + 1)
  })
  it('three drops in five minutes close the server for an hour', async () => {
    const script = new Script()
    const server = await peekServer()
    const { pool, clock } = await poolWith(server, CFG, script)
    for (let i = 0; i < 3; i++) {
      await pool.tools(server)
      script.closeHandlers[script.closeHandlers.length - 1]?.()
      clock.advance(1000)
    }
    await expect(pool.tools(server)).rejects.toBeInstanceOf(DirectUnavailableError)
    clock.advance(3600_000 - 10_000)
    await expect(pool.tools(server)).rejects.toBeInstanceOf(DirectUnavailableError)
    clock.advance(20_000)
    await expect(pool.tools(server)).resolves.toBeDefined()
  })
  it('a failed connect is an error and leaves nothing open', async () => {
    const script = new Script()
    script.failConnect = new DirectUnavailableError('refused')
    const server = await peekServer()
    const { pool } = await poolWith(server, CFG, script)
    await expect(pool.tools(server)).rejects.toBeInstanceOf(DirectUnavailableError)
    expect(pool.openCount).toBe(0)
    expect(pool.noteFailure(server)).toBe(1)
    pool.noteFailure(server)
    expect(pool.noteFailure(server)).toBe(3)
  })
  it("closeServer drops one server's session", async () => {
    const script = new Script()
    const server = await peekServer()
    const { pool } = await poolWith(server, CFG, script)
    await pool.tools(server)
    await pool.closeServer(server)
    expect(pool.openCount).toBe(0)
    expect(script.closes).toBe(1)
  })
})

describe('the manifest and the call-time label check', () => {
  it("every direct call re-lists and refuses when an app-only tool's labels moved (either direction)", async () => {
    const script = new Script()
    const server = await peekServer()
    const { pool } = await poolWith(server, CFG, script)
    await expect(pool.callTool(server, 'peek', {})).resolves.toBeDefined()
    script.tools = [
      { ...(script.tools[0] as DirectTool), annotations: { readOnlyHint: false } },
      script.tools[1] as DirectTool,
    ]
    await expect(pool.callTool(server, 'peek', {})).rejects.toBeInstanceOf(DirectManifestChanged)
    script.tools = [
      {
        ...(script.tools[0] as DirectTool),
        annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
      },
      script.tools[1] as DirectTool,
    ]
    await expect(pool.callTool(server, 'peek', {})).rejects.toBeInstanceOf(DirectManifestChanged)
    script.tools = [script.tools[1] as DirectTool]
    await expect(pool.callTool(server, 'peek', {})).rejects.toBeInstanceOf(DirectManifestChanged)
  })
  it('identical, changed (either direction, or the tool gone), and failed', async () => {
    const script = new Script()
    const server = await peekServer()
    const read = server.tools.find((t) => t.name === 'read_note') as never
    const { pool, clock } = await poolWith(server, CFG, script)
    expect(await pool.labelCheck(server, read)).toBe('identical')
    clock.advance(LIST_CACHE_MS + 1)
    script.tools = script.tools.map((t) =>
      t.name === 'read_note' ? { ...t, annotations: { readOnlyHint: true, destructiveHint: true } } : t,
    )
    expect(await pool.labelCheck(server, read)).toBe('changed')
    clock.advance(LIST_CACHE_MS + 1)
    script.tools = script.tools.filter((t) => t.name !== 'read_note')
    expect(await pool.labelCheck(server, read)).toBe('changed')
  })
  it('the label check always lists fresh (a relabel after the last check is seen); plain tools() keeps its 60 s cache', async () => {
    const script = new Script()
    const server = await peekServer()
    const read = server.tools.find((t) => t.name === 'read_note') as never
    const { pool, clock } = await poolWith(server, CFG, script)
    await pool.labelCheck(server, read)
    await pool.labelCheck(server, read)
    expect(script.listCalls).toBe(2)
    await pool.tools(server)
    await pool.tools(server)
    expect(script.listCalls).toBe(2) // served from the fresh list the last check stored
    clock.advance(LIST_CACHE_MS + 1)
    await pool.tools(server)
    expect(script.listCalls).toBe(3)
    script.tools = script.tools.map((t) =>
      t.name === 'read_note' ? { ...t, annotations: { readOnlyHint: true, destructiveHint: true } } : t,
    )
    expect(await pool.labelCheck(server, read)).toBe('changed') // inside the cache window, still seen
  })
  it('the fresh list inside callTool is bounded by the label-check timeout, and no call is made', async () => {
    const script = new Script()
    const server = await peekServer()
    const read = server.tools.find((t) => t.name === 'read_note') as never
    const h = await poolWith(server, CFG, script)
    await h.pool.labelCheck(server, read) // connect while it answers
    script.hangList = true
    h.clock.advance(LIST_CACHE_MS + 1)
    const p = h.pool.callTool(server, 'peek', {}).then(
      () => 'ran',
      (e) => e,
    )
    await new Promise((r) => setTimeout(r, 5))
    h.clock.advance(LABEL_CHECK_TIMEOUT_MS + 1)
    expect(await p).toBeInstanceOf(DirectTimeoutError)
    expect(script.toolCalls).toBe(0)
  })
  it('the guard runs after the list and right before the call; a false guard means no server call', async () => {
    const script = new Script()
    const server = await peekServer()
    const h = await poolWith(server, CFG, script)
    let asked = 0
    await expect(
      h.pool.callTool(server, 'peek', {}, () => {
        asked++
        return false
      }),
    ).rejects.toBeInstanceOf(DirectNotRunnable)
    expect(asked).toBe(1)
    expect(script.toolCalls).toBe(0)
    await h.pool.callTool(server, 'peek', {}, () => true)
    expect(script.toolCalls).toBe(1)
  })
  it('a check that cannot finish fails (a card), whether the server hangs for 10 s or the Keychain is locked', async () => {
    const script = new Script()
    const server = await peekServer()
    const read = server.tools.find((t) => t.name === 'read_note') as never
    const hung = await poolWith(server, CFG, script)
    await hung.pool.labelCheck(server, read) // connect while it answers
    script.hangList = true
    hung.clock.advance(LIST_CACHE_MS + 1)
    const p = hung.pool.labelCheck(server, read)
    await new Promise((r) => setTimeout(r, 5))
    hung.clock.advance(LABEL_CHECK_TIMEOUT_MS + 1)
    expect(await p).toBe('failed')
    const locked = await poolWith(server, CFG, new Script())
    locked.kc.failWith = new Error('locked')
    expect(await locked.pool.labelCheck(server, read)).toBe('failed')
    const down = new Script()
    down.failConnect = new DirectUnavailableError('down')
    const d = await poolWith(server, CFG, down)
    expect(await d.pool.labelCheck(server, read)).toBe('failed')
  })
})

describe('tools as the catalog stores them (toCatalogTool)', () => {
  it('visibility defaults to model + app; the flat ui/resourceUri works; only ui:// URIs count', () => {
    expect(toCatalogTool({ name: 'a' })).toEqual({
      name: 'a',
      visibility: ['model', 'app'],
      read_only: false,
      destructive: true,
      open_world: true,
    })
    expect(toCatalogTool({ name: 'a', _meta: { 'ui/resourceUri': 'ui://x/y' } }).resource_uri).toBe('ui://x/y')
    expect(toCatalogTool({ name: 'a', _meta: { ui: { resourceUri: 'https://evil/x' } } }).resource_uri).toBeUndefined()
    expect(toCatalogTool({ name: 'a', _meta: { ui: { visibility: ['app', 'bogus'] } } }).visibility).toEqual(['app'])
    expect(toCatalogTool({ name: 'a', _meta: { ui: { visibility: ['bogus'] } } }).visibility).toEqual(['model', 'app'])
  })
  it('errors from the SDK map to the right failure: sign-in, timeout, anything else is unavailable', () => {
    expect(mapDirectError(new UnauthorizedError())).toBeInstanceOf(DirectAuthError)
    expect(mapDirectError(new McpError(ErrorCode.RequestTimeout, 'x'))).toBeInstanceOf(DirectTimeoutError)
    expect(mapDirectError(Object.assign(new Error('x'), { code: 401 }))).toBeInstanceOf(DirectAuthError)
    expect(mapDirectError(Object.assign(new Error('x'), { code: 403 }))).toBeInstanceOf(DirectAuthError)
    expect(mapDirectError(new Error('ECONNREFUSED'))).toBeInstanceOf(DirectUnavailableError)
    expect(mapDirectError(new McpError(ErrorCode.InternalError, 'x'))).toBeInstanceOf(DirectUnavailableError)
  })
})
