// HB5b: test_required. A heartbeat that a change leaves ENABLED needs a passing test of those exact settings, under 24 hours old,
// whichever door the change comes by: the agent's schedule_propose, the owner's schedule.patch frame, an adopt. The rule sits in
// prepareCard (and is asked again when the card is approved). The bridge, relay frames and app frames are the real ones; Chronos
// is a replay of its recorded output. Passes are written with `recordPass`, the one function the bridge itself writes them with.
import { afterEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { type CardT, HEARTBEAT_META_KEY, HEARTBEAT_TEST_VALID_MS, heartbeatConfigHashOf } from '@talos-app/protocol'
import { recordPass, TEST_REQUIRED, testRequiredProblem, testsFile } from '../../src/heartbeat/tested.ts'
import { longTimeouts, type Req, type SchedHarness, startSched, waitFor } from './harness.ts'
import { fixture, ReplayBox } from './replay-box.ts'

longTimeouts()

let h = undefined as unknown as SchedHarness
afterEach(async () => {
  await h?.stop()
  h = undefined as unknown as SchedHarness
})

const gh = { id: 'gh-main', kind: 'github', enabled: true, args: { repos: ['acme/widgets'] }, timeout_s: 30 }
const good = {
  schema: 'talos.heartbeat/1',
  mode: 'shadow',
  sources: [gh],
  mutes: [],
  wake_cap_per_day: 3,
  run_timeout_s: 120,
}
const SLOTS = ['09:45', '12:15', '14:45', '17:15']
const META = (c: unknown = good) => ({ [HEARTBEAT_META_KEY]: c })
const V2 = { relayFeatures: ['schedules/1', 'schedules/2', 'heartbeat/1'] }
/** The job's result thread lives in the Talos sidecar, not in Chronos: `check-in` has its own thread, as a heartbeat must. */
const start = (box: ReplayBox) => {
  const home = mkdtempSync(join(tmpdir(), 'hb-req-'))
  writeFileSync(join(home, 'schedules-meta.json'), JSON.stringify({ jobs: { 'check-in': { thread_id: 'inbox' } } }))
  return startSched({ box, relay: V2, now: box.now, home })
}
const validOk = (box: ReplayBox) => {
  const v = fixture<Record<string, unknown>>('chronos-0.4', 'validate-times-create')
  box.answer('validate', { ok: true, normalized: v.normalized, preview: v.preview, expected_etag: v.expected_etag })
}
/** A job on disk with a heartbeat in its meta. */
const onDisk = (box: ReplayBox, over: Record<string, unknown> = {}, cfg: unknown = good) => {
  const detail = fixture<{ schedule: Record<string, unknown> & { content_hash: string; etag: string } }>(
    'chronos-0.4',
    'detail-times-meta',
  )
  Object.assign(detail.schedule, { meta: META(cfg), runner: 'session', permissions: 'full', enabled: true }, over)
  box.answer('detail', detail)
  return detail.schedule
}
const pass = (cfg: unknown = good, ageMs = 0) => recordPass(h.home, heartbeatConfigHashOf(cfg), h.clock.now() - ageMs)

const propose = (over: Record<string, unknown> = {}, cfg: unknown = good) => ({
  op: 'create',
  thread_id: 'general',
  reason: 'a heartbeat',
  name: 'New Beat',
  when: { type: 'times', days: 'weekdays', times: SLOTS },
  meta: META(cfg),
  prompt: 'Check.\n',
  runner: 'session',
  permissions: 'full',
  allowed_tools: [],
  result_thread_id: 'inbox',
  ...over,
})
const draft = (over: Record<string, unknown> = {}, cfg: unknown = good) => ({
  id: 'new-beat',
  name: 'New Beat',
  description: '',
  when: { type: 'times', days: 'weekdays', times: SLOTS },
  catchup_min: 60,
  enabled: true,
  runner: 'session',
  permissions: 'full',
  allowed_tools: [],
  model: null,
  notify: 'failure',
  thread_id: 'inbox',
  prompt: 'Check.\n',
  meta: META(cfg),
  ...over,
})

type Door = {
  name: string
  /** A change that leaves the heartbeat enabled with `cfg`; `box` has the job on disk when the door needs one. */
  setup(box: ReplayBox): void
  /** Resolves to null when the change was accepted (a card was made), else the refusal words. */
  go(cfg: unknown): Promise<{ text: string; code?: string; field?: string } | null>
}
const viaTool = async (args: Record<string, unknown>) => {
  const r = await h.bridge.callTool('schedule_propose', args)
  return r.isError ? { text: r.content[0]?.text ?? '' } : null
}
const viaFrame = async (change: Record<string, unknown>) => {
  const f = await h.app.patchSchedule(change, 'general')
  const got = await Promise.race([
    h.app
      .expectFrame('error', (r) => r.ref === (f as unknown as Req).id, { direction: 'in', timeoutMs: 8000 })
      .then((e) => ({
        text: `${e.message} ${JSON.stringify(e.fields)}`,
        code: e.code as string,
        field: (e.fields as Array<{ path: string }> | undefined)?.[0]?.path,
      })),
    h.app
      .expectFrame('card.create', (c) => (c.card.payload as { client_ref?: string } | undefined)?.client_ref === f.id, {
        direction: 'in',
        timeoutMs: 8000,
      })
      .then(() => null),
  ])
  return got
}
const doors: Door[] = [
  {
    name: 'the agent (schedule_propose create)',
    setup: (box) => validOk(box),
    go: (cfg) => viaTool(propose({}, cfg)),
  },
  {
    name: 'the owner (schedule.patch create)',
    setup: (box) => validOk(box),
    go: (cfg) => viaFrame({ op: 'create', draft: draft({}, cfg) }),
  },
  {
    name: 'the owner (schedule.patch update, Turn on)',
    setup: (box) => {
      validOk(box)
      onDisk(box, { enabled: false })
    },
    go: (cfg) =>
      viaFrame({ op: 'update', id: 'check-in', base_etag: ONDISK_ETAG, set: { enabled: true, meta: META(cfg) } }),
  },
  {
    name: 'the agent (schedule_propose update, Turn on)',
    setup: (box) => {
      validOk(box)
      onDisk(box, { enabled: false })
    },
    go: (cfg) =>
      viaTool({ op: 'update', id: 'check-in', thread_id: 'general', reason: 'x', enabled: true, meta: META(cfg) }),
  },
  {
    name: 'an adopt',
    setup: (box) => {
      validOk(box)
    },
    go: () => viaFrame({ op: 'adopt', id: 'check-in', content_hash: ONDISK_HASH }),
  },
]
const ONDISK_ETAG = fixture<{ schedule: { etag: string } }>('chronos-0.4', 'detail-times-meta').schedule.etag
const ONDISK_HASH = fixture<{ schedule: { content_hash: string } }>('chronos-0.4', 'detail-times-meta').schedule
  .content_hash

/** Starts a harness for a door. The adopt door adopts whatever is on disk, so that is `cfg` itself. */
async function begin(door: Door, cfg: unknown) {
  const box = ReplayBox.times()
  door.setup(box)
  if (door.name === 'an adopt') onDisk(box, { enabled: true }, cfg)
  else if (door.name.includes('update')) onDisk(box, { enabled: false }, good)
  h = await start(box)
  return box
}

describe('test_required: all the doors refuse an enabled heartbeat that has no passing test', () => {
  for (const door of doors) {
    test(`${door.name}: refused in words, with the test_required field, and Chronos is never asked`, async () => {
      const box = await begin(door, good)
      const out = await door.go(good)
      expect(out, 'it was accepted').not.toBeNull()
      expect(out?.text).toContain(TEST_REQUIRED)
      if (out?.code) {
        expect(out.code).toBe('schedule_invalid')
        expect(out.field).toBe('test_required')
      }
      expect(box.callsOf('validate')).toEqual([])
      expect(h.bridge.ctx.ledger.list('pending').filter((c) => c.binding.kind === 'schedule')).toEqual([])
    })
    test(`${door.name}: a fresh pass for the same settings lets it through to Chronos and a card is made`, async () => {
      const box = await begin(door, good)
      pass(good)
      const out = await door.go(good)
      expect(out, out?.text).toBeNull()
      expect(box.callsOf('validate').length + (door.name === 'an adopt' ? 1 : 0)).toBeGreaterThan(0)
    })
    test(`${door.name}: a pass for DIFFERENT settings is no pass`, async () => {
      await begin(door, good)
      pass({ ...good, mode: 'live' })
      pass({ ...good, wake_cap_per_day: 2 })
      const out = await door.go(good)
      expect(out?.text).toContain(TEST_REQUIRED)
    })
    test(`${door.name}: a pass older than 24 hours is no pass, one at exactly 24 hours still is, one from the future is not`, async () => {
      await begin(door, good)
      pass(good, HEARTBEAT_TEST_VALID_MS + 1)
      expect((await door.go(good))?.text).toContain(TEST_REQUIRED)
      pass(good, -10 * 60_000) // the clock was set back: a pass stamped ahead of now
      expect((await door.go(good))?.text).toContain(TEST_REQUIRED)
      pass(good, HEARTBEAT_TEST_VALID_MS)
      expect(await door.go(good), 'exactly 24 h old').toBeNull()
    })
  }
})

describe('test_required: what needs no test', () => {
  test('a heartbeat saved OFF needs none (how setup works): agent create and owner create', async () => {
    const box = ReplayBox.times()
    validOk(box)
    h = await start(box)
    expect(await viaTool(propose({ enabled: false }))).toBeNull()
    expect(await viaFrame({ op: 'create', draft: draft({ enabled: false, id: 'off-beat' }) })).toBeNull()
  })

  test('turning an enabled heartbeat OFF never needs one, however old the last pass is (or if there never was one)', async () => {
    const box = ReplayBox.times()
    validOk(box)
    onDisk(box)
    h = await start(box)
    expect(
      await viaTool({ op: 'update', id: 'check-in', thread_id: 'general', reason: 'x', enabled: false }),
    ).toBeNull()
    expect(await viaFrame({ op: 'update', id: 'check-in', base_etag: ONDISK_ETAG, set: { enabled: false } })).toBeNull()
  })

  test('an update that leaves an already-ON heartbeat with the same settings (a rename, a thread move) or changes only its mutes needs none', async () => {
    const box = ReplayBox.times()
    validOk(box)
    onDisk(box)
    h = await start(box)
    expect(
      await viaTool({ op: 'update', id: 'check-in', thread_id: 'general', reason: 'x', name: 'Renamed' }),
    ).toBeNull()
    const muted = { ...good, mutes: [{ source: 'gh-main', key: 'pr:1', until: '2099-01-01T00:00:00.000Z' }] }
    expect(
      await viaTool({ op: 'update', id: 'check-in', thread_id: 'general', reason: 'x', meta: META(muted) }),
    ).toBeNull()
  })

  test('but any other change to the settings of an ON heartbeat (wake cap, mode, a source) does need a fresh pass', async () => {
    const box = ReplayBox.times()
    validOk(box)
    onDisk(box)
    h = await start(box)
    for (const next of [
      { ...good, wake_cap_per_day: 2 },
      { ...good, mode: 'live' },
      { ...good, sources: [{ ...gh, timeout_s: 20 }] },
    ]) {
      const out = await viaTool({ op: 'update', id: 'check-in', thread_id: 'general', reason: 'x', meta: META(next) })
      expect(out?.text, JSON.stringify(next)).toContain(TEST_REQUIRED)
      pass(next)
      expect(
        await viaTool({ op: 'update', id: 'check-in', thread_id: 'general', reason: 'x', meta: META(next) }),
      ).toBeNull()
    }
  })

  test('a job that is not a heartbeat is untouched by the rule', async () => {
    const box = ReplayBox.times()
    validOk(box)
    h = await start(box)
    expect(await viaTool(propose({ meta: { other: 1 } }, undefined))).toBeNull()
  })
})

describe('test_required: the ledger fails closed, and is asked again at approval', () => {
  test('a ledger that is missing, corrupt, of another schema or full of junk is "no pass"', async () => {
    const box = ReplayBox.times()
    validOk(box)
    h = await start(box)
    const file = testsFile(h.home)
    pass(good)
    expect(await viaTool(propose())).toBeNull()
    for (const junk of [
      '',
      '{',
      '[]',
      'null',
      '{"schema":"other","passes":{}}',
      JSON.stringify({ schema: 'talos.heartbeat-tests/1', passes: { [heartbeatConfigHashOf(good)]: 'not a time' } }),
    ]) {
      writeFileSync(file, junk)
      expect((await viaTool(propose()))?.text, junk).toContain(TEST_REQUIRED)
    }
    rmSync(file)
    expect((await viaTool(propose()))?.text).toContain(TEST_REQUIRED)
  })

  test('the pass that let a card be drawn is looked at again when the card is approved: gone by then = the card fails and nothing is written', async () => {
    const box = ReplayBox.times()
    // what Chronos hands back is what the card will apply, so it carries the heartbeat the owner asked for
    const v = fixture<{ normalized: { draft: Record<string, unknown> } } & Record<string, unknown>>(
      'chronos-0.4',
      'validate-times-create',
    )
    Object.assign(v.normalized.draft, { meta: META(good), runner: 'session', enabled: true })
    box.answer('validate', { ok: true, normalized: v.normalized, preview: v.preview, expected_etag: v.expected_etag })
    h = await start(box)
    pass(good)
    const f = await h.app.patchSchedule({ op: 'create', draft: draft() }, 'general')
    const cc = await h.app.expectFrame(
      'card.create',
      (c) => (c.card.payload as { client_ref?: string } | undefined)?.client_ref === f.id,
      { direction: 'in' },
    )
    const card = cc.card as CardT
    rmSync(testsFile(h.home)) // a day passes / the file is lost: no pass stands behind the card any more
    const token = h.relay.mintStepup(`card:${card.id}`)
    await h.app.resolveCard(card, 'primary', card.payload_hash, { stepup_token: token })
    const upd = await h.app.expectFrame('card.update', (u) => u.card_id === card.id && u.state === 'failed', {
      direction: 'in',
      timeoutMs: 15_000,
    })
    expect(JSON.stringify(upd.result)).toContain(TEST_REQUIRED)
    expect(box.callsOf('apply')).toEqual([])
  })

  test('control: with the pass still standing, the same approved card does reach Chronos (so the test above can fail)', async () => {
    const box = ReplayBox.times()
    const v = fixture<{ normalized: { draft: Record<string, unknown> } } & Record<string, unknown>>(
      'chronos-0.4',
      'validate-times-create',
    )
    Object.assign(v.normalized.draft, { meta: META(good), runner: 'session', enabled: true })
    box.answer('validate', { ok: true, normalized: v.normalized, preview: v.preview, expected_etag: v.expected_etag })
    h = await start(box)
    pass(good)
    const f = await h.app.patchSchedule({ op: 'create', draft: draft() }, 'general')
    const cc = await h.app.expectFrame(
      'card.create',
      (c) => (c.card.payload as { client_ref?: string } | undefined)?.client_ref === f.id,
      { direction: 'in' },
    )
    const card = cc.card as CardT
    await h.app.resolveCard(card, 'primary', card.payload_hash, { stepup_token: h.relay.mintStepup(`card:${card.id}`) })
    await waitFor(() => box.callsOf('apply').length > 0, 15_000, 'the apply to reach Chronos')
  })

  test('the whole chain through the real door: the app tests, the bridge remembers, and only then does Turn on reach Chronos', async () => {
    const box = ReplayBox.times()
    validOk(box)
    const dir = mkdtempSync(join(tmpdir(), 'hb-chain-'))
    const src = join(dir, 's.sh')
    writeFileSync(
      src,
      `#!/bin/sh\ncat >/dev/null\nprintf '%s' '{"schema":"talos.heartbeat-source/1","status":"ok","cursor":null,"items":[]}'\n`,
      { mode: 0o755 },
    )
    h = await start(box)
    const cfg = {
      ...good,
      sources: [{ id: 'news', kind: 'command', enabled: true, args: { argv: ['/bin/sh', src] }, timeout_s: 5 }],
    }
    expect((await viaTool(propose({}, cfg)))?.text).toContain(TEST_REQUIRED)
    const t = await h.app.testHeartbeat(cfg)
    await h.app.expectFrame(
      'heartbeat.test_result',
      (x) => x.request_id === (t as unknown as { request_id: string }).request_id,
      { direction: 'in', timeoutMs: 20_000 },
    )
    expect(existsSync(testsFile(h.home))).toBe(true)
    expect(await viaTool(propose({}, cfg))).toBeNull()
    // and a test of other settings did not unlock this one
    expect((await viaTool(propose({}, { ...cfg, wake_cap_per_day: 1 })))?.text).toContain(TEST_REQUIRED)
    await waitFor(() => readFileSync(testsFile(h.home), 'utf8').length > 0, 1000, 'ledger')
  })
})

describe('HB5b review R1-1: an unreadable schedule never lets a change through', () => {
  const READ_FAIL = "Couldn't read the current schedule; try again"
  test('a Turn-on card approved while Chronos cannot be read is refused, and nothing is written', async () => {
    const box = ReplayBox.times()
    // what Chronos hands back is what the card applies: an update that turns the job on
    const v = fixture<Record<string, unknown>>('chronos-0.4', 'validate-times-create')
    box.answer('validate', {
      ok: true,
      normalized: { op: 'update', id: 'check-in', base_etag: ONDISK_ETAG, set: { enabled: true } },
      preview: v.preview,
      expected_etag: v.expected_etag,
    })
    onDisk(box, { enabled: false })
    let broken = false
    const home = mkdtempSync(join(tmpdir(), 'hb-req-'))
    writeFileSync(join(home, 'schedules-meta.json'), JSON.stringify({ jobs: { 'check-in': { thread_id: 'inbox' } } }))
    h = await startSched({
      box,
      relay: V2,
      now: box.now,
      home,
      wrapAdapter: (a) =>
        new Proxy(a, {
          get(t, p) {
            if (p === 'detail')
              return async (...args: unknown[]) => {
                if (broken) throw new Error('chronos did not answer')
                return (t as never as { detail: (...a: unknown[]) => unknown }).detail(...args)
              }
            const v = (t as unknown as Record<string | symbol, unknown>)[p]
            return typeof v === 'function' ? v.bind(t) : v
          },
        }),
    })
    pass(good)
    const f = await h.app.patchSchedule(
      { op: 'update', id: 'check-in', base_etag: ONDISK_ETAG, set: { enabled: true } },
      'general',
    )
    const cc = await h.app.expectFrame(
      'card.create',
      (c) => (c.card.payload as { client_ref?: string } | undefined)?.client_ref === f.id,
      { direction: 'in' },
    )
    const card = cc.card as CardT
    broken = true
    await h.app.resolveCard(card, 'primary', card.payload_hash, { stepup_token: h.relay.mintStepup(`card:${card.id}`) })
    const upd = await h.app.expectFrame('card.update', (u) => u.card_id === card.id && u.state === 'failed', {
      direction: 'in',
      timeoutMs: 15_000,
    })
    expect(JSON.stringify(upd.result)).toContain(READ_FAIL)
    expect(box.callsOf('apply')).toEqual([])
  })

  test('with no base to look at, an update without meta and an adopt are refused; a pure switch-off is not; a create does not need one', () => {
    const home = mkdtempSync(join(tmpdir(), 'hb-req-'))
    const update = { op: 'update', id: 'x', base_etag: 'e', set: { name: 'Renamed' } } as never
    const adopt = { op: 'adopt', id: 'x', content_hash: 'h' } as never
    expect(testRequiredProblem(home, Date.now(), update, null)).toContain(READ_FAIL)
    expect(testRequiredProblem(home, Date.now(), adopt, null)).toContain(READ_FAIL)
    expect(
      testRequiredProblem(
        home,
        Date.now(),
        { op: 'update', id: 'x', base_etag: 'e', set: { enabled: false } } as never,
        null,
      ),
    ).toBeNull()
    expect(testRequiredProblem(home, Date.now(), { op: 'delete', id: 'x', base_etag: 'e' } as never, null)).toBeNull()
  })
})

describe('HB5b review R1-5: settings on disk that no longer parse strictly', () => {
  test('a fresh pass for the NEW settings lets an update through; without one it asks for a test (not "could not be read")', async () => {
    const box = ReplayBox.times()
    validOk(box)
    onDisk(box, { enabled: true }, { ...good, future_key: 1 }) // the strict parse of what is on disk fails
    h = await start(box)
    const next = { ...good, wake_cap_per_day: 2 }
    const out = await viaTool({ op: 'update', id: 'check-in', thread_id: 'general', reason: 'x', meta: META(next) })
    expect(out?.text).toContain(TEST_REQUIRED)
    expect(out?.text).not.toContain('could not be read')
    pass(next)
    expect(
      await viaTool({ op: 'update', id: 'check-in', thread_id: 'general', reason: 'x', meta: META(next) }),
    ).toBeNull()
  })
})
