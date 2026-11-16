// The late, optional fields of a workers.json entry (`needs_you`, `stopped_why`, `turn_started_at`) and Main's `needs_you` in
// main-restart-check.json: an older file reads as before, a value this build cannot read is none (or `unknown`) for that entry
// only, and every other thread still reads. The same entry an older reader parses has the fields stripped, never refused.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import {
  MainRestartCheckFile,
  NEEDS_YOU_COMPUTER_USE,
  NEEDS_YOU_MAC_PLACE,
  NEEDS_YOU_USAGE_LIMIT,
  needsYouStep,
  readWorkersFile,
  WorkerEntry,
  WorkersFile,
} from '../src/index.ts'

const entry = (x: Record<string, unknown> = {}) => ({ state: 'parked', tmux: 't-trip', cwd: '/home/alex/trip', ...x })
const file = (threads: Record<string, unknown>) =>
  JSON.stringify({ v: 1, supervisor: { pid: 1, heartbeat_at: '2026-11-12T10:00:00.000Z' }, threads })

describe('workers.json entry: the status fields', () => {
  it('an entry an older Mac wrote has none of them', () => {
    const e = WorkerEntry.parse(entry())
    expect(e.needs_you).toBeUndefined()
    expect(e.stopped_why).toBeUndefined()
    expect(e.turn_started_at).toBeUndefined()
  })

  it('as the Mac writes them, they read back', () => {
    const e = WorkerEntry.parse(
      entry({
        state: 'busy',
        needs_you: { kind: 'Computer Use needs macOS permissions', since: '2026-11-12T10:00:00.000Z' },
        turn_started_at: '2026-11-12T09:58:00.000Z',
      }),
    )
    expect(e.needs_you).toEqual({ kind: 'Computer Use needs macOS permissions', since: '2026-11-12T10:00:00.000Z' })
    expect(e.turn_started_at).toBe('2026-11-12T09:58:00.000Z')
    expect(WorkerEntry.parse(entry({ stopped_why: 'idle' })).stopped_why).toBe('idle')
  })

  it('a value that does not fit is none (or unknown) for that entry, never the file, and the other threads read', () => {
    const r = readWorkersFile(
      file({
        trip: entry({ needs_you: { kind: 7 }, stopped_why: 'solar_flare', turn_started_at: 'soon' }),
        garden: entry({ stopped_why: 'idle' }),
        nulls: entry({ needs_you: null, stopped_why: null, turn_started_at: null }),
      }),
    )
    expect(r?.unavailable).toEqual([])
    expect(r?.threads.trip?.needs_you).toBeUndefined()
    expect(r?.threads.trip?.stopped_why).toBe('unknown')
    expect(r?.threads.trip?.turn_started_at).toBeUndefined()
    expect(r?.threads.garden?.stopped_why).toBe('idle')
    expect(r?.threads.nulls?.needs_you ?? null).toBeNull()
    expect(r?.threads.nulls?.stopped_why ?? null).toBeNull()
  })

  it('a long kind is clipped, never refused, and never ends on half of a pair', () => {
    const kind = `${'x'.repeat(79)}😀tail`
    const e = WorkerEntry.parse(entry({ needs_you: { kind, since: '2026-11-12T10:00:00.000Z' } }))
    expect(e.needs_you?.kind).toBe('x'.repeat(79))
  })

  it('an older reader (the schema before these fields) reads the new entry whole', () => {
    const Old = WorkersFile.extend({
      threads: z.record(z.string(), WorkerEntry.omit({ needs_you: true, stopped_why: true, turn_started_at: true })),
    })
    const r = Old.safeParse(
      JSON.parse(
        file({
          trip: entry({
            needs_you: { kind: 'trust', since: '2026-11-12T10:00:00.000Z' },
            stopped_why: 'idle',
            turn_started_at: '2026-11-12T10:00:00.000Z',
          }),
        }),
      ),
    )
    expect(r.success).toBe(true)
  })
})

