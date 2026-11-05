// @vitest-environment node
// A card approval on the real socket client against FakeRelay, when it is refused or never answered. `card.resolve` is
// never queued or resent, so each of these must reject once, at once, and leave the card as it was.
import type { CardT } from '@talos-app/protocol'
import { buildCard, FakeRelay, mkFrame, waitFor } from '@talos-app/testkit'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { NoAnswerError, NotSentError, TalosClientError } from '../src/lib/client.ts'
import { createSocketClient, type SocketClient } from '../src/lib/socketClient.ts'
import { createMemoryStorage } from '../src/lib/storage.ts'

let relay: FakeRelay
let client: SocketClient
let card: CardT

beforeEach(async () => {
  relay = await new FakeRelay().start()
  client = createSocketClient({
    storage: createMemoryStorage(),
    wsUrl: `${relay.wsBase}/ws`,
    backoff: { baseMs: 20, maxMs: 40 },
    isOnline: () => true,
  })
  card = buildCard({ thread_id: 'general' })
})
afterEach(async () => {
  vi.useRealTimers()
  client.close()
  await relay.stop()
})

async function online() {
  await client.ensureDevice()
  await client.start({ pinned: true })
  await waitFor(() => client.store.getState().connection === 'online', 4000, 'online')
  relay.sendToApps(mkFrame('card.create', { card }))
  await waitFor(() => client.store.getState().cards.length === 1, 2000, 'card')
}

const resolveFrames = () => relay.frames.filter((f) => f.direction === 'from_app' && f.raw.type === 'card.resolve')

/** Starts an approval whose answer the test controls: the relay's ack is held back, so only what the test sends settles it. */
async function approve(heldTimers = false) {
  relay.swallowAcks = true
  const outcome = client.resolveCard(card.id, { action: 'primary', payloadHash: card.payload_hash }).then(
    () => null,
    (e: unknown) => e,
  )
  // waitFor runs on setTimeout, which a test holding the client's timers back has stopped: yield to the sockets instead
  if (heldTimers)
    for (let i = 0; i < 5000 && resolveFrames().length === 0; i++) await new Promise((r) => setImmediate(r))
  else await waitFor(() => resolveFrames().length === 1, 2000, 'card.resolve sent')
  expect(resolveFrames()).toHaveLength(1)
  return { outcome, id: resolveFrames()[0]?.raw.id as string }
}

const stillPending = () => expect(client.store.getState().cards.find((c) => c.id === card.id)?.state).toBe('pending')

describe('a refused card approval', () => {
  it.each([
    ['card_hash_mismatch', 'the card changed since it was rendered'],
    ['card_not_pending', 'card is done'],
    ['card_expired', 'card expired'],
    ['mac_offline', 'Your Mac is offline.'],
  ] as const)('%s from the relay rejects with that code and message, once', async (code, message) => {
    await online()
    const { outcome, id } = await approve()
    relay.sendToApps(mkFrame('error', { ref: id, code, message }))
    const err = await outcome
    expect(err).toBeInstanceOf(TalosClientError)
    expect((err as TalosClientError).code).toBe(code)
    expect((err as TalosClientError).message).toBe(message)
    // the relay answered, so it is neither "sent, no answer" nor "never sent": its own words say what happened
    expect(err).not.toBeInstanceOf(NoAnswerError)
    expect(err).not.toBeInstanceOf(NotSentError)
    stillPending()
    expect(resolveFrames()).toHaveLength(1)
    // nothing was put in the thread for the owner to read as a message, and the device is still trusted
    expect(client.store.getState().messages.general ?? []).toEqual([])
    expect(client.store.getState().devicePinned).toBe(true)
  })

  it('a late answer to an approval that already failed changes nothing', async () => {
    await online()
    const { outcome, id } = await approve()
    relay.sendToApps(mkFrame('error', { ref: id, code: 'card_expired', message: 'card expired' }))
    await outcome
    relay.sendToApps(mkFrame('ack', { ref: id, seq: 99 }))
    relay.sendToApps(mkFrame('error', { ref: id, code: 'mac_offline', message: 'Your Mac is offline.' }))
    await new Promise((r) => setTimeout(r, 50))
    stillPending()
    expect(client.store.getState().connection).toBe('online')
  })
})

