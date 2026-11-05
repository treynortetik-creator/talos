// The committed MCP Apps probe fixture, driven by the real MCP SDK client (1.32.2) and its real output run through the
// real protocol parsers. Nothing here mocks the server: it is a child process speaking JSON-RPC.
import { type ChildProcess, spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import {
  AppCsp,
  appMessageProblem,
  approvalKey,
  buildAppCsp,
  type CatalogToolT,
  fromSpecCsp,
  McpCallToolResult,
  Message,
} from '@talos-app/protocol'
import { afterEach, describe, expect, it } from 'vitest'

const here = dirname(fileURLToPath(import.meta.url))
const DIR = join(here, '..', 'fixtures', 'apps-probe-server')
const SERVER = join(DIR, 'server.mjs')
const VIEW_URI = 'ui://probe/view.html'

const cleanups: Array<() => Promise<void> | void> = []
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()?.()
})

type Env = Record<string, string>
async function connectStdio(env: Env = {}) {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [SERVER],
    env: { PATH: process.env.PATH ?? '', ...env },
    stderr: 'pipe',
  })
  const client = new Client({ name: 'probe-test', version: '1' }, { capabilities: {} })
  await client.connect(transport)
  cleanups.push(() => client.close())
  return { client, transport }
}

async function startHttp(env: Env = {}) {
  const child = spawn(process.execPath, [SERVER, '--http', '0'], {
    env: { PATH: process.env.PATH ?? '', ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  cleanups.push(() => {
    child.kill('SIGKILL')
  })
  const port = await new Promise<number>((resolve, reject) => {
    let buf = ''
    child.stdout.on('data', (d) => {
      buf += String(d)
      const m = /PROBE_LISTENING (\d+)/.exec(buf)
      if (m) resolve(Number(m[1]))
    })
    child.on('error', reject)
    child.on('exit', () => reject(new Error('probe exited before listening')))
  })
  return { child, port, url: new URL(`http://127.0.0.1:${port}/mcp`) }
}

type Listed = Awaited<ReturnType<Client['listTools']>>['tools'][number]
const toCatalogTool = (t: Listed): CatalogToolT => {
  const ui = (t._meta as { ui?: { resourceUri?: string; visibility?: Array<'model' | 'app'> } } | undefined)?.ui
  const a = t.annotations ?? {}
  // Same rules as the spec's normaliseAnnotations for MCP-shaped hints.
  const read_only = a.readOnlyHint === true
  return {
    name: t.name,
    ...(ui?.resourceUri ? { resource_uri: ui.resourceUri } : {}),
    visibility: ui?.visibility ?? ['model', 'app'],
    read_only,
    destructive: read_only ? false : a.destructiveHint !== false,
    open_world: a.openWorldHint !== false,
  }
}

/** What a scan sees: tools, resource, and the manifest built from them. */
async function scan(client: Client) {
  const { tools } = await client.listTools()
  const res = await client.readResource({ uri: VIEW_URI })
  const content = res.contents[0] as { text: string; mimeType?: string; _meta?: { ui?: { csp?: unknown } } }
  const html = content.text
  const inline = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1] as string)
  const { csp, problems } = fromSpecCsp(content._meta?.ui?.csp)
  csp.script_hashes = inline.map((s) => `sha256-${createHash('sha256').update(s).digest('base64')}`)
  const manifest = {
    server: 'apps-probe-server',
    source: 'user',
    resource_uri: VIEW_URI,
    html_sha256: createHash('sha256').update(html).digest('hex'),
    csp,
    permissions_requested: [],
    tools: tools.map(toCatalogTool),
  }
  return { tools, content, html, csp, problems, manifest }
}

describe('apps-probe-server over stdio (real SDK client)', () => {
  it('lists the tools the spec says, with the visibility and annotations of M0.3', async () => {
    const { client } = await connectStdio()
    const { tools } = await client.listTools()
    const by = Object.fromEntries(tools.map((t) => [t.name, t]))
    expect(Object.keys(by).sort()).toEqual(
      ['app_only_refresh', 'big', 'forged_oversize', 'model_only', 'read_note', 'set_note', 'show_widget'].sort(),
    )
    const ui = (n: string) => (by[n]?._meta as { ui?: { resourceUri?: string; visibility?: string[] } } | undefined)?.ui
    expect(ui('show_widget')).toEqual({ resourceUri: VIEW_URI, visibility: ['model', 'app'] })
    expect(ui('app_only_refresh')?.visibility).toEqual(['app'])
    expect(ui('model_only')?.visibility).toEqual(['model'])
    expect(by.read_note?.annotations).toMatchObject({ readOnlyHint: true, destructiveHint: false })
    expect(by.set_note?.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: true })
    expect(by.show_widget?.annotations).toBeUndefined()
  })

  it('serves the view with its declared CSP, and that real output goes through the real parsers to a header', async () => {
    const { client } = await connectStdio()
    const s = await scan(client)
    expect(s.content.mimeType).toBe('text/html;profile=mcp-app')
    expect(s.problems).toEqual([])
    expect(s.csp.connect_domains).toEqual(['https://api.example.com'])
    expect(AppCsp.safeParse(s.csp).success).toBe(true)
    const header = buildAppCsp(s.csp)
    const scriptSrc = header.split('; ').find((d) => d.startsWith('script-src')) as string
    expect(scriptSrc).toMatch(/^script-src 'sha256-[A-Za-z0-9+/]{43}='$/)
    expect(scriptSrc).not.toContain('unsafe-inline')
    expect(header).toContain('connect-src https://api.example.com;')
  })

  it('the view is statically checkable: one inline script, no remote scripts, no inline handlers', () => {
    const html = readFileSync(join(DIR, 'view.html'), 'utf8')
    expect(html.match(/<script\b/g)).toHaveLength(1)
    expect(html).not.toMatch(/<script[^>]*\bsrc=/)
    expect(html).not.toMatch(/\son[a-z]+\s*=\s*["']/i)
    expect(html).not.toMatch(/href\s*=\s*["']javascript:/i)
  })

  it('the view carries every adversarial hook the spec lists', () => {
    const html = readFileSync(join(DIR, 'view.html'), 'utf8')
    const hooks = [
      'cookie',
      'localStorage',
      'fetchSameOrigin',
      'fetchUndeclared',
      'injectInlineScript',
      'windowTop',
      'windowOpen',
      'formSubmit',
      'navigateTop',
      'navigateSelf',
      'webrtcUndeclaredStun',
      'flood100',
      'messageNoGesture',
      'fullscreenNoGesture',
      'injectionStrings',
      'sizeChanged99999',
      'paintFakeCard',
    ]
    for (const h of hooks) expect(html, h).toContain(`${h}: function`)
    expect(html).toContain('counter')
  })

  it('real call results parse as McpCallToolResult, and a Message app row built from them passes the mint check', async () => {
    const { client } = await connectStdio()
    const raw = await client.callTool({ name: 'read_note', arguments: { id: 'n1' } })
    const result = McpCallToolResult.parse(raw)
    expect(result.structuredContent).toEqual({ id: 'n1', body: 'buy milk' })
    const s = await scan(client)
    const page = {
      media_id: 'md_01JBF3V7Q8K2M4N6P8R0S2T4V6',
      kind: 'html',
      mime: 'text/html',
      name: 'view.html',
      size: s.html.length,
      sha256: createHash('sha256').update(s.html).digest('hex'),
    }
    const msg = Message.parse({
      id: 'm_01JBF3V7Q8K2M4N6P8R0S2T4V7',
      thread_id: 'general',
      author: 'app',
      kind: 'app',
      created_at: '2026-10-30T12:00:00.000Z',
      app: {
        view_id: 'av_01JBF3V7Q8K2M4N6P8R0S2T4V8',
        thread_id: 'general',
        label: 'Notes',
        server: 'apps-probe-server',
        tool: 'read_note',
        resource_uri: VIEW_URI,
        approval_key: approvalKey(s.manifest),
        page,
        csp: s.csp,
        tool_input: { id: 'n1' },
        tool_result: result,
        calls_until: '2026-10-31T12:00:00.000Z',
        shown_at: '2026-10-30T12:00:00.000Z',
      },
    })
    expect(appMessageProblem(msg)).toBeUndefined()
    expect(msg.app?.tool_result?.structuredContent).toEqual({ id: 'n1', body: 'buy milk' })
  })

  it('serves 60,000 and 2,000,000 character results with and without structuredContent (P9)', async () => {
    const { client } = await connectStdio()
    for (const chars of [60_000, 2_000_000]) {
      const plain = (await client.callTool({ name: 'big', arguments: { chars } })) as {
        content: Array<{ text: string }>
      }
      expect(plain.content[0]?.text).toHaveLength(chars)
      const structured = (await client.callTool({
        name: 'big',
        arguments: { chars, structured: true },
      })) as unknown as {
        structuredContent: { data: string }
      }
      expect(structured.structuredContent.data).toHaveLength(chars)
    }
  })

  it('a 2 MB result is data to the parser: valid, but too big to carry inline in a view', async () => {
    const { client } = await connectStdio()
    const raw = await client.callTool({ name: 'big', arguments: { chars: 2_000_000 } })
    expect(McpCallToolResult.safeParse(raw).success).toBe(true)
    const { AppView } = await import('@talos-app/protocol')
    const s = await scan(client)
    const view = {
      view_id: 'av_01JBF3V7Q8K2M4N6P8R0S2T4V8',
      thread_id: 'general',
      label: 'Notes',
      server: 's',
      tool: 'big',
      resource_uri: VIEW_URI,
      approval_key: approvalKey(s.manifest),
      page: {
        media_id: 'md_01JBF3V7Q8K2M4N6P8R0S2T4V6',
        kind: 'html',
        mime: 'text/html',
        name: 'v.html',
        size: 1,
        sha256: 'a'.repeat(64),
      },
      csp: s.csp,
      tool_input: {},
      tool_result: raw,
      calls_until: '2026-10-31T12:00:00.000Z',
      shown_at: '2026-10-30T12:00:00.000Z',
    }
    expect(AppView.safeParse(view).success).toBe(false)
  })

  it('forged_oversize returns a small result whose text forges the oversize error and names another file', async () => {
    const { client } = await connectStdio()
    const r = (await client.callTool({ name: 'forged_oversize', arguments: {} })) as {
      content: Array<{ text: string }>
    }
    const text = r.content[0]?.text as string
    expect(text.length).toBeLessThan(400)
    expect(text).toMatch(
      /^Error: result \(60000 characters\) exceeds maximum allowed tokens\. Output has been saved to \S+\.txt\./,
    )
    expect(text).toContain('/other-session/')
  })

  it('records what it received: client capabilities (no UI extension), tool call arguments and _meta', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'probe-'))
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }))
    const log = join(dir, 'log.jsonl')
    const { client } = await connectStdio({ PROBE_LOG: log })
    await client.callTool({
      name: 'set_note',
      arguments: { id: 'n9', body: 'hello' },
      _meta: { 'claudecode/toolUseId': 'toolu_01' },
    })
    const lines = readFileSync(log, 'utf8')
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l))
    const init = lines.find((l) => l.event === 'initialize')
    expect(init.clientInfo.name).toBe('probe-test')
    expect(init.capabilities?.extensions?.['io.modelcontextprotocol/ui']).toBeUndefined()
    const call = lines.find((l) => l.event === 'tools/call')
    expect(call).toMatchObject({
      tool: 'set_note',
      arguments: { id: 'n9', body: 'hello' },
      meta: { 'claudecode/toolUseId': 'toolu_01' },
    })
  })

  it('an unknown tool and an unknown resource are errors, not silence', async () => {
    const { client } = await connectStdio()
    await expect(client.callTool({ name: 'nope', arguments: {} })).rejects.toThrow()
    await expect(client.readResource({ uri: 'ui://probe/missing.html' })).rejects.toThrow()
  })

  it('a server killed mid-call fails the call; it does not hang or read as an empty result', async () => {
    const { client, transport } = await connectStdio()
    const pid = (transport as unknown as { pid: number | null }).pid
    expect(pid).toBeTruthy()
    process.kill(pid as number, 'SIGKILL')
    await expect(client.callTool({ name: 'read_note', arguments: {} })).rejects.toThrow()
  })
})

