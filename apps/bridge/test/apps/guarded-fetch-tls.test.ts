// The transport behind every real `talos-app apps login`, run under Bun (the bridge's only runtime) against a real local TLS
// server with a self-signed certificate. Under Bun, node:https is not node's own client, so TLS to a pinned address, the
// request body, a redirect and a streamed body are each proven here instead of assumed from the vitest run.
import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { type ChildProcess, execFileSync, spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import https from 'node:https'
import net, { type AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { TLSSocket } from 'node:tls'

const CLIENT = join(import.meta.dir, 'fixtures', 'guarded-tls-client.ts')
const dir = mkdtempSync(join(tmpdir(), 'guarded-tls-'))

function makeCert(name: string, file: string) {
  const key = join(dir, `${file}.key.pem`)
  const crt = join(dir, `${file}.crt.pem`)
  execFileSync(
    'openssl',
    [
      'req',
      '-x509',
      '-newkey',
      'ec',
      '-pkeyopt',
      'ec_paramgen_curve:prime256v1',
      '-nodes',
      '-subj',
      `/CN=${name}`,
      '-addext',
      `subjectAltName=DNS:${name}`,
      '-days',
      '2',
      '-keyout',
      key,
      '-out',
      crt,
    ],
    { stdio: 'pipe' },
  )
  return { key: readFileSync(key), cert: readFileSync(crt), crt }
}

type Seen = {
  servername: string | false
  remote: string | undefined
  req: string
  body: string
  ctype: string | undefined
}
let seen: Seen[] = []
let sni: Array<string | undefined> = []

/** The host_name in a TLS ClientHello's server_name extension, or undefined when there is none. */
function sniOf(b: Buffer): string | undefined {
  try {
    let p = 5 + 4 + 2 + 32 // record header, handshake header, version, random
    p += 1 + b[p] // session id
    p += 2 + b.readUInt16BE(p) // cipher suites
    p += 1 + b[p] // compression
    const end = p + 2 + b.readUInt16BE(p)
    p += 2
    while (p + 4 <= end) {
      const type = b.readUInt16BE(p)
      const len = b.readUInt16BE(p + 2)
      if (type === 0) return b.subarray(p + 9, p + 4 + len).toString('latin1') // list length(2) type(1) name length(2) then the name
      p += 4 + len
    }
  } catch {}
  return undefined
}

function startServer(c: { key: Buffer; cert: Buffer }) {
  let release: () => void = () => {}
  const released = new Promise<void>((r) => (release = r))
  const server = https.createServer(
    {
      key: c.key,
      cert: c.cert,
    },
    (req, res) => {
      const chunks: Buffer[] = []
      req.on('data', (d: Buffer) => chunks.push(d))
      req.on('end', () => {
        const s = req.socket as TLSSocket
        seen.push({
          servername: (s as unknown as { servername?: string | false }).servername ?? false,
          remote: s.remoteAddress,
          req: `${req.method} ${req.url}`,
          body: Buffer.concat(chunks).toString(),
          ctype: req.headers['content-type'],
        })
        if (req.url === '/hello') return void res.writeHead(200, { 'content-type': 'text/plain' }).end('hello over tls')
        if (req.url === '/token')
          return void res.writeHead(200, { 'content-type': 'application/json' }).end('{"access_token":"t"}')
        if (req.url === '/redir') return void res.writeHead(302, { location: '/final' }).end()
        if (req.url === '/final') return void res.writeHead(200).end('arrived')
        if (req.url === '/release') {
          release()
          return void res.writeHead(200).end('released')
        }
        if (req.url === '/stream') {
          res.writeHead(200, { 'content-type': 'text/plain' })
          res.write('one')
          void released.then(() => res.end('two'))
          return
        }
        res.writeHead(404).end()
      })
    },
  )
  // A plain TCP front reads the first bytes of each connection (the TLS ClientHello), notes the server name in it, and hands
  // the connection on to the TLS server untouched. Bun's own TLS server does not report the name, so it is read off the wire.
  const socks = new Set<net.Socket>()
  const front = net.createServer((sock) => {
    socks.add(sock)
    sock.on('error', () => {})
    sock.once('data', (buf) => {
      sni.push(sniOf(buf))
      const inner = net.connect((server.address() as AddressInfo).port, '127.0.0.1', () => {
        inner.write(buf)
        sock.pipe(inner)
        inner.pipe(sock)
      })
      socks.add(inner)
      inner.on('error', () => sock.destroy())
      sock.on('close', () => inner.destroy())
      inner.on('close', () => sock.destroy())
    })
  })
  return new Promise<{ port: number; close: () => Promise<void> }>((ok) =>
    server.listen(0, '127.0.0.1', () =>
      front.listen(0, '127.0.0.1', () =>
        ok({
          port: (front.address() as AddressInfo).port,
          close: () =>
            new Promise<void>((r) => {
              for (const s of socks) s.destroy()
              server.closeAllConnections()
              server.close(() => front.close(() => r()))
            }),
        }),
      ),
    ),
  )
}

function runClient(env: Record<string, string>): Promise<{ code: number | null; out: string; err: string }> {
  return new Promise((ok) => {
    const child: ChildProcess = spawn(process.execPath, [CLIENT], {
      env: { PATH: process.env.PATH ?? '', ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let out = ''
    let err = ''
    child.stdout?.on('data', (d) => (out += d))
    child.stderr?.on('data', (d) => (err += d))
    child.on('close', (code) => ok({ code, out, err }))
  })
}

let good: ReturnType<typeof makeCert>
let other: ReturnType<typeof makeCert>
beforeAll(() => {
  mkdirSync(dir, { recursive: true })
  good = makeCert('mcp.example.test', 'good')
  other = makeCert('other.example.test', 'other')
})
afterAll(() => rmSync(dir, { recursive: true, force: true }))

describe('guarded fetch over real TLS under Bun', () => {
  it('connects to the pinned address with the NAME as servername, sends a token POST body, hands back a redirect, streams a body', async () => {
    seen = []
    sni = []
    const srv = await startServer(good)
    try {
      const r = await runClient({
        TLS_HOST: 'mcp.example.test',
        TLS_PORT: String(srv.port),
        TLS_MODE: 'full',
        NODE_EXTRA_CA_CERTS: good.crt,
      })
      expect(r.err).toBe('')
      expect(r.code).toBe(0)
      const o = JSON.parse(r.out)
      expect(o.get).toEqual({ status: 200, body: 'hello over tls' })
      expect(o.post).toEqual({ status: 200, body: '{"access_token":"t"}' })
      expect(o.redir).toEqual({ status: 302, location: '/final', nextStatus: 200, nextBody: 'arrived' })
      // streamed: the first chunk arrived while the server was still holding the response open (it only finishes after /release)
      expect(o.stream).toEqual({ first: 'one', rest: 'two' })
      expect(o.asked.every((h: string) => h === 'mcp.example.test')).toBe(true)
      // what the server saw: the name as SNI, the pinned address as the peer, the body and type byte for byte
      expect(seen.length).toBeGreaterThanOrEqual(6)
      expect(sni.length).toBeGreaterThan(0)
      expect(sni.every((n) => n === 'mcp.example.test')).toBe(true)
      const tok = seen.find((s) => s.req === 'POST /token')
      expect(tok?.body).toBe('grant_type=authorization_code&code=a+b%26c')
      expect(tok?.ctype).toBe('application/x-www-form-urlencoded')
    } finally {
      await srv.close()
    }
  })

  it('control: the certificate must be trusted. Without it the same request fails, so verification is on', async () => {
    seen = []
    sni = []
    const srv = await startServer(good)
    try {
      const r = await runClient({ TLS_HOST: 'mcp.example.test', TLS_PORT: String(srv.port), TLS_MODE: 'single' })
      const o = JSON.parse(r.out)
      expect(o.ok).toBe(false)
      expect(seen).toEqual([]) // no request was ever served over an unverified connection
    } finally {
      await srv.close()
    }
  })

  it('a trusted certificate for a DIFFERENT name is refused: the name is verified, not the address', async () => {
    seen = []
    sni = []
    const srv = await startServer(other)
    try {
      const r = await runClient({
        TLS_HOST: 'mcp.example.test',
        TLS_PORT: String(srv.port),
        TLS_MODE: 'single',
        NODE_EXTRA_CA_CERTS: other.crt,
      })
      const o = JSON.parse(r.out)
      expect(o.ok).toBe(false)
      expect(seen).toEqual([])
    } finally {
      await srv.close()
    }
  })
})
