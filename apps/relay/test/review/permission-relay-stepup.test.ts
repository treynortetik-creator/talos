// Changing permission_relay (who can approve the agent's tool calls) is a signed tap since 2026-11-14 (no Face ID, the
// owner's ruling): the patch reaches the Mac with no token, and an older app's token is stripped, never forwarded. Real relay,
// real auth, real signed owner frames.
import { FakeBridge } from '@talos-app/testkit'
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
  it('with no token it reaches the Mac (a signed tap is the approval)', async () => {
    const { app, bridge } = await rig()
    const f = await app.sendConfigPatch(0, { permission_relay: true })
    await bridge.expectFrame('config.patch', (x) => x.id === f.id, { direction: 'in' })
  })

  it("an older app's step-up token is accepted, never checked, and never forwarded to the Mac", async () => {
    const { app, bridge } = await rig()
    const f = await app.sendConfigPatch(0, { permission_relay: true }, { stepup_token: 'from-an-old-app' })
    const got = await bridge.expectFrame('config.patch', (x) => x.id === f.id, { direction: 'in' })
    expect('stepup_token' in (got as Record<string, unknown>)).toBe(false)
  })
})
