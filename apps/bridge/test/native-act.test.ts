// Reply / Approve from a notification, on the Mac: the real Bridge and Inbound behind the testkit's FakeRelay.
// The relay is not trusted, so every check here is re-done from what the phone signed and this Mac pinned.
import { afterEach, describe, expect, test } from 'bun:test'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import {
  type ActBodyT,
  type CardT,
  cardNotice,
  composePermissionCard,
  createDeviceKey,
  createPhoneKeys,
  newUlid,
  shownHash,
  signNativeAct,
  signNativeGrant,
} from '@talos-app/protocol'
import { eventually, type Harness, sleep, startHarness } from './helpers.ts'

let h: Harness
afterEach(async () => h?.stop())

type Keys = Awaited<ReturnType<typeof createPhoneKeys>>

async function phone(deviceId: string, devicePrivateKey: CryptoKey, nowMs = Date.now()) {
  const keys = await createPhoneKeys()
  const grant = await signNativeGrant({ deviceId, devicePrivateKey, encPub: keys.encPub, actPub: keys.actPub, nowMs })
  return { keys, grant }
}

/** A tap as the relay would hand it to the Mac: signed at `signedAt`, stamped by the relay at `receivedAt`. */
async function tap(
  p: { keys: Keys; grant: Record<string, unknown> & { osig: string } },
  deviceId: string,
  body: ActBodyT,
  signedAt: number,
  receivedAt: number | null,
) {
  const id = newUlid()
  const frame = await signNativeAct({
    deviceId,
    id,
    ts: new Date(signedAt).toISOString(),
    grant: p.grant,
    body,
    actPrivateKey: p.keys.act.privateKey,
  })
  return receivedAt === null ? frame : { ...frame, relay: { seq: 1, received_at: new Date(receivedAt).toISOString() } }
}

const errorFor = async (id: string) =>
  await h.relay.expectFrame('error', (f) => f.ref === id, { direction: 'from_bridge' })

async function makeCard(extra: Record<string, unknown> = {}): Promise<CardT> {
  const res = await h.bridge.callTool('card', {
    thread_id: 'general',
    kind: 'generic',
    title: 'Archive old drafts',
    summary: 'Moves 12 drafts',
    primary_label: 'Archive',
    kill_label: 'Kill archive',
    risk: 'low',
    origin: 'chat',
    body: 'Folder: Drafts',
    ...extra,
  })
  expect(res.isError, res.content[0]?.text).toBeFalsy()
  const id = /card (c_[0-9A-HJKMNP-TV-Z]{26})/.exec(res.content[0]?.text ?? '')?.[1]
  return (await h.relay.expectFrame('card.create', (f) => f.card.id === id, { direction: 'from_bridge' })).card
}

const HOUR = 3_600_000

describe('a Reply tapped while the Mac slept', () => {
  test('is taken when the Mac wakes an hour later, judged at the moment the relay queued it', async () => {
    h = await startHarness()
    const dev = h.app.device
    const p = await phone(dev.deviceId, dev.privateKey, Date.now() - HOUR)
    const t0 = Date.now() - HOUR
    const f = await tap(p, dev.deviceId, { a: 'reply', thread_id: 'general', text: 'on my way' }, t0, t0 + 30_000)
    h.relay.sendToBridge(f, { durable: true })
    await h.waitNotes(1)
    expect(h.notes[0]?.content).toContain('on my way')
    expect(h.bridge.ctx.store.hasSeen(f.id)).toBe(true)
  })

  test('is refused when the signed time and the relay stamp are far apart (a replay, not a tap that waited)', async () => {
    h = await startHarness()
    const dev = h.app.device
    const p = await phone(dev.deviceId, dev.privateKey, Date.now() - 3 * HOUR)
    const f = await tap(
      p,
      dev.deviceId,
      { a: 'reply', thread_id: 'general', text: 'replayed' },
      Date.now() - 3 * HOUR,
      Date.now() - HOUR,
    )
    h.relay.sendToBridge(f, { durable: true })
    const err = await errorFor(f.id)
    expect(err.code).toBe('stale')
    expect(err.message).not.toContain('clock') // an old tap is not a clock problem
    expect(h.notes).toHaveLength(0)
  })

  test('is refused when the relay stamp is older than the eight days the queue may hold a frame', async () => {
    h = await startHarness()
    const dev = h.app.device
    const long = 9 * 24 * HOUR
    const p = await phone(dev.deviceId, dev.privateKey, Date.now() - long)
    const f = await tap(
      p,
      dev.deviceId,
      { a: 'reply', thread_id: 'general', text: 'too old' },
      Date.now() - long,
      Date.now() - long + 1000,
    )
    h.relay.sendToBridge(f, { durable: true })
    expect((await errorFor(f.id)).code).toBe('stale')
    expect(h.notes).toHaveLength(0)
  })

  test('a signed time in the future still reads as a wrong clock', async () => {
    h = await startHarness()
    const dev = h.app.device
    const p = await phone(dev.deviceId, dev.privateKey)
    const f = await tap(
      p,
      dev.deviceId,
      { a: 'reply', thread_id: 'general', text: 'x' },
      Date.now() + 10 * 60_000,
      null,
    )
    h.relay.sendToBridge(f, { durable: true })
    const err = await errorFor(f.id)
    expect(err.code).toBe('stale')
    expect(err.message).toContain('clock')
  })
})

