// Durable outbox to the bridge, supersede and session-stopped alarms, push rules, derived queued status (fake clock).
import { newId, newUlid, signChallenge } from '@talos-app/protocol'
import { type FakeBridge, fakeClock, sleep, t, waitFor } from '@talos-app/testkit'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_AGENT_CONFIG } from '../../src/core/default-config.ts'
import { startTestRelay, type TestRelay } from './harness.ts'
import { advance, kit, newConn, silentBridge, sub } from './helpers.ts'

vi.setConfig({ testTimeout: t(30_000) }) // the waits of one test add up past 20 s at the default budgets

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

  /** A bridge socket from `ip` that signs in, driven through the hub so the address can be chosen. */
  async function bridgeFrom(r: TestRelay, c: ReturnType<typeof clock>, ip: string, standby = false) {
    const sent: Array<Record<string, unknown>> = []
    const closes: number[] = []
    const conn = {
      send: (text: string) => void sent.push(JSON.parse(text)),
      close: (code: number) => void closes.push(code),
      terminate: () => void closes.push(-1),
    }
    const sock = r.runtime.hub.attachBridge(conn, { ip, relayHost: 'relay.example.com' })
    sock.onMessage(
      JSON.stringify({
        v: 1,
        type: 'hello',
        id: newUlid(),
        ts: new Date(c.now()).toISOString(),
        role: 'bridge',
        key_id: r.bridgeKey.keyId,
        sig: await signChallenge(r.bridgeKey.privateKey, sent[0] as never),
        client: { name: 'bridge', version: '1', ...(standby ? { features: [] } : {}) },
        agent_config_rev: 0,
        ...(standby ? { standby: true } : {}),
      }),
    )
    // a standby is turned away while another bridge holds the slot, and signs in when it finds the slot empty
    if (standby)
      await waitFor(
        () => closes.includes(4409) || sent.some((f) => f.type === 'ready'),
        WAIT_MS,
        `the standby from ${ip} answered`,
      )
    else await waitFor(() => sent.some((f) => f.type === 'ready'), WAIT_MS, `the bridge from ${ip} signed in`)
    return { closes, sock }
  }
  /** The owner's bridge sends its config, as a real one does after it signs in. */
  async function syncConfig(
    r: TestRelay,
    c: ReturnType<typeof clock>,
    sock: { onMessage: (t: string) => void },
    patch: Partial<typeof DEFAULT_AGENT_CONFIG>,
  ) {
    sock.onMessage(
      JSON.stringify({
        v: 1,
        type: 'config.sync',
        id: newUlid(),
        ts: new Date(c.now()).toISOString(),
        config: { ...DEFAULT_AGENT_CONFIG, ...patch, rev: 2 },
        rev: 2,
      }),
    )
    await waitFor(() => r.runtime.hub.agentConfig()?.rev === 2, WAIT_MS, 'the config synced')
  }
  const takeovers = (r: TestRelay) =>
    r.transport.sent.filter((s) => s.payload.notification.body.startsWith('Another Mac took over your Talos bridge'))

  it(
    'a replaced bridge that is still alive on another address pushes the owner at once, with the time in their zone',
    async () => {
      const c = fakeClock('2026-11-10T21:07:30.000Z')
      relay = await startTestRelay({ clock: c })
      relay.runtime.store.putSub(sub())
      const mine = await bridgeFrom(relay, c, '198.51.100.5')
      await syncConfig(relay, c, mine.sock, { timezone: 'Asia/Tokyo' })
      await bridgeFrom(relay, c, '203.0.113.9')
      expect(mine.closes).toContain(4409)
      await sleep(50)
      expect(takeovers(relay)).toHaveLength(0) // a replace alone proves nothing
      c.advance(60_000) // the time is the replace's, not the standby's
      await bridgeFrom(relay, c, '198.51.100.5', true) // the owner's Mac, still running, asks to come back
      await waitFor(() => takeovers(relay as TestRelay).length === 1, WAIT_MS, 'the takeover push')
      expect(takeovers(relay)[0]?.payload.notification.body).toBe('Another Mac took over your Talos bridge at 06:07')
    },
    t(60_000),
  )

  it('a Mac that redials over its own dead socket from a new address is not a takeover', async () => {
    const c = clock()
    relay = await startTestRelay({ clock: c })
    relay.runtime.store.putSub(sub())
    await bridgeFrom(relay, c, '198.51.100.5') // its socket died silently; the relay has not noticed yet
    await bridgeFrom(relay, c, '203.0.113.9') // the same Mac after a VPN or Wi-Fi change; no standby follows
    await sleep(50)
    expect(takeovers(relay)).toHaveLength(0)
  })

  it('a bridge that takes the slot and leaves before the owner asks back is still reported', async () => {
    const c = clock()
    relay = await startTestRelay({ clock: c })
    relay.runtime.store.putSub(sub())
    await bridgeFrom(relay, c, '198.51.100.5')
    const thief = await bridgeFrom(relay, c, '203.0.113.9') // takes ready and the backlog
    thief.sock.onClose()
    await bridgeFrom(relay, c, '198.51.100.5', true) // finds the slot empty and signs in again
    await waitFor(() => takeovers(relay as TestRelay).length === 1, WAIT_MS, 'the takeover push')
  })

  it('a standby long after the last replace is not a takeover', async () => {
    const c = clock()
    relay = await startTestRelay({ clock: c })
    relay.runtime.store.putSub(sub())
    await bridgeFrom(relay, c, '198.51.100.5')
    const other = await bridgeFrom(relay, c, '203.0.113.9')
    other.sock.onClose()
    c.advance(11 * 60_000)
    await bridgeFrom(relay, c, '198.51.100.5', true)
    await sleep(50)
    expect(takeovers(relay)).toHaveLength(0)
  })

  it('a standby from the same address is not a takeover', async () => {
    const c = clock()
    relay = await startTestRelay({ clock: c })
    relay.runtime.store.putSub(sub())
    await bridgeFrom(relay, c, '198.51.100.5')
    await bridgeFrom(relay, c, '198.51.100.5')
    await bridgeFrom(relay, c, '198.51.100.5', true)
    await sleep(50)
    expect(takeovers(relay)).toHaveLength(0)
  })

  it('a takeover before any config arrives says no time rather than a wrong one', async () => {
    const c = clock()
    relay = await startTestRelay({ clock: c })
    relay.runtime.store.putSub(sub())
    await bridgeFrom(relay, c, '198.51.100.5')
    await bridgeFrom(relay, c, '203.0.113.9')
    await bridgeFrom(relay, c, '198.51.100.5', true)
    await waitFor(() => takeovers(relay as TestRelay).length === 1, WAIT_MS, 'the takeover push')
    expect(takeovers(relay)[0]?.payload.notification.body).toBe('Another Mac took over your Talos bridge')
  })

  it('a time zone that cannot be read gives no time', async () => {
    const c = clock()
    relay = await startTestRelay({ clock: c })
    relay.runtime.store.putSub(sub())
    await bridgeFrom(relay, c, '198.51.100.5')
    const hub = relay.runtime.hub as unknown as { agentConfig: () => unknown }
    const real = hub.agentConfig.bind(hub)
    hub.agentConfig = () => ({ ...(real() as object), ...DEFAULT_AGENT_CONFIG, timezone: 'Not/AZone' })
    await bridgeFrom(relay, c, '203.0.113.9')
    await bridgeFrom(relay, c, '198.51.100.5', true)
    await waitFor(() => takeovers(relay as TestRelay).length === 1, WAIT_MS, 'the takeover push')
    expect(takeovers(relay)[0]?.payload.notification.body).toBe('Another Mac took over your Talos bridge')
  })

  it(
    'takeover pushes come at most once in 10 minutes',
    async () => {
      const c = clock()
      relay = await startTestRelay({ clock: c })
      relay.runtime.store.putSub(sub())
      await bridgeFrom(relay, c, '198.51.100.5')
      await bridgeFrom(relay, c, '203.0.113.9')
      await bridgeFrom(relay, c, '198.51.100.5', true)
      await waitFor(() => takeovers(relay as TestRelay).length === 1, WAIT_MS, 'the first takeover push')
      // the same takeover asks again every minute: told once
      c.advance(60_000)
      await bridgeFrom(relay, c, '198.51.100.5', true)
      // a second takeover 5 minutes in: still within the 10
      c.advance(4 * 60_000)
      await bridgeFrom(relay, c, '203.0.113.9')
      await bridgeFrom(relay, c, '198.51.100.5', true)
      await sleep(50)
      expect(takeovers(relay)).toHaveLength(1)
      // another one after 10 minutes is told
      c.advance(6 * 60_000)
      await bridgeFrom(relay, c, '203.0.113.9')
      await bridgeFrom(relay, c, '198.51.100.5', true)
      await waitFor(() => takeovers(relay as TestRelay).length === 2, WAIT_MS, 'the takeover push after 10 minutes')
    },
    t(90_000),
  )

  it('a takeover push is heard even with notifications switched off', async () => {
    const c = clock()
    relay = await startTestRelay({ clock: c })
    relay.runtime.store.putSub(sub())
    const owner = await bridgeFrom(relay, c, '198.51.100.5')
    await syncConfig(relay, c, owner.sock, {
      notifications: { master: false, show_thread_names: 'fixed_only', web_message_text: true },
    })
    expect(relay.runtime.hub.agentConfig()?.notifications.master).toBe(false)
    await bridgeFrom(relay, c, '203.0.113.9')
    await bridgeFrom(relay, c, '198.51.100.5', true)
    await waitFor(() => takeovers(relay as TestRelay).length === 1, WAIT_MS, 'the takeover push')
  })

  it(
    'supersedes three times in an hour raise one push intent',
    async () => {
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
    },
    t(60_000),
  )

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

  it('sends a reply with the thread name and a preview of the reply', async () => {
    const { app, bridge } = await setup()
    bridge.reply('general', 'the launch window opens at nine')
    await app.expectFrame('reply')
    await pushes(1)
    expect(bodies()).toEqual(['the launch window opens at nine'])
    expect((relay as TestRelay).transport.sent[0]?.payload.notification.title).toBe('General')
  })

  it('a secret in a reply never reaches the push (a password line, through the real hub)', async () => {
    const { app, bridge } = await setup()
    bridge.reply('general', 'the launch code: password=hunter2 ok')
    await app.expectFrame('reply')
    await pushes(1)
    expect(JSON.stringify((relay as TestRelay).transport.sent)).not.toContain('hunter2')
  })

  it(
    'a reply still pushes to the phone while an app socket (a Mac window) is visible',
    async () => {
      const { app, bridge } = await setup()
      app.send({ type: 'visibility', state: 'visible' })
      await waitFor(() => (relay as TestRelay).runtime.hub.anyVisible(), WAIT_MS, 'visible')
      bridge.reply('general', 'one')
      await app.expectFrame('reply', (f) => f.message.text === 'one')
      await pushes(1)
      expect(bodies()).toEqual(['one'])
      app.send({ type: 'visibility', state: 'hidden' })
      await waitFor(() => !(relay as TestRelay).runtime.hub.anyVisible(), WAIT_MS, 'hidden')
      bridge.reply('general', 'two')
      await app.expectFrame('reply', (f) => f.message.text === 'two')
      await pushes(2)
      expect(bodies()).toEqual(['one', 'two'])
    },
    t(90_000),
  )

  describe('the relay still tracks who is at a screen (scheduler alerts use it), and no reply push depends on it', () => {
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

    it('a visible screen nobody touches stops counting as present after 60 s; the phone gets the push before and after', async () => {
      const { c, app, bridge } = await visibleSetup()
      expect(isPresent()).toBe(true)
      bridge.reply('general', 'one')
      await app.expectFrame('reply', (f) => f.message.text === 'one')
      await pushes(1) // someone is there, and the phone is told anyway
      await advance(c, 61_000, 20_000)
      expect(isPresent()).toBe(false)
      bridge.reply('general', 'two')
      await app.expectFrame('reply', (f) => f.message.text === 'two')
      await pushes(2)
      expect(bodies()).toEqual(['one', 'two'])
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
      await pushes(1)
      expect(bodies()).toEqual(['still here'])
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
      await pushes(1)
      expect(bodies()).toEqual(['thirty seconds later'])
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
    // timing-ok: negative window: no push inside quiet hours
    await sleep(t(150))
    expect(bodies()).toEqual([])
    c.set(Date.parse('2026-10-29T07:30:00Z'))
    bridge.reply('general', 'morning')
    await app.expectFrame('reply', (f) => f.message.text === 'morning')
    await pushes(1)
    expect(bodies()).toEqual(['morning'])
  })

  it('honours the per-thread notify setting and the master switch', async () => {
    const { c, app, bridge } = await setup()
    const base = app.rec.of('ready', 'in')[0]?.agent_config as { threads: Array<Record<string, unknown>> }
    const threads = base.threads.map((t) => (t.id === 'general' ? { ...t, notify: 'needs_you' } : t))
    bridge.send({ type: 'config.sync', config: { ...base, rev: 1, threads }, rev: 1 })
    await app.expectFrame('config.sync')
    bridge.reply('general', 'chatter')
    await app.expectFrame('reply')
    // timing-ok: negative window: needs_you threads push nothing for a plain reply
    await sleep(t(150))
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
      config: {
        ...base,
        rev: 2,
        threads,
        notifications: { master: false, show_thread_names: 'fixed_only', web_message_text: true },
      },
      rev: 2,
    })
    await app.expectFrame('config.sync', (f) => f.rev === 2)
    bridge.createCard({ thread_id: 'general', title: 'Another' })
    await app.expectFrame('card.create', (f) => f.card.title === 'Another')
    // timing-ok: negative window: the master switch is off, nothing more arrives
    await sleep(t(150)) // the master switch is off: nothing more may arrive
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
