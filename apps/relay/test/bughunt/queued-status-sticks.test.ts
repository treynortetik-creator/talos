// Bug hunt 2026-11-10, relay #6: the relay derives a `queued` row ("Busy with another task") 30 s after the Mac consumed
// a message with no `seen` receipt. A `seen` that came before the 30 s cancelled the timer; one that came after it left
// the row standing until a reply, a `status` frame from the Mac or the Mac disconnecting, and every `ready` repeated it.
// A message that is settled late (seen, or refused by the Mac) now takes the row back, unless another message in the
// same thread is still waiting unseen.
import { fakeClock, waitFor } from '@talos-app/testkit'
import { afterEach, expect, it, vi } from 'vitest'
import { startTestRelay, type TestRelay } from '../core/harness.ts'
import { advance, kit, silentBridge } from '../core/helpers.ts'

vi.setConfig({ testTimeout: 30_000 })
let relay: TestRelay | null = null
afterEach(async () => {
  await relay?.stop()
  relay = null
})

it('a late `seen` receipt clears the derived "Busy with another task" row', async () => {
  const c = fakeClock(new Date().toISOString())
  relay = await startTestRelay({ clock: c })
  const a = await kit(relay).connectedApp()
  const b = await silentBridge(relay, relay.bridgeKey)
  const sent = await a.sendMessage('general', 'when you have a minute')
  await b.reaches('message', sent.id, 1)
  b.ack(sent.id, 'consumed')
  await b.sync()
  await advance(c, 31_000, 1_000)
  await waitFor(() => relay?.runtime.store.getStatus('general')?.state === 'queued', 10_000, 'derived queued row')

  b.send({ type: 'receipt', message_id: sent.client_msg_id, state: 'seen' }) // the agent got to it 31 s in
  await b.sync()
  await a.expectFrame('receipt', (f) => f.message_id === sent.client_msg_id && f.state === 'seen')

  expect(relay.runtime.store.getStatus('general')?.state).not.toBe('queued')
  await b.close()
})

it('with two messages waiting, the row stays until the second one is seen too', async () => {
  const c = fakeClock(new Date().toISOString())
  relay = await startTestRelay({ clock: c })
  const store = relay.runtime.store
  const a = await kit(relay).connectedApp()
  const b = await silentBridge(relay, relay.bridgeKey)
  const one = await a.sendMessage('general', 'first')
  const two = await a.sendMessage('general', 'second')
  await b.reaches('message', one.id, 1)
  await b.reaches('message', two.id, 1)
  b.ack(one.id, 'consumed')
  b.ack(two.id, 'consumed')
  await b.sync()
  await advance(c, 31_000, 1_000)
  await waitFor(() => store.getStatus('general')?.state === 'queued', 10_000, 'derived queued row')

  b.send({ type: 'receipt', message_id: one.client_msg_id, state: 'seen' })
  await a.expectFrame('receipt', (f) => f.message_id === one.client_msg_id && f.state === 'seen')
  await b.sync()
  expect(store.getStatus('general')?.state).toBe('queued') // the second message is still waiting

  b.send({ type: 'receipt', message_id: two.client_msg_id, state: 'seen' })
  await a.expectFrame('receipt', (f) => f.message_id === two.client_msg_id && f.state === 'seen')
  await b.sync()
  expect(store.getStatus('general')?.state).not.toBe('queued')
  await b.close()
})

it('a late `seen` leaves a status the Mac set itself alone', async () => {
  const c = fakeClock(new Date().toISOString())
  relay = await startTestRelay({ clock: c })
  const store = relay.runtime.store
  const a = await kit(relay).connectedApp()
  const b = await silentBridge(relay, relay.bridgeKey)
  const sent = await a.sendMessage('general', 'when you have a minute')
  await b.reaches('message', sent.id, 1)
  b.ack(sent.id, 'consumed')
  await b.sync()
  await advance(c, 31_000, 1_000)
  await waitFor(() => store.getStatus('general')?.state === 'queued', 10_000, 'derived queued row')

  b.send({ type: 'status', thread_id: 'general', state: 'working', label: 'Reading', since: new Date().toISOString() }) // the Mac's own word
  await a.expectFrame('status', (f) => f.thread_id === 'general' && f.state === 'working')
  b.send({ type: 'receipt', message_id: sent.client_msg_id, state: 'seen' })
  await a.expectFrame('receipt', (f) => f.message_id === sent.client_msg_id && f.state === 'seen')
  await b.sync()
  expect(store.getStatus('general')?.state).toBe('working')
  await b.close()
})

it('a message the Mac refuses after the 30 s takes the row back too', async () => {
  const c = fakeClock(new Date().toISOString())
  relay = await startTestRelay({ clock: c })
  const store = relay.runtime.store
  const a = await kit(relay).connectedApp()
  const b = await silentBridge(relay, relay.bridgeKey)
  const sent = await a.sendMessage('general', 'to a thread the Mac will not take')
  await b.reaches('message', sent.id, 1)
  b.ack(sent.id, 'consumed')
  await b.sync()
  await advance(c, 31_000, 1_000)
  await waitFor(() => store.getStatus('general')?.state === 'queued', 10_000, 'derived queued row')

  b.send({ type: 'error', ref: sent.id, code: 'stale', message: "This device's clock is off." })
  await a.expectFrame('receipt', (f) => f.message_id === sent.client_msg_id && f.state === 'not_delivered')
  await b.sync()
  expect(store.getStatus('general')?.state).not.toBe('queued')
  await b.close()
})
