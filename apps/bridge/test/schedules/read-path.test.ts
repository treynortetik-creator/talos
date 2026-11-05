// WP-S1 acceptance: discovery, the read path, single-flight, timeouts and queues, "no scheduler", headless thread.
import { afterEach, describe, expect, test } from 'bun:test'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ScheduleDetail, ScheduleSnapshot } from '@talos-app/protocol'
import { Bridge } from '../../src/bridge.ts'
import { loadEnv } from '../../src/config.ts'
import { nullLogger } from '../../src/log.ts'
import { startHarness } from '../helpers.ts'
import {
  ChronosBox,
  draft,
  longTimeouts,
  MON_0700_EDT,
  type Req,
  type SchedHarness,
  sleep,
  startSched,
  tempHome,
  waitFor,
} from './harness.ts'

longTimeouts()

let h = undefined as unknown as SchedHarness
afterEach(async () => {
  await h?.stop()
  h = undefined as unknown as SchedHarness
})

const emptyHome = () => mkdtempSync(join(tmpdir(), 'talos-nohome-'))

async function snapshotOf(x: SchedHarness) {
  const f = await x.app.listSchedules()
  const s = await x.app.expectFrame('schedules.snapshot', (r) => r.request_id === (f as unknown as Req).request_id, {
    direction: 'in',
    timeoutMs: 10_000,
  })
  return { frame: f, snapshot: ScheduleSnapshot.parse(s.snapshot) }
}

/** A `chronos` that counts every call in `calls.log`, optionally hangs one api verb, then runs the real one. */
function wrapBin(box: ChronosBox, opts: { hang?: string } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'talos-wrapbin-'))
  const log = join(dir, 'calls.log')
  const bin = join(dir, 'chronos')
  writeFileSync(
    bin,
    `#!/bin/sh\necho "$@" >> '${log}'\n${opts.hang ? `if [ "$1" = api ] && [ "$2" = ${opts.hang} ]; then exec sleep 30; fi\n` : ''}exec '${box.bin}' "$@"\n`,
  )
  chmodSync(bin, 0o755)
  const calls = (verb: string) =>
    (() => {
      try {
        return readFileSync(log, 'utf8').split('\n')
      } catch {
        return []
      }
    })().filter((l) => l.startsWith(`api ${verb}`)).length
  return { bin, calls }
}

