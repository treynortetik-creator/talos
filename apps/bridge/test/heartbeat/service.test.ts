// HB2 through the REAL bridge and the REAL Chronos CLI (third_party/chronos): a heartbeat job's slot is claimed, run by the
// bridge, and closed with `finish`, so Chronos writes the same `ran-` marker it writes for any finished run. The agent is
// `h.notes`: a heartbeat slot that finds nothing, or only fyi, must leave it empty.
import { afterEach, describe, expect, test } from 'bun:test'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { HEARTBEAT_META_KEY } from '@talos-app/protocol'
import { SHADOW_LOG } from '../../src/heartbeat/runner.ts'
import { storeFile } from '../../src/heartbeat/store.ts'
import { draft, longTimeouts, type SchedHarness, startSched, waitFor } from '../schedules/harness.ts'
import { cmd, config, errAnswer, item, ok, printing, script, tmpDir } from './kit.ts'

longTimeouts()

// Monday 2026-10-05, 09:50 EDT: the 09:45 slot is due
const T0950 = '2026-10-05T13:50:00Z'
const SLOT = '2026-10-05T0945'
const SLOTS = ['09:45', '12:15', '14:45', '17:15']

// biome-ignore lint/suspicious/noExplicitAny: a test's view of JSON files it reads
type J = any

let h = undefined as unknown as SchedHarness
let dir: string
afterEach(async () => {
  await h?.stop()
  h = undefined as unknown as SchedHarness
})

const job = (cfg: unknown) =>
  draft({
    id: 'beat',
    name: 'Heartbeat',
    when: { type: 'times', days: 'weekdays', times: SLOTS },
    catchup_min: 60,
    meta: { [HEARTBEAT_META_KEY]: cfg } as never,
    prompt: 'This prompt must never reach the agent.\n',
  })
async function begin(cfg: ReturnType<typeof config>, opts: Parameters<typeof startSched>[0] = {}) {
  dir = tmpDir('hb-svc-')
  h = await startSched({ now: T0950, jobs: [job(cfg)], heartbeat: { secondMs: 200 }, ...opts })
}
const state = () => readdirSync(h.box.stateDir())
const ran = () => state().filter((f) => f.startsWith('ran-beat'))
const rows = () =>
  h.relay.frames
    .filter((r) => r.frame.type === 'reply' && r.direction === 'from_bridge')
    .map((r) => r.frame as unknown as { message: { author: string; text?: string }; silent?: boolean })
    .filter((f) => f.message.author === 'system')
const side = () => JSON.parse(readFileSync(join(h.home, 'schedules-meta.json'), 'utf8'))
const noteOf = () => Object.values(side().runs as Record<string, Record<string, J>>).find((r) => r.id === 'beat')

const closed = () => noteOf()?.status !== undefined && noteOf()?.status !== 'running'

