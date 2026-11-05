import {
  bindingFrom,
  bridgeKeyId,
  generateBridgeKey,
  type JwkP256T,
  parseFrame,
  payloadHash,
  verifyOwnerFrame,
} from '@talos-app/protocol'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { WebSocket } from 'ws'
import { FakeApp } from '../fake-app.ts'
import { BridgeState, FakeBridge } from '../fake-bridge.ts'
import { buildCard, mkFrame, sleep, waitFor } from '../frame-utils.ts'
import type { RelayHandle, RelayHarness } from './harness.ts'
import { kit, relayCaughtUp, signedPost, textOf } from './relay-kit.ts'
import { defineRelayRefusals } from './relay-refusals.ts'

/**
 * Relay contract (run by WP1 against the real relay): FakeApp + FakeBridge drive it through the frame types of 3.4, with
 * real authentication (session headers, the relay's bridge key, minted step-up tokens). The kit runs it against
 * FakeRelay to prove it is satisfiable.
 */
export function defineRelayContract(name: string, harness: RelayHarness) {
  describe(`relay contract: ${name}`, () => {
    let relay: RelayHandle
    beforeEach(async () => {
      relay = await harness.start()
    })
    afterEach(async () => {
      await relay.stop()
    })

    it('app hello -> ready with config, threads and presence', async () => {
      const app = kit(relay).app()
      const ready = await app.connect()
      expect(ready.agent_config).toBeDefined()
      expect(ready.threads?.length).toBeGreaterThan(0)
      expect(ready.presence.bridge_online).toBe(false)
      await app.close()
    })

    it('bridge hello -> ready, and apps see presence flip', async () => {
      const k = kit(relay)
      const app = await k.connectedApp()
      const bridge = await k.bridge().connect()
      await app.expectFrame('presence', (f) => f.bridge_online === true)
      await bridge.close()
      await app.expectFrame('presence', (f) => f.bridge_online === false)
      await app.close()
    })

    it('message: ack with seq, message.stored to the app, forwarded to the bridge with the signature intact', async () => {
      const k = kit(relay)
      const app = await k.connectedApp()
      const pinned: Record<string, JwkP256T> = { [app.device.deviceId]: app.device.publicJwk }
      const bridge = await k.bridge({ pinnedDevices: pinned }).connect()
      const sent = await app.sendMessage('general', 'Draft the release notes')
      const ack = await app.expectFrame('ack', (f) => f.ref === sent.id)
      expect(ack.seq).toBeGreaterThan(0)
      const stored = await app.expectFrame('message.stored', (f) => f.client_msg_id === sent.client_msg_id)
      expect(stored.message.seq).toBe(ack.seq)
      const atBridge = await bridge.expectFrame('message', (f) => f.id === sent.id, { direction: 'in' })
      expect(atBridge.text).toBe('Draft the release notes')
      const raw = bridge.rec.frames.find((r) => r.frame.id === sent.id && r.direction === 'in')?.raw as Record<
        string,
        unknown
      >
      expect(await verifyOwnerFrame(raw, app.device.publicJwk)).toBe(true)
      expect(bridge.dropped).toHaveLength(0)
      await app.expectFrame('reply', (f) => f.message.text === 'echo: Draft the release notes')
    })

    it('reply: bridge ack with seq, apps receive it', async () => {
      const k = kit(relay)
      const app = await k.connectedApp()
      const bridge = await k.bridge().connect()
      const out = bridge.reply('general', 'Done.')
      const ack = await bridge.expectFrame('ack', (f) => f.ref === out.id, { direction: 'in' })
      expect(ack.seq).toBeGreaterThan(0)
      await app.expectFrame('reply', (f) => f.message.text === 'Done.')
    })

    it('card flow: create -> resolve -> update reaches the app (low risk needs no step-up)', async () => {
      const k = kit(relay)
      const app = await k.connectedApp()
      const bridge = k.bridge({ pinnedDevices: { [app.device.deviceId]: app.device.publicJwk } })
      await bridge.connect()
      const card = bridge.createCard({ thread_id: 'general', title: 'Approve it' })
      await app.expectFrame('card.create', (f) => f.card.id === card.id)
      await app.resolveCard(card, 'primary', payloadHash(bindingFrom(card)))
      await app.expectFrame('card.update', (f) => f.card_id === card.id && f.state === 'resolved')
    })

    describe('step-up', () => {
      async function highRisk() {
        const k = kit(relay)
        const app = await k.connectedApp()
        const bridge = k.bridge({ pinnedDevices: { [app.device.deviceId]: app.device.publicJwk }, consume: 'manual' })
        await bridge.connect()
        const card = bridge.createCard({
          thread_id: 'general',
          kind: 'publish',
          title: 'Post it',
          risk: 'high',
          destination: [{ label: 'To', value: 'example' }],
        })
        await app.expectFrame('card.create', (f) => f.card.id === card.id)
        return { app, bridge, card, hash: payloadHash(bindingFrom(card)) }
      }

      it('a high-risk primary resolve with a minted token is forwarded without the token, signature intact', async () => {
        const { app, bridge, card, hash } = await highRisk()
        const token = await relay.mintStepup(`card:${card.id}`)
        const sent = await app.resolveCard(card, 'primary', hash, { stepup_token: token })
        const got = await bridge.expectFrame('card.resolve', (f) => f.id === sent.id, { direction: 'in' })
        const raw = bridge.rec.frames.find((r) => r.frame.id === sent.id && r.direction === 'in')?.raw as Record<
          string,
          unknown
        >
        expect(raw.stepup_token).toBeUndefined()
        expect(got.payload_hash).toBe(hash)
        expect(await verifyOwnerFrame(raw, app.device.publicJwk)).toBe(true)
      })

      it('without a token: error stepup_required and nothing reaches the bridge', async () => {
        const { app, bridge, card, hash } = await highRisk()
        const sent = await app.resolveCard(card, 'primary', hash)
        const err = await app.expectFrame('error', (f) => f.ref === sent.id)
        expect(err.code).toBe('stepup_required')
        await sleep(150)
        expect(bridge.rec.of('card.resolve', 'in')).toHaveLength(0)
      })

      it('a token for another purpose, an unknown token and a reused token are all refused', async () => {
        const { app, bridge, card, hash } = await highRisk()
        const wrong = await app.resolveCard(card, 'primary', hash, {
          stepup_token: await relay.mintStepup('device:revoke'),
        })
        expect((await app.expectFrame('error', (f) => f.ref === wrong.id)).code).toBe('stepup_invalid')
        const unknown = await app.resolveCard(card, 'primary', hash, { stepup_token: 'st_made_up' })
        expect((await app.expectFrame('error', (f) => f.ref === unknown.id)).code).toBe('stepup_invalid')
        const token = await relay.mintStepup(`card:${card.id}`)
        const ok = await app.resolveCard(card, 'primary', hash, { stepup_token: token })
        await bridge.expectFrame('card.resolve', (f) => f.id === ok.id, { direction: 'in' })
        const reuse = await app.resolveCard(card, 'primary', hash, { stepup_token: token })
        expect((await app.expectFrame('error', (f) => f.ref === reuse.id)).code).toMatch(/^stepup_(invalid|required)$/)
      })

      it('config.patch needs config:work only when it touches work.enabled', async () => {
        const k = kit(relay)
        const app = await k.connectedApp()
        const bridge = k.bridge({ verifyOwner: false, consume: 'manual' })
        await bridge.connect()
        const plain = await app.sendConfigPatch(0, { quiet_window: null })
        await bridge.expectFrame('config.patch', (f) => f.id === plain.id, { direction: 'in' })
        const work = await app.sendConfigPatch(0, { work: { enabled: ['slack'] } })
        expect((await app.expectFrame('error', (f) => f.ref === work.id)).code).toBe('stepup_required')
        const withToken = await app.sendConfigPatch(
          0,
          { work: { enabled: ['slack'] } },
          { stepup_token: await relay.mintStepup('config:work') },
        )
        await bridge.expectFrame('config.patch', (f) => f.id === withToken.id, { direction: 'in' })
      })
    })

    describe('what the relay refuses before the Mac sees it', () => {
      it('config.patch on a field the app may not change is config_field_forbidden and is not forwarded', async () => {
        const k = kit(relay)
        const app = await k.connectedApp()
        const bridge = k.bridge({ verifyOwner: false, consume: 'manual' })
        await bridge.connect()
        const bad = await app.sendConfigPatch(0, { trust_mode: true })
        expect((await app.expectFrame('error', (f) => f.ref === bad.id)).code).toBe('config_field_forbidden')
        // A later allowed patch reaching the bridge shows the forbidden one was decided (and dropped) before it.
        const plain = await app.sendConfigPatch(0, { quiet_window: null })
        await bridge.expectFrame('config.patch', (f) => f.id === plain.id, { direction: 'in' })
        expect(bridge.rec.of('config.patch', 'in').filter((f) => f.id === bad.id)).toHaveLength(0)
      })

      it('card.resolve for a card the relay never saw is card_not_pending and is not forwarded', async () => {
        const k = kit(relay)
        const app = await k.connectedApp()
        const bridge = k.bridge({ verifyOwner: false, consume: 'manual' })
        await bridge.connect()
        const stray = buildCard({ thread_id: 'general', risk: 'low' }) // never sent through card.create
        const sent = await app.resolveCard(stray, 'kill', payloadHash(bindingFrom(stray)))
        expect((await app.expectFrame('error', (f) => f.ref === sent.id)).code).toBe('card_not_pending')
        expect(bridge.rec.of('card.resolve', 'in').filter((f) => f.id === sent.id)).toHaveLength(0)
      })
    })

    it('dedups a resent message (same client_msg_id): one forward to the bridge', async () => {
      const k = kit(relay)
      const app = await k.connectedApp()
      const bridge = await k.bridge({ autoReply: false, verifyOwner: false }).connect()
      const sent = await app.sendMessage('general', 'once')
      await bridge.expectFrame('message', (f) => f.id === sent.id, { direction: 'in' })
      app.sendRaw(JSON.stringify(sent)) // outbox resend: identical bytes
      await sleep(150)
      expect(bridge.rec.of('message', 'in').filter((f) => f.client_msg_id === sent.client_msg_id)).toHaveLength(1)
      await waitFor(() => app.rec.of('ack', 'in').filter((a) => a.ref === sent.id).length >= 1)
    })

    it('a replayed owner frame id (card.resolve) is acked again and not forwarded twice', async () => {
      const k = kit(relay)
      const app = await k.connectedApp()
      const bridge = k.bridge({ verifyOwner: false, consume: 'manual' })
      await bridge.connect()
      const card = bridge.createCard({ thread_id: 'general', title: 'Once only' })
      await app.expectFrame('card.create', (f) => f.card.id === card.id)
      const sent = await app.resolveCard(card, 'kill', payloadHash(bindingFrom(card)))
      await bridge.expectFrame('card.resolve', (f) => f.id === sent.id, { direction: 'in' })
      app.sendRaw(JSON.stringify(sent))
      await sleep(150)
      expect(bridge.rec.of('card.resolve', 'in').filter((f) => f.id === sent.id)).toHaveLength(1)
    })

    it('inbox.update from one device reaches the other device and not the bridge', async () => {
      const k = kit(relay)
      const a = await k.connectedApp()
      const b = await k.connectedApp()
      const bridge = await k.bridge().connect()
      relay.seedInboxItem?.('e_01JBF3V7Q8K2M4N6P8R0S2T4V6')
      a.send({ type: 'inbox.update', event_id: 'e_01JBF3V7Q8K2M4N6P8R0S2T4V6', state: 'done' })
      await b.expectFrame('inbox.update', (f) => f.event_id === 'e_01JBF3V7Q8K2M4N6P8R0S2T4V6')
      await a.expectFrame('ack')
      await sleep(150)
      expect(bridge.rec.of('inbox.update', 'in')).toHaveLength(0)
    })

    it('answers an unknown frame type with error{bad_frame} and keeps the socket open', async () => {
      const app = await kit(relay).connectedApp()
      app.send({ type: 'nope.never' })
      const err = await app.expectFrame('error')
      expect(err.code).toBe('bad_frame')
      expect(app.connected).toBe(true)
    })

    it('every frame it emits parses against its direction union', async () => {
      const k = kit(relay)
      const app = await k.connectedApp()
      const bridge = await k.bridge({ pinnedDevices: { [app.device.deviceId]: app.device.publicJwk } }).connect()
      await app.sendMessage('general', 'hi')
      await app.expectFrame('reply')
      for (const r of app.rec.frames.filter((x) => x.direction === 'in')) {
        const res = parseFrame(r.raw, { direction: 'relay_to_app' })
        expect(res.ok, `${String(r.raw.type)}: ${res.ok ? '' : res.message}`).toBe(true)
      }
      for (const r of bridge.rec.frames.filter((x) => x.direction === 'in')) {
        const res = parseFrame(r.raw, { direction: 'relay_to_bridge' })
        expect(res.ok, `${String(r.raw.type)}: ${res.ok ? '' : res.message}`).toBe(true)
      }
    })

    it('catch-up pages: at most 200 frames, to_seq is the last included seq, more says whether any remain', async () => {
      const k = kit(relay)
      const a = await k.connectedApp()
      for (let i = 0; i < 205; i++) await a.sendMessage('general', `m${i}`)
      await waitFor(() => a.rec.of('ack', 'in').length >= 205, 10_000, '205 acks')
      const b = k.app()
      b.lastSeq = 1
      await b.connect()
      const first = await b.expectFrame('catchup.batch')
      expect(first.frames.length).toBeLessThanOrEqual(200)
      const seqs = (f: { relay?: { seq: number } }) => f.relay?.seq ?? 0
      const maxOf = (frames: Array<{ relay?: { seq: number } }>) => Math.max(...frames.map(seqs))
      expect(first.to_seq).toBe(maxOf(first.frames as Array<{ relay?: { seq: number } }>))
      expect(first.more).toBe(true)
      // following the cursor to the end loses nothing
      const seen = new Set((first.frames as Array<{ relay?: { seq: number } }>).map(seqs))
      let cursor = first.to_seq
      for (let guard = 0; guard < 5; guard++) {
        const before = b.rec.length
        b.send({ type: 'catchup.request', since_seq: cursor })
        const page = await b.expectFrame('catchup.batch', (f) => f.from_seq === cursor + 1, { since: before })
        for (const f of page.frames as Array<{ relay?: { seq: number } }>) seen.add(seqs(f))
        cursor = page.to_seq
        if (!page.more) break
      }
      for (let s = 2; s <= Math.max(...seen); s++)
        if (!seen.has(s) && s <= cursor) throw new Error(`catch-up skipped seq ${s}`)
    })

    describe('bridge authentication (Ed25519)', () => {
      it('a bridge with the wrong key is refused with 4401; the right key connects', async () => {
        const wrong = await generateBridgeKey()
        const code = await new FakeBridge({ relayWs: relay.wsBase, key: wrong }).connectExpectingRefusal()
        expect(code).toBe(4401)
        const ok = await kit(relay).bridge().connect()
        expect(ok.connected).toBe(true)
      })

      it('a hello with the right signature but a wrong key_id is refused', async () => {
        const key = relay.bridgeKey
        expect(key.keyId).toBe(bridgeKeyId(Buffer.from(key.publicKeyB64, 'base64url')))
        const ws = new WebSocket(`${relay.wsBase}/bridge`)
        const code = await new Promise<number>((resolve) => {
          ws.on('message', (d) => {
            const f = JSON.parse(textOf(d as Buffer)) as { type: string }
            if (f.type === 'challenge') {
              void import('@talos-app/protocol').then(async (p) => {
                const sig = await p.signChallenge(key.privateKey, f as never)
                ws.send(
                  JSON.stringify(
                    mkFrame('hello', {
                      role: 'bridge',
                      key_id: '0000000000000000',
                      sig,
                      client: { name: 't', version: '0' },
                      agent_config_rev: 0,
                    }),
                  ),
                )
              })
            }
          })
          ws.on('close', (c) => resolve(c))
        })
        expect(code).toBe(4401)
      })

      it('anything but hello first is 4401', async () => {
        const ws = new WebSocket(`${relay.wsBase}/bridge`)
        const code = await new Promise<number>((resolve) => {
          ws.on('open', () => ws.send(JSON.stringify(mkFrame('ping', { nonce: 'x' }))))
          ws.on('close', (c) => resolve(c))
        })
        expect(code).toBe(4401)
      })

      it('a headless reply over a signed POST /bridge/post is accepted; unsigned, tampered, replayed and wrong-type posts are not', async () => {
        const app = await kit(relay).connectedApp()
        const reply = {
          ...mkFrame('reply'),
          message: {
            id: `m_${'0'.repeat(25)}1`,
            thread_id: 'general',
            author: 'agent',
            kind: 'text',
            text: 'headless',
            format: 'plain',
            attachments: [],
            via: 'headless',
            created_at: new Date().toISOString(),
          },
        }
        const { body, header } = await signedPost(relay, reply)
        const post = (b: string, auth?: string) =>
          fetch(`${relay.httpBase}/bridge/post`, {
            method: 'POST',
            body: b,
            headers: { 'content-type': 'application/json', ...(auth ? { authorization: auth } : {}) },
          })
        const ok = await post(body, header)
        expect(ok.status).toBe(200)
        expect(((await ok.json()) as { ack: { ref: string } }).ack.ref).toBe(reply.id)
        await app.expectFrame('reply', (f) => f.message.text === 'headless')

        expect((await post(body)).status).toBe(401) // no Authorization header
        expect((await post(body.replace('headless', 'tampered'), header)).status).toBe(401) // body changed after signing
        expect((await post(body, header)).status).toBe(401) // same nonce again
        const wrongKey = await generateBridgeKey()
        const forged = await signedPost(relay, reply, { key: wrongKey })
        expect((await post(forged.body, forged.header)).status).toBe(401)
        const hook = { ...mkFrame('ping'), nonce: 'x' }
        const wrongType = await signedPost(relay, hook)
        expect((await post(wrongType.body, wrongType.header)).status).toBe(400) // only reply, card.create, thread.upsert, inbox.update
      })
    })

    defineRelayRefusals(() => relay)

    describe('socket guards', () => {
      it('an oversize frame before authentication closes with 4413', async () => {
        const ws = new WebSocket(`${relay.wsBase}/ws`, { headers: relay.appHeaders })
        const code = await new Promise<number>((resolve, reject) => {
          ws.on('open', () =>
            ws.send(JSON.stringify({ v: 1, type: 'ping', id: 'x', ts: 'y', nonce: 'x'.repeat(70_000) })),
          )
          ws.on('close', (c) => resolve(c))
          ws.on('error', reject)
        })
        expect(code).toBe(4413)
      })

      it('a non-hello first frame on /ws is refused (4401 or 4400)', async () => {
        const ws = new WebSocket(`${relay.wsBase}/ws`, { headers: relay.appHeaders })
        const code = await new Promise<number>((resolve, reject) => {
          ws.on('open', () => ws.send(JSON.stringify(mkFrame('visibility', { state: 'visible' }))))
          ws.on('close', (c) => resolve(c))
          ws.on('error', reject)
        })
        expect([4400, 4401]).toContain(code)
      })

      it('without a session the upgrade is refused with 401 (before any frame)', async () => {
        if (!relay.unauthenticatedHeaders) return
        const app = new FakeApp({ relayWs: relay.wsBase, headers: relay.unauthenticatedHeaders })
        expect(await app.connectExpectingRefusal()).toBe(401)
      })

      it('with a session but the wrong Origin the upgrade is refused with 403', async () => {
        if (!relay.wrongOriginHeaders) return
        const app = new FakeApp({ relayWs: relay.wsBase, headers: relay.wrongOriginHeaders })
        expect(await app.connectExpectingRefusal()).toBe(403)
      })
    })
  })
}

