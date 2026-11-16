// `stopping_since` in workers.json: the Mac writes when a worker was asked to stop after its turn, so a relaunched app counts the
// turn's time from the stop. It is the Mac's own field: this schema does not name it, and a file that carries it (with any value)
// must read here exactly as one without it, in this build and in one from before the field existed.
import { describe, expect, it } from 'vitest'
import { parseWorkersFile } from '../src/index.ts'
import { oldParseWorkersFile } from './support/workers-file-before-last-active.ts'

const file = (trip: Record<string, unknown>) =>
  JSON.stringify({
    v: 1,
    supervisor: { pid: 1, heartbeat_at: '2026-11-10T10:41:00.000Z', workers_supported: true },
    threads: {
      trip: { state: 'stopping', tmux: 't-trip', cwd: '/home/alex/trip', pane_pid: 4242, ...trip },
      walk: { state: 'parked', tmux: 't-walk', cwd: '/home/alex/walk', parked_at: '2026-11-10T08:00:00.000Z' },
    },
  })

describe('workers.json stopping_since (the Mac’s own field)', () => {
  it.each(['2026-11-10T10:40:12.250Z', 17, 'yesterday', null, { a: 1 }])(
    'a file that has it (%j) reads as the file without it',
    (v) => {
      const without = parseWorkersFile(file({}))
      expect(without).not.toBeNull()
      expect(parseWorkersFile(file({ stopping_since: v }))).toEqual(without)
      expect(oldParseWorkersFile(file({ stopping_since: v }))).toEqual(oldParseWorkersFile(file({})))
      expect(oldParseWorkersFile(file({ stopping_since: v }))?.threads.trip?.state).toBe('stopping')
    },
  )
})
