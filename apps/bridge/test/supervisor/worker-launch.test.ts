// What a thread session was started with against its thread's settings now (P3d4, part 2; the Mac's LaunchChange.swift): the
// comparison, the settle wait, and the record written at each start.
import { describe, expect, it } from 'bun:test'
import { mkdtempSync, realpathSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { WORKER_TIMING, WorkerLaunched } from '@talos-app/protocol'
import {
  compareLaunch,
  type LaunchSig,
  launchedRecord,
  NO_CHANGE_PENDING,
  observeChange,
  wantedFolder,
  wantedLaunch,
} from '../../src/supervisor/worker-launch.ts'
import type { WorkerThread } from '../../src/supervisor/worker-types.ts'

const TRIP: WorkerThread = { id: 'trip', cwd: '/home/alex/trip', model: 'inherit', effort: null, parentCwd: null }
const SIG: LaunchSig = { cwd: '/home/alex/trip', model: 'inherit', effort: null, mcpAllow: null }

describe('compareLaunch', () => {
  it('no record of the launch (an older entry) is never a change', () => {
    expect(compareLaunch(undefined, SIG)).toEqual({ kind: 'none' })
  })
  it('the same launch is no change; the list is compared as a set', () => {
    expect(compareLaunch({ cwd: '/home/alex/trip', model: 'inherit' }, SIG)).toEqual({ kind: 'none' })
    expect(
      compareLaunch(
        { cwd: '/home/alex/trip', model: 'inherit', mcp_allow: ['b', 'a'] },
        { ...SIG, mcpAllow: ['a', 'b'] },
      ),
    ).toEqual({ kind: 'none' })
  })
  it('a new folder is a fresh start; anything else resumes, naming what changed', () => {
    expect(compareLaunch({ cwd: '/home/alex/old', model: 'opus' }, SIG).kind).toBe('fresh')
    expect(compareLaunch({ cwd: '/home/alex/trip', model: 'opus', effort: 'high' }, SIG)).toEqual({
      kind: 'restart',
      wanted: SIG,
      changed: ['model', 'effort'],
    })
  })
  it('no list and an empty list differ', () => {
    expect(compareLaunch({ cwd: '/home/alex/trip', model: 'inherit', mcp_allow: [] }, SIG)).toMatchObject({
      kind: 'restart',
      changed: ['mcp_allow'],
    })
    expect(compareLaunch({ cwd: '/home/alex/trip', model: 'inherit' }, { ...SIG, mcpAllow: [] })).toMatchObject({
      kind: 'restart',
      changed: ['mcp_allow'],
    })
  })
})

describe('compact_window in the launch', () => {
  const rec = { cwd: '/home/alex/trip', model: 'inherit' }
  it('a set value against a record without one is a change, named; the same value is none', () => {
    expect(compareLaunch(rec, { ...SIG, compactWindow: 400000 })).toMatchObject({
      kind: 'restart',
      changed: ['compact_window'],
    })
    expect(compareLaunch({ ...rec, compact_window: 400000 }, { ...SIG, compactWindow: 400000 })).toEqual({
      kind: 'none',
    })
    expect(compareLaunch({ ...rec, compact_window: 400000 }, { ...SIG, compactWindow: 300000 })).toMatchObject({
      changed: ['compact_window'],
    })
  })
  it('turned off after a launch with it is a change; never set and never recorded is none', () => {
    expect(compareLaunch({ ...rec, compact_window: 400000 }, SIG)).toMatchObject({ changed: ['compact_window'] })
    expect(compareLaunch(rec, { ...SIG, compactWindow: null })).toEqual({ kind: 'none' })
  })
  it('wantedLaunch and launchedRecord carry it, and a record of it matches the thread it was made from', () => {
    const t: WorkerThread = { ...TRIP, compactWindow: 400000 }
    expect(wantedLaunch(t, () => '/home/alex/trip').compactWindow).toBe(400000)
    expect(wantedLaunch(TRIP, () => '/home/alex/trip').compactWindow ?? null).toBeNull()
    expect(launchedRecord(t, '/home/alex/trip')?.compact_window).toBe(400000)
    expect(launchedRecord(TRIP, '/home/alex/trip')).not.toHaveProperty('compact_window')
  })
  it('an old record, or one with a value this build cannot read, reads as none', () => {
    expect(WorkerLaunched.parse(rec).compact_window).toBeUndefined()
    expect(WorkerLaunched.parse({ ...rec, compact_window: 5 }).compact_window).toBeUndefined()
  })
})

describe('observeChange (the settle wait)', () => {
  const change = compareLaunch({ cwd: '/home/alex/trip', model: 'opus' }, SIG)
  const settle = WORKER_TIMING.launch_change_settle_s
  it('a change is acted on once it has stood for launch_change_settle_s, and only once', () => {
    let r = observeChange(NO_CHANGE_PENDING, change, 100)
    expect(r.fire).toBeNull()
    r = observeChange(r.state, change, 100 + settle - 1)
    expect(r.fire).toBeNull()
    r = observeChange(r.state, change, 100 + settle)
    expect(r.fire).toEqual(change)
    expect(observeChange(r.state, change, 100 + settle + 1).fire).toBeNull() // the wait starts again
  })
  it('a change back before the settle passes forgets it; another change starts the wait again', () => {
    let r = observeChange(NO_CHANGE_PENDING, change, 100)
    r = observeChange(r.state, { kind: 'none' }, 110)
    r = observeChange(r.state, change, 120)
    expect(observeChange(r.state, change, 100 + settle).fire).toBeNull()
    const other = compareLaunch({ cwd: '/home/alex/trip', model: 'haiku' }, { ...SIG, model: 'sonnet' })
    r = observeChange(r.state, other, 125)
    expect(observeChange(r.state, other, 120 + settle).fire).toBeNull()
    expect(observeChange(r.state, other, 125 + settle).fire).toEqual(other)
  })
})

describe('the record and the wanted launch', () => {
  it('the record is schema-valid and compares equal to the settings it was made from', () => {
    const t: WorkerThread = { ...TRIP, model: 'opus', effort: 'high', mcpAllow: ['notion'] }
    const rec = launchedRecord(t, '/home/alex/trip')
    expect(rec).toEqual({ cwd: '/home/alex/trip', model: 'opus', effort: 'high', mcp_allow: ['notion'] })
    expect(WorkerLaunched.safeParse(rec).success).toBe(true)
    expect(
      compareLaunch(
        rec,
        wantedLaunch(t, (c) => c),
      ),
    ).toEqual({ kind: 'none' })
    expect(launchedRecord(TRIP, '/home/alex/trip')).toEqual({ cwd: '/home/alex/trip', model: 'inherit' })
  })
  it('keeps the launch’s spec hash and instructions digest (restart-on-update); neither makes the launch read as changed', () => {
    const h = `sha256:${'c'.repeat(64)}`
    const i = `sha256:${'d'.repeat(64)}`
    expect(launchedRecord(TRIP, '/home/alex/trip', { specHash: h })).toEqual({
      cwd: '/home/alex/trip',
      model: 'inherit',
      spec_hash: h,
    })
    const rec = launchedRecord(TRIP, '/home/alex/trip', { specHash: h, instructionsHash: i })
    expect(rec).toEqual({ cwd: '/home/alex/trip', model: 'inherit', spec_hash: h, instructions_hash: i })
    expect(
      compareLaunch(
        rec,
        wantedLaunch(TRIP, (c) => c),
      ),
    ).toEqual({ kind: 'none' })
  })
  it('a folder that cannot be known is never a new folder; options that cannot be read compare only the MCP list', () => {
    const rec = launchedRecord(TRIP, '/home/alex/trip')
    expect(
      compareLaunch(
        rec,
        wantedLaunch(TRIP, () => null),
      ),
    ).toEqual({ kind: 'none' })
    const unread: WorkerThread = { ...TRIP, cwd: '/home/alex/agent', model: 'sonnet', optsUnread: ['session_opts'] }
    expect(
      compareLaunch(
        rec,
        wantedLaunch(unread, (c) => c),
        unread,
      ),
    ).toEqual({ kind: 'none' })
    expect(
      compareLaunch(
        rec,
        wantedLaunch({ ...unread, mcpAllow: [] }, (c) => c),
        unread,
      ),
    ).toMatchObject({
      kind: 'restart',
      changed: ['mcp_allow'],
    })
  })
  it('a value the schema would change is not recorded (a record that never matches would restart for good)', () => {
    expect(launchedRecord(TRIP, 'relative/folder')).toBeUndefined()
    expect(launchedRecord({ ...TRIP, model: 'bad model!' }, '/home/alex/trip')).toBeUndefined()
  })
  it('the wanted folder is the folder as it really is (a symlink resolved); one that cannot be resolved is not known', () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'talos-launch-')))
    try {
      symlinkSync(root, join(root, 'link'))
      expect(wantedFolder(join(root, 'link'))).toBe(root)
      expect(wantedFolder('/nowhere/at/all')).toBeNull()
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})

