// D47: the live bridge writes $TALOS_APP_HOME/status.json (DESKTOP-SPEC 6.2), the menu bar reads it. A real Bridge on a
// FakeRelay; the traps are the ones the spec names: a headless process overwriting the live file, a dead bridge leaving a
// fresh-looking file, an old bridge stamping over a newer one, a torn read.
import { afterEach, describe, expect, test } from 'bun:test'
import { readFileSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { Bridge } from '../src/bridge.ts'
import { loadEnv } from '../src/config.ts'
import { nullLogger } from '../src/log.ts'
import {
  bridgeLiveness,
  parseStatusFile,
  readStatusFile,
  STATUS_KEYS,
  STATUS_RELAY_KEYS,
  StatusWriter,
} from '../src/status-file.ts'
import { type Harness, sleep, startHarness, tempHome, waitFor } from './helpers.ts'

let h: Harness | undefined
afterEach(async () => {
  await h?.stop()
  h = undefined
})

const statusPath = (home: string) => join(home, 'status.json')
const raw = (home: string) => JSON.parse(readFileSync(statusPath(home), 'utf8')) as Record<string, unknown>

describe('status.json written by a real live bridge', () => {
  test('appears as soon as the bridge starts, pins its keys, is 0600 and carries no content', async () => {
    h = await startHarness({ startBridge: false })
    h.bridge.start()
    // start() writes before it returns, before the socket has even connected: "not connected yet" is itself a fact the
    // menu bar needs. Reading it on the very next line is the "at once" check; no clock is involved.
    expect(readStatusFile(statusPath(h.home))?.relay.connected).toBe(false)
    await h.relay.expectFrame('ready', () => true, { direction: 'to_bridge' })
    await waitFor(() => readStatusFile(statusPath(h?.home ?? ''))?.relay.connected === true, 3000, 'connected')
    const s = raw(h.home)
    // the contract the Swift reader and `status --json` depend on: exactly these keys, nothing else
    expect(Object.keys(s).sort()).toEqual([...STATUS_KEYS].sort())
    expect(Object.keys(s.relay as object).sort()).toEqual([...STATUS_RELAY_KEYS].sort())
    expect(s.v).toBe(1)
    expect(s.pid).toBe(process.pid)
    expect(s.mode).toBe('live')
    expect(typeof s.instance).toBe('string')
    expect(typeof s.queue_depth).toBe('number')
    expect(typeof s.permission_relay).toBe('boolean')
    expect(Number.isNaN(Date.parse(String(s.updated_at)))).toBe(false)
    expect(Number.isNaN(Date.parse(String(s.started_at)))).toBe(false)
    expect((statSync(statusPath(h.home)).mode & 0o777).toString(8)).toBe('600')
    // content-free: nothing from the relay, the key or the config leaks into it
    const text = readFileSync(statusPath(h.home), 'utf8')
    expect(text).not.toContain(h.relay.bridgeKey.publicKeyB64)
    expect(text).not.toContain(h.relay.httpUrl)
    expect(text).not.toContain('General')
  })

  test('relay.connected flips to false when the socket drops, with the close code, and back to true on reconnect', async () => {
    h = await startHarness({ bridge: { random: () => 0 } })
    const home = h.home
    await waitFor(() => readStatusFile(statusPath(home))?.relay.connected === true, 3000, 'connected')
    expect(readStatusFile(statusPath(home))?.relay.last_connect_at).toBeTruthy()
    h.relay.dropBridge()
    await waitFor(() => readStatusFile(statusPath(home))?.relay.connected === false, 3000, 'connected to flip to false')
    expect(typeof readStatusFile(statusPath(home))?.relay.last_close_code).toBe('number')
    await waitFor(() => readStatusFile(statusPath(home))?.relay.connected === true, 8000, 'connected again')
  })

  test('4409: one last superseded snapshot, then the old bridge never writes again', async () => {
    h = await startHarness({ bridge: { random: () => 0 } })
    const home = h.home
    await waitFor(() => readStatusFile(statusPath(home))?.relay.connected === true, 3000, 'connected')
    h.relay.kickBridge(4409)
    await waitFor(() => readStatusFile(statusPath(home))?.mode === 'superseded', 3000, 'superseded')
    expect(readStatusFile(statusPath(home))?.relay.last_close_code).toBe(4409)
    const frozen = readFileSync(statusPath(home), 'utf8')
    await sleep(400)
    expect(readFileSync(statusPath(home), 'utf8')).toBe(frozen)
  })

  test('a headless process on the same home (talos-app post) never overwrites the live bridge file', async () => {
    h = await startHarness()
    const home = h.home
    await waitFor(() => readStatusFile(statusPath(home))?.relay.connected === true, 3000, 'connected')
    const before = readFileSync(statusPath(home), 'utf8')
    const env = loadEnv({
      TALOS_APP_HOME: home,
      TALOS_APP_RELAY_URL: h.relay.httpUrl,
    })
    const headless = await Bridge.create({ env, headless: true, logger: nullLogger })
    try {
      expect(headless.live).toBe(false)
      await headless.callTool('reply', { thread_id: 'general', text: 'from a job' })
      headless.start() // a no-op without a socket
      await headless.poll()
      await sleep(250)
    } finally {
      await headless.stop()
    }
    expect(readFileSync(statusPath(home), 'utf8')).toBe(before)
  })

  test('a headless process alone, with no live bridge started, creates no status.json at all', async () => {
    h = await startHarness({ startBridge: false })
    const home = h.home
    const env = loadEnv({
      TALOS_APP_HOME: home,
      TALOS_APP_RELAY_URL: h.relay.httpUrl,
    })
    const headless = await Bridge.create({ env, headless: true, logger: nullLogger })
    await headless.callTool('list_threads', {})
    await headless.stop()
    expect(readStatusFile(statusPath(home))).toBeUndefined()
  })

  test('stop() leaves the last snapshot but no timer keeps writing', async () => {
    h = await startHarness()
    const home = h.home
    await waitFor(() => readStatusFile(statusPath(home))?.relay.connected === true, 3000, 'connected')
    await h.bridge.stop()
    const frozen = readFileSync(statusPath(home), 'utf8')
    await sleep(300)
    expect(readFileSync(statusPath(home), 'utf8')).toBe(frozen)
  })
})

describe('StatusWriter ownership and heartbeat', () => {
  const clockAt = (t: { ms: number }) => ({
    now: () => t.ms,
    setTimeout: (fn: () => void, ms: number) => {
      timers.push({ at: t.ms + ms, fn })
      return timers.length
    },
    clearTimeout: () => {},
  })
  const timers: Array<{ at: number; fn: () => void }> = []
  const snap = () => ({
    mode: 'live' as const,
    relay: { connected: true, last_connect_at: null, last_close_code: null },
    queue_depth: 0,
    permission_relay: false,
    permission_relay_declared: false,
  })

  test('heartbeat: the file is rewritten every 15 s so a frozen bridge goes stale', () => {
    const home = tempHome()
    const t = { ms: Date.parse('2026-11-01T10:00:00Z') }
    timers.length = 0
    const w = new StatusWriter({
      path: statusPath(home),
      clock: clockAt(t),
      log: nullLogger,
      instance: 'a',
      snapshot: snap,
    })
    w.start()
    expect(readStatusFile(statusPath(home))?.updated_at).toBe('2026-11-01T10:00:00.000Z')
    t.ms += 15_000
    timers[0]?.fn()
    expect(readStatusFile(statusPath(home))?.updated_at).toBe('2026-11-01T10:00:15.000Z')
    w.stop()
  })

  test('an older bridge going superseded does not stamp over a newer live bridge that is running', () => {
    const home = tempHome()
    const t = { ms: Date.parse('2026-11-01T10:00:00Z') }
    const old = new StatusWriter({
      path: statusPath(home),
      clock: clockAt(t),
      log: nullLogger,
      instance: 'old',
      snapshot: snap,
    })
    old.start()
    t.ms += 2000
    const fresh = new StatusWriter({
      path: statusPath(home),
      clock: clockAt(t),
      log: nullLogger,
      instance: 'new',
      snapshot: snap,
    })
    fresh.start()
    expect(readStatusFile(statusPath(home))?.instance).toBe('new')
    t.ms += 1000
    old.supersede() // the old one hears 4409 after the new one wrote
    const s = readStatusFile(statusPath(home))
    expect(s?.instance).toBe('new')
    expect(s?.mode).toBe('live')
    fresh.stop()
  })

  test('...but a newer bridge file whose pid is dead does not block the old one or a restart', () => {
    const home = tempHome()
    const t = { ms: Date.parse('2026-11-01T10:00:00Z') }
    const dead = new StatusWriter({
      path: statusPath(home),
      clock: clockAt(t),
      log: nullLogger,
      instance: 'gone',
      snapshot: snap,
      pid: 999_999,
    })
    t.ms += 5000
    dead.start()
    t.ms -= 5000 // the clock went backwards: our started_at is older than the dead file's
    const w = new StatusWriter({
      path: statusPath(home),
      clock: clockAt(t),
      log: nullLogger,
      instance: 'now',
      snapshot: snap,
      alive: (pid) => pid !== 999_999,
    })
    w.start()
    expect(readStatusFile(statusPath(home))?.instance).toBe('now')
  })
})

describe('reading the file', () => {
  const live = (over: Record<string, unknown> = {}) => ({
    v: 1,
    pid: 4242,
    instance: 'i',
    started_at: '2026-11-01T10:00:00.000Z',
    mode: 'live',
    relay: { connected: true, last_connect_at: null, last_close_code: null },
    queue_depth: 0,
    permission_relay: false,
    permission_relay_declared: false,
    updated_at: '2026-11-01T10:00:00.000Z',
    ...over,
  })

  test('a dead pid beats a fresh-looking file', () => {
    const home = tempHome()
    writeFileSync(statusPath(home), JSON.stringify(live()))
    const now = Date.parse('2026-11-01T10:00:05Z')
    expect(bridgeLiveness(statusPath(home), now, () => false).state).toBe('dead')
    expect(bridgeLiveness(statusPath(home), now, () => true).state).toBe('live')
  })

  test('a file older than 45 s is stale even when the pid lives; the future is not fresh either', () => {
    const home = tempHome()
    writeFileSync(statusPath(home), JSON.stringify(live()))
    expect(bridgeLiveness(statusPath(home), Date.parse('2026-11-01T10:00:46Z'), () => true).state).toBe('stale')
    expect(bridgeLiveness(statusPath(home), Date.parse('2026-11-01T09:59:00Z'), () => true).state).toBe('stale')
  })

  test('a torn or half-written file is "none", never a guess', () => {
    const home = tempHome()
    writeFileSync(statusPath(home), '{"v":1,"pid":42,"mo')
    expect(bridgeLiveness(statusPath(home), Date.now(), () => true).state).toBe('none')
    expect(
      parseStatusFile({ v: 2, pid: 1, mode: 'live', relay: { connected: true }, updated_at: new Date().toISOString() }),
    ).toBeUndefined()
  })

  test('superseded and relay-down are reported as they are', () => {
    const home = tempHome()
    writeFileSync(statusPath(home), JSON.stringify(live({ mode: 'superseded' })))
    expect(bridgeLiveness(statusPath(home), Date.parse('2026-11-01T10:00:05Z'), () => true).state).toBe('superseded')
    writeFileSync(
      statusPath(home),
      JSON.stringify(live({ relay: { connected: false, last_connect_at: null, last_close_code: 1006 } })),
    )
    const l = bridgeLiveness(statusPath(home), Date.parse('2026-11-01T10:00:05Z'), () => true)
    expect(l.state === 'live' && l.relayConnected).toBe(false)
  })
})
