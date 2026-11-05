// composeScheduleCard() (SCHEDULES S8.2, S9 N4): the whole schedule Card from its inputs, pure. Every S8.2 risk rule has
// a case here.
import { describe, expect, it } from 'vitest'
import {
  bindingFrom,
  Card,
  type ComposeScheduleCardOpts,
  composeScheduleCard,
  lineDiff,
  payloadHash,
  ScheduleCardPayload,
  type ScheduleChangeT,
  type ScheduleT,
  scheduleCardRisk,
} from '../src/index.ts'
import { loadFixtures } from './helpers.ts'

const fixtures = loadFixtures()
const snap = (fixtures['schedules.snapshot'] as { snapshot: { schedules: ScheduleT[] } }).snapshot
const base = snap.schedules.find((s) => s.id === 'daily-digest') as ScheduleT
const ETAG = `sha256:${'2'.repeat(64)}`
const PROMPT = "Summarise yesterday's activity and post it.\n"
const preview = {
  when_text: 'Weekdays at 7:30 AM',
  next_runs: ['2026-10-06T07:30:00-04:00', '2026-10-07T07:30:00-04:00'],
  tz: 'America/New_York',
}
const opts = (o: Partial<ComposeScheduleCardOpts> = {}): ComposeScheduleCardOpts => ({
  cardId: 'c_01JBF3V7Q8K2M4N6P8R0S2T4CC',
  threadId: 'general',
  now: '2026-10-05T11:45:00.000Z',
  origin: 'chat',
  proposedBy: 'agent',
  agentName: 'Talos',
  expectedEtag: ETAG,
  clientRef: null,
  threadName: (id) => (id === 'general' ? 'General' : id === null ? 'General (default)' : id),
  base: { schedule: base, prompt: PROMPT, guard: null },
  ...o,
})
const draft = {
  id: 'new-job',
  name: 'New Job',
  description: '',
  when: { type: 'daily', time: '09:00' },
  catchup_min: 60,
  enabled: true,
  runner: 'headless', // Chronos refuses restricted + session (review F12)
  permissions: 'restricted',
  allowed_tools: ['Read'],
  model: null,
  notify: 'failure',
  thread_id: null,
  prompt: 'Do the thing.\n',
} as const
const create: ScheduleChangeT = { op: 'create', draft: { ...draft, when: { ...draft.when }, allowed_tools: ['Read'] } }
const update = (set: Record<string, unknown>): ScheduleChangeT =>
  ({ op: 'update', id: base.id, base_etag: base.etag, set }) as ScheduleChangeT

describe('composeScheduleCard under trust mode', () => {
  it('without the flag the risk is the S8.2 rule; with it every schedule card is low', () => {
    expect(composeScheduleCard(create, preview, null, opts({ base: null })).risk).toBe('high')
    expect(composeScheduleCard(create, preview, null, opts({ base: null, trust: false })).risk).toBe('high')
    expect(composeScheduleCard(create, preview, null, opts({ base: null, trust: true })).risk).toBe('low')
  })
  it('the flag changes nothing else in the card (an old app reads the same card)', () => {
    const off = composeScheduleCard(create, preview, null, opts({ base: null }))
    const on = composeScheduleCard(create, preview, null, opts({ base: null, trust: true }))
    expect({ ...on, risk: 'high', payload_hash: '' }).toEqual({ ...off, payload_hash: '' })
    expect(on.payload_hash).toBe(payloadHash(bindingFrom(on)))
  })
})

