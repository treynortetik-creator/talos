// The supervisor's side of the files it shares with the hub (P3d2): workers.json, each worker's nonce, the ready file the hub
// writes and the wake file it drops. Temp folders only; nothing is launched.
import { afterEach, describe, expect, it } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseWorkersFile, WORKER_CRASH_LOOP, WORKER_TRANSITIONS, type WorkerStateT } from '@talos-app/protocol'
import {
  buildWorkersFile,
  crashLooping,
  legalMove,
  newNonce,
  readReady,
  releaseWorkerFiles,
  setWorkersOn,
  takeWake,
  writeNonce,
  writeWorkersFile,
} from '../../src/supervisor/workers-file.ts'
import { workerDir, workersJsonPath, writeControl, writeReady } from '../../src/worker/files.ts'

const dirs: string[] = []
const home = () => {
  const d = mkdtempSync(join(tmpdir(), 'talos-workers-file-'))
  dirs.push(d)
  // a supervisor that reads `control`: the bridge writes a tap there (writeControl); the old-supervisor cases use bareHome
  writeFileSync(
    join(d, 'workers.json'),
    JSON.stringify({
      v: 1,
      supervisor: { pid: 1, heartbeat_at: new Date().toISOString(), workers_supported: true, reads_control: true },
      threads: {},
    }),
  )
  return d
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})
const NOW = Date.parse('2026-11-10T12:00:00.000Z')
const entry = (over: Record<string, unknown> = {}) => ({
  state: 'live' as WorkerStateT,
  session_id: '11111111-2222-3333-4444-555555555555',
  tmux: 't-trip',
  pane_pid: 4242,
  cwd: '/home/alex/trip',
  ...over,
})

describe('workers.json', () => {
  it('is what the hub reads back: v1, the supervisor block, one entry per thread; nothing is claimed it cannot do', () => {
    const h = home()
    const f = buildWorkersFile({ pid: 77, nowMs: NOW, mainPanePid: 9, threads: { trip: entry() } })
    writeWorkersFile(h, f)
    const back = parseWorkersFile(readFileSync(workersJsonPath(h), 'utf8'))
    expect(back?.supervisor).toMatchObject({
      pid: 77,
      heartbeat_at: '2026-11-10T12:00:00.000Z',
      main_pane_pid: 9,
      workers_supported: true,
      subthreads_supported: true,
    })
    expect(back?.threads.trip?.pane_pid).toBe(4242)
    expect(statSync(workersJsonPath(h)).mode & 0o777).toBe(0o600)
  })
  it('a resting worker carries pane_pid 0, and an entry the schema refuses is a bug, never a written file', () => {
    const f = buildWorkersFile({
      pid: 1,
      nowMs: NOW,
      mainPanePid: 0,
      threads: { trip: entry({ state: 'parked', pane_pid: 4242 }) },
    })
    expect(f.threads.trip?.pane_pid).toBe(0)
    expect(() =>
      buildWorkersFile({ pid: 1, nowMs: NOW, mainPanePid: 0, threads: { trip: entry({ tmux: 'nope' }) } }),
    ).toThrow()
  })
})

describe('the capability flag for `control` (BSUP-5)', () => {
  it('the Linux supervisor says it reads `control` whenever it writes workers.json; a file without the flag reads as false', () => {
    expect(buildWorkersFile({ pid: 1, nowMs: NOW, mainPanePid: 0, threads: {} }).supervisor.reads_control).toBe(true)
    const old = {
      v: 1,
      supervisor: { pid: 1, heartbeat_at: '2026-11-10T12:00:00.000Z', workers_supported: true },
      threads: {},
    }
    expect(parseWorkersFile(JSON.stringify(old))?.supervisor.reads_control).toBe(false)
  })
})

describe('the owner’s switch for thread sessions', () => {
  afterEach(() => setWorkersOn(() => true))
  const build = () => buildWorkersFile({ pid: 1, nowMs: NOW, mainPanePid: 0, threads: {} }).supervisor
  it('on unless the owner turned it off (supervisor.json workers: false): then workers.json says it hosts none', () => {
    expect(build().workers_supported).toBe(true)
    setWorkersOn(() => false)
    expect(build().workers_supported).toBe(false)
    expect(build().subthreads_supported).toBe(true) // as the Mac says it: sub-thread routing and config need no session
    expect(build().subthreads_shared_folder).toBe(true) // and runs a sub-thread in its parent's folder, as the Mac does
    expect(build().subthreads_own_folder).toBe(true) // and keeps an own folder outside its parent's, as the Mac does (c24c01f8)
  })
})

