// Nyx's address (`memory.nyx_url`) is the owner's setting in the app's Memory screen: a signed owner frame carrying an https
// address reaches the Mac; http, javascript: and spaces are turned away at the relay, naming the field, before the Mac sees them.
import { FakeBridge, sleep } from '@talos-app/testkit'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { type RealRelay, startRealRelay } from './real-relay.ts'

vi.setConfig({ testTimeout: 20_000 }) // timing-ok: the limit of a real relay start, no wait inside it

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
  return { app, bridge }
}

describe('config.patch of memory.nyx_url', () => {
  it('an https address reaches the Mac', async () => {
    const { app, bridge } = await rig()
    const f = await app.sendConfigPatch(0, { memory: { nyx_url: 'https://nyx.example.com' } })
    await bridge.expectFrame('config.patch', (x) => x.id === f.id, { direction: 'in' })
  })

  it('http, javascript:, spaces and a non-string are refused with the field named, and never reach the Mac', async () => {
    const { app, bridge } = await rig()
    for (const bad of ['http://nyx.example.com', 'javascript:alert(1)', 'https://nyx.example.com/a b', 7]) {
      const f = await app.sendConfigPatch(0, { memory: { nyx_url: bad } })
      const err = await app.expectFrame('error', (e) => e.ref === f.id)
      expect(err.code).toBe('config_field_forbidden')
      expect(err.message).toBe('field not allowed: memory.nyx_url')
    }
    await sleep(80) // timing-ok: a negative window, nothing must reach the Mac in it
    expect(bridge.rec.of('config.patch', 'in')).toHaveLength(0)
  })

  it('the address comes back to the app in config.sync (the app shows it; only the bug webhook is hidden)', async () => {
    const { app, bridge } = await rig()
    const cfg = { ...(app.rec.of('ready', 'in')[0]?.agent_config as object) } as Record<string, unknown>
    bridge.send({
      type: 'config.sync',
      config: { ...cfg, rev: 2, memory: { nyx_url: 'https://nyx.example.com/' } },
      rev: 2,
    })
    const sync = await app.expectFrame('config.sync', (x) => x.rev === 2)
    expect(sync.config.memory?.nyx_url).toBe('https://nyx.example.com/')
  })
})
