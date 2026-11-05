// MCP Apps AP2, the frame routes at the real relay: FakeApp in front, FakeBridge behind (spec M3.4, M4.6, M6.3).
import { createDeviceKey, newId, newUlid, signBridgeHttp, signOwnerFrame, verifyOwnerFrame } from '@talos-app/protocol'
import { FakeApp, type FakeBridge, type fakeClock, mkFrame, sleep, waitFor } from '@talos-app/testkit'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ORIGIN, startTestRelay, type TestRelay } from '../core/harness.ts'
import { kit } from '../core/helpers.ts'
import { testAppHeaders } from '../helpers/test-auth.ts'
import { fixture } from './helpers.ts'

vi.setConfig({ testTimeout: 30_000 })
let relay: TestRelay | null = null
const open: Array<{ close(): Promise<void> }> = []
afterEach(async () => {
  for (const c of open.splice(0)) await c.close().catch(() => undefined)
  await relay?.stop()
  relay = null
})

const VIEW = 'av_01JBF3V7Q8K2M4N6P8R0S2T43R'
const rid = () => `ar_${newUlid()}`
const inFrames = (a: FakeApp) => a.rec.frames.filter((r) => r.direction === 'in').map((r) => r.raw)
const bridgeIn = (b: FakeBridge) => b.rec.frames.filter((r) => r.direction === 'in').map((r) => r.raw)

async function world(opts: { bridge?: boolean; clock?: ReturnType<typeof fakeClock> } = {}) {
  relay = await startTestRelay(opts.clock ? { clock: opts.clock } : {})
  const k = kit(relay)
  const app = await k.connectedApp()
  const other = await k.connectedApp()
  open.push(app, other)
  const bridge =
    opts.bridge === false
      ? null
      : await k
          .bridge({
            pinnedDevices: {
              [app.device.deviceId]: app.device.publicJwk,
              [other.device.deviceId]: other.device.publicJwk,
            },
            autoReply: false,
          })
          .connect()
  if (bridge) open.push(bridge)
  return { relay, k, app, other, bridge: bridge as FakeBridge }
}

const toolsCall = (over: Record<string, unknown> = {}) => ({
  ...mkFrame('app.request'),
  thread_id: 'general',
  view_id: VIEW,
  request_id: rid(),
  method: 'tools/call',
  tool_name: 'read_note',
  arguments: { id: 'n1' },
  user_gesture: true,
  ...over,
})
const response = (request_id: string, over: Record<string, unknown> = {}) => ({
  type: 'app.response',
  view_id: VIEW,
  request_id,
  state: 'done',
  result: { content: [{ type: 'text', text: 'Buy milk' }] },
  ...over,
})
const eventTypes = (r: TestRelay) =>
  (r.runtime.store.db.prepare('select type from core_events').all() as Array<{ type: string }>).map((x) => x.type)

