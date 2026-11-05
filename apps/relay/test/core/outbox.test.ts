// Durable outbox to the bridge, supersede and session-stopped alarms, push rules, derived queued status (fake clock).
import { newId } from '@talos-app/protocol'
import { type FakeBridge, fakeClock, sleep, waitFor } from '@talos-app/testkit'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { startTestRelay, type TestRelay } from './harness.ts'
import { advance, kit, newConn, silentBridge, sub } from './helpers.ts'

vi.setConfig({ testTimeout: 20_000 })

let relay: TestRelay | null = null
afterEach(async () => {
  await relay?.stop()
  relay = null
})

const clock = () => fakeClock(new Date().toISOString())

// Waits are on observable state, never a bare sleep before a positive assertion: under load (many agents, load avg 15+)
// a frame or a push can take far longer than 60 ms, and the fake clock only moves when a test advances it.
const WAIT_MS = 10_000
const pushes = (n: number) => waitFor(() => (relay as TestRelay).transport.sent.length >= n, WAIT_MS, `${n} push(es)`)
/** The relay saw the bridge go away (so a fake-clock step that follows arms or fires its offline timers). */
const bridgeGone = () => waitFor(() => !(relay as TestRelay).runtime.hub.bridgeOnline(), WAIT_MS, 'bridge offline')
/** Ping/pong barrier: the relay handles bridge frames in order, so after the pong every earlier frame was handled. */
async function syncBridge(b: FakeBridge) {
  const nonce = `sync_${Math.random().toString(36).slice(2, 12)}`
  b.send({ type: 'ping', nonce })
  await b.expectFrame('pong', (f) => f.nonce === nonce, { timeoutMs: WAIT_MS })
}

describe('durable outbox', () => {
  it('resends an unacked frame after 5 s, 30 s and 2 min, and stops once the bridge has it', async () => {
    const c = clock()
    relay = await startTestRelay({ clock: c })
    const k = kit(relay)
    const a = await k.connectedApp()
    const b = await silentBridge(relay, relay.bridgeKey)
    const sent = await a.sendMessage('general', 'are you there')
    // Every wait below is on the bridge socket itself (`reaches` / `sync`), never a fixed sleep: under load a frame can
    // take far longer than 60 ms to cross app -> relay -> bridge, and the fake clock only moves when we advance it.
    await b.reaches('message', sent.id, 1)
    expect(b.count('message', sent.id)).toBe(1)
    await advance(c, 5_000, 1_000)
    await b.reaches('message', sent.id, 2)
    expect(b.count('message', sent.id)).toBe(2)
    await advance(c, 29_000, 1_000)
    await b.sync()
    expect(b.count('message', sent.id)).toBe(2)
    await advance(c, 1_000, 1_000)
    await b.reaches('message', sent.id, 3)
    expect(b.count('message', sent.id)).toBe(3)
    await advance(c, 120_000, 5_000)
    await b.reaches('message', sent.id, 4)
    expect(b.count('message', sent.id)).toBe(4)
    b.ack(sent.id, 'delivered') // it has the frame: no more timed resends, but it stays buffered until consumed
    await b.sync() // the relay has handled the ack before the clock moves
    await advance(c, 300_000, 5_000)
    await b.sync()
    expect(b.count('message', sent.id)).toBe(4)
    await b.close()
    const again = await silentBridge(relay, relay.bridgeKey)
    await again.reaches('message', sent.id, 1)
    expect(again.count('message', sent.id)).toBe(1) // delivered-but-unconsumed comes back on hello
    again.ack(sent.id, 'consumed')
    await again.sync()
    await again.close()
    const last = await silentBridge(relay, relay.bridgeKey)
    await last.sync()
    expect(last.count('message', sent.id)).toBe(0)
  })

  it('marks a hook.event that waited over 15 minutes as backlog', async () => {
    const c = clock()
    relay = await startTestRelay({ clock: c })
    const event = {
      id: newId('e'),
      source: 'generic',
      connection: newConn(),
      kind: 'generic.event',
      title: 'Deploy finished',
      summary: 'A deploy finished',
      actor: {},
      ts: new Date(c.now()).toISOString(),
      thread: 'inbox',
      work: false,
      priority: 'normal',
      dedup_key: 'generic:1',
    }
    const live = await relay.relay.services.bus.toBridge(
      { type: 'hook.event', event, delivery: 'live' },
      { durable: true },
    )
    expect(live.queued).toBe(true)
    await advance(c, 20 * 60_000, 60_000)
    const b = await silentBridge(relay, relay.bridgeKey)
    await b.reaches('hook.event', undefined, 1)
    const got = b.received.find((f) => f.type === 'hook.event')
    expect(got?.delivery).toBe('backlog')
  })

  it('a frame past its ttl is not resent', async () => {
    const c = clock()
    relay = await startTestRelay({ clock: c })
    await relay.relay.services.bus.toBridge(
      { type: 'device.revoked', device_id: 'd_aaaaaaaaaaaaaaaaaaaa' },
      { durable: true, ttl_s: 60 },
    )
    await advance(c, 120_000, 20_000)
    const b = await silentBridge(relay, relay.bridgeKey)
    await b.sync()
    expect(b.count('device.revoked')).toBe(0)
  })
})

