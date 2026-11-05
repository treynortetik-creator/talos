// WP-S1 acceptance: the four agent tools and the instructions (S6.1, S6.2).
import { afterEach, describe, expect, test } from 'bun:test'
import {
  ATTACHMENT_BRIDGE_TOOLS,
  BRIDGE_TOOLS,
  type CardT,
  CONFIG_BRIDGE_TOOLS,
  composeScheduleCard,
  MOD_BRIDGE_TOOLS,
  newId,
  SCHEDULE_BRIDGE_TOOLS,
  ScheduleCardPayload,
} from '@talos-app/protocol'
import { INSTRUCTIONS } from '../../src/bridge.ts'
import { draft, longTimeouts, type SchedHarness, sleep, startSched } from './harness.ts'

longTimeouts()

let h = undefined as unknown as SchedHarness
afterEach(async () => {
  await h?.stop()
  h = undefined as unknown as SchedHarness
})

const wire = () => ({
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
  thread_id: null,
  prompt: 'Sync the notes folder.\n',
})

const create = (extra: Record<string, unknown> = {}) => ({
  op: 'create',
  thread_id: 'general',
  reason: 'The owner asked for a nightly sync.',
  name: 'Nightly Sync',
  when: { type: 'weekdays', time: '22:00' },
  prompt: 'Sync the notes folder.\n',
  ...extra,
})

async function proposed(x: SchedHarness, args: Record<string, unknown>) {
  const res = await x.bridge.callTool('schedule_propose', args)
  expect(res.isError, res.content[0]?.text).toBeFalsy()
  const id = /card (c_[0-9A-HJKMNP-TV-Z]{26}) pending, expires (\S+)$/.exec(res.content[0]?.text ?? '')?.[1]
  expect(id).toBeDefined()
  const cc = await x.app.expectFrame('card.create', (c) => c.card.id === id, { direction: 'in' })
  return { card: cc.card as CardT, payload: ScheduleCardPayload.parse(cc.card.payload) }
}

describe('registration', () => {
  test('the four schedule tools are registered, the original 12 are unchanged, and only schedules_list is headless', async () => {
    h = await startSched()
    const names = h.bridge.tools.map((t) => t.name)
    for (const t of [
      ...BRIDGE_TOOLS,
      ...MOD_BRIDGE_TOOLS,
      ...SCHEDULE_BRIDGE_TOOLS,
      ...CONFIG_BRIDGE_TOOLS,
      ...ATTACHMENT_BRIDGE_TOOLS,
      'handoff',
    ])
      expect(names).toContain(t)
    expect(names.length).toBe(
      BRIDGE_TOOLS.length +
        MOD_BRIDGE_TOOLS.length +
        SCHEDULE_BRIDGE_TOOLS.length +
        CONFIG_BRIDGE_TOOLS.length +
        ATTACHMENT_BRIDGE_TOOLS.length +
        1, // handoff
    )
  })

  test('the instructions carry the Schedules paragraph (S6.2)', () => {
    for (const s of [
      'schedule_propose',
      'Never create cron, launchd or in-session timer jobs',
      'kind=schedule_run',
      'schedule_run_start',
      'Agent tool',
      'standing rules and then the job text',
      'schedule_run_done',
      'kind=schedule_held',
    ])
      expect(INSTRUCTIONS).toContain(s)
  })
})

describe('schedules_list', () => {
  test('a plain-text table of every job, then the health issues; one job in full with `id`', async () => {
    h = await startSched({
      jobs: [
        draft(),
        draft({ id: 'weekly-wrap', name: 'Weekly Wrap', when: { type: 'days', days: ['fri'], time: '16:00' } }),
      ],
    })
    const res = await h.bridge.callTool('schedules_list', {})
    const text = res.content[0]?.text ?? ''
    expect(text).toContain('daily-digest')
    expect(text).toContain('Daily Digest')
    expect(text).toContain('weekly-wrap')
    expect(text).toContain(h.box.listedWhenText('daily-digest'))
    expect(text).toMatch(/session/)
    const one = await h.bridge.callTool('schedules_list', { id: 'daily-digest' })
    expect(one.content[0]?.text).toContain('Summarise yesterday and post it.')
    const none = await h.bridge.callTool('schedules_list', { id: 'nope' })
    expect(none.isError).toBe(true)
  })
})