describe('the nonce and the ready file', () => {
  it('a fresh nonce is NONCE_BYTES of lowercase hex, written 0600 in a 0700 folder; each start gets a new one', () => {
    const h = home()
    const a = newNonce()
    expect(a).toMatch(/^[0-9a-f]{32}$/)
    expect(newNonce()).not.toBe(a)
    writeNonce(h, 'trip', a)
    expect(readFileSync(join(workerDir(h, 'trip'), 'nonce'), 'utf8')).toBe(a)
    expect(statSync(join(workerDir(h, 'trip'), 'nonce')).mode & 0o777).toBe(0o600)
    expect(statSync(workerDir(h, 'trip')).mode & 0o777).toBe(0o700)
  })
  it('ready counts only for its own thread; release removes nonce and ready, never the wake the hub may be writing', () => {
    const h = home()
    writeNonce(h, 'trip', newNonce())
    expect(readReady(h, 'trip')).toBeNull()
    writeReady(h, { v: 1, thread_id: 'trip', pid: 4242, at: '2026-11-10T12:00:00.000Z' })
    expect(readReady(h, 'trip')?.pid).toBe(4242)
    writeFileSync(join(workerDir(h, 'trip'), 'ready'), JSON.stringify({ v: 1, thread_id: 'other', pid: 1, at: 'x' }))
    expect(readReady(h, 'trip')).toBeNull()
    writeControl(h, {
      v: 1,
      thread_id: 'trip',
      message_ids: [],
      at: '2026-11-10T12:00:00.000Z',
      reason: 'control',
      action: 'park',
    })
    releaseWorkerFiles(h, 'trip')
    expect(existsSync(join(workerDir(h, 'trip'), 'nonce'))).toBe(false)
    expect(existsSync(join(workerDir(h, 'trip'), 'ready'))).toBe(false)
    expect(existsSync(join(workerDir(h, 'trip'), 'control'))).toBe(true)
  })
})

describe('the wake file', () => {
  const wake = { v: 1 as const, at: '2026-11-10T12:00:00.000Z', reason: 'control' as const, action: 'restart' as const }
  it('is taken once: read, then gone', () => {
    const h = home()
    writeControl(h, { ...wake, thread_id: 'trip', message_ids: [] })
    expect(takeWake(h, 'trip')?.action).toBe('restart')
    expect(existsSync(join(workerDir(h, 'trip'), 'wake'))).toBe(false)
    expect(takeWake(h, 'trip')).toBeNull()
  })
  it('a wake naming another thread, or one that does not parse, is dropped, never acted on', () => {
    const h = home()
    writeControl(h, { ...wake, thread_id: 'other', message_ids: [] })
    mkdirSync(workerDir(h, 'trip'), { recursive: true })
    writeFileSync(join(workerDir(h, 'trip'), 'control'), readFileSync(join(workerDir(h, 'other'), 'control')))
    expect(takeWake(h, 'trip')).toBeNull()
    expect(existsSync(join(workerDir(h, 'trip'), 'wake'))).toBe(false)
    writeFileSync(join(workerDir(h, 'trip'), 'wake'), '{"v":1,')
    expect(takeWake(h, 'trip')).toBeNull()
  })
  it('a thread id that is not one is never turned into a path', () => {
    expect(takeWake(home(), '../etc')).toBeNull()
  })
})

describe('the rules', () => {
  it('every move is one WORKER_TRANSITIONS allows', () => {
    expect(legalMove('live', 'parking')).toBe(true)
    expect(legalMove('live', 'starting')).toBe(false) // a restart goes through park
    for (const [from, tos] of Object.entries(WORKER_TRANSITIONS))
      for (const to of tos) expect(legalMove(from as WorkerStateT, to)).toBe(true)
  })
  it(`${WORKER_CRASH_LOOP.count} crashes inside ${WORKER_CRASH_LOOP.window_s / 60} minutes are a crash loop`, () => {
    const at = (agoS: number) => new Date(NOW - agoS * 1000).toISOString()
    expect(crashLooping([at(60), at(120), at(180), at(240)], NOW)).toBe(false)
    expect(crashLooping([at(60), at(120), at(180), at(240), at(300)], NOW)).toBe(true)
    expect(crashLooping([at(60), at(120), at(180), at(240), at(WORKER_CRASH_LOOP.window_s + 1)], NOW)).toBe(false)
    expect(crashLooping(['not a time', at(1), at(2), at(3), at(4)], NOW)).toBe(false)
  })
})
