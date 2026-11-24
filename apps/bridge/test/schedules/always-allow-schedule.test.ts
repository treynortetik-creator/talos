// "Always allow schedule changes", end to end through schedule_propose (owner 2026-11-21): the grant covers LOW-risk schedule cards
// only. A high one (a new prompt, full permissions, more tools, a job turned on or created) still gets a card.
import { afterEach, describe, expect, test } from 'bun:test'
import type { CardT } from '@talos-app/protocol'
import { draft, longTimeouts, type SchedHarness, startSched } from './harness.ts'

longTimeouts()

let h = undefined as unknown as SchedHarness
afterEach(async () => {
  await h?.stop()
  h = undefined as unknown as SchedHarness
})

const granted = {
  config: ((c: object) => ({ ...c, always_allow: [{ kind: 'schedule', destination: null }] })) as never,
}
const update = (set: Record<string, unknown>) => ({
  op: 'update',
  id: 'daily-digest',
  thread_id: 'general',
  reason: 'The owner asked.',
  ...set,
})
const scheduleCards = (x: SchedHarness) =>
  x.relay.frames
    .filter((r) => r.direction === 'from_bridge' && r.raw.type === 'card.create')
    .map((r) => r.raw.card as CardT)
    .filter((c) => c.kind === 'schedule')

describe('a schedule grant', () => {
  test('a low-risk change (a rename) passes without a card', async () => {
    h = await startSched({ jobs: [draft()], ...granted })
    const r = await h.bridge.callTool('schedule_propose', update({ name: 'Morning Digest' }))
    expect(r.isError, r.content[0]?.text).toBeFalsy()
    expect(r.content[0]?.text).toMatch(/approved without a card/)
    expect(scheduleCards(h)).toHaveLength(0)
  })

  test.each([
    ['a new prompt', { prompt: 'Something else entirely.\n' }],
    ['a new tool', { allowed_tools: ['Read'] }],
    ['a job turned on', { enabled: true }],
  ])('a high-risk change (%s) still gets a card', async (_name, set) => {
    // a job that is off, so "turn on" is a change at all
    h = await startSched({ jobs: [draft({ enabled: false })], ...granted })
    const r = await h.bridge.callTool('schedule_propose', update(set))
    expect(r.isError, r.content[0]?.text).toBeFalsy()
    expect(r.content[0]?.text).toMatch(/pending/)
    expect(r.content[0]?.text).not.toMatch(/approved without a card/)
    const cards = scheduleCards(h)
    expect(cards).toHaveLength(1)
    expect(cards[0]?.risk).toBe('high')
  })

  test.each([
    ['a new prompt', { prompt: 'Something else entirely.\n' }],
    ['a job turned on', { enabled: true }],
    ['full permissions', { permissions: 'full' }],
  ])('trust mode on: a high-risk change (%s) still gets a card, though trust mints it low', async (_n, set) => {
    h = await startSched({
      jobs: [draft({ enabled: false, runner: 'headless', permissions: 'restricted' })],
      config: ((c: object) => ({
        ...c,
        trust_mode: true,
        always_allow: [{ kind: 'schedule', destination: null }],
      })) as never,
    })
    const r = await h.bridge.callTool('schedule_propose', update(set))
    expect(r.isError, r.content[0]?.text).toBeFalsy()
    expect(r.content[0]?.text).not.toMatch(/approved without a card/)
    const cards = scheduleCards(h)
    expect(cards).toHaveLength(1)
    expect(cards[0]?.risk).toBe('low') // the trust-mode risk, which is why the grant must not read it
    expect((cards[0]?.payload as { own_risk?: string } | undefined)?.own_risk).toBe('high')
  })

  test('trust mode on: a low-risk change still passes', async () => {
    h = await startSched({
      jobs: [draft()],
      config: ((c: object) => ({
        ...c,
        trust_mode: true,
        always_allow: [{ kind: 'schedule', destination: null }],
      })) as never,
    })
    const r = await h.bridge.callTool('schedule_propose', update({ name: 'Morning Digest' }))
    expect(r.content[0]?.text).toMatch(/approved without a card/)
  })

  test('without the grant the low-risk change is a card too', async () => {
    h = await startSched({ jobs: [draft()] })
    const r = await h.bridge.callTool('schedule_propose', update({ name: 'Morning Digest' }))
    expect(r.content[0]?.text).toMatch(/pending/)
  })
})
