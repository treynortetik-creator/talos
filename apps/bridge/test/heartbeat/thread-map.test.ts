// HB4 R2-5: a card never waits long on Chronos, and a heartbeat thread's limits do not fail open when Chronos cannot be read.
// Real bridge, real Chronos CLI; "unreadable" and "slow" are the Chronos wrapper script swapped for one that fails or sleeps.
import { afterEach, describe, expect, test } from 'bun:test'
import { chmodSync, copyFileSync, existsSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { HEARTBEAT_META_KEY } from '@talos-app/protocol'
import { AdapterError } from '../../src/schedules/chronos-adapter.ts'
import { draft, longTimeouts, type SchedHarness, startSched, tempHome, waitFor } from '../schedules/harness.ts'
import { cmd, config, ok, printing, tmpDir } from './kit.ts'

longTimeouts()

const T0930 = '2026-10-05T13:30:00Z' // before the 09:45 slot: no run, so no store file unless a test makes one
const HB = 'inbox'
let h = undefined as unknown as SchedHarness
afterEach(async () => {
  await h?.stop()
  h = undefined as unknown as SchedHarness
})

const cfgOf = ((c: { threads: unknown[] }) => ({
  ...c,
  threads: [
    ...c.threads,
    {
      id: 'trip',
      name: 'Trip',
      kind: 'fixed',
      order: 5,
      notify: 'all',
      voice_context: 'recent',
      archived: false,
      created_at: '2026-10-28T00:00:00.000Z',
    },
  ],
})) as never

async function begin() {
  const cfg = config([cmd('news', printing(tmpDir('hb-tm-'), 'n', ok([])))])
  const home = tempHome()
  writeFileSync(join(home, 'schedules-meta.json'), JSON.stringify({ jobs: { beat: { thread_id: HB } } }))
  h = await startSched({
    now: T0930,
    home,
    jobs: [
      draft({
        id: 'beat',
        name: 'Heartbeat',
        when: { type: 'times', days: 'weekdays', times: ['09:45', '12:15', '14:45', '17:15'] },
        catchup_min: 60,
        meta: { [HEARTBEAT_META_KEY]: cfg } as never,
      }),
    ],
    heartbeat: { secondMs: 200 },
    config: cfgOf,
  })
  // a good snapshot has been read by now (the bridge lists schedules at start)
  await h.app.expectFrame('schedule.status', () => true, { direction: 'in', timeoutMs: 15_000 }).catch(() => undefined)
}
const tool = async (name: string, args: Record<string, unknown>) =>
  (await h.bridge.callTool(name, args)) as { isError?: boolean; content: Array<{ text: string }> }
const card = (over: Record<string, unknown> = {}) =>
  tool('card', {
    thread_id: HB,
    kind: 'generic',
    title: 'Reply to Dana',
    primary_label: 'Send reply',
    kill_label: 'Kill reply',
    risk: 'low',
    origin: 'background',
    ...over,
  })
const pending = (thread = HB) => h.bridge.ctx.ledger.list('pending').filter((r) => r.thread_id === thread)
const chronosBin = () => h.box.bin
const breakChronos = (body: string) => {
  writeFileSync(chronosBin(), `#!/bin/sh\n${body}\n`)
  chmodSync(chronosBin(), 0o755)
}
const mapFile = () => join(h.home, 'heartbeat-threads.json')

describe('the heartbeat thread map', () => {
  test('after a restart with Chronos unreadable, the heartbeat thread is still limited (saved map)', async () => {
    await begin()
    for (const t of ['one', 'two', 'three']) expect((await card({ title: t })).content[0]?.text).toContain('pending')
    expect(existsSync(mapFile())).toBe(true)
    await h.stop()
    breakChronos('echo "chronos is gone" >&2; exit 1')
    const next = await startSched({ box: h.box, home: h.home, now: T0930, config: cfgOf })
    h = next
    const r = await card({ title: 'after restart', origin: 'chat' })
    expect(r.content[0]?.text).toContain('plain line')
    expect(pending().length).toBe(3)
  })

  test('with Chronos unreadable AND no saved map, a thread that has a heartbeat store is still limited', async () => {
    await begin()
    for (const t of ['one', 'two', 'three']) await card({ title: t })
    writeFileSync(join(h.home, 'heartbeat-state.beat.json'), '{}') // the job has run before
    await h.stop()
    rmSync(mapFile(), { force: true })
    breakChronos('exit 1')
    h = await startSched({ box: h.box, home: h.home, now: T0930, config: cfgOf })
    const r = await card({ title: 'unknown map', origin: 'chat' })
    expect(r.content[0]?.text).toContain('plain line')
  })

  test('a damaged saved map is the same as none (no throw, no fail-open for a thread with a store)', async () => {
    await begin()
    for (const t of ['one', 'two', 'three']) await card({ title: t })
    writeFileSync(join(h.home, 'heartbeat-state.beat.json'), '{}')
    await h.stop()
    writeFileSync(mapFile(), '{not json')
    breakChronos('exit 1')
    h = await startSched({ box: h.box, home: h.home, now: T0930, config: cfgOf })
    expect((await card({ title: 'damaged', origin: 'chat' })).content[0]?.text).toContain('plain line')
  })

  test('a slow Chronos does not delay a card in an unrelated thread past the bound', async () => {
    await begin()
    await h.stop()
    // discovery works, but `chronos api snapshot` takes 20 s: the bridge has no good snapshot yet and a card cannot get one
    copyFileSync(chronosBin(), `${chronosBin()}.orig`)
    breakChronos(`case "$*" in *snapshot*) sleep 20; exit 1;; esac\nexec '${chronosBin()}.orig' "$@"`)
    h = await startSched({ box: h.box, home: h.home, now: T0930, config: cfgOf })
    const t0 = Date.now()
    const r = await card({ thread_id: 'trip', title: 'Elsewhere', origin: 'chat' })
    const took = Date.now() - t0
    expect(r.isError).toBeFalsy()
    expect(took).toBeLessThan(3500)
  })

  test('a burst of cards while no snapshot is known shares one read of Chronos; a later call makes a new one', async () => {
    const seen = { snapshots: 0 }
    h = await startSched({
      now: T0930,
      config: cfgOf,
      // Chronos is up but its snapshot never works, so the bridge has no good one and every card has to ask
      wrapAdapter: (a) =>
        new Proxy(a, {
          get(t, p) {
            if (p === 'snapshot')
              return async () => {
                seen.snapshots++
                await Bun.sleep(300)
                throw new AdapterError('exit', 'chronos api snapshot: not answering')
              }
            const v = (t as unknown as Record<string | symbol, unknown>)[p]
            return typeof v === 'function' ? v.bind(t) : v
          },
        }),
    })
    const schedules = h.bridge.ctx.schedules as NonNullable<typeof h.bridge.ctx.schedules>
    await waitFor(() => schedules.hasStarted, 15_000, 'the schedules to start')
    await schedules.idle()
    seen.snapshots = 0
    const jobs = await Promise.all(Array.from({ length: 6 }, () => schedules.heartbeatJobOfThread('trip')))
    expect(jobs).toEqual([null, null, null, null, null, null])
    expect(seen.snapshots).toBe(1)
    await schedules.heartbeatJobOfThread('trip') // the first read has settled: this one asks again
    expect(seen.snapshots).toBe(2)
  })
})
