// WP-V1 acceptance, bridge part (docs/V2-FEATURES.md V2.2, V2.6): the REAL bridge (live, in process) + FakeRelay, a mod
// scripted through the real talos_mod_hello / talos_mod_sync tools, a fake clock.
import { afterEach, describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { HealthBeat, type HealthBeatT } from '@talos-app/protocol'
import { fakeClock } from '@talos-app/testkit'
import { HealthMonitor, readFreeBytes } from '../src/health/monitor.ts'
import { advanceSteps, eventually, fixture, type Harness, sleep, startHarness, waitFor } from './helpers.ts'
import { helloArgs, signedSync } from './mod-sign.ts'

let h: Harness | undefined
let h2: Harness | undefined
afterEach(async () => {
  await h?.stop()
  await h2?.stop()
  h = undefined
  h2 = undefined
})

const beats = (x: Harness): Array<{ raw: Record<string, unknown>; beat: HealthBeatT }> =>
  x.relay.frames
    .filter((r) => r.direction === 'from_bridge' && r.raw.type === 'health.beat')
    .map((r) => ({ raw: r.raw, beat: HealthBeat.parse(r.raw.beat) }))
const lastBeat = (x: Harness) => beats(x).at(-1)?.beat
const keyOf = (home: string) => readFileSync(join(home, 'mod.key'), 'utf8').trim()

async function modSync(x: Harness, clockNow: () => number, seq = 1) {
  await x.bridge.callTool('talos_mod_hello', helloArgs(keyOf(x.home), clockNow()))
  const key = keyOf(x.home)
  await x.bridge.callTool('talos_mod_sync', signedSync(key, seq, { state: undefined }))
  return key
}

describe('V2.2 health.beat', () => {
  test('goes out on connect: schema-valid, no content, no path, no thread names', async () => {
    h = await startHarness({
      env: {
        TALOS_APP_TTS_CMD: JSON.stringify([fixture('fake-tts.sh'), 'file', '{out}', '{text}']),
      },
    })
    await waitFor(() => beats(h as Harness).length >= 1, 4000, 'first beat')
    const b = beats(h)[0]
    expect(b).toBeDefined()
    const text = JSON.stringify(b?.raw)
    expect(text).not.toContain(h.home)
    expect(text).not.toContain('/')
    expect(text).not.toMatch(/General|Inbox|thread/i)
    expect(Object.keys(b?.beat ?? {}).sort()).toEqual(
      ['bridge', 'disk_free_bytes', 'mod', 'sqlite', 'stt', 'tts'].sort(),
    )
    // free disk is a bare number: a whole, non-negative count of bytes, never a path (the no-'/' check above covers the text)
    expect(Number.isSafeInteger(b?.beat.disk_free_bytes)).toBe(true)
    expect(b?.beat.disk_free_bytes).toBeGreaterThan(0)
    expect(b?.beat.tts).toBe(true)
    expect(b?.beat.stt).toBe(false)
    expect(b?.beat.mod).toEqual({ state: 'absent', last_seen: null, expected: false })
    expect(typeof b?.beat.sqlite.fts5).toBe('boolean')
    expect(b?.beat.bridge.version.length).toBeGreaterThan(0)
  })

  test('hello advertises health/1', async () => {
    h = await startHarness()
    const hello = h.relay.frames.find((r) => r.direction === 'from_bridge' && r.raw.type === 'hello')
    const features = ((hello?.raw.client as { features?: string[] } | undefined)?.features ?? []) as string[]
    expect(features).toContain('health/1')
  })

  test('repeats every 60 s while nothing changes', async () => {
    const clock = fakeClock(new Date().toISOString())
    h = await startHarness({ clock })
    await waitFor(() => beats(h as Harness).length >= 1, 4000, 'first beat')
    const n = beats(h).length
    await advanceSteps(clock, 125_000, 10_000)
    await sleep(100)
    await eventually(() => expect(beats(h as Harness).length).toBeGreaterThanOrEqual(n + 2))
  })

  test('mod alive -> quiet at 31 s, sent within 2 s of the change; expected is true', async () => {
    const clock = fakeClock(new Date().toISOString())
    h = await startHarness({ clock })
    await waitFor(() => beats(h as Harness).length >= 1, 4000, 'first beat')
    await modSync(h, () => clock.now())
    await advanceSteps(clock, 3_000, 1_000)
    await waitFor(() => lastBeat(h as Harness)?.mod.state === 'alive', 4000, 'alive beat')
    expect(lastBeat(h)?.mod.expected).toBe(true)
    await advanceSteps(clock, 26_000, 5_000) // 29 s since the sync: still alive
    await sleep(50)
    await eventually(() => expect(lastBeat(h as Harness)?.mod.state).toBe('alive'))
    await advanceSteps(clock, 4_000, 1_000) // 33 s: quiet
    await waitFor(() => lastBeat(h as Harness)?.mod.state === 'quiet', 4000, 'quiet beat')
    expect(lastBeat(h)?.mod.expected).toBe(true)
    expect(lastBeat(h)?.mod.last_seen).not.toBeNull()
  })

  test('expected survives a restart: a bridge that restarts shows quiet, not absent', async () => {
    const clock = fakeClock(new Date().toISOString())
    h = await startHarness({ clock })
    await waitFor(() => beats(h as Harness).length >= 1, 4000, 'first beat')
    await modSync(h, () => clock.now())
    await advanceSteps(clock, 3_000, 1_000)
    await waitFor(() => lastBeat(h as Harness)?.mod.state === 'alive', 4000, 'alive beat')
    const home = h.home
    await h.stop()
    h = undefined
    h2 = await startHarness({ home })
    await waitFor(() => beats(h2 as Harness).length >= 1, 4000, 'beat after restart')
    expect(lastBeat(h2)?.mod.expected).toBe(true)
    expect(lastBeat(h2)?.mod.state).toBe('quiet')
  })

  test('a mod never seen is absent, and a stale kv (8 days) is not expected', async () => {
    const home = (await import('./helpers.ts')).tempHome()
    const { HistoryStore } = await import('../src/history-store.ts')
    const s = new HistoryStore(join(home, 'history.sqlite'))
    s.kvSet('mod_seen_at', new Date(Date.now() - 8 * 86_400_000).toISOString())
    s.close()
    h = await startHarness({ home })
    await waitFor(() => beats(h as Harness).length >= 1, 4000, 'first beat')
    expect(lastBeat(h)?.mod).toEqual({ state: 'absent', last_seen: null, expected: false })
  })
})

describe('D11 free disk in the beat', () => {
  const stat = (bavail: number, bsize = 4096) =>
    (() => ({ bavail, bsize })) as unknown as typeof import('node:fs').statfsSync

  test('readFreeBytes is available blocks times block size, a number only; unreadable or nonsense is null, never a guess', () => {
    expect(readFreeBytes('/anywhere', stat(1000, 4096))).toBe(4_096_000)
    expect(readFreeBytes('/anywhere', stat(0))).toBe(0)
    expect(
      readFreeBytes('/anywhere', (() => {
        throw new Error('ENOENT: /secret/path')
      }) as never),
    ).toBeNull()
    expect(readFreeBytes('/anywhere', stat(Number.NaN))).toBeNull()
    expect(readFreeBytes('/anywhere', stat(-5))).toBeNull()
    expect(readFreeBytes('/anywhere', stat(Number.MAX_SAFE_INTEGER))).toBeNull()
  })

  const monitor = (free: () => number | null) => {
    const ctx = {
      clock: { now: () => Date.now(), setTimeout: () => 0, clearTimeout: () => {} },
      paths: { home: '/nowhere' },
      env: {},
      mod: { live: false },
      store: { kvGet: () => null, kvSet: () => {}, db: {} },
      search: { available: true },
    }
    return new HealthMonitor(ctx as never, { connected: () => true, freeBytes: free })
  }

  test('the beat carries the number when readable and omits the field (not 0) when not', () => {
    expect(monitor(() => 123_456_789).build().disk_free_bytes).toBe(123_456_789)
    const none = monitor(() => null).build()
    expect('disk_free_bytes' in none).toBe(false)
    expect(HealthBeat.safeParse(none).success).toBe(true)
  })

  test('the exact number does not make a "change" (no beat per second), crossing the low line does', () => {
    const m = monitor(() => 0) as unknown as { keyOf(b: unknown): string }
    const GB = 1024 ** 3
    // Each monitor stamps its own start time; pin it so two monitors built a millisecond apart still compare equal.
    const started = monitor(() => 0).build().bridge
    const beat = (free: number) => ({ ...monitor(() => free).build(), bridge: started, disk_free_bytes: free })
    expect(m.keyOf(beat(50 * GB))).toBe(m.keyOf(beat(49 * GB)))
    expect(m.keyOf(beat(50 * GB))).not.toBe(m.keyOf(beat(1 * GB)))
    expect(m.keyOf(beat(1 * GB))).toBe(m.keyOf(beat(1.5 * GB)))
  })
})