describe('composeScheduleCard', () => {
  it('builds a valid pending card whose payload_hash verifies and whose payload parses', () => {
    const card = composeScheduleCard(create, preview, null, opts({ base: null }))
    expect(Card.safeParse(card).success).toBe(true)
    expect(card.kind).toBe('schedule')
    expect(card.state).toBe('pending')
    expect(card.payload_hash).toBe(payloadHash(bindingFrom(card)))
    const p = ScheduleCardPayload.parse(card.payload)
    expect(p.change).toEqual(create)
    expect(p.expected_etag).toBe(ETAG)
    expect(p.proposed_by).toBe('agent')
    expect(p.preview).toEqual(preview)
  })
  it('is pure: the same inputs give the same card', () => {
    expect(composeScheduleCard(create, preview, null, opts({ base: null }))).toEqual(
      composeScheduleCard(create, preview, null, opts({ base: null })),
    )
  })
  it('has the S8.2 destination rows, in order', () => {
    const card = composeScheduleCard(create, preview, null, opts({ base: null }))
    expect(card.destination.map((d) => d.label)).toEqual(['Runs', 'Next', 'As', 'Where', 'Posts to', 'Proposed by'])
    const row = (l: string) => card.destination.find((d) => d.label === l)?.value
    expect(row('Runs')).toBe('Weekdays at 7:30 AM')
    expect(row('Next')).toBe('2026-10-06T07:30:00-04:00')
    expect(row('As')).toBe('Read-only: Read')
    expect(row('Where')).toBe('In the background')
    expect(row('Posts to')).toBe('General (default)')
    expect(row('Proposed by')).toBe('Talos')
    const form = composeScheduleCard(create, preview, null, opts({ base: null, proposedBy: 'owner_form' }))
    expect(form.destination.find((d) => d.label === 'Proposed by')?.value).toBe('your form')
  })
  it('never lets the owner edit fields in place, always allows Revise', () => {
    const card = composeScheduleCard(create, preview, null, opts({ base: null }))
    expect(card.allow_edit).toBe(false)
    expect(card.allow_revise).toBe(true)
  })
  it('expiry: 86400 s for chat and for background (O2)', () => {
    const chat = composeScheduleCard(create, preview, null, opts({ base: null }))
    expect(Date.parse(chat.expires_at) - Date.parse(chat.created_at)).toBe(86_400_000)
    const bg = composeScheduleCard(create, preview, null, opts({ base: null, origin: 'background' }))
    expect(bg.origin).toBe('background')
    expect(Date.parse(bg.expires_at) - Date.parse(bg.created_at)).toBe(86_400_000)
  })
  it('warns on full-permission jobs only', () => {
    const full = composeScheduleCard(
      { op: 'create', draft: { ...draft, permissions: 'full', allowed_tools: [] } } as ScheduleChangeT,
      preview,
      null,
      opts({ base: null }),
    )
    expect(full.warning).toBe('Runs unattended with full permissions: it can do anything you can on this Mac.')
    expect(full.destination.find((d) => d.label === 'As')?.value).toBe('Full permissions, nobody watching')
    expect(composeScheduleCard(create, preview, null, opts({ base: null })).warning).toBeUndefined()
  })
  it('create body is the prompt; update body is the capped line diff; adopt diffs against the approved text', () => {
    expect(composeScheduleCard(create, preview, null, opts({ base: null })).body).toContain('Prompt:\nDo the thing.\n')
    const up = composeScheduleCard(update({ name: 'Morning Digest', prompt: 'Summarise.\n' }), preview, null, opts())
    expect(up.body).toContain('Name: Daily Digest → Morning Digest')
    expect(up.body).toContain("-Summarise yesterday's activity and post it.")
    expect(up.body).toContain('+Summarise.')
    const adopt = composeScheduleCard(
      { op: 'adopt', id: base.id, content_hash: base.content_hash },
      preview,
      { prompt: 'Old text.\n', guard: null },
      opts({ base: { schedule: base, prompt: 'New text.\n', guard: null } }),
    )
    expect(adopt.body).toContain('-Old text.')
    expect(adopt.body).toContain('+New text.')
    const never = composeScheduleCard(
      { op: 'adopt', id: base.id, content_hash: base.content_hash },
      preview,
      null,
      opts({ base: { schedule: base, prompt: 'New text.\n', guard: 'Be careful.\n' } }),
    )
    expect(never.body).toContain('Never approved')
    expect(never.body).toContain('Be careful.')
    expect(never.body).toContain('New text.')
  })
  it('caps the update body at 16 KiB with a pointer to Details', () => {
    const big = Array.from({ length: 3000 }, (_, i) => `line ${i} ${'y'.repeat(20)}`).join('\n')
    const card = composeScheduleCard(update({ prompt: big }), preview, null, opts())
    expect(new TextEncoder().encode(card.body ?? '').length).toBeLessThanOrEqual(16 * 1024)
    expect(card.body?.endsWith('… full text under Details')).toBe(true)
  })
  it('a 16 KiB prompt card stays within the 64 KiB JCS payload cap', () => {
    const prompt = '"\\'.repeat(8 * 1024)
    const card = composeScheduleCard(
      { op: 'create', draft: { ...draft, prompt, allowed_tools: [] } } as ScheduleChangeT,
      preview,
      null,
      opts({ base: null }),
    )
    expect(new TextEncoder().encode(JSON.stringify(card.payload)).length).toBeLessThanOrEqual(64 * 1024)
  })
})