describe('schedule_propose', () => {
  test('create: a kind:schedule card, proposed by the agent, high risk; the registry is never written', async () => {
    h = await startSched()
    const { card, payload } = await proposed(h, create())
    expect(card.kind).toBe('schedule')
    expect(card.risk).toBe('high')
    expect(card.allow_edit).toBe(false)
    expect(payload.proposed_by).toBe('agent')
    expect(payload.change.op === 'create' && payload.change.draft.id).toBe('nightly-sync') // slugged from the name
    expect(payload.change.op === 'create' && payload.change.draft.runner).toBe('session') // the default
    expect(payload.change.op === 'create' && payload.change.draft.enabled).toBe(true)
    expect(card.destination.find((d) => d.label === 'Proposed by')?.value).not.toBe('your form')
    expect(card.summary).toBe('The owner asked for a nightly sync.')
    expect(h.bridge.ctx.ledger.get(card.id)?.actor).toBe('bridge')
    expect(h.box.api<{ schedules: unknown[] }>(['snapshot']).schedules).toEqual([])
  })

  test('update fills base_etag from the live job and shows a prompt diff; delete needs only the id', async () => {
    h = await startSched({ jobs: [draft()] })
    const etag = h.box.api<{ schedules: Array<{ etag: string }> }>(['snapshot']).schedules[0]?.etag
    const up = await proposed(h, {
      op: 'update',
      thread_id: 'general',
      reason: 'Make it shorter.',
      id: 'daily-digest',
      prompt: 'Summarise yesterday in one line.\n',
    })
    expect(up.payload.change.op === 'update' && up.payload.change.base_etag).toBe(etag as string)
    expect(up.card.body).toContain('+Summarise yesterday in one line.')
    const del = await proposed(h, { op: 'delete', thread_id: 'general', reason: 'Not needed.', id: 'daily-digest' })
    expect(del.payload.change.op === 'delete' && del.payload.change.base_etag).toBe(etag as string)
    expect(del.payload.expected_etag).toBeNull()
  })

  test('validation errors come back verbatim, with field paths, and no card is minted', async () => {
    h = await startSched()
    const bad = await h.bridge.callTool('schedule_propose', create({ permissions: 'restricted', runner: 'session' }))
    expect(bad.isError).toBe(true)
    expect(bad.content[0]?.text).toMatch(/runner|permissions/)
    const badWhen = await h.bridge.callTool('schedule_propose', create({ when: { type: 'daily', time: '25:99' } }))
    expect(badWhen.isError).toBe(true)
    expect(badWhen.content[0]?.text).toContain('when')
    const noName = await h.bridge.callTool('schedule_propose', create({ name: undefined }))
    expect(noName.isError).toBe(true)
    await sleep(100)
    expect(h.app.rec.frames.some((r) => r.direction === 'in' && r.raw.type === 'card.create')).toBe(false)
  })

  test('an unknown thread is refused with the valid ids', async () => {
    h = await startSched()
    const r = await h.bridge.callTool('schedule_propose', create({ thread_id: 'nope' }))
    expect(r.isError).toBe(true)
    expect(r.content[0]?.text).toContain('general')
  })

  test('result_thread_id is bound into the card; an update of an unknown job is not found', async () => {
    h = await startSched()
    const { payload } = await proposed(h, create({ result_thread_id: 'inbox' }))
    expect(payload.change.op === 'create' && payload.change.draft.thread_id).toBe('inbox')
    const r = await h.bridge.callTool('schedule_propose', {
      op: 'update',
      thread_id: 'general',
      reason: 'x',
      id: 'ghost',
      name: 'Boo',
    })
    expect(r.isError).toBe(true)
    expect(r.content[0]?.text).toMatch(/not.found|no scheduled job/i)
  })

  test('at most 10 proposals an hour', async () => {
    h = await startSched()
    for (let i = 0; i < 10; i++) {
      const r = await h.bridge.callTool('schedule_propose', create({ name: `Job ${i}`, id: `job-${i}` }))
      expect(r.isError, r.content[0]?.text).toBeFalsy()
    }
    const r = await h.bridge.callTool('schedule_propose', create({ name: 'Job 11', id: 'job-11' }))
    expect(r.isError).toBe(true)
    expect(r.content[0]?.text).toContain('10 proposals an hour')
    await h.advance(61 * 60_000)
    const later = await h.bridge.callTool('schedule_propose', create({ name: 'Job 12', id: 'job-12' }))
    expect(later.isError, later.content[0]?.text).toBeFalsy()
  })

  test('no more than 20 schedule cards pending', async () => {
    h = await startSched()
    // twenty pending bridge-owned schedule cards, written through the real ledger
    for (let i = 0; i < 20; i++) {
      const c = composeScheduleCard(
        { op: 'create', draft: { ...wire(), id: `job-${i}`, name: `Job ${i}` } as never },
        { when_text: 'Weekdays at 10:00 PM', next_runs: [], tz: 'America/New_York' },
        null,
        {
          cardId: newId('c'),
          threadId: 'general',
          now: new Date(h.clock.now()).toISOString(),
          origin: 'chat',
          proposedBy: 'agent',
          agentName: 'Agent',
          expectedEtag: null,
          clientRef: null,
          threadName: () => 'General',
          base: null,
        },
      )
      h.bridge.ctx.ledger.create(c, 'bridge')
    }
    const r = await h.bridge.callTool('schedule_propose', create({ name: 'Job 21', id: 'job-21' }))
    expect(r.isError).toBe(true)
    expect(r.content[0]?.text).toContain('20 schedule cards')
  })

  test('supersedes replaces an earlier card; origin follows whether the owner just spoke in the thread', async () => {
    h = await startSched()
    const first = await proposed(h, create())
    await h.app.sendMessage('general', 'make it 9pm instead')
    await h.waitNotes(1)
    const second = await proposed(h, create({ when: { type: 'weekdays', time: '21:00' }, supersedes: first.card.id }))
    expect(second.card.supersedes).toBe(first.card.id)
    expect(h.bridge.ctx.ledger.get(first.card.id)?.state).toBe('superseded')
    // the owner spoke in `general` moments ago: a chat card (24 h); nobody spoke in `inbox`: background (also 24 h since O2)
    expect(second.card.origin).toBe('chat')
    const bg = await proposed(h, create({ thread_id: 'inbox', name: 'Quiet one', id: 'quiet-one' }))
    expect(bg.card.origin).toBe('background')
    expect(Date.parse(bg.card.expires_at) - Date.parse(bg.card.created_at)).toBe(86_400_000)
  })

  test('until the relay lists schedules/1 the agent cannot mint a schedule card', async () => {
    h = await startSched({ relay: { relayFeatures: [] } })
    const r = await h.bridge.callTool('schedule_propose', create())
    expect(r.isError).toBe(true)
    expect(r.content[0]?.text).toContain("relay doesn't support Schedules yet")
  })

  test("with Chronos's own timers still armed (session_runner hook) there are no proposals", async () => {
    h = await startSched({ sessionRunner: 'hook', approvalRequired: false })
    const r = await h.bridge.callTool('schedule_propose', create())
    expect(r.isError).toBe(true)
    expect(r.content[0]?.text).toContain('talos-app schedules adopt')
  })
})

describe('schedule_run_start / schedule_run_done', () => {
  test('an unknown run id is a SKIP / not yours, never a claim', async () => {
    h = await startSched({ jobs: [draft()] })
    const s = await h.bridge.callTool('schedule_run_start', { run_id: 'r_01JBF3V7Q8K2M4N6P8R0S2T4V6' })
    expect(s.isError).toBe(true)
    expect(s.content[0]?.text).toContain('unknown run')
    const d = await h.bridge.callTool('schedule_run_done', {
      run_id: 'r_01JBF3V7Q8K2M4N6P8R0S2T4V6',
      ok: true,
      summary: 'x',
    })
    expect(d.content[0]?.text).toMatch(/^not yours:/)
  })

  test('summary is required and capped at 280 characters', async () => {
    h = await startSched({ jobs: [draft()] })
    const r = await h.bridge.callTool('schedule_run_done', { run_id: 'r_x', ok: true, summary: 'x'.repeat(281) })
    expect(r.isError).toBe(true)
  })
})