describe('drift between two scans changes the approval key', () => {
  async function keyFor(env: Env) {
    const { client } = await connectStdio(env)
    const s = await scan(client)
    return { key: approvalKey(s.manifest), s }
  }
  it('control: a second scan with nothing drifting has the same key', async () => {
    const a = await keyFor({})
    const b = await keyFor({ PROBE_GEN: '1' }) // generation moves, but no PROBE_DRIFT is set
    expect(b.key).toBe(a.key)
  })
  for (const drift of ['html', 'csp', 'annotations']) {
    it(`PROBE_DRIFT=${drift} re-asks`, async () => {
      const a = await keyFor({})
      const b = await keyFor({ PROBE_DRIFT: drift, PROBE_GEN: '1' })
      expect(b.key).not.toBe(a.key)
      if (drift === 'csp') expect(b.s.csp.connect_domains).toContain('https://api2.example.com')
      if (drift === 'annotations') {
        const set = b.s.manifest.tools.find((t) => t.name === 'set_note')
        expect(set).toMatchObject({ read_only: true, destructive: false }) // the write tool now claims to be read-only
        const read = b.s.manifest.tools.find((t) => t.name === 'read_note')
        expect(read).toMatchObject({ read_only: false, destructive: false }) // and the read tool lost its label
      }
    })
  }
  it('PROBE_DRIFT with generation 0 does not drift (the first scan is the baseline)', async () => {
    const a = await keyFor({})
    const b = await keyFor({ PROBE_DRIFT: 'csp', PROBE_GEN: '0' })
    expect(b.key).toBe(a.key)
  })
})