describe('alarms', () => {
  it('a second bridge supersedes the first with 4409', async () => {
    relay = await startTestRelay()
    const k = kit(relay)
    const first = await k.bridge().connect()
    const second = await k.bridge().connect()
    await waitFor(() => first.closeCode !== null, WAIT_MS, 'first bridge closed')
    expect(first.closeCode).toBe(4409)
    expect(second.connected).toBe(true)
  })

  it('supersedes three times in an hour raise one push intent', async () => {
    const c = clock()
    relay = await startTestRelay({ clock: c })
    relay.runtime.store.putSub(sub())
    const k = kit(relay)
    const bridges = []
    for (let i = 0; i < 5; i++) {
      bridges.push(await k.bridge().connect())
      await sleep(30)
    }
    const keyAlarms = () =>
      (relay as TestRelay).transport.sent.filter(
        (s) => s.payload.notification.body === 'Your bridge key may be in use somewhere else',
      )
    await waitFor(() => keyAlarms().length >= 1, WAIT_MS, 'key alarm')
    await sleep(50) // room for a wrong second alarm to show up
    expect(keyAlarms()).toHaveLength(1)
  })

  it('no bridge for 5 minutes raises one "session stopped" push; a return raises "back"; a new outage inside the min gap is silent (V2.3)', async () => {
    const c = clock()
    relay = await startTestRelay({ clock: c })
    relay.runtime.store.putSub(sub())
    const k = kit(relay)
    const bridge = await k.bridge().connect()
    await bridge.close()
    await bridgeGone()
    await advance(c, 4 * 60_000, 20_000)
    expect(relay.transport.sent).toHaveLength(0)
    await advance(c, 2 * 60_000, 20_000)
    await pushes(1)
    expect(relay.transport.sent.map((s) => s.payload.notification.body)).toEqual(["Talos's Mac session stopped"])
    await advance(c, 30 * 60_000, 60_000)
    expect(relay.transport.sent).toHaveLength(1)
    const back = await k.bridge().connect()
    await advance(c, 30_000, 15_000)
    await pushes(2)
    expect(relay.transport.sent.map((s) => s.payload.notification.body)).toEqual([
      "Talos's Mac session stopped",
      "Talos's Mac is back",
    ])
    await back.close()
    await bridgeGone()
    await advance(c, 6 * 60_000, 20_000)
    expect(relay.transport.sent).toHaveLength(2) // MAC_ALERT_MIN_GAP_MIN (120): a laptop that sleeps again is silent
  })

  it('a bridge that reconnects within 5 minutes raises nothing', async () => {
    const c = clock()
    relay = await startTestRelay({ clock: c })
    relay.runtime.store.putSub(sub())
    const k = kit(relay)
    const b1 = await k.bridge().connect()
    await b1.close()
    await bridgeGone()
    await advance(c, 2 * 60_000, 20_000)
    await k.bridge().connect()
    await advance(c, 10 * 60_000, 20_000)
    expect(relay.transport.sent).toHaveLength(0)
  })
})

