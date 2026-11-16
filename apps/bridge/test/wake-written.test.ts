// What writeWake keeps beside the wake (worker/files.ts): a record of the capped wakes it wrote, for the up-front gap and cap
// check when the reader keeps no state; and what that check counts (wakeCapTimes). The wake itself never waits on that record,
// and no wake carries a counter. Temp folders only.
import { afterEach, describe, expect, it } from 'bun:test'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { WAKE_STATE_TAKEN_MAX, type WakeFileT, WORKER_FILES, wakeCapCheck, wakeDecision } from '@talos-app/protocol'
import { takeWake } from '../src/supervisor/workers-file.ts'
import { readWake, wakeCapTimes, workerDir, writeWake } from '../src/worker/files.ts'

const dirs: string[] = []
const home = () => {
  const d = mkdtempSync(join(tmpdir(), 'talos-wake-written-'))
  dirs.push(d)
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
const written = (h: string) => join(workerDir(h, 'trip'), WORKER_FILES.wakeWritten)
const statePath = (h: string) => join(workerDir(h, 'trip'), WORKER_FILES.wakeState)
const rawWake = (h: string) => JSON.parse(readFileSync(join(workerDir(h, 'trip'), WORKER_FILES.wake), 'utf8'))

describe('the record of capped wakes the bridge wrote', () => {
  it('restart and fresh are recorded by their at and action, 0600; park, resume and pointer wakes are not', () => {
    const h = home()
    writeWake(h, wake('restart'))
    writeWake(h, wake('pointer'))
    writeWake(h, wake('park'))
    writeWake(h, wake('resume'))
    writeWake(h, wake('fresh', '2026-11-13T12:00:30.000Z'))
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
    for (let i = 0; i < WAKE_STATE_TAKEN_MAX + 3; i++)
      writeWake(h, wake('restart', new Date(AT_MS + i * 1000).toISOString()))
    const kept = JSON.parse(readFileSync(written(h), 'utf8')).capped as Array<{ at: number }>
    expect(kept).toHaveLength(WAKE_STATE_TAKEN_MAX)
    expect(kept[kept.length - 1]?.at).toBe(AT_MS + (WAKE_STATE_TAKEN_MAX + 2) * 1000)
  })

  it('no wake carries a counter, even one a caller passed', () => {
    const h = home()
    writeWake(h, { ...wake('restart'), counter: 9 })
    expect('counter' in rawWake(h)).toBe(false)
    expect(existsSync(join(workerDir(h, 'trip'), 'wake-counter.json'))).toBe(false)
  })

  it('a record that cannot be written costs the record only: the wake goes, and the failure is logged', () => {
    const h = home()
    mkdirSync(written(h), { recursive: true }) // a folder where the record goes: its write fails
    const warned: Array<[string, Record<string, unknown>]> = []
    writeWake(h, wake('restart'), (m, f) => warned.push([m, f]))
    expect(readWake(h, 'trip')?.action).toBe('restart')
    expect(warned).toHaveLength(1)
    expect(warned[0]?.[0]).toBe('wake record not written')
    expect(warned[0]?.[1]).toMatchObject({ thread: 'trip' })
  })

  it('a pointer wake never touches the record, so nothing there can stop it', () => {
    const h = home()
    mkdirSync(written(h), { recursive: true })
    const warned: string[] = []
    writeWake(h, wake('pointer'), (m) => warned.push(m))
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
    writeWake(h, wake('restart'))
    expect(wakeCapTimes(h, 'trip')).toEqual([AT_MS])
  })

  it('with reader state: what the reader took plus the capped wake still waiting, each once', () => {
    const h = home()
    writeWake(h, wake('restart', '2026-11-13T11:59:00.000Z'))
    takeWake(h, 'trip') // the reader took it ...
    writeFileSync(statePath(h), JSON.stringify({ v: 1, taken: [{ at: AT_MS - 60_000, action: 'restart' }] }))
    writeWake(h, wake('fresh')) // ... and this one still waits in the file
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
    writeWake(h, wake('restart'))
    expect(wakeCapCheck(wakeCapTimes(h, 'trip'), AT_MS + 500)).toMatchObject({ ok: false, why: 'gap' })
  })

  it('the reader state says it took none, and no capped wake waits: nothing counts, whatever the bridge wrote', () => {
    const h = home()
    writeWake(h, wake('restart'))
    takeWake(h, 'trip') // taken and refused, say
    writeFileSync(statePath(h), JSON.stringify({ v: 1, taken: [] }))
    expect(wakeCapTimes(h, 'trip')).toEqual([])
  })

  it('end to end through the Linux reader: a wake dropped back after it was taken is stale once its at is past 5 minutes', () => {
    const h = home()
    writeWake(h, wake('restart'))
    const copy = readFileSync(join(workerDir(h, 'trip'), WORKER_FILES.wake))
    const first = takeWake(h, 'trip') as WakeFileT
    expect(wakeDecision({ wake: first, now: AT_MS, recentTaken: [], threadIdle: true })).toMatchObject({ take: true })
    writeFileSync(join(workerDir(h, 'trip'), WORKER_FILES.wake), copy)
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
