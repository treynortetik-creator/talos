// The live cap and the park after the turn (P3d3, part 6; the Mac's WorkerPolicy.planStart, enforceCap, retryHeld and the stop
// limit): pure functions only. The manager's use of them is in workers.test.ts.

import { describe, expect, it } from 'bun:test'
import { CAP_HOLD_MS, WORKER_POINTER_TEXT, WORKER_TIMING } from '@talos-app/protocol'
import {
  capVictims,
  holdExpired,
  type Live,
  parkAfterTurn,
  planStart,
  waitsOnOwner,
} from '../../src/supervisor/worker-cap.ts'

describe('a start under the cap', () => {
  // the Mac's capParksTheLongestIdleNonBusyWorker
  const live: Live[] = [
    { threadId: 'a', busy: false, lastActive: 100 },
    { threadId: 'b', busy: false, lastActive: 50 },
    { threadId: 'c', busy: true, lastActive: 10 },
  ]
  it('starts while a slot is free; when full parks the longest-idle worker that is not busy; else holds', () => {
    expect(planStart(live.slice(0, 2), 3)).toEqual({ kind: 'start' })
    expect(planStart(live, 3)).toEqual({ kind: 'parkThenStart', victim: 'b' })
    expect(
      planStart(
        live.map((l) => ({ ...l, busy: true })),
        3,
      ),
    ).toEqual({ kind: 'hold' })
  })
  it('a tie in idle time goes by thread id', () => {
    const tie: Live[] = [
      { threadId: 'z', busy: false, lastActive: 5 },
      { threadId: 'm', busy: false, lastActive: 5 },
    ]
    expect(planStart(tie, 2)).toEqual({ kind: 'parkThenStart', victim: 'm' })
  })
  it('more than the cap (a lowered max_live) is still full', () => {
    expect(planStart(live, 1)).toEqual({ kind: 'parkThenStart', victim: 'b' })
  })
})

describe('a lowered max_live', () => {
  const live: Live[] = [
    { threadId: 'a', busy: false, lastActive: 300 },
    { threadId: 'b', busy: false, lastActive: 100 },
    { threadId: 'c', busy: true, lastActive: 10 },
    { threadId: 'd', busy: false, lastActive: 200 },
  ]
  it('parks the most idle of the extras; busy ones wait', () => {
    expect(capVictims(live, 4)).toEqual([])
    expect(capVictims(live, 3)).toEqual(['b'])
    expect(capVictims(live, 2)).toEqual(['b', 'd'])
    expect(capVictims(live, 1)).toEqual(['b', 'd', 'a'])
  })
})

describe('waiting on the owner', () => {
  const rule = '─'.repeat(40)
  const quiet = ['history', rule, '❯ ', rule]
  const pane = (rows: string[] | null, clients: number[] | null, escaped: string[] | null = rows) => ({
    visibleRows: async () => rows,
    visibleRowsEscaped: async () => escaped,
    clientActivities: async () => clients,
  })
  it('flagged, a key typed within dialog_client_quiet_s, or a read that fails: yes; a quiet pane: no', async () => {
    const now = 1_000_000
    expect(await waitsOnOwner(false, pane(quiet, []), now)).toBe(false)
    expect(await waitsOnOwner(true, pane(quiet, []), now)).toBe(true)
    expect(await waitsOnOwner(false, pane(quiet, [now - 1000]), now)).toBe(true)
    expect(await waitsOnOwner(false, pane(quiet, [now - WORKER_TIMING.dialog_client_quiet_s * 1000]), now)).toBe(false)
    expect(await waitsOnOwner(false, pane(null, []), now)).toBe(true)
    expect(await waitsOnOwner(false, pane(quiet, null), now)).toBe(true)
    expect(await waitsOnOwner(false, null, now)).toBe(true)
  })
  it('the owner’s unsent text in the box (by its colours) is waiting on the owner; the dim placeholder and our own line are not', async () => {
    const now = 1_000_000
    const box = (line: string) => ['history', rule, line, rule]
    expect(await waitsOnOwner(false, pane(quiet, [], box('\u276F\u00A0half a thought')), now)).toBe(true)
    expect(await waitsOnOwner(false, pane(quiet, [], box('\u276F\u00A0\u001b[2mTry "x"\u001b[0m')), now)).toBe(false)
    expect(await waitsOnOwner(false, pane(quiet, [], box(`\u276F\u00A0${WORKER_POINTER_TEXT}`)), now)).toBe(false)
    expect(await waitsOnOwner(false, pane(quiet, [], null), now)).toBe(true)
  })
})

describe('a held start', () => {
  it('is given up after CAP_HOLD_MS (the hub hands the message to Main)', () => {
    expect(holdExpired(100, 100 + CAP_HOLD_MS / 1000)).toBe(false)
    expect(holdExpired(100, 100 + CAP_HOLD_MS / 1000 + 1)).toBe(true)
  })
})

describe('a park after the turn', () => {
  it('the governor’s waits for the turn to end, however long it takes', () => {
    const w = { why: 'governor', deadline: null }
    expect(parkAfterTurn(w, true, 1e9)).toBeNull()
    expect(parkAfterTurn(w, false, 1e9)).toBe('governor')
  })
  it('an owner’s gives up on the turn at its stop limit (owner_stop_s from the tap)', () => {
    const w = { why: 'control', deadline: 100 + WORKER_TIMING.owner_stop_s }
    expect(parkAfterTurn(w, true, 100 + WORKER_TIMING.owner_stop_s - 1)).toBeNull()
    expect(parkAfterTurn(w, true, 100 + WORKER_TIMING.owner_stop_s)).toBe('stop_limit')
    expect(parkAfterTurn(w, false, 101)).toBe('control')
  })
})
