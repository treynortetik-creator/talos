// Property: a schedule card (title 120, reason 280, thread and session names 500, the delete card's "Does" line 500) is
// hashable whatever well-formed text the owner or the agent gave, including an emoji at the point where each is cut.
import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import {
  type ComposeScheduleCardOpts,
  composeScheduleCard,
  payloadHash,
  type ScheduleChangeT,
  type ScheduleT,
} from '../src/index.ts'
import { loadFixtures } from './helpers.ts'

const fixtures = loadFixtures()
const snap = (fixtures['schedules.snapshot'] as { snapshot: { schedules: ScheduleT[] } }).snapshot
const base = snap.schedules.find((s) => s.id === 'daily-digest') as ScheduleT
const preview = {
  when_text: 'Weekdays at 7:30 AM',
  next_runs: ['2026-10-06T07:30:00-04:00'],
  tz: 'America/New_York',
}
const wellFormed = (s: string) => !/[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/.test(s)
/** `n` letters then emoji: for the right n the cut falls inside an emoji. */
const near = (cut: number, spread = 12) =>
  fc
    .tuple(fc.integer({ min: cut - spread, max: cut }), fc.integer({ min: 2, max: 6 }))
    .map(([n, e]) => `${'n'.repeat(Math.max(0, n))}${'\u{1F600}'.repeat(e)}`)

const opts = (o: Partial<ComposeScheduleCardOpts>): ComposeScheduleCardOpts => ({
  cardId: 'c_01JBF3V7Q8K2M4N6P8R0S2T4CC',
  threadId: 'general',
  now: '2026-10-05T11:45:00.000Z',
  origin: 'chat',
  proposedBy: 'agent',
  agentName: 'Talos',
  expectedEtag: `sha256:${'2'.repeat(64)}`,
  clientRef: null,
  threadName: () => 'General',
  base: { schedule: base, prompt: 'Summarise yesterday.\n', guard: null },
  ...o,
})
const create = (name: string, prompt: string): ScheduleChangeT => ({
  op: 'create',
  draft: {
    id: 'new-job',
    name,
    description: '',
    when: { type: 'daily', time: '09:00' },
    catchup_min: 60,
    enabled: true,
    runner: 'headless',
    permissions: 'restricted',
    allowed_tools: ['Read'],
    model: null,
    notify: 'failure',
    thread_id: null,
    prompt,
  },
})

describe('a schedule card for text cut at an emoji', () => {
  it('title, reason, thread name and session name: the card is well-formed and hashes', () => {
    fc.assert(
      fc.property(
        near(110),
        near(270),
        near(490),
        near(490),
        fc.boolean(),
        (name, reason, thread, session, asSession) => {
          const card = composeScheduleCard(
            create(name, 'Do the thing.\n'),
            preview,
            null,
            opts({
              base: null,
              reason,
              threadName: () => thread,
              ...(asSession ? { sessionName: session } : {}),
            }),
          )
          expect(() => payloadHash({ ...card } as never)).not.toThrow()
          for (const s of [card.title, card.summary ?? '', ...card.destination.map((d) => d.value)])
            expect(wellFormed(s)).toBe(true)
        },
      ),
      { seed: 20261122, numRuns: 400 },
    )
  })

  it('the "Does" line of a delete card, cut at 200 and 500', () => {
    fc.assert(
      fc.property(near(199, 6), (line) => {
        const card = composeScheduleCard(
          { op: 'delete', id: base.id, base_etag: base.etag } as ScheduleChangeT,
          preview,
          null,
          opts({ sessionName: 'Trip', base: { schedule: base, prompt: line, guard: null } }),
        )
        for (const d of card.destination) expect(wellFormed(d.value)).toBe(true)
      }),
      { seed: 20261123, numRuns: 400 },
    )
  })
})
