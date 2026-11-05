// `bun run apps/bridge/test/apps/e2e-scan.ts '<json>'` (driven by e2e/harness/apps.ts): the owner's `talos-app apps scan`, scripted (MCP-APPS-SPEC M6.1, "catalog in
// CI"). It lists the REAL servers (the probe fixture, the two reference servers) with a real MCP client, hands that output to
// the real scan module through an injected status source, answers its questions, and so writes the catalog, the pinned HTML
// and the hook entries into the agent folder exactly as a scan does. It lives under test/ and is never reachable from the
// bridge: no flag or env switch in the product enables it. The Keychain is an in-memory double (the live Keychain is never
// touched). Prints one JSON line: { ok, out, asked, drift }.
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { type KeychainRunner, ServerSecrets } from '../../src/apps/keychain.ts'
import { appPaths } from '../../src/apps/paths.ts'
import type { RawContent, RawServer } from '../../src/apps/scan.ts'
import { runScan } from '../../src/apps/scan.ts'
import { ScriptedSource, scriptedIO, sdkToolOf } from './helpers.ts'

export type ScanServer = {
  /** The name Claude Code would report (`mcp__<name>__tool`). */
  name: string
  kind: 'probe' | 'clock' | 'monitor'
  transport: 'stdio' | 'http'
  /** http only */
  url?: string
  /** stdio only: extra env for the server (PROBE_GEN, PROBE_DRIFT, PROBE_LOG) */
  env?: Record<string, string>
  label: string
  show?: 'auto' | 'ask'
  /** Answer the approval question with this (default true). */
  approve?: boolean
}
export type ScanArgs = {
  home: string
  agentDir: string
  relayUrl: string
  version?: string
  servers: ScanServer[]
  check?: boolean
  /** A JSON file standing in for the login Keychain, kept between scan runs of one test (server fingerprints live there). */
  keychainFile: string
}

const ROOT = resolve(import.meta.dir, '..', '..', '..', '..')
const BRIDGE_DIR = join(ROOT, 'apps', 'bridge')
const PROBE = join(ROOT, 'packages', 'testkit', 'fixtures', 'apps-probe-server', 'server.mjs')
const REF = (pkg: string) => join(ROOT, 'e2e', 'node_modules', '@modelcontextprotocol', pkg, 'dist', 'index.js')

export function stdioCommand(s: Pick<ScanServer, 'kind'>): { command: string; args: string[] } {
  if (s.kind === 'probe') return { command: 'node', args: [PROBE] }
  return {
    command: 'node',
    args: [REF(s.kind === 'clock' ? 'server-basic-vanillajs' : 'server-system-monitor'), '--stdio'],
  }
}

/** The Keychain double: a JSON file, so a second scan process sees what the first stored (the 'launch command changed' check). */
class FileKeychain implements KeychainRunner {
  constructor(private readonly file: string) {}
  private load(): Record<string, string> {
    return existsSync(this.file) ? (JSON.parse(readFileSync(this.file, 'utf8')) as Record<string, string>) : {}
  }
  async write(account: string, value: string) {
    writeFileSync(this.file, JSON.stringify({ ...this.load(), [account]: value }), { mode: 0o600 })
  }
  async read(account: string) {
    return this.load()[account]
  }
  async delete(account: string) {
    const m = this.load()
    delete m[account]
    writeFileSync(this.file, JSON.stringify(m), { mode: 0o600 })
  }
}

async function list(s: ScanServer) {
  const client = new Client({ name: 'apps-e2e-scan', version: '1' }, { capabilities: {} })
  if (s.transport === 'http') {
    await client.connect(new StreamableHTTPClientTransport(new URL(s.url as string)))
  } else {
    const { command, args } = stdioCommand(s)
    await client.connect(
      new StdioClientTransport({
        command,
        args,
        env: { PATH: process.env.PATH ?? '', ...(s.env ?? {}) },
        stderr: 'pipe',
      }),
    )
  }
  const tools = (await client.listTools()).tools
  const uris = [
    ...new Set(tools.map((t) => (t._meta as { ui?: { resourceUri?: string } } | undefined)?.ui?.resourceUri)),
  ]
  const contents: Record<string, RawContent[]> = {}
  for (const uri of uris) {
    if (!uri) continue
    contents[`${s.name}:${uri}`] = (await client.readResource({ uri })).contents as unknown as RawContent[]
  }
  await client.close()
  return { tools: tools.map((t) => sdkToolOf(t as never)), contents }
}

async function main(a: ScanArgs) {
  const raw: RawServer[] = []
  const contents: Record<string, RawContent[]> = {}
  const asks: boolean[] = []
  const texts: string[] = []
  for (const s of a.servers) {
    const l = await list(s)
    Object.assign(contents, l.contents)
    const { command, args } = stdioCommand(s)
    raw.push({
      name: s.name,
      status: 'connected',
      source: 'local',
      config: s.transport === 'http' ? { type: 'http', url: s.url } : { type: 'stdio', command, args },
      tools: l.tools as never,
    })
    // one approval question, then label and show, per app view of this server
    const views = Object.keys(l.contents).length
    for (let i = 0; i < views; i++) {
      asks.push(s.approve !== false)
      texts.push(s.label, s.show ?? 'auto')
    }
  }
  const src = new ScriptedSource(a.version ?? '2.1.312', raw, contents)
  const t = scriptedIO({ ask: asks, text: texts })
  const secrets = new ServerSecrets(new FileKeychain(a.keychainFile))
  const result = await runScan({
    paths: appPaths(a.home),
    source: src,
    io: t.io,
    now: () => Date.now(),
    sleep: async () => {},
    secrets,
    connector: {
      connect: async () => {
        throw new Error('no direct connection in the e2e scan')
      },
    },
    relayUrl: a.relayUrl,
    agentDir: a.agentDir,
    bridgeDir: BRIDGE_DIR,
    liveVersion: undefined,
    check: a.check ?? false,
    agentNames: [],
  })
  process.stdout.write(`${JSON.stringify({ ok: true, out: t.out, asked: t.asked, result })}\n`)
}

if (import.meta.main) {
  main(JSON.parse(process.argv[2] ?? '{}') as ScanArgs).then(
    () => process.exit(0),
    (e) => {
      process.stdout.write(`${JSON.stringify({ ok: false, error: String(e?.stack ?? e) })}\n`)
      process.exit(1)
    },
  )
}
