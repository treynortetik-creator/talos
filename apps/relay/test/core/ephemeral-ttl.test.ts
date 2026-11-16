// How long the relay waits for the Mac's answer to a signed request (core/ephemeral.ts): 30 s for a read, longer for a
// route that says so. An upload into a thread's folder (`files.put`) waits FILES_PUT_ANSWER_MS, because the Mac fetches the
// file before it answers; an answer past 30 s still reaches the asker there, and is dropped for a plain read.
import { FILES_PUT_ANSWER_MS } from '@talos-app/protocol'
import { describe, expect, it } from 'vitest'
import { EPHEMERAL_TTL_MS, EphemeralRouter } from '../../src/core/ephemeral.ts'

function router() {
  let t = 1_000_000
  const sent: Array<Record<string, unknown>> = []
  const r = new EphemeralRouter({
    clock: { now: () => t, setTimeout: () => 0, clearTimeout: () => {} },
    log: { info() {}, warn() {}, error() {}, debug() {} } as never,
    bridgeOnline: () => true,
    sendBridge: () => {},
    sendToApp: (_s, raw) => {
      sent.push(raw)
      return true
    },
    appError: () => {},
  })
  return { r, sent, later: (ms: number) => (t += ms) }
}

describe('how long a signed request waits for its answer', () => {
  it('an upload waits two minutes; a read is forgotten after 30 s', () => {
    const { r, sent, later } = router()
    r.register('files.put', 'files.put_result', null, FILES_PUT_ANSWER_MS)
    r.register('files.list', 'files.listing')
    r.onRequest('s1', { id: 'f1', type: 'files.put', request_id: 'r1' }, {})
    r.onRequest('s1', { id: 'f2', type: 'files.list', request_id: 'r2' }, {})
    later(EPHEMERAL_TTL_MS + 1000)
    r.onResponse({ type: 'files.put_result', request_id: 'r1' }, { type: 'files.put_result', request_id: 'r1' })
    r.onResponse({ type: 'files.listing', request_id: 'r2' }, { type: 'files.listing', request_id: 'r2' })
    expect(sent.map((s) => s.type)).toEqual(['files.put_result'])
    expect(FILES_PUT_ANSWER_MS).toBeGreaterThan(EPHEMERAL_TTL_MS)
  })
})
