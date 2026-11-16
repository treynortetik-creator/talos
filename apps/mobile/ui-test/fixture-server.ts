// A throwaway origin for the iPhone shell's UI tests (docs/ios.md "UI tests"). The shell loads ONE origin, fixed at build time from
// TALOS_RELAY_URL; ui-test.sh builds it with http://127.0.0.1:<port> and starts this server on that port. It serves the composer
// fixture page at "/" and "/offline.html" (the shell's own offline page is bundled, so that path is never asked of us) and
// answers 404 to everything else. It binds loopback only, never reads the owner's Talos home, and holds no data.
import { readFileSync } from 'node:fs'
import { createServer } from 'node:http'

const port = Number(process.argv[2] ?? process.env.TALOS_UITEST_PORT ?? 0)
if (!Number.isInteger(port) || port < 1024 || port > 65535) {
  console.error('usage: node fixture-server.ts <port 1024-65535>')
  process.exit(2)
}
const page = readFileSync(new URL('./composer-fixture.html', import.meta.url))

const server = createServer((req, res) => {
  const path = (req.url ?? '/').split('?')[0]
  if (path === '/' || path === '/index.html') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
    res.end(page)
  } else {
    res.writeHead(404, { 'content-type': 'text/plain' })
    res.end('not found')
  }
})
server.listen(port, '127.0.0.1', () => console.log(`fixture on http://127.0.0.1:${port}`))
for (const sig of ['SIGINT', 'SIGTERM'] as const) process.on(sig, () => server.close(() => process.exit(0)))