describe('apps-probe-server over HTTP', () => {
  const connectHttp = async (url: URL, headers?: Record<string, string>) => {
    const client = new Client({ name: 'probe-http', version: '1' }, { capabilities: {} })
    await client.connect(new StreamableHTTPClientTransport(url, headers ? { requestInit: { headers } } : {}))
    cleanups.push(() => client.close())
    return client
  }

  it('answers the same listing as stdio, so the direct path can be tested against it', async () => {
    const srv = await startHttp()
    const http = await connectHttp(srv.url)
    const { client } = await connectStdio()
    const a = (await http.listTools()).tools
    const b = (await client.listTools()).tools
    expect(a).toEqual(b)
  })

  it('a static bearer is required when PROBE_BEARER is set: no header, wrong header and right header', async () => {
    const srv = await startHttp({ PROBE_BEARER: 'test-bearer-value' })
    await expect(connectHttp(srv.url)).rejects.toThrow()
    await expect(connectHttp(srv.url, { Authorization: 'Bearer wrong' })).rejects.toThrow()
    const ok = await connectHttp(srv.url, { Authorization: 'Bearer test-bearer-value' })
    expect((await ok.listTools()).tools.length).toBeGreaterThan(0)
  })

  it('two servers at once keep their own generation (no shared state)', async () => {
    const [a, b] = await Promise.all([startHttp({ PROBE_DRIFT: 'csp' }), startHttp({ PROBE_DRIFT: 'csp' })])
    await fetch(`http://127.0.0.1:${b.port}/__gen/1`)
    const [ca, cb] = await Promise.all([connectHttp(a.url), connectHttp(b.url)])
    const [sa, sb] = await Promise.all([scan(ca), scan(cb)])
    expect(sa.csp.connect_domains).toEqual(['https://api.example.com'])
    expect(sb.csp.connect_domains).toEqual(['https://api.example.com', 'https://api2.example.com'])
  })

  it('many parallel calls to one server all return', async () => {
    const srv = await startHttp()
    const c = await connectHttp(srv.url)
    const rs = await Promise.all(
      Array.from({ length: 50 }, (_, i) => c.callTool({ name: 'read_note', arguments: { id: `n${i}` } })),
    )
    expect(rs.map((r) => (r.structuredContent as { id: string }).id)).toEqual(
      Array.from({ length: 50 }, (_, i) => `n${i}`),
    )
  })

  it('a server that dies mid-session fails the next call', async () => {
    const srv = await startHttp()
    const c = await connectHttp(srv.url)
    await c.listTools()
    srv.child.kill('SIGKILL')
    await new Promise((r) => (srv.child as ChildProcess).once('exit', r))
    await expect(c.callTool({ name: 'read_note', arguments: {} })).rejects.toThrow()
  })
})
