// The REAL relay hub with the session module (docs/CLAUDE-CODE.md C2.5): a signed control is held for the bridge until
// it acks `consumed`; state and results reach apps; a reconnecting app gets the last state in `ready`.
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { AGENT_LIMITS, newUlid, USAGE_AS_OF_FEATURE } from '@talos-app/protocol'
import { t } from '@talos-app/testkit'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { startTestRelay, type TestRelay } from './harness.ts'
import { kit, silentBridge } from './helpers.ts'

vi.setConfig({ testTimeout: t(30_000) })

let relay: TestRelay | null = null
afterEach(async () => {
  await relay?.stop()
  relay = null
})

const state = {
  session_id: 'sess_1',
  source: 'mod',
  capabilities: ['stop'],
  rate_limits: [],
  surfaces: [],
  at: new Date().toISOString(),
}

describe('session frames through the relay', () => {
  it('holds a control for the bridge until its result is recorded (consumed), replaying it on a new hello', async () => {
    relay = await startTestRelay()
    const k = kit(relay)
    const a = await k.connectedApp()
    const b = await silentBridge(relay, relay.bridgeKey)
    const sent = await a.sendSessionControl('general', { action: 'compact' })
    await vi.waitFor(() => expect(b.count('session.control', sent.id as string)).toBe(1), { timeout: t(10_000) })
    b.ack(sent.id as string, 'delivered')
    await b.close()
    const again = await silentBridge(relay, relay.bridgeKey)
    await vi.waitFor(() => expect(again.count('session.control', sent.id as string)).toBe(1), { timeout: t(10_000) }) // delivered is not consumed
    again.ack(sent.id as string, 'consumed')
    await again.sync() // the relay has handled the ack before the socket goes
    await again.close()
    const last = await silentBridge(relay, relay.bridgeKey)
    await last.sync()
    expect(last.count('session.control', sent.id as string)).toBe(0)
  })

  it('fans the bridge state out, delivers results, and gives a reconnecting app the last state in ready', async () => {
    relay = await startTestRelay()
    const k = kit(relay)
    const a = await k.connectedApp()
    const b = await silentBridge(relay, relay.bridgeKey)
    b.send({ type: 'session.state', state })
    await vi.waitFor(() => expect(a.rec.of('session.state', 'in')).toHaveLength(1), { timeout: t(10_000) })
    const controlId = newUlid()
    const res = { type: 'session.control.result', control_id: controlId, ok: true, text: 'Stopped.', at: state.at }
    b.send(res)
    await vi.waitFor(
      () => expect(a.rec.of('session.control.result', 'in')[0]).toMatchObject({ control_id: controlId, ok: true }),
      { timeout: t(10_000) },
    )
    expect(b.received.some((f) => f.type === 'ack')).toBe(true)
    const late = await k.connectedApp()
    expect(late.rec.of('ready', 'in')[0]?.session_state).toMatchObject({ session_id: 'sess_1' })
  })

  it('usage-as-of/1: listed to the bridge and the app; a state whose readings carry as_of reaches the app and ready intact', async () => {
    relay = await startTestRelay()
    const k = kit(relay)
    const a = await k.connectedApp()
    const b = await silentBridge(relay, relay.bridgeKey)
    const ready = b.received.find((f) => f.type === 'ready') as { features?: string[] } | undefined
    expect(ready?.features).toContain(USAGE_AS_OF_FEATURE)
    expect(a.rec.of('ready', 'in')[0]?.features).toContain(USAGE_AS_OF_FEATURE)
    const asOf = new Date(Date.now() - 180_000).toISOString()
    const rows = [
      { kind: 'seven_day', percent: 35, resets_at: new Date(Date.now() + 86_400_000).toISOString(), as_of: asOf },
      { kind: 'a_kind_from_later', percent: 2, as_of: asOf },
    ]
    b.send({ type: 'session.state', state: { ...state, rate_limits: rows } })
    await vi.waitFor(() => expect(a.rec.of('session.state', 'in')).toHaveLength(1), { timeout: t(10_000) })
    expect(a.rec.of('session.state', 'in')[0]?.state.rate_limits).toEqual(rows)
    const late = await k.connectedApp()
    expect(late.rec.of('ready', 'in')[0]?.session_state?.rate_limits).toEqual(rows)
  })

  it('session.agents: fanned out, the last one in ready, never stored (gone after a restart), never pushed', async () => {
    relay = await startTestRelay()
    const k = kit(relay)
    const a = await k.connectedApp()
    const b = await silentBridge(relay, relay.bridgeKey)
    const SENTINEL = 'sentinel-agent-title-7f3a'
    const agents = {
      session_id: 'sess_1',
      source: 'mod',
      rows: [
        {
          id: 'a1',
          kind: 'subagent',
          type: 'Explore',
          title: SENTINEL,
          status: 'running',
          background: true,
          stoppable: true,
          recent: [],
        },
      ],
      at: state.at,
    }
    b.send({ type: 'session.agents', agents })
    await vi.waitFor(() => expect(a.rec.of('session.agents', 'in')).toHaveLength(1), { timeout: t(10_000) })
    expect(a.rec.of('session.agents', 'in')[0]?.relay).toBeUndefined() // no seq: not durable
    const late = await k.connectedApp()
    expect(late.rec.of('ready', 'in')[0]?.session_agents).toMatchObject({ session_id: 'sess_1', rows: [{ id: 'a1' }] })
    expect(relay.transport.sent).toHaveLength(0)
    // a fresh app catching up from seq 0 is not handed the snapshot as a stored frame
    const fresh = await k.connectedApp()
    expect(fresh.rec.of('session.agents', 'in')).toHaveLength(0)
    await b.close()
    const dir = relay.dir
    await relay.stopKeepData()
    for (const f of readdirSync(dir, { recursive: true }) as string[]) {
      const p = join(dir, f)
      let bytes: Buffer
      try {
        bytes = readFileSync(p)
      } catch {
        continue // a directory
      }
      expect(bytes.includes(SENTINEL), `${f} holds the agents snapshot`).toBe(false)
    }
    relay = await startTestRelay({ dir })
    const after = await kit(relay).connectedApp()
    expect(after.rec.of('ready', 'in')[0]?.session_agents).toBeUndefined()
  })

  it('an oversize session.agents is refused at the relay (bad_frame to the bridge) and reaches no app', async () => {
    relay = await startTestRelay()
    const a = await kit(relay).connectedApp()
    const b = await silentBridge(relay, relay.bridgeKey)
    const row = (i: number) => ({
      id: `a${i}`,
      kind: 'subagent',
      type: 'Explore',
      title: 'x'.repeat(AGENT_LIMITS.text),
      status: 'running',
      background: true,
      stoppable: false,
      recent: Array.from({ length: AGENT_LIMITS.recent }, () => ({
        at: state.at,
        text: 'y'.repeat(AGENT_LIMITS.text),
      })),
    })
    const agents = {
      session_id: 'sess_1',
      source: 'mod',
      rows: Array.from({ length: AGENT_LIMITS.rows }, (_, i) => row(i)),
      at: state.at,
    }
    expect(JSON.stringify(agents).length).toBeGreaterThan(AGENT_LIMITS.frameBytes)
    b.send({ type: 'session.agents', agents })
    await vi.waitFor(() => expect(b.received.some((f) => f.type === 'error' && f.code === 'bad_frame')).toBe(true), {
      timeout: t(10_000),
    })
    expect(a.rec.of('session.agents', 'in')).toHaveLength(0)
  })

  it('a control while the Mac is offline is refused with mac_offline, not queued silently', async () => {
    relay = await startTestRelay()
    const a = await kit(relay).connectedApp()
    const sent = await a.sendSessionControl('general', { action: 'compact' })
    await vi.waitFor(
      () => expect(a.rec.of('error', 'in').some((e) => e.ref === sent.id && e.code === 'mac_offline')).toBe(true),
      { timeout: t(10_000) },
    )
  })
})