describe('push rules', () => {
  async function setup(configPatch: Record<string, unknown> = {}) {
    const c = clock()
    c.set(Date.parse('2026-10-28T15:00:00Z'))
    relay = await startTestRelay({ clock: c })
    relay.runtime.store.putSub(sub())
    const k = kit(relay)
    const app = await k.connectedApp({ visible: false })
    const bridge = await k.bridge().connect()
    if (Object.keys(configPatch).length) {
      const base = app.rec.of('ready', 'in')[0]?.agent_config as Record<string, unknown>
      bridge.send({ type: 'config.sync', config: { ...base, rev: 1, ...configPatch }, rev: 1 })
      await app.expectFrame('config.sync')
    }
    return { c, k, app, bridge }
  }
  const bodies = () => (relay as TestRelay).transport.sent.map((s) => s.payload.notification.body)

  it('sends when no socket is visible, with a fixed template and no message text', async () => {
    const { app, bridge } = await setup()
    bridge.reply('general', 'the launch code is hunter2')
    await app.expectFrame('reply')
    await pushes(1)
    expect(bodies()).toEqual(['New reply in General'])
    expect(JSON.stringify((relay as TestRelay).transport.sent)).not.toContain('hunter2')
  })

  it('stays silent while an app socket is visible, and sends again once it is hidden', async () => {
    const { app, bridge } = await setup()
    app.send({ type: 'visibility', state: 'visible' })
    await waitFor(() => (relay as TestRelay).runtime.hub.anyVisible(), WAIT_MS, 'visible')
    bridge.reply('general', 'one')
    await app.expectFrame('reply', (f) => f.message.text === 'one')
    await sleep(60)
    expect(bodies()).toEqual([])
    app.send({ type: 'visibility', state: 'hidden' })
    await waitFor(() => !(relay as TestRelay).runtime.hub.anyVisible(), WAIT_MS, 'hidden')
    bridge.reply('general', 'two')
    await app.expectFrame('reply', (f) => f.message.text === 'two')
    await pushes(1)
    expect(bodies()).toEqual(['New reply in General'])
  })

  describe('a visible screen only mutes pushes while someone is there', () => {
    const isPresent = () => (relay as TestRelay).runtime.hub.anyVisible()
    async function visibleSetup() {
      const c = clock()
      c.set(Date.parse('2026-10-28T15:00:00Z'))
      relay = await startTestRelay({ clock: c })
      relay.runtime.store.putSub(sub())
      const k = kit(relay)
      const app = await k.connectedApp({ visible: true })
      const bridge = await k.bridge().connect()
      return { c, app, bridge }
    }

    it('a visible screen nobody touches stops muting after 60 s and the phone gets the push', async () => {
      const { c, app, bridge } = await visibleSetup()
      expect(isPresent()).toBe(true)
      bridge.reply('general', 'one')
      await app.expectFrame('reply', (f) => f.message.text === 'one')
      await sleep(60)
      expect(bodies()).toEqual([]) // just arrived: someone is there
      await advance(c, 61_000, 20_000)
      expect(isPresent()).toBe(false)
      bridge.reply('general', 'two')
      await app.expectFrame('reply', (f) => f.message.text === 'two')
      await pushes(1)
      expect(bodies()).toEqual(['New reply in General'])
    })

    it('activity reports (visibility frames while visible) keep the screen counted as present', async () => {
      const { c, app, bridge } = await visibleSetup()
      for (let i = 0; i < 3; i++) {
        await advance(c, 40_000, 20_000)
        app.send({ type: 'visibility', state: 'visible' })
        await syncBridge(bridge) // keep ordering honest
        await sleep(30)
        expect(isPresent()).toBe(true)
      }
      bridge.reply('general', 'still here')
      await app.expectFrame('reply', (f) => f.message.text === 'still here')
      await sleep(60)
      expect(bodies()).toEqual([])
    })

    it('an older app that never reports activity mutes for at most one window after its last visibility change', async () => {
      const { c, app } = await visibleSetup()
      app.send({ type: 'visibility', state: 'visible' }) // its only frame, ever
      app.send({ type: 'ping', nonce: 'barrier1' }) // the relay handles app frames in order: after the pong it stamped ours
      await app.expectFrame('pong', (f) => f.nonce === 'barrier1')
      await advance(c, 59_000, 20_000)
      expect(isPresent()).toBe(true)
      await advance(c, 2_000, 1_000)
      expect(isPresent()).toBe(false)
    })

    it('a message the owner just sent counts as being there, with a client that sends no activity frames', async () => {
      const { c, app, bridge } = await visibleSetup()
      await advance(c, 70_000, 20_000)
      expect(isPresent()).toBe(false)
      await app.sendMessage('general', 'back at it')
      app.send({ type: 'ping', nonce: 'barrier3' }) // frames are handled in order: after the pong the message was stamped
      await app.expectFrame('pong', (f) => f.nonce === 'barrier3')
      expect(isPresent()).toBe(true)
      await advance(c, 30_000, 10_000)
      bridge.reply('general', 'thirty seconds later')
      await app.expectFrame('reply', (f) => f.message.text === 'thirty seconds later')
      await sleep(60)
      expect(bodies()).toEqual([])
    })

    it('a voice.ask counts as being there: a hands-free call is not an idle screen', async () => {
      const { c, app } = await visibleSetup()
      await advance(c, 70_000, 20_000)
      expect(isPresent()).toBe(false)
      const ask = await app.sendVoiceAsk('general', 'what is on my plate?')
      await app.expectFrame('error', (f) => f.ref === ask.id) // no voice module in this relay: refused, but the owner was there
      app.send({ type: 'ping', nonce: 'barrier2' })
      await app.expectFrame('pong', (f) => f.nonce === 'barrier2')
      expect(isPresent()).toBe(true)
    })

    it('a hidden screen is never present, however recent its last frame', async () => {
      const { app } = await visibleSetup()
      app.send({ type: 'visibility', state: 'hidden' })
      await waitFor(() => !isPresent(), WAIT_MS, 'hidden')
    })
  })

  it('is silent inside the quiet window and sends outside it', async () => {
    const { c, app, bridge } = await setup({ quiet_window: { start: '22:00', end: '07:00' }, timezone: 'UTC' })
    c.set(Date.parse('2026-10-28T23:30:00Z'))
    bridge.reply('general', 'late')
    await app.expectFrame('reply', (f) => f.message.text === 'late')
    await sleep(60)
    expect(bodies()).toEqual([])
    c.set(Date.parse('2026-10-29T07:30:00Z'))
    bridge.reply('general', 'morning')
    await app.expectFrame('reply', (f) => f.message.text === 'morning')
    await pushes(1)
    expect(bodies()).toEqual(['New reply in General'])
  })

  it('honours the per-thread notify setting and the master switch', async () => {
    const { c, app, bridge } = await setup()
    const base = app.rec.of('ready', 'in')[0]?.agent_config as { threads: Array<Record<string, unknown>> }
    const threads = base.threads.map((t) => (t.id === 'general' ? { ...t, notify: 'needs_you' } : t))
    bridge.send({ type: 'config.sync', config: { ...base, rev: 1, threads }, rev: 1 })
    await app.expectFrame('config.sync')
    bridge.reply('general', 'chatter')
    await app.expectFrame('reply')
    await sleep(60)
    expect(bodies()).toEqual([]) // needs_you threads ignore plain replies
    const card = bridge.createCard({ thread_id: 'general', title: 'Approve it' })
    await app.expectFrame('card.create', (f) => f.card.id === card.id)
    await pushes(1)
    expect(bodies()).toEqual(['Needs you in General'])
    // the card's own expiry reaches the transport, so the push is never kept past the card (D25)
    const left = (relay as TestRelay).transport.opts[0]?.secondsLeft
    const created = app.rec.of('card.create', 'in').find((f) => f.card.id === card.id)
    expect(left).toBeCloseTo((Date.parse(created?.card.expires_at ?? '') - c.now()) / 1000, 0)
    expect(left).toBeGreaterThan(0)
    bridge.send({
      type: 'config.sync',
      config: { ...base, rev: 2, threads, notifications: { master: false, show_thread_names: 'fixed_only' } },
      rev: 2,
    })
    await app.expectFrame('config.sync', (f) => f.rev === 2)
    bridge.createCard({ thread_id: 'general', title: 'Another' })
    await app.expectFrame('card.create', (f) => f.card.title === 'Another')
    await sleep(60) // the master switch is off: nothing more may arrive
    expect(bodies()).toEqual(['Needs you in General'])
  })

  it('drops a subscription the push service reports gone', async () => {
    const { app, bridge } = await setup()
    ;(relay as TestRelay).transport.send = async () => ({ ok: false, gone: true })
    bridge.reply('general', 'x')
    await app.expectFrame('reply')
    await waitFor(() => (relay as TestRelay).runtime.store.listSubs().length === 0, WAIT_MS, 'subscription dropped')
    expect((relay as TestRelay).runtime.store.listSubs()).toHaveLength(0)
  })
})

