// N11 hardening: the start-up orphan sweep closes a session claim only when the bridge that owns it is gone.
// A second bridge (a test, another agent folder, a restart overlap) must not close a live bridge's run.

import { afterEach, describe, expect, test } from 'bun:test'
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { InstanceRegistry } from '../../src/schedules/instances.ts'
import { ChronosBox, draft, MON_0700_EDT, type SchedHarness, sleep, startSched, tempHome, waitFor } from './harness.ts'

const AFTER_0730 = '2026-10-05T11:31:00Z'
const DS = '2026-10-05'
const RUN = 'r_01JBF3V7Q8K2M4N6P8R0S2T4V6'

let h: SchedHarness | undefined
afterEach(async () => {
  await h?.stop()
  h = undefined
})

/** A pid that existed and is certainly not running now. */
function deadPid(): number {
  const r = Bun.spawnSync(['true'])
  return r.pid
}

function psStart(pid: number): string {
  const r = Bun.spawnSync(['ps', '-p', String(pid), '-o', 'lstart='], { env: { ...process.env, LC_ALL: 'C' } })
  return r.stdout.toString().trim()
}

/** What a bridge leaves in its home: instances/<id>.json. */
function record(home: string, instance: string, pid: number, startedAt: string, extra: object = {}) {
  const dir = join(home, 'instances')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, `${instance}.json`), JSON.stringify({ instance, pid, started_at: startedAt, ...extra }))
}

function boxWithClaimBy(owner: string | null): ChronosBox {
  const box = new ChronosBox(MON_0700_EDT)
  box.configure({ sessionRunner: 'talos', approvalRequired: true })
  box.create(draft())
  const r = box.api<{ ok: boolean }>(
    ['claim', 'daily-digest'],
    {
      run_id: RUN,
      ds: DS,
      fire_at: '2026-10-05T07:30:00-04:00',
      manual: true,
      again: false,
      runner: 'session',
      ...(owner === null ? {} : { bridge_instance: owner }), // null = Chronos 0.3.1, which sends no bridge_instance
    },
    AFTER_0730,
  )
  expect(r.ok).toBe(true)
  return box
}

const markers = (box: ChronosBox) => readdirSync(box.stateDir()).filter((f) => f.startsWith('failed-'))

async function startNext(box: ChronosBox, home: string) {
  h = await startSched({ box, home, now: AFTER_0730, instance: 'bi_next' })
  const svc = h.bridge.ctx.schedules
  await waitFor(() => svc?.armed === true, 15_000, 'the schedule loops to arm') // armed = the start-up sweep has run
  return h
}

describe('orphan sweep only closes claims whose owner is gone', () => {
  test('a claim owned by a live instance (running pid) is not closed by another instance starting', async () => {
    const home = tempHome('ow')
    record(home, 'bi_live', process.pid, psStart(process.pid))
    const box = boxWithClaimBy('bi_live')
    const x = await startNext(box, home)
    await x.advance(5 * 60_000)
    await sleep(300)
    expect(markers(box)).toEqual([])
  })

  test('a claim owned by a dead instance (pid not running) is closed as session_ended', async () => {
    const home = tempHome('ow')
    record(home, 'bi_dead', deadPid(), 'Mon Jan  1 00:00:00 2024')
    const box = boxWithClaimBy('bi_dead')
    await startNext(box, home)
    await waitFor(() => markers(box).length > 0, 10_000, 'the failed- marker')
    expect(markers(box)).toEqual(['failed-daily-digest-2026-10-05'])
  })

  test('a claim owned by an instance that stopped cleanly is closed as session_ended', async () => {
    const home = tempHome('ow')
    record(home, 'bi_done', process.pid, psStart(process.pid), { stopped_at: '2026-10-05T11:00:00Z' })
    const box = boxWithClaimBy('bi_done')
    await startNext(box, home)
    await waitFor(() => markers(box).length > 0, 10_000, 'the failed- marker')
    expect(markers(box)).toEqual(['failed-daily-digest-2026-10-05'])
  })

  test('a recycled pid (running, but started at another time) counts as gone', async () => {
    const home = tempHome('ow')
    record(home, 'bi_old', process.pid, 'Mon Jan  1 00:00:00 2024')
    const box = boxWithClaimBy('bi_old')
    await startNext(box, home)
    await waitFor(() => markers(box).length > 0, 10_000, 'the failed- marker')
    expect(markers(box)).toEqual(['failed-daily-digest-2026-10-05'])
  })

  test('a claim whose ownership is unknown (no record for the owner) is left alone', async () => {
    const home = tempHome('ow')
    const box = boxWithClaimBy('bi_stranger')
    const x = await startNext(box, home)
    await x.advance(5 * 60_000)
    await sleep(300)
    expect(markers(box)).toEqual([])
  })

  test('a claim with no owner instance in its owner file is left alone', async () => {
    const home = tempHome('ow')
    const box = boxWithClaimBy('')
    await startNext(box, home)
    expect(markers(box)).toEqual([])
  })
})