describe('app.request: app -> relay -> bridge', () => {
  it('reaches the bridge byte-for-byte and its owner signature still verifies there', async () => {
    const { app, bridge } = await world()
    const f = await app.sign(toolsCall())
    app.send(f)
    const got = await bridge.expectFrame('app.request', (x) => x.id === f.id, { direction: 'in' })
    expect(got).toMatchObject({ tool_name: 'read_note', arguments: { id: 'n1' }, user_gesture: true })
    const raw = bridge.rec.frames.find((r) => r.raw.id === f.id)?.raw as Record<string, unknown>
    expect(raw).toEqual(JSON.parse(app.sentBytes[app.sentBytes.length - 1] as string))
    expect(await verifyOwnerFrame(raw, app.device.publicJwk)).toBe(true)
  })

  it('a ui/message request is forwarded the same way', async () => {
    const { app, bridge } = await world()
    const f = await app.sign({
      ...mkFrame('app.request'),
      thread_id: 'general',
      view_id: VIEW,
      request_id: rid(),
      method: 'ui/message',
      text: 'remind me tomorrow',
      user_gesture: false,
    })
    app.send(f)
    await bridge.expectFrame('app.request', (x) => x.id === f.id, { direction: 'in' })
  })

  it('is not stored: no event, no outbox row, not in a fresh app catch-up', async () => {
    const { relay: r, app, bridge, k } = await world()
    const f = await app.sign(toolsCall())
    app.send(f)
    await bridge.expectFrame('app.request', (x) => x.id === f.id, { direction: 'in' })
    bridge.send(response(f.request_id) as never)
    await app.expectFrame('app.response', (x) => x.request_id === f.request_id, { direction: 'in' })
    expect(eventTypes(r).filter((t) => t.startsWith('app.'))).toEqual([])
    expect(r.runtime.store.getEventByFrameId(f.id)).toBeFalsy()
    expect(r.runtime.store.outboxAll().filter((x) => x.type.startsWith('app.'))).toEqual([])
    const fresh = await k.connectedApp()
    open.push(fresh)
    fresh.send({ type: 'catchup.request', since_seq: 0 })
    await sleep(300)
    const seen = JSON.stringify(inFrames(fresh))
    expect(seen).not.toContain('app.request')
    expect(seen).not.toContain('app.response')
  })

  it('a signed request from a different device than the session is refused before it is forwarded', async () => {
    relay = await startTestRelay()
    const mine = await createDeviceKey()
    const app = new FakeApp({ relayWs: relay.wsBase, headers: testAppHeaders(ORIGIN, mine.deviceId), deviceKey: mine })
    await app.connect()
    open.push(app)
    const bridge = await kit(relay).bridge({ autoReply: false }).connect()
    open.push(bridge)
    const other = await createDeviceKey()
    const f = await signOwnerFrame({ ...toolsCall(), device_id: other.deviceId }, other.privateKey)
    app.send(f)
    const err = await app.expectFrame('error', (x) => x.ref === f.id, { direction: 'in' })
    expect(err.code).toBe('unauthorized')
    await sleep(150)
    expect(bridgeIn(bridge).some((x) => x.id === f.id)).toBe(false)
    const ok = await app.sign(toolsCall()) // control: the session's own device is forwarded
    app.send(ok)
    await bridge.expectFrame('app.request', (x) => x.id === ok.id, { direction: 'in' })
  })

  it('an unsigned request never parses: bad_frame, nothing forwarded', async () => {
    const { app, bridge } = await world()
    const f = toolsCall()
    app.send(f)
    const err = await app.expectFrame('error', (x) => x.ref === f.id, { direction: 'in' })
    expect(err.code).toBe('bad_frame')
    await sleep(150)
    expect(bridgeIn(bridge).some((x) => x.id === f.id)).toBe(false)
  })

  it('oversize arguments (16 KiB limit) and an unknown method are refused as bad_frame', async () => {
    const { app, bridge } = await world()
    const big = await app.sign(toolsCall({ arguments: { blob: 'x'.repeat(17_000) } }))
    const odd = await app.sign(toolsCall({ method: 'resources/read' }))
    app.send(big)
    app.send(odd)
    expect((await app.expectFrame('error', (x) => x.ref === big.id, { direction: 'in' })).code).toBe('bad_frame')
    expect((await app.expectFrame('error', (x) => x.ref === odd.id, { direction: 'in' })).code).toBe('bad_frame')
    await sleep(100)
    expect(bridgeIn(bridge).filter((x) => x.type === 'app.request')).toEqual([])
  })

  it('a resend of the same request_id on the same socket reaches the bridge once and is answered once', async () => {
    const { app, bridge } = await world()
    const id = rid()
    const a = await app.sign(toolsCall({ request_id: id }))
    const b = await app.sign(toolsCall({ request_id: id }))
    app.send(a)
    app.send(b)
    await bridge.expectFrame('app.request', (x) => x.id === a.id, { direction: 'in' })
    await sleep(200)
    expect(bridgeIn(bridge).filter((x) => x.type === 'app.request')).toHaveLength(1)
    bridge.send(response(id) as never)
    await app.expectFrame('app.response', (x) => x.request_id === id, { direction: 'in' })
    await sleep(100)
    expect(inFrames(app).filter((x) => x.type === 'app.response')).toHaveLength(1)
    expect(inFrames(app).filter((x) => x.type === 'error')).toEqual([]) // a resend is absorbed, not an error
  })
})

