// Main's state (the supervisor's run/main-state, reduced to one word by the bridge) reaches the app through presence: the
// beat that carries it is kept, a change goes out to the apps at once, a beat without it clears it, and it is shown only
// while the bridge is online. The real relay (real auth, real hub, real sockets).
import { type HealthBeatT, Presence } from '@talos-app/protocol'
import { waitFor } from '@talos-app/testkit'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { type RealRelay, startRealRelay } from '../review/real-relay.ts'

vi.setConfig({ testTimeout: 20_000 })

let r: RealRelay | null = null
afterEach(async () => {
  await r?.stop()
  r = null
})

const beat = (main?: string): HealthBeatT =>
  ({
    bridge: { version: 'test', started_at: new Date().toISOString() },
    ...(main ? { main } : {}),
    mod: { state: 'absent', last_seen: null, expected: false },
    tts: false,
    stt: false,
    sqlite: { fts5: true },
  }) as HealthBeatT

describe('presence.main', () => {
  it('signin goes out at once, a change goes out, a beat without it clears it, and an offline bridge shows none', async () => {
    r = await startRealRelay()
    const app = r.app(await r.owner())
    await app.connect()
    const b = await r.bridge().connect()
    // each step waits for a presence frame sent after it, and checks what the hub says now
    const step = async (main: string | undefined, pred: (f: { main?: string; bridge_online: boolean }) => boolean) => {
      const since = app.rec.frames.length
      b.send({ type: 'health.beat', beat: beat(main) })
      await app.expectFrame('presence', pred, { since })
      expect(r?.runtime.hub.presence().main).toBe(main)
    }
    await step('signin', (f) => f.main === 'signin')
    await step('running', (f) => f.main === 'running')
    await step(undefined, (f) => f.bridge_online === true && f.main === undefined)
    await step('signin', (f) => f.main === 'signin')
    // an unchanged beat sends no presence
    const before = app.rec.of('presence').length
    b.send({ type: 'health.beat', beat: { ...beat('signin'), tts: true } })
    await waitFor(
      () => r?.runtime.store.getState('health_beat')?.includes('"tts":true') === true,
      3000,
      'the beat stored',
    )
    await new Promise((res) => setTimeout(res, 200))
    expect(app.rec.of('presence').length).toBe(before)
    const since = app.rec.frames.length
    await b.close()
    await app.expectFrame('presence', (f) => f.bridge_online === false && f.main === undefined, { since })
    await app.close()
  })

  it("a bridge that comes back starts with no state: the last bridge's signin never shows before the new one beats", async () => {
    r = await startRealRelay()
    const first = await r.bridge().connect()
    first.send({ type: 'health.beat', beat: beat('signin') })
    await waitFor(() => r?.runtime.hub.presence().main === 'signin', 3000, 'signin')
    await first.close()
    await waitFor(() => r?.runtime.hub.presence().bridge_online === false, 3000, 'offline')
    const app = r.app(await r.owner())
    await app.connect()
    const since = app.rec.frames.length
    await r.bridge().connect() // signed in meanwhile; it has not beaten yet
    await app.expectFrame('presence', (f) => f.bridge_online === true && f.main === undefined, { since })
    expect(r.runtime.hub.presence()).toMatchObject({ bridge_online: true })
    expect(r.runtime.hub.presence().main).toBeUndefined()
    await app.close()
  })

  it('a word this build does not know is dropped, in the beat and in presence, and breaks neither', () => {
    expect(
      Presence.parse({ bridge_online: true, last_seen: null, queue_depth: 0, main: 'dreaming' }).main,
    ).toBeUndefined()
    expect(Presence.parse({ bridge_online: true, last_seen: null, queue_depth: 0, main: 'signin' }).main).toBe('signin')
  })
})
