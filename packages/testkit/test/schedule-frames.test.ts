// The schedule-frames contract run end to end through the fakes: FakeApp -> FakeRelay -> FakeBridge (FakeScheduler).
// WP-S1 runs the same contract against the real bridge, WP-S2 against the real relay with FakeBridge.
import { describe, expect, it } from 'vitest'
import { defineScheduleFramesContract } from '../src/contract/schedule-frames.ts'
import { FakeApp } from '../src/fake-app.ts'
import { FakeBridge } from '../src/fake-bridge.ts'
import { FakeRelay } from '../src/fake-relay.ts'
import { FakeScheduler } from '../src/fake-scheduler.ts'
import { mkFrame, waitFor } from '../src/frame-utils.ts'

async function startAll(opts: { bridge?: boolean } = {}) {
  const relay = await new FakeRelay().start()
  const scheduler = new FakeScheduler({ tz: 'UTC', now: new Date().toISOString() })
  await scheduler.seed({
    id: 'daily-digest',
    name: 'Daily Digest',
    description: 'Example job',
    when: { type: 'daily', time: '07:30' },
    catchup_min: 180,
    enabled: true,
    runner: 'session',
    permissions: 'full',
    allowed_tools: [],
    model: null,
    notify: 'failure',
    prompt: 'Summarise yesterday and post it.\n',
  })
  const app = new FakeApp({ relayWs: relay.wsBase })
  await app.connect()
  let bridge: FakeBridge | null = null
  if (opts.bridge !== false) {
    bridge = new FakeBridge({
      relayWs: relay.wsBase,
      key: relay.bridgeKey,
      pinnedDevices: { [app.device.deviceId]: app.device.publicJwk },
      scheduler,
    })
    await bridge.connect()
  }
  return { relay, app, bridge, scheduler }
}

defineScheduleFramesContract('FakeBridge + FakeScheduler via FakeRelay', {
  async start() {
    const { relay, app, bridge } = await startAll()
    return {
      knownScheduleId: 'daily-digest',
      knownScheduleName: 'Daily Digest',
      knownPrompt: 'Summarise yesterday and post it.',
      threadId: 'general',
      sendOwner: async (frame) => {
        const signed = await app.sign({ ...mkFrame(String(frame.type)), ...frame })
        app.send(signed)
        return signed
      },
      sendUnsigned: async (frame) => {
        const f = { ...mkFrame(String(frame.type)), ...frame, device_id: app.device.deviceId, osig: 'A'.repeat(86) }
        app.send(f)
        return f
      },
      expect: (type, pred, timeoutMs) =>
        app.expectFrame(type as never, pred as never, { direction: 'in', timeoutMs }) as never,
      received: () => app.rec.frames.filter((r) => r.direction === 'in').map((r) => r.raw),
      stop: async () => {
        await app.close()
        await bridge?.close()
        await relay.stop()
      },
    }
  },
})

describe('FakeRelay schedule routing', () => {
  it('answers mac_offline at once when no bridge is connected, and stores nothing', async () => {
    const { relay, app } = await startAll({ bridge: false })
    try {
      const f = await app.sign({ ...mkFrame('schedules.list'), request_id: mkFrame('x').id })
      app.send(f)
      const err = await app.expectFrame('error', (e) => e.ref === f.id, { direction: 'in', timeoutMs: 2000 })
      expect(err.code).toBe('mac_offline')
      expect(relay.stored.some((s) => String(s.type).startsWith('schedule'))).toBe(false)
    } finally {
      await app.close()
      await relay.stop()
    }
  })

  it('routes a snapshot only to the socket that asked', async () => {
    const { relay, app, bridge } = await startAll()
    const other = new FakeApp({ relayWs: relay.wsBase })
    await other.connect()
    try {
      const f = await app.sign({ ...mkFrame('schedules.list'), request_id: mkFrame('x').id })
      app.send(f)
      await app.expectFrame('schedules.snapshot', (s) => s.request_id === f.request_id, { direction: 'in' })
      await new Promise((r) => setTimeout(r, 100))
      expect(other.rec.frames.some((r) => r.direction === 'in' && r.raw.type === 'schedules.snapshot')).toBe(false)
      expect(relay.stored.some((s) => String(s.type).startsWith('schedule'))).toBe(false)
    } finally {
      await other.close()
      await app.close()
      await bridge?.close()
      await relay.stop()
    }
  })

  it('acks a duplicate frame id with no seq and does not forward it twice', async () => {
    const { relay, app, bridge } = await startAll()
    try {
      const f = await app.sign({ ...mkFrame('schedules.list'), request_id: mkFrame('x').id })
      app.send(f)
      await app.expectFrame('schedules.snapshot', (s) => s.request_id === f.request_id, { direction: 'in' })
      app.send(f)
      const acks = () =>
        app.rec.frames.filter((r) => r.direction === 'in' && r.raw.type === 'ack' && r.raw.ref === f.id)
      await waitFor(() => acks().length >= 2, 4000, 'the second ack')
      expect(acks().length).toBe(2)
      for (const a of acks()) expect(a.raw.seq).toBeUndefined()
      expect(relay.rec.frames.filter((r) => r.direction === 'to_bridge' && r.raw.id === f.id).length).toBe(1)
    } finally {
      await app.close()
      await bridge?.close()
      await relay.stop()
    }
  })

  it('echoes the bridge features in presence', async () => {
    const { relay, app, bridge } = await startAll()
    try {
      await app.expectFrame('presence', (p) => (p.features ?? []).includes('schedules/1'), { direction: 'in' })
    } finally {
      await app.close()
      await bridge?.close()
      await relay.stop()
    }
  })
})
