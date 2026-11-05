import { afterEach, describe, expect, test } from 'bun:test'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { bindingFrom, type CardT, ChannelMeta, editedHash, parseFrame, payloadHash } from '@talos-app/protocol'
import { fakeClock } from '@talos-app/testkit'
import {
  advanceSteps,
  eventually,
  type Harness,
  pushCardResolvePastRelay,
  sleep,
  startHarness,
  waitFor,
} from './helpers.ts'

let h: Harness
afterEach(async () => h?.stop())

const cardArgs = (extra: Record<string, unknown> = {}) => ({
  thread_id: 'general',
  kind: 'message',
  title: 'Send the update',
  primary_label: 'Send',
  kill_label: 'Kill draft',
  risk: 'low',
  origin: 'chat',
  destination: [{ label: 'To', value: 'someone@example.com' }],
  body: 'Draft body',
  fields: [
    { key: 'subject', label: 'Subject', value: 'Update', editable: true },
    { key: 'cc', label: 'Cc', value: 'nobody@example.com' },
  ],
  ...extra,
})

async function makeCard(extra: Record<string, unknown> = {}): Promise<CardT> {
  const res = await h.bridge.callTool('card', cardArgs(extra))
  expect(res.isError, res.content[0]?.text).toBeFalsy()
  const id = /card (c_[0-9A-HJKMNP-TV-Z]{26})/.exec(res.content[0]?.text ?? '')?.[1]
  return (await h.relay.expectFrame('card.create', (f) => f.card.id === id, { direction: 'from_bridge' })).card
}

const errFor = async (id: string) =>
  (await h.relay.expectFrame('error', (f) => f.ref === id, { direction: 'from_bridge' })).code

