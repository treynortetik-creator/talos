// HB5b through the REAL bridge (live, in process, on an injected clock) and the REAL Chronos CLI: the app's signed
// `heartbeat.test` is acked at once, the sources really run in dry mode, and `heartbeat.test_result` comes back in the shape the
// app reads. A pass is remembered by the bridge (and only a real pass).
import { afterEach, describe, expect, test } from 'bun:test'
import { existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  HEARTBEAT_FEATURE,
  HeartbeatConfig,
  heartbeatConfigHashOf,
  heartbeatTestPassed,
  newUlid,
  parseHeartbeatTestResult,
} from '@talos-app/protocol'
import { mkFrame } from '@talos-app/testkit'
import { bridgeFeatures } from '../../src/handshake.ts'
import { BUSY_SUMMARY } from '../../src/heartbeat/run-parts.ts'
import { hasFreshPass, testsFile } from '../../src/heartbeat/tested.ts'
import { longTimeouts, type SchedHarness, startSched, waitFor } from '../schedules/harness.ts'
import { cmd, config, errAnswer, item, ok, printing, script, tmpDir } from './kit.ts'

longTimeouts()

const T0950 = '2026-10-05T13:50:00Z'
// biome-ignore lint/suspicious/noExplicitAny: a test's view of JSON
type J = any
let h = undefined as unknown as SchedHarness
let dir: string
afterEach(async () => {
  await h?.stop()
  h = undefined as unknown as SchedHarness
})
const begin = async () => {
  dir = tmpDir('hb-tr-')
  h = await startSched({ now: T0950, heartbeat: { secondMs: 100 } })
}
const FIX = new URL('../../../../packages/testkit/fixtures/heartbeat-frames/', import.meta.url)
const fx = (n: string): J => JSON.parse(readFileSync(new URL(n, FIX), 'utf8'))

/** Sends a test and returns the frame, its ack and its result (each waited for). */
async function ask(cfg: unknown, opts: { windowH?: number; withAgent?: boolean; requestId?: string } = {}) {
  const f = await h.app.testHeartbeat(cfg as Record<string, unknown>, opts)
  const ack = await h.app.expectFrame('ack', (x) => x.ref === f.id, { direction: 'in' })
  const res = await h.app.expectFrame('heartbeat.test_result', (x) => x.request_id === (f as J).request_id, {
    direction: 'in',
    timeoutMs: 20_000,
  })
  return { f, ack, res: res.result as J }
}
const refused = async (cfg: unknown, opts: Parameters<typeof ask>[1] = {}) => {
  const f = await h.app.testHeartbeat(cfg as Record<string, unknown>, opts)
  const e = await h.app.expectFrame('error', (x) => x.ref === f.id, { direction: 'in' })
  return { f, e }
}
const idx = (type: string) => h.app.rec.frames.findIndex((r) => r.direction === 'in' && r.raw.type === type)

