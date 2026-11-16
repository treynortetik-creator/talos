// Where bug reports are sent (`bug_webhook_url`) is the owner's setting in the app's Settings: a signed tap (no passkey since
// 2026-11-14); an address the webhook would never call is refused before it reaches the Mac; and the address never comes back
// to a device, which sees only its host. Real relay, real signed owner frames.
import { BUG_WEBHOOK_URL_RULE } from '@talos-app/protocol'
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
  const app = r.app(o)
  await app.connect()
  const bridge = await new FakeBridge({
    relayWs: r.wsBase,
    key: r.bridgeKey,
    verifyOwner: false,
    consume: 'manual',
  }).connect()
  const cfg = { ...(app.rec.of('ready', 'in')[0]?.agent_config as object) } as Record<string, unknown>
  return { rel: r, o, app, bridge, cfg }
}
const URL_OK = 'https://hooks.example.com/services/T000/B000/secret-token-part'

describe('config.patch of bug_webhook_url', () => {
  it('needs no passkey step (2026-11-14): a signed patch reaches the Mac, with or without trust mode', async () => {
    const { app, bridge } = await rig()
    const f = await app.sendConfigPatch(0, { bug_webhook_url: URL_OK })
    await bridge.expectFrame('config.patch', (x) => x.id === f.id, { direction: 'in' })
  })

  it('an address the webhook would not call is refused in the same words, before the Mac', async () => {
    const { app, bridge } = await rig()
    for (const bad of ['ftp://hooks.example.com/x', 'not an address']) {
      const f = await app.sendConfigPatch(0, { bug_webhook_url: bad })
      const err = await app.expectFrame('error', (e) => e.ref === f.id)
      expect(err.code).toBe('config_field_forbidden')
      expect(err.message).toBe(BUG_WEBHOOK_URL_RULE)
    }
    // not a string at all: refused by the patch check
    const n = await app.sendConfigPatch(0, { bug_webhook_url: 7 })
    expect((await app.expectFrame('error', (e) => e.ref === n.id)).code).toBe('config_field_forbidden')
    await sleep(80)
    expect(bridge.rec.of('config.patch', 'in')).toHaveLength(0)
  })

  it('a good address goes to the Mac; the address never comes back to a device, only its host', async () => {
    const { rel, o, app, bridge, cfg } = await rig()
    const f = await app.sendConfigPatch(0, { bug_webhook_url: URL_OK })
    await bridge.expectFrame('config.patch', (x) => x.id === f.id, { direction: 'in' })
    // the Mac saves it and syncs back: the app gets the host, never the address (whose path is the token)
    bridge.send({ type: 'config.sync', config: { ...cfg, rev: 2, bug_webhook_url: URL_OK }, rev: 2 })
    const sync = await app.expectFrame('config.sync', (x) => x.rev === 2)
    expect(sync.config.bug_webhook_host).toBe('hooks.example.com')
    // (the app's own outgoing patch has it, of course: only what comes IN is the question)
    expect(JSON.stringify(app.rec.frames.filter((x) => x.direction === 'in').map((x) => x.raw))).not.toContain(
      'secret-token-part',
    )
    // catch-up never replays the patch that carried it, to this device or another (the review of 2026-11-11 found it did)
    const other = rel.app(await rel.owner())
    await other.connect()
    for (const dev of [app, other]) {
      dev.send({ type: 'catchup.request', since_seq: 0 })
      const batch = await dev.expectFrame('catchup.batch', undefined, { direction: 'in', since: dev.rec.length - 1 })
      expect(JSON.stringify(batch)).not.toContain('secret-token-part')
    }
    // and a reconnecting device's `ready` says the same
    const again = rel.app(o)
    await again.connect()
    const ready = again.rec.of('ready', 'in')[0]
    expect(ready?.agent_config?.bug_webhook_host).toBe('hooks.example.com')
    expect(JSON.stringify(ready)).not.toContain('secret-token-part')
  })
})
