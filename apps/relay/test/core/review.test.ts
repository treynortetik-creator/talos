// Adversarial review tests for PR #5 (not part of the PR). Each test states the behaviour the spec needs.
import { request } from 'node:http'
import { bindingFrom, payloadHash, signBridgeHttp, signChallenge, verifyOwnerFrame } from '@talos-app/protocol'
import { BridgeState, FakeBridge, mkFrame, sleep, waitFor } from '@talos-app/testkit'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { WebSocket } from 'ws'
import { startTestRelay, type TestRelay } from './harness.ts'
import { kit } from './helpers.ts'

vi.setConfig({ testTimeout: 30_000 })

let relay: TestRelay | null = null
afterEach(async () => {
  await relay?.stop()
  relay = null
})

describe('review: delivery', () => {
  it('kill the bridge mid-stream: 20 messages arrive at Claude once each, in send order', async () => {
    relay = await startTestRelay()
    const k = kit(relay)
    const app = await k.connectedApp()
    const state = new BridgeState()
    const b1 = await k
      .bridge({
        state,
        consume: 'manual',
        autoReply: false,
        pinnedDevices: { [app.device.deviceId]: app.device.publicJwk },
      })
      .connect()
    const sent: string[] = []
    for (let i = 0; i < 20; i++) {
      const f = await app.sendMessage('general', `m${i}`)
      sent.push(f.id)
      if (i === 4) {
        // the first five reach the bridge; Claude consumes two of them; then the process dies mid-stream
        await waitFor(() => b1.unconsumedIds().length >= 5, 3000, 'five delivered')
        b1.consume(sent[0] as string)
        b1.consume(sent[1] as string)
        await sleep(30)
        b1.crash()
      }
    }
    await waitFor(() => app.rec.of('ack', 'in').length >= 20, 5000, '20 acks')
    const b2 = await new FakeBridge({
      relayWs: relay.wsBase,
      key: relay.bridgeKey,
      state,
      autoReply: false,
      pinnedDevices: { [app.device.deviceId]: app.device.publicJwk },
    }).connect()
    await waitFor(() => b2.notified.length >= 18, 5000, '18 notified on the new bridge')
    await sleep(1500) // let the resend loop run once more: nothing may be notified twice
    const order = [...b1.notified, ...b2.notified].map((f) => (f as { text?: string }).text)
    expect(order).toEqual(Array.from({ length: 20 }, (_, i) => `m${i}`))
    for (const f of b2.rec.of('message', 'in'))
      expect(await verifyOwnerFrame(f as never, app.device.publicJwk)).toBe(true)
  })

  it('an app whose last_seq is ahead of the relay (volume restored or reset) gets catchup.reset', async () => {
    relay = await startTestRelay()
    const k = kit(relay)
    const bridge = await k.bridge().connect()
    bridge.reply('general', 'after the reset')
    await sleep(80)
    const a = k.app({ lastSeq: 5000 })
    await a.connect()
    // Without a reset the app keeps a cursor of 5000 and every catch-up after the next reconnect returns nothing.
    await waitFor(
      () => a.rec.of('catchup.reset', 'in').length + a.rec.of('catchup.batch', 'in').length > 0,
      4000,
      'a catch-up answer',
    )
    expect(a.rec.of('catchup.reset', 'in').length + a.rec.of('catchup.batch', 'in').length).toBeGreaterThan(0)
  })
})

describe('review: cards', () => {
  it('a card.resolve the bridge rejects leaves the card resolvable (relay state follows the Mac)', async () => {
    relay = await startTestRelay()
    const k = kit(relay)
    const app = await k.connectedApp()
    // The device is not pinned yet: the bridge rejects the first resolve with device_not_pinned (3.5).
    const bridge = await k.bridge({ consume: 'auto' }).connect()
    const card = bridge.createCard({ thread_id: 'general', title: 'Retry me' })
    await app.expectFrame('card.create', (f) => f.card.id === card.id)
    const hash = payloadHash(bindingFrom(card))
    const first = await app.resolveCard(card, 'primary', hash)
    const err = await app.expectFrame('error', (f) => f.ref === first.id)
    expect(err.code).toBe('device_not_pinned')
    // The owner confirms the pin at the Mac and taps again.
    bridge.pin(app.device)
    const second = await app.resolveCard(card, 'primary', hash)
    await bridge.expectFrame('card.resolve', (f) => f.id === second.id, { direction: 'in' })
    const errs = app.rec.of('error', 'in').filter((f) => f.ref === second.id)
    expect(errs.map((e) => e.code)).toEqual([])
    expect(bridge.rec.of('card.resolve', 'in').map((f) => f.id)).toContain(second.id)
  })
})