describe('heartbeat.test answered by the bridge', () => {
  test('acks first, then the result: the same keys the app reads in its own fixtures, and the app parser says it passed', async () => {
    await begin()
    const cfg = config(
      [
        cmd('news', printing(dir, 'n', ok([item('a1', { level: 'act' }), item('f1')]))),
        cmd('mail', printing(dir, 'm', ok([]))),
      ],
      { mode: 'live' },
    )
    const { res } = await ask(cfg)
    expect(idx('ack')).toBeGreaterThanOrEqual(0)
    expect(idx('ack')).toBeLessThan(idx('heartbeat.test_result')) // acked before the result, never the other way round
    const pass = fx('01-test-pass.json').result
    expect(Object.keys(res).sort()).toEqual([...Object.keys(pass), 'error', 'if_live', 'mode'].sort())
    expect(res.error).toBeNull()
    for (const row of res.sources) expect(Object.keys(row).sort()).toEqual(Object.keys(pass.sources[0]).sort())
    expect(Object.keys(res.would_wake[0]).sort()).toEqual(Object.keys(pass.would_wake[0]).sort())
    const parsed = parseHeartbeatTestResult(res)
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    expect(parsed.result.unreadable_rows).toBe(0)
    expect(heartbeatTestPassed(parsed.result, cfg, h.clock.now())).toBe(true)
    expect(res.sources).toMatchObject([
      { id: 'news', ok: true, read: 2, act: 1, fyi: 1, dropped: 0, held: 0, unreadable: 0 },
      { id: 'mail', ok: true, read: 0, act: 0, fyi: 0, dropped: 0, held: 0, unreadable: 0 },
    ])
    expect(res.would_wake).toEqual([{ source: 'news', title: 'Item a1', why: 'test.rule' }])
    expect(res.would_post).toEqual([{ source: 'news', title: 'Item f1', why: 'test.rule' }])
    expect(res.at).toBe(new Date(h.clock.now()).toISOString())
    expect(res.with_agent).toBe(false)
    expect(res.window_h).toBe(24)
    expect(res.est_wakes).toBe(1)
  })

  test('config_hash is heartbeatConfigHashOf on the RAW config in the frame (defaults left out), and another config hashes differently', async () => {
    await begin()
    const src = printing(dir, 'n', ok([]))
    const raw = {
      schema: 'talos.heartbeat/1',
      mutes: [],
      sources: [{ id: 'news', kind: 'command', enabled: true, args: { argv: ['/bin/sh', src] }, timeout_s: 5 }],
    }
    expect(HeartbeatConfig.safeParse(raw).success).toBe(true) // defaults (mode, mutes, caps, limits) are filled by the strict parse
    const { res } = await ask(raw)
    expect(res.config_hash).toBe(heartbeatConfigHashOf(raw))
    const other = { ...raw, mode: 'live' }
    expect(heartbeatConfigHashOf(other)).not.toBe(res.config_hash)
  })

  test('a real pass is remembered by the bridge (hash and time), and by nothing else', async () => {
    await begin()
    const cfg = config([cmd('news', printing(dir, 'n', ok([])))])
    expect(existsSync(testsFile(h.home))).toBe(false)
    const { res } = await ask(cfg)
    expect(hasFreshPass(h.home, res.config_hash, h.clock.now())).toBe(true)
    const file = JSON.parse(readFileSync(testsFile(h.home), 'utf8'))
    expect(file.passes[res.config_hash]).toBe(new Date(h.clock.now()).toISOString())
    expect(
      hasFreshPass(
        h.home,
        heartbeatConfigHashOf({ ...cfg, mode: cfg.mode === 'live' ? 'shadow' : 'live' }),
        h.clock.now(),
      ),
    ).toBe(false)
  })

  test('a test writes no store, posts nothing, wakes nobody, claims nothing in Chronos', async () => {
    await begin()
    await ask(config([cmd('news', printing(dir, 'n', ok([item('a1', { level: 'act' })])))], { mode: 'live' }))
    expect(readdirSync(h.home).filter((f) => f.startsWith('heartbeat-state'))).toEqual([])
    expect(existsSync(join(h.home, 'heartbeat-shadow.jsonl'))).toBe(false)
    expect(existsSync(join(h.home, 'heartbeat', 'runs'))).toBe(false)
    expect(h.notes).toEqual([])
    expect(h.relay.frames.filter((r) => r.frame.type === 'reply' && r.direction === 'from_bridge')).toEqual([])
    expect(
      existsSync(h.box.stateDir()) ? readdirSync(h.box.stateDir()).filter((f) => f.startsWith('ran-')) : [],
    ).toEqual([])
    // the sources were asked with dry:true
    expect(JSON.parse(readFileSync(join(dir, 'n.stdin'), 'utf8')).dry).toBe(true)
  })

  test('a failed source is a failed row with its reason, the test is not a pass, and nothing is remembered', async () => {
    await begin()
    const cfg = config([
      cmd('good', printing(dir, 'g', ok([]))),
      cmd('bad', printing(dir, 'b', errAnswer('gh is not signed in'))),
    ])
    const { res } = await ask(cfg)
    expect(res.sources.find((s: J) => s.id === 'bad')).toMatchObject({ ok: false, error: 'gh is not signed in' })
    const parsed = parseHeartbeatTestResult(res)
    expect(parsed.ok && heartbeatTestPassed(parsed.result, cfg, h.clock.now())).toBe(false)
    expect(existsSync(testsFile(h.home))).toBe(false)
  })

  test('an item that does not parse is counted as unreadable on its source and the test is not a pass', async () => {
    await begin()
    const cfg = config([cmd('news', printing(dir, 'n', ok([item('a'), { key: 'broken', sig: '1' }])))])
    const { res } = await ask(cfg)
    expect(res.sources[0].unreadable).toBe(1)
    expect(existsSync(testsFile(h.home))).toBe(false)
  })

  test('a hanging source is killed at run_timeout_s with its children, the answer says why, and it is not a pass', async () => {
    dir = tmpDir('hb-tr-')
    h = await startSched({ now: T0950, heartbeat: { secondMs: 60 } })
    const pidFile = join(dir, 'child.pid')
    const hang = script(dir, 'hang', `sleep 60 &\necho $! > '${pidFile}'\nwait`)
    const t0 = Date.now()
    const { res } = await ask(config([cmd('slow', hang, { timeout_s: 60 })], { run_timeout_s: 30 }))
    expect(Date.now() - t0).toBeLessThan(3200) // the source's own limit is 3.6 s here; the run's is 1.8 s
    expect(res.sources[0]).toMatchObject({ id: 'slow', ok: false })
    expect(res.sources[0].error).toContain('time limit')
    await new Promise((r) => setTimeout(r, 200))
    expect(() => process.kill(Number(readFileSync(pidFile, 'utf8').trim()), 0)).toThrow()
    expect(existsSync(testsFile(h.home))).toBe(false)
  })

  test('a pass that cannot be saved is reported as a failed test, never as a pass the next enable would refuse', async () => {
    await begin()
    writeFileSync(join(h.home, 'heartbeat'), 'not a folder') // the folder the ledger lives in is a file: it cannot be written
    const cfg = config([cmd('news', printing(dir, 'n', ok([])))])
    const { res } = await ask(cfg)
    expect(res.error).toContain('could not save')
    const parsed = parseHeartbeatTestResult(res)
    expect(parsed.ok && heartbeatTestPassed(parsed.result, cfg, h.clock.now())).toBe(false)
  })
})

