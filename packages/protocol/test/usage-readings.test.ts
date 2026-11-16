// Plan usage from every session (usage-readings.ts): the newest reading per kind, a reset window dropped, a worker's usage file
// read for its own session only, and `as_of` on the wire without breaking a peer that predates it.
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import {
  IsoTs,
  newestReadings,
  type RateLimitT,
  readingsFromUsageFile,
  SessionState,
  SessionStateFrame,
  USAGE_RECORDER_PY,
  usageRecorderCommand,
  withoutAsOf,
} from '../src/index.ts'

const NOW = Date.parse('2026-11-12T18:00:00.000Z')
const ago = (min: number) => new Date(NOW - min * 60_000).toISOString()
const LATER = '2026-11-15T00:00:00.000Z'
const SID = '6f1c2a9e-4b3d-4c8e-9a71-2d5e8f0b3c41'

describe('the newest reading per kind', () => {
  it('a busy worker’s newer reading replaces main’s older one', () => {
    const main: RateLimitT[] = [{ kind: 'seven_day', percent: 27, resets_at: LATER, as_of: ago(90) }]
    const worker: RateLimitT[] = [{ kind: 'seven_day', percent: 35, resets_at: LATER, as_of: ago(1) }]
    expect(newestReadings([main, worker], NOW)).toEqual(worker)
    // order of the sources does not matter: time decides
    expect(newestReadings([worker, main], NOW)).toEqual(worker)
  })

  it('a reading with no time loses to any timed one, and is kept when it is alone', () => {
    const untimed: RateLimitT[] = [{ kind: 'seven_day', percent: 27 }]
    const old: RateLimitT[] = [{ kind: 'seven_day', percent: 35, as_of: ago(600) }]
    expect(newestReadings([untimed, old], NOW)).toEqual(old)
    expect(newestReadings([untimed], NOW)).toEqual(untimed)
  })

  it('a reading past its reset is dropped (the window rolled over), and an older live one stands', () => {
    const reset: RateLimitT[] = [{ kind: 'five_hour', percent: 97, resets_at: ago(1), as_of: ago(2) }]
    const live: RateLimitT[] = [{ kind: 'five_hour', percent: 4, resets_at: LATER, as_of: ago(10) }]
    expect(newestReadings([reset, live], NOW)).toEqual(live)
    expect(newestReadings([reset], NOW)).toEqual([])
  })

  it('kinds are kept apart, and a tie keeps the higher figure (a duplicate never lowers one)', () => {
    const a: RateLimitT[] = [
      { kind: 'seven_day', percent: 40, as_of: ago(1) },
      { kind: 'five_hour', percent: 10, as_of: ago(1) },
    ]
    const b: RateLimitT[] = [{ kind: 'seven_day', percent: 41, as_of: ago(1) }]
    expect(newestReadings([a, b], NOW)).toEqual([
      { kind: 'seven_day', percent: 41, as_of: ago(1) },
      { kind: 'five_hour', percent: 10, as_of: ago(1) },
    ])
    expect(
      newestReadings(
        [
          [
            { kind: 'seven_day', percent: 90 },
            { kind: 'seven_day', percent: 20 },
          ],
        ],
        NOW,
      )[0]?.percent,
    ).toBe(90)
  })

  it('maxAgeMs drops a timed reading older than that, never an untimed one', () => {
    const old: RateLimitT[] = [{ kind: 'seven_day', percent: 96, as_of: ago(31) }]
    const untimed: RateLimitT[] = [{ kind: 'seven_day', percent: 50 }]
    expect(newestReadings([old], NOW, { maxAgeMs: 30 * 60_000 })).toEqual([])
    expect(newestReadings([old, untimed], NOW, { maxAgeMs: 30 * 60_000 })).toEqual(untimed)
  })
})

