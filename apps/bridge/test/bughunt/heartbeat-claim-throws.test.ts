// Bug hunt 2026-11-10 #10: a heartbeat slot whose one claim call threw (the scheduler timed out) was dropped with a log
// line and never tried again in its window; the app went on saying "Waiting for the agent". It is now tried again on the
// next ticks, and when every try fails the owner is told. Real bridge, real Chronos, injected clock.
import { afterEach, describe, expect, test } from 'bun:test'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { HEARTBEAT_META_KEY } from '@talos-app/protocol'
import { cmd, config, ok, printing, tmpDir } from '../heartbeat/kit.ts'
import { draft, longTimeouts, type SchedHarness, sleep, startSched, waitFor } from '../schedules/harness.ts'

longTimeouts()

const T0950 = '2026-10-05T13:50:00Z' // Monday 09:50 EDT: the 09:45 slot is due, its window is 60 min
const SLOT = '2026-10-05T0945'

let h = undefined as unknown as SchedHarness
afterEach(async () => {
  await h?.stop()
  h = undefined as unknown as SchedHarness
})

const job = () =>
  draft({
    id: 'beat',
    name: 'Heartbeat',
    when: { type: 'times', days: 'weekdays', times: ['09:45', '17:15'] },
    catchup_min: 60,
    meta: { [HEARTBEAT_META_KEY]: config([cmd('quiet', printing(tmpDir(), 'q', ok([])))]) } as never,
    prompt: 'Never offered.\n',
  })

/** The real adapter, with `claim` throwing for the first `failures` calls (a scheduler that does not answer). */
function start(failures: number) {
  let calls = 0
  return startSched({
    now: T0950,
    jobs: [job()],
    heartbeat: { secondMs: 200 },
    wrapAdapter: (a) =>
      new Proxy(a, {
        get(t, p) {
          if (p === 'claim')
            return async (...args: unknown[]) => {
              calls++
              if (calls <= failures) throw new Error('chronos claim: timed out')
              return (t as never as { claim: (...a: unknown[]) => unknown }).claim(...args)
            }
          const v = (t as unknown as Record<string | symbol, unknown>)[p]
          return typeof v === 'function' ? v.bind(t) : v
        },
      }),
  }).then((x) => Object.assign(x, { claims: () => calls }))
}

const ran = () => readdirSync(h.box.stateDir()).filter((f) => f.startsWith('ran-beat'))
const side = () => JSON.parse(readFileSync(join(h.home, 'schedules-meta.json'), 'utf8'))
const systemRows = () =>
  h.relay.rec
    .of('reply', 'from_bridge')
    .filter((f) => f.message.author === 'system')
    .map((f) => f.message.text ?? '')

describe('bug hunt #10: a heartbeat slot whose claim throws', () => {
  test('one timeout: the slot is tried again on a later tick, inside its window, and runs; the owner is told nothing', async () => {
    const x = await start(1)
    h = x
    await waitFor(() => x.claims() >= 1, 15_000, 'the first claim')
    for (let i = 0; i < 4 && ran().length === 0; i++) await h.advance(61_000)
    await waitFor(() => ran().length === 1, 30_000, 'the slot to run on a retry')
    expect(ran()).toEqual([`ran-beat-${SLOT}`])
    expect(x.claims()).toBe(2)
    expect(systemRows().filter((t) => t.includes('Heartbeat'))).toEqual([])
  })

  test('every try times out: three tries, then one plain notice to the owner and a failed entry in the run list, and no fourth try', async () => {
    const x = await start(99)
    h = x
    await waitFor(() => x.claims() >= 1, 15_000, 'the first claim')
    for (let i = 0; i < 8; i++) await h.advance(61_000)
    await sleep(300)
    expect(x.claims()).toBe(3)
    expect(ran()).toEqual([])
    const told = systemRows().filter((t) => t.includes('Heartbeat'))
    expect(told).toEqual([
      `Scheduled job "Heartbeat" could not start at its time: the scheduler did not answer (tried 3 times). Open Schedules.`,
    ])
    const notes = Object.values(side().runs as Record<string, { id: string; status?: string; summary?: string }>)
    expect(notes.filter((n) => n.id === 'beat').map((n) => [n.status, n.summary])).toEqual([
      ['failed', 'Could not start: the scheduler did not answer'],
    ])
  })
})
