// AP0's reference-server checks (MCP-APPS-SPEC M6.1): the two real npm servers (MCP SDK v2 inside) listed by this repo's
// pinned MCP SDK 1.32.2 client, their `_meta.ui` as the spec says, their views' mime type, and the system monitor's HTTP
// mode recorded: no `--stdio` flag gives Streamable HTTP at /mcp on PORT (default 3001), stateless.
import { type ChildProcess, spawn } from 'node:child_process'
import { createServer } from 'node:net'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { fromSpecCsp } from '@talos-app/protocol'
import { afterEach, describe, expect, it } from 'vitest'

const here = dirname(fileURLToPath(import.meta.url))
// devDependencies of e2e (pnpm links them under e2e/node_modules); the package `exports` do not expose a path, so go by directory
const dist = (pkg: string) => join(here, '..', '..', '..', 'e2e', 'node_modules', pkg, 'dist', 'index.js')
const BASIC = dist('@modelcontextprotocol/server-basic-vanillajs')
const MONITOR = dist('@modelcontextprotocol/server-system-monitor')

const cleanups: Array<() => Promise<void> | void> = []
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()?.()
})
type Ui = { resourceUri?: string; visibility?: string[] }
const uiOf = (t: { _meta?: unknown }) => (t._meta as { ui?: Ui } | undefined)?.ui

async function stdio(script: string) {
  const c = new Client({ name: 'ref-test', version: '1' }, { capabilities: {} })
  await c.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: [script, '--stdio'],
      env: { PATH: process.env.PATH ?? '' },
      stderr: 'pipe',
    }),
  )
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

describe('reference servers through the 1.32.2 client', () => {
  it('server-basic-vanillajs: get-time declares a view, has no annotations', async () => {
    const c = await stdio(BASIC)
    const t = (await c.listTools()).tools.find((x) => x.name === 'get-time')
    expect(uiOf(t as never)?.resourceUri).toMatch(/^ui:\/\//)
    expect(t?.annotations).toBeUndefined()
    const res = await c.readResource({ uri: uiOf(t as never)?.resourceUri as string })
    const item = res.contents[0] as { mimeType?: string; _meta?: { ui?: { csp?: unknown } } }
    expect(item.mimeType).toBe('text/html;profile=mcp-app')
    expect(fromSpecCsp(item._meta?.ui?.csp).problems).toEqual([])
  })
  it('server-system-monitor: get-system-info shows the view, poll-system-stats is visibility ["app"] with no annotations', async () => {
    const c = await stdio(MONITOR)
    const tools = (await c.listTools()).tools
    expect(uiOf(tools.find((t) => t.name === 'get-system-info') as never)?.resourceUri).toBe(
      'ui://system-monitor/mcp-app.html',
    )
    const poll = tools.find((t) => t.name === 'poll-system-stats')
    expect(uiOf(poll as never)?.visibility).toEqual(['app'])
    expect(poll?.annotations).toBeUndefined()
  })
  it("the system monitor's HTTP mode (recorded): /mcp on PORT, stateless, nothing else answers", async () => {
    const port = await freePort()
    const child: ChildProcess = spawn(process.execPath, [MONITOR], {
      env: { PATH: process.env.PATH ?? '', PORT: String(port) },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    cleanups.push(() => void child.kill('SIGKILL'))
    await new Promise<void>((resolve, reject) => {
      child.stdout?.on('data', (d) => /listening on http:\/\/localhost:\d+\/mcp/.test(String(d)) && resolve())
      child.on('exit', () => reject(new Error('monitor exited')))
    })
    const c = new Client({ name: 'ref-http', version: '1' }, { capabilities: {} })
    const t = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`))
    await c.connect(t)
    cleanups.push(() => c.close())
    expect(t.sessionId).toBeUndefined() // stateless: no Mcp-Session-Id
    expect((await c.listTools()).tools.map((x) => x.name).sort()).toEqual(['get-system-info', 'poll-system-stats'])
    expect((await fetch(`http://127.0.0.1:${port}/elsewhere`)).status).toBe(404)
  })
})
