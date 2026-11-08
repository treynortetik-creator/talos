// A heartbeat source runs in its own process group and outlives a bridge crash. The store records its group while it runs;
// the next bridge start kills a recorded group only if it is still alive AND its leader still has the command we recorded
// (pids get reused). Every process here is one the test started itself.
import { afterEach, describe, expect, test } from 'bun:test'
import { spawn } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { reapOrphans } from '../../src/heartbeat/orphans.ts'
import { processInfo } from '../../src/heartbeat/spawn.ts'
import { emptyStore, storeFile } from '../../src/heartbeat/store.ts'
import { longTimeouts, type SchedHarness, startSched, tempHome, waitFor } from '../schedules/harness.ts'

longTimeouts()

type Child = { pid: number; exited: Promise<void>; isGone(): boolean }
const started: Child[] = []
let h = undefined as unknown as SchedHarness
afterEach(async () => {
  for (const c of started.splice(0))
    try {
      if (!c.isGone()) process.kill(-c.pid, 'SIGKILL')
    } catch {
      // already gone
    }
  await h?.stop()
  h = undefined as unknown as SchedHarness
})

/** A `sleep` in a group of its own, like a source. */
function leader(secs: number): Child {
  const child = spawn('/bin/sleep', [String(secs)], { detached: true, stdio: 'ignore' })
  let gone = false
  const exited = new Promise<void>((resolve) =>
    child.on('exit', () => {
      gone = true
      resolve()
    }),
  )
  const c = { pid: child.pid as number, exited, isGone: () => gone }
  started.push(c)
  return c
}
const infoOf = async (pid: number) => {
  const i = await processInfo(pid)
  if (typeof i === 'string') throw new Error(`no process ${pid}`)
  return i
}
const record = async (c: Child, over: { command?: string; lstart?: string; bridge_pid?: number } = {}) => {
  const i = await infoOf(c.pid)
  return { pgid: c.pid, command: i.command, lstart: i.lstart, at: '2026-10-05T10:00:00.000Z', ...over }
}
const logs: Array<[string, unknown]> = []
const log = (m: string, f?: unknown) => logs.push([m, f])
function writeStore(home: string, running: Record<string, unknown>, shadow = false, jobId = 'beat') {
  writeFileSync(storeFile(home, shadow, jobId), JSON.stringify({ ...emptyStore(), running }))
}
// biome-ignore lint/suspicious/noExplicitAny: a test's view of a JSON file it pokes at
const readStore = (home: string, shadow = false, jobId = 'beat'): any =>
  JSON.parse(readFileSync(storeFile(home, shadow, jobId), 'utf8'))
const stays = (c: Child, ms = 400) => Bun.sleep(ms).then(() => !c.isGone())

