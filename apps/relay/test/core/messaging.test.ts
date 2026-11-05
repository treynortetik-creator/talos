// Replay, dedup, fan-out, error forwarding, history and config storage (spec 9 WP1 acceptance).
import { type JwkP256T, newUlid, verifyOwnerFrame } from '@talos-app/protocol'
import { mkFrame, sleep, waitFor } from '@talos-app/testkit'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { startTestRelay, type TestRelay } from './harness.ts'
import { kit } from './helpers.ts'

vi.setConfig({ testTimeout: 20_000 })

describe('core messaging', () => {
  let relay: TestRelay
  beforeEach(async () => {
    relay = await startTestRelay()
  })
  afterEach(async () => {
    await relay.stop()
  })

  it('replays what an app missed after a reconnect, in order, and nothing it already has', async () => {
    const k = kit(relay)
    const a = await k.connectedApp()
    const bridge = await k.bridge().connect()
    bridge.reply('general', 'one')
    bridge.reply('general', 'two')
    await a.expectFrame('reply', (f) => f.message.text === 'two')
    const seen = a.lastSeq
    await a.close()
    bridge.reply('general', 'three')
    bridge.reply('general', 'four')
    await bridge.expectFrame('ack', (f) => f.seq !== undefined && f.seq > seen, { direction: 'in' })
    await sleep(50)
    const b = k.app({ lastSeq: seen })
    await b.connect()
    const batch = await b.expectFrame('catchup.batch')
    const texts = batch.frames.map((f) => (f as { message?: { text?: string } }).message?.text)
    expect(texts).toEqual(['three', 'four'])
    expect(batch.from_seq).toBe(seen + 1)
    expect(batch.more).toBe(false)
  })

  it('sends catchup.reset when the app is behind the buffer floor', async () => {
    // The floor moves when the sweeper prunes; here we prune by hand through the store the sweeper uses.
    const k = kit(relay)
    const bridge = await k.bridge().connect()
    for (let i = 0; i < 5; i++) bridge.reply('general', `m${i}`)
    await bridge.expectFrame('ack', (f) => f.seq === 5, { direction: 'in' })
    relay.runtime.store.db.prepare('delete from core_events where seq <= 3').run()
    relay.runtime.store.setState('floor', '4')
    const a = k.app({ lastSeq: 1 })
    await a.connect()
    const reset = await a.expectFrame('catchup.reset')
    expect(reset.min_seq).toBe(4)
    const batch = await a.expectFrame('catchup.batch')
    expect(batch.from_seq).toBe(4)
    expect(batch.frames).toHaveLength(2)
  })

  it('forwards a message to the bridge with the owner signature fields untouched and a relay meta added', async () => {
    const k = kit(relay)
    const a = await k.connectedApp()
    const bridge = await k
      .bridge({ pinnedDevices: { [a.device.deviceId]: a.device.publicJwk }, autoReply: false })
      .connect()
    const sent = await a.sendMessage('general', 'Draft the release notes')
    await bridge.expectFrame('message', (f) => f.id === sent.id, { direction: 'in' })
    const raw = bridge.rec.frames.find((r) => r.frame.id === sent.id && r.direction === 'in')?.raw as Record<
      string,
      unknown
    >
    const { relay: meta, ...rest } = raw
    expect(meta).toMatchObject({ seq: expect.any(Number), received_at: expect.any(String) })
    expect(rest).toEqual(sent)
    expect(await verifyOwnerFrame(raw, a.device.publicJwk)).toBe(true)
  })

  it('a message nobody could deliver is resent on the next bridge hello, once, and deduped by id', async () => {
    const k = kit(relay)
    const a = await k.connectedApp()
    const sent = await a.sendMessage('general', 'while you were out')
    await a.expectFrame('ack', (f) => f.ref === sent.id)
    const pin: Record<string, JwkP256T> = { [a.device.deviceId]: a.device.publicJwk }
    const first = await k.bridge({ pinnedDevices: pin, autoReply: false }).connect()
    await first.expectFrame('message', (f) => f.id === sent.id, { direction: 'in' })
    await first.waitNotified('message')
    expect(first.notified.filter((f) => f.id === sent.id)).toHaveLength(1)
    await first.close()
    const second = await k.bridge({ pinnedDevices: pin, autoReply: false }).connect()
    await sleep(200)
    // consumed the first time, so it is not sent again
    expect(second.rec.of('message', 'in')).toHaveLength(0)
  })

  it('a reply reaches two app sockets', async () => {
    const k = kit(relay)
    const a = await k.connectedApp()
    const b = await k.connectedApp()
    const bridge = await k.bridge().connect()
    bridge.reply('general', 'hello both')
    await a.expectFrame('reply', (f) => f.message.text === 'hello both')
    await b.expectFrame('reply', (f) => f.message.text === 'hello both')
  })

  it('stores a message once when the same client_msg_id arrives twice (different frame ids)', async () => {
    const k = kit(relay)
    const a = await k.connectedApp()
    const bridge = await k.bridge({ verifyOwner: false, autoReply: false }).connect()
    const first = await a.sendMessage('general', 'only once')
    const clientMsgId = first.client_msg_id
    const second = await a.sendMessage('general', 'only once', { client_msg_id: clientMsgId })
    await a.expectFrame('ack', (f) => f.ref === second.id)
    await sleep(150)
    await vi.waitFor(
      () => expect(bridge.rec.of('message', 'in').filter((f) => f.client_msg_id === clientMsgId)).toHaveLength(1),
      { timeout: 10_000 },
    )
    const rows = relay.runtime.store.db.prepare("select count(*) n from core_events where type = 'message'").get() as {
      n: number
    }
    expect(rows.n).toBe(1)
    const acks = a.rec.of('ack', 'in')
    expect(acks.find((x) => x.ref === first.id)?.seq).toBe(acks.find((x) => x.ref === second.id)?.seq)
  })

  it('forwards a bridge error{ref} to the socket that sent the ref, and only that socket', async () => {
    const k = kit(relay)
    const a = await k.connectedApp()
    const other = await k.connectedApp()
    const bridge = await k.bridge({ autoReply: false }).connect() // nothing pinned: the bridge rejects with device_not_pinned
    const sent = await a.sendMessage('general', 'from an unpinned device')
    const err = await a.expectFrame('error', (f) => f.ref === sent.id)
    expect(err.code).toBe('device_not_pinned')
    await sleep(100)
    expect(other.rec.of('error', 'in')).toHaveLength(0)
    expect(bridge.connected).toBe(true)
  })

  it('stores a bridge rejection as a system message when the sending socket is gone', async () => {
    const k = kit(relay)
    const a = await k.connectedApp()
    const watcher = await k.connectedApp()
    const bridge = await k.bridge({ autoReply: false, consume: 'manual' }).connect()
    const sent = await a.sendMessage('general', 'bye')
    await bridge.expectFrame('message', (f) => f.id === sent.id, { direction: 'in' })
    await a.close()
    await sleep(50)
    bridge.send({ type: 'error', ref: sent.id, code: 'sig_invalid', message: 'bad signature' })
    const stored = await watcher.expectFrame(
      'message.stored',
      (f) => f.message.author === 'system' && f.message.thread_id === 'general',
    )
    expect(stored.message.text).toContain('sig_invalid')
  })

  it('serves history from the buffer, newest page first, with has_more', async () => {
    const k = kit(relay)
    const a = await k.connectedApp()
    const bridge = await k.bridge({ autoReply: false, verifyOwner: false }).connect()
    for (let i = 0; i < 5; i++) bridge.reply('general', `r${i}`)
    await bridge.expectFrame('ack', (f) => f.seq === 5, { direction: 'in' })
    a.send({ type: 'history.request', request_id: 'h1', thread_id: 'general', limit: 3 })
    const page = await a.expectFrame('history.page', (f) => f.request_id === 'h1')
    expect(page.messages.map((m) => m.text)).toEqual(['r2', 'r3', 'r4'])
    expect(page.has_more).toBe(true)
    const oldest = page.messages[0]?.seq as number
    a.send({ type: 'history.request', request_id: 'h2', thread_id: 'general', before_seq: oldest, limit: 3 })
    const rest = await a.expectFrame('history.page', (f) => f.request_id === 'h2')
    expect(rest.messages.map((m) => m.text)).toEqual(['r0', 'r1'])
    expect(rest.has_more).toBe(false)
  })

  it('history beyond the buffer with no bridge answers unavailable: mac_offline', async () => {
    const k = kit(relay)
    const a = await k.connectedApp()
    // The buffer has been pruned at some point, so older history lives only on the Mac.
    relay.runtime.store.setState('floor', '10')
    a.send({ type: 'history.request', request_id: 'old', thread_id: 'general', before_seq: 5, limit: 20 })
    const page = await a.expectFrame('history.page', (f) => f.request_id === 'old')
    expect(page.unavailable).toBe('mac_offline')
    expect(page.messages).toEqual([])
    expect(page.has_more).toBe(false)
  })

  it('proxies history beyond the buffer to the bridge when it is online', async () => {
    const k = kit(relay)
    const a = await k.connectedApp()
    const bridge = await k.bridge().connect()
    relay.runtime.store.setState('floor', '10')
    a.send({ type: 'history.request', request_id: 'far', thread_id: 'general', before_seq: 5, limit: 20 })
    const asked = await bridge.expectFrame('history.request', (f) => f.request_id === 'far', { direction: 'in' })
    expect(asked.thread_id).toBe('general')
    bridge.send({
      type: 'history.page',
      request_id: 'far',
      thread_id: 'general',
      messages: [],
      has_more: false,
    })
    await a.expectFrame('history.page', (f) => f.request_id === 'far' && f.unavailable === undefined)
  })

  it('ready carries the legacy top-level mirror {telegram:off} on the default config and on a synced one (older app, R1-1)', async () => {
    const k = kit(relay)
    const a = await k.connectedApp()
    const bridge = await k.bridge().connect()
    const first = a.rec.of('ready', 'in')[0]?.agent_config as Record<string, unknown>
    expect(first.mirror).toEqual({ telegram: 'off' })
    const { mirror: _m, ...bare } = first // what the bridge's own config has: no mirror
    bridge.send({ type: 'config.sync', config: { ...bare, rev: 3 }, rev: 3 })
    await a.expectFrame('config.sync', (f) => f.rev === 3)
    const late = await k.connectedApp()
    const synced = late.rec.of('ready', 'in')[0]?.agent_config as Record<string, unknown>
    expect(synced.rev).toBe(3)
    expect(synced.mirror).toEqual({ telegram: 'off' })
  })

  it('config.sync is stored, fanned out, served in ready, and survives a restart', async () => {
    const k = kit(relay)
    const a = await k.connectedApp()
    const bridge = await k.bridge().connect()
    const cfg = { ...(a.rec.of('ready', 'in')[0]?.agent_config as object) } as Record<string, unknown>
    const next = { ...cfg, rev: 7, agent: { name: 'Orion', voice: 'meridian', voice_persona: '' } }
    bridge.send({ type: 'config.sync', config: next, rev: 7 })
    await a.expectFrame('config.sync', (f) => f.rev === 7)
    expect(relay.relay.services.agentConfig()?.rev).toBe(7)
    const late = await k.connectedApp()
    expect(late.rec.of('ready', 'in')[0]?.agent_config?.agent.name).toBe('Orion')
    const dir = relay.dir
    await relay.stopKeepData()
    relay = await startTestRelay({ dir })
    expect(relay.relay.services.agentConfig()?.rev).toBe(7)
  })

  it('answers ping with pong, and unknown frames with bad_frame', async () => {
    const a = await kit(relay).connectedApp()
    a.send({ type: 'ping', nonce: 'x' })
    await a.expectFrame('pong', (f) => f.nonce === 'x')
    a.send({ type: 'not.a.frame' })
    expect((await a.expectFrame('error')).code).toBe('bad_frame')
  })

  it('paces a burst of frames instead of dropping them, and closes 4429 on a flood', async () => {
    const k = kit(relay)
    const a = await k.connectedApp()
    for (let i = 0; i < 80; i++) a.send({ type: 'ping', nonce: `n${i}` })
    await waitFor(() => a.rec.of('pong', 'in').length === 80, 10_000, '80 pongs')
    const flood = await k.connectedApp()
    const closed = new Promise<number>((r) => flood.ws?.once('close', (c) => r(c)))
    for (let i = 0; i < 700; i++)
      flood.sendRaw(JSON.stringify({ v: 1, type: 'ping', id: newUlid(), ts: new Date().toISOString(), nonce: 'f' }))
    expect(await closed).toBe(4429)
  })

  it('a thread.read goes to the other devices, not the sender, and lowers unread in the next ready', async () => {
    const k = kit(relay)
    const a = await k.connectedApp()
    const b = await k.connectedApp()
    const bridge = await k.bridge().connect()
    bridge.reply('general', 'unread one')
    const reply = await a.expectFrame('reply')
    const seq = reply.relay?.seq as number
    const c1 = await k.connectedApp()
    expect(c1.rec.of('ready', 'in')[0]?.unread).toEqual({ general: 1 })
    // Nothing read yet: the app is told so, which is how it finds the first unread row without counting from the end.
    expect(c1.rec.of('ready', 'in')[0]?.read_upto).toEqual({})
    a.send({ type: 'thread.read', thread_id: 'general', up_to_seq: seq })
    await b.expectFrame('thread.read', (f) => f.up_to_seq === seq)
    await sleep(50)
    expect(a.rec.of('thread.read', 'in')).toHaveLength(0)
    const c2 = await k.connectedApp()
    expect(c2.rec.of('ready', 'in')[0]?.unread).toEqual({})
    expect(c2.rec.of('ready', 'in')[0]?.read_upto).toEqual({ general: seq })
  })

  it('refuses a hello for a different device than the session is bound to (4401)', async () => {
    const { createDeviceKey } = await import('@talos-app/protocol')
    const { WebSocket } = await import('ws')
    const mine = await createDeviceKey()
    const other = await createDeviceKey()
    let reason = ''
    const hello = (deviceId: string, sessionDevice: string) =>
      new Promise<number | 'ready'>((resolve, reject) => {
        const ws = new WebSocket(`${relay.wsBase}/ws`, {
          headers: { ...relay.appHeaders, 'X-Test-Session': sessionDevice },
        })
        ws.on('open', () =>
          ws.send(
            JSON.stringify(
              mkFrame('hello', {
                role: 'app',
                device_id: deviceId,
                last_seq: 0,
                visible: true,
                client: { version: '0', standalone: true, platform: 'test' },
              }),
            ),
          ),
        )
        ws.on('message', () => {
          ws.close()
          resolve('ready')
        })
        ws.on('close', (code, why) => {
          reason = why.toString()
          resolve(code)
        })
        ws.on('error', reject)
      })
    expect(await hello(mine.deviceId, mine.deviceId)).toBe('ready')
    expect(await hello(mine.deviceId, other.deviceId)).toBe(4401)
    // The app wipes its queue on 4401 with no reason; this one says the tab only holds an old key, so it does not.
    expect(reason).toBe('device_changed')
  })
})