describe('cards', () => {
  test('the ledger hash is payloadHash(binding) and card.create parses', async () => {
    h = await startHarness()
    const res = await h.bridge.callTool('card', cardArgs())
    expect(res.content[0]?.text).toMatch(/^card c_[0-9A-HJKMNP-TV-Z]{26} pending, expires \S+, sha256:[0-9a-f]{64}$/)
    const f = await h.relay.expectFrame('card.create', undefined, { direction: 'from_bridge' })
    expect(parseFrame(f, { direction: 'bridge_to_relay' }).ok).toBe(true)
    expect(f.card.payload_hash).toBe(payloadHash(bindingFrom(f.card)))
    const row = h.bridge.ctx.ledger.get(f.card.id)
    expect(row?.payload_hash).toBe(f.card.payload_hash)
    expect(row?.state).toBe('pending')
    expect(f.card.state).toBe('pending')
  })

  test('validation: destination required for a message card, expiry bounds, bad enums', async () => {
    h = await startHarness()
    expect((await h.bridge.callTool('card', cardArgs({ destination: [] }))).isError).toBe(true)
    expect((await h.bridge.callTool('card', cardArgs({ expires_in_s: 604_801 }))).isError).toBe(true)
    expect((await h.bridge.callTool('card', cardArgs({ risk: 'medium' }))).isError).toBe(true)
    expect((await h.bridge.callTool('card', cardArgs({ title: 'x'.repeat(121) }))).isError).toBe(true)
    // decision and generic cards need no destination
    expect((await h.bridge.callTool('card', cardArgs({ kind: 'decision', destination: [] }))).isError).toBeFalsy()
  })

  test('default expiry is 86400 s for background and for chat (O2: a background card no longer dies in 30 minutes)', async () => {
    h = await startHarness()
    const bg = await makeCard({ origin: 'background' })
    const chat = await makeCard({ origin: 'chat' })
    expect(Date.parse(bg.expires_at) - Date.parse(bg.created_at)).toBe(86_400_000)
    expect(Date.parse(chat.expires_at) - Date.parse(chat.created_at)).toBe(86_400_000)
  })

  test('primary resolves once: card_action, approved file, card.update; a second resolve is card_not_pending', async () => {
    h = await startHarness()
    const card = await makeCard()
    await h.app.resolveCard(card, 'primary', card.payload_hash)
    await h.waitNotes(1)
    const n = h.notes[0]
    const meta = ChannelMeta.parse(n?.meta)
    expect(meta.kind).toBe('card_action')
    expect(meta.card_action).toBe('primary')
    expect(meta.card_id).toBe(card.id)
    expect(meta.card_edited).toBe('false')
    expect(meta.message_id).toBe(card.id)
    expect(meta.payload_path).toBe(join(h.home, 'approved', `${card.id}.json`))
    expect(n?.content).toContain(
      `Card ${card.id} "Send the update" → PRIMARY (Send). Edited: no. Approved binding: ${meta.payload_path} (${card.payload_hash}). Do exactly what it says, nothing more, then call card_result.`,
    )
    const approved = JSON.parse(readFileSync(meta.payload_path as string, 'utf8'))
    expect(payloadHash(approved)).toBe(card.payload_hash)
    const upd = await h.relay.expectFrame('card.update', (f) => f.state === 'resolved', { direction: 'from_bridge' })
    expect(upd.resolution?.action).toBe('primary')
    expect(upd.resolution?.edited).toBe(false)
    // The relay stops a second tap on its own (see the FakeRelay parity test); this one goes past it to the Mac's ledger.
    const again = await pushCardResolvePastRelay(h, card, card.payload_hash)
    expect(await errFor(again.id)).toBe('card_not_pending')
    expect(h.notes).toHaveLength(1)
  })

  test('replaying the same card.resolve frame is answered consumed and never runs twice', async () => {
    h = await startHarness()
    const card = await makeCard()
    const f = await h.app.resolveCard(card, 'primary', card.payload_hash)
    await h.waitNotes(1)
    const consumedAcks = () =>
      h.relay.frames.filter(
        (r) =>
          r.direction === 'from_bridge' &&
          r.frame.type === 'ack' &&
          (r.frame as { ref?: string }).ref === f.id &&
          (r.frame as { stage?: string }).stage === 'consumed',
      ).length
    await eventually(() => expect(consumedAcks()).toBe(1)) // the first delivery
    h.relay.sendToBridge(f, { durable: false }) // the relay replays the very same frame, straight to the bridge
    // A quiet answer is the seen-id check: consumed again. The ledger refusing instead would be card_not_pending.
    await eventually(() => expect(consumedAcks()).toBe(2))
    const errors = h.relay.frames.filter(
      (r) => r.direction === 'from_bridge' && r.frame.type === 'error' && (r.frame as { ref?: string }).ref === f.id,
    )
    expect(errors).toHaveLength(0)
    expect(h.notes).toHaveLength(1)
  })

  test('a wrong hash is rejected with card_hash_mismatch and nothing is delivered', async () => {
    h = await startHarness()
    const card = await makeCard()
    for (const flip of [
      { allow_edit: !card.allow_edit },
      { allow_revise: !card.allow_revise },
      { origin: 'background' as const },
    ]) {
      const altered = await pushCardResolvePastRelay(h, card, payloadHash(bindingFrom({ ...card, ...flip })))
      expect(await errFor(altered.id)).toBe('card_hash_mismatch')
    }
    const wrong = await pushCardResolvePastRelay(h, card, `sha256:${'f'.repeat(64)}`)
    expect(await errFor(wrong.id)).toBe('card_hash_mismatch')
    expect(h.notes).toHaveLength(0)
    expect(h.bridge.ctx.ledger.get(card.id)?.state).toBe('pending')
    await h.relay.expectFrame('card.update', (f) => f.reason === 'hash_mismatch', { direction: 'from_bridge' })
  })

  test('an edit of a non-editable field is rejected with card_edit_forbidden', async () => {
    h = await startHarness()
    const card = await makeCard()
    const binding = bindingFrom(card)
    const edited = { fields: [{ key: 'cc', value: 'attacker@example.net' }] }
    const f = await h.app.resolveCard(card, 'primary', card.payload_hash, {
      edited,
      edited_hash: editedHash(binding, edited),
    })
    expect(await errFor(f.id)).toBe('card_edit_forbidden')
    expect(h.notes).toHaveLength(0)
  })

  test('a wrong edited_hash, an unknown field and a body edit on a non-body kind are rejected', async () => {
    h = await startHarness()
    const card = await makeCard({ kind: 'decision', destination: [] })
    const binding = bindingFrom(card)
    const body = { fields: [], body: 'new' }
    const f1 = await pushCardResolvePastRelay(h, card, card.payload_hash, 'primary', {
      edited: body,
      edited_hash: editedHash(binding, body),
    })
    expect(await errFor(f1.id)).toBe('card_edit_forbidden') // decision card: body not editable
    const ok = { fields: [{ key: 'subject', value: 'New' }] }
    const f2 = await pushCardResolvePastRelay(h, card, card.payload_hash, 'primary', {
      edited: ok,
      edited_hash: `sha256:${'0'.repeat(64)}`,
    })
    expect(await errFor(f2.id)).toBe('card_edit_forbidden')
    const unknown = { fields: [{ key: 'nope', value: 'x' }] }
    const f3 = await pushCardResolvePastRelay(h, card, card.payload_hash, 'primary', {
      edited: unknown,
      edited_hash: editedHash(binding, unknown),
    })
    expect(await errFor(f3.id)).toBe('card_edit_forbidden')
  })

  test('a valid edit resolves with card_edited=true and the approved file holds the edited binding', async () => {
    h = await startHarness()
    const card = await makeCard()
    const binding = bindingFrom(card)
    const edited = { fields: [{ key: 'subject', value: 'Better subject' }], body: 'Better body' }
    const eh = editedHash(binding, edited)
    await h.app.resolveCard(card, 'primary', card.payload_hash, { edited, edited_hash: eh })
    await h.waitNotes(1)
    const meta = ChannelMeta.parse(h.notes[0]?.meta)
    expect(meta.card_edited).toBe('true')
    expect(h.notes[0]?.content).toContain('Edited: yes')
    expect(h.notes[0]?.content).toContain(eh)
    const approved = JSON.parse(readFileSync(meta.payload_path as string, 'utf8'))
    expect(approved.body).toBe('Better body')
    expect(approved.fields.find((f: { key: string }) => f.key === 'subject').value).toBe('Better subject')
    expect(payloadHash(approved)).toBe(eh)
  })

  test('kill and revise tell the agent not to run it; revise carries the note', async () => {
    h = await startHarness()
    const a = await makeCard()
    await h.app.resolveCard(a, 'kill', a.payload_hash)
    await h.waitNotes(1)
    expect(h.notes[0]?.content).toContain('→ KILL. Do not run it.')
    expect(h.notes[0]?.meta.payload_path).toBeUndefined()
    expect(existsSync(join(h.home, 'approved', `${a.id}.json`))).toBe(false)
    const b = await makeCard()
    await h.app.resolveCard(b, 'revise', b.payload_hash, { note: 'make it shorter' })
    await h.waitNotes(2)
    expect(h.notes[1]?.content).toContain('→ REVISE')
    expect(h.notes[1]?.content).toContain('make it shorter')
  })

  test.each(['kill', 'revise'] as const)(
    'a %s ends the card: the ledger and every app see it done, after the resolved frame, with the owner action kept',
    async (action) => {
      h = await startHarness()
      const card = await makeCard()
      await h.app.resolveCard(card, action, card.payload_hash, action === 'revise' ? { note: 'shorter' } : {})
      await h.waitNotes(1)
      const done = await h.relay.expectFrame('card.update', (u) => u.card_id === card.id && u.state === 'done', {
        direction: 'from_bridge',
      })
      expect(done.resolution?.action).toBe(action)
      expect(done.result).toBeUndefined() // nothing ran, so there is no result to report
      expect(Date.parse(done.resolution?.taken_at ?? '')).toBeGreaterThan(0) // the apps get the Mac's own time too
      const row = h.bridge.ctx.ledger.get(card.id)
      expect(row?.state).toBe('done')
      expect(row?.resolution?.action).toBe(action)
      const mine = h.relay.frames
        .filter((r) => r.direction === 'from_bridge' && r.raw.type === 'card.update' && r.raw.card_id === card.id)
        .map((r) => r.raw.state)
      expect(mine).toEqual(['resolved', 'done']) // the app keeps the last frame, so done must come last
      // the agent cannot report on it, and a second resolve is refused
      expect((await h.bridge.callTool('card_result', { card_id: card.id, ok: true, text: 'x' })).isError).toBe(true)
      const again = await pushCardResolvePastRelay(h, card, card.payload_hash)
      expect(await errFor(again.id)).toBe('card_not_pending')
      // the refusal re-states the card as decided: a `done` with no resolution would read as a sent email
      const restated = await h.relay.expectFrame(
        'card.update',
        (u) => u.card_id === card.id && u.reason === 'state_done',
        { direction: 'from_bridge' },
      )
      expect(restated.state).toBe('done')
      expect(restated.resolution?.action).toBe(action)
    },
  )

  test('an approved card is not closed by the bridge: it waits for the agent result', async () => {
    h = await startHarness()
    const card = await makeCard()
    await h.app.resolveCard(card, 'primary', card.payload_hash)
    await h.waitNotes(1)
    await h.relay.expectFrame('card.update', (u) => u.card_id === card.id && u.state === 'resolved', {
      direction: 'from_bridge',
    })
    expect(h.bridge.ctx.ledger.get(card.id)?.state).toBe('resolved')
  })

  test('a resolve arriving 11 minutes after its ts is expired, not run', async () => {
    h = await startHarness()
    const card = await makeCard()
    const old = new Date(Date.now() - 11 * 60_000).toISOString()
    const f = await h.app.resolveCard(card, 'primary', card.payload_hash, { ts: old })
    expect(await errFor(f.id)).toBe('card_expired')
    await h.waitNotes(1)
    expect(h.notes[0]?.meta.card_action).toBe('expired')
    expect(h.notes[0]?.content).toContain('EXPIRED. Nothing ran')
    expect(h.bridge.ctx.ledger.get(card.id)?.state).toBe('expired')
    const upd = await h.relay.expectFrame('card.update', (u) => u.state === 'expired', { direction: 'from_bridge' })
    expect(upd.reason).toBe('mac_offline_too_long')
    expect(existsSync(join(h.home, 'approved', `${card.id}.json`))).toBe(false)
    // and a later resolve of that card is rejected too
    const again = await pushCardResolvePastRelay(h, card, card.payload_hash)
    expect(await errFor(again.id)).toBe('card_expired')
  })

  test('the expiry timer fires card_action=expired with a fake clock', async () => {
    const clock = fakeClock(new Date().toISOString())
    h = await startHarness({ clock })
    const card = await makeCard({ expires_in_s: 120 })
    expect(h.notes).toHaveLength(0)
    await advanceSteps(clock, 119_000, 20_000, h.bridge.client)
    expect(h.notes).toHaveLength(0)
    await advanceSteps(clock, 2_000, 20_000, h.bridge.client)
    await h.waitNotes(1)
    expect(h.notes[0]?.meta.card_action).toBe('expired')
    expect(h.notes[0]?.meta.card_id).toBe(card.id)
    await h.relay.expectFrame('card.update', (u) => u.state === 'expired' && u.reason === 'expired', {
      direction: 'from_bridge',
    })
    expect(h.bridge.ctx.ledger.get(card.id)?.state).toBe('expired')
    const f = await pushCardResolvePastRelay(h, card, card.payload_hash)
    expect(await errFor(f.id)).toBe('card_expired')
    expect(h.notes).toHaveLength(1) // not notified twice
  })

  test('a card past its expiry at startup expires once on the first sweep', async () => {
    const clock = fakeClock(new Date().toISOString())
    h = await startHarness({ clock })
    const card = await makeCard({ expires_in_s: 60 })
    await h.bridge.stop()
    clock.advance(3600_000)
    // a fresh bridge process over the same home
    const { Bridge } = await import('../src/bridge.ts')
    const { nullLogger } = await import('../src/log.ts')
    const b2 = await Bridge.create({ env: h.bridge.ctx.env, logger: nullLogger, clock, inbound: { settleMs: 10 } })
    const seen: string[] = []
    b2.setEmit(async (n) => {
      seen.push(n.meta.card_action as string)
    })
    b2.expiry.sync()
    await waitFor(() => seen.length === 1)
    b2.expiry.sync()
    await sleep(30)
    await eventually(() => expect(seen).toEqual(['expired']))
    expect(b2.ctx.ledger.get(card.id)?.state).toBe('expired')
    await b2.stop()
  })

  test('card_result moves a resolved card to done/failed and rejects bad use', async () => {
    h = await startHarness()
    const card = await makeCard()
    expect((await h.bridge.callTool('card_result', { card_id: card.id, ok: true, text: 'early' })).isError).toBe(true) // still pending
    await h.app.resolveCard(card, 'primary', card.payload_hash)
    await h.waitNotes(1)
    const res = await h.bridge.callTool('card_result', { card_id: card.id, ok: true, text: 'Published' })
    expect(res.isError).toBeFalsy()
    const upd = await h.relay.expectFrame('card.update', (u) => u.state === 'done', { direction: 'from_bridge' })
    expect(upd.result?.ok).toBe(true)
    expect(upd.result?.text).toBe('Published')
    expect((await h.bridge.callTool('card_result', { card_id: card.id, ok: true, text: 'again' })).isError).toBe(true)
    const killed = await makeCard()
    await h.app.resolveCard(killed, 'kill', killed.payload_hash)
    await h.waitNotes(2)
    expect((await h.bridge.callTool('card_result', { card_id: killed.id, ok: true, text: 'x' })).isError).toBe(true)
  })

  test('a new card can supersede a pending one', async () => {
    h = await startHarness()
    const a = await makeCard()
    const b = await makeCard({ supersedes: a.id })
    expect(h.bridge.ctx.ledger.get(a.id)?.state).toBe('superseded')
    await h.relay.expectFrame('card.update', (u) => u.card_id === a.id && u.state === 'superseded', {
      direction: 'from_bridge',
    })
    const f = await pushCardResolvePastRelay(h, a, a.payload_hash)
    expect(await errFor(f.id)).toBe('card_not_pending')
    expect(b.id).not.toBe(a.id)
  })

  test('a resolve for an unknown card is card_not_pending', async () => {
    h = await startHarness()
    const card = await makeCard()
    const fake = { ...card, id: 'c_01JBF3V7Q8K2M4N6P8R0S2T4V6' }
    const f = await pushCardResolvePastRelay(h, fake, card.payload_hash)
    expect(await errFor(f.id)).toBe('card_not_pending')
  })
})
