// Review cases for the app floor (bug hunt R9) and the young-buffer scroll-back (R11): the floor never hides a frame a
// device missed, a relay that swept before the mark existed seeds it, and an old app or an offline Mac keep their answers.
import { newId, newUlid } from '@talos-app/protocol'
import { fakeClock, mkFrame, waitFor } from '@talos-app/testkit'
import { afterEach, expect, it, vi } from 'vitest'
import { startTestRelay, type TestRelay } from '../core/harness.ts'
import { kit, silentBridge } from '../core/helpers.ts'

vi.setConfig({ testTimeout: 60_000 })
let relay: TestRelay | null = null
afterEach(async () => {
  await relay?.stop()
  relay = null
})

const replyFrame = (text: string, at: number) =>
  mkFrame('reply', {
    message: {
      id: newId('m'),
      thread_id: 'general',
      author: 'agent',
      kind: 'text',
      text,
      format: 'plain',
      attachments: [],
      via: 'app',
      created_at: new Date(at).toISOString(),
    },
  })

it('a device that missed an app frame is still reset, though bridge-only frames aged out after it', async () => {
  const c = fakeClock('2026-10-01T09:00:00.000Z')
  relay = await startTestRelay({ clock: c })
  const a = await kit(relay).connectedApp()
  const b = await silentBridge(relay, relay.bridgeKey)
  const first = replyFrame('seen', c.now())
  b.send(first)
  await a.expectFrame('reply', (f) => f.id === first.id)
  const have = a.lastSeq
  await a.close()
  const missed = replyFrame('missed while away', c.now())
  b.send(missed)
  await waitFor(() => (relay as TestRelay).runtime.store.maxSeq() === have + 1, 10_000, 'the missed reply stored')
  await relay.runtime.hub.toBridge(
    { type: 'session.control', control_id: newUlid(), thread_id: 'general', action: 'stop' },
    { durable: true, ttl_s: 300 },
  )
  await b.close()
  await waitFor(() => !relay?.runtime.hub.bridgeOnline(), 10_000, 'bridge offline')
  c.advance(8 * 86_400_000)
  expect(relay.runtime.store.appFloor()).toBe(have + 2) // one past the missed reply
  await a.connect()
  const reset = await a.expectFrame('catchup.reset')
  expect(reset.min_seq).toBe(have + 2)
})

it('a relay that swept before the app floor existed seeds it from its floor at the next sweep', async () => {
  relay = await startTestRelay()
  const store = relay.runtime.store
  store.setState('floor', '40')
  store.deleteState('app_floor')
  expect(store.appFloor()).toBe(40) // the old floor until the mark exists
  store.sweep({ bufferMs: 7 * 86_400_000, dedupMs: 86_400_000 })
  expect(store.getState('app_floor')).toBe('40')
  expect(store.appFloor()).toBe(40)
})

it('on a young buffer, an unsigned scroll-back stays local and a signed one with the Mac offline is told so', async () => {
  relay = await startTestRelay()
  const k = kit(relay)
  const a = await k.connectedApp()
  const b = await silentBridge(relay, relay.bridgeKey)
  const sent = await a.sendMessage('general', 'first message on the new relay')
  const ack = await a.expectFrame('ack', (f) => f.ref === sent.id)
  a.send({ type: 'history.request', request_id: 'old-app', thread_id: 'general', before_seq: ack.seq, limit: 20 })
  const local = await a.expectFrame('history.page', (f) => f.request_id === 'old-app')
  expect(local.has_more).toBe(false)
  expect(local.unavailable).toBeUndefined()
  await b.sync()
  expect(b.count('history.request')).toBe(0)
  await b.close()
  await waitFor(() => !relay?.runtime.hub.bridgeOnline(), 10_000, 'bridge offline')
  const req = await a.sendHistoryRequest('general', { before_seq: ack.seq })
  const page = await a.expectFrame('history.page', (f) => f.request_id === req.request_id)
  expect(page.unavailable).toBe('mac_offline')
})
