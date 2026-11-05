import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { readCatalog } from '../../src/apps/catalog.ts'
import { DirectAuthError, type DirectConnector, type DirectSession, type DirectTool } from '../../src/apps/direct.ts'
import { type ServerSecrets, serverIdOf } from '../../src/apps/keychain.ts'
import { appPaths } from '../../src/apps/paths.ts'
import { type RawContent, type RawServer, runScan, type ScanDeps, ScanStop } from '../../src/apps/scan.ts'
import {
  httpConfig,
  type MemoryKeychain,
  memSecrets,
  readProbe,
  ScriptedSource,
  scriptedIO,
  stdioConfig,
  tmp,
} from './helpers.ts'

const URI = 'ui://probe/view.html'
const fakeHome = tmp('empty-home-')
const realHome = process.env.HOME
beforeAll(() => {
  process.env.HOME = fakeHome
})
afterAll(() => {
  process.env.HOME = realHome
})

class SpyConnector implements DirectConnector {
  connects: unknown[] = []
  constructor(
    private readonly tools: DirectTool[] = [],
    private readonly failure?: Error,
  ) {}
  async connect(cfg: unknown): Promise<DirectSession> {
    this.connects.push(cfg)
    if (this.failure) throw this.failure
    const tools = this.tools
    return {
      listTools: async () => tools,
      callTool: async () => ({ content: [] }),
      close: async () => {},
      onClose: () => {},
    }
  }
}

const mcpTools = (r: Awaited<ReturnType<typeof readProbe>>): DirectTool[] =>
  // the raw MCP view of the same tools: hints in MCP names (what a direct connection sees)
  r.tools.map((t) => ({
    name: t.name,
    _meta: t._meta,
    annotations: t.annotations
      ? {
          readOnlyHint: (t.annotations as { readOnly?: boolean }).readOnly,
          destructiveHint: (t.annotations as { destructive?: boolean }).destructive === true,
        }
      : undefined,
  }))

async function mk(opts: {
  env?: Record<string, string>
  server?: Partial<RawServer>
  version?: string | undefined
  answers?: Parameters<typeof scriptedIO>[0]
  contents?: RawContent[]
  home?: string
  connector?: DirectConnector
  relayUrl?: string
  secrets?: { kc: MemoryKeychain; secrets: ServerSecrets }
  liveVersion?: string
  check?: boolean
  extraServers?: RawServer[]
  onStatus?: (n: number) => void
  readError?: Error
}) {
  const probe = await readProbe(opts.env ?? {})
  const home = opts.home ?? tmp('home-')
  const agentDir = tmp('agent-')
  const server: RawServer = {
    name: 'probe',
    status: 'connected',
    source: 'local',
    config: stdioConfig(),
    tools: probe.tools as never,
    ...opts.server,
  }
  const src = new ScriptedSource(
    'version' in opts ? opts.version : '2.1.312',
    [server, ...(opts.extraServers ?? [])],
    { [`probe:${URI}`]: opts.contents ?? probe.contents },
    opts.onStatus,
    opts.readError,
  )
  const sec = opts.secrets ?? memSecrets()
  const t = scriptedIO(opts.answers)
  const connector = opts.connector ?? new SpyConnector([], new Error('a stdio server must never be connected to'))
  let clock = Date.parse('2026-10-30T12:00:00Z')
  const deps: ScanDeps = {
    paths: appPaths(home),
    source: src,
    io: t.io,
    now: () => clock,
    sleep: async (ms) => {
      clock += ms
    },
    secrets: sec.secrets,
    connector,
    relayUrl: opts.relayUrl ?? 'https://relay.example.com',
    agentDir,
    bridgeDir: '/repo/apps/bridge',
    liveVersion: opts.liveVersion,
    check: opts.check ?? false,
    agentNames: ['Ada'],
  }
  return { deps, src, t, home, agentDir, sec, connector, probe, run: () => runScan(deps), P: appPaths(home) }
}

const allFiles = (dir: string): string[] => {
  const out: string[] = []
  const walk = (d: string) => {
    for (const n of readdirSync(d)) {
      const p = join(d, n)
      if (statSync(p).isDirectory()) walk(p)
      else out.push(p)
    }
  }
  walk(dir)
  return out
}

