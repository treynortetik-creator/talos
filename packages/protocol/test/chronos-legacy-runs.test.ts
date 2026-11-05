import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { ChronosDetail } from '../src/schedules-chronos.ts'

// Chronos 0.3.1 rebuilds runs from older ran-markers with run_id, started_at and runner set to null (2026-11-03: this broke
// `talos-app schedules adopt` on the owner's Mac with "the answer does not parse at (root)").
const goldenDetail = () =>
  JSON.parse(readFileSync(join(import.meta.dirname, 'chronos-detail-legacy-runs.json'), 'utf8'))

describe('a Chronos detail with runs rebuilt from old markers', () => {
  it('parses, and the null fields are left out', () => {
    const r = ChronosDetail.parse(goldenDetail())
    expect(r.runs).toHaveLength(2)
    expect(r.runs[0]).toEqual({ ds: '2026-11-02', trigger: 'clock', status: 'ok', has_report: true })
    expect('run_id' in r.runs[0]).toBe(false)
  })
  it('still refuses a run with a wrong value, not only a null', () => {
    const d = goldenDetail()
    d.runs[0].runner = 'somewhere'
    expect(ChronosDetail.safeParse(d).success).toBe(false)
  })
  it('accepts the ended_at Chronos 0.3.1 sends on a finished run', () => {
    const d = goldenDetail()
    const run = {
      run_id: 'r_01M6GXC7WMQYASQ9CBWYEZW51K',
      ds: '2026-11-03',
      started_at: '2026-11-03T07:35:36-07:00',
      runner: 'session',
      trigger: 'clock',
      status: 'ok',
      duration_s: 63,
      has_report: true,
      ended_at: '2026-11-03T07:36:39-07:00',
    }
    d.schedule.last_run = run
    d.runs = [run]
    expect(ChronosDetail.safeParse(d).success).toBe(true)
  })
})