describe('an Approve tapped while the Mac slept', () => {
  test('runs when the Mac wakes an hour later, judged at the relay stamp, while the card is still alive', async () => {
    h = await startHarness()
    const dev = h.app.device
    const card = await makeCard() // chat origin: lives a day
    const t0 = Date.now() - HOUR
    const p = await phone(dev.deviceId, dev.privateKey, t0)
    const f = await tap(
      p,
      dev.deviceId,
      {
        a: 'approve',
        card_id: card.id,
        payload_hash: card.payload_hash,
        shown: shownHash(cardNotice(card).text, 'General'),
      },
      t0,
      t0 + 30_000,
    )
    h.relay.sendToBridge(f, { durable: true })
    await h.waitNotes(1)
    expect(h.bridge.ctx.ledger.get(card.id)?.state).toBe('resolved')
  })

  test("a tap with no relay stamp is judged on this Mac's clock: 5 minutes old runs, 11 minutes old is refused", async () => {
    h = await startHarness()
    const dev = h.app.device
    const card = await makeCard()
    const t0 = Date.now() - 5 * 60_000
    const p = await phone(dev.deviceId, dev.privateKey, t0)
    const f = await tap(
      p,
      dev.deviceId,
      {
        a: 'approve',
        card_id: card.id,
        payload_hash: card.payload_hash,
        shown: shownHash(cardNotice(card).text, 'General'),
      },
      t0,
      null,
    )
    // 5 minutes old, no stamp: still inside the rule, runs (the control for the refusal below)
    h.relay.sendToBridge(f, { durable: true })
    await h.waitNotes(1)
    const card2 = await makeCard()
    const t1 = Date.now() - 11 * 60_000
    const p2 = await phone(dev.deviceId, dev.privateKey, t1)
    const old = await tap(
      p2,
      dev.deviceId,
      {
        a: 'approve',
        card_id: card2.id,
        payload_hash: card2.payload_hash,
        shown: shownHash(cardNotice(card2).text, 'General'),
      },
      t1,
      null,
    )
    h.relay.sendToBridge(old, { durable: true })
    expect((await errorFor(old.id)).code).toBe('stale') // checkNativeAct: act_stale, never reaches the card
    expect(h.bridge.ctx.ledger.get(card2.id)?.state).toBe('pending')
  })

  test("the card's own expiry still wins: a card that ran out while the Mac slept is expired and the owner is told", async () => {
    h = await startHarness()
    const dev = h.app.device
    const card = await makeCard({ expires_in_s: 1 })
    await sleep(1200) // the card is now past its own expiry on this Mac's clock
    const t0 = Date.now() - 1100 // tapped while it was still alive (stamp before expiry)
    const p = await phone(dev.deviceId, dev.privateKey, t0)
    const f = await tap(
      p,
      dev.deviceId,
      {
        a: 'approve',
        card_id: card.id,
        payload_hash: card.payload_hash,
        shown: shownHash(cardNotice(card).text, 'General'),
      },
      t0,
      t0 + 10,
    )
    h.relay.sendToBridge(f, { durable: true })
    expect((await errorFor(f.id)).code).toBe('card_expired')
    expect(h.bridge.ctx.ledger.get(card.id)?.state).toBe('expired')
    const upd = await h.relay.expectFrame('card.update', (u) => u.card_id === card.id && u.state === 'expired', {
      direction: 'from_bridge',
    })
    expect(upd.state).toBe('expired')
    await h.waitNotes(1)
    expect(h.notes[0]?.content).toContain('EXPIRED')
    expect(existsSync(join(h.home, 'approved', `${card.id}.json`))).toBe(false)
  })

  test('a relay that withholds a tap and stamps it as if fresh cannot stretch it: 11 hours old runs, 13 hours old stays pending', async () => {
    h = await startHarness()
    const dev = h.app.device
    const shownOf = (c: CardT) => shownHash(cardNotice(c).text, 'General')
    const okCard = await makeCard()
    const t11 = Date.now() - 11 * HOUR
    const p11 = await phone(dev.deviceId, dev.privateKey, t11)
    const inside = await tap(
      p11,
      dev.deviceId,
      { a: 'approve', card_id: okCard.id, payload_hash: okCard.payload_hash, shown: shownOf(okCard) },
      t11,
      t11 + 60_000, // the stamp the relay chose: believable, unsigned
    )
    h.relay.sendToBridge(inside, { durable: true })
    await h.waitNotes(1)
    expect(h.bridge.ctx.ledger.get(okCard.id)?.state).toBe('resolved')

    const lateCard = await makeCard()
    const t13 = Date.now() - 13 * HOUR
    const p13 = await phone(dev.deviceId, dev.privateKey, t13)
    const late = await tap(
      p13,
      dev.deviceId,
      { a: 'approve', card_id: lateCard.id, payload_hash: lateCard.payload_hash, shown: shownOf(lateCard) },
      t13,
      t13 + 60_000,
    )
    h.relay.sendToBridge(late, { durable: true })
    expect((await errorFor(late.id)).code).toBe('stale')
    expect(h.bridge.ctx.ledger.get(lateCard.id)?.state).toBe('pending')
    expect(h.notes).toHaveLength(1)
  })

  test('the 12-hour cap is for Approve only: a Reply that waited 13 hours still goes through', async () => {
    h = await startHarness()
    const dev = h.app.device
    const t13 = Date.now() - 13 * HOUR
    const p = await phone(dev.deviceId, dev.privateKey, t13)
    const f = await tap(p, dev.deviceId, { a: 'reply', thread_id: 'general', text: 'late but fine' }, t13, t13 + 60_000)
    h.relay.sendToBridge(f, { durable: true })
    await h.waitNotes(1)
    expect(h.notes[0]?.content).toContain('late but fine')
  })

  test('a grant that ran out cannot be revived by a relay stamp from before it ran out', async () => {
    h = await startHarness()
    const dev = h.app.device
    const keys = await createPhoneKeys()
    const t0 = Date.now() - 2 * HOUR
    const grant = await signNativeGrant({
      deviceId: dev.deviceId,
      devicePrivateKey: dev.privateKey,
      encPub: keys.encPub,
      actPub: keys.actPub,
      nowMs: t0,
      ttlMs: HOUR,
    })
    // signed a minute after the grant ended; the relay stamps it a minute before the end ("it was still valid")
    const signedAt = t0 + HOUR + 60_000
    const f = await tap(
      { keys, grant },
      dev.deviceId,
      { a: 'reply', thread_id: 'general', text: 'revived?' },
      signedAt,
      t0 + HOUR - 60_000,
    )
    h.relay.sendToBridge(f, { durable: true })
    expect((await errorFor(f.id)).code).toBe('sig_invalid')
    expect(h.notes).toHaveLength(0)
  })

  test('a refusal that could not be sent (the socket dropped) is not forgotten: the tap is not marked seen and is refused again on replay', async () => {
    h = await startHarness()
    const dev = h.app.device
    const card = await makeCard({ risk: 'high' }) // a card a notification can never approve
    const p = await phone(dev.deviceId, dev.privateKey)
    const now = Date.now()
    const f = await tap(
      p,
      dev.deviceId,
      {
        a: 'approve',
        card_id: card.id,
        payload_hash: card.payload_hash,
        shown: shownHash(cardNotice(card).text, 'General'),
      },
      now,
      now,
    )
    const transport = h.bridge.ctx.transport
    const real = transport.sendEphemeral.bind(transport)
    let drop = true
    transport.sendEphemeral = (frame) => (drop && frame.type === 'error' ? false : real(frame))
    h.relay.sendToBridge(f, { durable: true })
    await sleep(300)
    expect(h.bridge.ctx.store.hasSeen(f.id)).toBe(false) // not forgotten
    drop = false
    h.relay.sendToBridge(f, { durable: true }) // the relay replays it on the next hello
    expect((await errorFor(f.id)).code).toBe('stepup_required')
    expect(h.bridge.ctx.store.hasSeen(f.id)).toBe(true)
  })

  test('the ledger judges the card expiry at the Mac clock and the 10-minute age at the stamp, never the other way round', async () => {
    h = await startHarness()
    const card = await makeCard({ expires_in_s: 3600 })
    const expires = Date.parse(card.expires_at)
    const input = {
      card_id: card.id,
      action: 'primary' as const,
      payload_hash: card.payload_hash,
      ts: new Date(expires - 2 * HOUR).toISOString(),
    }
    // the Mac wakes after the card ran out; the tap itself was made long before and the relay stamped it then
    const late = h.bridge.ctx.ledger.resolve(input, expires + 1000, { ageAtMs: expires - 3_000_000 })
    expect(late.ok).toBe(false)
    expect(!late.ok && late.code).toBe('card_expired')
    expect(!late.ok && late.reason).toBe('expired')
    // and without a stamp the same old frame is the app's own 10-minute rule
    const card2 = await makeCard({ expires_in_s: 3600 })
    const old = h.bridge.ctx.ledger.resolve(
      { ...input, card_id: card2.id, payload_hash: card2.payload_hash },
      expires - 1000,
    )
    expect(!old.ok && old.reason).toBe('mac_offline_too_long')
  })
})