describe('a heartbeat slot, claimed and closed by the bridge', () => {
  test('a silent slot sends ZERO notifications, posts nothing, and closes with a ran- marker; the sidecar entry has the per-source result', async () => {
    await begin(config([cmd('quiet', printing(tmpDir(), 'q', ok([])))]))
    await waitFor(() => ran().length === 1 && closed(), 30_000, `the slot to close (state: ${state().join(',')})`)
    expect(ran()).toEqual([`ran-beat-${SLOT}`])
    expect(h.notes).toEqual([]) // not a schedule_run, not a system notice: nothing reached the agent
    expect(rows()).toEqual([])
    const n = noteOf()
    expect(n?.status).toBe('ok')
    expect(n?.summary).toBe('Nothing new')
    expect(n?.heartbeat.outcome).toBe('silent')
    expect(n?.heartbeat.run_key).toBe(SLOT)
    expect(n?.heartbeat.sources).toEqual([{ id: 'quiet', ok: true, ms: expect.any(Number), unreadable: 0 }])
  })

  test('an fyi slot posts ONE silent row, sends the agent nothing, and closes ran-', async () => {
    await begin(config([cmd('news', printing(tmpDir(), 'n', ok([item('a'), item('b')])))]))
    await waitFor(() => ran().length === 1 && closed(), 30_000, 'the slot to close')
    await waitFor(() => rows().length === 1, 5000, 'the digest row')
    expect(rows()[0]?.silent).toBe(true)
    expect(rows()[0]?.message.text).toContain('Item a')
    expect(h.notes).toEqual([])
    expect(noteOf()?.heartbeat.outcome).toBe('fyi')
    expect(noteOf()?.summary).toBe('2 updates posted')
  })

  test('the job prompt is never offered to the agent, by the clock or by Run now (even in the quiet window)', async () => {
    await begin(config([cmd('news', printing(tmpDir(), 'n', ok([])))]), {
      config: (c) => ({ ...c, timezone: 'America/New_York', quiet_window: { start: '09:00', end: '11:00' } }),
    })
    await waitFor(() => ran().length === 1 && closed(), 30_000, 'the quiet slot to close')
    expect(noteOf()?.heartbeat.outcome).toBe('quiet')
    expect(noteOf()?.heartbeat.sources).toEqual([])
    expect(existsSync(join(dir, 'never'))).toBe(false)
    await h.app.runScheduleNow('beat')
    await waitFor(
      () => Object.values(side().runs as Record<string, J>).filter((r) => r.id === 'beat').length === 2,
      30_000,
      'Run now to be recorded',
    )
    await waitFor(
      () => Object.values(side().runs as Record<string, J>).every((r) => r.status !== 'running'),
      30_000,
      'Run now to finish',
    )
    expect(h.notesOf('schedule_run')).toEqual([])
    expect(JSON.stringify(h.notes)).not.toContain('must never reach the agent')
    const runNow = Object.values(side().runs as Record<string, Record<string, J>>).find((r) => r.trigger === 'run_now')
    expect(runNow?.heartbeat.outcome).toBe('silent') // the owner's own request bypasses quiet hours
  })

  test('the quiet slot runs no source at all', async () => {
    const probe = script(tmpDir(), 'probe', `echo '${ok([])}'`)
    await begin(config([cmd('probe', probe)]), {
      config: (c) => ({ ...c, timezone: 'America/New_York', quiet_window: { start: '09:00', end: '11:00' } }),
    })
    await waitFor(() => ran().length === 1 && closed(), 30_000, 'the quiet slot to close')
    expect(existsSync(probe.replace(/\.sh$/, '.stdin'))).toBe(false)
    expect(existsSync(storeFile(h.home, false, 'beat'))).toBe(false)
  })

  test('a hanging source is killed and the others deliver; the slot still closes', async () => {
    const hang = script(tmpDir(), 'hang', 'sleep 300')
    await begin(config([cmd('hang', hang), cmd('good', printing(tmpDir(), 'g', ok([item('g')])))]))
    await waitFor(() => ran().length === 1 && closed(), 30_000, 'the slot to close')
    await waitFor(() => rows().length === 1, 5000, 'the digest row')
    expect(rows()[0]?.message.text).toContain('Item g')
    const n = noteOf()
    expect(n?.heartbeat.outcome).toBe('partial')
    expect(n?.heartbeat.sources.find((s: J) => s.id === 'hang')).toMatchObject({ ok: false })
    expect(n?.summary).toBe("Couldn't check hang")
  })

  test('a failed source never reads as silent: the slot closes FAILED, the thread says why once, and nothing wakes the agent', async () => {
    await begin(config([cmd('down', printing(tmpDir(), 'd', errAnswer('jira: 401')))]))
    await waitFor(
      () => state().some((f) => f.startsWith('failed-beat')) && closed(),
      30_000,
      `the slot to fail (state: ${state().join(',')})`,
    )
    expect(ran()).toEqual([])
    expect(noteOf()?.status).toBe('failed')
    expect(noteOf()?.summary).toBe('Check failed')
    await waitFor(() => rows().length >= 1, 5000, 'the failure line')
    await Bun.sleep(300)
    const texts = rows().map((r) => r.message.text ?? '')
    expect(texts.filter((t) => t.includes('jira: 401')).length).toBe(1)
    expect(texts.filter((t) => t.includes("didn't finish")).length).toBe(0) // the generic notice would only say it twice
    expect(h.notes).toEqual([])
  })

  test('shadow mode through the bridge never posts or notifies, and writes the digest to the shadow log', async () => {
    await begin(config([cmd('news', printing(tmpDir(), 'n', ok([item('a')])))], { mode: 'shadow' }))
    await waitFor(() => ran().length === 1 && closed(), 30_000, 'the slot to close')
    expect(rows()).toEqual([])
    expect(h.notes).toEqual([])
    expect(readFileSync(join(h.home, SHADOW_LOG), 'utf8')).toContain('Item a')
    expect(existsSync(storeFile(h.home, false, 'beat'))).toBe(false)
  })

  test('stopping the bridge mid-run kills the source, and the run writes and posts nothing', async () => {
    const d = tmpDir()
    const pidFile = join(d, 'pid')
    const hang = script(d, 'hang', `echo $$ > '${pidFile}'\nsleep 300`)
    await begin(config([cmd('hang', hang, { timeout_s: 60 })], { run_timeout_s: 150 }), {
      heartbeat: { secondMs: 1000 },
    })
    await waitFor(
      () => existsSync(pidFile) && readFileSync(pidFile, 'utf8').trim() !== '',
      30_000,
      'the source to start',
    )
    const pid = Number(readFileSync(pidFile, 'utf8'))
    h.bridge.ctx.schedules?.stop()
    await waitFor(
      () => {
        try {
          process.kill(pid, 0)
          return false
        } catch {
          return true
        }
      },
      5000,
      'the source to be killed',
    )
    await Bun.sleep(300)
    expect(ran()).toEqual([])
    expect(existsSync(storeFile(h.home, false, 'beat'))).toBe(false)
    expect(rows()).toEqual([])
  })

  test('schedule_run_start cannot be used to reach a heartbeat: the slot has no run id the agent could hold', async () => {
    await begin(config([cmd('news', printing(tmpDir(), 'n', ok([])))]))
    await waitFor(() => ran().length === 1 && closed(), 30_000, 'the slot to close')
    const runId = Object.keys(side().runs)[0] as string
    const started = await h.agent.start(runId)
    expect(started).toMatch(/^SKIP: already done/)
    expect(h.notes).toEqual([])
  })
  test('a slow heartbeat is started once: ticks while it runs do not start it again, and the slot closes once', async () => {
    const slow = script(tmpDir(), 'slow', `sleep 2\necho '${ok([item('s')])}'`)
    await begin(config([cmd('slow', slow, { timeout_s: 30 })]), { heartbeat: { secondMs: 1000 } })
    await h.advance(61_000)
    await h.advance(61_000)
    await waitFor(() => ran().length === 1 && closed(), 30_000, 'the slot to close')
    const mine = Object.values(side().runs as Record<string, Record<string, J>>).filter((r) => r.id === 'beat')
    expect(mine.length).toBe(1)
    expect(rows().length).toBe(1)
    expect(h.notes).toEqual([])
  })

  test('Run now on a heartbeat whose job says "headless" is refused, and no background agent run is started', async () => {
    dir = tmpDir('hb-svc-')
    const cfg = config([cmd('news', printing(tmpDir(), 'n', ok([])))])
    h = await startSched({
      now: T0950,
      jobs: [{ ...job(cfg), runner: 'headless', permissions: 'restricted', allowed_tools: ['Read'] }],
      heartbeat: { secondMs: 200 },
    })
    const f = (await h.app.runScheduleNow('beat')) as unknown as { id: string }
    const err = await h.app.expectFrame('error', (e) => e.ref === f.id, { direction: 'in' })
    expect(err.code).toBe('schedule_invalid')
    await Bun.sleep(500)
    expect(existsSync(join(h.home, 'schedules-meta.json')) ? Object.keys(side().runs) : []).toEqual([])
    expect(readdirSync(h.box.homeDir()).filter((x) => x.includes('headless') && x !== 'headless.blocked')).toEqual([])
    expect(h.notes).toEqual([])
  })
  test('R1-5: when the job cannot be read at the slot, the offer is refused with a plain notice (once) and never falls through to the agent', async () => {
    const flag = { fail: true }
    await begin(config([cmd('news', printing(tmpDir(), 'n', ok([item('a')])))]), {
      wrapAdapter: (a) =>
        new Proxy(a, {
          get(t, p) {
            if (p === 'detail')
              return async (...x: Parameters<typeof a.detail>) => {
                if (flag.fail) throw new Error('chronos did not answer')
                return t.detail(...x)
              }
            const v = (t as unknown as Record<string | symbol, unknown>)[p]
            return typeof v === 'function' ? v.bind(t) : v
          },
        }),
    })
    await waitFor(() => rows().length >= 1, 30_000, 'the notice')
    await h.advance(61_000)
    await h.advance(61_000)
    expect(h.notesOf('schedule_run')).toEqual([])
    expect(JSON.stringify(h.notes)).not.toContain('must never reach the agent')
    expect(rows().length).toBe(1) // once, not every tick
    expect(rows()[0]?.message.text).toContain("couldn't")
    expect(ran()).toEqual([])
    flag.fail = false
    await h.advance(61_000)
    await waitFor(() => ran().length === 1 && closed(), 30_000, 'the slot to run once Chronos answers')
    expect(h.notesOf('schedule_run')).toEqual([])
  })
})
