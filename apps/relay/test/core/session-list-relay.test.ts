// session.list through the REAL relay hub. The protocol lists it among the bridge's session frames the relay keeps for
// `ready` (frames.ts SESSION_BRIDGE_FRAME_TYPES, ready.session_list), but the relay's session module had no handler for it,
// so the bus dropped it: an open app never saw it and a reconnecting one found no `session_list` in `ready`. The last test
// keeps the module and the protocol's list in step, so the next session frame cannot be dropped the same way.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { SESSION_BRIDGE_FRAME_TYPES } from '@talos-app/protocol'
import { waitFor } from '@talos-app/testkit'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { startTestRelay, type TestRelay } from './harness.ts'
import { kit, silentBridge } from './helpers.ts'

vi.setConfig({ testTimeout: 20_000 })
let relay: TestRelay | null = null
afterEach(async () => {
  await relay?.stop()
  relay = null
})

const at = new Date().toISOString()
const sessions = [
  {
    id: 'bg_sample_1',
    kind: 'background',
    title: 'Run the test suite',
    status: 'working',
    thread_id: 'general',
    output: 'available',
    updated_at: at,
  },
]

describe('session.list through the real relay', () => {
  it('reaches an open app, and rides in the ready of an app that connects later', async () => {
    relay = await startTestRelay()
    const k = kit(relay)
    const open = await k.connectedApp()
    const b = await silentBridge(relay, relay.bridgeKey)
    b.send({ type: 'session.list', sessions, at })
    await open.expectFrame('session.list', undefined, { timeoutMs: 10_000 })
    const got = open.rec.of('session.list', 'in')[0] as Record<string, unknown> | undefined
    expect(got?.sessions).toEqual(sessions)
    expect(got?.at).toBe(at)
    await b.sync()
    const late = await k.connectedApp()
    const ready = late.rec.of('ready', 'in')[0] as Record<string, unknown>
    expect(ready.session_list).toEqual(sessions)
  })

  it('is forgotten when the Mac drops: a later app is never shown a "working" row from a Mac that is away', async () => {
    relay = await startTestRelay()
    const k = kit(relay)
    const b = await silentBridge(relay, relay.bridgeKey)
    b.send({ type: 'session.list', sessions, at })
    await b.sync()
    await b.close()
    await waitFor(() => !relay?.runtime.hub.bridgeOnline(), 10_000, 'bridge offline')
    const late = await k.connectedApp()
    const ready = late.rec.of('ready', 'in')[0] as Record<string, unknown>
    expect(ready.session_list).toBeUndefined()
  })

  it('forwards the validated list, not extra envelope fields', async () => {
    relay = await startTestRelay()
    const a = await kit(relay).connectedApp()
    const b = await silentBridge(relay, relay.bridgeKey)
    b.send({ type: 'session.list', sessions, at, padding: 'p'.repeat(150_000) })
    await a.expectFrame('session.list', undefined, { timeoutMs: 10_000 })
    const got = a.rec.of('session.list', 'in')[0]
    expect(JSON.stringify(got).length).toBeLessThan(10_000)
  })
})

describe('the relay handles every session frame the bridge sends (frames.ts SESSION_BRIDGE_FRAME_TYPES)', () => {
  it('each one has an onBridgeFrame handler in the session module', () => {
    const src = readFileSync(join(__dirname, '../../src/session/index.ts'), 'utf8')
    const handled = new Set([...src.matchAll(/onBridgeFrame\('([^']+)'/g)].map((m) => m[1]))
    for (const t of SESSION_BRIDGE_FRAME_TYPES)
      expect(handled.has(t), `${t} has no handler in apps/relay/src/session/index.ts`).toBe(true)
  })
})
