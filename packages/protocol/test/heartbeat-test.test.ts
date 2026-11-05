// The Heartbeat test frames and the reader for their result (HB5). The golden frames in fixtures/frames/ go through the real
// parser; older, newer and hostile results go through the real reader.
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import {
  configHash,
  DIRECTION_TYPES,
  HEARTBEAT_TEST_VALID_MS,
  HeartbeatConfig,
  type HeartbeatConfigT,
  heartbeatTestPassed,
  OWNER_FRAME_TYPES,
  parseFrame,
  parseHeartbeatTestResult,
} from '../src/index.ts'

const fixture = (n: string) =>
  JSON.parse(readFileSync(new URL(`../fixtures/frames/${n}.json`, import.meta.url), 'utf8'))
const NOW = Date.parse('2026-10-28T15:40:00.000Z')

const config = (over: Record<string, unknown> = {}): HeartbeatConfigT =>
  HeartbeatConfig.parse({
    schema: 'talos.heartbeat/1',
    mode: 'shadow',
    sources: [
      {
        id: 'github',
        kind: 'github',
        enabled: true,
        class: 'own',
        args: { repos: ['example-org/example-repo'] },
        timeout_s: 30,
      },
      { id: 'inbox', kind: 'inbox', enabled: true, args: {}, timeout_s: 30 },
      { id: 'disk', kind: 'command', enabled: false, args: { argv: ['/usr/bin/true'] }, timeout_s: 30 },
    ],
    mutes: [],
    wake_cap_per_day: 3,
    run_timeout_s: 120,
    ...over,
  })
const row = (id: string, o: Record<string, unknown> = {}) => ({
  id,
  ok: true,
  ms: 900,
  read: 3,
  act: 0,
  fyi: 1,
  dropped: 2,
  held: 0,
  unreadable: 0,
  ...o,
})
const result = (c: HeartbeatConfigT, o: Record<string, unknown> = {}) => ({
  config_hash: configHash(c),
  at: '2026-10-28T15:32:10.120Z',
  window_h: 24,
  sources: [row('github'), row('inbox')],
  ...o,
})
const read = (r: unknown) => {
  const p = parseHeartbeatTestResult(r)
  if (!p.ok) throw new Error(p.problem)
  return p.result
}

describe('heartbeat.test and heartbeat.test_result frames', () => {
  it('the golden frames parse, and sit on the right lists', () => {
    expect(parseFrame(fixture('heartbeat.test')).ok).toBe(true)
    expect(parseFrame(fixture('heartbeat.test_result')).ok).toBe(true)
    expect(OWNER_FRAME_TYPES).toContain('heartbeat.test')
    expect(DIRECTION_TYPES.app_to_relay).toContain('heartbeat.test')
    expect(DIRECTION_TYPES.relay_to_bridge).toContain('heartbeat.test')
    expect(DIRECTION_TYPES.bridge_to_relay).toContain('heartbeat.test_result')
    expect(DIRECTION_TYPES.relay_to_app).toContain('heartbeat.test_result')
  })

  it('a config key or source kind from a newer app does not kill the frame (work.enabled lesson)', () => {
    const f = fixture('heartbeat.test')
    const newer = {
      ...f,
      config: { ...f.config, future_key: { x: 1 }, sources: [...f.config.sources, { id: 'cal', kind: 'calendar-v9' }] },
    }
    expect(parseFrame(newer).ok).toBe(true)
  })

  it('any window up to a week is carried; nonsense is refused', () => {
    const f = fixture('heartbeat.test')
    expect(parseFrame({ ...f, window_h: 6 }).ok).toBe(true)
    expect(parseFrame({ ...f, window_h: 0 }).ok).toBe(false)
    expect(parseFrame({ ...f, window_h: 100000 }).ok).toBe(false)
    expect(parseFrame({ ...f, window_h: 'x' }).ok).toBe(false)
  })

  it('an unsigned heartbeat.test is refused (it is an owner frame)', () => {
    const { osig: _o, ...unsigned } = fixture('heartbeat.test')
    expect(parseFrame(unsigned).ok).toBe(false)
  })

  it('a runaway config is refused', () => {
    const f = fixture('heartbeat.test')
    expect(parseFrame({ ...f, config: { ...f.config, junk: 'x'.repeat(9000) } }).ok).toBe(false)
  })

  it('a result frame with unknown keys still parses', () => {
    const f = fixture('heartbeat.test_result')
    expect(parseFrame({ ...f, from_the_future: 1, result: { ...f.result, new_thing: [1] } }).ok).toBe(true)
  })
})