describe('approval and the catalog', () => {
  it('without a y the app is declined: no hooks, no pinned file, nothing runs', async () => {
    const m = await mk({ answers: { ask: [false] } })
    const r = await m.run()
    const res = r.catalog?.servers[0]?.resources[0]
    expect(res?.state).toBe('declined')
    expect(existsSync(join(m.agentDir, '.claude', 'settings.local.json'))).toBe(false)
    expect(readdirSync(m.P.resources)).toEqual([])
    expect(m.t.asked).toEqual(['Approve this app? y/N'])
    expect(m.src.modelTurns).toBe(0)
    expect(m.src.closed).toBe(true)
  })
  it('with y: one approval, a label and a show choice; catalog, pinned HTML (0600), hooks and scan.log written', async () => {
    const m = await mk({ answers: { ask: [true], text: ['Notes board', 'ask'] } })
    const r = await m.run()
    const c = r.catalog
    const s = c?.servers[0]
    const res = s?.resources[0]
    expect(res?.state).toBe('approved')
    expect(res?.owner).toEqual({ label: 'Notes board', show: 'ask', direct: false })
    expect(c?.claude_code_version).toBe('2.1.312')
    expect(c?.rev).toBe(1)
    expect(s?.tool_prefix).toBe('mcp__probe__')
    expect(s?.tools.map((t) => t.name).sort()).toEqual([
      'app_only_refresh',
      'big',
      'forged_oversize',
      'model_only',
      'read_note',
      'set_note',
      'show_widget',
    ])
    expect(readCatalog(m.P).ok).toBe(true)
    const pinned = join(m.P.resources, `${res?.html_sha256}.html`)
    expect(statSync(pinned).mode & 0o777).toBe(0o600)
    expect(statSync(m.P.catalog).mode & 0o777).toBe(0o600)
    const settings = JSON.parse(readFileSync(join(m.agentDir, '.claude', 'settings.local.json'), 'utf8'))
    expect(settings.hooks.PreToolUse[0].matcher).toBe('^mcp__probe__.*')
    expect(settings.hooks.PreToolUse[0].hooks[0].onFailure).toBe('block')
    expect(settings.hooks.PreToolUse[0].hooks[0].command).toBe(
      'bun run --cwd /repo/apps/bridge --silent cli hook pre-tool-use',
    )
    expect(existsSync(m.P.scanLog)).toBe(true)
    expect(m.t.text()).toContain('Every MCP server in this folder starts once')
  })
  it('the screen lists every tool with its run rule and asks exactly one y/N (no per-tool question)', async () => {
    const m = await mk({ answers: { ask: [true] } })
    await m.run()
    const text = m.t.text()
    expect(text).toContain('read_note  [agent + app]  runs without a tap (server says read-only)')
    expect(text).toContain('set_note  [agent + app]  asks you each time')
    expect(text).toContain('show_widget  [agent + app]  asks you each time')
    expect(text).toContain('app_only_refresh  [app only]  asks you each time')
    expect(text).toContain('model_only  [agent only]  asks you each time')
    expect(text).toContain('whenever its buttons ask. The server decides those labels')
    expect(m.t.asked.length).toBe(1)
    expect(m.t.texts.length).toBe(2) // label and show
    expect(text).toContain('may connect to: https://api.example.com')
  })
  it('a rescan with nothing changed keeps the decision and the owner choices without asking again', async () => {
    const first = await mk({ answers: { ask: [true], text: ['Notes board', 'ask'] } })
    await first.run()
    const again = await mk({ home: first.home, secrets: first.sec, answers: { ask: [] } })
    const r = await again.run()
    expect(again.t.asked).toEqual([])
    expect(r.catalog?.servers[0]?.resources[0]?.owner).toEqual({ label: 'Notes board', show: 'ask', direct: false })
    expect(r.catalog?.rev).toBe(2)
  })
  it('a changed CSP (same HTML) asks again, with the diff', async () => {
    const first = await mk({ answers: { ask: [true] } })
    await first.run()
    const drift = await mk({
      home: first.home,
      secrets: first.sec,
      env: { PROBE_GEN: '1', PROBE_DRIFT: 'csp' },
      answers: { ask: [false] },
    })
    const r = await drift.run()
    expect(drift.t.asked.length).toBe(1)
    expect(drift.t.text()).toContain('Changed since you last approved it:')
    expect(drift.t.text()).toContain('now may also connect to: https://api2.example.com')
    expect(r.catalog?.servers[0]?.resources[0]?.state).toBe('declined') // the new key was declined
  })
  it('changed HTML asks again and says so', async () => {
    const first = await mk({ answers: { ask: [true] } })
    await first.run()
    const drift = await mk({
      home: first.home,
      secrets: first.sec,
      env: { PROBE_GEN: '1', PROBE_DRIFT: 'html' },
      answers: { ask: [true] },
    })
    await drift.run()
    expect(drift.t.text()).toContain('HTML changed')
    expect(drift.t.asked.length).toBe(1)
  })
  it('a relabelled tool asks again and names the tool and what its run rule becomes', async () => {
    const first = await mk({ answers: { ask: [true] } })
    await first.run()
    const drift = await mk({
      home: first.home,
      secrets: first.sec,
      env: { PROBE_GEN: '1', PROBE_DRIFT: 'annotations' },
      answers: { ask: [false] },
    })
    await drift.run()
    const text = drift.t.text()
    expect(text).toContain('`set_note` is now marked read-only, so it would run without a tap')
    expect(text).toContain('`read_note` is no longer marked read-only')
    expect(drift.t.asked.length).toBe(1)
  })
  it('a rescan after a resource went needs_reapproval asks again with the stored reason', async () => {
    const first = await mk({ answers: { ask: [true] } })
    await first.run()
    const cat = readCatalog(first.P)
    if (!cat.ok || !cat.catalog) throw new Error('no catalog')
    const c = structuredClone(cat.catalog)
    const r0 = c.servers[0]?.resources[0]
    if (r0) {
      r0.state = 'needs_reapproval'
      r0.reapproval_diff = '`read_note` is labelled differently than when you approved it'
    }
    writeFileSync(first.P.catalog, JSON.stringify(c))
    const again = await mk({ home: first.home, secrets: first.sec, answers: { ask: [true] } })
    const r = await again.run()
    expect(again.t.asked.length).toBe(1)
    expect(r.catalog?.servers[0]?.resources[0]?.state).toBe('approved')
  })
  it('refuses a label that could pass for Talos UI, re-asks, and falls back to the default', async () => {
    const m = await mk({ answers: { ask: [true], text: ['Talos approve', 'Notes board', 'ask'] } })
    const r = await m.run()
    expect(m.t.text()).toContain('A label can\'t contain "talos"')
    expect(r.catalog?.servers[0]?.resources[0]?.owner.label).toBe('Notes board')
    // five bad labels in a row fall back to a plain one
    const bad = ['Talos', 'Approve', 'Card', 'Sign in', 'Password', 'ask']
    const m2 = await mk({ answers: { ask: [true], text: bad } })
    expect((await m2.run()).catalog?.servers[0]?.resources[0]?.owner.label).toBe('App')
  })
})

