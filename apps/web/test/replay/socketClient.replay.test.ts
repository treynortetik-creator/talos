// @vitest-environment node
// Records what the web socket client does today for the owner's main journeys: every frame it sends, in order, and the
// state it ends in. Each sequence is compared to golden/socketClient.golden.json. Rewrite it on purpose with UPDATE_GOLDEN=1.
import { bindingFrom, ORIGINAL_TS_FEATURE, payloadHash } from '@talos-app/protocol'
import { buildCard } from '@talos-app/testkit'
import { afterAll, afterEach, describe, expect, it } from 'vitest'
import {
  goldenMode,
  type Run,
  readGolden,
  readyFrame,
  START_ISO,
  saveGolden,
  srv,
  startRun,
  uid,
} from './replay-harness.ts'

let run: Run | null = null
afterEach(() => {
  run?.stop()
  run = null
})

const results: Record<string, unknown> = {}

const sentFrames = (r: Run, type: string) =>
  r.sockets.log
    .filter((s) => s.dir === 'app->relay' && (s.frame as { type?: string }).type === type)
    .map((s) => s.frame as Record<string, unknown>)

const card = (n: number) =>
  buildCard(
    {
      id: uid('c_'),
      thread_id: 'general',
      title: `Send the invoice to alex@example.com (${n})`,
      expires_at: '2026-10-29T15:00:00.000Z',
    },
    new Date(START_ISO),
  )

async function online(r: Run, extra: Record<string, unknown> = {}) {
  r.sock().receive(readyFrame(extra))
  await r.settle()
}

