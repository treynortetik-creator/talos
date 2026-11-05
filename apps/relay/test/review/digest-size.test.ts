// Bughunt C: a digest must fit in a frame. 200 events at their full field sizes are over 256 KiB, which the Mac refuses
// as unparseable (no id, so no ack), and the relay resends forever. The digest is capped by bytes, not only by count.
import { MAX_FRAME_BYTES, newId } from '@talos-app/protocol'
import { afterEach, describe, expect, it } from 'vitest'
import { resetAuthImplementation } from '../../src/auth/contract.ts'
import { buildDigestBody } from '../../src/hooks/digest.ts'
import type { EventRow } from '../../src/hooks/types.ts'
import { setup } from '../hooks/harness.ts'

afterEach(() => resetAuthImplementation())

function bigRow(i: number, priority: 'high' | 'normal' | 'low'): EventRow {
  const id = newId('e')
  const event = {
    id,
    source: 'generic',
    connection: 'cn_AAAAAAAAAAAAAAAAAAAAAA',
    kind: 'generic.event',
    title: `Event ${i} `.padEnd(200, 't'),
    summary: 's'.repeat(280),
    url: `https://example.com/${'p'.repeat(600)}`,
    actor: { name: 'a'.repeat(120) },
    ts: new Date().toISOString(),
    thread: 'inbox',
    work: false,
    priority,
    dedup_key: `generic:${i}:${'d'.repeat(200)}`,
  }
  return {
    event_id: id,
    conn_id: 'cn_AAAAAAAAAAAAAAAAAAAAAA',
    integration: 'generic',
    thread: 'inbox',
    priority,
    work: 0,
    ts: event.ts,
    event_json: JSON.stringify(event),
    created_at: i,
  } as EventRow
}

describe('hook.digest size', () => {
  it('200 full-size events fit in one frame and say how many were left out', () => {
    const s = setup()
    const rows = Array.from({ length: 200 }, (_, i) => bigRow(i, i % 10 === 0 ? 'high' : 'normal'))
    const body = buildDigestBody(s.rt, rows, { start: 0, end: 1 })
    const frame = { v: 1, type: 'hook.digest', id: newId('e'), ts: new Date().toISOString(), ...body }
    expect(Buffer.byteLength(JSON.stringify(frame))).toBeLessThan(MAX_FRAME_BYTES - 8 * 1024)
    expect(body.events.length).toBeLessThanOrEqual(200)
    const highs = body.events.filter((e) => e.priority === 'high')
    expect(highs).toHaveLength(20) // a high-priority item is never the one left out
    expect(body.events.at(-1)?.title).toMatch(/^\+\d+ more/)
    expect(body.events.some((e) => e.summary.startsWith('s'.repeat(10)))).toBe(true)
  })

  it('a small digest is untouched', () => {
    const s = setup()
    const rows = Array.from({ length: 5 }, (_, i) => bigRow(i, 'normal'))
    expect(buildDigestBody(s.rt, rows, { start: 0, end: 1 }).events).toHaveLength(5)
  })
})

describe('a digest sent straight to the Mac', () => {
  it('is trimmed to fit a frame by the hub, whoever built it', async () => {
    const { startRealRelay } = await import('./real-relay.ts')
    const r = await startRealRelay()
    try {
      const bridge = await r.bridge().connect()
      const events = Array.from({ length: 200 }, (_, i) =>
        JSON.parse(bigRow(i, i % 10 === 0 ? 'high' : 'low').event_json),
      )
      const now = new Date().toISOString()
      await r.relay.services.bus.toBridge(
        {
          type: 'hook.digest',
          window: { start: now, end: now },
          threads: [{ thread_id: 'inbox', counts: { generic: 200 } }],
          events,
        },
        { durable: true },
      )
      const got = await bridge.expectFrame('hook.digest', () => true, { timeoutMs: 5000 })
      const rec = bridge.rec.frames.find((f) => f.frame.type === 'hook.digest')
      expect(Buffer.byteLength(rec?.text ?? '')).toBeLessThan(MAX_FRAME_BYTES)
      expect(got.events.filter((e) => e.priority === 'high')).toHaveLength(20)
      expect(got.events.at(-1)?.title).toMatch(/^\+\d+ more/)
    } finally {
      await r.stop()
    }
  })
})
