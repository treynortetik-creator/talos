import { existsSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { createFakeServices } from './helpers/fake-services.ts'

describe('fake services (shared test infrastructure)', () => {
  it('boots with migrations applied and a usable env', () => {
    const f = createFakeServices()
    expect(f.services.env.NODE_ENV).toBe('test')
    // every migration file on disk was applied, none other
    const files = ['core', 'auth', 'hooks', 'voice'].flatMap((m) => {
      const dir = fileURLToPath(new URL(`../migrations/${m}`, import.meta.url))
      return existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith('.sql')) : []
    })
    expect(f.db.prepare('select count(*) as n from _migrations').get()).toEqual({ n: files.length })
    expect(f.services.agentConfig()?.threads.map((t) => t.id)).toEqual(['general', 'inbox'])
  })

  it('the recording bus runs handlers modules registered and records what they send', async () => {
    const f = createFakeServices()
    f.services.bus.onAppFrame('visibility', async (frame, ctx) => {
      await f.services.bus.toApps({ type: 'presence', seen: frame.state })
      ctx.reply({ type: 'pong', nonce: 'x' })
    })
    const replies = await f.bus.injectAppFrame({
      v: 1,
      type: 'visibility',
      id: '01JBF3V7Q8K2M4N6P8R0S2T4V6',
      ts: '2026-10-28T15:00:00.000Z',
      state: 'hidden',
    })
    expect(replies).toEqual([{ type: 'pong', nonce: 'x' }])
    expect(f.bus.toAppsLog[0]?.frame).toMatchObject({ seen: 'hidden' })
  })

  it('injecting an invalid frame throws instead of reaching a handler', async () => {
    const f = createFakeServices()
    await expect(f.bus.injectAppFrame({ v: 1, type: 'nope' })).rejects.toThrow(/injectAppFrame/)
  })

  it('toBridge reports queued while the bridge is offline', async () => {
    const f = createFakeServices()
    expect((await f.services.bus.toBridge({ type: 'hook.event' }, { durable: true })).queued).toBe(true)
    f.bus.setBridgeOnline(true)
    expect((await f.services.bus.toBridge({ type: 'hook.event' }, { durable: true })).queued).toBe(false)
    expect(f.services.bus.bridgeOnline()).toBe(true)
  })

  it('the fake services carry the production crypto: round trip, AAD binding, and a short blob is refused', () => {
    const { services } = createFakeServices()
    const blob = services.crypto.encrypt(new TextEncoder().encode('secret'), 'core_messages:1')
    expect(new TextDecoder().decode(services.crypto.decrypt(blob, 'core_messages:1'))).toBe('secret')
    expect(() => services.crypto.decrypt(blob, 'core_messages:2')).toThrow()
    // Only src/core/crypto.ts throws this message; a private copy of the cipher in the helper would not.
    expect(() => services.crypto.decrypt(new Uint8Array(10), 'core_messages:1')).toThrow('ciphertext too short')
  })

  it('media and push sinks record, the clock is fake', async () => {
    const f = createFakeServices()
    const ref = await f.services.media.put({ bytes: new Uint8Array([1, 2, 3]), mime: 'image/png', name: 'a.png' })
    expect(ref.sha256).toMatch(/^[0-9a-f]{64}$/)
    expect((await f.services.media.get(ref.media_id))?.bytes).toEqual(new Uint8Array([1, 2, 3]))
    await f.services.push.notify({ template: 'session_stopped' })
    expect(f.push.intents).toEqual([{ template: 'session_stopped' }])
    const t0 = f.services.clock.now()
    f.clock.advance(1000)
    expect(f.services.clock.now()).toBe(t0 + 1000)
  })
})