describe('what the bridge refuses', () => {
  test('settings that fail the strict schema: a plain schedule_invalid with the field paths, no ack, no source run, the bridge carries on', async () => {
    await begin()
    const src = printing(dir, 'n', ok([]))
    const good = config([cmd('news', src)])
    for (const bad of [
      { ...good, future_key: 1 },
      { ...good, sources: [{ id: 'chat', kind: 'slack', enabled: true, args: {}, timeout_s: 10 }] },
      { schema: 'talos.heartbeat/1' },
      { ...good, sources: [{ ...good.sources[0], args: { argv: ['python3'] } }] },
    ]) {
      const { f, e } = await refused(bad)
      expect(e.code).toBe('schedule_invalid')
      expect(String(e.message)).toContain("can't be tested")
      expect(JSON.stringify(e.fields)).toContain('config')
      expect(h.app.rec.frames.some((r) => r.direction === 'in' && r.raw.type === 'ack' && r.raw.ref === f.id)).toBe(
        false,
      )
    }
    expect(existsSync(join(dir, 'n.stdin'))).toBe(false)
    const { res } = await ask(good) // still alive
    expect(res.sources[0].ok).toBe(true)
  })

  test('"with the agent" is not built: refused in words, nothing runs', async () => {
    await begin()
    const { e } = await refused(config([cmd('news', printing(dir, 'n', ok([])))]), { withAgent: true })
    expect(e.code).toBe('scheduler_unavailable')
    expect(String(e.message)).toContain("isn't available")
    expect(existsSync(join(dir, 'n.stdin'))).toBe(false)
  })

  test('the same request_id asked twice runs the sources once, and both asks are acked', async () => {
    await begin()
    const counter = join(dir, 'count')
    const cfg = config([cmd('news', script(dir, 'n', `echo x >> '${counter}'\nsleep 0.4\necho '${ok([])}'`))])
    const requestId = newUlid()
    const a = await h.app.testHeartbeat(cfg as never, { requestId })
    const b = await h.app.testHeartbeat(cfg as never, { requestId })
    await h.app.expectFrame('ack', (x) => x.ref === a.id, { direction: 'in' })
    await h.app.expectFrame('ack', (x) => x.ref === b.id, { direction: 'in' })
    await h.app.expectFrame('heartbeat.test_result', (x) => x.request_id === requestId, {
      direction: 'in',
      timeoutMs: 20_000,
    })
    expect(readFileSync(counter, 'utf8').trim().split('\n')).toHaveLength(1)
  })

  test('a second test while one runs is rate_limited with words ("a test is already running"); the running one still answers', async () => {
    dir = tmpDir('hb-tr-')
    h = await startSched({ now: T0950, heartbeat: { secondMs: 100 } })
    const slow = (n: string) => config([cmd('news', script(dir, n, `sleep 1\necho '${ok([])}'`), { timeout_s: 60 })])
    const a = await h.app.testHeartbeat(slow('a') as never)
    await h.app.expectFrame('ack', (x) => x.ref === a.id, { direction: 'in' })
    const { e } = await refused(slow('c'))
    expect(e.code).toBe('rate_limited')
    expect(String(e.message)).toContain('already running')
    await h.app.expectFrame('heartbeat.test_result', (x) => x.request_id === (a as J).request_id, {
      direction: 'in',
      timeoutMs: 20_000,
    })
    // and once it is done the next one is taken
    const { res } = await ask(slow('d'))
    expect(res.sources[0].ok).toBe(true)
  })

  test('a request that is older than the run_now window is refused as stale, like run_now and control, and nothing runs', async () => {
    await begin()
    const src = printing(dir, 'n', ok([]))
    const old = new Date(h.clock.now() - 10 * 60_000).toISOString()
    const f = (await h.app.sendSchedule('heartbeat.test', {
      request_id: newUlid(),
      config: config([cmd('news', src)]),
      window_h: 24,
      with_agent: false,
      ts: old,
      keep_ts: true,
    })) as J
    const e = await h.app.expectFrame('error', (x) => x.ref === f.id, { direction: 'in' })
    expect(e.code).toBe('stale')
    expect(existsSync(join(dir, 'n.stdin'))).toBe(false)
  })

  test('shadow: the answer says it would record only (no wake, no post, no estimate) and shows what live WOULD do; live: the real lists', async () => {
    await begin()
    const items = [item('a1', { level: 'act' }), item('f1')]
    const shadow = await ask(config([cmd('news', printing(dir, 'n', ok(items)))], { mode: 'shadow' }))
    expect(shadow.res.mode).toBe('shadow')
    expect(shadow.res.would_wake).toEqual([])
    expect(shadow.res.would_post).toEqual([])
    expect(shadow.res.est_wakes).toBe(0)
    expect(shadow.res.est_tokens).toBe(0)
    expect(shadow.res.if_live).toMatchObject({ est_wakes: 1, est_tokens: 180000 })
    expect(shadow.res.if_live.would_wake.map((l: J) => l.title)).toEqual(['Item a1'])
    expect(shadow.res.if_live.would_post.map((l: J) => l.title)).toEqual(['Item f1'])
    expect(shadow.res.sources[0]).toMatchObject({ read: 2, act: 1, fyi: 1 }) // what the source found is still counted
    const live = await ask(config([cmd('news', printing(dir, 'm', ok(items)))], { mode: 'live' }))
    expect(live.res.mode).toBe('live')
    expect(live.res.would_wake.map((l: J) => l.title)).toEqual(['Item a1'])
    expect(live.res.est_wakes).toBe(1)
    expect(live.res.if_live).toBeNull()
  })

  test('an unsigned frame, and a signed frame whose settings were changed after signing, are refused and no source runs', async () => {
    await begin()
    const src = printing(dir, 'n', ok([]))
    const cfg = config([cmd('news', src)])
    // unsigned
    const bare = mkFrame('heartbeat.test', { request_id: newUlid(), config: cfg, window_h: 24, with_agent: false })
    h.app.send(bare)
    const e1 = await h.app.expectFrame('error', (x) => x.ref === bare.id, { direction: 'in' })
    expect(['sig_invalid', 'device_not_pinned', 'bad_frame']).toContain(e1.code as string)
    // signed for one config, sent with another (what was shown is what was signed)
    const signed = (await h.app.testHeartbeat(cfg as never)) as J
    await h.app.expectFrame('heartbeat.test_result', (x) => x.request_id === signed.request_id, {
      direction: 'in',
      timeoutMs: 20_000,
    })
    rmSync(join(dir, 'n.stdin'))
    const evil = {
      ...signed,
      id: newUlid(),
      request_id: newUlid(),
      config: { ...cfg, mode: 'shadow' === cfg.mode ? 'live' : 'shadow' },
    }
    h.app.send(evil)
    const e2 = await h.app.expectFrame('error', (x) => x.ref === evil.id, { direction: 'in' })
    expect(e2.code).toBe('sig_invalid')
    expect(existsSync(join(dir, 'n.stdin'))).toBe(false)
  })
})

