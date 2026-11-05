// Changing permission_relay (who can approve the agent's tool calls) needs a step-up (Face ID) token for exactly that
// purpose, from this session, used once. Only the relay can enforce it: the Mac never sees the token. Real relay, real auth,
// real step-up tokens, real signed owner frames.
import { FakeBridge, sleep } from '@talos-app/testkit'
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
  const other = await r.owner()
  const app = r.app(o)
  await app.connect()
  const bridge = await new FakeBridge({
    relayWs: r.wsBase,
    key: r.bridgeKey,
    verifyOwner: false,
    consume: 'manual',
  }).connect()
  return { rel: r, o, other, app, bridge }
}

describe('config.patch of permission_relay', () => {
  it('without a step-up token is refused with stepup_required and never reaches the Mac', async () => {
    const { app, bridge } = await rig()
    const f = await app.sendConfigPatch(0, { permission_relay: true })
    expect((await app.expectFrame('error', (e) => e.ref === f.id)).code).toBe('stepup_required')
    await sleep(80)
    expect(bridge.rec.of('config.patch', 'in')).toHaveLength(0)
  })

  it('with a token for another purpose, another session, or made up is refused with stepup_invalid', async () => {
    const { rel, o, other, app, bridge } = await rig()
    const tokens = [
      rel.auth.core.mintStepup(o.sessionId, 'device:revoke'),
      rel.auth.core.mintStepup(other.sessionId, 'config:session'),
      'st_made_up',
    ]
    for (const stepup_token of tokens) {
      const f = await app.sendConfigPatch(0, { permission_relay: true }, { stepup_token })
      expect((await app.expectFrame('error', (e) => e.ref === f.id)).code).toBe('stepup_invalid')
    }
    await sleep(80)
    expect(bridge.rec.of('config.patch', 'in')).toHaveLength(0)
  })

  it('with a good token goes through once; the same token a second time is refused', async () => {
    const { rel, o, app, bridge } = await rig()
    const stepup_token = rel.auth.core.mintStepup(o.sessionId, 'config:session')
    const first = await app.sendConfigPatch(0, { permission_relay: true }, { stepup_token })
    await bridge.expectFrame('config.patch', (f) => f.id === first.id, { direction: 'in' })
    const second = await app.sendConfigPatch(0, { permission_relay: false }, { stepup_token })
    expect((await app.expectFrame('error', (e) => e.ref === second.id)).code).toBe('stepup_invalid')
    await sleep(80)
    expect(bridge.rec.of('config.patch', 'in').map((x) => x.id)).toEqual([first.id])
  })

  it('a token for config:work cannot change permission_relay', async () => {
    const { rel, o, app, bridge } = await rig()
    const f = await app.sendConfigPatch(
      0,
      { permission_relay: true },
      { stepup_token: rel.auth.core.mintStepup(o.sessionId, 'config:work') },
    )
    expect((await app.expectFrame('error', (e) => e.ref === f.id)).code).toBe('stepup_invalid')
    await sleep(80)
    expect(bridge.rec.of('config.patch', 'in')).toHaveLength(0)
  })
})
