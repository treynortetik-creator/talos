// Review of PR #100 (v6 follow-ups), relay hub: the REAL hub with FakeApp in front and FakeBridge behind.
import { bindingFrom, newId, newUlid, payloadHash } from '@talos-app/protocol'
import { type FakeApp, type FakeBridge, fakeClock, mkFrame, sleep } from '@talos-app/testkit'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { startTestRelay, type TestRelay } from './harness.ts'
import { advance, kit } from './helpers.ts'

vi.setConfig({ testTimeout: 30_000 })

let relay: TestRelay | null = null
afterEach(async () => {
  await relay?.stop()
  relay = null
})

const inFrames = (a: FakeApp) => a.rec.frames.filter((r) => r.direction === 'in').map((r) => r.raw)
const bridgeIn = (b: FakeBridge) => b.rec.frames.filter((r) => r.direction === 'in').map((r) => r.raw)

async function world() {
  const clock = fakeClock()
  relay = await startTestRelay({ clock })
  const k = kit(relay)
  const app = await k.connectedApp()
  const other = await k.connectedApp()
  const bridge = await k
    .bridge({ pinnedDevices: { [app.device.deviceId]: app.device.publicJwk }, autoReply: false })
    .connect()
  return { clock, app, other, bridge }
}

describe('history.request has a per-socket budget (finding 3)', () => {
  it('100 signed requests inside one minute: the first 60 reach the Mac, the rest are told rate_limited', async () => {
    const { clock, app, bridge } = await world()
    const ids: string[] = []
    for (let batch = 0; batch < 4; batch++) {
      for (let i = 0; i < 25; i++) {
        const req = await app.sign({
          ...mkFrame('history.request', {}, clock.iso()),
          request_id: newUlid(),
          thread_id: 'general',
          before_id: newId('m'),
          limit: 5,
        })
        ids.push(req.id)
        app.send(req)
      }
      await sleep(150)
      await advance(clock, 2_000) // the 30 frames/s budget refills; the history bucket (60/min) does not
    }
    await sleep(300)
    const forwarded = bridgeIn(bridge).filter((f) => f.type === 'history.request')
    const limited = inFrames(app).filter((f) => f.type === 'error' && f.code === 'rate_limited')
    // 60 from the full bucket plus the one per second that refilled during the 6 s of fake time
    expect(forwarded.length).toBeGreaterThanOrEqual(60)
    expect(forwarded.length).toBeLessThanOrEqual(66)
    expect(limited.length).toBe(100 - forwarded.length)
  })
})

describe('media.fetch at the relay (finding 1)', () => {
  it('forwards a signed fetch and an unsigned one (an old app gets the Mac "update the app" answer)', async () => {
    const { clock, app, bridge } = await world()
    const signed = await app.sign({ ...mkFrame('media.fetch', {}, clock.iso()), media_id: newId('md') })
    app.send(signed)
    await bridge.expectFrame('media.fetch', (f) => f.id === signed.id, { direction: 'in' })
    const old = { ...mkFrame('media.fetch', {}, clock.iso()), media_id: newId('md') }
    app.send(old)
    await bridge.expectFrame('media.fetch', (f) => f.id === old.id, { direction: 'in' })
  })

  it("sends the Mac's refusal back to the asking socket, never into a thread or to another socket", async () => {
    const { clock, app, other, bridge } = await world()
    const req = await app.sign({ ...mkFrame('media.fetch', {}, clock.iso()), media_id: newId('md') })
    app.send(req)
    await bridge.expectFrame('media.fetch', (f) => f.id === req.id, { direction: 'in' })
    bridge.send(
      mkFrame('error', {
        ref: req.id,
        code: 'bad_frame',
        message: 'Update the Talos app to load older files.',
      }) as never,
    )
    await app.expectFrame('error', (f) => f.ref === req.id, { direction: 'in' })
    await sleep(200)
    expect(inFrames(app).filter((f) => f.type === 'message.stored')).toEqual([])
    expect(inFrames(other).filter((f) => f.type === 'message.stored')).toEqual([])
    expect(inFrames(other).some((f) => f.type === 'error' && f.ref === req.id)).toBe(false)
  })

  it('has its own budget: 120 a minute per socket, then rate_limited and nothing reaches the Mac', async () => {
    const { clock, app, bridge } = await world()
    for (let batch = 0; batch < 6; batch++) {
      for (let i = 0; i < 25; i++)
        app.send(await app.sign({ ...mkFrame('media.fetch', {}, clock.iso()), media_id: newId('md') }))
      await sleep(150)
      await advance(clock, 2_000)
    }
    await sleep(300)
    const forwarded = bridgeIn(bridge).filter((f) => f.type === 'media.fetch').length
    expect(forwarded).toBeGreaterThanOrEqual(120)
    expect(forwarded).toBeLessThan(150)
    expect(inFrames(app).filter((f) => f.type === 'error' && f.code === 'rate_limited').length).toBe(150 - forwarded)
  })
})

describe('media.fetch cannot reach a stored frame (re-review)', () => {
  it("a fetch that reuses a card.resolve frame id, and the Mac's refusal of it, leave a resolved card resolved", async () => {
    const { clock, app, bridge } = await world()
    const card = bridge.createCard({ thread_id: 'general', title: 'Already acting' })
    await app.expectFrame('card.create', (f) => f.card.id === card.id)
    const resolve = await app.resolveCard(card, 'primary', payloadHash(bindingFrom(card)))
    await bridge.expectFrame('card.resolve', (f) => f.id === resolve.id, { direction: 'in' })
    // A stolen session sends an unsigned media.fetch that names the resolve frame's id. The Mac refuses an unsigned fetch.
    app.send({ ...mkFrame('media.fetch', {}, clock.iso()), id: resolve.id, media_id: newId('md') })
    await sleep(200)
    bridge.send(
      mkFrame('error', {
        ref: resolve.id,
        code: 'bad_frame',
        message: 'Update the Talos app to load older files.',
      }) as never,
    )
    await sleep(300)
    expect(
      inFrames(app).filter((f) => f.type === 'card.update' && f.card_id === card.id && f.state === 'pending'),
    ).toEqual([])
    expect(bridgeIn(bridge).filter((f) => f.type === 'media.fetch')).toEqual([])
  })
})