describe('turning off reaches a test in flight', () => {
  test('stopping the bridge while a test runs kills its source and its children, and writes no pass', async () => {
    // real-time limits (150 s for the run), so only the stop can be what ends the source inside this test
    dir = tmpDir('hb-tr-')
    h = await startSched({ now: T0950, heartbeat: { secondMs: 1000 } })
    const pidFile = join(dir, 'child.pid')
    const hang = script(dir, 'hang', `sleep 60 &\necho $! > '${pidFile}'\nwait`)
    const f = await h.app.testHeartbeat(config([cmd('slow', hang, { timeout_s: 60 })], { run_timeout_s: 150 }) as never)
    await h.app.expectFrame('ack', (x) => x.ref === f.id, { direction: 'in' })
    await waitFor(() => existsSync(pidFile), 10_000, 'the source to start')
    const pid = Number(readFileSync(pidFile, 'utf8').trim())
    await h.stop()
    await waitFor(
      () => {
        try {
          process.kill(pid, 0)
          return false
        } catch {
          return true
        }
      },
      8000,
      'the source children to be killed',
    )
    expect(existsSync(testsFile(h.home))).toBe(false)
    h = undefined as unknown as SchedHarness
  })
})

describe('the feature and the busy words', () => {
  test('the bridge lists heartbeat/1', () => {
    expect(bridgeFeatures({})).toContain(HEARTBEAT_FEATURE)
    expect(bridgeFeatures({}).length).toBeLessThanOrEqual(20)
  })
  test('the busy summary starts "Busy:" and matches the pattern the app reads', () => {
    expect(BUSY_SUMMARY.startsWith('Busy:')).toBe(true)
    expect(/^busy\b/i.test(BUSY_SUMMARY)).toBe(true)
  })
})