const sequences: Record<string, (r: Run) => Promise<void>> = {
  async owner_message(r) {
    await online(r)
    const sent = r.client.sendMessage({ threadId: 'general', text: 'Hello from Alex Example' })
    await r.settle()
    const msg = sentFrames(r, 'message')[0] as { id: string; client_msg_id: string }
    r.sock().receive(srv('ack', { ref: msg.id, seq: 1 }))
    r.sock().receive(
      srv('message.stored', {
        client_msg_id: msg.client_msg_id,
        message: {
          id: msg.client_msg_id,
          thread_id: 'general',
          seq: 1,
          author: 'owner',
          kind: 'text',
          text: 'Hello from Alex Example',
          format: 'plain',
          attachments: [],
          via: 'app',
          created_at: START_ISO,
        },
      }),
    )
    await sent
    await r.settle()
    r.note('the agent answers')
    r.sock().receive(
      srv('reply', {
        message: {
          id: uid('m_'),
          thread_id: 'general',
          seq: 2,
          author: 'agent',
          kind: 'text',
          text: 'Good morning Alex',
          format: 'plain',
          attachments: [],
          via: 'app',
          created_at: START_ISO,
        },
      }),
    )
    await r.settle()
  },

  async card_approve(r) {
    await online(r)
    const c = card(1)
    r.sock().receive(srv('card.create', { card: c, relay: { seq: 1 } }))
    await r.settle()
    const done = r.client.resolveCard(c.id, { action: 'primary', payloadHash: payloadHash(bindingFrom(c)) })
    await r.settle()
    const res = sentFrames(r, 'card.resolve')[0] as { id: string }
    r.sock().receive(srv('ack', { ref: res.id }))
    await done
    r.sock().receive(
      srv('card.update', {
        card_id: c.id,
        state: 'done',
        resolution: { action: 'primary', at: START_ISO, edited: false, payload_hash: payloadHash(bindingFrom(c)) },
        relay: { seq: 2 },
      }),
    )
    await r.settle()
  },

  async card_second_tap(r) {
    await online(r)
    const c = card(2)
    r.sock().receive(srv('card.create', { card: c, relay: { seq: 1 } }))
    await r.settle()
    const hash = payloadHash(bindingFrom(c))
    const first = r.client.resolveCard(c.id, { action: 'primary', payloadHash: hash })
    await r.settle()
    const res = sentFrames(r, 'card.resolve')[0] as { id: string }
    r.sock().receive(srv('ack', { ref: res.id }))
    await first
    r.note('second tap on the same card')
    const second = r.client.resolveCard(c.id, { action: 'kill', payloadHash: hash }).then(
      () => 'resolved',
      (e: { code?: string }) => `rejected ${e.code ?? 'error'}`,
    )
    await r.settle()
    const again = sentFrames(r, 'card.resolve')[1] as { id: string } | undefined
    if (again) r.sock().receive(srv('error', { ref: again.id, code: 'card_not_pending', message: 'card is resolved' }))
    r.note(`second tap outcome: ${await second}`)
    await r.settle()
  },

  async bad_signature(r) {
    await online(r)
    r.note('a frame that fails the protocol schema is dropped')
    r.sock().receive({ ...srv('message.stored'), message: 'not a message' })
    r.sock().receive(srv('ack', { ref: 'not-an-id' }))
    await r.settle()
    r.note('the Mac refuses a message still held in the queue: it is kept with a retry')
    const kept = r.client.sendMessage({ threadId: 'general', text: 'Signed wrong' }).then(
      (m) => m.state,
      (e: { code?: string }) => `rejected ${e.code ?? 'error'}`,
    )
    await r.settle()
    const msg = sentFrames(r, 'message')[0] as { id: string }
    r.sock().receive(srv('error', { ref: msg.id, code: 'sig_invalid', message: 'signature does not verify' }))
    await r.settle()
    r.note('the Mac refuses a card tap that is not held anywhere: the owner is told it was dropped')
    const c = card(4)
    r.sock().receive(srv('card.create', { card: c, relay: { seq: 1 } }))
    await r.settle()
    const tap = r.client.resolveCard(c.id, { action: 'primary', payloadHash: payloadHash(bindingFrom(c)) }).then(
      () => 'resolved',
      (e: { code?: string }) => `rejected ${e.code ?? 'error'}`,
    )
    await r.settle()
    const res = sentFrames(r, 'card.resolve')[0] as { id: string }
    r.sock().receive(srv('error', { ref: res.id, code: 'sig_invalid', message: 'signature does not verify' }))
    r.note(`card tap outcome: ${await tap}`)
    r.note('an error for a frame this client never sent is dropped the same way')
    r.sock().receive(srv('error', { ref: uid(), code: 'sig_invalid', message: 'signature does not verify' }))
    await r.settle()
    r.note(`held message outcome so far: ${await Promise.race([kept, 'still waiting'])}`)
    r.note('the relay refuses the signature on the next sign-in: close 4401')
    r.sock().drop(4401, 'bad signature')
    await r.settle()
    await r.advance(60_000)
  },

  async wrong_device(r) {
    await online(r)
    r.note('another tab replaced this device key')
    r.sock().drop(4401, 'device_changed')
    await r.settle()
    await r.advance(60_000)
    r.note('a send while the relay does not know this device')
    const sent = await r.client.sendMessage({ threadId: 'general', text: 'Let me in' })
    r.note(`send result: ${sent.state}`)
    await r.settle()
  },

  // The client starts out believing the device is pinned. Only the relay's error can tell it otherwise.
  async wrong_device_not_pinned(r) {
    await online(r)
    r.note('the relay says the Mac has not approved this device')
    r.sock().receive(srv('error', { code: 'device_not_pinned', message: 'this device is not pinned by your Mac yet' }))
    await r.settle()
    r.note('a send now waits for the Mac')
    const sent = await r.client.sendMessage({ threadId: 'general', text: 'Is anyone there' })
    r.note(`send result: ${sent.state}`)
    await r.settle()
  },

  // The same refusal, but tied to a message the client holds: the device is marked unpinned and the message is not failed.
  async device_not_pinned_held(r) {
    await online(r)
    void r.client.sendMessage({ threadId: 'general', text: 'Sent before the Mac said no' }).catch(() => {})
    await r.settle()
    const msg = sentFrames(r, 'message')[0] as { id: string }
    r.sock().receive(srv('error', { ref: msg.id, code: 'device_not_pinned', message: 'this device is not pinned yet' }))
    await r.settle()
  },

  // A message that waited past six days in the queue is signed again before it goes out: a new frame id and time, the
  // same client message id, and the first writing time carried along for a Mac that lists the feature.
  async message_resign(r) {
    const features = { bridge_online: true, last_seen: START_ISO, queue_depth: 0, features: [ORIGINAL_TS_FEATURE] }
    await online(r, { presence: features })
    r.note('the link drops and a message is written while offline')
    r.sock().drop(1006)
    await r.settle()
    const sent = r.client.sendMessage({ threadId: 'general', text: 'Written on the plane' }).catch(() => null)
    await r.settle()
    const clientMsgId = (r.client.store.getState().messages.general ?? [])[0]?.id
    r.note('the phone sleeps for seven days')
    r.jumpTo('2026-11-04T15:00:00.000Z')
    await r.advance(5000)
    r.note('back online: the queued message is signed again before it is sent')
    await online(r, { presence: features })
    const out = sentFrames(r, 'message')
    if (out.length !== 1) throw new Error(`expected one message frame on the wire, got ${out.length}`)
    const again = out[0] as { client_msg_id: string; ts: string; original_ts?: string }
    expect(again.client_msg_id).toBe(clientMsgId)
    expect(Date.parse(again.ts) - Date.parse(START_ISO)).toBeGreaterThan(6 * 24 * 3600_000) // a new signing time
    expect(again.original_ts).toBe(START_ISO)
    r.sock().receive(srv('ack', { ref: (out[0] as { id: string }).id, seq: 1 }))
    await sent
    await r.settle()
  },

  async unknown_frame(r) {
    await online(r)
    r.sock().receive(srv('no.such.frame', { x: 1 }))
    r.sock().receive('this is not json')
    r.sock().receive(srv('ping', { nonce: 'abcd1234' }))
    await r.settle()
  },

  async reconnect(r) {
    await online(r)
    const first = r.client.sendMessage({ threadId: 'general', text: 'Sent just before the link dropped' })
    await r.settle()
    r.note('the link drops before the ack')
    r.sock().drop(1006)
    await r.settle()
    await r.advance(5000)
    r.note('back online with a catch-up')
    const c = card(3)
    await online(r, { server_seq: 3, open_cards: [c] })
    r.sock().receive(srv('catchup.batch', { from_seq: 1, to_seq: 3, frames: [], more: false }))
    await r.settle()
    const msg = sentFrames(r, 'message')[0] as { id: string; client_msg_id: string }
    r.sock().receive(srv('ack', { ref: msg.id, seq: 3 }))
    await first
    await r.settle()
  },
}

const golden: Record<string, unknown> = JSON.parse(readGolden('socketClient') ?? '{}')
const update = goldenMode() === 'update'

describe('socket client replay', () => {
  for (const [name, play] of Object.entries(sequences)) {
    it(name, async () => {
      run = await startRun()
      await play(run)
      const got = JSON.parse(JSON.stringify(await run.finish()))
      results[name] = got
      if (!update) expect(got).toEqual(golden[name])
    })
  }
  afterAll(() => {
    if (update) saveGolden('socketClient', results)
  })
})
