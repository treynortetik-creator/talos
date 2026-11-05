// A tap held for a sleeping Mac: its `at` is the owner's tap (where the card sits), `taken_at` is when the Mac took it
// (what "how long has it been running" and "done today" are measured from). Peers that send no `taken_at` still work.
import { Card } from '@talos-app/protocol'
import { describe, expect, it } from 'vitest'
import { collapseLine, RESULT_OVERDUE_MS, resultOverdue } from '../../src/features/cards/logic.ts'
import { buildHome } from '../../src/features/home/groups.ts'
import { makeCard, setup } from './helpers.tsx'

const TAP = Date.parse('2026-10-28T09:00:00.000Z')
const TAKEN = TAP + 2 * 60 * 60_000 // the Mac woke two hours later
const res = (over: Record<string, unknown> = {}) => ({
  action: 'primary',
  at: new Date(TAP).toISOString(),
  edited: false,
  payload_hash: 'sha256:x',
  ...over,
})

describe('a tap held for a sleeping Mac', () => {
  it('is not overdue the moment the Mac takes it, however old the tap is', () => {
    const card = makeCard({ state: 'resolved', resolution: res({ taken_at: new Date(TAKEN).toISOString() }) })
    expect(resultOverdue(card, TAKEN + 60_000)).toBe(false)
    expect(collapseLine(card, { agent: 'Talos', nowMs: TAKEN + 60_000 })).toMatch(/^… Working on it/)
  })

  it('becomes overdue only once the Mac has had it for the full wait', () => {
    const card = makeCard({ state: 'resolved', resolution: res({ taken_at: new Date(TAKEN).toISOString() }) })
    expect(resultOverdue(card, TAKEN + RESULT_OVERDUE_MS)).toBe(false)
    expect(resultOverdue(card, TAKEN + RESULT_OVERDUE_MS + 1)).toBe(true)
  })

  it('an older Mac that sends no taken_at is measured from the tap, as before', () => {
    const card = makeCard({ state: 'resolved', resolution: res() })
    expect(resultOverdue(card, TAP + RESULT_OVERDUE_MS + 1)).toBe(true)
  })

  it('the resolution parses with and without taken_at, and an unreadable taken_at degrades to absent instead of dropping the card', () => {
    const base = makeCard({ state: 'resolved' })
    expect(Card.safeParse({ ...base, resolution: res() }).success).toBe(true)
    expect(Card.safeParse({ ...base, resolution: res({ taken_at: new Date(TAKEN).toISOString() }) }).success).toBe(true)
    const bad = Card.safeParse({ ...base, resolution: res({ taken_at: 'soon' }) })
    expect(bad.success && bad.data.resolution?.taken_at).toBeUndefined()
    expect(bad.success).toBe(true)
  })

  it("stays in Home's Done today list when the tap was 23:50 yesterday and the Mac took it this morning", () => {
    const tap = Date.parse('2026-10-27T23:50:00.000Z')
    const taken = Date.parse('2026-10-28T07:00:00.000Z')
    const held = makeCard({
      title: 'Held tap',
      state: 'resolved',
      resolution: res({ at: new Date(tap).toISOString(), taken_at: new Date(taken).toISOString() }),
    })
    const old = makeCard({
      title: 'Old Mac',
      state: 'resolved',
      resolution: res({ at: new Date(tap).toISOString() }),
    })
    const client = setup({ cards: [held, old] })
    const m = buildHome(client.store.getState(), {
      nowMs: taken + 60_000,
      timeZone: 'UTC',
      localSnoozed: new Map(),
    })
    const done = m.groups.find((g) => g.id === 'done_today')?.rows.map((r) => r.id) ?? []
    expect(done).toContain(held.id)
    expect(done).not.toContain(old.id) // no taken_at: judged by the tap, which was yesterday
  })
})

describe('an approval that never ran', () => {
  const failed = (ran?: boolean | 'unknown', text = 'Nothing ran: Apps are turned off on this Mac.') =>
    makeCard({
      state: 'failed',
      resolution: res(),
      result: {
        ok: false,
        text,
        at: new Date(TAP).toISOString(),
        ...(ran === false || ran === 'unknown' ? { ran } : {}),
      },
    })

  it('says the plain reason on the collapsed line, not "ask Talos to retry"', () => {
    const line = collapseLine(failed(false), { agent: 'Talos', nowMs: TAKEN })
    expect(line).toBe('⚠ Nothing ran: Apps are turned off on this Mac.')
  })

  it('an interrupted hand-over says check first, in the Mac\'s own words, not "ask Talos to retry"', () => {
    const text = 'This may not have reached your agent. Check before asking again.'
    const line = collapseLine(failed('unknown', text), { agent: 'Talos', nowMs: TAKEN })
    expect(line).toBe(`⚠ ${text}`)
    expect(line).not.toMatch(/retry/i)
  })

  it('a failure with no marker keeps the retry line (an older Mac, or something that really ran and failed)', () => {
    expect(collapseLine(failed(), { agent: 'Talos', nowMs: TAKEN })).toMatch(/Ask Talos to retry/)
  })
})
