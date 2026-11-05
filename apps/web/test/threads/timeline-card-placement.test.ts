// A decided or expired card sits where it happened, not pinned under everything; a card still waiting stays last.
import type { CardT, MessageT } from '@talos-app/protocol'
import { describe, expect, it } from 'vitest'
import { oldestStoredKey, orderTimelineRows } from '../../src/features/threads/Timeline.tsx'

const at = (min: number) => new Date(Date.UTC(2026, 9, 31, 12, min)).toISOString()
const msg = (seq: number, min: number): MessageT => ({
  id: `m_${seq}`,
  thread_id: 'talos',
  author: 'agent',
  kind: 'text',
  text: `message ${seq}`,
  format: 'plain',
  attachments: [],
  via: 'app',
  seq,
  created_at: at(min),
})
const card = (id: string, min: number, state: CardT['state']): CardT =>
  ({ id, thread_id: 'talos', created_at: at(min), expires_at: '2099-01-01T00:00:00.000Z', state }) as CardT
/** A card the owner acted on at minute `actMin` (created at `min`). */
const acted = (
  id: string,
  min: number,
  state: CardT['state'],
  action: 'primary' | 'kill' | 'revise' | 'expired',
  actMin: number,
): CardT => ({ ...card(id, min, state), resolution: { action, at: at(actMin), edited: false, payload_hash: 'h' } })
const keys = (m: MessageT[], c: CardT[]) => orderTimelineRows(m, c).map((r) => r.key)
const stored = [msg(1, 0), msg(2, 10), msg(3, 20), msg(4, 30)]

