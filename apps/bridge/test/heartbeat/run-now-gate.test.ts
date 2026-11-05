// Run now on a heartbeat must not get around the test gate (docs/HEARTBEAT.md "A test before turning on"). A DISABLED heartbeat in
// live mode may only be run by hand when the exact settings have a fresh passing test, the rule that turning it on has. Shadow
// mode only records, so it runs freely. Real bridge, real Chronos CLI, real source scripts.
import { afterEach, describe, expect, test } from 'bun:test'
import { chmodSync, copyFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { HEARTBEAT_META_KEY, heartbeatConfigHashOf } from '@talos-app/protocol'
import { recordPass, TEST_REQUIRED } from '../../src/heartbeat/tested.ts'
import { draft, longTimeouts, type SchedHarness, startSched, waitFor } from '../schedules/harness.ts'
import { cmd, config, item, ok, printing, tmpDir } from './kit.ts'

longTimeouts()

const T0930 = '2026-10-05T13:30:00Z' // before the 09:45 slot, so the clock never runs it
let h = undefined as unknown as SchedHarness
afterEach(async () => {
  await h?.stop()
  h = undefined as unknown as SchedHarness
})

// biome-ignore lint/suspicious/noExplicitAny: a test's view of JSON files it reads
type J = any
const side = () =>
  existsSync(join(h.home, 'schedules-meta.json'))
    ? JSON.parse(readFileSync(join(h.home, 'schedules-meta.json'), 'utf8'))
    : {}
const runNowRuns = () =>
  Object.values((side().runs ?? {}) as Record<string, J>).filter((r) => r.id === 'beat' && r.trigger === 'run_now')

async function begin(mode: 'live' | 'shadow', enabled: boolean) {
  const dir = tmpDir('hb-rn-')
  const probe = printing(dir, 'probe', ok([item('a')]))
  const cfg = config([cmd('probe', probe)], { mode })
  h = await startSched({
    now: T0930,
    jobs: [
      draft({
        id: 'beat',
        name: 'Heartbeat',
        enabled,
        when: { type: 'times', days: 'weekdays', times: ['09:45', '12:15', '14:45', '17:15'] },
        catchup_min: 60,
        meta: { [HEARTBEAT_META_KEY]: cfg } as never,
      }),
    ],
    heartbeat: { secondMs: 200 },
  })
  return { cfg, stdin: probe.replace(/\.sh$/, '.stdin') }
}

describe('Run now on a heartbeat respects the test gate', () => {
  test('a DISABLED live heartbeat with no passing test is refused: no source runs, no run is recorded', async () => {
    const { stdin } = await begin('live', false)
    const f = await h.app.runScheduleNow('beat')
    const e = await h.app.expectFrame('error', (r) => r.ref === f.id, { direction: 'in', timeoutMs: 8000 })
    expect(JSON.stringify(e)).toContain(TEST_REQUIRED)
    await new Promise((r) => setTimeout(r, 1500))
    expect(existsSync(stdin)).toBe(false)
    expect(runNowRuns()).toEqual([])
  })

  test('a DISABLED live heartbeat with a fresh pass for its exact settings runs', async () => {
    const { cfg, stdin } = await begin('live', false)
    recordPass(h.home, heartbeatConfigHashOf(cfg), h.clock.now())
    const f = await h.app.runScheduleNow('beat')
    await h.app.expectFrame('ack', (r) => r.ref === f.id, { direction: 'in' })
    await waitFor(() => existsSync(stdin), 30_000, 'the source to run')
  })

  test('a pass for other settings does not unlock it', async () => {
    const { cfg, stdin } = await begin('live', false)
    recordPass(h.home, heartbeatConfigHashOf({ ...cfg, wake_cap_per_day: 1 }), h.clock.now())
    const f = await h.app.runScheduleNow('beat')
    await h.app.expectFrame('error', (r) => r.ref === f.id, { direction: 'in', timeoutMs: 8000 })
    expect(existsSync(stdin)).toBe(false)
  })

  test('a DISABLED SHADOW heartbeat runs with no test (it only records)', async () => {
    const { stdin } = await begin('shadow', false)
    const f = await h.app.runScheduleNow('beat')
    await h.app.expectFrame('ack', (r) => r.ref === f.id, { direction: 'in' })
    await waitFor(() => existsSync(stdin), 30_000, 'the source to run')
  })

  test('an ENABLED live heartbeat keeps running by hand (existing heartbeats keep running)', async () => {
    const { stdin } = await begin('live', true)
    const f = await h.app.runScheduleNow('beat')
    await h.app.expectFrame('ack', (r) => r.ref === f.id, { direction: 'in' })
    await waitFor(() => existsSync(stdin), 30_000, 'the source to run')
  })

  test('a STALE snapshot (enabled, shadow) does not unlock Run now when the fresh read says disabled + live with no pass', async () => {
    const { cfg, stdin } = await begin('shadow', true)
    // the bridge holds a good snapshot (enabled, shadow) ...
    await waitFor(
      () => (h.bridge.ctx.schedules as never as { lastGood: unknown }).lastGood !== null,
      15_000,
      'a snapshot',
    )
    const etag = h.box
      .api<{ schedules: Array<{ id: string; etag: string }> }>(['snapshot'])
      .schedules.find((j) => j.id === 'beat')?.etag
    // ... then Chronos stops answering `snapshot` (the bridge keeps the stale one) while the job on disk changes underneath it
    copyFileSync(h.box.bin, `${h.box.bin}.orig`)
    writeFileSync(h.box.bin, `#!/bin/sh\ncase "$*" in *snapshot*) exit 1;; esac\nexec '${h.box.bin}.orig' "$@"\n`)
    chmodSync(h.box.bin, 0o755)
    const sources = [cmd('probe', stdin.replace(/\.stdin$/, '.sh'), { id: 'new-source' })]
    h.box.change({
      op: 'update',
      id: 'beat',
      base_etag: etag,
      set: { enabled: false, meta: { [HEARTBEAT_META_KEY]: { ...cfg, mode: 'live', sources } } },
    })
    const f = await h.app.runScheduleNow('beat')
    const e = await h.app.expectFrame('error', (r) => r.ref === f.id, { direction: 'in', timeoutMs: 8000 })
    expect(JSON.stringify(e)).toContain(TEST_REQUIRED)
    await new Promise((r) => setTimeout(r, 1500))
    expect(existsSync(stdin)).toBe(false)
    expect(runNowRuns()).toEqual([])
  })
})