describe('scheduleCardRisk (S8.2)', () => {
  const b = { schedule: base, prompt: PROMPT, guard: null }
  it.each([
    ['create', create],
    ['delete', { op: 'delete', id: base.id, base_etag: base.etag }],
    ['adopt', { op: 'adopt', id: base.id, content_hash: base.content_hash }],
  ])('%s is always high', (_n, change) => {
    expect(scheduleCardRisk(change as ScheduleChangeT, b)).toBe('high')
  })
  it.each([
    ['turning a job on', { schedule: { ...base, enabled: false } }, { enabled: true }],
    ['changing the prompt', {}, { prompt: 'Other.\n' }],
    ['changing the model', {}, { model: 'opus' }],
    ['changing the runner', {}, { runner: 'headless' }],
    [
      'setting permissions to full',
      { schedule: { ...base, permissions: 'restricted', allowed_tools: ['Read'] } },
      { permissions: 'full' },
    ],
    [
      'adding an allowed tool',
      { schedule: { ...base, permissions: 'restricted', allowed_tools: ['Read'] } },
      { allowed_tools: ['Read', 'Bash'] },
    ],
  ])('update %s is high', (_n, over, set) => {
    expect(scheduleCardRisk(update(set), { ...b, ...over } as typeof b)).toBe('high')
  })
  it.each([
    ['rename', { name: 'Other' }],
    ['description', { description: 'x' }],
    ['time', { when: { type: 'daily', time: '08:00' } }],
    ['days', { when: { type: 'days', days: ['mon'], time: '07:30' } }],
    ['catch-up', { catchup_min: 60 }],
    ['notify never', { notify: 'never' }],
    ['result thread', { thread_id: 'work' }],
    ['turning a job off', { enabled: false }],
    ['the same prompt resent', { prompt: PROMPT }],
    ['removing an allowed tool', { allowed_tools: [] }],
  ])('update %s is low', (_n, set) => {
    const restricted = { ...b, schedule: { ...base, permissions: 'restricted' as const, allowed_tools: ['Read'] } }
    expect(scheduleCardRisk(update(set), restricted)).toBe('low')
  })
  it('an update with no base to compare against is high (fail closed)', () => {
    expect(scheduleCardRisk(update({ name: 'x' }), null)).toBe('high')
  })
  it('the composed card carries the risk', () => {
    expect(composeScheduleCard(update({ name: 'x' }), preview, null, opts()).risk).toBe('low')
    expect(composeScheduleCard(update({ model: 'opus' }), preview, null, opts()).risk).toBe('high')
  })
})

describe('lineDiff', () => {
  it('is a unified diff with hunk headers', () => {
    const d = lineDiff('a\nb\nc\n', 'a\nB\nc\n')
    expect(d).toBe('@@ -1,3 +1,3 @@\n a\n-b\n+B\n c')
  })
  it('is empty when nothing changed', () => {
    expect(lineDiff('a\n', 'a\n')).toBe('')
  })
})