describe('who may tap', () => {
  test('a phone the Mac has revoked is refused even with a valid grant and a fresh tap, for a Reply and for an Approve', async () => {
    h = await startHarness()
    const dev = h.app.device
    const p = await phone(dev.deviceId, dev.privateKey)
    const card = await makeCard()
    h.bridge.ctx.devices.revoke(dev.deviceId, new Date().toISOString())
    const now = Date.now()
    const reply = await tap(p, dev.deviceId, { a: 'reply', thread_id: 'general', text: 'still me' }, now, now)
    const approve = await tap(
      p,
      dev.deviceId,
      {
        a: 'approve',
        card_id: card.id,
        payload_hash: card.payload_hash,
        shown: shownHash(cardNotice(card).text, 'General'),
      },
      now,
      now,
    )
    for (const f of [reply, approve]) {
      h.relay.sendToBridge(f, { durable: true })
      expect((await errorFor(f.id)).code).toBe('device_not_pinned')
    }
    expect(h.notes).toHaveLength(0)
    expect(h.bridge.ctx.ledger.get(card.id)?.state).toBe('pending')
  })

  test("a second phone cannot reuse the first phone's grant or id; an unpinned phone is refused", async () => {
    h = await startHarness()
    const first = h.app.device
    const p = await phone(first.deviceId, first.privateKey)
    const now = Date.now()
    const ok = await tap(p, first.deviceId, { a: 'reply', thread_id: 'general', text: 'first' }, now, now)
    h.relay.sendToBridge(ok, { durable: true })
    await h.waitNotes(1)
    // a different device (never pinned here) presents the first phone's grant and keys
    const other = await createDeviceKey()
    const stolen = await tap(p, other.deviceId, { a: 'reply', thread_id: 'general', text: 'stolen' }, now, now)
    h.relay.sendToBridge(stolen, { durable: true })
    expect((await errorFor(stolen.id)).code).toBe('device_not_pinned')
    // the first phone's id sent again with other words is not run twice either
    h.relay.sendToBridge(
      { ...ok, body: JSON.stringify({ a: 'reply', thread_id: 'general', text: 'changed' }) },
      { durable: true },
    )
    await sleep(150)
    expect(h.notes).toHaveLength(1)
  })
})

