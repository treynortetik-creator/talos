// agent.recover through the real relay: a restart goes to the Mac and a repeated frame is queued once. A restore_last_good
// from an old app is refused in plain words and never queued (restoring is done at the Mac now), token or no token,
// trust mode or not, and the token is not spent.
import { FakeBridge, mkFrame, sleep } from '@talos-app/testkit'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { type RealRelay, startRealRelay } from './real-relay.ts'

vi.setConfig({ testTimeout: 20_000 })

let r: RealRelay | null = null
afterEach(async () => {
  await r?.stop()
  r = null
})

async function rig() {
  r = await startRealRelay()
  const o = await r.owner()
  const app = r.app(o)
  await app.connect()
  const bridge = await new FakeBridge({
    relayWs: r.wsBase,
    key: r.bridgeKey,
    verifyOwner: false,
    consume: 'manual',
  }).connect()
  return { rel: r, o, app, bridge }
}

describe('agent.recover at the relay', () => {
  it('a restart needs no passkey and reaches the Mac', async () => {
    const { app, bridge } = await rig()
    const f = await app.sendAgentRecover('restart')
    const got = await bridge.expectFrame('agent.recover', (x) => x.id === f.id, { direction: 'in' })
    expect(got.action).toBe('restart')
  })

  it('a restore from an old app is refused plainly, with or without a token, and never reaches the Mac or spends the token', async () => {
    const { rel, o, app, bridge } = await rig()
    const bare = await app.sendAgentRecover('restore_last_good')
    const e1 = await app.expectFrame('error', (e) => e.ref === bare.id)
    expect(e1.code).toBe('bad_frame')
    expect(e1.message).toContain('needs the Mac now')
    const stepup_token = rel.auth.core.mintStepup(o.sessionId, 'config:session')
    const withToken = await app.sendAgentRecover('restore_last_good', { stepup_token })
    expect((await app.expectFrame('error', (e) => e.ref === withToken.id)).message).toContain('needs the Mac now')
    await sleep(80)
    expect(bridge.rec.of('agent.recover', 'in')).toHaveLength(0)
    expect(rel.auth.core.consumeStepup(stepup_token, 'config:session', o.sessionId)).toBe(true) // still unspent
  })

  it('the same signed frame sent twice is queued once', async () => {
    const { app, bridge } = await rig()
    const f = await app.sendAgentRecover('restart')
    app.send(f)
    await sleep(120)
    expect(bridge.rec.of('agent.recover', 'in').map((x) => x.id)).toEqual([f.id])
  })

  it('with the Mac away a restart says mac_offline, and a restore is still told it needs the Mac', async () => {
    const { app, bridge } = await rig()
    await bridge.close()
    await sleep(120)
    const f = await app.sendAgentRecover('restart')
    expect((await app.expectFrame('error', (e) => e.ref === f.id)).code).toBe('mac_offline')
    const r = await app.sendAgentRecover('restore_last_good')
    expect((await app.expectFrame('error', (e) => e.ref === r.id)).message).toContain('needs the Mac now')
  })

  it('the Mac result reaches the app', async () => {
    const { app, bridge } = await rig()
    const f = await app.sendAgentRecover('restart')
    await bridge.expectFrame('agent.recover', (x) => x.id === f.id, { direction: 'in' })
    bridge.send({
      ...mkFrame('agent.recover.result'),
      control_id: f.control_id,
      ok: true,
      text: 'Done.',
      at: new Date().toISOString(),
    })
    const res = await app.expectFrame('agent.recover.result', (x) => x.control_id === f.control_id)
    expect(res).toMatchObject({ ok: true, text: 'Done.' })
  })

  it('a failed queue write leaves no seen mark: the retry of a restart goes through', async () => {
    const { rel, app, bridge } = await rig()
    const store = rel.runtime.store
    const real = store.enqueueOutbox.bind(store)
    let failed = false
    store.enqueueOutbox = (...a: Parameters<typeof real>) => {
      if (!failed) {
        failed = true
        throw new Error('disk full')
      }
      return real(...a)
    }
    const f = await app.sendAgentRecover('restart')
    expect((await app.expectFrame('error', (e) => e.ref === f.id)).code).toBe('internal')
    expect(bridge.rec.of('agent.recover', 'in')).toHaveLength(0)
    expect(store.seen(`ar:${f.id}`)).toBeUndefined()
    const retry = await app.sendAgentRecover('restart')
    await bridge.expectFrame('agent.recover', (x) => x.id === retry.id, { direction: 'in' })
    expect(store.seen(`ar:${retry.id}`)).toBeDefined()
  })

  it('trust mode on changes nothing: a restore is still refused', async () => {
    const { app, bridge } = await rig()
    const cfg = { ...(app.rec.of('ready', 'in')[0]?.agent_config as object) } as Record<string, unknown>
    bridge.send({ type: 'config.sync', config: { ...cfg, rev: 1, trust_mode: true }, rev: 1 })
    await app.expectFrame('config.sync', (f) => f.rev === 1)
    const r = await app.sendAgentRecover('restore_last_good')
    expect((await app.expectFrame('error', (e) => e.ref === r.id)).message).toContain('needs the Mac now')
    await sleep(80)
    expect(bridge.rec.of('agent.recover', 'in')).toHaveLength(0)
  })
})