describe('refusals at scan', () => {
  const html = (body: string) => [
    {
      uri: URI,
      mimeType: 'text/html;profile=mcp-app',
      text: body,
      _meta: { ui: { csp: { connectDomains: ['https://api.example.com'] } } },
    },
  ]
  const refusedWith = async (c: RawContent[], opts: Parameters<typeof mk>[0] = {}) => {
    const m = await mk({ contents: c, answers: { ask: [true] }, ...opts })
    const r = await m.run()
    const res = r.catalog?.servers[0]?.resources[0]
    expect(res?.state).toBe('refused')
    expect(m.t.asked).toEqual([]) // never asked
    expect(existsSync(join(m.agentDir, '.claude', 'settings.local.json'))).toBe(false)
    return { res, m }
  }
  it('unpinned remote code', async () => {
    const { res } = await refusedWith([
      {
        ...(html('<script src="https://cdn.example.com/a.js"></script>')[0] as RawContent),
        _meta: { ui: { csp: { resourceDomains: ['https://cdn.example.com'] } } },
      },
    ])
    expect(res?.reason).toContain('Code not pinned')
  })
  it('inline handlers', async () => {
    const { res } = await refusedWith(html('<button onclick="go()">x</button>'))
    expect(res?.reason).toContain('uses inline handlers')
  })
  it('a CSP that names the relay host, or a wildcard that covers it', async () => {
    const c = (d: string) => [
      { ...(html('<p>x</p>')[0] as RawContent), _meta: { ui: { csp: { connectDomains: [d] } } } },
    ]
    const a = await refusedWith(c('https://relay.example.com'))
    expect(a.res?.reason).toBeDefined()
    const b = await refusedWith(c('https://*.example.com'))
    expect(b.res?.reason).toBeDefined()
  })
  it('invalid CSP entries are reported, never dropped', async () => {
    const { res } = await refusedWith([
      {
        ...(html('<p>x</p>')[0] as RawContent),
        _meta: { ui: { csp: { connectDomains: ['http://api.example.com', 'https://*.com', '*'] } } },
      },
    ])
    expect(res?.reason).toContain('invalid CSP entries')
  })
  it('the wrong content type, no content, and an oversize page', async () => {
    await refusedWith([{ uri: URI, mimeType: 'text/plain', text: '<p>x</p>' }])
    await refusedWith([])
    await refusedWith([{ uri: URI, mimeType: 'text/html;profile=mcp-app' }])
    await refusedWith([{ uri: URI, mimeType: 'text/html;profile=mcp-app', text: 'x'.repeat(8 * 1024 * 1024 + 1) }])
  })
  it('a blob page is decoded and checked just like a text one', async () => {
    const m = await mk({
      contents: [
        { uri: URI, mimeType: 'text/html; profile=mcp-app', blob: Buffer.from('<p>ok</p>').toString('base64') },
      ],
      answers: { ask: [true] },
    })
    const r = await m.run()
    expect(r.catalog?.servers[0]?.resources[0]?.state).toBe('approved')
  })
  it('a refused resource is re-evaluated at the next scan, not remembered', async () => {
    const bad = await mk({ contents: html('<img onerror="x()">'), answers: { ask: [] } })
    await bad.run()
    const good = await mk({ home: bad.home, secrets: bad.sec, answers: { ask: [true] } })
    const r = await good.run()
    expect(r.catalog?.servers[0]?.resources[0]?.state).toBe('approved')
  })
  it('a read that fails because the server is not connected refuses one resource; any other read error stops the scan', async () => {
    const a = await mk({ readError: new Error('MCP server "probe" is not connected') })
    const r = await a.run()
    expect(r.catalog?.servers[0]?.resources[0]?.state).toBe('refused')
    const b = await mk({ readError: new Error('method not found') })
    await expect(b.run()).rejects.toThrow("This Claude Code version can't read app resources")
    expect(b.src.closed).toBe(true)
  })
})

