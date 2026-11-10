// Job memory (docs/SCHEDULES.md "Job memory"): a per-job opt-in, off by default. It is a Talos-only field, like the result
// thread: it rides in the draft and the update's `set`, shows on the approval card, and never reaches the scheduler's files.
import { describe, expect, it } from 'vitest'
import {
  type ComposeScheduleCardOpts,
  changeNeedsSchedulesV2,
  composeScheduleCard,
  fromChronosChange,
  needsSchedulesV2,
  Schedule,
  ScheduleChange,
  type ScheduleChangeT,
  type ScheduleT,
  scheduleCardRisk,
  scheduleFromChronos,
  toChronosChange,
} from '../src/index.ts'
import { loadFixtures } from './helpers.ts'

type ChronosMemory = NonNullable<ComposeScheduleCardOpts['chronosMemory']>
const snap = (loadFixtures()['schedules.snapshot'] as { snapshot: { schedules: ScheduleT[] } }).snapshot
const plain = snap.schedules.find((s) => s.id === 'daily-digest') as ScheduleT
const preview = { when_text: 'Every day at 7:30 AM', next_runs: ['2026-10-06T07:30:00-04:00'], tz: 'America/New_York' }
const opts = (base: ScheduleT | null, chronosMemory?: ChronosMemory): ComposeScheduleCardOpts => ({
  cardId: 'c_01JBF3V7Q8K2M4N6P8R0S2T4CC',
  threadId: 'general',
  now: '2026-10-05T11:45:00.000Z',
  origin: 'chat',
  proposedBy: 'owner_form',
  agentName: 'Talos',
  expectedEtag: `sha256:${'2'.repeat(64)}`,
  clientRef: null,
  threadName: () => 'General',
  base: base ? { schedule: base, prompt: 'Summarise yesterday.\n', guard: null } : null,
  ...(chronosMemory === undefined ? {} : { chronosMemory }),
})
const draft = (over: Record<string, unknown> = {}) => ({
  id: 'daily-digest',
  name: 'Daily Digest',
  description: '',
  when: { type: 'daily', time: '07:30' },
  catchup_min: 180,
  enabled: true,
  runner: 'session',
  permissions: 'full',
  allowed_tools: [],
  model: null,
  notify: 'failure',
  thread_id: null,
  prompt: 'Summarise yesterday.\n',
  ...over,
})
const create = (over: Record<string, unknown> = {}) => ScheduleChange.parse({ op: 'create', draft: draft(over) })
const update = (set: Record<string, unknown>) =>
  ScheduleChange.parse({ op: 'update', id: plain.id, base_etag: plain.etag, set })

describe('memory is off unless it is switched on', () => {
  it('a job from before the field existed reads as off, and a draft without it is valid', () => {
    expect(Schedule.safeParse(plain).success).toBe(true)
    expect(plain.memory).toBeUndefined()
    const c = create()
    expect(c.op === 'create' && c.draft.memory).toBeUndefined()
  })

  it('memory is a boolean when present, and nothing else', () => {
    expect(ScheduleChange.safeParse({ op: 'create', draft: draft({ memory: true }) }).success).toBe(true)
    expect(ScheduleChange.safeParse({ op: 'create', draft: draft({ memory: false }) }).success).toBe(true)
    expect(ScheduleChange.safeParse({ op: 'create', draft: draft({ memory: 'yes' }) }).success).toBe(false)
    expect(
      ScheduleChange.safeParse({ op: 'update', id: 'x-1', base_etag: plain.etag, set: { memory: 1 } }).success,
    ).toBe(false)
  })

  it('scheduleFromChronos reports memory only when the bridge says it is on (the field stays absent otherwise)', () => {
    const job = {
      ...(JSON.parse(JSON.stringify(plain)) as object),
    } as never
    expect('memory' in scheduleFromChronos(job, { thread_id: null, offerAgeS: null })).toBe(false)
    expect(scheduleFromChronos(job, { thread_id: null, offerAgeS: null, memory: true }).memory).toBe(true)
  })
})

describe('memory is Talos-only: it never goes to the scheduler', () => {
  it('toChronosChange takes it out of a draft and out of a set, and fromChronosChange puts it back', () => {
    const c = create({ memory: true })
    const split = toChronosChange(c)
    expect(JSON.stringify(split.chronos)).not.toContain('memory')
    expect(split.memory).toEqual({ set: true, value: true })
    const back = fromChronosChange(split.chronos, split.threadId, split.memory)
    expect(back.op === 'create' && back.draft.memory).toBe(true)

    const u = update({ memory: false })
    const us = toChronosChange(u)
    expect(JSON.stringify(us.chronos)).not.toContain('memory')
    expect(us.memory).toEqual({ set: true, value: false })
    const ub = fromChronosChange(us.chronos, us.threadId, us.memory)
    expect(ub.op === 'update' && ub.set.memory).toBe(false)
  })

  it('a change that does not mention memory splits exactly as before', () => {
    const split = toChronosChange(create())
    expect('memory' in split).toBe(false)
    const back = fromChronosChange(split.chronos, split.threadId)
    expect(back.op === 'create' && 'memory' in back.draft).toBe(false)
    const us = toChronosChange(update({ name: 'Morning' }))
    expect('memory' in us).toBe(false)
  })
})

