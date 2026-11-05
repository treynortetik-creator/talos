// Gate G7, on the REAL reference views (MCP-APPS-SPEC M6.5): the two views the MCP Apps SDK authors ship, read from the real
// servers over stdio, served the way /media/:id/app serves a page (`sandbox allow-scripts` + buildAppCsp from the catalog's
// own policy, the inline scripts pinned by hash) inside the same iframe attributes the app uses. Runs in Chromium (desktop and
// Pixel) and WebKit (iPhone). The earlier gate used a surrogate page; this is the check on the real files.
import { type ChildProcess, spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { join } from 'node:path'
import { expect, type Page, test } from '@playwright/test'
import { type AppCspT, buildAppCsp, fromSpecCsp } from '@talos-app/protocol'

const ROOT = join(import.meta.dirname, '..', '..', '..', '..')
const REF = (pkg: string) => join(ROOT, 'e2e', 'node_modules', '@modelcontextprotocol', pkg, 'dist', 'index.js')
const VIEWS = [
  { name: 'server-basic-vanillajs', pkg: 'server-basic-vanillajs', uri: 'ui://get-time/mcp-app.html' },
  { name: 'server-system-monitor', pkg: 'server-system-monitor', uri: 'ui://system-monitor/mcp-app.html' },
] as const

/** `resources/read` over stdio, by hand (newline-delimited JSON-RPC), so this package needs no MCP client. */
async function readView(
  pkg: string,
  uri: string,
): Promise<{ html: string; csp: AppCspT | undefined; problems: unknown[] }> {
  const child: ChildProcess = spawn(process.execPath, [REF(pkg), '--stdio'], {
    stdio: ['pipe', 'pipe', 'ignore'],
    env: { PATH: process.env.PATH ?? '' },
  })
  try {
    const answers = new Map<number, (m: Record<string, unknown>) => void>()
    let buf = ''
    child.stdout?.on('data', (d) => {
      buf += String(d)
      for (let nl = buf.indexOf('\n'); nl >= 0; nl = buf.indexOf('\n')) {
        const line = buf.slice(0, nl)
        buf = buf.slice(nl + 1)
        try {
          const m = JSON.parse(line) as { id?: number }
          if (m.id !== undefined) answers.get(m.id)?.(m as Record<string, unknown>)
        } catch {
          // not a message
        }
      }
    })
    const call = (id: number, method: string, params: unknown) =>
      new Promise<Record<string, unknown>>((resolve, reject) => {
        const t = setTimeout(() => reject(new Error(`${method} timed out`)), 15_000)
        answers.set(id, (m) => {
          clearTimeout(t)
          resolve(m)
        })
        child.stdin?.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`)
      })
    await call(1, 'initialize', {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'g7', version: '1' },
    })
    child.stdin?.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`)
    const res = (await call(2, 'resources/read', { uri })) as {
      result?: { contents: Array<{ text?: string; _meta?: { ui?: { csp?: unknown } } }> }
    }
    const item = res.result?.contents[0]
    if (!item?.text) throw new Error(`no HTML from ${pkg}: ${JSON.stringify(res).slice(0, 300)}`)
    const parsed = fromSpecCsp(item._meta?.ui?.csp)
    return { html: item.text, csp: parsed.csp, problems: parsed.problems }
  } finally {
    child.kill('SIGKILL')
  }
}

/** The sha256 of every inline script, the way the scan pins them (an external `src=` script is not inline). */
function inlineScriptHashes(html: string): string[] {
  const out: string[] = []
  for (const m of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)) {
    if (/\bsrc\s*=/.test(m[1] ?? '')) continue
    out.push(
      `sha256-${createHash('sha256')
        .update(m[2] ?? '')
        .digest('base64')}`,
    )
  }
  return out
}

let server: Server
let base = ''
const pages = new Map<string, { html: string; csp: string }>()

test.beforeAll(async () => {
  server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://x')
    if (url.pathname === '/host') {
      const src = url.searchParams.get('src') ?? ''
      res.setHeader('content-type', 'text/html')
      // the host side of the contract: the app's iframe attributes, and a recorder for everything the view posts up
      res.end(`<!doctype html><body><iframe id="v" title="view" sandbox="allow-scripts" referrerpolicy="no-referrer" style="width:600px;height:400px" src="${src}"></iframe>
<script>window.__msgs=[];addEventListener('message',e=>{window.__msgs.push(e.data)})</script></body>`)
      return
    }
    const p = pages.get(url.pathname)
    if (!p) {
      res.statusCode = 404
      res.end('no')
      return
    }
    res.setHeader('content-type', 'text/html')
    res.setHeader('content-security-policy', p.csp)
    res.end(p.html)
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})
test.afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()))
})

