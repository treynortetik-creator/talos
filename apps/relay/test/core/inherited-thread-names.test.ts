// A thread id that every object already has (`constructor`) is not accepted as a NEW thread, but one stored before the
// rule keeps working, and its counts stay numbers (an inherited member must never be read as "an unread count").
import { sleep } from '@talos-app/testkit'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { startTestRelay, type TestRelay } from './harness.ts'
import { bridgeFetch, kit } from './helpers.ts'

vi.setConfig({ testTimeout: 20_000 })
let relay: TestRelay | null = null
afterEach(async () => {
  await relay?.stop()
  relay = null
})

const at = '2026-10-28T15:00:00.000Z'
const thread = (id: string, over: Record<string, unknown> = {}) => ({
  id,
  name: id,
  kind: 'agent',
  order: 5,
  notify: 'all',
  voice_context: 'recent',
  archived: false,
  created_at: at,
  ...over,
})
const post = async (r: TestRelay, frame: Record<string, unknown>) => {
  const body = JSON.stringify({
    v: 1,
    id: `01JBF3V7Q8K2M4N6P8R0S${String(Math.random()).slice(2, 7)}`,
    ts: at,
    ...frame,
  })
  return bridgeFetch(r, 'POST', '/bridge/post', body, { 'content-type': 'application/json' })
}

describe('thread.upsert', () => {
  it('that ADDS a thread called constructor is refused and the thread is not stored', async () => {
    relay = await startTestRelay()
    const res = await post(relay, { type: 'thread.upsert', thread: thread('constructor') })
    expect(res.status).toBe(400)
    expect(relay.runtime.store.listThreads().map((t) => t.id)).not.toContain('constructor')
    const app = await kit(relay).connectedApp()
    expect(app.rec.of('ready', 'in')[0]?.threads?.map((t) => t.id)).not.toContain('constructor')
  })

  it('for a constructor thread the relay already holds is accepted (an edit, not an add)', async () => {
    relay = await startTestRelay()
    relay.runtime.store.upsertThread(thread('constructor') as never)
    const res = await post(relay, { type: 'thread.upsert', thread: thread('constructor', { topic: 'edited' }) })
    expect(res.status).toBe(200)
    expect(relay.runtime.store.listThreads().find((t) => t.id === 'constructor')?.topic).toBe('edited')
  })
})

describe('config.sync', () => {
  const base = async (r: TestRelay) => {
    const k = kit(r)
    const a = await k.connectedApp()
    const bridge = await k.bridge().connect()
    const cfg = { ...(a.rec.of('ready', 'in')[0]?.agent_config as object) } as {
      threads: unknown[]
      rev: number
    }
    return { k, a, bridge, cfg }
  }

  it('that adds a constructor thread to a config the relay holds is refused; the old config stays', async () => {
    relay = await startTestRelay()
    const { a, bridge, cfg } = await base(relay)
    bridge.send({ type: 'config.sync', config: { ...cfg, rev: 3 }, rev: 3 })
    await a.expectFrame('config.sync', (f) => f.rev === 3)
    const bad = bridge.send({
      type: 'config.sync',
      config: { ...cfg, rev: 4, threads: [...cfg.threads, thread('constructor')] },
      rev: 4,
    })
    const err = await bridge.expectFrame('error', (f) => f.ref === bad.id)
    expect(err.code).toBe('bad_frame')
    await sleep(50)
    expect(relay.relay.services.agentConfig()?.rev).toBe(3)
  })

  it('that keeps a constructor thread the relay already holds is applied and the ready frame carries it', async () => {
    relay = await startTestRelay()
    const { k, a, bridge, cfg } = await base(relay)
    const withIt = { ...cfg, threads: [...cfg.threads, thread('constructor')] }
    // the first sync after an upgrade: the relay holds no config yet, so nothing is "added"; it is applied
    bridge.send({ type: 'config.sync', config: { ...withIt, rev: 5 }, rev: 5 })
    await a.expectFrame('config.sync', (f) => f.rev === 5)
    bridge.send({ type: 'config.sync', config: { ...withIt, rev: 6 }, rev: 6 })
    await a.expectFrame('config.sync', (f) => f.rev === 6)
    const late = await k.connectedApp()
    expect(late.rec.of('ready', 'in')[0]?.threads?.map((t) => t.id)).toContain('constructor')
  })
})

describe('unread counts for a thread named constructor', () => {
  it('marking it unread gives 1 in ready, never a function or NaN', async () => {
    relay = await startTestRelay()
    const k = kit(relay)
    const a = await k.connectedApp()
    a.send({ type: 'thread.unread', thread_id: 'constructor' })
    const f = await a.expectFrame('thread.unread', (x) => x.count !== undefined)
    expect(f.count).toBe(1)
    expect(relay.runtime.store.unreadByThread()).toEqual({ constructor: 1 })
    const late = await k.connectedApp()
    expect(JSON.parse(JSON.stringify(late.rec.of('ready', 'in')[0]?.unread))).toEqual({ constructor: 1 })
  })
})
