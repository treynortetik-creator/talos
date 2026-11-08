// `last_active_at` in workers.json: the Mac saves a worker's last real activity so a relaunched app can carry the idle clock on.
// Optional and tolerant on both sides: a bad value reads as none and never makes the file unreadable, and a bridge that has not
// been updated still reads a file that has it.
import { describe, expect, it } from 'vitest'
import { parseWorkersFile } from '../src/index.ts'
import { oldParseWorkersFile } from './support/workers-file-before-last-active.ts'

const file = (trip: Record<string, unknown>) =>
  JSON.stringify({
    v: 1,
    supervisor: { pid: 1, heartbeat_at: '2026-11-07T10:41:00.000Z', workers_supported: true },
    threads: {
      trip: {
        state: 'live',
        tmux: 't-trip',
        cwd: '/home/alex/trip',
        last_turn_at: '2026-11-07T09:00:00.000Z',
        ...trip,
      },
      walk: { state: 'parked', tmux: 't-walk', cwd: '/home/alex/walk', parked_at: '2026-11-07T08:00:00.000Z' },
    },
  })

describe('workers.json last_active_at', () => {
  it('is optional: an entry without it parses as before', () => {
    const f = parseWorkersFile(file({}))
    expect(f?.threads.trip?.last_active_at).toBeUndefined()
  })

  it('is read as a time', () => {
    const f = parseWorkersFile(file({ last_active_at: '2026-11-07T10:40:12.250Z' }))
    expect(f?.threads.trip?.last_active_at).toBe('2026-11-07T10:40:12.250Z')
    expect(f?.threads.walk?.state).toBe('parked')
  })

  it.each([17, 'yesterday', null, { a: 1 }, ['x']])(
    'a value that is not a time (%j) reads as none and never nulls the file',
    (v) => {
      const f = parseWorkersFile(file({ last_active_at: v }))
      expect(f).not.toBeNull()
      expect(f?.threads.trip?.last_active_at).toBeUndefined()
      expect(f?.threads.trip?.state).toBe('live')
      expect(f?.threads.walk?.parked_at).toBe('2026-11-07T08:00:00.000Z')
    },
  )
})

describe('a bridge that has not been updated reads a file that has last_active_at', () => {
  const text = file({ last_active_at: '2026-11-07T10:40:12.250Z' })

  it('control: the pinned old schema has no such key', () => {
    const shape = JSON.stringify(Object.keys(oldParseWorkersFile(file({}))?.threads.trip ?? {}))
    expect(shape).not.toContain('last_active_at')
  })

  it('does not return null, and every other entry and field stays intact', () => {
    const f = oldParseWorkersFile(text)
    expect(f).not.toBeNull()
    expect(f?.supervisor.workers_supported).toBe(true)
    expect(f?.threads.trip).toMatchObject({ state: 'live', tmux: 't-trip', last_turn_at: '2026-11-07T09:00:00.000Z' })
    expect(f?.threads.walk).toMatchObject({ state: 'parked', parked_at: '2026-11-07T08:00:00.000Z' })
    expect(Object.keys(f?.threads ?? {}).sort()).toEqual(['trip', 'walk'])
  })

  it('reads the same file the same way as the same file without the key', () => {
    const without = oldParseWorkersFile(file({}))
    const withKey = oldParseWorkersFile(text)
    expect(withKey).toEqual(without)
  })
})
