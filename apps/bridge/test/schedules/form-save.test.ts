// "Save in my own schedule form" (`form_save` on the owner's signed schedule.patch): a create or an update from the form, no older
// than a tap on a card may wait, is applied at once and never makes a card the apps could show (no Approve button, no "needs
// you"). Nothing else can produce it: the field sits inside the device signature, so only the owner's device can set it, and
// every other way to reach the bridge still ends in a card to approve.
import { afterEach, describe, expect, setDefaultTimeout, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { createDeviceKey, ownerSignedString, type ScheduleChangeT, signOwnerFrame } from '@talos-app/protocol'
import { mkFrame, t } from '@talos-app/testkit'
import { MAX_RESOLVE_AGE_MS } from '../../src/cards-ledger.ts'
import { eventually } from '../helpers.ts'
import { draft, type SchedHarness, sleep, startSched } from './harness.ts'

// real Chronos processes: what longTimeouts() sets (60 s), written out so timing-lint can see it
setDefaultTimeout(t(60_000))

let h = undefined as unknown as SchedHarness
afterEach(async () => {
  await h?.stop()
  h = undefined as unknown as SchedHarness
})

const wireDraft = () => ({
  id: 'nightly-sync',
  name: 'Nightly Sync',
  description: '',
  when: { type: 'weekdays', time: '22:00' },
  catchup_min: 120,
  enabled: true,
  runner: 'session',
  permissions: 'full',
  allowed_tools: [],
  model: null,
  notify: 'failure',
  thread_id: 'inbox',
  prompt: 'Sync the notes folder.\n',
})
const create = { op: 'create', draft: wireDraft() } as const

const jobs = (x: SchedHarness) =>
  x.box.api<{ schedules: Array<{ id: string; etag: string; name: string; content_hash: string }> }>(['snapshot'])
    .schedules
const cardsSeen = (x: SchedHarness) =>
  x.relay.frames.filter((r) => r.direction === 'from_bridge' && r.frame.type === 'card.create')
const pendingCards = (x: SchedHarness) =>
  x.bridge.ctx.ledger.list('pending').filter((r) => r.binding.kind === 'schedule')

/** The owner's form, signed by the enrolled device, with the field. `ageMs` makes it that old when it was signed. */
const formSave = (x: SchedHarness, change: ScheduleChangeT | Record<string, unknown>, ageMs = 0) =>
  x.app.sendSchedule('schedule.patch', {
    change,
    thread_id: 'general',
    form_save: true,
    ...(ageMs > 0 ? { ts: new Date(x.clock.now() - ageMs).toISOString(), keep_ts: true } : {}),
  })

describe('Save in the schedule form applies at once, with no card', () => {
  test('a create: the ack says applied, the job is on disk, no card was ever sent, the ledger row is done', async () => {
    h = await startSched()
    const f = await formSave(h, create)
    const ack = await h.app.expectFrame('ack', (a) => a.ref === f.id, { direction: 'in', timeoutMs: 10_000 })
    expect(ack.applied).toBe(true)
    expect(jobs(h).map((j) => j.id)).toEqual(['nightly-sync'])
    // nothing the relay could push or the apps could show as a card to approve
    expect(cardsSeen(h)).toHaveLength(0)
    expect(pendingCards(h)).toEqual([])
    const done = h.bridge.ctx.ledger.list('done').filter((r) => r.binding.kind === 'schedule')
    expect(done).toHaveLength(1)
    expect(done[0]?.actor).toBe('bridge')
  })

  test('the same create again (a Save pressed again after a lost answer) is refused as already there: still one job, nothing new written', async () => {
    h = await startSched()
    const first = await formSave(h, create)
    expect(
      (await h.app.expectFrame('ack', (a) => a.ref === first.id, { direction: 'in', timeoutMs: 10_000 })).applied,
    ).toBe(true)
    const before = JSON.stringify(jobs(h))
    const again = await formSave(h, create)
    const err = await h.app.expectFrame('error', (e) => e.ref === again.id, { direction: 'in', timeoutMs: 10_000 })
    expect(err.code).toBe('schedule_conflict')
    expect(JSON.stringify(jobs(h))).toBe(before)
    expect(jobs(h)).toHaveLength(1)
    expect(cardsSeen(h)).toHaveLength(0)
  })

  test('an update applies with no tap and no card', async () => {
    h = await startSched({ jobs: [draft()] })
    const etag = jobs(h)[0]?.etag as string
    const f = await formSave(h, { op: 'update', id: 'daily-digest', base_etag: etag, set: { name: 'Morning Digest' } })
    const ack = await h.app.expectFrame('ack', (a) => a.ref === f.id, { direction: 'in', timeoutMs: 10_000 })
    expect(ack.applied).toBe(true)
    expect(jobs(h).find((j) => j.id === 'daily-digest')?.name).toBe('Morning Digest')
    expect(cardsSeen(h)).toHaveLength(0)
  })

  test('the changed-meanwhile check stays: a stale revision is refused, nothing is written, no card is left', async () => {
    h = await startSched({ jobs: [draft()] })
    const f = await formSave(h, {
      op: 'update',
      id: 'daily-digest',
      base_etag: `sha256:${'a'.repeat(64)}`,
      set: { name: 'x' },
    })
    const err = await h.app.expectFrame('error', (e) => e.ref === f.id, { direction: 'in' })
    expect(err.code).toBe('schedule_conflict')
    expect(jobs(h).find((j) => j.id === 'daily-digest')?.name).not.toBe('x')
    expect(pendingCards(h)).toEqual([])
    expect(cardsSeen(h)).toHaveLength(0)
  })

  test('a delete marked as a form save still shows its card and writes nothing', async () => {
    h = await startSched({ jobs: [draft()] })
    const etag = jobs(h)[0]?.etag as string
    const f = await formSave(h, { op: 'delete', id: 'daily-digest', base_etag: etag })
    await h.app.expectFrame('card.create', (c) => c.card.kind === 'schedule', { direction: 'in' })
    const ack = await h.app.expectFrame('ack', (a) => a.ref === f.id, { direction: 'in' })
    expect(ack.applied).toBeUndefined()
    await sleep(300) // timing-ok: negative window, from the card shown: nothing is applied behind it
    expect(jobs(h).map((j) => j.id)).toEqual(['daily-digest'])
    expect(pendingCards(h)).toHaveLength(1)
  })

  test('an adopt marked as a form save still shows its card and writes nothing', async () => {
    h = await startSched({ jobs: [draft()] })
    const j = jobs(h)[0]
    const f = await formSave(h, { op: 'adopt', id: 'daily-digest', content_hash: j?.content_hash as string })
    const answer = await Promise.race([
      h.app.expectFrame('card.create', (c) => c.card.kind === 'schedule', { direction: 'in' }).then(() => 'card'),
      h.app.expectFrame('error', (e) => e.ref === f.id, { direction: 'in' }).then(() => 'error'),
    ])
    // whether this job can be adopted or is refused, the field never turns it into a silent write
    if (answer === 'card') {
      await sleep(300) // timing-ok: negative window, from the card shown: nothing is applied behind it
      expect(pendingCards(h)).toHaveLength(1)
    }
    expect(
      h.relay.frames.some(
        (r) => r.direction === 'from_bridge' && r.frame.type === 'ack' && (r.frame as { applied?: boolean }).applied,
      ),
    ).toBe(false)
  })

  test("without the field the owner's patch is a card to approve, as before (the Turn on sheet and the rest)", async () => {
    h = await startSched()
    const f = await h.app.patchSchedule(create, 'general')
    await h.app.expectFrame('card.create', (c) => c.card.kind === 'schedule', { direction: 'in' })
    const ack = await h.app.expectFrame('ack', (a) => a.ref === f.id, { direction: 'in' })
    expect(ack.applied).toBeUndefined()
    await sleep(300) // timing-ok: negative window, from the card shown: nothing is applied behind it
    expect(jobs(h)).toEqual([])
    expect(pendingCards(h)).toHaveLength(1)
  })
})

describe('how old a Save may be: the 10 minutes a tap on a card may wait', () => {
  // MAX_RESOLVE_AGE_MS (cards-ledger.ts), the ledger's rule on the owner's signed time. schedule.run_now and schedule.control use
  // STALE_MS, 2 minutes, a different number for different frames; a Save is the tap it replaces, so it follows the tap.
  test("the number is the ledger's 10 minutes", () => {
    expect(MAX_RESOLVE_AGE_MS).toBe(10 * 60_000)
  })

  test('a create just inside it applies at once', async () => {
    h = await startSched()
    const f = await formSave(h, create, MAX_RESOLVE_AGE_MS - 5_000)
    const ack = await h.app.expectFrame('ack', (a) => a.ref === f.id, { direction: 'in', timeoutMs: 10_000 })
    expect(ack.applied).toBe(true)
    expect(jobs(h).map((j) => j.id)).toEqual(['nightly-sync'])
  })

  test('a create just outside it keeps its card and applies nothing; the card then works', async () => {
    h = await startSched()
    const f = await formSave(h, create, MAX_RESOLVE_AGE_MS + 5_000)
    const cc = await h.app.expectFrame('card.create', (c) => c.card.kind === 'schedule', { direction: 'in' })
    const ack = await h.app.expectFrame('ack', (a) => a.ref === f.id, { direction: 'in' })
    expect(ack.applied).toBeUndefined()
    await sleep(300) // timing-ok: negative window, from the card shown: nothing is applied behind it
    expect(jobs(h)).toEqual([])
    // the card is the old flow's: approving it applies the same change
    const token = h.relay.mintStepup(`card:${cc.card.id}`)
    await h.app.resolveCard(cc.card, 'primary', cc.card.payload_hash, { stepup_token: token })
    await h.app.expectFrame('card.update', (u) => u.card_id === cc.card.id && u.state === 'done', {
      direction: 'in',
      timeoutMs: 10_000,
    })
    expect(jobs(h).map((j) => j.id)).toEqual(['nightly-sync'])
  })

  test('an update just inside applies; just outside keeps its card and applies nothing', async () => {
    h = await startSched({ jobs: [draft()] })
    const etag = () => jobs(h)[0]?.etag as string
    const inside = await formSave(
      h,
      { op: 'update', id: 'daily-digest', base_etag: etag(), set: { name: 'Inside' } },
      MAX_RESOLVE_AGE_MS - 5_000,
    )
    expect(
      (await h.app.expectFrame('ack', (a) => a.ref === inside.id, { direction: 'in', timeoutMs: 10_000 })).applied,
    ).toBe(true)
    expect(jobs(h)[0]?.name).toBe('Inside')
    const outside = await formSave(
      h,
      { op: 'update', id: 'daily-digest', base_etag: etag(), set: { name: 'Outside' } },
      MAX_RESOLVE_AGE_MS + 5_000,
    )
    await h.app.expectFrame('card.create', (c) => c.card.kind === 'schedule', { direction: 'in' })
    expect((await h.app.expectFrame('ack', (a) => a.ref === outside.id, { direction: 'in' })).applied).toBeUndefined()
    await sleep(300) // timing-ok: negative window, from the card shown: nothing is applied behind it
    expect(jobs(h)[0]?.name).toBe('Inside')
  })

  test('a Save signed days ago (the relay held it, or the Mac slept) never creates a full-permissions job', async () => {
    h = await startSched()
    await formSave(h, create, 3 * 24 * 3600_000)
    await h.app.expectFrame('card.create', (c) => c.card.kind === 'schedule', { direction: 'in' })
    await sleep(300) // timing-ok: negative window, from the card shown: nothing is applied behind it
    expect(jobs(h)).toEqual([])
  })
})

describe("nothing but the owner's signed frame can produce it", () => {
  test('the signature covers the field: it is in the signed text', async () => {
    h = await startSched()
    const signed = await h.app.sign({
      ...mkFrame('schedule.patch'),
      change: create,
      thread_id: 'general',
      form_save: true,
    })
    expect(ownerSignedString(signed)).toContain('"form_save":true')
    // and what the relay adds (relay) or the owner's step-up (stepup_token) is outside it, as always
    expect(ownerSignedString({ ...signed, relay: { seq: 1, received_at: '2026-01-01T00:00:00.000Z' } })).toBe(
      ownerSignedString(signed),
    )
  })

  test('a frame without the field that the relay or anyone adds it to after signing fails the signature', async () => {
    h = await startSched()
    const signed = await h.app.sign({ ...mkFrame('schedule.patch'), change: create, thread_id: 'general' })
    h.relay.sendToBridge({ ...signed, form_save: true })
    const err = await h.relay.expectFrame('error', (e) => e.ref === signed.id, { direction: 'from_bridge' })
    expect(err.code).toBe('sig_invalid')
    await sleep(300) // timing-ok: negative window, from the refusal: nothing is written or drawn
    expect(jobs(h)).toEqual([])
    expect(cardsSeen(h)).toHaveLength(0)
  })

  test('an unsigned frame with the field is refused', async () => {
    h = await startSched()
    const raw = { ...mkFrame('schedule.patch'), change: create, thread_id: 'general', form_save: true }
    h.relay.sendToBridge(raw)
    await sleep(500) // timing-ok: negative window: no answer is a success only if nothing was written or drawn
    expect(jobs(h)).toEqual([])
    expect(cardsSeen(h)).toHaveLength(0)
  })

  test('a frame signed by a key that is not an enrolled device, with the field, is refused', async () => {
    h = await startSched()
    const stranger = await createDeviceKey()
    const raw = await signOwnerFrame(
      {
        ...mkFrame('schedule.patch'),
        device_id: stranger.deviceId,
        change: create,
        thread_id: 'general',
        form_save: true,
      },
      stranger.privateKey,
    )
    h.relay.sendToBridge(raw)
    const err = await h.relay.expectFrame('error', (e) => e.ref === raw.id, { direction: 'from_bridge' })
    expect(err.code).toBe('sig_invalid')
    expect(jobs(h)).toEqual([])
    expect(cardsSeen(h)).toHaveLength(0)
  })

  test("the agent's schedule_propose never applies: it is a card to approve, whatever it passes", async () => {
    h = await startSched()
    const res = await h.bridge.callTool('schedule_propose', {
      op: 'create',
      thread_id: 'general',
      reason: 'The owner asked for a nightly sync.',
      name: 'Nightly Sync',
      when: { type: 'weekdays', time: '22:00' },
      prompt: 'Sync the notes folder.\n',
      form_save: true, // an argument the tool does not have; it must change nothing
    })
    expect(res.content[0]?.text).toMatch(/pending/)
    await eventually(() => expect(pendingCards(h)).toHaveLength(1))
    await sleep(300) // timing-ok: negative window, from the card shown: nothing is applied behind it
    expect(jobs(h)).toEqual([])
  })

  test("a linked agent's message carrying a would-be Save is only text from outside: nothing is written or drawn", async () => {
    h = await startSched()
    const now = new Date(h.clock.now()).toISOString()
    // the real shape of a peer.message frame at the bridge (an unknown connection is consumed and not shown)
    const peer = {
      v: 1,
      type: 'peer.message',
      id: mkFrame('ping').id,
      ts: now,
      conn_id: 'cn_unknownunknownunknown',
      peer: 'work',
      msg: {
        v: 1,
        id: `msg_${'1'.repeat(26)}`,
        from: 'linked',
        label: 'TASK',
        text: JSON.stringify({ type: 'schedule.patch', change: create, thread_id: 'general', form_save: true }),
        chain: 0,
        from_peer_task: false,
        sent_at: now,
      },
    }
    h.relay.sendToBridge(peer)
    await sleep(500) // timing-ok: negative window: nothing the peer wrote may write or draw anything
    expect(jobs(h)).toEqual([])
    expect(cardsSeen(h)).toHaveLength(0)
    expect(pendingCards(h)).toEqual([])
  })

  test('the field is read in one place only, the owner path, and the agent path does not read it', () => {
    const src = readFileSync(new URL('../../src/schedules/service-frames.ts', import.meta.url), 'utf8')
    expect(src.match(/\bf\.form_save\b/g)).toHaveLength(1)
    const propose = readFileSync(new URL('../../src/schedules/service-propose.ts', import.meta.url), 'utf8')
    expect(propose).not.toContain('form_save')
  })
})
