// A schedule card proposed by a thread's own session (docs/OPTION-C.md "Thread schedules"): it names that session, says where
// the job runs, and uses Approve / Not now. A card from main or the owner's form is byte-identical to before.
import { describe, expect, it } from 'vitest'
import {
  bindingFrom,
  CardCreateFrame,
  type ComposeScheduleCardOpts,
  composeScheduleCard,
  payloadHash,
  runsInSession,
  type ScheduleChangeT,
  type ScheduleT,
} from '../src/index.ts'
import { loadFixtures } from './helpers.ts'

const fixtures = loadFixtures()
const snap = (fixtures['schedules.snapshot'] as { snapshot: { schedules: ScheduleT[] } }).snapshot
const base = snap.schedules.find((s) => s.id === 'daily-digest') as ScheduleT
const PROMPT = '\n  Summarise yesterday and post it.\nThen list open items.\n'
const preview = { when_text: 'Weekdays at 7:40 AM', next_runs: ['2026-10-06T07:40:00-04:00'], tz: 'America/New_York' }
const opts = (o: Partial<ComposeScheduleCardOpts> = {}): ComposeScheduleCardOpts => ({
  cardId: 'c_01JBF3V7Q8K2M4N6P8R0S2T4CC',
  threadId: 'trip',
  now: '2026-10-05T11:45:00.000Z',
  origin: 'chat',
  proposedBy: 'agent',
  agentName: 'Talos',
  expectedEtag: `sha256:${'2'.repeat(64)}`,
  clientRef: null,
  threadName: (id) => (id === null ? 'General (default)' : id === 'trip' ? 'Trip' : id),
  base: null,
  ...o,
})
const create: ScheduleChangeT = {
  op: 'create',
  draft: {
    id: 'packing-check',
    name: 'Packing check',
    description: '',
    when: { type: 'weekdays', time: '07:40' },
    catchup_min: 180,
    enabled: true,
    runner: 'session',
    permissions: 'full',
    allowed_tools: [],
    model: null,
    notify: 'failure',
    thread_id: 'trip',
    prompt: PROMPT,
  },
}
const rows = (c: ReturnType<typeof composeScheduleCard>) =>
  Object.fromEntries(c.destination.map((d) => [d.label, d.value]))

describe("a thread session's schedule card", () => {
  it('names the session, where the job runs, when and what it does; Approve / Not now', () => {
    const c = composeScheduleCard(create, preview, null, opts({ sessionName: 'Trip' }))
    expect(c.title).toBe("Trip's session wants to schedule Packing check")
    expect(c.primary_label).toBe('Approve')
    expect(c.kill_label).toBe('Not now')
    expect(rows(c)).toMatchObject({
      'Runs in': "This thread's own session (wakes it if parked), or Main if that session can't take it",
      When: 'Weekdays at 7:40 AM',
      Does: 'Summarise yesterday and post it.',
      'Proposed by': "Trip's session",
      'Posts to': 'Trip',
    })
    expect(c.destination.length).toBeLessThanOrEqual(6)
  })

  it('stays inside the card limits and the hash still binds what is shown', () => {
    const c = composeScheduleCard(create, preview, null, opts({ sessionName: 'T'.repeat(500) }))
    expect(CardCreateFrame.shape.card.safeParse(c).success).toBe(true)
    expect(c.title.length).toBeLessThanOrEqual(120)
    expect(c.payload_hash).toBe(payloadHash(bindingFrom(c)))
    const long = composeScheduleCard(
      { ...create, draft: { ...create.draft, prompt: `${'x'.repeat(600)}\n` } },
      preview,
      null,
      opts({ sessionName: 'Trip' }),
    )
    expect((rows(long).Does as string).length).toBeLessThanOrEqual(200)
  })

  it('a delete says what stops, a change says "change"', () => {
    const b = { schedule: base, prompt: 'Post the digest.\n', guard: null }
    const del = composeScheduleCard(
      { op: 'delete', id: base.id, base_etag: base.etag },
      preview,
      null,
      opts({ sessionName: 'Trip', base: b }),
    )
    expect(del.title).toBe(`Trip's session wants to delete ${base.name}`)
    expect(rows(del).Does).toBe('Stops running: Post the digest.')
    const upd = composeScheduleCard(
      { op: 'update', id: base.id, base_etag: base.etag, set: { name: 'Renamed' } },
      preview,
      null,
      opts({ sessionName: 'Trip', base: b }),
    )
    expect(upd.title).toBe("Trip's session wants to change Renamed")
    expect(rows(upd).Does).toBe('Post the digest.')
  })

  it('never claims "own session" for a job that does not run in a session', () => {
    for (const runner of ['headless', 'both'] as const) {
      const c = composeScheduleCard(
        { ...create, draft: { ...create.draft, runner: runner as 'headless' } },
        preview,
        null,
        opts({ sessionName: 'Trip' }),
      )
      expect(rows(c)['Runs in'], runner).not.toContain('own session')
      expect(rows(c)['Runs in'], runner).toMatch(/background/i)
    }
  })

  it('a session job with restricted permissions is headless, so its card never says "own session"', () => {
    const c = composeScheduleCard(
      { ...create, draft: { ...create.draft, permissions: 'restricted', allowed_tools: ['Read'] } },
      preview,
      null,
      opts({ sessionName: 'Trip' }),
    )
    expect(rows(c)['Runs in']).not.toContain('own session')
    expect(runsInSession({ runner: 'session', permissions: 'restricted' })).toBe(false)
    expect(runsInSession({ runner: 'session', permissions: 'full' })).toBe(true)
    expect(runsInSession({ runner: 'headless', permissions: 'full' })).toBe(false)
  })

  it('without a session name the card is exactly what it was', () => {
    const c = composeScheduleCard(create, preview, null, opts())
    expect(c.title).toBe('New scheduled job: Packing check')
    expect(c.primary_label).toBe('Create job')
    expect(c.kill_label).toBe('Kill new job')
    expect(Object.keys(rows(c))).toEqual(['Runs', 'Next', 'As', 'Where', 'Posts to', 'Proposed by'])
    expect(rows(c)['Proposed by']).toBe('Talos')
  })
})
