// Independent review of PR #86 (MCP Apps WP-AP2). Real relay, testkit fakes. Tests named "FINDING" fail on the PR head
// and describe what should hold; the rest pin properties that hold and should keep holding.
import { newUlid } from '@talos-app/protocol'
import { type FakeApp, type FakeBridge, mkFrame, sleep, waitFor } from '@talos-app/testkit'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { startTestRelay, type TestRelay } from '../core/harness.ts'
import { kit } from '../core/helpers.ts'
import { fixture, getApp, goodHeader, newMediaId, putPage, SESSION, text } from './helpers.ts'

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

async function world(n: number) {
  relay = await startTestRelay()
  const k = kit(relay)
  const apps: FakeApp[] = []
  for (let i = 0; i < n; i++) {
    const a = await k.connectedApp()
    apps.push(a)
    open.push(a)
  }
  const pinned = Object.fromEntries(apps.map((a) => [a.device.deviceId, a.device.publicJwk]))
  const bridge = await k.bridge({ pinnedDevices: pinned, autoReply: false }).connect()
  open.push(bridge)
  return { relay, k, apps, bridge }
}

describe('PR86 review: the app.request rate limit', () => {
  // M4.6 budget is per socket, so the owner's total is 60 x sockets. A tab that reconnects (or a page that opens more
  // sockets with the same session) gets a fresh 60 every time. The bridge is the only other brake.
  it('FINDING: the 60/min budget is per socket only; 4 sockets of one session push 240 requests/min to the Mac', async () => {
    const { apps, bridge } = await world(4)
    // Sign everything first, then send as one burst: the bucket refills at 1/s, so signing between sends (slow on a
    // loaded box) would let the 61st request in and the budget would read as 61.
    const signed = await Promise.all(
      apps.map(async (a) => Promise.all(Array.from({ length: 60 }, () => a.sign(toolsCall())))),
    )
    apps.forEach((a, i) => {
      for (const f of signed[i] ?? []) a.send(f)
    })
    // each socket's frames are handled in order, so its pong proves everything it sent has been handled
    await Promise.all(
      apps.map(async (a) => {
        const nonce = mkFrame('ping').id.slice(-12)
        a.send({ ...mkFrame('ping'), nonce })
        await a.expectFrame('pong', (f) => f.nonce === nonce, { direction: 'in' })
      }),
    )
    const forwarded = bridgeIn(bridge).filter((x) => x.type === 'app.request').length
    expect(forwarded).toBeLessThanOrEqual(60)
  })

  it('FINDING: closing and reopening a socket resets the budget (a fresh 60 per reconnect)', async () => {
    const { k, apps, bridge } = await world(1)
    const first = apps[0] as FakeApp
    for (let i = 0; i < 60; i++) first.send(await first.sign(toolsCall()))
    await waitFor(() => bridgeIn(bridge).filter((x) => x.type === 'app.request').length >= 60, 10_000, '60')
    await first.close()
    const again = await k.connectedApp({ deviceKey: first.device })
    open.push(again)
    const f = await again.sign(toolsCall())
    again.send(f)
    const res = await again
      .expectFrame('app.response', (x) => x.request_id === f.request_id, { direction: 'in', timeoutMs: 1500 })
      .catch(() => null)
    // the same device/session is still over its minute: the request should be rate_limited, not forwarded
    expect(bridgeIn(bridge).filter((x) => x.type === 'app.request').length).toBe(60)
    expect(res).toMatchObject({ state: 'failed', error: { code: 'rate_limited' } })
  })
})

describe('PR86 review: routing an app request error by frame id', () => {
  // The relay keys `error{ref}` routing by the client-chosen frame id. A second request reusing a frame id (another
  // tab, or the same tab) overwrites the first's entry: the bridge's error for the FIRST request is then delivered as a
  // failure of the SECOND one (which may well have succeeded on the Mac), and the first asker never hears back.
  it('FINDING: a reused frame id misroutes the bridge error; the first asker is left hanging', async () => {
    const { apps, bridge } = await world(2)
    const [a, b] = apps as [FakeApp, FakeApp]
    const frameId = newUlid()
    const fa = await a.sign(toolsCall({ id: frameId }))
    a.send(fa)
    await bridge.expectFrame('app.request', (x) => x.request_id === fa.request_id, { direction: 'in' })
    const fb = await b.sign(toolsCall({ id: frameId }))
    b.send(fb)
    await sleep(300)
    // the bridge refuses A's request (the one that reached it first under this id)
    bridge.send({ type: 'error', ref: frameId, code: 'sig_invalid', message: 'bad sig' })
    await sleep(400)
    const bGotFailure = inFrames(b).some((x) => x.type === 'app.response' && x.request_id === fb.request_id)
    const aGotFailure = inFrames(a).some((x) => x.type === 'app.response' && x.request_id === fa.request_id)
    expect(bGotFailure).toBe(false)
    expect(aGotFailure).toBe(true)
  })
})