/**
 * Two-stage ack (delivered / consumed) as seen from the relay. A message the bridge received but Claude never consumed
 * before a crash must not be lost, and must not be reordered: on every bridge hello the relay re-sends all frames not yet
 * `consumed`, in relay.seq order. `replay.request` is an optional hint with the same result.
 */
export function defineTwoStageAckContract(name: string, harness: RelayHarness) {
  describe(`two-stage ack contract: ${name}`, () => {
    let relay: RelayHandle
    beforeEach(async () => {
      relay = await harness.start()
    })
    afterEach(async () => {
      await relay.stop()
    })

    it('re-sends a delivered-but-unconsumed message after a crash, with no request from the bridge', async () => {
      const k = kit(relay)
      const app = await k.connectedApp()
      const state = new BridgeState()
      const pin = { [app.device.deviceId]: app.device.publicJwk }
      const b1 = await k.bridge({ state, consume: 'manual', autoReply: false, pinnedDevices: pin }).connect()
      const sent = await app.sendMessage('general', 'do not lose me')
      await b1.expectFrame('message', (f) => f.id === sent.id, { direction: 'in' })
      await b1.expectFrame('ack', (f) => f.ref === sent.id && f.stage === 'delivered', { direction: 'out' })
      await sleep(80)
      expect(b1.notified).toHaveLength(0)
      expect(b1.unconsumedIds()).toEqual([sent.id])
      b1.crash()
      await sleep(50)

      const b2 = await k.bridge({ state, autoReply: false, pinnedDevices: pin }).connect()
      await b2.expectFrame('message', (f) => f.id === sent.id, { direction: 'in' })
      await b2.waitNotified('message')
      expect(b2.rec.of('replay.request', 'out')).toHaveLength(0)
      expect(b2.notified.filter((f) => f.id === sent.id)).toHaveLength(1)
      await b2.expectFrame('ack', (f) => f.ref === sent.id && f.stage === 'consumed', { direction: 'out' })
      expect(state.unconsumed.size).toBe(0)
    })

    it('keeps order across a crash: A (delivered, unconsumed) then B (sent while offline) arrive A, B', async () => {
      const k = kit(relay)
      const app = await k.connectedApp()
      const state = new BridgeState()
      const pin = { [app.device.deviceId]: app.device.publicJwk }
      const b1 = await k.bridge({ state, consume: 'manual', autoReply: false, pinnedDevices: pin }).connect()
      const a = await app.sendMessage('general', 'A: do the thing')
      await b1.expectFrame('message', (f) => f.id === a.id, { direction: 'in' })
      await sleep(80)
      b1.crash()
      await sleep(50)
      const b = await app.sendMessage('general', 'B: actually cancel that')
      await app.expectFrame('ack', (f) => f.ref === b.id)
      const b2 = await k.bridge({ state, autoReply: false, pinnedDevices: pin }).connect()
      await b2.waitNotified('message', 2)
      expect(b2.notified.map((f) => (f as { text: string }).text)).toEqual([
        'A: do the thing',
        'B: actually cancel that',
      ])
    })

    it('a duplicate arrival (re-send plus replay.request hint) is notified once', async () => {
      const k = kit(relay)
      const app = await k.connectedApp()
      const state = new BridgeState()
      const pin = { [app.device.deviceId]: app.device.publicJwk }
      const b1 = await k.bridge({ state, consume: 'manual', autoReply: false, pinnedDevices: pin }).connect()
      const sent = await app.sendMessage('general', 'once please')
      await b1.expectFrame('message', (f) => f.id === sent.id, { direction: 'in' })
      await sleep(80)
      b1.crash()
      await sleep(50)
      const b2 = await k.bridge({ state, autoReply: false, pinnedDevices: pin, requestReplay: true }).connect()
      await b2.waitNotified('message')
      await sleep(250)
      expect(b2.notified.filter((f) => f.id === sent.id)).toHaveLength(1)
      expect(
        b2.rec.of('ack', 'out').filter((a) => a.ref === sent.id && a.stage === 'consumed').length,
      ).toBeGreaterThanOrEqual(1)
    })

    it('the signature still verifies after replay (original bytes are re-sent)', async () => {
      const k = kit(relay)
      const app = await k.connectedApp()
      const state = new BridgeState()
      const pin = { [app.device.deviceId]: app.device.publicJwk }
      const b1 = await k.bridge({ state, consume: 'manual', pinnedDevices: pin }).connect()
      const sent = await app.sendMessage('general', 'signed')
      await b1.expectFrame('message', (f) => f.id === sent.id, { direction: 'in' })
      await sleep(80)
      b1.crash()
      await sleep(50)
      const b2 = await k.bridge({ state, autoReply: false, pinnedDevices: pin }).connect()
      await b2.waitNotified('message')
      expect(b2.dropped).toHaveLength(0)
    })

    it('does not re-send a consumed message', async () => {
      const k = kit(relay)
      const app = await k.connectedApp()
      const pin = { [app.device.deviceId]: app.device.publicJwk }
      const b1 = await k.bridge({ autoReply: false, pinnedDevices: pin }).connect()
      const sent = await app.sendMessage('general', 'consume me')
      await b1.waitNotified('message')
      await b1.expectFrame('ack', (f) => f.ref === sent.id && f.stage === 'consumed', { direction: 'out' })
      await relayCaughtUp(b1)
      b1.crash()
      await sleep(50)
      const b2 = await k.bridge({ autoReply: false, pinnedDevices: pin }).connect()
      await sleep(250)
      expect(b2.rec.of('message', 'in').filter((f) => f.id === sent.id)).toHaveLength(0)
    })

    it('a frame the bridge rejects is acked consumed after its error and never comes back', async () => {
      const k = kit(relay)
      const app = await k.connectedApp()
      const state = new BridgeState()
      const b1 = await k.bridge({ state, autoReply: false }).connect() // nothing pinned: every owner frame is rejected
      const sent = await app.sendMessage('general', 'from an unpinned device')
      const err = await b1.expectFrame('error', (f) => f.ref === sent.id, { direction: 'out' })
      expect(err.code).toBe('device_not_pinned')
      await b1.expectFrame('ack', (f) => f.ref === sent.id && f.stage === 'consumed', { direction: 'out' })
      await relayCaughtUp(b1)
      b1.crash()
      await sleep(50)
      const b2 = await k.bridge({ state, autoReply: false }).connect()
      await sleep(250)
      expect(b2.rec.of('message', 'in').filter((f) => f.id === sent.id)).toHaveLength(0)
    })

    it('delivers a message that arrived while the bridge was offline, without any replay.request', async () => {
      const k = kit(relay)
      const app = await k.connectedApp()
      const sent = await app.sendMessage('general', 'sent while offline')
      await app.expectFrame('ack', (f) => f.ref === sent.id)
      const b = await k
        .bridge({ autoReply: false, pinnedDevices: { [app.device.deviceId]: app.device.publicJwk } })
        .connect()
      await b.expectFrame('message', (f) => f.id === sent.id, { direction: 'in' })
      await b.waitNotified('message')
      expect(b.rec.of('replay.request', 'out')).toHaveLength(0)
    })

    it('replay.request with unknown ids is ignored without an error', async () => {
      const k = kit(relay)
      const app = await k.connectedApp()
      const pin = { [app.device.deviceId]: app.device.publicJwk }
      const b = await k.bridge({ autoReply: false, pinnedDevices: pin }).connect()
      b.send({ type: 'replay.request', ids: ['01JBF3V7Q8K2M4N6P8R0S2T4ZZ'] })
      await sleep(200)
      expect(b.rec.of('error', 'in')).toHaveLength(0)
      expect(b.connected).toBe(true)
    })
  })
}
