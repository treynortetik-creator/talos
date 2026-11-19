// What writeWake keeps beside the wake (worker/files.ts): a record of the capped wakes it wrote, for the up-front gap and cap
// check when the reader keeps no state; and what that check counts (wakeCapTimes). The wake itself never waits on that record,
// and no wake carries a counter. Temp folders only.
import { afterEach, describe, expect, it } from 'bun:test'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  WAKE_STATE_TAKEN_MAX,
  WakeFile,
  type WakeFileT,
  WORKER_FILES,
  wakeCapCheck,
  wakeDecision,
} from '@talos-app/protocol'
import { takeWake } from '../src/supervisor/workers-file.ts'
import { readControl, readWake, wakeCapTimes, workerDir, writeControl, writeWake } from '../src/worker/files.ts'

const dirs: string[] = []
const home = () => {
  const d = mkdtempSync(join(tmpdir(), 'talos-wake-written-'))
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
  for (const d of dirs.splice(0)) {
    try {
      chmodSync(join(d, 'workers', 'trip'), 0o700)
    } catch {}
    rmSync(d, { recursive: true, force: true })
  }
})
const AT = '2026-11-13T12:00:00.000Z'
const AT_MS = Date.parse(AT)
const wake = (action: WakeFileT['action'] = 'restart', at = AT): WakeFileT => ({
  v: 1,
  thread_id: 'trip',
  message_ids: action === 'pointer' ? ['m_01JBF3V7Q8K2M4N6P8R0S2T401'] : [],
  at,
  reason: action === 'pointer' ? 'message' : 'control',
  action,
})
/** A pointer goes to `wake`, a control to `control` (BSUP-5). */
const put = (h: string, w: WakeFileT, warn?: Parameters<typeof writeWake>[2]) =>
  w.action === 'pointer' ? writeWake(h, w, warn) : writeControl(h, w, warn)
const written = (h: string) => join(workerDir(h, 'trip'), WORKER_FILES.wakeWritten)
const statePath = (h: string) => join(workerDir(h, 'trip'), WORKER_FILES.wakeState)
const rawWake = (h: string, file: string = WORKER_FILES.wake) =>
  JSON.parse(readFileSync(join(workerDir(h, 'trip'), file), 'utf8'))

describe('the record of capped wakes the bridge wrote', () => {
  it('restart and fresh are recorded by their at and action, 0600; park, resume and pointer wakes are not', () => {
    const h = home()
    put(h, wake('restart'))
    put(h, wake('pointer'))
    put(h, wake('park'))
    put(h, wake('resume'))
    put(h, wake('fresh', '2026-11-13T12:00:30.000Z'))
    expect(JSON.parse(readFileSync(written(h), 'utf8'))).toEqual({
      v: 1,
      capped: [
        { at: AT_MS, action: 'restart' },
        { at: AT_MS + 30_000, action: 'fresh' },
      ],
    })
    expect(statSync(written(h)).mode & 0o777).toBe(0o600)
  })

  it('keeps the newest WAKE_STATE_TAKEN_MAX', () => {
    const h = home()
    for (let i = 0; i < WAKE_STATE_TAKEN_MAX + 3; i++) put(h, wake('restart', new Date(AT_MS + i * 1000).toISOString()))
    const kept = JSON.parse(readFileSync(written(h), 'utf8')).capped as Array<{ at: number }>
    expect(kept).toHaveLength(WAKE_STATE_TAKEN_MAX)
    expect(kept[kept.length - 1]?.at).toBe(AT_MS + (WAKE_STATE_TAKEN_MAX + 2) * 1000)
  })

  it('no wake carries a counter, even one a caller passed', () => {
    const h = home()
    put(h, { ...wake('restart'), counter: 9 })
    expect('counter' in rawWake(h, WORKER_FILES.control)).toBe(false)
    expect(existsSync(join(workerDir(h, 'trip'), 'wake-counter.json'))).toBe(false)
  })

  it('a record that cannot be written costs the record only: the wake goes, and the failure is logged', () => {
    const h = home()
    mkdirSync(written(h), { recursive: true }) // a folder where the record goes: its write fails
    const warned: Array<[string, Record<string, unknown>]> = []
    put(h, wake('restart'), (m, f) => warned.push([m, f]))
    expect(readControl(h, 'trip')?.action).toBe('restart')
    expect(warned).toHaveLength(1)
    expect(warned[0]?.[0]).toBe('wake record not written')
    expect(warned[0]?.[1]).toMatchObject({ thread: 'trip' })
  })

  it('a pointer wake never touches the record, so nothing there can stop it', () => {
    const h = home()
    mkdirSync(written(h), { recursive: true })
    const warned: string[] = []
    put(h, wake('pointer'), (m) => warned.push(m))
    expect(readWake(h, 'trip')?.action).toBe('pointer')
    expect(warned).toEqual([])
  })

  it('a record that is not ours reads as none', () => {
    const h = home()
    mkdirSync(workerDir(h, 'trip'), { recursive: true })
    for (const junk of ['not json', '{"v":2,"capped":[]}', '{"v":1,"capped":[5]}', '{"v":1,"capped":"x"}']) {
      writeFileSync(written(h), junk)
      expect(wakeCapTimes(h, 'trip'), junk).toEqual([])
    }
  })
})

