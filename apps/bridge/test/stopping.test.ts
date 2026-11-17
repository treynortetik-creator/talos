// The read_inbound write tracking of stopping.ts: a response counts as written only when the transport took it, and a
// cancelled request leaves nothing to wait for. (server.ts wires these to the real MCP transport.)
import { describe, expect, test } from 'bun:test'
import { PendingResults, trackWrites } from '../src/stopping.ts'

const fakeTransport = (fail = false) => {
  const sent: unknown[] = []
  return {
    sent,
    async send(message: unknown) {
      if (fail) throw new Error('the pipe is closed')
      sent.push(message)
    },
  }
}

describe('trackWrites', () => {
  test('a response that was written is reported, and only a response', async () => {
    const t = fakeTransport()
    const written: Array<string | number> = []
    trackWrites(t as never, (id) => written.push(id))
    await t.send({ jsonrpc: '2.0', method: 'notifications/claude/channel', params: {} }) // a notification: no id
    await t.send({ jsonrpc: '2.0', id: 7, method: 'ping' }) // a request of ours: an id, no result
    await t.send({ jsonrpc: '2.0', id: 8, result: { content: [] } })
    await t.send({ jsonrpc: '2.0', id: 9, error: { code: -32000, message: 'no' } })
    expect(written).toEqual([8, 9])
    expect(t.sent).toHaveLength(4) // everything still went through
  })

  test('a write that failed is not reported as written, and the error still reaches the caller', async () => {
    const t = fakeTransport(true)
    const written: Array<string | number> = []
    trackWrites(t as never, (id) => written.push(id))
    await expect(t.send({ jsonrpc: '2.0', id: 8, result: {} })).rejects.toThrow('closed')
    expect(written).toEqual([])
  })
})

describe('PendingResults', () => {
  test('stop waits for a response that was neither written nor cancelled, and only up to its cap', async () => {
    const r = new PendingResults()
    r.add('a')
    const t0 = Date.now()
    await r.settled(150)
    expect(Date.now() - t0).toBeGreaterThanOrEqual(100)
  })

  test('a written response and a cancelled request leave nothing to wait for', async () => {
    const r = new PendingResults()
    r.add(1)
    r.add(2)
    r.written(1)
    r.cancelled(2)
    const t0 = Date.now()
    await r.settled(5000)
    expect(Date.now() - t0).toBeLessThan(1000) // not the 5 s cap
  })
})