describe('mac_offline', () => {
  it('goes to the sender only, as a failed app.response, and nothing is queued for later', async () => {
    const { relay: r, app, other } = await world({ bridge: false })
    const f = await app.sign(toolsCall())
    app.send(f)
    const res = await app.expectFrame('app.response', (x) => x.request_id === f.request_id, { direction: 'in' })
    expect(res).toMatchObject({ state: 'failed', view_id: VIEW, error: { code: 'mac_offline' } })
    await sleep(150)
    expect(inFrames(other).some((x) => x.type === 'app.response')).toBe(false)
    expect(eventTypes(r).filter((t) => t.startsWith('app.'))).toEqual([])
    expect(r.runtime.store.outboxDepth()).toBe(0)
  })

  it('the Mac going away mid-request: the bridge reconnects and its answer still reaches the asker; the old socket is not the route', async () => {
    const { relay: r, app, other, bridge, k } = await world()
    const f = await app.sign(toolsCall())
    app.send(f)
    await bridge.expectFrame('app.request', (x) => x.id === f.id, { direction: 'in' })
    await bridge.close()
    await waitFor(() => !r.relay.services.bus.bridgeOnline(), 3000, 'bridge gone')
    const again = await k.bridge({ autoReply: false }).connect()
    open.push(again)
    again.send(response(f.request_id) as never)
    await app.expectFrame('app.response', (x) => x.request_id === f.request_id, { direction: 'in' })
    expect(inFrames(other).some((x) => x.type === 'app.response')).toBe(false)
  })

  it('the asking socket closing mid-request: the answer is dropped without an error and nothing leaks', async () => {
    const { relay: r, app, other, bridge } = await world()
    const f = await app.sign(toolsCall())
    app.send(f)
    await bridge.expectFrame('app.request', (x) => x.id === f.id, { direction: 'in' })
    await app.close()
    await waitFor(
      () => (r.runtime.hub as unknown as { appRouter: { pending(): number } }).appRouter.pending() === 0,
      3000,
      'route dropped',
    )
    bridge.send(response(f.request_id) as never)
    await sleep(200)
    expect(inFrames(other).some((x) => x.type === 'app.response')).toBe(false)
    expect(r.relay.services.bus.bridgeOnline()).toBe(true) // the relay did not choke on it
  })
})