describe('leftover source processes', () => {
  test('a recorded group that is alive and still has its recorded command is killed, and the record is cleared', async () => {
    const home = tempHome()
    const orphan = leader(300)
    const bystander = leader(300) // same command, never recorded
    writeStore(home, { src: await record(orphan) })
    const out = await reapOrphans(home, log)
    await Promise.race([orphan.exited, Bun.sleep(3000)])
    expect(orphan.isGone()).toBe(true)
    expect(out.killed).toEqual([orphan.pid])
    expect(await stays(bystander)).toBe(true) // a pgid nobody recorded is never touched
    expect(readStore(home).running).toEqual({})
  })

  test('a reused pid that now runs something else is left alone, and the record is cleared', async () => {
    const home = tempHome()
    const stranger = leader(300)
    writeStore(home, { src: await record(stranger, { command: '/usr/bin/some-other-program --serve' }) })
    const out = await reapOrphans(home, log)
    expect(out.killed).toEqual([])
    expect(await stays(stranger)).toBe(true)
    expect(readStore(home).running).toEqual({})
  })

  test('a dead group is just cleared', async () => {
    const home = tempHome()
    const gone = leader(300)
    const rec = await record(gone)
    process.kill(-gone.pid, 'SIGKILL')
    await gone.exited
    writeStore(home, { src: rec })
    const out = await reapOrphans(home, log)
    expect(out.killed).toEqual([])
    expect(readStore(home).running).toEqual({})
  })

  test('shadow stores are swept too, every record in a file is judged on its own, and a store nobody can read is left where it is', async () => {
    const home = tempHome()
    const a = leader(300)
    const b = leader(300)
    writeStore(home, { one: await record(a), two: await record(b, { command: 'not what it was' }) }, true, 'beat')
    writeFileSync(storeFile(home, false, 'broken'), '{not json')
    const out = await reapOrphans(home, log)
    await Promise.race([a.exited, Bun.sleep(3000)])
    expect(out.killed).toEqual([a.pid])
    expect(await stays(b)).toBe(true)
    expect(readStore(home, true).running).toEqual({})
    expect(readFileSync(storeFile(home, false, 'broken'), 'utf8')).toBe('{not json')
  })

  test('a record that points at pid 0, 1 or this process is cleared and never signalled', async () => {
    const home = tempHome()
    const myCommand = (await infoOf(process.pid)).command
    const bad = (pgid: number) => ({ pgid, command: myCommand, at: '2026-10-05T10:00:00.000Z' })
    writeStore(home, { a: bad(process.pid), b: { ...bad(1), pgid: 1 } })
    expect((await reapOrphans(home, log)).killed).toEqual([])
    expect(readStore(home).running).toEqual({})
  })

  test('a pid that was reused by the same command at another start time is left alone', async () => {
    const home = tempHome()
    const stranger = leader(300)
    writeStore(home, { src: await record(stranger, { lstart: 'Mon Jan  1 00:00:00 2001' }) })
    expect((await reapOrphans(home, log)).killed).toEqual([])
    expect(await stays(stranger)).toBe(true)
    expect(readStore(home).running).toEqual({})
  })

  test('a group whose leader is gone but which still has members is killed: its pgid cannot have been reused', async () => {
    const home = tempHome()
    // the leader (a shell) exits after a moment and leaves a `sleep` in its group
    const child = spawn('/bin/sh', ['-c', 'sleep 300 & sleep 1'], { detached: true, stdio: 'ignore' })
    const pgid = child.pid as number
    const exited = new Promise<void>((resolve) => child.on('exit', () => resolve()))
    started.push({ pid: pgid, exited, isGone: () => false })
    const rec = { pgid, ...(await infoOf(pgid)), at: '2026-10-05T10:00:00.000Z' }
    await exited
    writeStore(home, { src: rec })
    const groupAlive = () => {
      try {
        process.kill(-pgid, 0)
        return true
      } catch {
        return false
      }
    }
    expect(groupAlive()).toBe(true)
    expect((await reapOrphans(home, log)).killed).toEqual([pgid])
    await waitFor(() => !groupAlive(), 3000, 'the group to be gone')
    expect(readStore(home).running).toEqual({})
  })

  test('a ps that cannot answer keeps the record for the next start and kills nothing', async () => {
    const home = tempHome()
    const orphan = leader(300)
    writeStore(home, { src: await record(orphan) })
    expect((await reapOrphans(home, log, { info: async () => 'unknown' })).killed).toEqual([])
    expect(await stays(orphan)).toBe(true)
    expect(Object.keys(readStore(home).running)).toEqual(['src'])
  })

  test('a bridge start sweeps before any slot: the leftover is killed and its record gone', async () => {
    const home = tempHome()
    const orphan = leader(300)
    writeStore(home, { src: await record(orphan) })
    h = await startSched({ now: '2026-10-05T13:30:00Z', home })
    await waitFor(() => orphan.isGone(), 15_000, 'the leftover to be killed')
    await waitFor(() => Object.keys(readStore(home).running).length === 0, 5000, 'the record to be cleared')
  })

  test('a source recorded by a bridge that is still alive is left running and keeps its record (a restart overlap)', async () => {
    const home = tempHome()
    const live = leader(300)
    const oldBridge = leader(300) // any live process that is not this one stands in for the old bridge
    writeStore(home, { src: await record(live, { bridge_pid: oldBridge.pid }) })
    expect((await reapOrphans(home, log)).killed).toEqual([])
    expect(await stays(live)).toBe(true)
    expect(Object.keys(readStore(home).running)).toEqual(['src'])
  })

  test('a group that is gone is cleared even when the bridge that recorded it is still alive', async () => {
    const home = tempHome()
    const gone = leader(300)
    const oldBridge = leader(300)
    const rec = await record(gone, { bridge_pid: oldBridge.pid })
    process.kill(-gone.pid, 'SIGKILL')
    await gone.exited
    writeStore(home, { src: rec })
    expect((await reapOrphans(home, log)).killed).toEqual([])
    expect(readStore(home).running).toEqual({})
    expect(await stays(oldBridge)).toBe(true)
  })

  test('once that bridge is gone, the same record is a leftover and is killed', async () => {
    const home = tempHome()
    const orphan = leader(300)
    const dead = leader(300)
    const rec = await record(orphan, { bridge_pid: dead.pid })
    process.kill(-dead.pid, 'SIGKILL')
    await dead.exited
    writeStore(home, { src: rec })
    expect((await reapOrphans(home, log)).killed).toEqual([orphan.pid])
    expect(readStore(home).running).toEqual({})
  })

  test('a record added to the store while the sweep was judging is not dropped by its write', async () => {
    const home = tempHome()
    const orphan = leader(300)
    const newcomer = leader(300)
    writeStore(home, { src: await record(orphan) })
    const added = await record(newcomer)
    const info = async (pid: number) => {
      const r = await processInfo(pid)
      writeStore(home, { src: await record(orphan), other: added }) // another writer, mid-sweep
      return r
    }
    await reapOrphans(home, log, { info })
    expect(Object.keys(readStore(home).running)).toEqual(['other'])
  })

  test('the startup sweep runs inside the schedule queue: it waits for work already queued', async () => {
    const home = tempHome()
    const orphan = leader(300)
    writeStore(home, { src: await record(orphan) })
    h = await startSched({ now: '2026-10-05T13:30:00Z', home, startBridge: false })
    let release = () => {}
    const gate = new Promise<void>((r) => {
      release = r
    })
    // biome-ignore lint/suspicious/noExplicitAny: the queue is private; the test occupies it the way a running job does
    ;(h.bridge.ctx.schedules as any).enqueue(() => gate)
    h.bridge.start()
    await waitFor(() => h.bridge.ctx.schedules?.hasStarted === true, 15_000, 'the schedule service to start')
    await Bun.sleep(1500)
    expect(orphan.isGone()).toBe(false) // an unqueued sweep would have killed it by now
    expect(Object.keys(readStore(home).running)).toEqual(['src'])
    release()
    await waitFor(() => orphan.isGone(), 15_000, 'the leftover to be killed once the queue is free')
  })
})