describe('versions', () => {
  it('missing or below 2.1.296 stops, and the session is closed', async () => {
    const none = await mk({ version: undefined })
    await expect(none.run()).rejects.toBeInstanceOf(ScanStop)
    expect(none.src.closed).toBe(true)
    for (const v of ['2.1.295', '2.0.999', '1.9.9']) {
      const m = await mk({ version: v })
      await expect(m.run()).rejects.toThrow('too old for apps')
      expect(m.src.statusCalls).toBe(0)
    }
    const ok = await mk({ version: '2.1.296', answers: { ask: [false] } })
    await ok.run()
    const newer = await mk({ version: '2.2.0', answers: { ask: [false] } })
    await newer.run()
    expect(newer.src.statusCalls).toBeGreaterThan(0)
  })
  it('a live session on another version stops the scan, naming both', async () => {
    const m = await mk({ liveVersion: '2.1.300' })
    await expect(m.run()).rejects.toThrow(
      'The live session runs 2.1.300, this scan would run 2.1.312; restart one of them.',
    )
    expect(m.src.statusCalls).toBe(0)
    const same = await mk({ liveVersion: '2.1.312', answers: { ask: [false] } })
    await same.run()
  })
})

describe('server statuses', () => {
  const others: RawServer[] = [
    { name: 'needs', status: 'needs-auth', source: 'user' },
    { name: 'broken', status: 'failed', source: 'user', error: 'spawn ENOENT' },
    { name: 'off', status: 'disabled', source: 'user' },
  ]
  it('needs-auth, failed and disabled are reported and skipped; the rest still scans', async () => {
    const m = await mk({ extraServers: others, answers: { ask: [false] } })
    const r = await m.run()
    expect(r.skipped.map((s) => s.server).sort()).toEqual(['broken', 'needs', 'off'])
    expect(m.t.text()).toContain("sign in from an interactive `claude` session's /mcp first")
    expect(m.t.text()).toContain('broken: failed to start (spawn ENOENT)')
    expect(r.catalog?.servers.length).toBe(1)
  })
  it('a server skipped now keeps its old catalog entry untouched', async () => {
    const first = await mk({ answers: { ask: [true] } })
    await first.run()
    const again = await mk({
      home: first.home,
      secrets: first.sec,
      server: { status: 'needs-auth', tools: undefined, config: undefined },
    })
    const r = await again.run()
    expect(r.skipped[0]?.server).toBe('probe')
    expect(r.catalog?.servers[0]?.resources[0]?.state).toBe('approved')
    expect(again.t.asked).toEqual([])
  })
  it('pending is polled up to 30 s, reconnected once, and polled 15 s more', async () => {
    let n = 0
    const m = await mk({ answers: { ask: [false] } })
    m.src.servers[0] = { ...(m.src.servers[0] as RawServer), status: 'pending' }
    m.src.onStatus = () => {
      n++
      if (n >= 40) (m.src.servers[0] as RawServer).status = 'connected'
    }
    const r = await runScan(m.deps)
    expect(m.src.reconnects).toEqual(['probe'])
    expect(r.catalog?.servers.length).toBe(1) // connected on the second poll window
  })
  it('still pending after both windows is reported and skipped', async () => {
    const m = await mk({ server: { status: 'pending' } })
    const r = await m.run()
    expect(r.skipped).toEqual([{ server: 'probe', why: 'still starting; try again' }])
    expect(m.src.reconnects).toEqual(['probe'])
  })
  it('no app metadata anywhere: says so, writes a catalog with no servers', async () => {
    const m = await mk({ server: { tools: [{ name: 'plain' }] } })
    const r = await m.run()
    expect(m.t.text()).toContain('No app tools found.')
    expect(r.catalog?.servers).toEqual([])
  })
})