describe('PR86 review: properties that hold', () => {
  it('app.update survives a relay restart and is replayed to a fresh app', async () => {
    relay = await startTestRelay()
    const dir = relay.dir
    const bridgeKey = relay.bridgeKey
    const bridge = await kit(relay).bridge({ autoReply: false }).connect()
    const { relay: _r, ...u } = { ...fixture('app.update'), id: newUlid(), ts: new Date().toISOString() } as Record<
      string,
      unknown
    >
    bridge.send(u as never)
    await waitFor(
      () =>
        (
          (relay as TestRelay).runtime.store.db
            .prepare("select count(*) n from core_events where type = 'app.update'")
            .get() as { n: number }
        ).n === 1,
      5000,
      'stored',
    )
    await bridge.close()
    await relay.stopKeepData()
    relay = await startTestRelay({ dir, bridgeKey })
    const fresh = await kit(relay).connectedApp()
    open.push(fresh)
    fresh.send({ type: 'catchup.request', since_seq: 0 })
    await fresh.expectFrame('catchup.batch', (b) => JSON.stringify(b.frames).includes(String(u.id)), {
      direction: 'in',
    })
  })

  it('a response for request R never reaches a socket that did not ask, even one on the same device', async () => {
    const { apps, bridge } = await world(3)
    const [a, b, c] = apps as [FakeApp, FakeApp, FakeApp]
    const f = await a.sign(toolsCall())
    a.send(f)
    await bridge.expectFrame('app.request', (x) => x.id === f.id, { direction: 'in' })
    bridge.send({
      type: 'app.response',
      view_id: VIEW,
      request_id: f.request_id,
      state: 'done',
      result: { content: [{ type: 'text', text: 'secret' }] },
    } as never)
    await a.expectFrame('app.response', (x) => x.request_id === f.request_id, { direction: 'in' })
    await sleep(200)
    expect(JSON.stringify(inFrames(b))).not.toContain('secret')
    expect(JSON.stringify(inFrames(c))).not.toContain('secret')
  })

  it('the served CSP cannot be widened from the header: quote, semicolon, unsafe-inline, self, http and bare * are refused', async () => {
    relay = await startTestRelay()
    const raw = (o: Record<string, unknown>) => Buffer.from(JSON.stringify(o)).toString('base64url')
    const base = {
      connect_domains: [],
      resource_domains: [],
      frame_domains: [],
      base_uri_domains: [],
      script_hashes: [],
      script_urls: [],
      style_urls: [],
    }
    const evil = [
      { ...base, connect_domains: ["https://a.example.com; script-src 'unsafe-inline'"] },
      { ...base, connect_domains: ["'self'"] },
      { ...base, connect_domains: ['*'] },
      { ...base, connect_domains: ['http://a.example.com'] },
      { ...base, script_hashes: ["'unsafe-inline'"] },
      { ...base, script_urls: ['https://cdn.example.com/x.js;sandbox'] },
      { ...base, resource_domains: ['https://*.example.com'] }, // covers relay.example.com
      { ...base, sandbox: 'allow-same-origin' },
    ]
    for (const e of evil) {
      const id = newMediaId()
      const res = await putPage(relay, id, { csp: raw(e) })
      expect(res.status, JSON.stringify(e)).toBe(400)
      expect((await getApp(relay, id)).status).toBe(404)
    }
  })

  it('the app page is an opaque origin with nosniff and a fixed text/html type, and needs a session', async () => {
    relay = await startTestRelay()
    const id = newMediaId()
    expect((await putPage(relay, id, { csp: goodHeader(), body: text('<!doctype html><p>x</p>') })).status).toBe(200)
    const res = await getApp(relay, id)
    expect(res.status).toBe(200)
    const csp = res.headers.get('content-security-policy') as string
    expect(csp.startsWith('sandbox allow-scripts;')).toBe(true)
    expect(csp).not.toContain('allow-same-origin')
    expect(csp).not.toContain('allow-top-navigation')
    expect(csp).not.toContain('allow-popups')
    expect(csp).not.toContain('allow-forms')
    expect(res.headers.get('x-content-type-options')).toBe('nosniff')
    expect(res.headers.get('content-type')).toBe('text/html; charset=utf-8')
    const anon = await fetch(`${relay.httpBase}/media/${id}/app`)
    expect(anon.status).toBe(401)
    expect(await anon.text()).not.toContain('<p>x</p>')
    const page = await fetch(`${relay.httpBase}/media/${id}/page`, { headers: SESSION })
    expect(page.status).toBe(404)
  })
})