describe('app.response: bridge -> relay -> the requesting socket only', () => {
  it('goes only to the socket that asked, by request_id; a second caller gets nothing', async () => {
    const { app, other, bridge } = await world()
    const a = await app.sign(toolsCall())
    const b = await other.sign(toolsCall())
    app.send(a)
    other.send(b)
    await bridge.expectFrame('app.request', (x) => x.id === a.id, { direction: 'in' })
    await bridge.expectFrame('app.request', (x) => x.id === b.id, { direction: 'in' })
    bridge.send(response(b.request_id, { result: { content: [{ type: 'text', text: 'for other' }] } }) as never)
    bridge.send(response(a.request_id, { result: { content: [{ type: 'text', text: 'for app' }] } }) as never)
    const gotA = await app.expectFrame('app.response', undefined, { direction: 'in' })
    const gotB = await other.expectFrame('app.response', undefined, { direction: 'in' })
    expect(JSON.stringify(gotA)).toContain('for app')
    expect(JSON.stringify(gotB)).toContain('for other')
    await sleep(150)
    expect(inFrames(app).filter((x) => x.type === 'app.response')).toHaveLength(1)
    expect(inFrames(other).filter((x) => x.type === 'app.response')).toHaveLength(1)
  })

  it('a second socket cannot take over a live request_id: it is refused and the answer still goes to the first', async () => {
    const { app, other, bridge } = await world()
    const id = rid()
    const mine = await app.sign(toolsCall({ request_id: id }))
    app.send(mine)
    await bridge.expectFrame('app.request', (x) => x.id === mine.id, { direction: 'in' })
    const theirs = await other.sign(toolsCall({ request_id: id }))
    other.send(theirs)
    const err = await other.expectFrame('error', (x) => x.ref === theirs.id, { direction: 'in' })
    expect(err.code).toBe('bad_frame')
    await sleep(100)
    expect(bridgeIn(bridge).filter((x) => x.type === 'app.request')).toHaveLength(1)
    bridge.send(response(id) as never)
    await app.expectFrame('app.response', (x) => x.request_id === id, { direction: 'in' })
    expect(inFrames(other).some((x) => x.type === 'app.response')).toBe(false)
  })

  it('two at once with the same request_id from two sockets: exactly one wins, never both', async () => {
    const { app, other, bridge } = await world()
    const id = rid()
    const [a, b] = await Promise.all([
      app.sign(toolsCall({ request_id: id })),
      other.sign(toolsCall({ request_id: id })),
    ])
    app.send(a)
    other.send(b)
    // one is forwarded, the other refused: both answers are the signal that the relay processed the pair
    await waitFor(
      () =>
        bridgeIn(bridge).filter((x) => x.type === 'app.request').length >= 1 &&
        [...inFrames(app), ...inFrames(other)].some((x) => x.type === 'error' && x.code === 'bad_frame'),
      4000,
      'one request forwarded and one refused',
    )
    expect(bridgeIn(bridge).filter((x) => x.type === 'app.request')).toHaveLength(1)
    const errs = [...inFrames(app), ...inFrames(other)].filter((x) => x.type === 'error' && x.code === 'bad_frame')
    expect(errs).toHaveLength(1)
  })

  it('an unknown request_id, a wrong view_id and a repeated final answer are dropped', async () => {
    const { app, other, bridge } = await world()
    bridge.send(response(rid()) as never)
    const f = await app.sign(toolsCall())
    app.send(f)
    await bridge.expectFrame('app.request', (x) => x.id === f.id, { direction: 'in' })
    bridge.send(response(f.request_id, { view_id: 'av_01JBF3V7Q8K2M4N6P8R0S2T43Z' }) as never)
    await sleep(150)
    expect(inFrames(app).some((x) => x.type === 'app.response')).toBe(false)
    bridge.send(response(f.request_id) as never)
    await app.expectFrame('app.response', undefined, { direction: 'in' })
    bridge.send(response(f.request_id) as never)
    await sleep(150)
    expect(inFrames(app).filter((x) => x.type === 'app.response')).toHaveLength(1)
    expect(inFrames(other).some((x) => x.type === 'app.response')).toBe(false)
  })

  it('pending_card keeps the route: the card outcome that follows still arrives', async () => {
    const { app, bridge } = await world()
    const f = await app.sign(toolsCall())
    app.send(f)
    await bridge.expectFrame('app.request', (x) => x.id === f.id, { direction: 'in' })
    bridge.send({
      type: 'app.response',
      view_id: VIEW,
      request_id: f.request_id,
      state: 'pending_card',
      card_id: newId('c'),
    } as never)
    await app.expectFrame('app.response', (x) => x.state === 'pending_card', { direction: 'in' })
    bridge.send(response(f.request_id) as never)
    await app.expectFrame('app.response', (x) => x.state === 'done', { direction: 'in' })
  })

  it('is not stored and not replayed', async () => {
    const { relay: r, app, bridge } = await world()
    const f = await app.sign(toolsCall())
    app.send(f)
    await bridge.expectFrame('app.request', (x) => x.id === f.id, { direction: 'in' })
    bridge.send(response(f.request_id) as never)
    await app.expectFrame('app.response', undefined, { direction: 'in' })
    expect(eventTypes(r).filter((t) => t === 'app.response')).toEqual([])
  })

  it('a malformed response (failed without error) is bad_frame to the bridge and never reaches the app', async () => {
    const { app, bridge } = await world()
    const f = await app.sign(toolsCall())
    app.send(f)
    await bridge.expectFrame('app.request', (x) => x.id === f.id, { direction: 'in' })
    const bad = bridge.send({ type: 'app.response', view_id: VIEW, request_id: f.request_id, state: 'failed' })
    const err = await bridge.expectFrame('error', (x) => x.ref === bad.id, { direction: 'in' })
    expect(err.code).toBe('bad_frame')
    await sleep(100)
    expect(inFrames(app).some((x) => x.type === 'app.response')).toBe(false)
  })
})