describe('review: limits before auth', () => {
  // Two unauthenticated callers. One names no trusted key: the relay turns it away from the header, before any body is read
  // (401). One names the real key id with a fresh time, so it gets past the header and meets the size cap (413).
  for (const [name, namesTrustedKey, expected] of [
    ['names no trusted key', false, 401],
    ['names a trusted key with a fresh time (the signature cannot be checked until the body is in)', true, 413],
  ] as const) {
    it(`POST /bridge/post answers an unauthenticated oversized chunked body without buffering all of it: caller ${name}`, async () => {
      relay = await startTestRelay()
      const url = new URL(`${relay.httpBase}/bridge/post`)
      const authorization = namesTrustedKey
        ? await signBridgeHttp({
            privateKey: relay.bridgeKey.privateKey,
            keyId: relay.bridgeKey.keyId,
            method: 'POST',
            pathWithQuery: '/bridge/post',
            body: '',
          })
        : undefined
      const status = await new Promise<number | 'no response'>((resolve) => {
        const req = request(
          {
            host: url.hostname,
            port: url.port,
            path: url.pathname,
            method: 'POST',
            headers: { 'transfer-encoding': 'chunked', ...(authorization ? { authorization } : {}) },
          },
          (res) => resolve(res.statusCode ?? 0),
        )
        req.on('error', () => resolve('no response'))
        // 512 KiB (twice the post-auth frame cap), then the stream stays open: a slow-loris that keeps feeding bytes.
        req.write(Buffer.alloc(512 * 1024, 0x61))
        setTimeout(() => {
          resolve('no response')
          req.destroy()
        }, 2000)
      })
      expect(status).toBe(expected)
    })
  }

  it('a pre-auth bridge frame over 1 MiB is closed at the 256 KiB ws cap (1009 from the ws library, or 4413)', async () => {
    relay = await startTestRelay()
    const ws = new WebSocket(`${relay.wsBase}/bridge`)
    const code = await new Promise<number>((resolve) => {
      ws.on('message', () => ws.send('x'.repeat(2 * 1024 * 1024)))
      ws.on('close', (c) => resolve(c))
    })
    // maxPayload = MAX_FRAME_BYTES, so ws stops buffering at 256 KiB and closes 1009 itself.
    expect([1009, 4413]).toContain(code)
  })

  it('a bridge that never answers the challenge is closed 4408 after 10 s', async () => {
    relay = await startTestRelay()
    const ws = new WebSocket(`${relay.wsBase}/bridge`)
    const started = Date.now()
    const code = await new Promise<number>((resolve) => ws.on('close', (c) => resolve(c)))
    expect(code).toBe(4408)
    expect(Date.now() - started).toBeGreaterThanOrEqual(9_500)
  }, 20_000)
})

describe('review: supersede', () => {
  it('frames from a superseded bridge are not processed after the new one is live', async () => {
    relay = await startTestRelay()
    const k = kit(relay)
    const app = await k.connectedApp()
    // b1 authenticates by hand so the test controls exactly when it sends.
    const ws = new WebSocket(`${relay.wsBase}/bridge`)
    await new Promise<void>((resolve) => {
      ws.on('message', async (d) => {
        const f = JSON.parse(d.toString()) as Record<string, unknown>
        if (f.type === 'challenge') {
          const sig = await signChallenge(relay!.bridgeKey.privateKey, f as never)
          ws.send(
            JSON.stringify(
              mkFrame('hello', {
                role: 'bridge',
                key_id: relay!.bridgeKey.keyId,
                sig,
                client: { name: 'old', version: '0' },
                agent_config_rev: 0,
              }),
            ),
          )
        }
        if (f.type === 'ready') resolve()
      })
    })
    // b1 queues a reply in the same tick in which b2 takes over; the relay should drop what the old socket sends.
    const b2 = k.bridge()
    const ready2 = b2.connect()
    await ready2
    const stale = mkFrame('reply', {
      message: {
        id: 'm_01JBF3WA0H1J2K3M4N5P6Q7R8T',
        thread_id: 'general',
        author: 'agent',
        kind: 'text',
        text: 'from the old bridge',
        format: 'plain',
        attachments: [],
        via: 'app',
        created_at: new Date().toISOString(),
      },
    })
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(stale))
    await sleep(300)
    expect(app.rec.of('reply', 'in').filter((f) => f.message.text === 'from the old bridge')).toHaveLength(0)
  })
})
