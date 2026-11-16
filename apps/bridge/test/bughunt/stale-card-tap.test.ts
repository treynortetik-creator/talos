// Bug hunt 2026-11-10 #2, the Mac's half: a card tap signed more than 2 min ahead of the Mac's clock is refused as
// `stale`. The refusal must leave the card pending on the Mac, say whose clock is off and by how much, and (through the
// relay's rule, played here by the FakeRelay) put the card back in front of every device so a second tap works.
import { afterEach, describe, expect, test } from 'bun:test'
import type { CardT } from '@talos-app/protocol'
import { CLOCK_OFF_MESSAGE, clockOffMessage } from '../../src/inbound-shared.ts'
import { type Harness, startHarness } from '../helpers.ts'

let h: Harness
afterEach(async () => h?.stop())

async function makeCard(): Promise<CardT> {
  const res = await h.bridge.callTool('card', {
    thread_id: 'general',
    kind: 'decision',
    title: 'Ship it?',
    primary_label: 'Ship',
    kill_label: 'Hold',
    risk: 'low',
    origin: 'chat',
    body: 'Ready to go.',
  })
  expect(res.isError, res.content[0]?.text).toBeFalsy()
  const id = /card (c_[0-9A-HJKMNP-TV-Z]{26})/.exec(res.content[0]?.text ?? '')?.[1]
  return (await h.relay.expectFrame('card.create', (f) => f.card.id === id, { direction: 'from_bridge' })).card
}

describe('bug hunt #2: a card tap from a phone whose clock is ahead', () => {
  test('the Mac keeps the card pending, the tapper is told its clock is 3 min fast, every device sees the card again, and a good tap then resolves it', async () => {
    h = await startHarness()
    const card = await makeCard()
    const ahead = await h.app.resolveCard(card, 'primary', card.payload_hash, {
      ts: new Date(Date.now() + 3 * 60_000).toISOString(),
    })
    const err = await h.app.expectFrame('error', (f) => f.ref === ahead.id)
    expect(err.code).toBe('stale')
    expect(err.message).toBe(
      "This device's clock is about 3 min fast. Set it to automatic date and time, then try again.",
    )
    expect(h.bridge.ctx.ledger.get(card.id)?.state).toBe('pending')
    // the relay reopens the card for every device (it had marked it resolved when it queued the tap)
    const reopened = await h.app.expectFrame('card.update', (f) => f.card_id === card.id && f.state === 'pending')
    expect(reopened.reason).toBe('resolve_rejected')
    // nothing reached the agent
    expect(h.notes.filter((n) => n.meta.kind === 'card_action')).toEqual([])

    await h.app.resolveCard(card, 'primary', card.payload_hash)
    const done = await h.relay.expectFrame('card.update', (f) => f.card_id === card.id && f.state === 'resolved', {
      direction: 'from_bridge',
    })
    expect(done.resolution?.action).toBe('primary')
    expect(h.bridge.ctx.ledger.get(card.id)?.state).toBe('resolved')
  })
})

describe('clockOffMessage: whose clock, and by how much', () => {
  const now = Date.parse('2026-11-10T12:00:00Z')
  const fix = 'Set it to automatic date and time, then try again.'

  test('the phone is ahead of the relay too: the phone is named, with the minutes', () => {
    expect(clockOffMessage(now + 7 * 60_000, now, now + 2_000)).toBe(`This device's clock is about 7 min fast. ${fix}`)
  })
  test('the phone agrees with the relay and only the Mac differs: the Mac is named, not the phone', () => {
    const msg = clockOffMessage(now + 5 * 60_000, now, now + 5 * 60_000 + 800)
    expect(msg).toBe("Your Mac's clock is about 5 min slow. Set the Mac to automatic date and time, then try again.")
  })
  test('no relay stamp to compare with: only the difference is stated, and neither clock is blamed', () => {
    expect(clockOffMessage(now + 4 * 60_000, now, undefined)).toBe(
      "This device's clock is about 4 min ahead of your Mac's. Set both to automatic date and time, then try again.",
    )
    expect(clockOffMessage(now + 4 * 60_000, now, Number.NaN)).toContain("ahead of your Mac's")
  })
  test('a frame that is too old (a queued tap, a replay, a clock far behind) gets the plain message: no number is guessed', () => {
    expect(clockOffMessage(now - 9 * 86_400_000, now, now)).toBe(CLOCK_OFF_MESSAGE)
    expect(clockOffMessage(Number.NaN, now, now)).toBe(CLOCK_OFF_MESSAGE)
  })
  test('an absurd skew still reads as a plain number of minutes or hours, never NaN or a negative', () => {
    expect(clockOffMessage(now + 3 * 3600_000, now, now)).toBe(`This device's clock is about 3 h fast. ${fix}`)
    expect(clockOffMessage(now + 121_000, now, now)).toContain('about 2 min fast')
  })
})
