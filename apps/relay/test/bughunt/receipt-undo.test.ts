// "Undo to here": a message's undo point rides on its `delivered` receipt from the Mac. The relay keeps it in the
// message's meta whenever a receipt carries it, even one that moves nothing forward (a second `delivered` for a point
// recorded after the hand-over, or one after `seen`), never taking the receipt back, and hands it on in catch-up and on
// the message's history row.
import { afterEach, expect, it, vi } from 'vitest'
import { startTestRelay, type TestRelay } from '../core/harness.ts'
import { kit, silentBridge } from '../core/helpers.ts'

vi.setConfig({ testTimeout: 30_000 })
let relay: TestRelay | null = null
afterEach(async () => {
  await relay?.stop()
  relay = null
})

async function sentAndTaken() {
  relay = await startTestRelay()
  const a = await kit(relay).connectedApp()
  const sent = await a.sendMessage('general', 'tidy the readme please')
  await a.expectFrame('ack', (f) => f.ref === sent.id)
  const b = await silentBridge(relay, relay.bridgeKey)
  await b.reaches('message', sent.id, 1)
  b.ack(sent.id, 'consumed')
  return { relay, a, b, id: sent.client_msg_id as string }
}

it('a delivered receipt with an undo point is kept and handed on with it', async () => {
  const { relay, a, b, id } = await sentAndTaken()
  b.send({ type: 'receipt', message_id: id, state: 'delivered', undo: { state: 'ready' } })
  const live = await a.expectFrame('receipt', (f) => f.message_id === id && f.state === 'delivered')
  expect(live.undo).toEqual({ state: 'ready' })
  expect(relay.runtime.store.getMeta(id)).toMatchObject({ receipt: 'delivered', undo: { state: 'ready' } })
  await b.close()
})

it('a second delivered (a late point) and one after seen keep the point, and never take the receipt back', async () => {
  const { relay, a, b, id } = await sentAndTaken()
  const store = relay.runtime.store
  b.send({ type: 'receipt', message_id: id, state: 'delivered' })
  b.send({ type: 'receipt', message_id: id, state: 'seen' })
  await a.expectFrame('receipt', (f) => f.message_id === id && f.state === 'seen')
  b.send({ type: 'receipt', message_id: id, state: 'delivered', undo: { state: 'not_saved' } })
  const late = await a.expectFrame('receipt', (f) => f.message_id === id && f.undo !== undefined)
  expect(late).toMatchObject({ state: 'seen', undo: { state: 'not_saved' } })
  await b.sync()
  expect(store.getMeta(id)).toMatchObject({ receipt: 'seen', undo: { state: 'not_saved' } })
  await b.close()
})

it('a device that was away gets the point in its catch-up, and a history row carries it', async () => {
  const { relay, a, b, id } = await sentAndTaken()
  const own = await a.expectFrame('message.stored', (f) => f.client_msg_id === id)
  a.lastSeq = own.message.seq ?? 0
  await a.close()
  b.send({ type: 'receipt', message_id: id, state: 'delivered', undo: { state: 'too_large' } })
  await b.sync()
  const mark = a.rec.frames.length
  const ready = await a.connect()
  a.send({ type: 'ping', nonce: 'barrier1' })
  await a.expectFrame('pong', (f) => f.nonce === 'barrier1', { since: mark })
  const got = [ready, ...a.rec.frames.slice(mark).map((x) => x.raw)]
  const pages = got.filter((f) => f.type === 'catchup.batch') as Array<{ frames: Array<Record<string, unknown>> }>
  const replayed = pages.flatMap((p) => p.frames).filter((f) => f.type === 'receipt' && f.message_id === id)
  expect(replayed.map((f) => f.undo)).toEqual([{ state: 'too_large' }])
  a.send({ type: 'history.request', request_id: 'h1', thread_id: 'general', limit: 10 })
  const page = await a.expectFrame('history.page', (f) => f.request_id === 'h1')
  expect(page.messages.find((m) => m.id === id)?.undo).toEqual({ state: 'too_large' })
  await b.close()
})

it('a later step forward carries the point it already has', async () => {
  const { relay, a, b, id } = await sentAndTaken()
  b.send({ type: 'receipt', message_id: id, state: 'delivered', undo: { state: 'ready' } })
  await a.expectFrame('receipt', (f) => f.message_id === id && f.state === 'delivered')
  b.send({ type: 'receipt', message_id: id, state: 'seen' })
  const seen = await a.expectFrame('receipt', (f) => f.message_id === id && f.state === 'seen')
  expect(seen.undo).toEqual({ state: 'ready' })
  expect(relay.runtime.store.getMeta(id)).toMatchObject({ receipt: 'seen', undo: { state: 'ready' } })
  await b.close()
})

it('the same point again is passed on live and not stored again', async () => {
  const { relay, a, b, id } = await sentAndTaken()
  const store = relay.runtime.store
  b.send({ type: 'receipt', message_id: id, state: 'delivered', undo: { state: 'ready' } })
  await a.expectFrame('receipt', (f) => f.message_id === id && f.state === 'delivered')
  await b.sync()
  const top = store.maxSeq()
  b.send({ type: 'receipt', message_id: id, state: 'delivered', undo: { state: 'ready' } })
  await b.sync()
  expect(store.maxSeq()).toBe(top)
  await b.close()
})

it('a point for a message this relay never took, or in a state it does not know, is never kept or passed on', async () => {
  const { relay, a, b, id } = await sentAndTaken()
  const store = relay.runtime.store
  const stranger = 'm_01JZZZZZZZZZZZZZZZZZZZZZZZ'
  b.send({ type: 'receipt', message_id: stranger, state: 'delivered', undo: { state: 'ready' } })
  const live = await a.expectFrame('receipt', (f) => f.message_id === stranger)
  expect(live.undo).toBeUndefined()
  expect(store.getMeta(stranger).undo).toBeUndefined()
  b.send({ type: 'receipt', message_id: id, state: 'delivered' })
  await a.expectFrame('receipt', (f) => f.message_id === id && f.state === 'delivered')
  const mark = a.rec.frames.length
  b.send({ type: 'receipt', message_id: id, state: 'delivered', undo: { state: 'archived' } }) // a repeat: sent on raw
  await a.expectFrame('receipt', (f) => f.message_id === id, { since: mark })
  const raw = a.rec.frames.slice(mark).find((r) => r.raw.type === 'receipt' && r.raw.message_id === id)?.raw
  expect(raw && 'undo' in raw).toBe(false)
  expect(store.getMeta(id).undo).toBeUndefined()
  await b.close()
})

it('the same point again after seen never takes the receipt back', async () => {
  const { relay, a, b, id } = await sentAndTaken()
  b.send({ type: 'receipt', message_id: id, state: 'delivered', undo: { state: 'ready' } })
  b.send({ type: 'receipt', message_id: id, state: 'seen' })
  await a.expectFrame('receipt', (f) => f.message_id === id && f.state === 'seen')
  b.send({ type: 'receipt', message_id: id, state: 'delivered', undo: { state: 'ready' } })
  await b.sync()
  expect(relay.runtime.store.getMeta(id)).toMatchObject({ receipt: 'seen', undo: { state: 'ready' } })
  await b.close()
})
