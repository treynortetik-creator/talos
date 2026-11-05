// Records what the bridge's inbound pipeline does today for the owner's main journeys: every frame the bridge sends,
// every notification the agent would see, and the Mac's own state after. Each sequence is compared to
// golden/inbound.golden.json. Rewrite it on purpose with UPDATE_GOLDEN=1.
import { afterAll, afterEach, describe, expect, test } from 'bun:test'
import { createDeviceKey, signOwnerFrame } from '@talos-app/protocol'
import { permissionFixture } from '@talos-app/testkit'
import { goldenMode, type Replay, readGolden, saveGolden, startReplay } from './replay-harness.ts'

let rp: Replay | null = null
afterEach(async () => {
  await rp?.stop()
  rp = null
})

const cardArgs = (title: string) => ({
  thread_id: 'general',
  kind: 'message',
  title,
  primary_label: 'Send',
  kill_label: 'Kill draft',
  risk: 'low',
  origin: 'chat',
  destination: [{ label: 'To', value: 'alex@example.com' }],
  body: 'Draft body',
  fields: [{ key: 'subject', label: 'Subject', value: 'Update', editable: true }],
})

async function makeCard(r: Replay, title: string) {
  const res = await r.h.bridge.callTool('card', cardArgs(title))
  if (res.isError) throw new Error(res.content[0]?.text)
  const id = /card (c_[0-9A-HJKMNP-TV-Z]{26})/.exec(res.content[0]?.text ?? '')?.[1]
  const f = await r.h.relay.expectFrame('card.create', (x) => x.card.id === id, { direction: 'from_bridge' })
  return f.card
}

const message = (r: Replay, text: string, extra: Record<string, unknown> = {}) =>
  r.frame('message', { thread_id: 'general', client_msg_id: `m_${r.frame('x').id}`, text, attachments: [], ...extra })

/** A well-formed hash that no card has. */
const WRONG_HASH = `sha256:${'0'.repeat(64)}`

const resolve = (r: Replay, card: { id: string; payload_hash: string }, action: 'primary' | 'kill') =>
  r.frame('card.resolve', { card_id: card.id, action, payload_hash: card.payload_hash })

async function until(cond: () => boolean) {
  for (let i = 0; i < 100_000 && !cond(); i++) await new Promise<void>((res) => setImmediate(res))
  if (!cond()) throw new Error('condition never became true')
}

const sequences: Record<string, (r: Replay) => Promise<void>> = {
  async owner_message(r) {
    await r.pushSigned(message(r, 'Hello from Alex Example'))
    await r.settle()
  },

  async card_approve(r) {
    const card = await makeCard(r, 'Send the invoice to alex@example.com')
    await r.settle()
    r.note('a tap whose payload_hash is not the card’s is refused and the card stays pending')
    await r.pushSigned(resolve(r, { id: card.id, payload_hash: WRONG_HASH }, 'primary'))
    await r.settle()
    r.note('the owner approves')
    await r.pushSigned(resolve(r, card, 'primary'))
    await r.settle()
  },

  async card_second_tap(r) {
    const card = await makeCard(r, 'Post the update')
    await r.settle()
    await r.pushSigned(resolve(r, card, 'primary'))
    await r.settle()
    r.note('a second tap on the same card, past the relay')
    await r.pushSigned(resolve(r, card, 'kill'))
    await r.settle()
  },

  async bad_signature(r) {
    const good = await r.h.app.sign(message(r, 'Tampered'))
    r.note('a signature that is the right shape but not this message')
    r.push({ ...good, osig: `${String(good.osig).slice(0, -4)}AAAA` })
    await r.settle()
    r.note('the same frame with the signature missing')
    const { osig: _drop, ...unsigned } = await r.h.app.sign(message(r, 'Unsigned'))
    r.push(unsigned)
    await r.settle()
    r.note('a good message still goes through afterwards')
    await r.pushSigned(message(r, 'Fine'))
    await r.settle()
  },

  async wrong_device(r) {
    r.note('a device key the Mac never pinned signs a message')
    const stranger = await createDeviceKey()
    r.push(await signOwnerFrame({ ...message(r, 'Let me in'), device_id: stranger.deviceId }, stranger.privateKey))
    await r.settle()
    r.note('the pinned device is unaffected')
    await r.pushSigned(message(r, 'Still me'))
    await r.settle()
  },

  async duplicate_delivery(r) {
    const sent = await r.pushSigned(message(r, 'Only once please'))
    await r.settle()
    r.note('the relay delivers the very same frame again')
    r.push(sent)
    await r.settle()
  },

  // A retry the app signs again under a NEW frame id, with the same client_msg_id (what socketClient does when it re-sends).
  // The frame-id check on receipt cannot catch it; only the client_msg_id check can.
  async message_retry(r) {
    const first = message(r, 'Please send this once')
    await r.pushSigned(first)
    await r.settle()
    r.note('the app signs the same message again under a new frame id')
    await r.pushSigned({ ...first, id: r.frame('x').id })
    await r.settle()
  },

  async stale_timestamp(r) {
    r.note('a validly signed message dated nine days ago')
    await r.pushSigned(message(r, 'Too old', { ts: '2026-10-19T15:00:00.000Z' }))
    await r.settle()
    r.note('a validly signed message dated ten minutes ahead of the Mac clock')
    await r.pushSigned(message(r, 'From the future', { ts: '2026-10-28T15:10:00.000Z' }))
    await r.settle()
    r.note('a message inside the window still goes through')
    await r.pushSigned(message(r, 'On time'))
    await r.settle()
  },

  async permission_card_precheck(r) {
    // A prompt whose input is partly hidden gets a card with no Allow. A PRIMARY forged past the relay must be refused
    // before the ledger moves, so the card stays pending.
    await r.h.bridge.ctx.permission.onRequest(permissionFixture('elided').params)
    const created = await r.h.relay.expectFrame('card.create', (x) => x.card.kind === 'permission', {
      direction: 'from_bridge',
    })
    await r.settle()
    r.note('a forged Allow on a card that cannot allow')
    await r.pushSigned(resolve(r, created.card, 'primary'))
    await r.settle()
  },

  async unknown_frame(r) {
    r.push(r.frame('no.such.frame', { x: 1 }), { durable: false })
    await r.settle()
    r.push({ v: 1, type: 'message', id: 'not-an-id' }, { durable: false })
    await r.settle()
  },

  async reconnect(r) {
    await r.pushSigned(message(r, 'Before the drop'))
    await r.settle()
    r.note('the Mac socket drops; a message arrives while it is gone')
    r.h.relay.dropBridge()
    await until(() => r.h.bridge.client?.connected === false)
    await r.pushSigned(message(r, 'While you were away'))
    r.clock.advance(5000) // past the first reconnect backoff
    await until(() => r.h.relay.bridgeConnected)
    await r.settle()
    r.note('back online: the relay replays what was not consumed, and nothing runs twice')
    await r.settle()
  },
}

const golden: Record<string, unknown> = JSON.parse(readGolden('inbound') ?? '{}')
const update = goldenMode() === 'update'
const results: Record<string, unknown> = {}

describe('inbound replay', () => {
  for (const [name, play] of Object.entries(sequences)) {
    test(name, async () => {
      rp = await startReplay({ permissionRelay: name === 'permission_card_precheck' })
      await play(rp)
      const got = JSON.parse(JSON.stringify(rp.finish()))
      results[name] = got
      if (!update) expect(got).toEqual(golden[name] as never)
    }, 30_000)
  }
  afterAll(() => {
    if (update) saveGolden('inbound', results)
  })
})