describe('a worker’s usage file', () => {
  const file = (over: Record<string, unknown> = {}) => ({
    v: 1,
    session_id: SID,
    at: (NOW - 60_000) / 1000,
    rate_limits: {
      five_hour: { used_percentage: 12.5, resets_at: Date.parse(LATER) / 1000 },
      seven_day: { used_percentage: 35, resets_at: Date.parse(LATER) / 1000 },
    },
    ...over,
  })

  it('gives each window with the time it was taken (epoch seconds, as the status line gives them)', () => {
    const r = readingsFromUsageFile(file(), { sessionId: SID.toUpperCase(), nowMs: NOW })
    expect(r).toEqual({
      ok: true,
      readings: [
        { kind: 'five_hour', percent: 12.5, resets_at: LATER, as_of: ago(1) },
        { kind: 'seven_day', percent: 35, resets_at: LATER, as_of: ago(1) },
      ],
    })
  })

  it('counts only for the session the thread runs: another session id, or none, gives no reading', () => {
    expect(readingsFromUsageFile(file({ session_id: 'someone-else' }), { sessionId: SID, nowMs: NOW })).toEqual({
      ok: false,
      reason: 'another session',
    })
    expect(readingsFromUsageFile(file({ session_id: undefined }), { sessionId: SID, nowMs: NOW }).ok).toBe(false)
  })

  it('a time ahead of the clock is refused; the file’s modification time caps a later stamp', () => {
    expect(readingsFromUsageFile(file({ at: (NOW + 10 * 60_000) / 1000 }), { sessionId: SID, nowMs: NOW })).toEqual({
      ok: false,
      reason: 'time ahead of the clock',
    })
    const r = readingsFromUsageFile(file({ at: NOW / 1000 }), { sessionId: SID, nowMs: NOW, mtimeMs: NOW - 5 * 60_000 })
    expect(r.ok && r.readings[0]?.as_of).toBe(ago(5))
  })

  it('an odd window loses itself (or its figure), never the others; a window from a newer Claude Code is kept as a kind', () => {
    const r = readingsFromUsageFile(
      file({
        rate_limits: {
          seven_day: { used_percentage: 'lots', resets_at: Date.parse(LATER) / 1000 },
          five_hour: 'not a window',
          spend_limit: { used_percentage: 140 },
          weekly_new_kind: { used_percentage: 3 },
        },
      }),
      { sessionId: SID, nowMs: NOW },
    )
    expect(r).toEqual({
      ok: true,
      readings: [
        { kind: 'seven_day', resets_at: LATER, as_of: ago(1) },
        { kind: 'spend_limit', as_of: ago(1) },
        { kind: 'weekly_new_kind', percent: 3, as_of: ago(1) },
      ],
    })
  })

  it('no time, or not an object: no reading, with a reason', () => {
    expect(readingsFromUsageFile(file({ at: 'yesterday' }), { sessionId: SID, nowMs: NOW })).toEqual({
      ok: false,
      reason: 'no time',
    })
    expect(readingsFromUsageFile([1, 2], { sessionId: SID, nowMs: NOW }).ok).toBe(false)
  })
})

describe('`as_of` on the wire, old and new peers', () => {
  // the rate-limit row as every app and relay before this change parsed it (packages/protocol session.ts, origin/main be45fb5c)
  const OldRow = z.strictObject({
    kind: z.string().max(24),
    percent: z.number().min(0).max(100).optional(),
    resets_at: IsoTs.optional(),
  })
  const OldState = SessionState.extend({ rate_limits: z.array(OldRow).max(6).default([]) })
  const state = (rows: RateLimitT[]) => ({
    session_id: 'main-1',
    source: 'mod',
    capabilities: ['stop'],
    rate_limits: rows,
    surfaces: [],
    at: ago(0),
  })
  const rows: RateLimitT[] = [{ kind: 'seven_day', percent: 35, resets_at: LATER, as_of: ago(3) }]

  it('this build reads a state with as_of, and one without it (an older Mac)', () => {
    const withAsOf = SessionState.safeParse(state(rows))
    expect(withAsOf.success && withAsOf.data.rate_limits[0]?.as_of).toBe(ago(3))
    expect(SessionState.safeParse(state(withoutAsOf(rows))).success).toBe(true)
    // the whole frame, as the relay and the app parse it
    const frame = { v: 1, type: 'session.state', id: '01JC0000000000000000000000', ts: ago(0), state: state(rows) }
    expect(SessionStateFrame.safeParse(frame).success).toBe(true)
  })

  it('an older app refuses as_of, which is why it goes only to a relay that lists usage-as-of/1; without it, it parses', () => {
    expect(OldState.safeParse(state(rows)).success).toBe(false)
    expect(OldState.safeParse(state(withoutAsOf(rows))).success).toBe(true)
  })

  it('a bad as_of is refused by the schema (the bridge only ever writes ISO times)', () => {
    expect(SessionState.safeParse(state([{ kind: 'seven_day', percent: 1, as_of: 'ten minutes ago' }])).success).toBe(
      false,
    )
  })

  it('six rows each with as_of still fit the state', () => {
    const six = ['a', 'b', 'c', 'd', 'e', 'f'].map((k) => ({
      kind: k.repeat(24),
      percent: 100,
      resets_at: LATER,
      as_of: ago(1),
    }))
    expect(SessionState.safeParse(state(six)).success).toBe(true)
  })
})

describe('the recorder program', () => {
  it('has no backslash and no single quote, so it travels unchanged in a shell word and a Swift literal', () => {
    expect(USAGE_RECORDER_PY).not.toContain('\\')
    expect(USAGE_RECORDER_PY).not.toContain("'")
  })
  it('the command quotes a path with a quote in it', () => {
    const c = usageRecorderCommand("/opt/py's/python3", '/home/alex/.talos/workers/trip/usage.json')
    expect(
      c.startsWith("exec /usr/bin/env -i PATH=/usr/bin:/bin LANG=en_US.UTF-8 '/opt/py'\\''s/python3' -I -c '"),
    ).toBe(true)
    expect(c.endsWith(" '/home/alex/.talos/workers/trip/usage.json'")).toBe(true)
  })
})
