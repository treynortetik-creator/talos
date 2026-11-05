// The relay's session module (docs/CLAUDE-CODE.md C2.5): last state and inventory kept for `ready`, state fanned out,
// results passed to apps durably, a signed control queued durably for the bridge and never altered.
import { readFileSync } from 'node:fs'
import { describe, expect, test } from 'vitest'
import { register } from '../src/session/index.ts'
import { createFakeServices } from './helpers/fake-services.ts'

const fx = (n: string) =>
  JSON.parse(
    readFileSync(new URL(`../../../packages/protocol/fixtures/frames/${n}.json`, import.meta.url), 'utf8'),
  ) as Record<string, unknown>

function rig() {
  const f = createFakeServices()
  const extras: Array<() => Record<string, unknown>> = []
  ;(f.bus as unknown as { readyExtra: (fn: () => Record<string, unknown>) => void }).readyExtra = (fn) =>
    void extras.push(fn)
  register(f.services)
  return { ...f, ready: () => Object.assign({}, ...extras.map((e) => e())) }
}

describe('relay session module', () => {
  test('keeps the last state and inventory for ready, and fans both out ephemerally', async () => {
    const r = rig()
    expect(r.ready()).toEqual({})
    const state = fx('session.state')
    const inv = fx('session.inventory')
    await r.bus.injectBridgeFrame(state)
    await r.bus.injectBridgeFrame(inv)
    expect(r.ready()).toEqual({ session_state: state.state, session_inventory: inv.inventory })
    expect(r.bus.toAppsLog.map((x) => x.frame.type)).toEqual(['session.state', 'session.inventory'])
    expect(r.bus.toAppsLog.every((x) => !x.opts)).toBe(true)
  })

  test('session.agents (docs/SUBAGENTS.md): the last snapshot rides in ready, fanned out ephemerally, nothing logged', async () => {
    const r = rig()
    const agents = fx('session.agents')
    await r.bus.injectBridgeFrame(agents)
    expect(r.ready()).toEqual({ session_agents: agents.agents })
    const next = { ...agents, id: '01JBF3V7Q8K2M4N6P8R0S2T4ZZ', agents: { ...(agents.agents as object), rows: [] } }
    await r.bus.injectBridgeFrame(next)
    expect(r.ready()).toEqual({ session_agents: next.agents }) // the LAST one, replaced wholesale
    expect(r.bus.toAppsLog.map((x) => x.frame.type)).toEqual(['session.agents', 'session.agents'])
    expect(r.bus.toAppsLog.every((x) => !x.opts)).toBe(true) // not durable: no seq, no catch-up, no push
    expect(JSON.stringify(r.logs)).not.toContain('research mods API')
    // a relay restart (a fresh module) has nothing: memory only
    expect(rig().ready()).toEqual({})
  })

  test('a control result is acked to the bridge and sent to apps once, durably', async () => {
    const r = rig()
    const res = fx('session.control.result')
    const first = await r.bus.injectBridgeFrame(res)
    const again = await r.bus.injectBridgeFrame(res)
    expect(first[0]).toMatchObject({ type: 'ack', ref: res.id })
    expect(again[0]).toMatchObject({ type: 'ack', ref: res.id })
    expect(r.bus.toAppsLog).toHaveLength(1)
    expect(r.bus.toAppsLog[0]?.opts).toEqual({ durable: true })
  })

  test('a signed control is queued durably for the bridge unchanged, and acked to the app', async () => {
    const r = rig()
    r.bus.setBridgeOnline(true)
    const c = fx('session.control')
    const replies = await r.bus.injectAppFrame(c, { deviceId: c.device_id as string })
    expect(replies[0]).toMatchObject({ type: 'ack', ref: c.id })
    expect(r.bus.toBridgeLog).toHaveLength(1)
    expect(r.bus.toBridgeLog[0]?.frame).toBe(c)
    expect(r.bus.toBridgeLog[0]?.opts).toMatchObject({ durable: true })
    await r.bus.injectAppFrame(c, { deviceId: c.device_id as string })
    expect(r.bus.toBridgeLog).toHaveLength(1)
  })

  test('refused: another device, or the Mac offline', async () => {
    const r = rig()
    const c = fx('session.control')
    const other = await r.bus.injectAppFrame(c, { deviceId: 'dev_someoneelse' })
    expect(other[0]).toMatchObject({ type: 'error', code: 'unauthorized' })
    const offline = await r.bus.injectAppFrame(c, { deviceId: c.device_id as string })
    expect(offline[0]).toMatchObject({ type: 'error', code: 'mac_offline' })
    expect(r.bus.toBridgeLog).toHaveLength(0)
  })
})
