// R2-4: the sweep that drops the kv rows of cards and runs that are over. The kv is a real history store; the lookups are plain
// data about a card and a run. A row survives only while its card waits (or is being applied) or its run is open, and is younger
// than a week.
import { afterEach, describe, expect, test } from 'bun:test'
import { join } from 'node:path'
import { openHistory } from '../../src/history-store.ts'
import { pruneScheduleKv } from '../../src/schedules/kv-prune.ts'
import { tempHome } from './harness.ts'

const NOW = Date.parse('2026-11-05T12:00:00Z')
const DAY = 24 * 3600_000
const iso = (ms: number) => new Date(ms).toISOString()
let store: ReturnType<typeof openHistory>
afterEach(() => store?.close())

function fresh() {
  store = openHistory(join(tempHome(), 'h.sqlite'))
  return store
}

describe('pruneScheduleKv', () => {
  test('keeps what is live and young, drops what is over, unknown or a week old', () => {
    const s = fresh()
    for (const k of [
      'schedule_card_proposer/c_wait',
      'schedule_card_proposer/c_apply',
      'schedule_card_proposer/c_done',
      'schedule_card_proposer/c_declined',
      'schedule_card_proposer/c_gone',
      'schedule_card_proposer/c_old',
      'schedule_run_started/r_open',
      'schedule_run_started/r_closed',
      'schedule_run_started/r_unknown',
      'schedule_run_started/r_stale',
      'other/key',
    ])
      s.kvSet(k, 'trip')
    const cards: Record<string, { state: string; created_at: string }> = {
      c_wait: { state: 'pending', created_at: iso(NOW - DAY) },
      c_apply: { state: 'resolved', created_at: iso(NOW - DAY) },
      c_done: { state: 'done', created_at: iso(NOW - DAY) },
      c_declined: { state: 'declined', created_at: iso(NOW - DAY) },
      c_old: { state: 'pending', created_at: iso(NOW - 8 * DAY) },
    }
    const runs: Record<string, { closed?: string; claimed_at: number }> = {
      r_open: { claimed_at: NOW - 3600_000 },
      r_closed: { closed: 'ok', claimed_at: NOW - 3600_000 },
      r_stale: { claimed_at: NOW - 8 * DAY },
    }
    const n = pruneScheduleKv({ now: NOW, kv: s, card: (id) => cards[id], run: (id) => runs[id] })
    expect(n).toBe(7)
    expect(s.kvKeys('schedule_').sort()).toEqual([
      'schedule_card_proposer/c_apply',
      'schedule_card_proposer/c_wait',
      'schedule_run_started/r_open',
    ])
    expect(s.kvGet('other/key')).toBe('trip')
  })

  test('a prefix with % or _ in it matches itself only', () => {
    const s = fresh()
    s.kvSet('a_b/1', 'x')
    s.kvSet('axb/1', 'x')
    s.kvSet('a%/1', 'x')
    expect(s.kvKeys('a_b/')).toEqual(['a_b/1'])
    expect(s.kvKeys('a%')).toEqual(['a%/1'])
  })

  test('a row that cannot be removed does not stop the rest', () => {
    const s = fresh()
    s.kvSet('schedule_card_proposer/c_1', 'trip')
    s.kvSet('schedule_card_proposer/c_2', 'trip')
    const failing = {
      kvKeys: (p: string) => s.kvKeys(p),
      kvDelete: (k: string) => {
        if (k.endsWith('c_1')) throw new Error('database is locked')
        s.kvDelete(k)
      },
    }
    expect(pruneScheduleKv({ now: NOW, kv: failing, card: () => undefined, run: () => undefined })).toBe(1)
    expect(s.kvKeys('schedule_')).toEqual(['schedule_card_proposer/c_1'])
  })
})
