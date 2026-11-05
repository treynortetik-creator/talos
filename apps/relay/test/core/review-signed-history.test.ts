// Adversarial review of PR #54, relay part: the REAL relay hub (FakeApp in front, FakeBridge behind). "HOLDS" = the PR
// passes the probe; "FINDING" = fails on the PR head; "BY DESIGN" documents what the relay can still read or serve.
import { newUlid } from '@talos-app/protocol'
import { type FakeApp, type FakeBridge, fakeClock, mkFrame, sleep } from '@talos-app/testkit'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { startTestRelay, type TestRelay } from './harness.ts'
import { advance, kit } from './helpers.ts'

vi.setConfig({ testTimeout: 20_000 })

let relay: TestRelay | null = null
afterEach(async () => {
  await relay?.stop()
  relay = null
})

const inFrames = (a: FakeApp) => a.rec.frames.filter((r) => r.direction === 'in').map((r) => r.raw)
const bridgeIn = (b: FakeBridge) => b.rec.frames.filter((r) => r.direction === 'in').map((r) => r.raw)

async function world(opts: { clock?: ReturnType<typeof fakeClock> } = {}) {
  relay = await startTestRelay(opts.clock ? { clock: opts.clock } : {})
  const k = kit(relay)
  const app = await k.connectedApp()
  const other = await k.connectedApp()
  const bridge = await k
    .bridge({ pinnedDevices: { [app.device.deviceId]: app.device.publicJwk }, autoReply: false })
    .connect()
  return { relay, k, app, other, bridge }
}

describe('PR #54 review: relay hub', () => {
  // forwardError only routes a history error to the asker while the historyReqs entry is alive (HISTORY_REQ_TTL_MS = 2
  // min, pruned lazily). A slow Mac (read queue behind a long search, a laptop waking) answers after that: the error falls
  // through to the old path and is stored in the thread as "An action was rejected (sig_invalid): ..." for every device.
  // The PR's own claim is "never stored as a system message".
  it('FINDING: a Mac error for a history request that lands after the 2-minute TTL is stored as a thread message', async () => {
    const clock = fakeClock()
    const { app, bridge } = await world({ clock })
    const req = await app.sign({
      ...mkFrame('history.request', {}, clock.iso()),
      request_id: newUlid(),
      thread_id: 'general',
      around_id: `m_${newUlid()}`,
      limit: 50,
    })
    app.send(req)
    await bridge.expectFrame('history.request', (x) => x.request_id === req.request_id, { direction: 'in' })
    await advance(clock, 3 * 60_000)
    // any later history request prunes the expired entry
    const later = await app.sign({
      ...mkFrame('history.request', {}, clock.iso()),
      request_id: newUlid(),
      thread_id: 'general',
      around_id: `m_${newUlid()}`,
      limit: 50,
    })
    app.send(later)
    await bridge.expectFrame('history.request', (x) => x.request_id === later.request_id, { direction: 'in' })
    bridge.send(
      mkFrame('error', { ref: req.id, code: 'sig_invalid', message: 'That request was already used.' }) as never,
    )
    await sleep(300)
    const stored = inFrames(app).filter((f) => f.type === 'message.stored')
    expect(stored.map((f) => JSON.stringify(f))).toEqual([]) // on the PR head: "An action was rejected (sig_invalid): ..."
  })

  it('HOLDS: the page for a signed request reaches only the asking socket, never a second socket of the same owner', async () => {
    const { app, other, bridge } = await world()
    const req = await app.sign({
      ...mkFrame('history.request'),
      request_id: newUlid(),
      thread_id: 'general',
      around_id: `m_${newUlid()}`,
      limit: 50,
    })
    app.send(req)
    await bridge.expectFrame('history.request', (x) => x.request_id === req.request_id, { direction: 'in' })
    bridge.send({
      type: 'history.page',
      request_id: req.request_id,
      thread_id: 'general',
      messages: [],
      has_more: false,
    } as never)
    await app.expectFrame('history.page', (x) => x.request_id === req.request_id, { direction: 'in' })
    await sleep(150)
    expect(inFrames(other).some((f) => f.type === 'history.page')).toBe(false)
  })

  // What the relay can still read without any signature, by design (docs/SECURITY.md "Short memory on the relay"): its
  // own buffer. On a relay that has never pruned (floor() === null) that is the whole buffered history.
  it('BY DESIGN: an unsigned request is answered from the relay buffer without ever asking the Mac', async () => {
    const { app, other, bridge } = await world()
    await app.sendMessage('general', 'buffered-on-relay')
    await sleep(150)
    other.send({ type: 'history.request', request_id: 'old-app', thread_id: 'general', limit: 20 })
    const page = await other.expectFrame('history.page', (x) => x.request_id === 'old-app', { direction: 'in' })
    expect(JSON.stringify(page)).toContain('buffered-on-relay')
    expect(bridgeIn(bridge).some((x) => x.type === 'history.request')).toBe(false)
  })
})