describe('timeline card placement', () => {
  it.each(['done', 'failed', 'expired', 'superseded'] as const)(
    'a %s card with no message goes by created_at among the stored rows',
    (state) => {
      expect(keys(stored, [card('c_x', 15, state)])).toEqual(['m_1', 'm_2', 'c_x', 'm_3', 'm_4'])
    },
  )

  it('a decided card newer than every stored row goes after them', () => {
    expect(keys(stored, [card('c_x', 99, 'done')])).toEqual(['m_1', 'm_2', 'm_3', 'm_4', 'c_x'])
  })

  it('a decided card older than every stored row goes first', () => {
    expect(keys(stored, [card('c_x', -5, 'done')])).toEqual(['c_x', 'm_1', 'm_2', 'm_3', 'm_4'])
  })

  it.each(['kill', 'revise'] as const)(
    'a %s card left in the resolved state (an older Mac never closes it) is placed by when the owner acted',
    (action) => {
      // created at minute 5, acted on at minute 25: between message 3 (20) and message 4 (30), not at the bottom
      expect(keys(stored, [acted('c_k', 5, 'resolved', action, 25)])).toEqual(['m_1', 'm_2', 'm_3', 'c_k', 'm_4'])
    },
  )

  it('a decided card is placed by the action time, not the creation time, and carries that time as its row time', () => {
    const rows = orderTimelineRows(stored, [acted('c_k', 0, 'done', 'kill', 15)])
    expect(rows.map((r) => r.key)).toEqual(['m_1', 'm_2', 'c_k', 'm_3', 'm_4'])
    expect(rows[2]?.at).toBe(at(15)) // the day divider reads this
  })

  it('an approved card still waiting for the agent result is placed by the approval time, not pinned', () => {
    expect(keys(stored, [acted('c_r', 5, 'resolved', 'primary', 15)])).toEqual(['m_1', 'm_2', 'c_r', 'm_3', 'm_4'])
    // finishing it does not move it
    expect(keys(stored, [acted('c_r', 5, 'done', 'primary', 15)])).toEqual(['m_1', 'm_2', 'c_r', 'm_3', 'm_4'])
  })

  it('a resolved card with no resolution at all (a tap the relay queued) falls back to its creation time', () => {
    expect(keys(stored, [card('c_r', 15, 'resolved')])).toEqual(['m_1', 'm_2', 'c_r', 'm_3', 'm_4'])
  })

  it('a pending card past its expiry is no longer waiting on the owner and is placed in the past', () => {
    const lapsed = { ...card('c_e', 15, 'pending'), expires_at: at(16) }
    const live = orderTimelineRows(stored, [lapsed], Date.parse(at(10)))
    const gone = orderTimelineRows(stored, [lapsed], Date.parse(at(60)))
    expect(live.map((r) => r.key)).toEqual(['m_1', 'm_2', 'm_3', 'm_4', 'c_e'])
    expect(gone.map((r) => r.key)).toEqual(['m_1', 'm_2', 'c_e', 'm_3', 'm_4'])
  })

  it('a waiting card created before the newest message never carries an earlier row time than the row above it', () => {
    // created at minute 5 but pinned last: its row time must not say an earlier day than the newest message above it
    const rows = orderTimelineRows(stored, [card('c_p', 5, 'pending')])
    expect(rows.map((r) => r.key)).toEqual(['m_1', 'm_2', 'm_3', 'm_4', 'c_p'])
    const times = rows.map((r) => Date.parse(r.at))
    expect(times).toEqual([...times].sort((a, b) => a - b))
    expect(rows[4]?.at).toBe(at(30))
  })

  it('a waiting card message row (no seq) is clamped the same way', () => {
    const row = { ...msg(7, 5), id: 'm_card', kind: 'card', card_id: 'c_p' } as MessageT
    delete (row as { seq?: number }).seq
    const rows = orderTimelineRows([...stored, row], [card('c_p', 5, 'pending')])
    const times = rows.map((r) => Date.parse(r.at))
    expect(times).toEqual([...times].sort((a, b) => a - b))
  })

  it('a card message row (no seq) for a killed-but-resolved card is placed by the action time too', () => {
    const row = { ...msg(7, 15), id: 'm_card', kind: 'card', card_id: 'c_k' } as MessageT
    delete (row as { seq?: number }).seq
    const rows = orderTimelineRows([...stored, row], [acted('c_k', 15, 'resolved', 'revise', 25)])
    expect(rows.map((r) => r.key)).toEqual(['m_1', 'm_2', 'm_3', 'm_card', 'm_4'])
    expect(rows[3]?.at).toBe(at(25))
  })

  it('an old decided card first in the list does not hide a page of older messages from the keep-place watch', () => {
    const c = [card('c_old', -5, 'done')]
    const before = orderTimelineRows([msg(100, 0), msg(101, 10)], c)
    const after = orderTimelineRows([msg(90, -3), msg(91, -2), msg(100, 0), msg(101, 10)], c)
    expect(before[0]?.key).toBe('c_old')
    expect(after[0]?.key).toBe('c_old') // rows[0] alone did not change
    expect(oldestStoredKey(before)).toBe('m_100')
    expect(oldestStoredKey(after)).toBe('m_90')
  })

  it('a card still waiting on the owner stays at the bottom, however old', () => {
    expect(keys(stored, [card('c_p', 5, 'pending')])).toEqual(['m_1', 'm_2', 'm_3', 'm_4', 'c_p'])
  })

  it('pending stays after a decided card that is newer than the stored rows', () => {
    expect(keys(stored, [card('c_p', 5, 'pending'), card('c_d', 99, 'done')])).toEqual([
      'm_1',
      'm_2',
      'm_3',
      'm_4',
      'c_d',
      'c_p',
    ])
  })

  it('messages keep seq order even when their clocks disagree', () => {
    const skew = [msg(1, 50), msg(2, 10)]
    expect(keys(skew, [])).toEqual(['m_1', 'm_2'])
  })

  it('an optimistic message with no seq stays after the stored rows', () => {
    const optimistic = { ...msg(9, 5), id: 'm_local' } as MessageT
    delete (optimistic as { seq?: number }).seq
    expect(keys([...stored, optimistic], [card('c_x', 15, 'done')])).toEqual([
      'm_1',
      'm_2',
      'c_x',
      'm_3',
      'm_4',
      'm_local',
    ])
  })

  it('a history card row with no seq, for a decided card, is placed by its time too', () => {
    const row = { ...msg(7, 15), id: 'm_card', kind: 'card', card_id: 'c_x' } as MessageT
    delete (row as { seq?: number }).seq
    expect(keys([...stored, row], [card('c_x', 15, 'done')])).toEqual(['m_1', 'm_2', 'm_card', 'm_3', 'm_4'])
  })

  it('a card that has its own message is not shown twice', () => {
    const row = { ...msg(7, 15), id: 'm_card', kind: 'card', card_id: 'c_x' } as MessageT
    expect(keys([...stored, row], [card('c_x', 15, 'done')]).filter((k) => k === 'c_x')).toEqual([])
  })
})
