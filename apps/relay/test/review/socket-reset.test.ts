// Bughunt D: a refused WebSocket upgrade answered by a TCP reset must not take the relay process down. The raw socket had
// no 'error' listener (node removes the HTTP server's on 'upgrade'), so ECONNRESET was an uncaught exception.
import net from 'node:net'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { type RealRelay, startRealRelay } from './real-relay.ts'

vi.setConfig({ testTimeout: 20_000 })

let r: RealRelay | null = null
afterEach(async () => {
  await r?.stop()
  r = null
})

function refusedUpgradeThenReset(port: number, path: string, headers: Record<string, string>): Promise<string> {
  return new Promise((resolve) => {
    const s = net.connect(port, '127.0.0.1', () => {
      const extra = Object.entries(headers)
        .map(([k, v]) => `${k}: ${v}\r\n`)
        .join('')
      s.write(
        `GET ${path} HTTP/1.1\r\nHost: relay.example.com\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n` +
          `Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n${extra}\r\n`,
      )
    })
    s.once('data', (d) => {
      const line = d.toString().split('\r\n')[0] ?? ''
      s.resetAndDestroy()
      resolve(line)
    })
    s.on('error', () => {})
  })
}

describe('a reset after a refused upgrade', () => {
  it.each([
    ['foreign Origin', '/ws', { Origin: 'https://evil.example' }, '403'],
    ['no cookie', '/ws', { Origin: 'https://relay.example.com' }, '401'],
  ])('(%s) does not crash the relay', async (_n, path, headers, status) => {
    const uncaught: unknown[] = []
    const onErr = (e: unknown) => uncaught.push(e)
    process.on('uncaughtException', onErr)
    try {
      r = await startRealRelay()
      const line = await refusedUpgradeThenReset(r.relay.port, path, headers)
      expect(line).toContain(status)
      await new Promise((res) => setTimeout(res, 300))
      expect(uncaught).toEqual([])
      expect((await fetch(`${r.httpBase}/healthz`)).ok).toBe(true)
    } finally {
      process.off('uncaughtException', onErr)
    }
  })
})
