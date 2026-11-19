// The bridge log said only when the relay socket CLOSED, so a bridge that had connected and authed looked like one that never
// got through (2026-11-19 incident). It also says when the socket opens (with the dial's attempt number) and when the relay
// accepts the hello (with how long that took), in order, across a close and a redial. No URLs, keys or frame text in them.
import { afterEach, expect, test } from 'bun:test'
import { Bridge } from '../src/bridge.ts'
import { createLogger } from '../src/log.ts'
import { type Harness, startHarness, waitFor } from './helpers.ts'

let h: Harness
afterEach(async () => h?.stop())

test('relay socket open and relay authed are logged, in order, across a close and a redial', async () => {
  h = await startHarness({ startBridge: false })
  const lines: string[] = []
  const b = await Bridge.create({
    env: h.bridge.ctx.env,
    logger: createLogger(null, 'info', (l) => lines.push(l)),
    random: () => 0,
    inbound: { settleMs: 10 },
  })
  b.setEmit(async () => {})
  b.start()
  try {
    const events = () =>
      lines
        .map((l) => JSON.parse(l) as { msg: string; level: string; attempt?: number; after_ms?: number })
        .filter((l) => l.msg.startsWith('relay socket') || l.msg === 'relay authed')
    await waitFor(() => events().some((e) => e.msg === 'relay authed'), 5000, 'the first authed line')
    h.relay.dropBridge()
    await waitFor(() => events().filter((e) => e.msg === 'relay authed').length === 2, 8000, 'the second authed line')
    const ev = events()
    expect(ev.map((e) => e.msg)).toEqual([
      'relay socket open',
      'relay authed',
      'relay socket closed',
      'relay socket open',
      'relay authed',
    ])
    expect(ev.every((e) => e.level === 'info')).toBe(true)
    expect(ev[0]?.attempt).toBe(0)
    expect(typeof ev[1]?.after_ms).toBe('number')
    expect(ev[1]?.after_ms as number).toBeGreaterThanOrEqual(0)
    expect(ev[3]?.attempt).toBeGreaterThanOrEqual(0)
    // nothing that could carry a secret or the relay's address
    const text = lines.filter((l) => l.includes('relay socket') || l.includes('relay authed')).join('')
    expect(text).not.toContain('127.0.0.1')
    expect(text).not.toContain('ws://')
  } finally {
    await b.stop()
  }
})
