// Records what the relay hub does today for the owner's main journeys, so a move of hub.ts code that changes behaviour
// goes red. Each sequence is compared, frame by frame and with the stored state after, to golden/hub.golden.json.
// Rewrite the golden on purpose with UPDATE_GOLDEN=1.

import { createDeviceKey, generateBridgeKey, payloadHash, signOwnerFrame } from '@talos-app/protocol'
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest'
import {
  bindingFrom,
  buildCard,
  frame,
  goldenMode,
  type Replay,
  readGolden,
  START_ISO,
  saveGolden,
  startReplay,
  uid,
} from './replay-harness.ts'

vi.setConfig({ testTimeout: 30_000 })

let rp: Replay | null = null
afterEach(async () => {
  await rp?.stop()
  rp = null
})

const results: Record<string, unknown> = {}

const reply = (text: string) =>
  frame('reply', {
    message: {
      id: uid('m_'),
      thread_id: 'general',
      author: 'agent',
      kind: 'text',
      text,
      format: 'plain',
      attachments: [],
      via: 'app',
      created_at: START_ISO,
    },
  })

const sequences: Record<string, (r: Replay) => Promise<void>> = {
  async owner_message(r) {
    const bridge = await r.bridge('bridge')
    const app = r.app('app')
    await r.hello(app)
    const msg = await r.signed({
      ...frame('message'),
      thread_id: 'general',
      client_msg_id: uid('m_'),
      text: 'Hello from Alex Example',
      attachments: [],
    })
    await r.appSend(app, msg)
    r.note('bridge acks the message')
    await r.bridgeSend(bridge, frame('ack', { ref: msg.id, stage: 'consumed' }))
  },

  async card_approve(r) {
    const bridge = await r.bridge('bridge')
    const app = r.app('app')
    await r.hello(app)
    const card = buildCard(
      {
        id: uid('c_'),
        thread_id: 'general',
        title: 'Send the invoice to alex@example.com',
        expires_at: '2026-10-29T15:00:00.000Z',
      },
      new Date(r.clock.now()),
    )
    await r.bridgeSend(bridge, frame('card.create', { card }))
    r.note('a tap whose payload_hash is not the card’s is refused and the card stays pending')
    const wrong = await r.signed({
      ...frame('card.resolve'),
      card_id: card.id,
      action: 'primary',
      payload_hash: `sha256:${'0'.repeat(64)}`,
    })
    await r.appSend(app, wrong)
    r.note('the owner approves')
    const res = await r.signed({
      ...frame('card.resolve'),
      card_id: card.id,
      action: 'primary',
      payload_hash: payloadHash(bindingFrom(card)),
    })
    await r.appSend(app, res)
    r.note('bridge reports the card done')
    await r.bridgeSend(
      bridge,
      frame('card.update', {
        card_id: card.id,
        state: 'done',
        resolution: { action: 'primary', at: START_ISO, edited: false, payload_hash: payloadHash(bindingFrom(card)) },
      }),
    )
  },

  async card_second_tap(r) {
    const bridge = await r.bridge('bridge')
    const app = r.app('app')
    await r.hello(app)
    const card = buildCard(
      { id: uid('c_'), thread_id: 'general', title: 'Post the update', expires_at: '2026-10-29T15:00:00.000Z' },
      new Date(r.clock.now()),
    )
    await r.bridgeSend(bridge, frame('card.create', { card }))
    const hash = payloadHash(bindingFrom(card))
    for (const action of ['primary', 'kill']) {
      await r.appSend(app, await r.signed({ ...frame('card.resolve'), card_id: card.id, action, payload_hash: hash }))
    }
  },

  async bad_signature(r) {
    const other = await generateBridgeKey()
    // a Mac key the relay does not trust
    await r.bridge('stranger', { key: other })
    // the trusted key id with a signature over some other challenge
    await r.bridge('forger', { badSig: true })
    // the trusted key, still fine afterwards
    const bridge = await r.bridge('bridge')
    // An owner signature of the wrong SHAPE is refused by the relay's own schema, before anything is stored or forwarded.
    const app = r.app('app')
    await r.hello(app)
    const msg = await r.signed({
      ...frame('message'),
      thread_id: 'general',
      client_msg_id: uid('m_'),
      text: 'Tampered',
      attachments: [],
    })
    await r.appSend(app, { ...msg, osig: 'AAAA' })
    // A well-formed signature (86 base64url characters) that is not this frame's is the Mac's to refuse. The relay cannot
    // tell, so it queues the tap for the Mac and marks the card resolved...
    const card = buildCard(
      { id: uid('c_'), thread_id: 'general', title: 'Pay the invoice', expires_at: '2026-10-29T15:00:00.000Z' },
      new Date(r.clock.now()),
    )
    await r.bridgeSend(bridge, frame('card.create', { card }))
    const resolve = frame('card.resolve')
    const forged = {
      ...(await r.signed({
        ...resolve,
        card_id: card.id,
        action: 'primary',
        payload_hash: payloadHash(bindingFrom(card)),
      })),
      osig: 'A'.repeat(86),
    }
    await r.appSend(app, forged)
    r.note('the Mac refuses the signature: the card goes back to pending and the app is told')
    await r.bridgeSend(bridge, frame('error', { ref: resolve.id, code: 'sig_invalid', message: 'bad signature' }))
  },

  async wrong_device(r) {
    const bridge = await r.bridge('bridge')
    // a tab holding a different device key than its session
    const stale = r.app('stale-tab', { deviceId: 'd_otherdevice' })
    await r.hello(stale)
    // a session the Mac has not approved yet may not send messages
    const unpinned = r.app('unpinned', { pinned: false })
    await r.hello(unpinned)
    await r.appSend(unpinned, {
      ...(await r.signed({
        ...frame('message'),
        thread_id: 'general',
        client_msg_id: uid('m_'),
        text: 'Let me in',
        attachments: [],
      })),
    })
    // a session whose frame is signed by another pinned device's key: refused as unauthorized, never stored or forwarded
    const app = r.app('app')
    await r.hello(app)
    const other = await createDeviceKey()
    await r.appSend(
      app,
      await signOwnerFrame(
        {
          ...frame('message'),
          thread_id: 'general',
          client_msg_id: uid('m_'),
          text: 'Signed by someone else',
          attachments: [],
          device_id: other.deviceId,
        },
        other.privateKey,
      ),
    )
    const card = buildCard(
      { id: uid('c_'), thread_id: 'general', title: 'Post the update', expires_at: '2026-10-29T15:00:00.000Z' },
      new Date(r.clock.now()),
    )
    await r.bridgeSend(bridge, frame('card.create', { card }))
    await r.appSend(
      app,
      await signOwnerFrame(
        {
          ...frame('card.resolve'),
          card_id: card.id,
          action: 'primary',
          payload_hash: payloadHash(bindingFrom(card)),
          device_id: other.deviceId,
        },
        other.privateKey,
      ),
    )
  },

  // A card the owner must confirm with a fresh step-up: refused without a token and with one minted for another card, and
  // when it passes, the token is kept out of what is stored and forwarded to the Mac.
  async card_approve_high_risk(r) {
    const bridge = await r.bridge('bridge')
    const app = r.app('app')
    await r.hello(app)
    const card = buildCard(
      {
        id: uid('c_'),
        thread_id: 'general',
        title: 'Wire the deposit to alex@example.com',
        risk: 'high',
        expires_at: '2026-10-29T15:00:00.000Z',
      },
      new Date(r.clock.now()),
    )
    await r.bridgeSend(bridge, frame('card.create', { card }))
    const resolve = (extra: Record<string, unknown> = {}) =>
      r.signed({
        ...frame('card.resolve'),
        card_id: card.id,
        action: 'primary',
        payload_hash: payloadHash(bindingFrom(card)),
        ...extra,
      })
    r.note('no step-up token')
    await r.appSend(app, await resolve())
    r.note('a token minted for another card')
    await r.appSend(app, await resolve({ stepup_token: r.relay.mintStepup('card:c_someothercard') }))
    r.note('the right token')
    await r.appSend(app, await resolve({ stepup_token: r.relay.mintStepup(`card:${card.id}`) }))
  },

  // The app re-signs a message it was not sure arrived: a NEW frame id, the same client_msg_id. And the very same frame
  // arriving twice. Both are acked with the first seq and stored once.
  async message_retry(r) {
    const bridge = await r.bridge('bridge')
    const app = r.app('app')
    await r.hello(app)
    const fields = { thread_id: 'general', client_msg_id: uid('m_'), text: 'Please send this once', attachments: [] }
    const first = await r.signed({ ...frame('message'), ...fields })
    await r.appSend(app, first)
    r.note('the same message signed again under a new frame id')
    await r.appSend(app, await r.signed({ ...frame('message'), ...fields }))
    r.note('the very same frame again')
    await r.appSend(app, first)
    void bridge
  },

  // The same card.resolve frame arriving twice (the app's retry after a lost ack): acked again, not refused as a second tap.
  async card_resolve_resend(r) {
    const bridge = await r.bridge('bridge')
    const app = r.app('app')
    await r.hello(app)
    const card = buildCard(
      { id: uid('c_'), thread_id: 'general', title: 'Post the update', expires_at: '2026-10-29T15:00:00.000Z' },
      new Date(r.clock.now()),
    )
    await r.bridgeSend(bridge, frame('card.create', { card }))
    const res = await r.signed({
      ...frame('card.resolve'),
      card_id: card.id,
      action: 'primary',
      payload_hash: payloadHash(bindingFrom(card)),
    })
    await r.appSend(app, res)
    r.note('the same frame again')
    await r.appSend(app, res)
  },

  async unknown_frame(r) {
    const bridge = await r.bridge('bridge')
    const app = r.app('app')
    await r.hello(app)
    await r.appSend(app, frame('no.such.frame', { x: 1 }))
    await r.appSend(app, 'this is not json')
    await r.bridgeSend(bridge, frame('no.such.frame', { x: 1 }))
  },

  async reconnect(r) {
    const bridge = await r.bridge('bridge')
    const app = r.app('app')
    await r.hello(app)
    await r.bridgeSend(bridge, reply('Good morning Alex'))
    app.at.onClose()
    r.note('app is away; the agent posts twice')
    for (const n of [1, 2]) {
      const card = buildCard(
        { id: uid('c_'), thread_id: 'general', title: `Missed ${n}`, expires_at: '2026-10-29T15:00:00.000Z' },
        new Date(r.clock.now()),
      )
      await r.bridgeSend(bridge, frame('card.create', { card }))
    }
    const back = r.app('app-back')
    await r.hello(back, { last_seq: 1 })
    r.note('the Mac drops and comes back')
    bridge.at.onClose()
    await r.bridge('bridge-2')
  },
}

const golden: Record<string, unknown> = JSON.parse(readGolden('hub') ?? '{}')
const update = goldenMode() === 'update'

describe('hub replay', () => {
  for (const [name, run] of Object.entries(sequences)) {
    it(name, async () => {
      rp = await startReplay()
      await run(rp)
      const got = JSON.parse(JSON.stringify(rp.finish()))
      results[name] = got
      if (!update) expect(got).toEqual(golden[name])
    })
  }
  afterAll(() => {
    if (update) saveGolden('hub', results)
  })
})