describe('what the up-front check counts (wakeCapTimes)', () => {
  it('without reader state: the bridge record', () => {
    const h = home()
    put(h, wake('restart'))
    expect(wakeCapTimes(h, 'trip')).toEqual([AT_MS])
  })

  it('with reader state: what the reader took plus the capped wake still waiting, each once', () => {
    const h = home()
    put(h, wake('restart', '2026-11-13T11:59:00.000Z'))
    takeWake(h, 'trip') // the reader took it ...
    writeFileSync(statePath(h), JSON.stringify({ v: 1, taken: [{ at: AT_MS - 60_000, action: 'restart' }] }))
    put(h, wake('fresh')) // ... and this one still waits in the file
    expect(wakeCapTimes(h, 'trip').sort()).toEqual([AT_MS - 60_000, AT_MS])
    // the reader takes the waiting one too: the same wake is counted once
    takeWake(h, 'trip')
    writeFileSync(
      statePath(h),
      JSON.stringify({
        v: 1,
        taken: [
          { at: AT_MS - 60_000, action: 'restart' },
          { at: AT_MS, action: 'fresh' },
        ],
      }),
    )
    expect(wakeCapTimes(h, 'trip').sort()).toEqual([AT_MS - 60_000, AT_MS])
  })

  it('a double tap: the first restart still waiting refuses the second up front, with reader state present', () => {
    const h = home()
    mkdirSync(workerDir(h, 'trip'), { recursive: true })
    writeFileSync(statePath(h), JSON.stringify({ v: 1, taken: [] }))
    put(h, wake('restart'))
    expect(wakeCapCheck(wakeCapTimes(h, 'trip'), AT_MS + 500)).toMatchObject({ ok: false, why: 'gap' })
  })

  it('the reader state says it took none, and no capped wake waits: nothing counts, whatever the bridge wrote', () => {
    const h = home()
    put(h, wake('restart'))
    takeWake(h, 'trip') // taken and refused, say
    writeFileSync(statePath(h), JSON.stringify({ v: 1, taken: [] }))
    expect(wakeCapTimes(h, 'trip')).toEqual([])
  })

  it('end to end through the Linux reader: a wake dropped back after it was taken is stale once its at is past 5 minutes', () => {
    const h = home()
    put(h, wake('restart'))
    const copy = readFileSync(join(workerDir(h, 'trip'), WORKER_FILES.control))
    const first = takeWake(h, 'trip') as WakeFileT
    expect(wakeDecision({ wake: first, now: AT_MS, recentTaken: [], threadIdle: true })).toMatchObject({ take: true })
    writeFileSync(join(workerDir(h, 'trip'), WORKER_FILES.control), copy)
    const again = takeWake(h, 'trip') as WakeFileT
    // inside 5 minutes the gap refuses it; after, its age does
    expect(wakeDecision({ wake: again, now: AT_MS + 1000, recentTaken: [AT_MS], threadIdle: true })).toMatchObject({
      take: false,
      why: 'gap',
    })
    expect(wakeDecision({ wake: again, now: AT_MS + 300_001, recentTaken: [AT_MS], threadIdle: true })).toMatchObject({
      take: false,
      why: 'too_old',
    })
  })
})