describe('an older bridge', () => {
  it('that answers app.request with error{bad_frame} gives the asker a failed app.response, and no system message is stored', async () => {
    const { relay: r, app, other, bridge } = await world()
    const f = await app.sign(toolsCall())
    app.send(f)
    await bridge.expectFrame('app.request', (x) => x.id === f.id, { direction: 'in' })
    const before = eventTypes(r).length
    bridge.send({ type: 'error', ref: f.id, code: 'bad_frame', message: 'unknown frame type app.request' })
    const res = await app.expectFrame('app.response', (x) => x.request_id === f.request_id, { direction: 'in' })
    expect(res).toMatchObject({ state: 'failed', view_id: VIEW })
    await sleep(150)
    expect(eventTypes(r).length).toBe(before)
    expect(JSON.stringify(inFrames(app))).not.toContain('An action was rejected')
    expect(JSON.stringify(inFrames(other))).not.toContain('An action was rejected')
    // the route is gone: a late answer is dropped
    bridge.send(response(f.request_id) as never)
    await sleep(100)
    expect(inFrames(app).filter((x) => x.type === 'app.response')).toHaveLength(1)
  })

  it('sig_invalid from the bridge reaches the asker as sig_invalid', async () => {
    const { app, bridge } = await world()
    const f = await app.sign(toolsCall())
    app.send(f)
    await bridge.expectFrame('app.request', (x) => x.id === f.id, { direction: 'in' })
    bridge.send({ type: 'error', ref: f.id, code: 'sig_invalid', message: 'bad signature' })
    const res = await app.expectFrame('app.response', undefined, { direction: 'in' })
    expect(res).toMatchObject({ state: 'failed', error: { code: 'sig_invalid' } })
  })

  it('an error for a ref that is not an app request still becomes the usual system message (control)', async () => {
    const { relay: r, app, bridge } = await world()
    bridge.send({ type: 'error', ref: newUlid(), code: 'bad_frame', message: 'x' })
    await waitFor(() => JSON.stringify(inFrames(app)).includes('An action was rejected'), 3000, 'system row')
    expect(eventTypes(r)).toContain('message.stored')
  })
})

describe('app.update: durable', () => {
  const update = () => ({ ...fixture('app.update'), id: newUlid(), ts: new Date().toISOString() })
  const strip = (f: Record<string, unknown>) => {
    const { relay: _r, ...rest } = f
    return rest
  }

  it('over the bridge socket it is stored, fanned out and replayed to a fresh app', async () => {
    const { relay: r, app, other, bridge, k } = await world()
    const u = update()
    bridge.send(strip(u))
    await app.expectFrame('app.update', (x) => x.id === u.id, { direction: 'in' })
    await other.expectFrame('app.update', (x) => x.id === u.id, { direction: 'in' })
    expect(eventTypes(r)).toContain('app.update')
    const fresh = k.app()
    await fresh.connect()
    open.push(fresh)
    fresh.send({ type: 'catchup.request', since_seq: 0 })
    await fresh.expectFrame('catchup.batch', (b) => JSON.stringify(b.frames).includes(String(u.id)), {
      direction: 'in',
    })
  })

  it('a resend with the same id is stored once', async () => {
    const { relay: r, app, bridge } = await world()
    const u = update()
    bridge.send(strip(u))
    bridge.send(strip(u))
    await app.expectFrame('app.update', (x) => x.id === u.id, { direction: 'in' })
    await sleep(150)
    expect(eventTypes(r).filter((t) => t === 'app.update')).toHaveLength(1)
  })

  it('over POST /bridge/post it is stored and fanned out too (live bridge not needed)', async () => {
    const { relay: r, app } = await world({ bridge: false })
    const u = strip(update())
    const body = JSON.stringify(u)
    const authorization = await signBridgeHttp({
      privateKey: r.bridgeKey.privateKey,
      keyId: r.bridgeKey.keyId,
      method: 'POST',
      pathWithQuery: '/bridge/post',
      body,
    })
    const res = await fetch(`${r.httpBase}/bridge/post`, {
      method: 'POST',
      body,
      headers: { 'content-type': 'application/json', authorization },
    })
    expect(res.status).toBe(200)
    await app.expectFrame('app.update', (x) => x.id === u.id, { direction: 'in' })
    expect(eventTypes(r)).toContain('app.update')
  })

  it('an app socket cannot send app.update or app.response: bad_frame, nothing fanned out', async () => {
    const { relay: r, app, other } = await world()
    const u = update()
    app.send(strip(u))
    expect((await app.expectFrame('error', (x) => x.ref === u.id, { direction: 'in' })).code).toBe('bad_frame')
    const resp = { ...mkFrame('app.response'), ...response(rid()) }
    app.send(resp)
    expect((await app.expectFrame('error', (x) => x.ref === resp.id, { direction: 'in' })).code).toBe('bad_frame')
    await sleep(100)
    expect(eventTypes(r).filter((t) => t.startsWith('app.'))).toEqual([])
    expect(inFrames(other).some((x) => x.type === 'app.update' || x.type === 'app.response')).toBe(false)
  })
})

