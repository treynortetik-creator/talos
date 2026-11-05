// Shared fixtures for the MCP-apps bridge tests: a memory Keychain, a scripted status source built from the REAL probe
// server's output, an approved-catalog builder, and a terminal that answers from a script. Nothing here touches the
// owner's Keychain, ~/.claude, or a real `claude`.
import { type ChildProcess, spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { approvalKey, type CatalogToolT, fromSpecCsp, sha256Hex } from '@talos-app/protocol'
import { type AppCatalogT, type CatalogServerT, normaliseAnnotations, toolPrefixFor } from '../../src/apps/catalog.ts'
import { toCatalogTool } from '../../src/apps/direct.ts'
import { checkHtml } from '../../src/apps/html-check.ts'
import { type KeychainRunner, ServerSecrets, serverIdOf } from '../../src/apps/keychain.ts'
import { appPaths } from '../../src/apps/paths.ts'
import { ensureAppDirs } from '../../src/apps/pending.ts'
import type { McpStatusSource, RawContent, RawServer, ScanIO } from '../../src/apps/scan.ts'

export const PROBE_DIR = join(
  import.meta.dir,
  '..',
  '..',
  '..',
  '..',
  'packages',
  'testkit',
  'fixtures',
  'apps-probe-server',
)
export const PROBE = join(PROBE_DIR, 'server.mjs')

export const tmp = (prefix = 'talos-apps-') => mkdtempSync(join(tmpdir(), prefix))

// ---- Keychain double -------------------------------------------------------------------------------------------------

export class MemoryKeychain implements KeychainRunner {
  readonly items = new Map<string, string>()
  readonly log: Array<{ op: 'write' | 'read' | 'delete'; account: string }> = []
  failWith: Error | undefined
  async write(account: string, value: string) {
    this.log.push({ op: 'write', account })
    if (this.failWith) throw this.failWith
    this.items.set(account, value)
  }
  async read(account: string) {
    this.log.push({ op: 'read', account })
    if (this.failWith) throw this.failWith
    return this.items.get(account)
  }
  async delete(account: string) {
    this.log.push({ op: 'delete', account })
    this.items.delete(account)
  }
}
export const memSecrets = () => {
  const kc = new MemoryKeychain()
  return { kc, secrets: new ServerSecrets(kc) }
}

// ---- the real probe server -------------------------------------------------------------------------------------------

export type ProbeEnv = Record<string, string>

/** MCP SDK client connected to the probe over stdio; what it lists is the probe's real output. */
export async function probeStdio(env: ProbeEnv = {}) {
  const t = new StdioClientTransport({
    command: process.execPath,
    args: [PROBE],
    env: { PATH: process.env.PATH ?? '', ...env },
    stderr: 'pipe',
  })
  const c = new Client({ name: 'apps-test', version: '1' }, { capabilities: {} })
  await c.connect(t)
  return { client: c, close: () => c.close() }
}

export async function probeHttp(env: ProbeEnv = {}) {
  const child: ChildProcess = spawn(process.execPath, [PROBE, '--http', '0'], {
    env: { PATH: process.env.PATH ?? '', ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  const port = await new Promise<number>((resolve, reject) => {
    let buf = ''
    child.stdout?.on('data', (d) => {
      buf += String(d)
      const m = /PROBE_LISTENING (\d+)/.exec(buf)
      if (m) resolve(Number(m[1]))
    })
    child.on('error', reject)
    child.on('exit', () => reject(new Error('probe exited before listening')))
  })
  return {
    port,
    url: `http://127.0.0.1:${port}/mcp`,
    origin: `http://127.0.0.1:${port}`,
    setGen: (n: number) => fetch(`http://127.0.0.1:${port}/__gen/${n}`),
    kill: () => child.kill('SIGKILL'),
    child,
  }
}

export async function probeHttpClient(url: string, headers: Record<string, string> = {}) {
  const c = new Client({ name: 'apps-test', version: '1' }, { capabilities: {} })
  await c.connect(new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers } }))
  return c
}

/** A tool as Claude Code's SDK reports it: annotations in `{readOnly, destructive, openWorld}`, `destructive:false` omitted. */
export function sdkToolOf(t: { name: string; annotations?: Record<string, unknown>; _meta?: Record<string, unknown> }) {
  const a = t.annotations ?? {}
  const ann: Record<string, boolean> = {}
  if (typeof a.readOnlyHint === 'boolean') ann.readOnly = a.readOnlyHint
  if (a.destructiveHint === true) ann.destructive = true
  if (typeof a.openWorldHint === 'boolean') ann.openWorld = a.openWorldHint
  return {
    name: t.name,
    ...(Object.keys(ann).length ? { annotations: ann } : {}),
    ...(t._meta ? { _meta: t._meta } : {}),
  }
}

export async function readProbe(env: ProbeEnv = {}) {
  const p = await probeStdio(env)
  const tools = (await p.client.listTools()).tools
  const res = await p.client.readResource({ uri: 'ui://probe/view.html' })
  await p.close()
  return { tools: tools.map((t) => sdkToolOf(t as never)), contents: res.contents as unknown as RawContent[] }
}

// ---- a scripted status source ----------------------------------------------------------------------------------------

export class ScriptedSource implements McpStatusSource {
  modelTurns = 0
  closed = false
  started = 0
  statusCalls = 0
  reconnects: string[] = []
  readCalls: string[] = []
  constructor(
    public version: string | undefined,
    public servers: RawServer[],
    public contents: Record<string, RawContent[]>,
    /** called on each status() so a test can turn pending into connected */
    public onStatus?: (n: number) => void,
    public readError?: Error,
  ) {}
  async start() {
    this.started++
    return { claudeCodeVersion: this.version }
  }
  async status() {
    this.statusCalls++
    this.onStatus?.(this.statusCalls)
    return this.servers
  }
  async reconnect(name: string) {
    this.reconnects.push(name)
  }
  async readResource(server: string, uri: string) {
    this.readCalls.push(`${server}:${uri}`)
    if (this.readError) throw this.readError
    return { contents: this.contents[`${server}:${uri}`] ?? [] }
  }
  close() {
    this.closed = true
  }
}

export function stdioConfig(extra: Record<string, unknown> = {}) {
  return { type: 'stdio', command: 'node', args: ['probe.js'], ...extra }
}
export function httpConfig(url: string, headers: Record<string, string> = {}) {
  return { type: 'http', url, ...(Object.keys(headers).length ? { headers } : {}) }
}

/** Terminal that answers from a script and records everything printed. */
export function scriptedIO(answers: { ask?: boolean[]; text?: string[] } = {}) {
  const out: string[] = []
  const asked: string[] = []
  const texts: string[] = []
  const ask = [...(answers.ask ?? [])]
  const text = [...(answers.text ?? [])]
  const io: ScanIO = {
    print: (l) => out.push(l),
    ask: async (q) => {
      asked.push(q)
      return ask.length ? (ask.shift() as boolean) : false
    },
    askText: async (q, d) => {
      texts.push(q)
      return text.length ? (text.shift() as string) : d
    },
  }
  return { io, out, asked, texts, text: () => out.join('\n') }
}

// ---- an approved catalog on disk ----------------------------------------------------------------------------------------

export const VIEW_HTML =
  '<!doctype html><html><body><div id="a">view</div><script>document.getElementById("a").textContent="hi"</script></body></html>'

export async function approvedFixture(
  home: string,
  opts: {
    server?: string
    source?: string
    tools?: CatalogToolT[]
    direct?: CatalogServerT['direct']
    ownerDirect?: boolean
    show?: 'auto' | 'ask'
    html?: string
    strict?: boolean
    askEach?: string[]
    cc?: string
  } = {},
) {
  const P = appPaths(home)
  ensureAppDirs(P)
  const server = opts.server ?? 'probe'
  const source = opts.source ?? 'local'
  const html = opts.html ?? VIEW_HTML
  const bytes = new TextEncoder().encode(html)
  const sha = sha256Hex(bytes)
  const checked = await checkHtml(html, { resource_domains: [] })
  if (!checked.ok) throw new Error(`fixture html refused: ${checked.reason}`)
  const csp = {
    connect_domains: ['https://api.example.com'],
    resource_domains: [],
    frame_domains: [],
    base_uri_domains: [],
    script_hashes: checked.script_hashes,
    script_urls: [],
    style_urls: [],
  }
  const tools: CatalogToolT[] = opts.tools ?? [
    {
      name: 'show_widget',
      resource_uri: 'ui://probe/view.html',
      visibility: ['model', 'app'],
      read_only: false,
      destructive: true,
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
    {
      name: 'set_note',
      resource_uri: 'ui://probe/view.html',
      visibility: ['model', 'app'],
      read_only: false,
      destructive: true,
      open_world: true,
    },
    {
      name: 'app_only_refresh',
      resource_uri: 'ui://probe/view.html',
      visibility: ['app'],
      read_only: true,
      destructive: false,
      open_world: true,
    },
    { name: 'model_only', visibility: ['model'], read_only: false, destructive: true, open_world: true },
  ]
  const manifest = {
    server,
    source,
    resource_uri: 'ui://probe/view.html',
    html_sha256: sha,
    csp,
    permissions_requested: [],
    tools,
    ...(opts.direct ? { direct: opts.direct } : {}),
  }
  const key = approvalKey(manifest)
  const cat: AppCatalogT = {
    rev: 1,
    scanned_at: new Date().toISOString(),
    claude_code_version: opts.cc ?? '2.1.312',
    strict: opts.strict ?? false,
    servers: [
      {
        server,
        source,
        tool_prefix: toolPrefixFor(server),
        ...(opts.direct ? { direct: opts.direct } : {}),
        ...(opts.askEach ? { ask_each_time: opts.askEach } : {}),
        tools,
        resources: [
          {
            uri: 'ui://probe/view.html',
            html_sha256: sha,
            size: bytes.length,
            csp,
            permissions_requested: [],
            approval_key: key,
            state: 'approved',
            owner: { label: 'Probe view', show: opts.show ?? 'auto', direct: opts.ownerDirect ?? false },
            decided_at: new Date().toISOString(),
          },
        ],
      },
    ],
  }
  writeFileSync(P.catalog, JSON.stringify(cat), { mode: 0o600 })
  writeFileSync(join(P.resources, `${sha}.html`), bytes, { mode: 0o600 })
  return { P, cat, key, sha, html, csp, tools }
}

export type { CatalogToolT }
export { fromSpecCsp, mkdirSync, normaliseAnnotations, readFileSync, serverIdOf, toCatalogTool }