describe('an approval nobody answers', () => {
  it('gives up with "did not answer" once the wait ends, and never sends it again', async () => {
    await online()
    // only the client's timers are held back; the sockets stay real
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const { outcome } = await approve(true)
    let settled = false
    void outcome.then(() => {
      settled = true
    })
    await vi.advanceTimersByTimeAsync(1000)
    expect(settled).toBe(false) // it is still waiting, not failed early
    // run on to the first timer that settles it; the wait is whatever the client holds, not a number this test knows
    for (let i = 0; i < 60 && !settled; i++) await vi.advanceTimersByTimeAsync(1000)
    const err = await outcome
    expect(err).toBeInstanceOf(TalosClientError)
    expect((err as TalosClientError).code).toBe('internal')
    expect((err as TalosClientError).message).toBe('The relay did not answer.')
    expect(err).toBeInstanceOf(NoAnswerError) // it left the phone; whether it ran is unknown
    stillPending()
    vi.useRealTimers()
    await new Promise((r) => setTimeout(r, 50))
    expect(resolveFrames()).toHaveLength(1)
  })
})

describe('an approval cut off by the connection', () => {
  it('a socket that drops mid-resolve rejects with "Connection lost" and the card is not resent after the reconnect', async () => {
    await online()
    const { outcome } = await approve()
    relay.dropApps()
    const err = await outcome
    expect(err).toBeInstanceOf(TalosClientError)
    expect((err as TalosClientError).code).toBe('internal')
    expect((err as TalosClientError).message).toBe('Connection lost')
    expect(err).toBeInstanceOf(NoAnswerError)
    relay.swallowAcks = false
    await waitFor(() => client.store.getState().connection === 'online', 4000, 'back online')
    await new Promise((r) => setTimeout(r, 100))
    expect(resolveFrames()).toHaveLength(1)
  })

  it('close() while it is in flight rejects it as sent with no answer', async () => {
    await online()
    const { outcome } = await approve()
    client.close()
    const err = await outcome
    expect((err as TalosClientError).message).toBe('Closed')
    expect(err).toBeInstanceOf(NoAnswerError)
  })

  it('while the socket is down, an approval fails at once as offline and sends nothing', async () => {
    await online()
    // keep the client from reconnecting so the gap stays open
    client.close()
    const err = await client.resolveCard(card.id, { action: 'primary', payloadHash: card.payload_hash }).catch((e) => e)
    expect(err).toBeInstanceOf(TalosClientError)
    expect((err as TalosClientError).code).toBe('internal')
    expect((err as TalosClientError).message).toBe("You're offline.")
    expect(err).toBeInstanceOf(NotSentError) // it never left the phone
    expect(resolveFrames()).toHaveLength(0)
  })

  it('before the device is pinned, an approval says it is waiting for the Mac and sends nothing', async () => {
    await client.ensureDevice()
    await client.start({ pinned: false })
    await waitFor(() => client.store.getState().connection === 'online', 4000, 'online')
    const err = await client.resolveCard(card.id, { action: 'primary', payloadHash: card.payload_hash }).catch((e) => e)
    expect((err as TalosClientError).code).toBe('device_not_pinned')
    expect(err).toBeInstanceOf(NotSentError)
    expect(resolveFrames()).toHaveLength(0)
  })
})

describe('a card the relay leaves out of ready', () => {
  // The relay moves a card to resolved when it stores a decision and sends no card.update then, so a card missing from
  // `open_cards` may be decided, not expired. It is only called expired once its own time has passed.
  const cardState = () => client.store.getState().cards.find((c) => c.id === card.id)?.state
  const reconnect = async () => {
    relay.dropApps()
    await waitFor(() => client.store.getState().connection !== 'online', 2000, 'dropped')
    await waitFor(() => client.store.getState().connection === 'online', 4000, 'back online')
  }

  it('is left exactly as it was while it is not past expires_at', async () => {
    await online()
    const before = client.store.getState().cards.find((c) => c.id === card.id)
    await reconnect()
    expect(client.store.getState().readySeq).toBeGreaterThanOrEqual(2) // the second ready did not list it
    expect(client.store.getState().cards.find((c) => c.id === card.id)).toEqual(before)
  })

  it('does flip to expired once it is past expires_at', async () => {
    card = buildCard({ thread_id: 'general', expires_at: new Date(Date.now() - 60_000).toISOString() })
    await online()
    await reconnect()
    expect(cardState()).toBe('expired')
  })

  it('approved on another device during the reconnect: stays until the Mac reports, and a retry is told it is decided', async () => {
    await online()
    await reconnect()
    expect(cardState()).toBe('pending')
    const { outcome, id } = await approve()
    relay.sendToApps(mkFrame('error', { ref: id, code: 'card_not_pending', message: 'card is resolved' }))
    expect(((await outcome) as TalosClientError).code).toBe('card_not_pending')
    expect(cardState()).toBe('pending')
    relay.sendToApps(mkFrame('card.update', { card_id: card.id, state: 'done' }))
    await waitFor(() => cardState() === 'done', 2000, 'Mac reported')
  })
})