describe('what an app socket may not say', () => {
  const noRelay = (f: Record<string, unknown>) => {
    const { relay: _r, ...rest } = f
    return rest
  }
  it('a frame carrying an app-authored row (view row, echo row) is bad_frame and is not stored or shown to others', async () => {
    const { relay: r, app, other } = await world()
    for (const name of ['reply.app_view', 'reply.app_echo']) {
      const f = { ...noRelay(fixture(name)), id: newUlid() }
      app.send(f)
      expect((await app.expectFrame('error', (x) => x.ref === f.id, { direction: 'in' })).code).toBe('bad_frame')
    }
    await sleep(100)
    expect(eventTypes(r).filter((t) => t === 'reply')).toEqual([])
    expect(inFrames(other).some((x) => x.type === 'reply')).toBe(false)
  })

  it('an owner message whose author is app is bad_frame', async () => {
    const { app } = await world()
    const m = await app.buildMessage('general', 'hi', { author: 'app' })
    app.send(m)
    expect((await app.expectFrame('error', (x) => x.ref === m.id, { direction: 'in' })).code).toBe('bad_frame')
  })

  it('the bridge cannot send app.request: bad_frame to the bridge, nothing reaches any app', async () => {
    const { app, bridge } = await world()
    const f = await app.sign(toolsCall())
    const sent = bridge.send(f)
    const err = await bridge.expectFrame('error', (x) => x.ref === sent.id, { direction: 'in' })
    expect(err.code).toBe('bad_frame')
    await sleep(100)
    expect(inFrames(app).some((x) => x.type === 'app.request')).toBe(false)
  })
})

describe('app.request rate limit: 60 per minute per socket (M4.6)', () => {
  it('the 61st is rate_limited to its sender, the first 60 reached the bridge, another socket shares the budget', async () => {
    const { app, other, bridge } = await world()
    const ids: string[] = []
    for (let i = 0; i < 61; i++) {
      const f = await app.sign(toolsCall())
      ids.push(f.request_id)
      app.send(f)
    }
    const limited = await app.expectFrame('app.response', (x) => x.request_id === ids[60], {
      direction: 'in',
      timeoutMs: 10_000,
    })
    expect(limited).toMatchObject({ state: 'failed', error: { code: 'rate_limited' } })
    await waitFor(() => bridgeIn(bridge).filter((x) => x.type === 'app.request').length >= 60, 10_000, '60 forwarded')
    await sleep(150)
    expect(bridgeIn(bridge).filter((x) => x.type === 'app.request')).toHaveLength(60)
    expect(
      inFrames(app).filter(
        (x) => x.type === 'app.response' && (x.error as { code: string } | undefined)?.code === 'rate_limited',
      ),
    ).toHaveLength(1)
    const f = await other.sign(toolsCall())
    other.send(f)
    const shared = await other.expectFrame('app.response', (x) => x.request_id === f.request_id, { direction: 'in' })
    expect(shared).toMatchObject({ error: { code: 'rate_limited' } })
    expect(bridgeIn(bridge).filter((x) => x.type === 'app.request')).toHaveLength(60)
  })
})
