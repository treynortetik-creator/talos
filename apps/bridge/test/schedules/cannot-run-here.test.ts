// Off a Mac a job that runs by itself in the background runs only while Chronos's own tick beats there (on Linux a systemd user
// timer), and a job limited to the tools it lists not at all yet: health says which, once (cannot_run_here). The tick is judged by
// its beat (chronos.beat), never by the platform (Pantheon 2026-11-15). A Mac's health is unchanged. The real Chronos
// (third_party/chronos), through the real adapter.
import { afterEach, describe, expect, test } from 'bun:test'
import { mkdirSync, utimesSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { HealthCode } from '@talos-app/protocol'
import { OWNER_HOST_TEST } from '../../src/platform.ts'
import { ChronosAdapter } from '../../src/schedules/chronos-adapter.ts'
import { ChronosBox, draft, MON_0700_EDT } from './harness.ts'

const boxes: ChronosBox[] = []
afterEach(() => {
  OWNER_HOST_TEST.host = 'mac' // as preload.ts left it
  for (const b of boxes.splice(0)) b.dispose()
})

/** The tick beat: `ageS` seconds ago, read from the file's time (Chronos falls back to it for a beat it can't parse). */
const beat = (box: ChronosBox, ageS: number) => {
  const f = join(box.home, '.chronos', 'chronos.beat')
  mkdirSync(join(box.home, '.chronos'), { recursive: true })
  writeFileSync(f, 'beat')
  const t = (Date.now() - ageS * 1000) / 1000
  utimesSync(f, t, t)
}
let lastBox: ChronosBox
const world = (extra: Array<Record<string, unknown>> = []) => {
  const box = new ChronosBox(MON_0700_EDT)
  lastBox = box
  boxes.push(box)
  box.configure({ sessionRunner: 'talos', approvalRequired: true })
  // written straight into Chronos (as a job left from before, or made outside the app): never through validate
  expect(box.create(draft({ id: 'thread-job', runner: 'session', permissions: 'full' }))).toMatch(/^sha256:/)
  expect(box.create(draft({ id: 'bg-job', runner: 'headless', permissions: 'full' }))).toMatch(/^sha256:/)
  for (const d of extra) expect(box.create(draft(d as never))).toMatch(/^sha256:/)
  return new ChronosAdapter({ bin: box.bin, timeoutMs: 15_000 })
}
const codes = async (a: ChronosAdapter) => (await a.health()).issues

describe('cannot_run_here: background jobs off a Mac', () => {
  test('off a Mac with no tick: one warning naming the jobs that run in the background, never the thread job', async () => {
    const a = world()
    OWNER_HOST_TEST.host = 'linux'
    const i = (await codes(a)).find((x) => x.code === 'cannot_run_here')
    expect(i).toMatchObject({ severity: 'warn', schedule_id: 'bg-job' })
    expect(i?.text).toBe("Some jobs can't run on this computer: bg-job.")
    expect(i?.fix).toContain('Reinstall Chronos so its background timer runs')
    expect(i?.text).not.toContain('thread-job')
  })
  test('off a Mac with the tick beating: a full-permission background job runs, so no warning for it', async () => {
    const a = world()
    beat(lastBox, 60)
    OWNER_HOST_TEST.host = 'linux'
    expect((await codes(a)).some((x) => x.code === 'cannot_run_here')).toBe(false)
  })
  test('a tick that stopped beating (over two intervals) is no tick', async () => {
    const a = world()
    beat(lastBox, 2 * 300 + 120)
    OWNER_HOST_TEST.host = 'linux'
    expect((await codes(a)).find((x) => x.code === 'cannot_run_here')?.schedule_id).toBe('bg-job')
  })
  test('with the tick beating, a job limited to the tools it lists still cannot run off a Mac (root runtime: later)', async () => {
    const a = world([{ id: 'narrow-job', runner: 'headless', permissions: 'restricted' }])
    beat(lastBox, 60)
    OWNER_HOST_TEST.host = 'linux'
    const i = (await codes(a)).find((x) => x.code === 'cannot_run_here')
    expect(i?.schedule_id).toBe('narrow-job')
    expect(i?.fix).toContain('Give them full permissions')
  })
  test('validate: a background job off a Mac is refused with no tick and let through with one', async () => {
    const a = world()
    OWNER_HOST_TEST.host = 'linux'
    const change = {
      op: 'create',
      draft: { ...draft({ id: 'new-bg', runner: 'headless', permissions: 'full' }) },
    } as never
    const refused = await a.validate(change)
    expect(refused).toMatchObject({ ok: false })
    expect(JSON.stringify(refused)).toContain('background timer')
    beat(lastBox, 30)
    const allowed = await a.validate(change)
    expect(JSON.stringify(allowed)).not.toContain('background timer')
  })
  test('on a Mac (it has the timer): no such warning', async () => {
    const a = world()
    expect((await codes(a)).some((x) => x.code === 'cannot_run_here')).toBe(false)
  })
  test('the protocol knows the code (a health object carrying it parses)', () => {
    expect(HealthCode.parse('cannot_run_here')).toBe('cannot_run_here')
  })
})
