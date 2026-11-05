// A history request id is good once, whichever side answers it: the relay serves scroll-back by seq from its own buffer,
// and a captured request sent again (same id) must be refused there too, not only where the Mac answers.
import { newUlid } from '@talos-app/protocol'
import { mkFrame, sleep } from '@talos-app/testkit'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { startTestRelay, type TestRelay } from './harness.ts'
import { kit } from './helpers.ts'

vi.setConfig({ testTimeout: 20_000 })

describe('history requests are single-use at the relay', () => {
  let relay: TestRelay
  beforeEach(async () => {
    relay = await startTestRelay()
  })
  afterEach(async () => {
    await relay.stop()
  })

  it('a seq-paged request answered from the buffer is refused the second time, with no page', async () => {
    const k = kit(relay)
    const a = await k.connectedApp()
    const b = await k.connectedApp() // the replaying socket: same owner device, a new connection
    const bridge = await k.bridge({ autoReply: false, verifyOwner: false }).connect()
    for (let i = 0; i < 3; i++) bridge.reply('general', `r${i}`)
    await bridge.expectFrame('ack', (f) => f.seq === 3, { direction: 'in' })
    const req = await a.sign({
      ...mkFrame('history.request'),
      request_id: newUlid(),
      thread_id: 'general',
      limit: 2,
    })
    a.send(req)
    await a.expectFrame('history.page', (f) => f.request_id === req.request_id)
    b.send(req)
    const refused = await b.expectFrame('error', (f) => f.ref === req.id)
    expect(refused.code).toBe('sig_invalid')
    await sleep(200)
    expect(b.rec.frames.filter((r) => r.direction === 'in' && r.raw.type === 'history.page')).toEqual([])
  })

  it('the refusal holds across the other read path too: a context request seen once is not forwarded again', async () => {
    const k = kit(relay)
    const a = await k.connectedApp()
    const bridge = await k.bridge({ autoReply: false, verifyOwner: false }).connect()
    const req = await a.sign({
      ...mkFrame('history.request'),
      request_id: newUlid(),
      thread_id: 'general',
      around_id: `m_${newUlid()}`,
      limit: 20,
    })
    a.send(req)
    await bridge.expectFrame('history.request', (f) => f.id === req.id, { direction: 'in' })
    a.send(req)
    await a.expectFrame('error', (f) => f.ref === req.id && f.code === 'sig_invalid')
    await sleep(200)
    expect(bridge.rec.frames.filter((r) => r.direction === 'in' && r.raw.type === 'history.request')).toHaveLength(1)
  })
})