describe('which file a wake goes to (BSUP-5)', () => {
  const has = (h: string, f: string) => existsSync(join(workerDir(h, 'trip'), f))
  it('a control goes to `control`, never `wake`; a pointer to `wake`, never `control`', () => {
    for (const a of ['park', 'resume', 'restart', 'fresh'] as const) {
      const h = home()
      writeControl(h, wake(a))
      expect(has(h, WORKER_FILES.control), a).toBe(true)
      expect(has(h, WORKER_FILES.wake), a).toBe(false)
      expect(statSync(join(workerDir(h, 'trip'), WORKER_FILES.control)).mode & 0o777).toBe(0o600)
    }
    const h = home()
    writeWake(h, wake('pointer'))
    expect(has(h, WORKER_FILES.wake)).toBe(true)
    expect(has(h, WORKER_FILES.control)).toBe(false)
  })
  it('each refuses the other kind, and a pointer leaves a waiting control as it was', () => {
    const h = home()
    expect(() => writeWake(h, wake('restart'))).toThrow()
    expect(() => writeControl(h, wake('pointer'))).toThrow()
    writeControl(h, wake('restart'))
    const before = readFileSync(join(workerDir(h, 'trip'), WORKER_FILES.control), 'utf8')
    writeWake(h, wake('pointer'))
    expect(readFileSync(join(workerDir(h, 'trip'), WORKER_FILES.control), 'utf8')).toBe(before)
  })
  it('a newer control replaces an older one (the last tap wins)', () => {
    const h = home()
    writeControl(h, wake('restart'))
    writeControl(h, wake('park', '2026-11-13T12:00:05.000Z'))
    expect(readControl(h, 'trip')?.action).toBe('park')
  })
  it('the record of capped wakes counts exactly restart and fresh, as before', () => {
    const h = home()
    for (const a of ['park', 'resume', 'restart', 'fresh'] as const) writeControl(h, wake(a))
    writeWake(h, wake('pointer'))
    expect(JSON.parse(readFileSync(written(h), 'utf8')).capped.map((e: { action: string }) => e.action)).toEqual([
      'restart',
      'fresh',
    ])
  })
})

describe('where a control goes depends on what the supervisor says it reads (workers.json reads_control)', () => {
  const bare = () => {
    const d = mkdtempSync(join(tmpdir(), 'talos-wake-bare-'))
    dirs.push(d)
    return d
  }
  const flagFile = (h: string, text: string) => writeFileSync(join(h, 'workers.json'), text)
  const sup = (extra: Record<string, unknown>) =>
    JSON.stringify({
      v: 1,
      supervisor: { pid: 1, heartbeat_at: new Date().toISOString(), workers_supported: true, ...extra },
      threads: {},
    })
  it('(m1) no flag in workers.json: the control goes to `wake`, as before, and a later pointer replaces it (today)', () => {
    const h = bare()
    flagFile(h, sup({}))
    writeControl(h, wake('restart'))
    expect(existsSync(join(workerDir(h, 'trip'), WORKER_FILES.control))).toBe(false)
    expect(readWake(h, 'trip')?.action).toBe('restart')
    expect(wakeCapTimes(h, 'trip')).toEqual([AT_MS]) // still recorded and counted
    writeWake(h, wake('pointer'))
    expect(readWake(h, 'trip')?.action).toBe('pointer') // unchanged: the tap is lost to the old reader's single file
  })
  it('(m1c) no flag: the files are byte for byte what writeWake on main writes for the same control (wake and its record, 0600)', () => {
    const h = bare()
    flagFile(h, sup({}))
    writeControl(h, wake('restart'))
    const dir = workerDir(h, 'trip')
    // origin/main's writeWake: the parsed wake without `counter`, one line, 0600; then the capped record for restart/fresh
    const { counter: _c, ...parsed } = WakeFile.parse(wake('restart'))
    expect(readFileSync(join(dir, WORKER_FILES.wake), 'utf8')).toBe(`${JSON.stringify(parsed)}\n`)
    expect(statSync(join(dir, WORKER_FILES.wake)).mode & 0o777).toBe(0o600)
    expect(readFileSync(join(dir, WORKER_FILES.wakeWritten), 'utf8')).toBe(
      `${JSON.stringify({ v: 1, capped: [{ at: AT_MS, action: 'restart' }] })}\n`,
    )
    expect(statSync(join(dir, WORKER_FILES.wakeWritten)).mode & 0o777).toBe(0o600)
    expect(existsSync(join(dir, WORKER_FILES.control))).toBe(false)
  })
  it('(m1b) a flag that is false reads as none', () => {
    const h = bare()
    flagFile(h, sup({ reads_control: false }))
    writeControl(h, wake('park'))
    expect(readWake(h, 'trip')?.action).toBe('park')
    expect(readControl(h, 'trip')).toBeUndefined()
  })
  it('(m2) flag present: the control goes to `control` and a pointer does not replace it', () => {
    const h = bare()
    flagFile(h, sup({ reads_control: true }))
    writeControl(h, wake('restart'))
    writeWake(h, wake('pointer'))
    expect(readControl(h, 'trip')?.action).toBe('restart')
    expect(readWake(h, 'trip')?.action).toBe('pointer')
  })
  it('(m3) workers.json missing, torn or unreadable: the control goes to `wake`', () => {
    for (const setup of [
      (_h: string) => {},
      (h: string) => flagFile(h, '{"v":1,"supervisor":'),
      (h: string) => flagFile(h, ''),
      (h: string) => mkdirSync(join(h, 'workers.json')), // a folder where the file goes: unreadable
    ]) {
      const h = bare()
      setup(h)
      writeControl(h, wake('fresh'))
      expect(readWake(h, 'trip')?.action).toBe('fresh')
      expect(readControl(h, 'trip')).toBeUndefined()
    }
  })
})
