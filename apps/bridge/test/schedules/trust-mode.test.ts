// Trust mode and Schedules (docs/SECURITY.md "Trust mode"): every change still draws a card, low (a tap, no passkey).
// Real bridge, real Chronos in a temp HOME.
import { afterEach, describe, expect, test } from 'bun:test'
import type { CardT } from '@talos-app/protocol'
import { draft, longTimeouts, type SchedHarness, sleep, startSched, waitFor } from './harness.ts'

longTimeouts()

let h = undefined as unknown as SchedHarness
afterEach(async () => {
  await h?.stop()
  h = undefined as unknown as SchedHarness
})

const ON = <T extends object>(c: T) => ({ ...c, trust_mode: true })
const create = (extra: Record<string, unknown> = {}) => ({
  op: 'create',
  thread_id: 'general',
  reason: 'The owner asked for a nightly sync.',
  name: 'Nightly Sync',
  when: { type: 'weekdays', time: '22:00' },
  prompt: 'Sync the notes folder.\n',
  ...extra,
})
const jobs = (x: SchedHarness) =>
  x.box.api<{ schedules: Array<{ id: string }> }>(['snapshot']).schedules.map((s) => s.id)
const scheduleCards = (x: SchedHarness) =>
  x.relay.frames
    .filter((r) => r.direction === 'from_bridge' && r.raw.type === 'card.create')
    .map((r) => r.raw.card as CardT)
    .filter((c) => c.kind === 'schedule')
async function ownerSays(x: SchedHarness, thread = 'general') {
  await x.app.sendMessage(thread, 'please set up a nightly sync')
  await waitFor(
    () => x.bridge.ctx.store.ownerRowsSince(new Date(x.clock.now() - 60_000).toISOString(), 50).length > 0,
    4000,
    'owner row',
  )
}

describe('trust mode on: a schedule change still draws a card', () => {
  // The bridge cannot tell whether the words in a job came from the owner or from a page the agent fetched, so the owner's
  // "just asked" never skips the card. Each case below goes through the real schedule_propose tool.
  test('the owner just asked: a card is drawn (low, a tap), nothing is written, nothing is applied', async () => {
    h = await startSched({ config: ON })
    await ownerSays(h)
    const r = await h.bridge.callTool('schedule_propose', create())
    expect(r.isError, r.content[0]?.text).toBeFalsy()
    expect(r.content[0]?.text).toMatch(/pending/)
    expect(r.content[0]?.text).not.toMatch(/without a card/i)
    await waitFor(() => scheduleCards(h).length === 1, 4000, 'the card')
    expect((scheduleCards(h)[0] as CardT).risk).toBe('low')
    expect(jobs(h)).toEqual([])
  })

  test('a delete the owner just asked for draws a card too', async () => {
    h = await startSched({ config: ON, jobs: [draft()] })
    await ownerSays(h)
    const r = await h.bridge.callTool('schedule_propose', {
      op: 'delete',
      thread_id: 'general',
      reason: 'Not needed.',
      id: 'daily-digest',
    })
    expect(r.content[0]?.text).toMatch(/pending/)
    await waitFor(() => scheduleCards(h).length === 1, 4000, 'the card')
    expect(jobs(h)).toContain('daily-digest')
  })

  test('approving the card writes the job (the owner taps, then it is applied)', async () => {
    h = await startSched({ config: ON })
    await ownerSays(h)
    await h.bridge.callTool('schedule_propose', create())
    await waitFor(() => scheduleCards(h).length === 1, 4000, 'the card')
    const card = scheduleCards(h)[0] as CardT
    await h.app.resolveCard(card, 'primary', card.payload_hash)
    await waitFor(() => jobs(h).includes('nightly-sync'), 8000, 'the job')
  })

  test('adopt keeps a card, low, and the job stays held until it is approved', async () => {
    h = await startSched({ config: ON, jobs: [draft()], now: '2026-10-05T10:00:00-04:00' })
    h.box.editPromptOutside('daily-digest', 'Summarise yesterday, then email everyone.\n')
    await h.advance(90_000)
    const job = h.box.api<{ schedules: Array<{ id: string; content_hash: string; today?: string }> }>(['snapshot'])
      .schedules[0]
    expect(job?.today).toBe('held')
    const f = await h.app.patchSchedule({ op: 'adopt', id: 'daily-digest', content_hash: job?.content_hash }, 'general')
    await h.app.expectFrame('ack', (a) => a.ref === f.id, { direction: 'in' })
    const cc = await h.app.expectFrame('card.create', (c) => c.card.kind === 'schedule', { direction: 'in' })
    expect(cc.card.risk).toBe('low')
    await sleep(100)
    expect(h.box.api<{ schedules: Array<{ today?: string }> }>(['snapshot']).schedules[0]?.today).toBe('held')
  })
})

describe('trust mode off', () => {
  test('the owner just asked and a card is still drawn, high, with nothing written (unchanged)', async () => {
    h = await startSched()
    await ownerSays(h)
    const r = await h.bridge.callTool('schedule_propose', create())
    expect(r.content[0]?.text).toMatch(/pending/)
    await waitFor(() => scheduleCards(h).length === 1, 4000, 'the card')
    expect((scheduleCards(h)[0] as CardT).risk).toBe('high')
    expect(jobs(h)).toEqual([])
  })
})