/** What the sidecar remembers of a run this instance claimed (schedules-meta.json). */
function sidecarClaim(home: string, instance: string) {
  mkdirSync(home, { recursive: true })
  writeFileSync(
    join(home, 'schedules-meta.json'),
    JSON.stringify({
      adapter: 'chronos',
      inflight: { [RUN]: { id: 'daily-digest', ds: DS, fire_at: null, instance, claimed_at: Date.parse(AFTER_0730) } },
    }),
  )
}

describe('Chronos 0.3.1 sends no bridge_instance: the sidecar names the owner', () => {
  test('a dead owner recorded in the sidecar is closed', async () => {
    const home = tempHome('ow')
    record(home, 'bi_dead', deadPid(), 'Mon Jan  1 00:00:00 2024')
    sidecarClaim(home, 'bi_dead')
    const box = boxWithClaimBy(null)
    await startNext(box, home)
    await waitFor(() => markers(box).length > 0, 10_000, 'the failed- marker')
    expect(markers(box)).toEqual(['failed-daily-digest-2026-10-05'])
  })

  test('a live owner recorded in the sidecar is left alone', async () => {
    const home = tempHome('ow')
    record(home, 'bi_live', process.pid, psStart(process.pid))
    sidecarClaim(home, 'bi_live')
    const box = boxWithClaimBy(null)
    const x = await startNext(box, home)
    await x.advance(5 * 60_000)
    await sleep(300)
    expect(markers(box)).toEqual([])
  })

  test('no sidecar record for the run: left alone', async () => {
    const home = tempHome('ow')
    const box = boxWithClaimBy(null)
    await startNext(box, home)
    expect(markers(box)).toEqual([])
  })
})

describe('a superseded bridge is still alive', () => {
  test('after a 4409 its instance is not gone while the process lives, and it is gone after a real stop', async () => {
    const home = tempHome('ow')
    const box = new ChronosBox(MON_0700_EDT)
    h = await startSched({ box, home, now: AFTER_0730, instance: 'bi_sup' })
    await waitFor(() => h?.bridge.ctx.schedules?.armed === true, 15_000, 'arm')
    const reg = new InstanceRegistry(join(home, 'instances'))
    expect(reg.stateOf('bi_sup')).toBe('alive')
    h.relay.kickBridge(4409)
    await waitFor(() => h?.bridge.ctx.mode === 'headless', 10_000, 'headless')
    expect(JSON.parse(readFileSync(join(home, 'instances', 'bi_sup.json'), 'utf8')).stopped_at).toBeUndefined()
    expect(reg.stateOf('bi_sup')).toBe('alive')
    await h.stop()
    h = undefined
    expect(reg.stateOf('bi_sup')).toBe('gone')
  })
})

describe('InstanceRegistry host', () => {
  test('a record from another host is unknown, even with a running pid; the same host is alive; no host (older record) is alive', () => {
    const dir = join(tempHome('ow'), 'instances')
    const here = new InstanceRegistry(dir, { host: () => 'Studio' })
    here.register('bi_a')
    expect(JSON.parse(readFileSync(join(dir, 'bi_a.json'), 'utf8')).host).toBe('Studio')
    expect(here.stateOf('bi_a')).toBe('alive')
    expect(new InstanceRegistry(dir, { host: () => 'Laptop' }).stateOf('bi_a')).toBe('unknown')
    record(join(dir, '..'), 'bi_old', process.pid, psStart(process.pid))
    expect(here.stateOf('bi_old')).toBe('alive')
  })
})

describe('InstanceRegistry', () => {
  test('register then stateOf is alive; markStopped then stateOf is gone; an unsafe id is unknown', () => {
    const reg = new InstanceRegistry(join(tempHome('ow'), 'instances'))
    reg.register('bi_a')
    expect(reg.stateOf('bi_a')).toBe('alive')
    reg.markStopped('bi_a', Date.now())
    expect(reg.stateOf('bi_a')).toBe('gone')
    expect(reg.stateOf('../etc')).toBe('unknown')
    expect(reg.stateOf('bi_none')).toBe('unknown')
  })
})