describe('R1-8: a run that breaks after the ack still reports what the sources answered', () => {
  test('answered sources keep their real results, unfinished ones are failed, and the result is never a pass', async () => {
    const { HeartbeatTester } = await import('../../src/heartbeat/test-run.ts')
    const sent: J[] = []
    const cfg = config([cmd('done', '/bin/true'), cmd('late', '/bin/true')])
    const runner = {
      run: async (input: J) => {
        input.test.onSource({
          id: 'done',
          ok: true,
          ms: 321,
          unreadable: 1,
          items: [{ level: 'act' }, { level: 'fyi' }],
          cursor: null,
        })
        throw new Error('boom after one source')
      },
    }
    const t = new HeartbeatTester({
      runner: runner as never,
      home: tmpDir(),
      now: () => Date.parse(T0950),
      send: (f) => (sent.push(f), true),
      log: () => {},
    })
    t.handle({
      id: newUlid(),
      type: 'heartbeat.test',
      request_id: newUlid(),
      config: cfg,
      window_h: 24,
      with_agent: false,
    } as never)
    await t.idle()
    const res = sent.find((f) => f.type === 'heartbeat.test_result').result
    expect(res.sources.find((s: J) => s.id === 'done')).toMatchObject({
      ok: true,
      ms: 321,
      read: 2,
      act: 1,
      fyi: 1,
      unreadable: 1,
    })
    expect(res.sources.find((s: J) => s.id === 'late')).toMatchObject({ ok: false })
    expect(res.sources.find((s: J) => s.id === 'late').error).toContain('did not finish')
    expect(res.error).toContain('could not finish')
    const parsed = parseHeartbeatTestResult(res)
    expect(parsed.ok && heartbeatTestPassed(parsed.result, cfg, Date.parse(T0950))).toBe(false)
  })
})