describe('direct connections and secrets', () => {
  const PLANT = 'Bearer plant-7f3a91c2d4e5'
  const httpServer = (headers: Record<string, string> = { Authorization: PLANT, 'X-Static': 'static-value-9981' }) => ({
    config: httpConfig('https://mcp.example.com/mcp', headers),
  })

  it('stdio: app-only buttons are unsupported, no verification connect, no config stored, only a fingerprint', async () => {
    const spy = new SpyConnector()
    const m = await mk({ connector: spy, answers: { ask: [true] } })
    const r = await m.run()
    const s = r.catalog?.servers[0]
    expect(spy.connects).toEqual([])
    expect(s?.direct?.type).toBe('stdio')
    expect(s?.direct?.config_fingerprint).toMatch(/^[0-9a-f]{64}$/)
    expect(s?.resources[0]?.owner.direct).toBe(false)
    expect(m.t.text()).toContain(
      "App-only buttons won't work for this app yet: Claude Code doesn't share this local server's launch settings with Talos.",
    )
    expect(m.t.text()).toContain("Talos can't re-check this server's labels between scans")
    const id = serverIdOf('probe', 'local')
    expect([...m.sec.kc.items.keys()]).toEqual([`${id}/hmac-key`])
  })
  it('sdk and claude.ai proxy servers are unsupported for app-only buttons', async () => {
    const m = await mk({
      server: { config: { type: 'claudeai-proxy', url: 'https://x.example.com', id: 'abc' }, source: 'claudeai' },
      answers: { ask: [true] },
    })
    const r = await m.run()
    expect(r.catalog?.servers[0]?.direct).toEqual({ type: 'unsupported', auth: 'none' })
    expect(m.t.text()).toContain("App-only buttons won't work for this app.")
    const n = await mk({ server: { config: undefined }, answers: { ask: [true] } })
    expect((await n.run()).catalog?.servers[0]?.direct?.type).toBe('unsupported')
  })
  it('http: one verification connect, config only in the Keychain, planted header values nowhere else', async () => {
    const probe = await readProbe()
    const spy = new SpyConnector(mcpTools(probe))
    const m = await mk({ server: httpServer(), connector: spy, answers: { ask: [true] } })
    const r = await m.run()
    expect(spy.connects.length).toBe(1)
    expect((spy.connects[0] as { headers: Record<string, string> }).headers.Authorization).toBe(PLANT)
    const s = r.catalog?.servers[0]
    expect(s?.direct).toMatchObject({ type: 'http', auth: 'static' })
    expect(s?.resources[0]?.owner.direct).toBe(true)
    const id = serverIdOf('probe', 'local')
    const cfg = await m.sec.secrets.loadConfig(id)
    expect(cfg).toEqual({
      type: 'http',
      url: 'https://mcp.example.com/mcp',
      headers: { Authorization: PLANT, 'X-Static': 'static-value-9981' },
    })
    // nothing token-like in output, the catalog, the scan log, any file under home or the agent dir
    for (const plant of [PLANT, 'plant-7f3a91c2d4e5', 'static-value-9981']) {
      expect(m.t.text()).not.toContain(plant)
      for (const f of [...allFiles(m.home), ...allFiles(m.agentDir)])
        expect({ f, has: readFileSync(f, 'utf8').includes(plant) }).toEqual({ f, has: false })
      expect(JSON.stringify(r)).not.toContain(plant)
    }
    expect(m.t.text()).toContain(
      "Talos keeps a copy of this server's settings, headers included, in your login Keychain.",
    )
    // the deny entries are written for a server with a Keychain copy
    const settings = JSON.parse(readFileSync(join(m.agentDir, '.claude', 'settings.local.json'), 'utf8'))
    expect(settings.permissions.deny).toContain('Bash(security find-generic-password:*)')
  })
  it('an error that carries a header value is redacted before it can be printed', async () => {
    const m = await mk({
      server: {
        ...httpServer(),
        status: 'failed',
        error: `401 Unauthorized for ${PLANT} at https://mcp.example.com`,
        tools: undefined,
      },
    })
    await m.run()
    expect(m.t.text()).toContain('failed to start')
    expect(m.t.text()).not.toContain('plant-7f3a91c2d4e5')
    expect(m.t.text()).toContain('***')
  })
  it('a verification connect that fails with the header in its message does not leak it', async () => {
    const spy = new SpyConnector([], new Error(`connect failed with ${PLANT}`))
    const m = await mk({ server: httpServer(), connector: spy, answers: { ask: [true] } })
    await m.run()
    expect(m.t.text()).not.toContain('plant-7f3a91c2d4e5')
    expect(m.t.text()).toContain("Talos couldn't reach this server for its own session")
  })
  it('a changed header or URL moves the fingerprint, so the next scan asks again', async () => {
    const probe = await readProbe()
    const first = await mk({
      server: httpServer(),
      connector: new SpyConnector(mcpTools(probe)),
      answers: { ask: [true] },
    })
    await first.run()
    const same = await mk({
      home: first.home,
      secrets: first.sec,
      server: httpServer(),
      connector: new SpyConnector(mcpTools(probe)),
      answers: { ask: [] },
    })
    await same.run()
    expect(same.t.asked).toEqual([])
    const rotated = await mk({
      home: first.home,
      secrets: first.sec,
      server: httpServer({ Authorization: 'Bearer rotated-0000000000' }),
      connector: new SpyConnector(mcpTools(probe)),
      answers: { ask: [false] },
    })
    await rotated.run()
    expect(rotated.t.asked.length).toBe(1)
    expect(rotated.t.text()).toContain("the server's launch command, URL or headers changed")
  })
  it("Claude Code and the server disagreeing on a tool's labels makes it ask each time, and the screen says why", async () => {
    const probe = await readProbe()
    // the server (direct) calls show_widget read-only; Claude Code's view of it has no annotations
    const direct = mcpTools(probe).map((t) =>
      t.name === 'show_widget' ? { ...t, annotations: { readOnlyHint: true, destructiveHint: false } } : t,
    )
    const m = await mk({ server: httpServer({}), connector: new SpyConnector(direct), answers: { ask: [true] } })
    const r = await m.run()
    expect(r.catalog?.servers[0]?.ask_each_time).toEqual(['show_widget'])
    expect(m.t.text()).toContain(
      '`show_widget`: Claude Code and the server disagree on its labels, so it asks you each time.',
    )
    // the catalog takes the direct (raw) triple
    expect(r.catalog?.servers[0]?.tools.find((t) => t.name === 'show_widget')?.read_only).toBe(true)
  })
  it('a 401 with no headers marks the server oauth and points at apps login', async () => {
    const m = await mk({
      server: httpServer({}),
      connector: new SpyConnector([], new DirectAuthError('sign-in needed')),
      answers: { ask: [true] },
    })
    const r = await m.run()
    expect(r.catalog?.servers[0]?.direct?.auth).toBe('oauth')
    expect(m.t.text()).toContain('run talos-app apps login <server> on this Mac')
  })
  it('headers that the server rejects are said so, not mistaken for oauth', async () => {
    const m = await mk({
      server: httpServer(),
      connector: new SpyConnector([], new DirectAuthError('x')),
      answers: { ask: [true] },
    })
    const r = await m.run()
    expect(r.catalog?.servers[0]?.direct?.auth).toBe('static')
    expect(m.t.text()).toContain('rejected the headers')
  })
  it("a Keychain that cannot be written refuses the server's apps with a plain reason and keeps the old catalog", async () => {
    const sec = memSecrets()
    sec.kc.failWith = new Error('locked')
    const m = await mk({ secrets: sec, answers: { ask: [true] } })
    const r = await m.run()
    expect(r.catalog?.servers[0]?.resources[0]?.state).toBe('refused')
    expect(r.catalog?.servers[0]?.resources[0]?.reason).toContain('login Keychain')
    expect(m.t.asked).toEqual([])
  })
})

