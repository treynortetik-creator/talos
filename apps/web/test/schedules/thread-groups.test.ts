// Jobs grouped by the thread they run in, and who runs each group (docs/OPTION-C.md "Thread schedules").
import { ThreadId } from '@talos-app/protocol'
import { describe, expect, it } from 'vitest'
import {
  groupByThread,
  jobRunnerText,
  MAIN_GROUP,
  RUNNER_WORDS,
  type Runner,
  runnerOf,
} from '../../src/features/schedules/logic.ts'
import { NOW_MS, VARIANTS } from './variants.ts'

const threads = [
  { id: 'general', name: 'General' },
  { id: 'trip', name: 'Trip' },
  { id: 'garden', name: 'Garden' },
  { id: 'shared_one', name: 'Rota' },
  { id: 'archived_one', name: 'Old plans', archived: true },
]
const group = (runner: (id: string | null) => Runner = () => 'main') =>
  groupByThread(VARIANTS.byThread(), NOW_MS, { threads, defaultThread: 'general', runner })

describe('groupByThread', () => {
  it("Main first, then each thread in the list's order; a thread that is archived or gone folds into Main", () => {
    const g = group()
    expect(g.map((x) => x.key)).toEqual([MAIN_GROUP, 'trip', 'garden', 'shared_one'])
    expect(g[0]?.name).toBe('Main')
    expect(g[0]?.rows.map((r) => r.id).sort()).toEqual(['daily-summary', 'gone-thread-job'])
    expect(g[1]?.rows.map((r) => r.id)).toEqual(['packing-check', 'trip-backup', 'trip-both', 'hotel-watch']) // on jobs before the off one
    expect(g[1]?.name).toBe('Trip')
    expect(g[3]?.name).toBe('Rota')
  })

  it("a job in the default thread is Main's, and an empty thread has no group", () => {
    const snap = VARIANTS.byThread()
    const g = groupByThread(
      { ...snap, schedules: snap.schedules.map((s) => (s.id === 'water-plants' ? { ...s, thread_id: 'general' } : s)) },
      NOW_MS,
      { threads, defaultThread: 'general', runner: () => 'main' },
    )
    expect(g.map((x) => x.key)).toEqual([MAIN_GROUP, 'trip', 'shared_one'])
    expect(g[0]?.rows.map((r) => r.id)).toContain('water-plants')
  })

  it('asks for the runner of Main as null and of a thread by id', () => {
    const asked: Array<string | null> = []
    group((id) => {
      asked.push(id)
      return 'main'
    })
    expect(asked).toEqual([null, 'trip', 'garden', 'shared_one'])
  })

  it('no jobs, no groups', () => {
    expect(
      groupByThread({ ...VARIANTS.byThread(), schedules: [] }, NOW_MS, {
        threads,
        defaultThread: 'general',
        runner: () => 'main',
      }),
    ).toEqual([])
  })
})

describe('a thread whose id is "main" is not Main', () => {
  it("has its own group; Main's key is one no thread id can take", () => {
    const snap = VARIANTS.byThread()
    const g = groupByThread(
      { ...snap, schedules: snap.schedules.map((s) => (s.id === 'water-plants' ? { ...s, thread_id: 'main' } : s)) },
      NOW_MS,
      { threads: [...threads, { id: 'main', name: 'Mainland' }], defaultThread: 'general', runner: () => 'main' },
    )
    const keys = g.map((x) => x.key)
    expect(keys).toContain('main')
    expect(keys.filter((k) => k === MAIN_GROUP)).toHaveLength(1)
    expect(g.find((x) => x.key === 'main')?.rows.map((r) => r.id)).toEqual(['water-plants'])
    expect(g.find((x) => x.key === MAIN_GROUP)?.rows.map((r) => r.id)).not.toContain('water-plants')
    expect(ThreadId.safeParse(MAIN_GROUP).success).toBe(false)
  })
})

describe("jobRunnerText: the job's own runner decides", () => {
  const j = (
    runner: 'session' | 'headless' | 'both',
    kind: 'claude' | 'command' = 'claude',
    permissions: 'full' | 'restricted' = 'full',
  ) => ({ runner, kind, permissions })
  it('only a session job in a thread with its own session reads "own session"', () => {
    expect(jobRunnerText(j('session'), 'own_live', 'Trip')).toEqual({ text: "Runs in Trip's own session", own: true })
    expect(jobRunnerText(j('session'), 'main', 'Rota')).toEqual({ text: 'Run by Main', own: false })
  })
  it('a session job with restricted permissions is headless: never "own session"', () => {
    for (const g of ['own_live', 'own_parked', 'own', 'main'] as const)
      expect(jobRunnerText(j('session', 'claude', 'restricted'), g, 'Trip')).toEqual({
        text: 'Runs in the background, no session',
        own: false,
      })
  })
  it('headless, both and command never do, whoever runs the group', () => {
    for (const g of ['own_live', 'own_parked', 'own', 'main'] as const) {
      expect(jobRunnerText(j('headless'), g, 'Trip').own).toBe(false)
      expect(jobRunnerText(j('both'), g, 'Trip').own).toBe(false)
      expect(jobRunnerText(j('session', 'command'), g, 'Trip').own).toBe(false)
    }
    expect(jobRunnerText(j('headless'), 'own_live', 'Trip').text).toBe('Runs in the background, no session')
    expect(jobRunnerText(j('both'), 'own_live', 'Trip').text).toBe('Run by Main, with a background backup')
  })
})

describe('runnerOf', () => {
  const r = (dedicated: boolean, supported: boolean, state?: string) =>
    runnerOf({ dedicated, supported, worker: state ? { state: state as never } : undefined })
  it('own session, live or parked; a thread never started wakes on its first job', () => {
    expect(r(true, true, 'live')).toBe('own_live')
    expect(r(true, true, 'busy')).toBe('own_live')
    expect(r(true, true, 'parked')).toBe('own_parked')
    expect(r(true, true, 'off')).toBe('own_parked')
    expect(r(true, true)).toBe('own_parked')
  })
  it('a session that is between states is only "own session" (no claim about live or parked)', () => {
    for (const s of ['starting', 'parking', 'unknown']) expect(r(true, true, s)).toBe('own')
  })
  it('run by Main when the thread is shared, the Mac cannot host sessions, or the session failed or is stopping', () => {
    expect(r(false, true, 'live')).toBe('main')
    expect(r(true, false, 'live')).toBe('main')
    expect(r(true, true, 'failed')).toBe('main')
    expect(r(true, true, 'stopping')).toBe('main')
  })
  it('the words', () => {
    expect(RUNNER_WORDS).toEqual({
      own_live: 'own session · live',
      own_parked: 'own session · parked',
      own: 'own session',
      main: 'run by Main',
    })
  })
})
