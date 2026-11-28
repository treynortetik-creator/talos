// workers.json carries, in a session's own entry, when Claude Code's own wait at a usage limit was first seen on its pane.
import { describe, expect, it } from 'vitest'
import { WorkerEntry } from '../src/index.ts'

const base = { state: 'live', tmux: 't-trip', cwd: '/home/alex/trip' }

describe('workers.json limit_wait', () => {
  it('reads as written, with or without the reset', () => {
    const a = WorkerEntry.parse({ ...base, limit_wait: { since: '2026-11-10T12:00:00.000Z' } })
    expect(a.limit_wait).toEqual({ since: '2026-11-10T12:00:00.000Z' })
    const b = WorkerEntry.parse({
      ...base,
      limit_wait: { since: '2026-11-10T12:00:00.000Z', reset: '2026-11-10T16:00:00.000Z' },
    })
    expect(b.limit_wait?.reset).toBe('2026-11-10T16:00:00.000Z')
  })
  it('absent, null or junk is no wait, and never costs the entry', () => {
    for (const junk of [undefined, null, 'x', 5, {}, { since: 'yesterday' }, { reset: '2026-11-10T16:00:00.000Z' }]) {
      const e = WorkerEntry.parse({ ...base, limit_wait: junk })
      expect(e.limit_wait ?? undefined).toBeUndefined()
      expect(e.state).toBe('live')
    }
    const noReset = WorkerEntry.parse({ ...base, limit_wait: { since: '2026-11-10T12:00:00.000Z', reset: 'soon' } })
    expect(noReset.limit_wait).toEqual({ since: '2026-11-10T12:00:00.000Z' })
  })
})
