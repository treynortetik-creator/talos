// Test cases for the guarded fetch against a hostile or stalled peer on a REAL local socket. Written once and run twice: by
// vitest (packages/protocol) and by `bun test` (apps/bridge), because the bridge only ever runs under Bun and a socket
// behaves differently there. Each runner passes in its own describe/it/expect.
import net from 'node:net'
import { createGuardedFetch } from '../../src/guarded-fetch.ts'

type Api = {
  describe: (name: string, fn: () => void) => void
  it: (name: string, fn: () => Promise<void>, timeoutMs?: number) => void
  // biome-ignore lint/suspicious/noExplicitAny: the matcher shape differs between vitest and bun:test
  expect: (v: unknown) => any
  beforeAll: (fn: () => Promise<void>) => void
  afterAll: (fn: () => Promise<void>) => void
}

export function defineHostileCases(api: Api): void {
  const { describe, it, expect, beforeAll, afterAll } = api
  let server: net.Server
  let port = 0
  const sockets = new Set<net.Socket>()
  let connections = 0
  const uncaught: unknown[] = []
  // one resolver per waiting test; the server calls it once the headers of /headers-then-silence are on the wire
  const headersWritten: Array<() => void> = []
  const waitForHeadersWritten = () => new Promise<void>((r) => void headersWritten.push(r))
  const onUncaught = (e: unknown) => void uncaught.push(e)

  // What the peer writes for a request line: keyed by path.
  const script: Record<string, (s: net.Socket) => void> = {
    '/999': (s) => s.end('HTTP/1.1 999 nope\r\ncontent-length: 0\r\n\r\n'),
    '/600': (s) => s.end('HTTP/1.1 600 nope\r\ncontent-length: 0\r\n\r\n'),
    '/199': (s) => s.end('HTTP/1.1 199 nope\r\ncontent-length: 0\r\n\r\n'),
    '/101': (s) => s.end('HTTP/1.1 101 Switching Protocols\r\nconnection: keep-alive\r\n\r\n'),
    '/599': (s) => s.end('HTTP/1.1 599 edge\r\ncontent-length: 2\r\n\r\nhi'),
    '/200': (s) => s.end('HTTP/1.1 200 ok\r\ncontent-length: 2\r\n\r\nhi'),
    '/cut': (s) => {
      s.write('HTTP/1.1 200 ok\r\ncontent-length: 100\r\n\r\nhello')
      setTimeout(() => s.destroy(), 20) // the peer vanishes after the headers were handed over
    },
    '/silent': () => {}, // accepts the request and never answers
    '/headers-then-silence': (s) => {
      s.write('HTTP/1.1 200 ok\r\ncontent-length: 100\r\n\r\nabc', () => headersWritten.shift()?.())
    },
  }

  beforeAll(async () => {
    process.on('uncaughtException', onUncaught)
    process.on('unhandledRejection', onUncaught)
    server = net.createServer((s) => {
      connections++
      sockets.add(s)
      s.on('close', () => sockets.delete(s))
      s.on('error', () => {})
      let buf = ''
      s.on('data', (c) => {
        buf += c.toString('latin1')
        const end = buf.indexOf('\r\n\r\n')
        if (end < 0) return
        const path = buf.split(' ')[1] ?? ''
        buf = ''
        script[path]?.(s)
      })
    })
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
    port = (server.address() as net.AddressInfo).port
  })
  afterAll(async () => {
    process.off('uncaughtException', onUncaught)
    process.off('unhandledRejection', onUncaught)
    for (const s of sockets) s.destroy()
    await new Promise((r) => server.close(r))
  })

  const f = (timeoutMs?: number) =>
    createGuardedFetch({
      resolve: async () => ['127.0.0.1'],
      allowLoopback: true,
      ...(timeoutMs !== undefined ? { timeoutMs } : {}),
    })
  const url = (p: string) => `http://peer.example.test:${port}${p}`
  const settle = async (p: Promise<unknown>) =>
    p.then(
      () => undefined,
      (e) => e as Error,
    )
  const turn = () => new Promise((r) => setTimeout(r, 30)) // let a stray async error surface before asserting none happened

  describe('a peer that answers with a status the Response class refuses', () => {
    for (const path of ['/999', '/600', '/199', '/101']) {
      it(`${path}: the fetch rejects with a readable error and the process stays alive`, async () => {
        const e = await settle(f()(url(path)))
        expect(e).toBeInstanceOf(Error)
        expect((e as Error).message.length).toBeGreaterThan(0) // the wording differs by runtime; the point is a rejection
        await turn()
        expect(uncaught).toEqual([])
      })
    }
    it('control: 200 and 599 are usable statuses, so the refusals above are about the status and not a dead peer', async () => {
      const a = await f()(url('/200'))
      expect(a.status).toBe(200)
      expect(await a.text()).toBe('hi')
      const b = await f()(url('/599'))
      expect(b.status).toBe(599)
      expect(await b.text()).toBe('hi')
    })
    it('twenty bad answers at once: all reject, none escapes', async () => {
      const r = await Promise.allSettled(
        Array.from({ length: 20 }, (_, i) => f()(url(['/999', '/101'][i % 2] as string))),
      )
      expect(r.every((x) => x.status === 'rejected')).toBe(true)
      await turn()
      expect(uncaught).toEqual([])
    })
  })

  describe('the peer breaks after the response was handed over', () => {
    it('the body read rejects (the owner sees the failure), and nothing is uncaught', async () => {
      const res = await f()(url('/cut'))
      expect(res.status).toBe(200)
      const e = await settle(res.text())
      expect(e).toBeInstanceOf(Error)
      await turn()
      expect(uncaught).toEqual([])
    })
  })

  describe('a stalled peer and a signal (nothing may wait forever)', () => {
    it('no answer at all: the fetch rejects with a TimeoutError once the overall limit passes', async () => {
      const e = await settle(f(50)(url('/silent')))
      expect((e as Error).name).toBe('TimeoutError')
    })
    it('headers then silence: reading the body rejects with a TimeoutError', async () => {
      // The limit covers the whole exchange, headers included, so it must be far longer than any slow runner needs to get
      // the headers; the test then waits out the silence. Nothing here is a race that load can win.
      const res = await f(2000)(url('/headers-then-silence'))
      const e = await settle(res.text())
      expect(e).toBeInstanceOf(Error)
      expect((e as Error).name).toBe('TimeoutError')
    }, 15000)
    it('an abort while waiting rejects at once', async () => {
      const ac = new AbortController()
      const p = settle(f(0)(url('/silent'), { signal: ac.signal }))
      await turn()
      ac.abort()
      const e = await p
      expect((e as Error).name).toBe('AbortError')
    })
    it('an abort after the headers errors the body read', async () => {
      const ac = new AbortController()
      const wrote = waitForHeadersWritten() // registered before the request, so the signal cannot be missed
      const res = await f(0)(url('/headers-then-silence'), { signal: ac.signal })
      const read = settle(res.text())
      await wrote // the server has written the headers and the first bytes; the body is now stalled
      ac.abort()
      expect(((await read) as Error).name).toBe('AbortError')
    })
    it('a signal that is already aborted rejects without opening a connection', async () => {
      const before = connections
      const e = await settle(f()(url('/200'), { signal: AbortSignal.abort() }))
      expect((e as Error).name).toBe('AbortError')
      await turn()
      expect(connections).toBe(before)
    })
    it('timeoutMs 0 means no limit: a normal request still completes', async () => {
      const res = await f(0)(url('/200'))
      expect(await res.text()).toBe('hi')
    })
  })
}
