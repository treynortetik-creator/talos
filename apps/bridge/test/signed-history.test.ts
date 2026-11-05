// Signed history and context paging (docs/PROTOCOL.md "Signed history reads"). The Mac keeps history forever, so a
// history.request that reaches it through the relay is served only when a pinned, unrevoked owner device signed it, once.
// Real bridge, FakeRelay, FakeApp; the frames travel app -> relay -> bridge exactly as in production.
import { afterEach, describe, expect, test } from 'bun:test'
import { type FrameOf, newId, newUlid } from '@talos-app/protocol'
import { FakeApp } from '@talos-app/testkit'
import { eventually, type Harness, sleep, startHarness } from './helpers.ts'

let h: Harness | undefined
afterEach(async () => {
  await h?.stop()
  h = undefined
})

const SECRET = 'history-secret-0xC0FFEE'
const pagesFor = (h: Harness, rid?: string) =>
  h.relay.frames.filter(
    (r) =>
      r.direction === 'from_bridge' && r.raw.type === 'history.page' && (rid === undefined || r.raw.request_id === rid),
  )
const errFor = (h: Harness, id: string) =>
  h.relay.expectFrame('error', (f) => f.ref === id, { direction: 'from_bridge' })
const seed = (h: Harness, n = 4) => {
  const ids: string[] = []
  for (let i = 0; i < n; i++) {
    const m = {
      id: newId('m'),
      thread_id: 'general',
      author: 'owner' as const,
      kind: 'text' as const,
      text: `${SECRET} line ${i}`,
      format: 'plain' as const,
      attachments: [],
      via: 'app' as const,
      created_at: new Date(Date.now() - (n - i) * 1000).toISOString(),
    }
    ids.push(m.id)
    h.bridge.ctx.store.addMessage(m)
  }
  return ids
}

describe('signed history reads', () => {
  test('control: a signed request is answered with the page', async () => {
    h = await startHarness()
    seed(h)
    const req = await h.app.sendHistoryRequest('general', { limit: 10 })
    const page = await h.relay.expectFrame('history.page', (f) => f.request_id === req.request_id, {
      direction: 'from_bridge',
    })
    expect(page.messages).toHaveLength(4)
  })

  test('an unsigned request gets no data and one error that says to update the app', async () => {
    h = await startHarness()
    seed(h)
    const req = h.app.send({ type: 'history.request', request_id: newUlid(), thread_id: 'general', limit: 10 })
    const err = await errFor(h, req.id as string)
    expect(err.code).toBe('bad_frame') // not sig_invalid: an old build would show that as a false security alarm
    expect(err.message.toLowerCase()).toContain('update')
    await sleep(150)
    expect(pagesFor(h)).toHaveLength(0)
    expect(JSON.stringify(h.relay.frames.filter((r) => r.direction === 'from_bridge'))).not.toContain(SECRET)
  })

  test('an unsigned context request (around_id) gets no data either', async () => {
    h = await startHarness()
    const ids = seed(h)
    const req = h.app.send({
      type: 'history.request',
      request_id: newUlid(),
      thread_id: 'general',
      around_id: ids[2],
      limit: 50,
    })
    await errFor(h, req.id as string)
    await sleep(100)
    expect(pagesFor(h)).toHaveLength(0)
  })

  test('a request changed after signing is refused, logged without content', async () => {
    const logs: string[] = []
    const line = (m: string, f?: unknown) => logs.push(`${m} ${JSON.stringify(f ?? {})}`)
    const logger = { debug: () => {}, info: line, warn: line, error: line, security: line }
    h = await startHarness({ bridge: { logger: logger as never } })
    seed(h)
    const good = await h.app.buildHistoryRequest('general', { limit: 5 })
    const forged = { ...good, limit: 100 } // widened after signing
    h.app.sendRaw(JSON.stringify(forged))
    const err = await errFor(h, forged.id)
    expect(err.code).toBe('sig_invalid')
    await sleep(100)
    expect(pagesFor(h)).toHaveLength(0)
    const all = logs.join('\n')
    expect(all).toContain('history')
    expect(all).not.toContain(SECRET)
  })

  test('a replayed signed request is refused, on the same or another socket', async () => {
    h = await startHarness()
    seed(h)
    const req = await h.app.buildHistoryRequest('general', { limit: 10 })
    const bytes = JSON.stringify(req)
    h.app.sendRaw(bytes)
    await h.relay.expectFrame('history.page', (f) => f.request_id === req.request_id, { direction: 'from_bridge' })
    h.app.sendRaw(bytes)
    const err = await errFor(h, req.id)
    expect(err.code).toBe('sig_invalid')
    const second = new FakeApp({ relayWs: h.relay.wsBase })
    await second.connect()
    second.sendRaw(bytes)
    await sleep(200)
    await eventually(() => expect(pagesFor(h as Harness, req.request_id as string)).toHaveLength(1))
    await second.close()
  })

  test('a request signed by an unpinned device is refused', async () => {
    h = await startHarness()
    seed(h)
    const rogue = new FakeApp({ relayWs: h.relay.wsBase })
    await rogue.connect()
    const req = await rogue.sendHistoryRequest('general', { limit: 10 })
    expect((await errFor(h, req.id)).code).toBe('sig_invalid')
    await sleep(100)
    expect(pagesFor(h)).toHaveLength(0)
    await rogue.close()
  })

  test('a request signed by a revoked device is refused', async () => {
    h = await startHarness()
    seed(h)
    h.bridge.ctx.devices.revoke(h.app.device.deviceId, new Date().toISOString())
    const req = await h.app.sendHistoryRequest('general', { limit: 10 })
    expect((await errFor(h, req.id)).code).toBe('sig_invalid')
    await sleep(100)
    expect(pagesFor(h)).toHaveLength(0)
  })

  test('signed context paging (around, before, after) still works', async () => {
    h = await startHarness()
    const ids = seed(h, 6)
    for (const key of ['around_id', 'before_id', 'after_id'] as const) {
      const req = await h.app.sendHistoryRequest('general', { [key]: ids[3], limit: 50 })
      const page = (await h.relay.expectFrame('history.page', (f) => f.request_id === req.request_id, {
        direction: 'from_bridge',
      })) as FrameOf<'history.page'>
      expect(page.messages.length).toBeGreaterThan(0)
    }
  })
})