describe('the approval card shows the toggle', () => {
  // A schedule card already fills the six destination rows a card may have, so memory is a line of the body.
  const card = (c: ScheduleChangeT, base: ScheduleT | null, chronosMemory?: ChronosMemory) =>
    composeScheduleCard(c, preview, null, opts(base, chronosMemory))
  const memoryLine = (c: ScheduleChangeT, base: ScheduleT | null, chronosMemory?: ChronosMemory) =>
    (card(c, base, chronosMemory).body ?? '').split('\n').find((l) => l.startsWith('Memory:'))

  it('a new job with memory on has a Memory line that says what it keeps', () => {
    const line = memoryLine(create({ memory: true }), null)
    expect(line).toMatch(/^Memory: on\b/)
    expect(line).toContain('last 3 results')
    expect(line).toContain('2 KB')
  })

  it('a new unrestricted background job keeps notes, and its card says it runs unattended with full permissions', () => {
    const c = card(create({ memory: true, runner: 'headless' }), null)
    expect(memoryLine(create({ memory: true, runner: 'headless' }), null)).toMatch(
      /^Memory: on \(keeps its last 3 results and a notepad of up to 2 KB between runs\)/,
    )
    expect(c.body ?? '').toMatch(/unattended[^\n]*full permissions/i)
    expect(c.body ?? '').not.toContain('does not get memory')
  })

  it('a restricted job reads past results and cannot keep notes; its card does not claim full permissions', () => {
    const d = { memory: true, runner: 'headless', permissions: 'restricted', allowed_tools: ['Read'] }
    const c = card(create(d), null)
    expect(memoryLine(create(d), null)).toMatch(/reads its last 3 results; can't keep notes/)
    expect(c.body ?? '').not.toMatch(/full permissions/i)
    expect(c.body ?? '').not.toContain('notepad')
  })

  it('a Chronos without the memory feature: the card says plainly it needs a newer Chronos, only for background jobs', () => {
    expect(card(create({ memory: true, runner: 'headless' }), null, 'too_old').body ?? '').toContain('newer Chronos')
    expect(card(create({ memory: true, runner: 'headless' }), null, 'ok').body ?? '').not.toContain('newer Chronos')
    expect(card(create({ memory: true }), null, 'too_old').body ?? '').not.toContain('newer Chronos')
  })

  it('a job with memory off (or never set) has no Memory line, and its card has the six rows it always had', () => {
    expect(memoryLine(create(), null)).toBeUndefined()
    expect(memoryLine(create({ memory: false }), null)).toBeUndefined()
    expect(card(create({ memory: true }), null).destination.length).toBeLessThanOrEqual(6)
  })

  it('an edit that switches it on is HIGH risk, says "off → on" and says what it widens; switching it off is low risk', () => {
    const c = card(update({ memory: true }), plain)
    expect(c.body ?? '').toContain('Memory: off → on')
    expect(c.body ?? '').toContain("Future runs will see the last 3 results and this job's notepad.")
    expect(c.risk).toBe('high')
    expect(scheduleCardRisk(update({ memory: true }), { schedule: plain, prompt: '', guard: null })).toBe('high')
    const on = { ...plain, memory: true } as ScheduleT
    const off = card(update({ memory: false }), on)
    expect(off.body ?? '').toContain('Memory: on → off')
    expect(off.body ?? '').not.toContain('Future runs will see')
    expect(off.risk).toBe('low')
  })

  it('switching it on for a job that has it on already is not a widening', () => {
    const on = { ...plain, memory: true } as ScheduleT
    expect(scheduleCardRisk(update({ memory: true }), { schedule: on, prompt: '', guard: null })).toBe('low')
  })

  it('a new job with memory on says the same thing, and an edit that puts a job in the background says what it gets there', () => {
    expect(card(create({ memory: true }), null).body ?? '').toContain(
      "Future runs will see the last 3 results and this job's notepad.",
    )
    const restricted = { ...plain, permissions: 'restricted', runner: 'headless' } as ScheduleT
    expect(memoryLine(update({ memory: true }), restricted)).toMatch(/can't keep notes/)
    const headless = { ...plain, runner: 'headless' } as ScheduleT
    expect(card(update({ memory: true }), headless).body ?? '').toMatch(/unattended[^\n]*full permissions/i)
    expect(card(update({ memory: true }), plain).body ?? '').not.toMatch(/unattended/i)
    expect(card(update({ memory: true, runner: 'headless' }), plain).body ?? '').toMatch(/unattended/i)
  })

  it('no Chronos at all is said differently from one that is too old', () => {
    const missing = card(create({ memory: true, runner: 'headless' }), null, 'not_found').body ?? ''
    expect(missing).toMatch(/Chronos was not found/)
    expect(missing).not.toContain('too old')
    const old = card(create({ memory: true, runner: 'headless' }), null, 'too_old').body ?? ''
    expect(old).toContain('too old')
    expect(old).not.toMatch(/was not found/)
    expect(card(create({ memory: true }), null, 'not_found').body ?? '').not.toMatch(/Chronos/)
  })

  it('a job that has memory on and moves to the background, or to full permissions, is told it will run unattended', () => {
    const on = { ...plain, memory: true } as ScheduleT
    expect(card(update({ runner: 'headless' }), on).body ?? '').toMatch(/unattended[^\n]*full permissions/i)
    const restricted = { ...on, permissions: 'restricted', runner: 'headless', allowed_tools: ['Read'] } as ScheduleT
    expect(card(update({ permissions: 'full' }), restricted).body ?? '').toMatch(/unattended[^\n]*full permissions/i)
    expect(card(update({ runner: 'headless' }), on, 'too_old').body ?? '').toContain('newer Chronos')
    expect(card(update({ runner: 'headless' }), on, 'not_found').body ?? '').toMatch(/was not found/)
  })

  it('a job that moves to read-only is told it can only read its results now', () => {
    const on = { ...plain, memory: true, runner: 'headless' } as ScheduleT
    const body = card(update({ permissions: 'restricted', allowed_tools: ['Read'] }), on).body ?? ''
    expect(body).toMatch(/can't keep notes/)
    expect(body).not.toMatch(/unattended/i)
  })

  it('an edit that does not change where it runs, or a job with memory off, says nothing more about memory', () => {
    const on = { ...plain, memory: true, runner: 'headless' } as ScheduleT
    expect(card(update({ name: 'Morning' }), on).body ?? '').not.toMatch(/unattended|Chronos/i)
    expect(card(update({ runner: 'headless' }), plain).body ?? '').not.toMatch(/unattended/i)
    const sessionOn = { ...plain, memory: true } as ScheduleT
    expect(card(update({ name: 'x' }), sessionOn).body ?? '').not.toMatch(/unattended/i)
  })

  it('a command job: the card says the command gets files and may rewrite the notepad, and that it runs unattended with full permissions', () => {
    const cmd = { ...plain, kind: 'command', permissions: 'command', runner: 'headless' } as ScheduleT
    const body = card(update({ memory: true }), cmd).body ?? ''
    expect(body).toContain('TALOS_MEMORY_DIR')
    expect(body).toContain('TALOS_MEMORY_NOTEPAD_OUT')
    expect(body).toMatch(/unattended[^\n]*full permissions/i)
    expect(card(update({ memory: true }), cmd, 'too_old').body ?? '').toContain('newer Chronos')
    expect(card(update({ memory: true }), plain).body ?? '').not.toContain('TALOS_MEMORY_DIR')
  })

  it('an edit to something else says nothing about memory', () => {
    const on = { ...plain, memory: true } as ScheduleT
    expect(card(update({ name: 'Morning' }), on).body ?? '').not.toContain('Memory')
  })
})

describe('memory travels only on schedules/2', () => {
  it('a job with memory on needs it; a job without the field does not', () => {
    expect(needsSchedulesV2({ when: { type: 'daily' }, memory: true })).toBe(true)
    expect(needsSchedulesV2({ when: { type: 'daily' } })).toBe(false)
    expect(needsSchedulesV2(plain)).toBe(false)
    expect(needsSchedulesV2({ ...plain, memory: true })).toBe(true)
  })

  it('a change that mentions memory in any way needs it, so an older relay never sees the field', () => {
    expect(changeNeedsSchedulesV2(create({ memory: true }))).toBe(true)
    expect(changeNeedsSchedulesV2(create({ memory: false }))).toBe(true)
    expect(changeNeedsSchedulesV2(update({ memory: true }))).toBe(true)
    expect(changeNeedsSchedulesV2(update({ memory: false }))).toBe(true)
  })

  it('a change that does not mention it is as before', () => {
    expect(changeNeedsSchedulesV2(create())).toBe(false)
    expect(changeNeedsSchedulesV2(update({ name: 'x' }))).toBe(false)
  })
})