describe("main-restart-check.json: Main's needs_you", () => {
  const base = { v: 1, at: '2026-11-12T10:00:00Z', will_return: true, reasons: [] }
  it('reads when written, is absent from an older app, and one that does not fit is none, never the file', () => {
    expect(MainRestartCheckFile.parse(base).needs_you).toBeUndefined()
    expect(
      MainRestartCheckFile.parse({ ...base, needs_you: { kind: 'folder trust', since: '2026-11-12T10:00:00Z' } })
        .needs_you,
    ).toEqual({ kind: 'folder trust', since: '2026-11-12T10:00:00Z' })
    const bad = MainRestartCheckFile.safeParse({ ...base, needs_you: { kind: '', since: 'x' } })
    expect(bad.success && bad.data.needs_you).toBe(undefined)
  })
})

describe('the needs_you kinds that are never "answer it": the usage limit and computer use', () => {
  const since = '2026-11-12T10:00:00.000Z'
  it('read in workers.json and in main-restart-check.json as the Mac writes them', () => {
    expect(WorkerEntry.parse(entry({ state: 'live', needs_you: { kind: 'usage limit', since } })).needs_you).toEqual({
      kind: NEEDS_YOU_USAGE_LIMIT,
      since,
    })
    const base = { v: 1, at: since, will_return: false, reasons: [] }
    expect(MainRestartCheckFile.parse({ ...base, needs_you: { kind: 'usage limit', since } }).needs_you?.kind).toBe(
      'usage limit',
    )
  })

  it('have a step that says Esc and never "answer"; any other kind, unknown or not a string, has none', () => {
    for (const k of [NEEDS_YOU_USAGE_LIMIT, NEEDS_YOU_COMPUTER_USE]) {
      const step = needsYouStep(k)
      expect(step).toContain('press Esc')
      expect(step?.toLowerCase()).not.toMatch(/answer|approve|accept|confirm/)
    }
    expect(needsYouStep(NEEDS_YOU_USAGE_LIMIT)).toContain('/model <another model>')
    for (const k of [
      'folder trust',
      'Usage Limit',
      'usage limit ',
      '__proto__',
      'constructor',
      '',
      7,
      null,
      undefined,
      {},
    ])
      expect(needsYouStep(k)).toBeUndefined()
  })

  it("say where in the platform's words: the Mac's sentences byte for byte by default, a Linux computer's name or 'there'", () => {
    expect(needsYouStep(NEEDS_YOU_USAGE_LIMIT)).toBe(
      'press Esc in its pane at the Mac, then /model <another model> (Talos presses nothing there: one option spends usage credits)',
    )
    expect(needsYouStep(NEEDS_YOU_COMPUTER_USE)).toBe(
      'press Esc in its pane at the Mac to close it (Esc only: Enter opens System Settings)',
    )
    expect(needsYouStep(NEEDS_YOU_USAGE_LIMIT, NEEDS_YOU_MAC_PLACE)).toBe(needsYouStep(NEEDS_YOU_USAGE_LIMIT))
    expect(needsYouStep(NEEDS_YOU_USAGE_LIMIT, 'on box')).toBe(
      'press Esc in its pane on box, then /model <another model> (Talos presses nothing there: one option spends usage credits)',
    )
    expect(needsYouStep(NEEDS_YOU_USAGE_LIMIT, 'there')).toBe(
      'press Esc in its pane there, then /model <another model> (Talos presses nothing there: one option spends usage credits)',
    )
    // computer use never comes up on Linux (no detector raises it there): its sentence is only pinned (Pantheon)
    expect(needsYouStep(NEEDS_YOU_COMPUTER_USE, 'on box')).toBe('press Esc in its pane on box to close it (Esc only)')
    expect(needsYouStep('folder trust', 'on box')).toBeUndefined()
  })

  it('are the very words the Mac writes (Swift sources)', () => {
    const src = (f: string) =>
      readFileSync(
        join(import.meta.dirname, '..', '..', '..', 'apps', 'desktop', 'Sources', 'TalosDesktopCore', f),
        'utf8',
      )
    expect(src('UsageLimitScreen.swift')).toContain(`public static let kind = "${NEEDS_YOU_USAGE_LIMIT}"`)
    expect(src('DialogMatcher.swift')).toContain(`case .computerUsePermissions: return "${NEEDS_YOU_COMPUTER_USE}"`)
  })
})