describe('Approve binds what the notification showed', () => {
  async function approve(card: CardT, over: Partial<{ shown: string; hash: string }> = {}) {
    const dev = h.app.device
    const p = await phone(dev.deviceId, dev.privateKey)
    const now = Date.now()
    const shown = over.shown ?? shownHash(cardNotice(card).text, 'General')
    const f = await tap(
      p,
      dev.deviceId,
      { a: 'approve', card_id: card.id, payload_hash: over.hash ?? card.payload_hash, shown },
      now,
      now,
    )
    h.relay.sendToBridge(f, { durable: true })
    return f
  }

  test('approves a small low-risk card when the phone signed the text this Mac would have shown', async () => {
    h = await startHarness()
    const card = await makeCard()
    await approve(card)
    await h.waitNotes(1)
    expect(h.bridge.ctx.ledger.get(card.id)?.state).toBe('resolved')
  })

  test('the subtitle is part of what was shown: a hash of the body alone, or with another thread name, is refused', async () => {
    h = await startHarness()
    const card = await makeCard()
    for (const shown of [
      shownHash(cardNotice(card).text), // body only, as if the subtitle were not displayed
      shownHash(cardNotice(card).text, 'Payroll'), // a name this card's thread does not have
    ]) {
      const f = await approve(card, { shown })
      expect((await errorFor(f.id)).code).toBe('card_hash_mismatch')
    }
    expect(h.bridge.ctx.ledger.get(card.id)?.state).toBe('pending')
    await approve(card) // the control: body plus the thread's real name runs
    await h.waitNotes(1)
  })

  test('refuses words the relay chose: the phone signed a different text, so the card stays pending', async () => {
    h = await startHarness()
    const card = await makeCard()
    const lie = shownHash('Approve archive of old drafts')
    const f = await approve(card, { shown: lie })
    const err = await errorFor(f.id)
    expect(err.code).toBe('card_hash_mismatch')
    expect(h.bridge.ctx.ledger.get(card.id)?.state).toBe('pending')
    expect(h.notes).toHaveLength(0)
  })

  test('refuses a card that leaves the app even when the agent called it low risk', async () => {
    h = await startHarness()
    const card = await makeCard({
      kind: 'email',
      title: 'Tidy up inbox',
      destination: [{ label: 'To', value: 'ceo@example.com' }],
      body: 'a damaging body',
    })
    // The phone signs exactly what this Mac would have shown (the real text and the real subtitle), so the words check passes
    // and only the "whole card" gate can refuse it. A wrong hash here would let the test pass with that gate removed.
    const real = shownHash(cardNotice(card).text, 'General')
    const f = await approve(card, { shown: real })
    const err = await errorFor(f.id)
    expect(err.code).toBe('card_hash_mismatch')
    expect(err.message).toMatch(/more than a notification can show/)
    expect(h.bridge.ctx.ledger.get(card.id)?.state).toBe('pending')
    expect(h.notes).toHaveLength(0)
  })

  test('refuses a generic, low-risk card that names a destination: the agent chose the kind, the owner sees the recipient', async () => {
    h = await startHarness()
    const card = await makeCard({ destination: [{ label: 'To', value: 'ceo@example.com' }], body: 'a damaging body' })
    expect(card.kind).toBe('generic')
    expect(card.risk).toBe('low')
    const f = await approve(card, { shown: shownHash(cardNotice(card).text, 'General') })
    const err = await errorFor(f.id)
    expect(err.code).toBe('card_hash_mismatch')
    expect(err.message).toMatch(/more than a notification can show/)
    expect(h.bridge.ctx.ledger.get(card.id)?.state).toBe('pending')
    expect(h.notes).toHaveLength(0)
  })

  test('refuses a permission card the app would show without Allow (old client, no version, repeated, hidden part)', async () => {
    h = await startHarness()
    const req = (id: string, input = '/home/alex/a.txt') => ({
      request_id: id,
      tool_name: 'Read',
      description: 'Read a file',
      input_preview: input,
    })
    const mk = (id: string, over: Partial<Parameters<typeof composePermissionCard>[0]>) =>
      composePermissionCard({
        request: req(id),
        card_id: `c_${newUlid()}`,
        thread_id: 'general',
        now: Date.now(),
        client_version: '2.1.234',
        ...over,
      })
    const allowed = mk('abcde', {})
    const denyOnly = {
      'old client': mk('fghij', { client_version: '2.1.233' }),
      'no version': mk('kmnop', { client_version: undefined }),
      repeated: mk('qrstu', { repeated: true }),
      'hidden part': mk('vwxyz', { request: req('vwxyz', 'a\u22EFb') }),
    }
    h.bridge.ctx.ledger.create(allowed)
    for (const c of Object.values(denyOnly)) h.bridge.ctx.ledger.create(c)
    for (const [name, c] of Object.entries(denyOnly)) {
      const f = await approve(c)
      expect((await errorFor(f.id)).code, name).toBe('card_hash_mismatch')
      expect(h.bridge.ctx.ledger.get(c.id)?.state, name).toBe('pending')
    }
    expect(h.notes).toHaveLength(0)
    // the control: the same card with nothing wrong gets past the "whole card" check (the permission path then takes over)
    expect(cardNotice(h.bridge.ctx.ledger.get(allowed.id)!.binding).complete).toBe(true)
  })

  describe('an Allow that passes the ledger but cannot reach Claude Code', () => {
    const params = {
      request_id: 'abcde',
      tool_name: 'Read',
      description: 'Read a file',
      input_preview: '/home/alex/a.txt',
    }
    async function permissionCard(sender: ((v: unknown) => Promise<void>) | null) {
      h = await startHarness()
      h.bridge.ctx.config.config.permission_relay = true
      h.bridge.setClientVersion(() => '2.1.312')
      if (sender) h.bridge.setPermissionSender(sender as never)
      await h.bridge.ctx.permission.onRequest(params)
      return (
        await h.relay.expectFrame('card.create', (f) => f.card.kind === 'permission', { direction: 'from_bridge' })
      ).card
    }
    for (const [name, sender, code] of [
      [
        'the verdict cannot be sent',
        async () => {
          throw new Error('pipe closed')
        },
        'internal',
      ],
      ['there is no channel to Claude Code', null, 'permission_closed'],
    ] as const) {
      test(`${name}: the card fails AND the tap gets a refusal, so the relay can send the failed-tap push`, async () => {
        const card = await permissionCard(sender)
        expect(card.risk).toBe('low')
        const f = await approve(card)
        const err = await errorFor(f.id) // the relay turns an error{ref} for a notification tap into the failed-tap push
        expect(err.code).toBe(code)
        const u = await h.relay.expectFrame('card.update', (x) => x.card_id === card.id && x.state === 'failed', {
          direction: 'from_bridge',
        })
        expect(u.result?.ok).toBe(false)
        expect(h.bridge.ctx.store.seenOutcome(f.id)).toBe(`rejected:${code}`)
      })
    }

    test('the same failure from the app (not a notification tap) is not turned into an error frame', async () => {
      const card = await permissionCard(async () => {
        throw new Error('pipe closed')
      })
      await h.app.resolveCard(card, 'primary', card.payload_hash)
      await h.relay.expectFrame('card.update', (x) => x.card_id === card.id && x.state === 'failed', {
        direction: 'from_bridge',
      })
      expect(h.relay.frames.some((x) => x.direction === 'from_bridge' && x.frame.type === 'error')).toBe(false)
    })

    test('the control: an Allow that reaches Claude Code is not refused', async () => {
      const sent: unknown[] = []
      const card = await permissionCard(async (v) => void sent.push(v))
      const f = await approve(card)
      await h.relay.expectFrame('card.update', (x) => x.card_id === card.id && x.state === 'done', {
        direction: 'from_bridge',
      })
      expect(sent).toHaveLength(1)
      expect(h.bridge.ctx.store.seenOutcome(f.id)).toBe('ok')
    })
  })

  test('a replayed tap that was refused earlier gets the stored refusal again, not just an ack', async () => {
    h = await startHarness()
    const card = await makeCard({ risk: 'high' })
    const f = await approve(card) // refused: stepup_required, and marked seen
    expect((await errorFor(f.id)).code).toBe('stepup_required')
    expect(h.bridge.ctx.store.seenOutcome(f.id)).toBe('rejected:stepup_required')
    // that refusal went out on a socket that then died; the relay never got the push trigger and replays the tap
    const refusals = () =>
      h.relay.frames.filter((x) => x.direction === 'from_bridge' && x.frame.type === 'error' && x.frame.ref === f.id)
    expect(refusals()).toHaveLength(1)
    h.relay.sendToBridge(f, { durable: true })
    await eventually(() => expect(refusals()).toHaveLength(2))
    const again = h.relay.frames.filter(
      (x) => x.direction === 'from_bridge' && x.frame.type === 'error' && x.frame.ref === f.id,
    )
    expect(again.length).toBe(2)
    expect((again[1]?.frame as { code?: string } | undefined)?.code).toBe('stepup_required')
    expect(h.bridge.ctx.ledger.get(card.id)?.state).toBe('pending')
    expect(h.notes).toHaveLength(0)
  })

  test('a replayed tap whose stored refusal cannot be sent is not acked, so the relay replays it again', async () => {
    h = await startHarness()
    const card = await makeCard({ risk: 'high' })
    const f = await approve(card)
    expect((await errorFor(f.id)).code).toBe('stepup_required') // refused once and remembered
    const transport = h.bridge.ctx.transport
    const real = transport.sendEphemeral.bind(transport)
    let drop = true
    const tried: Array<{ type: string; ref?: string }> = []
    transport.sendEphemeral = (frame) => {
      const x = frame as { type: string; ref?: string }
      if (x.ref === f.id) tried.push({ type: x.type, ref: x.ref })
      return drop && frame.type === 'error' ? false : real(frame)
    }
    h.relay.sendToBridge(f, { durable: true }) // the socket is down: the refusal cannot go out
    await eventually(() => expect(tried.some((t) => t.type === 'error')).toBe(true)) // it reached the resend
    await sleep(300)
    expect(tried.filter((t) => t.type === 'ack')).toEqual([]) // an ack here would let the relay forget the tap unrefused
    drop = false
    h.relay.sendToBridge(f, { durable: true }) // replayed again once the socket is back
    await eventually(() => expect(tried.some((t) => t.type === 'ack')).toBe(true))
    expect(tried.filter((t) => t.type === 'error' && drop === false).length).toBeGreaterThan(0)
  })

  test('a replayed tap that was accepted earlier is only acked: no second note, no error', async () => {
    h = await startHarness()
    const card = await makeCard()
    const f = await approve(card)
    await h.waitNotes(1)
    h.relay.sendToBridge(f, { durable: true })
    await new Promise((r) => setTimeout(r, 300))
    expect(h.notes).toHaveLength(1)
    expect(h.relay.frames.some((x) => x.direction === 'from_bridge' && x.frame.type === 'error')).toBe(false)
  })

  test('refuses a high-risk card whatever the relay says', async () => {
    h = await startHarness()
    const card = await makeCard({ risk: 'high' })
    const f = await approve(card)
    expect((await errorFor(f.id)).code).toBe('stepup_required')
    expect(h.bridge.ctx.ledger.get(card.id)?.state).toBe('pending')
  })

  test('refuses a card that changed after it was shown (hash of the card, not of the words)', async () => {
    h = await startHarness()
    const card = await makeCard()
    const f = await approve(card, { hash: `sha256:${'0'.repeat(64)}` })
    expect((await errorFor(f.id)).code).toBe('card_hash_mismatch')
    expect(h.bridge.ctx.ledger.get(card.id)?.state).toBe('pending')
  })

  test('a card the Mac never made is refused, not guessed at', async () => {
    h = await startHarness()
    const card = await makeCard()
    const ghost = { ...card, id: 'c_01JBF3V7Q8K2M4N6P8R0S2T4V7' }
    const f = await approve(ghost)
    await eventually(() => expect(h.bridge.ctx.store.hasSeen(f.id)).toBe(true))
    expect(h.notes).toHaveLength(0)
    expect(h.bridge.ctx.ledger.get(card.id)?.state).toBe('pending')
  })

  test('the decision is dated at the signed tap, not at the moment a sleeping Mac got to it', async () => {
    h = await startHarness()
    const card = await makeCard()
    const created = Date.parse(card.created_at)
    const tapped = created + 5 * 60_000
    const wake = created + 9 * HOUR
    const out = h.bridge.ctx.ledger.resolve(
      { card_id: card.id, action: 'primary', payload_hash: card.payload_hash, ts: new Date(tapped).toISOString() },
      wake,
      { ageAtMs: tapped + 30_000 }, // the relay's stamp: it took the tap a moment after it was made
    )
    expect(out.ok).toBe(true)
    expect(out.ok && out.resolution.at).toBe(new Date(tapped).toISOString())
    expect(h.bridge.ctx.ledger.get(card.id)?.resolution?.at).toBe(new Date(tapped).toISOString())
    // the Mac's own time is kept beside it: "running for how long" is measured from here, not from the tap
    expect(out.ok && out.resolution.taken_at).toBe(new Date(wake).toISOString())
    expect(h.bridge.ctx.ledger.get(card.id)?.resolution?.taken_at).toBe(new Date(wake).toISOString())
  })

  test('a signed tap time cannot move a card to before it existed or after the Mac processed it', async () => {
    h = await startHarness()
    const early = await makeCard()
    const late = await makeCard()
    const created = Date.parse(early.created_at)
    const now = created + 60_000
    const a = h.bridge.ctx.ledger.resolve(
      {
        card_id: early.id,
        action: 'kill',
        payload_hash: early.payload_hash,
        ts: new Date(created - 5 * 60_000).toISOString(),
      },
      now,
      { ageAtMs: now },
    )
    expect(a.ok && a.resolution.at).toBe(early.created_at) // a tap "from before the card": clamped up to its creation
    const b = h.bridge.ctx.ledger.resolve(
      { card_id: late.id, action: 'kill', payload_hash: late.payload_hash, ts: new Date(now + HOUR).toISOString() },
      now,
      { ageAtMs: now },
    )
    expect(b.ok && b.resolution.at).toBe(new Date(now).toISOString()) // a tap "from the future": clamped down to now
  })

  test('a tap time that cannot be read falls back to the moment the Mac processed it', async () => {
    h = await startHarness()
    const card = await makeCard()
    const now = Date.parse(card.created_at) + 60_000
    const out = h.bridge.ctx.ledger.resolve(
      { card_id: card.id, action: 'kill', payload_hash: card.payload_hash, ts: 'not a time' },
      now,
    )
    expect(out.ok && out.resolution.at).toBe(new Date(now).toISOString())
  })

  test('an Approve tapped on a notification is dated at the tap, through the real frame path', async () => {
    h = await startHarness()
    const dev = h.app.device
    const card = await makeCard()
    const t0 = Date.parse(card.created_at) + 1
    const p = await phone(dev.deviceId, dev.privateKey, t0)
    const f = await tap(
      p,
      dev.deviceId,
      {
        a: 'approve',
        card_id: card.id,
        payload_hash: card.payload_hash,
        shown: shownHash(cardNotice(card).text, 'General'),
      },
      t0,
      t0 + 30_000,
    )
    await sleep(25) // the Mac gets to it a moment later
    h.relay.sendToBridge(f, { durable: true })
    await h.waitNotes(1)
    expect(h.bridge.ctx.ledger.get(card.id)?.resolution?.at).toBe(new Date(t0).toISOString())
  })
})
