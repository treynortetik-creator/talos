// Review fix #8: the relay acks a voice.ask it accepted. Without the ack the web client keeps the frame in its persisted
// outbox and resends every old ask on every reconnect.
import { newUlid } from '@talos-app/protocol'
import { loadExampleConfig, mkFrame } from '@talos-app/testkit'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { FakeVoiceProvider } from '../../src/voice/fake-provider.ts'
import { setVoiceProvider } from '../../src/voice/index.ts'
import { setVoicePorts } from '../../src/voice/ports.ts'
import { type RealRelay, startRealRelay } from './real-relay.ts'

vi.setConfig({ testTimeout: 20_000 })

let r: RealRelay | null = null
afterEach(async () => {
  await r?.stop()
  r = null
  setVoiceProvider(null)
})

describe('voice.ask', () => {
  it('a good ask is acked', async () => {
    const provider = new FakeVoiceProvider()
    setVoiceProvider(provider)
    setVoicePorts({ sink: { append: async () => {} } })
    r = await startRealRelay()
    const owner = await r.owner()
    const app = r.app(owner)
    await app.connect()
    const bridge = await r.bridge().connect()
    bridge.send({ type: 'config.sync', rev: 1, config: loadExampleConfig('default') })
    await app.expectFrame('config.sync', undefined, { direction: 'in' })
    const res = await r.post('/api/voice/session', { thread_id: 'general', sdp: 'v=0\r\no=- offer\r\n' }, owner)
    expect(res.status).toBe(200)
    const { voice_session_id } = (await res.json()) as { voice_session_id: string }
    provider.last.emit({
      type: 'session.delegation.created',
      event_id: 'e1',
      offset_ms: 1,
      delegation: { id: 'dlg_1', target: 'client', type: 'delegation' },
    })
    const ask = await app.sign({
      ...mkFrame('voice.ask'),
      voice_session_id,
      delegation_id: 'dlg_1',
      thread_id: 'general',
      question: 'what is on my calendar',
      transcript_tail: [],
    })
    app.send(ask)
    const ack = await app.expectFrame('ack', (f) => f.ref === ask.id)
    expect(ack.ref).toBe(ask.id)
    await app.rec.expectNoFrame('error', (f) => f.ref === ask.id)
  })

  it('a refused ask still gets an error, not an ack', async () => {
    const provider = new FakeVoiceProvider()
    setVoiceProvider(provider)
    setVoicePorts({ sink: { append: async () => {} } })
    r = await startRealRelay()
    const owner = await r.owner()
    const app = r.app(owner)
    await app.connect()
    const ask = await app.sign({
      ...mkFrame('voice.ask'),
      voice_session_id: 'v_nope',
      delegation_id: newUlid(),
      thread_id: 'general',
      question: 'hello?',
      transcript_tail: [],
    })
    app.send(ask)
    await app.expectFrame('error', (f) => f.ref === ask.id)
    await app.rec.expectNoFrame('ack', (f) => f.ref === ask.id)
  })
})