describe('discovery (S1.4)', () => {
  test('the bridge advertises schedules/1 in its hello', async () => {
    h = await startSched()
    const hello = await h.relay.expectFrame('hello', (f) => f.role === 'bridge', { direction: 'from_bridge' })
    expect((hello.client as { features?: string[] }).features).toContain('schedules/1')
  })

  test('TALOS_APP_SCHEDULER=off: the tab says off and no schedule tools are registered', async () => {
    h = await startSched({ env: { TALOS_APP_SCHEDULER: 'off' } })
    const { snapshot } = await snapshotOf(h)
    expect(snapshot.health.state).toBe('off')
    expect(snapshot.schedules).toEqual([])
    const names = h.bridge.tools.map((t) => t.name)
    for (const t of ['schedules_list', 'schedule_propose', 'schedule_run_start', 'schedule_run_done'])
      expect(names).not.toContain(t)
  })

  test('nothing found: not_installed, and the tools answer the S1.6 text', async () => {
    h = await startHarness({
      env: { HOME: emptyHome(), PATH: '/nonexistent', TALOS_APP_CHRONOS_AUTODISCOVER: 'on' },
    }).then((x) => x as SchedHarness)
    const f = await h.app.listSchedules()
    const s = await h.app.expectFrame('schedules.snapshot', (r) => r.request_id === (f as unknown as Req).request_id, {
      direction: 'in',
    })
    const snap = ScheduleSnapshot.parse(s.snapshot)
    expect(snap.health.state).toBe('not_installed')
    expect(snap.health.issues.map((i) => i.code)).toContain('not_installed')
    const list = await h.bridge.callTool('schedules_list', {})
    expect(list.content[0]?.text).toBe(
      "No scheduler is installed on this Mac. Tell the owner they can install Chronos from the Schedules tab. Don't create cron, launchd or in-session timer jobs yourself.",
    )
    const propose = await h.bridge.callTool('schedule_propose', {
      op: 'create',
      thread_id: 'general',
      reason: 'x',
      name: 'x',
      prompt: 'x',
      when: { type: 'daily', time: '07:30' },
    })
    expect(propose.isError).toBe(true)
    expect(propose.content[0]?.text).toContain('No scheduler is installed')
  })

  test('Chronos 0.2 (no api): version_unsupported, with the upgrade copy, and no list', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'talos-chronos02-'))
    const bin = join(dir, 'chronos')
    writeFileSync(
      bin,
      `#!/bin/sh\nif [ "$1" = api ]; then echo "usage: chronos <command>" >&2; exit 2; fi\necho "chronos 0.2.2"\n`,
    )
    chmodSync(bin, 0o755)
    h = (await startHarness({
      env: { HOME: emptyHome(), PATH: '/usr/bin:/bin', TALOS_APP_CHRONOS_BIN: bin },
    })) as SchedHarness
    const f = await h.app.listSchedules()
    const s = await h.app.expectFrame('schedules.snapshot', (r) => r.request_id === (f as unknown as Req).request_id, {
      direction: 'in',
    })
    const snap = ScheduleSnapshot.parse(s.snapshot)
    expect(snap.health.state).toBe('unsupported')
    expect(snap.schedules).toEqual([])
    const issue = snap.health.issues.find((i) => i.code === 'version_unsupported')
    expect(issue?.text).toBe('Chronos 0.2 is installed. Talos needs 0.3 or newer: `git pull && ./install.sh`')
  })

  test('a Chronos that is slow to answer `api version` once is not "unsupported": it is asked again and then used', async () => {
    const box = new ChronosBox(MON_0700_EDT)
    box.configure({ sessionRunner: 'talos', approvalRequired: true })
    box.create(draft())
    const dir = mkdtempSync(join(tmpdir(), 'talos-slowfirst-'))
    const bin = join(dir, 'chronos')
    const marker = join(dir, 'stalled-once')
    const legacyLog = join(dir, 'legacy-version-calls')
    // the first `api version` stalls past the discovery budget; a plain `version` (the legacy probe) is recorded
    writeFileSync(
      bin,
      `#!/bin/sh\nif [ "$1" = version ]; then echo x >> '${legacyLog}'; fi\nif [ "$1" = api ] && [ "$2" = version ] && [ ! -e '${marker}' ]; then : > '${marker}'; exec sleep 30; fi\nexec '${box.bin}' "$@"\n`,
    )
    chmodSync(bin, 0o755)
    h = await startSched({ box, env: { TALOS_APP_CHRONOS_BIN: bin }, discoveryTimeoutMs: 400 })
    // while it is unanswered: no false upgrade advice, no "no scheduler" either
    const first = await snapshotOf(h)
    expect(first.snapshot.health.state).not.toBe('unsupported')
    expect(first.snapshot.health.issues.map((i) => i.code)).not.toContain('version_unsupported')
    expect(first.snapshot.health.issues.map((i) => i.code)).toContain('adapter_timeout')
    expect(() => readFileSync(legacyLog, 'utf8')).toThrow() // the legacy `version` fallback never ran
    // the next runner tick asks again, and this time it answers. The retry has the same 400 ms budget through sh, sh and Python, so on
    // a loaded box it can miss too; each miss restarts the wait, so the clock moves on again until it has answered.
    let ids: string[] = []
    for (const deadline = Date.now() + 15_000; Date.now() < deadline && !ids.includes('daily-digest'); ) {
      await h.advance(61_000)
      const { snapshot } = await snapshotOf(h)
      ids = snapshot.schedules.map((x) => x.id)
      if (!ids.length) await sleep(100)
    }
    expect(ids).toContain('daily-digest')
  })

  test('PATH discovery: a chronos on PATH that answers api version within 5 s is used', async () => {
    const box = new ChronosBox(MON_0700_EDT)
    box.configure({ sessionRunner: 'talos', approvalRequired: true })
    box.create(draft())
    const dir = mkdtempSync(join(tmpdir(), 'talos-pathbin-'))
    writeFileSync(join(dir, 'chronos'), readFileSync(box.bin, 'utf8'))
    chmodSync(join(dir, 'chronos'), 0o755)
    h = (await startSched({
      box,
      // an empty HOME, so the real ~/.local/share/chronos is never a candidate
      env: {
        HOME: emptyHome(),
        PATH: `${dir}:${process.env.PATH}`,
        TALOS_APP_CHRONOS_BIN: '',
        TALOS_APP_CHRONOS_AUTODISCOVER: 'on',
      },
    })) as SchedHarness
    const { snapshot } = await snapshotOf(h)
    expect(snapshot.schedules.map((s) => s.id)).toEqual(['daily-digest'])
  })

  test('a test-only clock in a production environment refuses to start', async () => {
    const home = tempHome()
    writeFileSync(join(home, 'config.json'), '{}')
    const env = loadEnv({ TALOS_APP_HOME: home, TALOS_APP_CHRONOS_NOW: '2026-10-05T07:00:00-04:00' })
    await expect(Bridge.create({ env, logger: nullLogger })).rejects.toThrow(/TALOS_APP_CHRONOS_NOW/)
  })
})