describe('derived queued status', () => {
  it('emits queued when a delivered message is not seen within 30 s, and not when it is', async () => {
    const c = clock()
    relay = await startTestRelay({ clock: c })
    const k = kit(relay)
    const app = await k.connectedApp()
    const bridge = await k.bridge({ verifyOwner: false, autoReply: false }).connect()
    const quiet = await app.sendMessage('general', 'fast one')
    await bridge.expectFrame('ack', (f) => f.ref === quiet.id && f.stage === 'consumed', { direction: 'out' })
    await syncBridge(bridge) // the relay has handled the ack (and armed the queued timer) before anything else
    bridge.send({ type: 'receipt', message_id: quiet.client_msg_id, state: 'seen' })
    await app.expectFrame('receipt', (f) => f.state === 'seen')
    await advance(c, 31_000, 5_000)
    await sleep(40)
    expect(app.rec.of('status', 'in')).toHaveLength(0)

    const slow = await app.sendMessage('general', 'slow one')
    await bridge.expectFrame('ack', (f) => f.ref === slow.id && f.stage === 'consumed', { direction: 'out' })
    await syncBridge(bridge)
    await advance(c, 31_000, 5_000)
    const status = await app.expectFrame('status', (f) => f.state === 'queued')
    expect(status.thread_id).toBe('general')
    expect(status.label).toBe('Busy with another task')
    // a reply clears it by way of the bridge's own status
    bridge.send({ type: 'status', thread_id: 'general', state: 'working', since: new Date().toISOString() })
    await app.expectFrame('status', (f) => f.state === 'working')
    const late = await k.connectedApp()
    expect(late.rec.of('ready', 'in')[0]?.statuses?.find((s) => s.thread_id === 'general')?.state).toBe('working')
  })
})
