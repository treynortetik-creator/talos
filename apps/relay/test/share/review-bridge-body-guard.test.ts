// Review of PR #52 (F1 follow-up): every unauthenticated /bridge/* route that buffers a body must cap and time it BEFORE
// the signature is read, the way /bridge/post does. A chunked body that stalls past the cap gets 413 while it streams.
import { request } from 'node:http'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { startTestRelay, type TestRelay } from '../core/harness.ts'

vi.setConfig({ testTimeout: 30_000 })

let relay: TestRelay | null = null
afterEach(async () => {
  await relay?.stop()
  relay = null
})

/** An UNSIGNED chunked request that writes `bytes` and stalls. Resolves with the status, or 'no answer' after `ms`. */
function stalledChunked(
  r: TestRelay,
  method: string,
  path: string,
  bytes: number,
  ms = 3000,
): Promise<number | string> {
  const u = new URL(`${r.httpBase}${path}`)
  return new Promise((resolve) => {
    const req = request(
      { host: u.hostname, port: u.port, path: u.pathname, method, headers: { 'content-type': 'application/json' } },
      (res) => {
        clearTimeout(t)
        resolve(res.statusCode ?? 0)
        req.destroy()
      },
    )
    req.on('error', () => {})
    const t = setTimeout(() => {
      resolve('no answer')
      req.destroy()
    }, ms)
    req.write(Buffer.alloc(bytes, 0x61))
  })
}

describe('unsigned bodies on the auth bridge routes are capped while they stream', () => {
  for (const path of ['/bridge/enroll', '/bridge/rotate', '/bridge/devices/d_abcdefghijklmnopqrst/revoke']) {
    it(`POST ${path}: a stalled chunked body past 4 KiB gets 413`, async () => {
      relay = await startTestRelay()
      expect(await stalledChunked(relay, 'POST', path, 64 * 1024)).toBe(413)
    })
  }

  it('control: a small signed-shaped body still reaches the handler (401 unsigned, not 413)', async () => {
    relay = await startTestRelay()
    const res = await fetch(`${relay.httpBase}/bridge/enroll`, { method: 'POST', body: '{}' })
    expect(res.status).toBe(401)
  })
})
