// Remaining WP1 behaviour: catch-up summary, owner-frame forwarding, fan-out of bridge frames, keep-alive, logs.
import { newId } from '@talos-app/protocol'
import { fakeClock, sleep, waitFor } from '@talos-app/testkit'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Logger } from '../../src/services.ts'
import { startTestRelay, type TestRelay } from './harness.ts'
import { advance, kit } from './helpers.ts'

vi.setConfig({ testTimeout: 30_000 })

let relay: TestRelay | null = null
afterEach(async () => {
  await relay?.stop()
  relay = null
})

describe('catch-up summary', () => {
  it('a long gap gets a per-thread summary before the first batch', async () => {
    relay = await startTestRelay()
    const k = kit(relay)
    const bridge = await k.bridge().connect()
    for (let i = 0; i < 210; i++) bridge.reply('general', `r${i}`)
    await bridge.expectFrame('ack', (f) => f.seq === 210, { direction: 'in', timeoutMs: 10_000 })
    bridge.createCard({ thread_id: 'general', title: 'Waiting' })
    await bridge.expectFrame('ack', (f) => f.seq === 211, { direction: 'in' })
    const app = k.app({ lastSeq: 1 })
    await app.connect()
    const summary = await app.expectFrame('catchup.summary')
    expect(summary.since_seq).toBe(1)
    const general = summary.threads.find((t) => t.thread_id === 'general')
    expect(general).toMatchObject({ unread: 210, needs_you: true })
    expect(summary.open_cards).toBe(1)
    const batch = await app.expectFrame('catchup.batch')
    expect(batch.more).toBe(true)
    expect(app.rec.frames.findIndex((r) => r.frame.type === 'catchup.summary')).toBeLessThan(
      app.rec.frames.findIndex((r) => r.frame.type === 'catchup.batch'),
    )
  })

  it('no summary for a short gap: the missed messages arrive as a plain batch', async () => {
    relay = await startTestRelay()
    const k = kit(relay)
    const bridge = await k.bridge().connect()
    for (let i = 0; i < 3; i++) bridge.reply('general', `short${i}`)
    await bridge.expectFrame('ack', (f) => f.seq === 3, { direction: 'in' })
    const app = k.app({ lastSeq: 1 })
    await app.connect()
    // The summary, when sent, comes before the first batch; so once the batch is here its absence is settled.
    const batch = await app.expectFrame('catchup.batch')
    expect(batch.more).toBe(false)
    expect(batch.frames.length).toBeGreaterThan(0)
    expect(app.rec.of('catchup.summary', 'in')).toHaveLength(0)
  })
})

describe('owner frames', () => {
  it('forwards config.patch to the bridge with the signature fields intact and the relay meta added', async () => {
    relay = await startTestRelay()
    const k = kit(relay)
    const app = await k.connectedApp()
    const bridge = await k
      .bridge({ pinnedDevices: { [app.device.deviceId]: app.device.publicJwk }, consume: 'manual' })
      .connect()
    const patch = await app.sendConfigPatch(0, { quiet_window: null })
    await bridge.expectFrame('config.patch', (f) => f.id === patch.id, { direction: 'in' })
    const got = bridge.rec.frames.find((r) => r.frame.id === patch.id && r.direction === 'in')?.raw as Record<
      string,
      unknown
    >
    expect(got.osig).toBe(patch.osig)
    expect(got.device_id).toBe(patch.device_id)
    expect(got.relay).toMatchObject({ seq: expect.any(Number) })
  })

  it('never forwards a voice.ask from an app: only the voice module may emit one (FOLLOWUPS PR3)', async () => {
    relay = await startTestRelay()
    const k = kit(relay)
    const app = await k.connectedApp()
    const bridge = await k
      .bridge({ pinnedDevices: { [app.device.deviceId]: app.device.publicJwk }, consume: 'manual' })
      .connect()
    const ask = await app.sendVoiceAsk('general', 'what is on my plate?')
    expect((await app.expectFrame('error', (f) => f.ref === ask.id)).code).toBe('bad_frame')
    await sleep(120)
    expect(bridge.rec.of('voice.ask', 'in')).toHaveLength(0)
  })

  it('refuses a config.patch outside the allowlist with config_field_forbidden, before the bridge sees it', async () => {
    relay = await startTestRelay()
    const k = kit(relay)
    const app = await k.connectedApp()
    const bridge = await k.bridge({ verifyOwner: false, consume: 'manual' }).connect()
    const bad = await app.sendConfigPatch(0, { trust_mode: true })
    expect((await app.expectFrame('error', (f) => f.ref === bad.id)).code).toBe('config_field_forbidden')
    await sleep(80)
    expect(bridge.rec.of('config.patch', 'in')).toHaveLength(0)
  })

  it('a voice note is stored and forwarded like a message', async () => {
    relay = await startTestRelay()
    const k = kit(relay)
    const app = await k.connectedApp()
    const bridge = await k.bridge({ verifyOwner: false, autoReply: false }).connect()
    const sent = await app.sendVoiceNote('general', {
      media_id: newId('md'),
      kind: 'voice_note',
      role: 'attachment',
      mime: 'audio/webm',
      name: 'note.webm',
      size: 1200,
      sha256: 'a'.repeat(64),
      duration_ms: 3000,
    })
    const stored = await app.expectFrame('message.stored', (f) => f.client_msg_id === sent.client_msg_id)
    expect(stored.message.kind).toBe('voice_note')
    await bridge.expectFrame('voice_note', (f) => f.id === sent.id, { direction: 'in' })
  })
})