describe('parseHeartbeatTestResult', () => {
  it('reads the golden result', () => {
    const r = read(fixture('heartbeat.test_result').result)
    expect(r.sources[0]).toMatchObject({ id: 'github', ok: true, unreadable: 0 })
    expect(r.would_wake[0]?.why).toBe('github.review')
    expect(r.est_tokens).toBe(180000)
  })

  it('an old result (only the required keys) reads, with the rest empty', () => {
    const c = config()
    const r = read({
      config_hash: configHash(c),
      at: '2026-10-28T15:32:10Z',
      window_h: 8,
      sources: [{ id: 'github', ok: true, ms: 5 }],
    })
    expect(r.would_wake).toEqual([])
    expect(r.held).toBe(0)
    expect(r.est_wakes).toBeNull()
  })

  it('one unreadable source row costs that row and blocks a pass, not the whole result', () => {
    const c = config()
    const r = read(result(c, { sources: [row('github'), { id: 'inbox', ok: 'maybe' }, 'junk', row('inbox')] }))
    expect(r.sources.map((s) => s.id)).toEqual(['github', 'inbox'])
    expect(r.unreadable_rows).toBe(2)
    expect(heartbeatTestPassed(r, c, NOW)).toBe(false)
  })

  it('a source row named twice is counted, so a second row cannot overwrite the first', () => {
    const c = config()
    const r = read(result(c, { sources: [row('github', { ok: false, error: 'boom' }), row('github'), row('inbox')] }))
    expect(r.unreadable_rows).toBe(1)
    expect(heartbeatTestPassed(r, c, NOW)).toBe(false)
  })

  it('refuses a result with no hash, no time or no list, in plain words, without throwing', () => {
    for (const bad of [
      null,
      [],
      'x',
      {},
      { config_hash: 'nope', at: 'x', window_h: 1, sources: [] },
      result(config(), { sources: 'x' }),
    ]) {
      const p = parseHeartbeatTestResult(bad)
      expect(p.ok).toBe(false)
    }
  })

  it('hostile text from a source is escaped, and a failed source with no reason still says it failed', () => {
    const c = config()
    const r = read(
      result(c, { sources: [row('github', { ok: false, error: 'bad ‮evil\u0007' }), row('inbox', { ok: false })] }),
    )
    expect(r.sources[0]?.error).toBe('bad ⟦U+202E⟧evil⟦U+0007⟧')
    expect(r.sources[1]?.error).toBe('no reason was given')
  })

  it('text the Mac already escaped is not escaped twice', () => {
    const c = config()
    const r = read(result(c, { sources: [row('github', { ok: false, error: 'bad ⟦U+202E⟧evil' }), row('inbox')] }))
    expect(r.sources[0]?.error).toBe('bad ⟦U+202E⟧evil')
  })

  it('caps long text and long lists', () => {
    const c = config()
    const many = Array.from({ length: 80 }, (_, i) => ({ source: 'github', title: `t${i}`, why: 'w' }))
    const r = read(result(c, { would_wake: many, would_post: [{ source: 'inbox', title: 'x'.repeat(500), why: '' }] }))
    expect(r.would_wake).toHaveLength(50)
    expect([...(r.would_post[0]?.title ?? '')].length).toBeLessThanOrEqual(121)
  })
})

