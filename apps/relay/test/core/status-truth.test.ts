// D17: thread status must not lie. Derived queued clears on a reply; working resets when the bridge drops or a new one authes.
import { fakeClock, sleep, waitFor } from '@talos-app/testkit'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { startTestRelay, type TestRelay } from './harness.ts'
import { advance, kit } from './helpers.ts'

vi.setConfig({ testTimeout: 20_000 })

let relay: TestRelay | null = null
afterEach(async () => {
  await relay?.stop()
  relay = null
})
const WAIT_MS = 10_000
const stateOf = (id: string) => (relay as TestRelay).runtime.store.getStatus(id)?.state

describe('status truth (D17)', () => {
  it('a reply clears a derived queued row and fans out idle', async () => {
    const c = fakeClock(new Date().toISOString())
    relay = await startTestRelay({ clock: c })
    const k = kit(relay)
    const app = await k.connectedApp()
    const bridge = await k.bridge({ verifyOwner: false, autoReply: false }).connect()
    const m = await app.sendMessage('general', 'slow one')
    await bridge.expectFrame('ack', (f) => f.ref === m.id && f.stage === 'consumed', { direction: 'out' })
    await sleep(40)
    await advance(c, 31_000, 5_000)
    await app.expectFrame('status', (f) => f.state === 'queued')
    expect(stateOf('general')).toBe('queued')
    bridge.reply('general', 'done')
    await app.expectFrame('status', (f) => f.state === 'idle' && f.thread_id === 'general')
    expect(stateOf('general')).toBe('idle')
  })

  it('a reply leaves a bridge-owned working row alone', async () => {
    relay = await startTestRelay()
    const k = kit(relay)
    const app = await k.connectedApp()
    const bridge = await k.bridge({ verifyOwner: false, autoReply: false }).connect()
    bridge.send({ type: 'status', thread_id: 'general', state: 'working', since: new Date().toISOString() })
    await app.expectFrame('status', (f) => f.state === 'working')
    bridge.reply('general', 'partial')
    await app.expectFrame('reply')
    await sleep(60)
    expect(stateOf('general')).toBe('working')
  })

  it('working resets to idle when the bridge drops, and the app is told', async () => {
    relay = await startTestRelay()
    const k = kit(relay)
    const app = await k.connectedApp()
    const bridge = await k.bridge({ verifyOwner: false, autoReply: false }).connect()
    bridge.send({ type: 'status', thread_id: 'general', state: 'working', since: new Date().toISOString() })
    await app.expectFrame('status', (f) => f.state === 'working')
    await bridge.close()
    await app.expectFrame('status', (f) => f.state === 'idle' && f.thread_id === 'general')
    expect(stateOf('general')).toBe('idle')
  })

  it('a row left working while no bridge was attached is reset when a new bridge authes', async () => {
    relay = await startTestRelay()
    const k = kit(relay)
    const r = relay.runtime
    r.store.setStatus({ thread_id: 'general', state: 'working', since: new Date().toISOString() })
    const bridge = await k.bridge({ verifyOwner: false, autoReply: false }).connect()
    await waitFor(() => stateOf('general') === 'idle', WAIT_MS, 'working reset on auth')
    await bridge.close()
  })

  const sessionState = (busy: boolean, scope?: { thread_id: string }) => ({
    session_id: scope ? `sess_${scope.thread_id}` : 'sess_main',
    ...(scope ? { scope } : {}),
    source: 'mod',
    capabilities: ['stop'],
    busy,
    ...(busy ? { turn_id: 'turn_1' } : {}),
    rate_limits: [],
    surfaces: [],
    at: new Date().toISOString(),
  })
  const working = (id: string) => ({ type: 'status', thread_id: id, state: 'working', since: new Date().toISOString() })

  it('main ending its turn (a Stop, or no set_status idle) idles the working row and tells the app', async () => {
    relay = await startTestRelay()
    const k = kit(relay)
    const app = await k.connectedApp()
    const bridge = await k.bridge({ verifyOwner: false, autoReply: false }).connect()
    bridge.send({ type: 'session.state', state: sessionState(true) })
    bridge.send(working('general'))
    await app.expectFrame('status', (f) => f.state === 'working')
    // still busy: a second busy frame changes nothing
    bridge.send({ type: 'session.state', state: sessionState(true) })
    await sleep(60)
    expect(stateOf('general')).toBe('working')
    bridge.send({ type: 'session.state', state: sessionState(false) })
    await app.expectFrame('status', (f) => f.state === 'idle' && f.thread_id === 'general')
    expect(stateOf('general')).toBe('idle')
  })

  it('a session going not-busy does not idle a row it never owned (dedicated thread, or another thread session)', async () => {
    relay = await startTestRelay()
    const k = kit(relay)
    const app = await k.connectedApp()
    const bridge = await k.bridge({ verifyOwner: false, autoReply: false }).connect()
    const cfg = { ...(app.rec.of('ready', 'in')[0]?.agent_config as Record<string, unknown>) }
    const threads = (cfg.threads as Array<Record<string, unknown>>).concat([
      {
        id: 'build',
        name: 'Build',
        kind: 'agent',
        order: 9,
        session: 'dedicated',
        created_at: new Date().toISOString(),
      },
      {
        id: 'other',
        name: 'Other',
        kind: 'agent',
        order: 10,
        session: 'dedicated',
        created_at: new Date().toISOString(),
      },
    ])
    const next = { ...cfg, rev: 9, threads, dedicated: { enabled: true } }
    bridge.send({ type: 'config.sync', config: next, rev: 9 })
    await app.expectFrame('config.sync', (f) => f.rev === 9)
    bridge.send({ type: 'session.state', state: sessionState(true) })
    bridge.send({ type: 'session.state', state: sessionState(true, { thread_id: 'build' }) })
    bridge.send(working('build'))
    bridge.send(working('other'))
    await sleep(80)
    // main ends: the dedicated threads are not main's
    bridge.send({ type: 'session.state', state: sessionState(false) })
    await sleep(120)
    expect(stateOf('build')).toBe('working')
    expect(stateOf('other')).toBe('working')
    // build's own session ends: only build goes idle
    bridge.send({ type: 'session.state', state: sessionState(false, { thread_id: 'build' }) })
    await app.expectFrame('status', (f) => f.state === 'idle' && f.thread_id === 'build')
    expect(stateOf('build')).toBe('idle')
    expect(stateOf('other')).toBe('working')
  })
})