describe('bridge frames reach the apps', () => {
  it('transcript, receipt, status, inbox.update, thread.archive and device.pinned are fanned out; receipts and transcripts stick to history', async () => {
    relay = await startTestRelay()
    const k = kit(relay)
    const app = await k.connectedApp()
    const bridge = await k.bridge({ verifyOwner: false, autoReply: false }).connect()
    const sent = await app.sendMessage('general', 'hello')
    await bridge.expectFrame('message', (f) => f.id === sent.id, { direction: 'in' })
    bridge.send({ type: 'receipt', message_id: sent.client_msg_id, state: 'delivered' })
    await app.expectFrame('receipt', (f) => f.state === 'delivered')
    bridge.send({ type: 'transcript', message_id: sent.client_msg_id, text: 'hello', engine: 'test', status: 'done' })
    await app.expectFrame('transcript', (f) => f.text === 'hello')
    bridge.send({ type: 'status', thread_id: 'general', state: 'working', since: new Date().toISOString() })
    await app.expectFrame('status', (f) => f.state === 'working')
    bridge.send({ type: 'inbox.update', event_id: newId('e'), state: 'done' })
    await app.expectFrame('inbox.update')
    bridge.send({ type: 'thread.archive', thread_id: 'general' })
    await app.expectFrame('thread.archive')
    bridge.send({ type: 'device.pinned', device_id: app.device.deviceId, ok: true })
    await app.expectFrame('device.pinned', (f) => f.ok)
    app.send({ type: 'history.request', request_id: 'h', thread_id: 'general', limit: 10 })
    const page = await app.expectFrame('history.page')
    const mine = page.messages.find((m) => m.id === sent.client_msg_id)
    expect(mine?.receipt).toBe('delivered')
    expect(mine?.transcript?.text).toBe('hello')
  })

  it('device.pinned ok raises a "New device pinned" push when nobody is looking', async () => {
    relay = await startTestRelay()
    relay.runtime.store.putSub({
      endpoint: 'https://push.example.com/send/ENDPOINTMARK',
      keys: { p256dh: 'P256MARK', auth: 'AUTHMARK' },
    })
    const k = kit(relay)
    const bridge = await k.bridge().connect()
    bridge.send({ type: 'device.pinned', device_id: 'd_aaaaaaaaaaaaaaaaaaaa', ok: true })
    await waitFor(() => (relay?.transport.sent.length ?? 0) === 1, 3000, 'push')
    expect(relay.transport.sent[0]?.payload.notification.body).toBe('New device pinned')
  })
})

describe('keep-alive', () => {
  it('pings both sockets every 25 s and drops one that stays silent for over 75 s', async () => {
    const c = fakeClock(new Date().toISOString())
    relay = await startTestRelay({ clock: c })
    const k = kit(relay)
    const app = await k.connectedApp()
    const bridge = await k.bridge().connect()
    await advance(c, 26_000, 5_000)
    await app.expectFrame('ping')
    await bridge.expectFrame('ping', undefined, { direction: 'in' })
    // the fakes answer pings, so both stay up across several minutes
    await advance(c, 5 * 60_000, 10_000)
    expect(app.connected).toBe(true)
    expect(bridge.connected).toBe(true)
    // a socket that stops answering is terminated
    const dead = await k.connectedApp()
    dead.ws?.removeAllListeners('message')
    await advance(c, 120_000, 25_000)
    await waitFor(() => !dead.connected, 3000, 'dead socket dropped')
  })
})

describe('logs', () => {
  it('never contain message text, card text, push subscription secrets, bridge key ids or signatures', async () => {
    const lines: string[] = []
    const rec = (level: string) => (obj: object | string, msg?: string) =>
      void lines.push(`${level} ${JSON.stringify(obj)} ${msg ?? ''}`)
    const log: Logger = {
      debug: rec('debug'),
      info: rec('info'),
      warn: rec('warn'),
      error: rec('error'),
      child: () => log,
    }
    relay = await startTestRelay({ log, env: { LOG_LEVEL: 'debug' } })
    relay.runtime.store.putSub({
      endpoint: 'https://push.example.com/send/ENDPOINTMARK',
      keys: { p256dh: 'P256MARK', auth: 'AUTHMARK' },
    })
    const k = kit(relay)
    const app = await k.connectedApp({ visible: false })
    const bridge = await k.bridge({ pinnedDevices: { [app.device.deviceId]: app.device.publicJwk } }).connect()
    const sent = await app.sendMessage('general', 'LOGMARK-private-words')
    await app.expectFrame('reply', (f) => f.message.text?.includes('LOGMARK') === true)
    bridge.createCard({ thread_id: 'general', title: 'LOGMARK-card' })
    await app.expectFrame('card.create')
    // The pushes for the reply and the card have gone out (the sender is asked once per push) and their log lines are in.
    await waitFor(() => (relay?.transport.sent.length ?? 0) >= 2, 3000, 'a push for the reply and one for the card')
    await waitFor(() => lines.some((l) => l.includes('push')), 3000, 'a log line about the push')
    const all = lines.join('\n')
    expect(all).not.toContain('LOGMARK')
    for (const secret of ['ENDPOINTMARK', 'P256MARK', 'AUTHMARK']) expect(all).not.toContain(secret)
    expect(all).toContain('push') // a push was tried, so the lines above had the chance to leak the subscription
    expect(all).not.toContain(sent.osig)
    expect(all).not.toContain(relay.bridgeKey.keyId)
  })
})
