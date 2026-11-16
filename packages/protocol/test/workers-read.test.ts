// Audit O3, the hub's side of workers-unreadable.ts: one workers.json entry the bridge cannot read costs that thread only. It
// is unavailable (never "off", never started on a guess); every other thread reads as written. The whole file is refused
// only in the WORKERS_FILE_REFUSED_WHEN cases. parseWorkersFile stays all-or-nothing for a writer (the Linux supervisor),
// which must never save fewer entries than it read.
import { describe, expect, it } from 'vitest'
import { parseWorkersFile, readWorkersFile, WORKERS_UNREADABLE_KEY } from '../src/index.ts'

const supervisor = { pid: 1, heartbeat_at: '2026-11-11T10:00:00.000Z', workers_supported: true }
const entry = (id: string, extra: Record<string, unknown> = {}) => ({
  state: 'live',
  tmux: `t-${id}`,
  cwd: `/home/alex/${id}`,
  ...extra,
})
const text = (o: Record<string, unknown>) => JSON.stringify({ v: 1, supervisor, ...o })

describe('readWorkersFile: entry by entry', () => {
  it('an entry it cannot read is unavailable; the others read as written', () => {
    for (const bad of [
      entry('garden', { cwd: 'relative/path' }), // outside the grammar (a hand-edited config seeds it)
      entry('garden', { model: 'not a model!' }),
      entry('garden', { state: 'daydreaming' }), // may be running: never treated as resting
      7,
      ['an', 'array'],
    ]) {
      const f = readWorkersFile(text({ threads: { trip: entry('trip'), garden: bad } }))
      expect(f, JSON.stringify(bad)).not.toBeNull()
      expect(Object.keys(f?.threads ?? {})).toEqual(['trip'])
      expect(f?.threads.trip?.state).toBe('live')
      expect(f?.unavailable).toEqual(['garden'])
    }
  })

  it(`a thread set aside under ${WORKERS_UNREADABLE_KEY} is unavailable; a K# copy holds nobody back`, () => {
    const f = readWorkersFile(
      text({
        threads: { trip: entry('trip'), walk: entry('walk') },
        [WORKERS_UNREADABLE_KEY]: { garden: '{"state":"x"}', 'walk#': '{"state":"y"}', walk: '{}' },
      }),
    )
    expect(f?.unavailable.slice().sort()).toEqual(['garden', 'walk'])
    expect(Object.keys(f?.threads ?? {}).sort()).toEqual(['trip', 'walk']) // read, but listed: unavailable wins
  })

  it('an error detail past 300 UTF-16 units is clipped, never the entry', () => {
    const detail = `${'x'.repeat(299)}😀 and more` // the emoji straddles unit 300
    const f = readWorkersFile(
      text({
        threads: {
          trip: entry('trip', {
            state: 'failed',
            error: { code: 'start_failed', detail, at: supervisor.heartbeat_at },
          }),
        },
      }),
    )
    expect(f?.unavailable).toEqual([])
    expect(f?.threads.trip?.error?.detail).toBe('x'.repeat(299))
  })

  it('refuses the whole file only where the contract says', () => {
    for (const bad of [
      'not json',
      '[]',
      '"a string"',
      JSON.stringify({ v: 2, supervisor, threads: {} }),
      text({}), // threads missing
      text({ threads: [] }),
      text({ threads: 'x' }),
      text({ threads: {}, [WORKERS_UNREADABLE_KEY]: ['x'] }),
      text({ threads: {}, [WORKERS_UNREADABLE_KEY]: 'x' }),
    ])
      expect(readWorkersFile(bad), bad).toBeNull()
    expect(readWorkersFile(text({ threads: {} }))?.unavailable).toEqual([])
  })

  it('parseWorkersFile (a writer’s read) is still all-or-nothing', () => {
    expect(
      parseWorkersFile(text({ threads: { trip: entry('trip'), garden: entry('garden', { cwd: 'x' }) } })),
    ).toBeNull()
  })
})