const methods = (page: Page) =>
  page.evaluate(() =>
    (window as unknown as { __msgs: Array<{ method?: string }> }).__msgs.map((m) => m?.method ?? '').filter(Boolean),
  )

for (const v of VIEWS) {
  test.describe(v.name, () => {
    let html = ''
    let csp: AppCspT
    test.beforeAll(async () => {
      const r = await readView(v.pkg, v.uri)
      expect(r.problems).toEqual([]) // the declared policy is one the scan would accept
      html = r.html
      csp = { ...(r.csp as AppCspT), script_hashes: inlineScriptHashes(html) }
      expect(csp.script_hashes.length).toBeGreaterThan(0)
    })
    const serve = (path: string, body: string, policy: AppCspT) =>
      pages.set(`/${path}`, { html: body, csp: `sandbox allow-scripts; ${buildAppCsp(policy)}` })
    const open = async (page: Page, path: string) => {
      await page.goto(`${base}/host?src=/${path}`)
    }

    test('the hash-pinned real view runs under the exact policy and starts its handshake', async ({ page }) => {
      serve(`${v.name}-ok`, html, csp)
      await open(page, `${v.name}-ok`)
      await expect.poll(() => methods(page), { timeout: 15_000 }).toContain('ui/initialize')
    })

    test('control: the same page with its hash left out does not start (the hash is what lets it run)', async ({
      page,
    }) => {
      serve(`${v.name}-nohash`, html, { ...csp, script_hashes: [] })
      await open(page, `${v.name}-nohash`)
      await page.waitForTimeout(1500)
      expect(await methods(page)).not.toContain('ui/initialize')
    })

    test('an inline script that is not pinned, and an inline handler, are blocked on the same page', async ({
      page,
    }) => {
      const hostile = html.replace(
        '</body>',
        `<script>parent.postMessage({marker:'unpinned'},'*')</script><img src="x" onerror="parent.postMessage({marker:'handler'},'*')"></body>`,
      )
      expect(hostile).not.toBe(html) // the view has a body to inject into
      serve(`${v.name}-hostile`, hostile, csp)
      const seen: string[] = []
      page.on('console', (m) => seen.push(m.text()))
      await open(page, `${v.name}-hostile`)
      await expect.poll(() => methods(page), { timeout: 15_000 }).toContain('ui/initialize') // the pinned script still ran
      await page.waitForTimeout(800)
      const markers = await page.evaluate(() =>
        (window as unknown as { __msgs: Array<{ marker?: string }> }).__msgs.map((m) => m?.marker).filter(Boolean),
      )
      expect(markers).toEqual([])
      expect(seen.join('\n')).toMatch(/Content Security Policy|content-security-policy/i)
    })

    test('even a pinned script in the real page has no parent, storage, cookies or network beyond its policy', async ({
      page,
    }) => {
      // the worst case: the owner approved this page, and the page is hostile. Its extra script is pinned too, so it runs.
      const script = `(async()=>{const r={};try{parent.document.cookie;r.parent='reachable'}catch(e){r.parent=e.name}
try{localStorage.getItem('x');r.storage='reachable'}catch(e){r.storage=e.name}
try{document.cookie='a=1';r.cookie=document.cookie===''?'empty':'set'}catch(e){r.cookie=e.name}
try{await fetch('${base}/secret');r.fetch='reached'}catch(e){r.fetch='blocked'}
try{await fetch('https://undeclared.example.net/x');r.fetch2='reached'}catch(e){r.fetch2='blocked'}
parent.postMessage({marker:'report',r},'*')})()`
      const hostile = html.replace('</body>', `<script>${script}</script></body>`)
      expect(hostile).not.toBe(html)
      serve(`${v.name}-pinned`, hostile, { ...csp, script_hashes: inlineScriptHashes(hostile) })
      pages.set('/secret', { html: 'secret', csp: "default-src 'none'" })
      await open(page, `${v.name}-pinned`)
      await expect
        .poll(
          () =>
            page.evaluate(() =>
              (window as unknown as { __msgs: Array<{ marker?: string }> }).__msgs.some((m) => m?.marker === 'report'),
            ),
          { timeout: 15_000 },
        )
        .toBe(true)
      const report = await page.evaluate(
        () =>
          (window as unknown as { __msgs: Array<{ marker?: string; r?: Record<string, string> }> }).__msgs.find(
            (m) => m?.marker === 'report',
          )?.r,
      )
      expect(report?.parent).toBe('SecurityError')
      expect(report?.storage).toBe('SecurityError')
      expect(report?.cookie).not.toBe('set')
      expect(report).toMatchObject({ fetch: 'blocked', fetch2: 'blocked' })
    })
  })
}