describe('heartbeatTestPassed', () => {
  const c = config()
  const ok = () => read(result(c))

  it('passes when every enabled source is ok; a disabled source is not asked', () => {
    expect(heartbeatTestPassed(ok(), c, NOW)).toBe(true)
  })

  it('zero items is a pass', () => {
    const r = read(
      result(c, {
        sources: [row('github', { read: 0, fyi: 0, dropped: 0 }), row('inbox', { read: 0, fyi: 0, dropped: 0 })],
      }),
    )
    expect(heartbeatTestPassed(r, c, NOW)).toBe(true)
  })

  it('a failed source fails it', () => {
    const r = read(result(c, { sources: [row('github'), row('inbox', { ok: false, error: 'gh not signed in' })] }))
    expect(heartbeatTestPassed(r, c, NOW)).toBe(false)
  })

  it('unreadable items fail it', () => {
    const r = read(result(c, { sources: [row('github', { unreadable: 1 }), row('inbox')] }))
    expect(heartbeatTestPassed(r, c, NOW)).toBe(false)
  })

  it('a source the result does not mention fails it', () => {
    const r = read(result(c, { sources: [row('github')] }))
    expect(heartbeatTestPassed(r, c, NOW)).toBe(false)
  })

  it('a result for another config (any change, even a mute) fails it', () => {
    const changed = config({ wake_cap_per_day: 4 })
    expect(heartbeatTestPassed(ok(), changed, NOW)).toBe(false)
  })

  it('a pass goes stale after 24 hours, and a result from the future is not trusted', () => {
    const r = ok()
    expect(heartbeatTestPassed(r, c, Date.parse(r.at) + HEARTBEAT_TEST_VALID_MS + 1)).toBe(false)
    expect(heartbeatTestPassed(r, c, Date.parse(r.at) - 3600_000)).toBe(false)
  })

  it('a config with every source off cannot pass', () => {
    const off = config({
      sources: [{ id: 'inbox', kind: 'inbox', enabled: false, args: {}, timeout_s: 30 }],
    })
    const r = read({ config_hash: configHash(off), at: '2026-10-28T15:32:10Z', window_h: 24, sources: [] })
    expect(heartbeatTestPassed(r, off, NOW)).toBe(false)
  })
})

describe('the committed result fixtures (packages/testkit/fixtures/heartbeat-frames)', () => {
  const dir = '../../testkit/fixtures/heartbeat-frames/'
  const load = (n: string) => JSON.parse(readFileSync(new URL(dir + n, import.meta.url), 'utf8'))
  const fixtureConfig = () => HeartbeatConfig.parse(load('config.json').config)

  it('config.json hashes to the hash the results carry', () => {
    expect(configHash(fixtureConfig())).toBe(load('config.json').config_hash)
  })

  it.each([
    ['01-test-pass.json', true],
    ['02-test-zero-items.json', true],
    ['03-test-failed-source.json', false],
    ['04-test-unreadable-items.json', false],
    ['05-test-old-minimal.json', true],
    ['06-test-newer-unknown-values.json', false],
  ])('%s passes: %s', (name, passes) => {
    const p = parseHeartbeatTestResult(load(name).result)
    expect(p.ok).toBe(true)
    if (!p.ok) return
    expect(heartbeatTestPassed(p.result, fixtureConfig(), Date.parse('2026-10-28T16:00:00Z'))).toBe(passes)
  })

  it('06 (a newer Mac) costs only its unreadable row, not the result', () => {
    const p = parseHeartbeatTestResult(load('06-test-newer-unknown-values.json').result)
    if (!p.ok) throw new Error(p.problem)
    expect(p.result.unreadable_rows).toBe(1)
    expect(p.result.sources.map((s) => s.id)).toEqual(['github', 'inbox', 'calendar-v9'])
    expect(p.result.est_tokens).toBeNull()
  })
})

describe('HB5b review: mode, "if live" and a broken run', () => {
  const pass = () => {
    const raw = JSON.parse(
      readFileSync(new URL('../../testkit/fixtures/heartbeat-frames/01-test-pass.json', import.meta.url), 'utf8'),
    ).result
    return { ...raw, config_hash: configHash(config()), at: new Date(NOW).toISOString() }
  }
  it('reads mode, the "if live" lines and an error; unknown values degrade to null, never refuse the frame', () => {
    const r = parseHeartbeatTestResult({
      ...pass(),
      mode: 'shadow',
      error: 'The test could not finish.',
      if_live: {
        would_wake: [{ source: 'github', title: 'T', why: 'w' }],
        would_post: [],
        est_wakes: 1,
        est_tokens: 180000,
      },
    })
    expect(r.ok && r.result.mode).toBe('shadow')
    expect(r.ok && r.result.error).toBe('The test could not finish.')
    expect(r.ok && r.result.if_live?.would_wake).toHaveLength(1)
    const odd = parseHeartbeatTestResult({ ...pass(), mode: 'sideways', if_live: 7, error: 5 })
    expect(odd.ok && [odd.result.mode, odd.result.if_live, odd.result.error]).toEqual([null, null, null])
  })
  it('a result that says it broke is never a pass, even when every source row is ok', () => {
    const r = parseHeartbeatTestResult({ ...pass(), error: 'The test could not finish.' })
    expect(r.ok && heartbeatTestPassed(r.result, config(), NOW)).toBe(false)
    const clean = parseHeartbeatTestResult(pass())
    expect(clean.ok && heartbeatTestPassed(clean.result, config(), NOW)).toBe(true)
  })
})