describe('--check', () => {
  it('prints drift, asks nothing, writes nothing', async () => {
    const first = await mk({ answers: { ask: [true] } })
    await first.run()
    const before = readFileSync(first.P.catalog, 'utf8')
    const settingsBefore = readFileSync(join(first.agentDir, '.claude', 'settings.local.json'), 'utf8')
    const chk = await mk({
      home: first.home,
      secrets: first.sec,
      check: true,
      env: { PROBE_GEN: '1', PROBE_DRIFT: 'annotations' },
    })
    const r = await chk.run()
    expect(chk.t.asked).toEqual([])
    expect(chk.t.texts).toEqual([])
    expect(r.drift.length).toBeGreaterThan(0)
    expect(chk.t.text()).toContain('drift: probe ui://probe/view.html:')
    expect(chk.t.text()).toContain('`set_note` is now marked read-only')
    expect(readFileSync(first.P.catalog, 'utf8')).toBe(before)
    expect(existsSync(join(chk.agentDir, '.claude'))).toBe(false)
    expect(readFileSync(join(first.agentDir, '.claude', 'settings.local.json'), 'utf8')).toBe(settingsBefore)
  })
  it('on a home that has never been scanned, creates nothing (no apps directory, no log, no settings)', async () => {
    const m = await mk({ check: true })
    await m.run()
    expect(existsSync(m.P.dir)).toBe(false)
    expect(existsSync(join(m.agentDir, '.claude'))).toBe(false)
  })
  it('reports a server that is gone and a Claude Code version change; clean when nothing moved', async () => {
    const first = await mk({ answers: { ask: [true] } })
    await first.run()
    const clean = await mk({ home: first.home, secrets: first.sec, check: true })
    const r0 = await clean.run()
    expect(r0.drift).toEqual([])
    expect(clean.t.text()).toContain('No drift')
    const gone = await mk({
      home: first.home,
      secrets: first.sec,
      check: true,
      version: '2.1.320',
      server: { name: 'other', source: 'local' },
    })
    ;(gone.src as ScriptedSource).contents['other:ui://probe/view.html'] = gone.src.contents[
      `probe:${URI}`
    ] as RawContent[]
    const r1 = await gone.run()
    expect(r1.drift.map((d) => d.what)).toContain('server gone')
    expect(r1.drift.map((d) => d.what)).toContain('Claude Code changed from 2.1.312 to 2.1.320')
  })
})

describe('the home directory is left alone', () => {
  it('a whole scan with an empty HOME leaves it empty', async () => {
    const m = await mk({ answers: { ask: [true] } })
    await m.run()
    // bun may make its own cache folder here (.bun, Library); the scan must not make a .claude
    expect(readdirSync(fakeHome).filter((n) => n === '.claude' || n === '.config')).toEqual([])
  })
  it('corrupt old catalog: starts fresh and says so', async () => {
    const home = tmp('home-')
    const P = appPaths(home)
    const first = await mk({ home, answers: { ask: [false] } })
    mkdirSync(P.dir, { recursive: true })
    writeFileSync(P.catalog, '{broken')
    const r = await first.run()
    expect(first.t.text()).toContain('The existing catalog is unusable')
    expect(r.catalog?.rev).toBe(1)
  })
})
