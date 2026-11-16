// Bug hunt 2026-11-10, relay #5: a `receipt` from the Mac (delivered / seen) was written to message meta and sent to the
// sockets open at that moment, and nothing else: it was not a stored event and `ready` carries only `not_delivered`. A
// device that was away (the phone that sent the message and went to the background) replayed its catch-up with no
// receipt, so the row stayed on one tick ("Sent") although the agent had read it. A receipt that moves a message forward
// is now stored for apps.
import { afterEach, expect, it, vi } from 'vitest'
import { startTestRelay, type TestRelay } from '../core/harness.ts'
import { kit, silentBridge } from '../core/helpers.ts'

vi.setConfig({ testTimeout: 30_000 })
let relay: TestRelay | null = null
afterEach(async () => {
  await relay?.stop()
  relay = null
})

it('a device that was away when the Mac read its message still learns the receipt', async () => {
  relay = await startTestRelay()
  const a = await kit(relay).connectedApp()
  const sent = await a.sendMessage('general', 'did you get this?')
  await a.expectFrame('ack', (f) => f.ref === sent.id)
  // The phone holds its own row before it leaves and counts that row's seq, as the web client does
  // (apps/web/src/lib/socket-frames-chat.ts, onMessageStored); the fake app only counts `relay.seq`. A device still at
  // seq 0 is sent no catch-up at all: it reads the thread's history page, which has always carried the receipt.
  const own = await a.expectFrame('message.stored', (f) => f.client_msg_id === sent.client_msg_id)
  a.lastSeq = own.message.seq ?? 0
  expect(a.lastSeq).toBeGreaterThan(0)
  await a.close() // the phone goes to the background

  const b = await silentBridge(relay, relay.bridgeKey)
  await b.reaches('message', sent.id, 1)
  b.ack(sent.id, 'consumed')
  b.send({ type: 'receipt', message_id: sent.client_msg_id, state: 'seen' })
  await b.sync()
  expect(relay.runtime.store.getMeta(sent.client_msg_id).receipt).toBe('seen') // the relay does know

  const mark = a.rec.frames.length
  const ready = await a.connect() // back, with its last_seq: hello -> ready (+ catch-up, if anything was missed)
  a.send({ type: 'ping', nonce: 'barrier1' })
  await a.expectFrame('pong', (f) => f.nonce === 'barrier1', { since: mark })
  const got = [ready, ...a.rec.frames.slice(mark).map((r) => r.raw)]
  const text = JSON.stringify(got)
  expect(text.includes(sent.client_msg_id) && text.includes('"seen"')).toBe(true)
  // and in the shape the app applies: a `receipt` frame inside the catch-up page
  const pages = got.filter((f) => f.type === 'catchup.batch') as Array<{ frames: Array<Record<string, unknown>> }>
  const replayed = pages.flatMap((p) => p.frames).filter((f) => f.type === 'receipt')
  expect(replayed.map((f) => [f.message_id, f.state])).toEqual([[sent.client_msg_id, 'seen']])
  await b.close()
})

it('a repeat, a `delivered` after `seen` and a receipt for an id the relay never took are sent live and not stored', async () => {
  relay = await startTestRelay()
  const store = relay.runtime.store
  const a = await kit(relay).connectedApp()
  const sent = await a.sendMessage('general', 'one tick, two ticks')
  await a.expectFrame('ack', (f) => f.ref === sent.id)
  const b = await silentBridge(relay, relay.bridgeKey)
  await b.reaches('message', sent.id, 1)
  b.ack(sent.id, 'consumed')

  const live = (state: string, id = sent.client_msg_id) =>
    a.rec.frames.filter((r) => r.raw.type === 'receipt' && r.raw.message_id === id && r.raw.state === state)
  b.send({ type: 'receipt', message_id: sent.client_msg_id, state: 'delivered' })
  await a.expectFrame('receipt', (f) => f.message_id === sent.client_msg_id && f.state === 'delivered')
  b.send({ type: 'receipt', message_id: sent.client_msg_id, state: 'seen' })
  await a.expectFrame('receipt', (f) => f.message_id === sent.client_msg_id && f.state === 'seen')
  await b.sync()
  // each step forward is one stored frame, and the open socket got each exactly once, with its seq
  expect(live('delivered')).toHaveLength(1)
  expect(live('seen')).toHaveLength(1)
  expect((live('seen')[0]?.raw.relay as { seq?: number } | undefined)?.seq).toBe(store.maxSeq())
  const top = store.maxSeq()

  b.send({ type: 'receipt', message_id: sent.client_msg_id, state: 'seen' }) // the Mac repeats itself
  b.send({ type: 'receipt', message_id: sent.client_msg_id, state: 'delivered' }) // a late `delivered`
  b.send({ type: 'receipt', message_id: 'm_01JZZZZZZZZZZZZZZZZZZZZZZZ', state: 'seen' }) // not a message of this relay
  await b.sync()
  await a.expectFrame('receipt', (f) => f.message_id === 'm_01JZZZZZZZZZZZZZZZZZZZZZZZ')
  expect(store.maxSeq()).toBe(top) // nothing more in the buffer
  expect(live('seen')).toHaveLength(2) // still passed on, as before
  await b.close()
})