describe('read path (S3.1)', () => {
  test('a signed schedules.list answers ack{ref} (no seq) and a snapshot whose when_text equals `chronos list`', async () => {
    h = await startSched({
      jobs: [
        draft(),
        draft({ id: 'weekday-brief', name: 'Weekday Brief', when: { type: 'weekdays', time: '08:15' } }),
        draft({ id: 'one-time', name: 'One Time', when: { type: 'once', at: '2026-10-09T10:00' } }),
      ],
    })
    const f = await h.app.listSchedules()
    const ack = await h.app.expectFrame('ack', (a) => a.ref === f.id, { direction: 'in' })
    expect(ack.seq).toBeUndefined()
    const s = await h.app.expectFrame('schedules.snapshot', (r) => r.request_id === (f as unknown as Req).request_id, {
      direction: 'in',
    })
    const snap = ScheduleSnapshot.parse(s.snapshot)
    expect(snap.protocol).toBe(1)
    expect(snap.health.state).toBe('ok')
    expect(snap.health.session_runner).toBe('talos')
    expect(snap.schedules.map((x) => x.id).sort()).toEqual(['daily-digest', 'one-time', 'weekday-brief'])
    for (const j of snap.schedules) expect(j.when_text).toBe(h.box.listedWhenText(j.id))
    // the S1.4 row: the host label is a sanitized, non-empty name
    expect(snap.health.host_label.length).toBeGreaterThan(0)
  })

  test('schedule.get answers a detail with the full prompt; an unknown id is error schedule_not_found', async () => {
    h = await startSched({ jobs: [draft()] })
    const f = await h.app.getSchedule('daily-digest')
    const d = await h.app.expectFrame('schedule.detail', (r) => r.request_id === (f as unknown as Req).request_id, {
      direction: 'in',
    })
    const detail = ScheduleDetail.parse(d.detail)
    expect(detail.prompt).toBe('Summarise yesterday and post it.\n')
    expect(detail.next_runs.length).toBe(3)
    const g = await h.app.getSchedule('no-such-job')
    const err = await h.app.expectFrame('error', (e) => e.ref === g.id, { direction: 'in' })
    expect(err.code).toBe('schedule_not_found')
  })

  test('snapshot() is single-flight: two lists within 2 s share one spawn', async () => {
    const box = new ChronosBox(MON_0700_EDT)
    box.configure({ sessionRunner: 'talos', approvalRequired: true })
    box.create(draft())
    const w = wrapBin(box)
    h = await startSched({ box, env: { TALOS_APP_CHRONOS_BIN: w.bin } })
    await sleep(300) // the start-up refresh settles
    const before = w.calls('snapshot')
    const a = await h.app.listSchedules()
    const b = await h.app.listSchedules()
    for (const f of [a, b])
      await h.app.expectFrame('schedules.snapshot', (r) => r.request_id === (f as unknown as Req).request_id, {
        direction: 'in',
      })
    expect(w.calls('snapshot') - before).toBeLessThanOrEqual(1)
  })

  test('an unreadable row is one entry plus an issue, not a dead list', async () => {
    h = await startSched({ jobs: [draft()] })
    const jobsFile = join(h.box.home, '.config', 'chronos', 'jobs.json')
    const raw = JSON.parse(readFileSync(jobsFile, 'utf8')) as { jobs?: unknown[] } | unknown[]
    const list = (Array.isArray(raw) ? raw : (raw.jobs ?? [])) as Array<Record<string, unknown>>
    list.push({
      id: 'broken-one',
      name: 'Broken',
      time: '99:99',
      days: 'daily',
      catchup_min: 60,
      enabled: true,
      in_session: true,
      headless: false,
    })
    writeFileSync(jobsFile, JSON.stringify(Array.isArray(raw) ? list : { ...raw, jobs: list }))
    await h.advance(2_100) // past the 2 s single-flight window
    const { snapshot } = await snapshotOf(h)
    expect(snapshot.schedules.map((s) => s.id)).toContain('daily-digest')
    expect(snapshot.unreadable.map((u) => u.id)).toContain('broken-one')
    expect(snapshot.health.issues.map((i) => i.code)).toContain('registry_unreadable')
  })
})

