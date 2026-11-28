// What the schedule form (and the proposal sheets) show when the Mac refuses a change: plain sentences, never a field name or a
// code. The texts below are the bridge's real ones (where each comes from is named), not the fake client's.
import { describe, expect, it } from 'vitest'
import { proposeError } from '../../src/features/schedules/Proposal.tsx'
import { TalosClientError } from '../../src/lib/client.ts'

const PLAIN = 'The job changed on your Mac. Reload it and try again.'
const conflict = (m: string) => proposeError(new TalosClientError('schedule_conflict', m)).message

describe('a conflict is always the plain sentence', () => {
  it.each([
    // packages/protocol/src/schedules-card.ts:666 and :668, sent by service-cards.ts:193 when the base moves between two reads
    ['the card binding (etag)', 'base_etag is not the revision the card shows; re-read the job'],
    ['the card binding (hash)', 'content_hash is not the on-disk version the card shows; re-read the job'],
    // service-cards.ts apply path (applyCardInner), reached by a direct Save through service-frames.ts
    ['the apply path', 'The job changed on your Mac after this card was drawn. Nothing was saved. Ask again.'],
    // service-cards.ts prepareCard: `${v.code}: ${text}` from Chronos's own validate (a stale base or an id that exists)
    ['Chronos validate', 'schedule_conflict: base_etag: stale revision'],
    ['a create on an id that exists', 'schedule_conflict: id: already exists'],
    ['the apply path, adopt', 'The job changed on your Mac again. Reload it and try again.'],
  ])('%s', (_n, text) => {
    const m = conflict(text)
    expect(m).toBe(PLAIN)
    expect(m).not.toMatch(/base_etag|content_hash|schedule_|\bcard\b/i)
  })

  it("the bridge's own patch-time sentence, in each host's words, is kept as it is", () => {
    for (const where of ['Mac', 'computer', 'PC']) {
      const text = `The job changed on your ${where}. Reload it and try again.`
      expect(conflict(text)).toBe(text)
    }
  })
})

describe('the other refusals the patch path can return are not raw codes either', () => {
  it('schedule_invalid is one plain line, with the fields under their own inputs', () => {
    const e = new TalosClientError('schedule_invalid', 'schedule_invalid: set.name: too long', [
      { path: 'set.name', message: 'too long' },
    ])
    expect(proposeError(e).message).toBe('Some fields need a change.')
    expect(proposeError(e).fields).toEqual([{ path: 'set.name', message: 'too long' }])
  })
  it('a missing job and an offline Mac keep their own plain words', () => {
    expect(proposeError(new TalosClientError('schedule_not_found', 'no scheduled job "x"')).message).toBe(
      'That job is gone.',
    )
    expect(proposeError(new TalosClientError('mac_offline', 'x')).message).toBe(
      'Your Mac is offline. Try again when it is back.',
    )
  })
})