describe('the enabled-plugin set is part of the launch', () => {
  const launched = { cwd: '/home/alex/trip', model: 'inherit' }
  it('a plugin turned on or off while the session runs is a restart (after its turn), naming plugins', () => {
    expect(compareLaunch({ ...launched, plugins: ['a@m'] }, { ...SIG, plugins: ['a@m', 'b@m'] })).toEqual({
      kind: 'restart',
      wanted: { ...SIG, plugins: ['a@m', 'b@m'] },
      changed: ['plugins'],
    })
  })
  it('the set is compared as a set', () => {
    expect(compareLaunch({ ...launched, plugins: ['b@m', 'a@m'] }, { ...SIG, plugins: ['a@m', 'b@m'] })).toEqual({
      kind: 'none',
    })
  })
  it('an entry an older build wrote (no set recorded), or a thread whose set is not known now, is never a change', () => {
    expect(compareLaunch(launched, { ...SIG, plugins: ['a@m'] })).toEqual({ kind: 'none' })
    expect(compareLaunch({ ...launched, plugins: ['a@m'] }, SIG)).toEqual({ kind: 'none' })
  })
  it('a start records the set, and the record reads back as the same launch', () => {
    const t: WorkerThread = { ...TRIP, plugins: ['b@m', 'a@m'] }
    const r = launchedRecord(t, '/home/alex/trip')
    expect(r?.plugins).toEqual(['b@m', 'a@m'])
    expect(wantedLaunch(t, () => '/home/alex/trip').plugins).toEqual(['a@m', 'b@m'])
    expect(
      compareLaunch(
        r,
        wantedLaunch(t, () => '/home/alex/trip'),
      ),
    ).toEqual({ kind: 'none' })
  })
  it('a set that is not a list of names reads as not recorded', () => {
    expect(WorkerLaunched.parse({ cwd: '/a', model: 'inherit', plugins: 'nope' }).plugins).toBeUndefined()
  })
})