describe('timeouts and queues (S2.4, S3.1)', () => {
  test('an adapter call that hangs past its timeout is adapter_timeout, and chat is not delayed', async () => {
    const box = new ChronosBox(MON_0700_EDT)
    box.configure({ sessionRunner: 'talos', approvalRequired: true })
    box.create(draft())
    // discovery (api version) is quick; the snapshot call hangs
    const w = wrapBin(box, { hang: 'snapshot' })
    h = await startSched({
      box,
      env: { TALOS_APP_CHRONOS_BIN: w.bin, TALOS_APP_SCHEDULER_TIMEOUT_S: '1' },
    })
    const t0 = Date.now()
    const f = await h.app.listSchedules() // sits on the schedule queue for ~1 s
    // a chat message meanwhile: the round trip to the agent is not behind the hung adapter call
    const sent = await h.app.sendMessage('general', 'are you there')
    await waitFor(
      () => h?.notes.some((n) => n.content.includes('are you there')) ?? false,
      3000,
      'the chat notification',
    )
    const delay = Date.now() - t0
    expect(delay).toBeLessThan(900)
    expect(sent.id).toBeDefined()
    const s = await h.app.expectFrame('schedules.snapshot', (r) => r.request_id === (f as unknown as Req).request_id, {
      direction: 'in',
      timeoutMs: 10_000,
    })
    const snap = ScheduleSnapshot.parse(s.snapshot)
    expect(snap.health.state).toBe('stuck')
    expect(snap.health.issues.map((i) => i.code)).toContain('adapter_timeout')
  })
})

describe('headless thread (S3.6)', () => {
  test('a headless bridge with CHRONOS_JOB set resolves the job thread and marks it in list_threads', async () => {
    const live = await startSched({ jobs: [draft()] })
    // the live bridge's sidecar names the job's result thread (set by an approved card in real use)
    writeFileSync(
      join(live.home, 'schedules-meta.json'),
      JSON.stringify({
        adapter: 'chronos',
        jobs: { 'daily-digest': { thread_id: 'inbox' } },
        offers: {},
        inflight: {},
      }),
    )
    const home = live.home
    await live.stop()
    const hl = await startHarness({
      home,
      startBridge: false,
      env: { CHRONOS_JOB: 'daily-digest', PATH: process.env.PATH ?? '/usr/bin:/bin' },
      bridge: { headless: true },
    })
    try {
      expect(hl.bridge.ctx.mode).toBe('headless')
      const res = await hl.bridge.callTool('list_threads', {})
      const out = JSON.parse(res.content[0]?.text ?? '{}') as {
        default_thread: string
        threads: Array<{ id: string; name: string }>
      }
      expect(out.default_thread).toBe('inbox')
      expect(out.threads.find((t) => t.id === 'inbox')?.name).toContain("(this job's thread)")
    } finally {
      await hl.stop()
    }
  })

  test('schedules_list works headless (read-only); the other schedule tools need a live session', async () => {
    const live = await startSched({ jobs: [draft()] })
    const box = live.box
    await live.stop()
    const hl = await startHarness({
      startBridge: false,
      env: { TALOS_APP_CHRONOS_BIN: box.bin, PATH: process.env.PATH ?? '/usr/bin:/bin' },
      bridge: { headless: true },
    })
    try {
      const list = await hl.bridge.callTool('schedules_list', {})
      expect(list.isError).toBeFalsy()
      expect(list.content[0]?.text).toContain('daily-digest')
      for (const t of ['schedule_propose', 'schedule_run_start', 'schedule_run_done']) {
        const r = await hl.bridge.callTool(t, { run_id: 'r_x', op: 'create', thread_id: 'general', reason: 'x' })
        expect(r.isError).toBe(true)
        expect(r.content[0]?.text).toContain('needs a live session')
      }
    } finally {
      await hl.stop()
    }
  })
})

void mkdirSync

describe('test bridges never find the real Chronos (2026-11-03)', () => {
  test('with autodiscovery off and no TALOS_APP_CHRONOS_BIN, discovery is off: PATH and ~/.local/share are never probed', async () => {
    expect(process.env.TALOS_APP_CHRONOS_AUTODISCOVER).toBe('off') // test/preload.ts
    const { loadEnv } = await import('../../src/config.ts')
    const { discover } = await import('../../src/schedules/discovery.ts')
    const env = loadEnv({ TALOS_APP_HOME: emptyHome(), HOME: '/home/owner-does-not-matter', PATH: '/usr/bin:/bin' })
    expect(env.chronosAutoDiscover).toBe(false)
    const d = await discover(env, {
      meta: { instance: 'test', host: 'test' } as never,
      now: Date.now,
      clockIso: () => new Date().toISOString(),
    })
    expect(d.state).toBe('off')
  })
})
