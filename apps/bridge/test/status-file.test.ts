// D47: the live bridge writes $TALOS_APP_HOME/status.json (DESKTOP-SPEC 6.2), the menu bar reads it. A real Bridge on a
// FakeRelay; the traps are the ones the spec names: a headless process overwriting the live file, a dead bridge leaving a
// fresh-looking file, an old bridge stamping over a newer one, a torn read.
import { afterEach, describe, expect, setDefaultTimeout, test } from 'bun:test'
import { mkdirSync, readFileSync, realpathSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { t } from '@talos-app/testkit'
import { Bridge } from '../src/bridge.ts'
import { loadEnv } from '../src/config.ts'
import { nullLogger } from '../src/log.ts'
import {
  bridgeLiveness,
  GOVERNOR_STATES,
  parseStatusFile,
  readStatusFile,
  STATUS_KEYS,
  STATUS_RELAY_KEYS,
  StatusWriter,
  validAppPath,
} from '../src/status-file.ts'
import { HARNESS_START_MS, type Harness, sleep, startHarness, tempHome, waitFor } from './helpers.ts'

// the harness start and the waits for the file add up past bun's 5 s default
setDefaultTimeout(t(30_000))

let h: Harness | undefined
afterEach(async () => {
  await h?.stop()
  h = undefined
})

const statusPath = (home: string) => join(home, 'status.json')
const raw = (home: string) => JSON.parse(readFileSync(statusPath(home), 'utf8')) as Record<string, unknown>

describe('status.json written by a real live bridge', () => {
  test(
    'appears as soon as the bridge starts, pins its keys, is 0600 and carries no content',
    async () => {
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
      // the governor now, for the Linux supervisor's restart-on-update queue (the harness has no usage limits: ok or off)
      expect(['ok', 'off', 'unknown']).toContain(String(s.governor))
      expect(Number.isNaN(Date.parse(String(s.updated_at)))).toBe(false)
      expect(Number.isNaN(Date.parse(String(s.started_at)))).toBe(false)
      expect((statSync(statusPath(h.home)).mode & 0o777).toString(8)).toBe('600')
      // content-free: nothing from the relay, the key or the config leaks into it
      const text = readFileSync(statusPath(h.home), 'utf8')
      expect(text).not.toContain(h.relay.bridgeKey.publicKeyB64)
      expect(text).not.toContain(h.relay.httpUrl)
      expect(text).not.toContain('General')
    },
    HARNESS_START_MS + t(30_000),
  )

  test(
    'unseen_oldest_at: null with nothing pending, the time of the oldest untouched owner message, null again once it is read',
    async () => {
      h = await startHarness()
      const home = h.home
      await waitFor(() => readStatusFile(statusPath(home))?.relay.connected === true, 3000, 'connected')
      expect(raw(home).unseen_oldest_at).toBeNull()
      const before = Date.now()
      await h.app.sendMessage('general', 'first')
      await h.waitNotes(1)
      await waitFor(() => readStatusFile(statusPath(home))?.unseen_oldest_at != null, 3000, 'the unseen time')
      const first = String(raw(home).unseen_oldest_at)
      expect(Date.parse(first)).toBeGreaterThanOrEqual(before - 1000)
      // later messages, in the same thread or another, keep the OLDEST time: the age a supervisor measures is the first one's
      await h.app.sendMessage('general', 'second')
      await h.app.sendMessage('inbox', 'third')
      await h.waitNotes(3)
      await sleep(t(150)) // timing-ok: negative window, from the three messages delivered: the oldest time is still the first one's
      expect(raw(home).unseen_oldest_at).toBe(first)
      // the agent picking it up
      await h.bridge.callTool('reply', { thread_id: 'general', text: 'on it' })
      await waitFor(() => raw(home).unseen_oldest_at === null, 3000, 'unseen cleared')
    },
    HARNESS_START_MS + t(30_000),
  )

  test(
    'last_owner_at: null before the owner writes, then the newest message time, changing with each message (the Mac updater postpones on it)',
    async () => {
      h = await startHarness()
      const home = h.home
      await waitFor(() => readStatusFile(statusPath(home))?.relay.connected === true, 3000, 'connected')
      expect(raw(home).last_owner_at).toBeNull()
      await h.app.sendMessage('general', 'first')
      await h.waitNotes(1)
      await waitFor(() => readStatusFile(statusPath(home))?.last_owner_at != null, 3000, 'the owner time')
      const first = String(raw(home).last_owner_at)
      await sleep(5)
      await h.app.sendMessage('inbox', 'second')
      await h.waitNotes(2)
      await waitFor(() => readStatusFile(statusPath(home))?.last_owner_at !== first, 3000, 'a newer owner time')
      // only a time: no text, thread or id of the message
      const text = readFileSync(statusPath(home), 'utf8')
      expect(text).not.toContain('second')
      expect(parseStatusFile({ ...JSON.parse(text), last_owner_at: 'not a time' })?.last_owner_at).toBeNull()
    },
    HARNESS_START_MS + t(30_000),
  )

  test(
    "main_resend: a live bridge says it answers the Mac's resend request; a file without the field (an older bridge) says it does not",
    async () => {
      h = await startHarness()
      const home = h.home
      await waitFor(() => readStatusFile(statusPath(home))?.relay.connected === true, 3000, 'connected')
      expect(raw(home).main_resend).toBe(true)
      const { main_resend: _gone, ...older } = JSON.parse(readFileSync(statusPath(home), 'utf8'))
      expect(parseStatusFile(older)?.main_resend).toBe(false)
      expect(parseStatusFile({ ...older, main_resend: 'yes' })?.main_resend).toBe(false)
    },
    HARNESS_START_MS + t(30_000),
  )

  test(
    'unseen_oldest_at: any tool call clears it, not only one on that thread (a session calling tools is not hung)',
    async () => {
      h = await startHarness()
      const home = h.home
      await h.app.sendMessage('general', 'thanks')
      await h.waitNotes(1)
      await waitFor(() => readStatusFile(statusPath(home))?.unseen_oldest_at != null, 3000, 'the unseen time')
      await h.bridge.callTool('list_threads', {})
      await waitFor(() => raw(home).unseen_oldest_at === null, 3000, 'unseen cleared')
    },
    HARNESS_START_MS + t(30_000),
  )

  test(
    'relay.connected flips to false when the socket drops, with the close code, and back to true on reconnect',
    async () => {
      // the waits add up to 42 s (connected 9, the flip 9, the reconnect 24, each at its x3), plus the harness start
      h = await startHarness({ bridge: { random: () => 0 } })
      const home = h.home
      await waitFor(() => readStatusFile(statusPath(home))?.relay.connected === true, 3000, 'connected')
      expect(readStatusFile(statusPath(home))?.relay.last_connect_at).toBeTruthy()
      h.relay.dropBridge()
      await waitFor(
        () => readStatusFile(statusPath(home))?.relay.connected === false,
        3000,
        'connected to flip to false',
      )
      expect(typeof readStatusFile(statusPath(home))?.relay.last_close_code).toBe('number')
      await waitFor(() => readStatusFile(statusPath(home))?.relay.connected === true, 8000, 'connected again')
    },
    HARNESS_START_MS + t(45_000),
  )

  test(
    '4409: one last superseded snapshot, then the old bridge never writes again',
    async () => {
      h = await startHarness({ bridge: { random: () => 0 } })
      const home = h.home
      await waitFor(() => readStatusFile(statusPath(home))?.relay.connected === true, 3000, 'connected')
      h.relay.kickBridge(4409)
      await waitFor(() => readStatusFile(statusPath(home))?.mode === 'superseded', 3000, 'superseded')
      expect(readStatusFile(statusPath(home))?.relay.last_close_code).toBe(4409)
      const frozen = readFileSync(statusPath(home), 'utf8')
      // The superseded bridge asks back in as a standby after backoffMs(0) = 800 ms (random 0); this fake relay has no newer bridge
      // to turn it away, so it rejoins then and writes again, by design. The window has to end before that, so it is not scaled.
      await sleep(400) // timing-ok: product timing: shorter than the 800 ms standby rejoin
      expect(readFileSync(statusPath(home), 'utf8')).toBe(frozen)
    },
    HARNESS_START_MS + t(30_000),
  )

  test(
    'a headless process on the same home (talos-app post) never overwrites the live bridge file',
    async () => {
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
        await sleep(t(250)) // timing-ok: negative window, from the headless poll returning: the live file is not touched
      } finally {
        await headless.stop()
      }
      expect(readFileSync(statusPath(home), 'utf8')).toBe(before)
    },
    HARNESS_START_MS + t(30_000),
  )

  test(
    'a headless process alone, with no live bridge started, creates no status.json at all',
    async () => {
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
    },
    HARNESS_START_MS + t(30_000),
  )

  test(
    'stop() leaves the last snapshot but no timer keeps writing',
    async () => {
      h = await startHarness()
      const home = h.home
      await waitFor(() => readStatusFile(statusPath(home))?.relay.connected === true, 3000, 'connected')
      await h.bridge.stop()
      const frozen = readFileSync(statusPath(home), 'utf8')
      await sleep(t(300)) // timing-ok: negative window, from stop() returning: no timer keeps writing
      expect(readFileSync(statusPath(home), 'utf8')).toBe(frozen)
    },
    HARNESS_START_MS + t(30_000),
  )
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
    unseen_oldest_at: null,
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
    unseen_oldest_at: null,
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

// The supervisor's #5 signal: the oldest owner message no bridge tool call has followed. The live bridge writes it (the
// unseen contract); this reader passes it through, and anything that is not a time reads as none.
describe('status.json unseen_oldest_at, as the supervisor reads it', () => {
  const base = {
    v: 1,
    pid: 4242,
    mode: 'live',
    relay: { connected: true },
    updated_at: '2026-11-01T10:00:00.000Z',
  }
  test('a time passes through; absent, null or not a time is none', () => {
    expect(parseStatusFile({ ...base, unseen_oldest_at: '2026-11-01T09:55:00.000Z' })?.unseen_oldest_at).toBe(
      '2026-11-01T09:55:00.000Z',
    )
    expect(parseStatusFile(base)?.unseen_oldest_at).toBeNull()
    expect(parseStatusFile({ ...base, unseen_oldest_at: null })?.unseen_oldest_at).toBeNull()
    expect(parseStatusFile({ ...base, unseen_oldest_at: 'soon' })?.unseen_oldest_at).toBeNull()
    expect(parseStatusFile({ ...base, unseen_oldest_at: 7 })?.unseen_oldest_at).toBeNull()
  })
  test('read from the file the supervisor reads', () => {
    const home = tempHome()
    writeFileSync(join(home, 'status.json'), JSON.stringify({ ...base, unseen_oldest_at: '2026-11-01T09:55:00.000Z' }))
    expect(readStatusFile(join(home, 'status.json'))?.unseen_oldest_at).toBe('2026-11-01T09:55:00.000Z')
  })
})

describe('the governor in status.json (restart-on-update)', () => {
  test('a known state is read as it is; one from an older bridge (absent) or unknown reads as null, which the queue holds on', () => {
    const base = { v: 1, pid: 4242, mode: 'live', relay: { connected: true }, updated_at: new Date().toISOString() }
    for (const g of GOVERNOR_STATES) expect(parseStatusFile({ ...base, governor: g })?.governor).toBe(g)
    expect(parseStatusFile(base)?.governor).toBeNull()
    expect(parseStatusFile({ ...base, governor: 'normal' })?.governor).toBeNull()
    expect(parseStatusFile({ ...base, governor: 7 })?.governor).toBeNull()
  })
})

describe('app_path: where the Mac app is, handed over by the Mac in TALOS_APP_BUNDLE (the bridge is the only writer of the file)', () => {
  const app = (home: string, name = 'Talos.app') => {
    const d = join(home, name)
    mkdirSync(d, { recursive: true })
    return realpathSync(d) // a Mac's temp folder is itself a link (/var -> /private/var); the bridge writes the real path
  }

  test('a real bridge started with a valid TALOS_APP_BUNDLE writes it as app_path, and nothing else changes', async () => {
    const home = tempHome()
    const bundle = app(tempHome())
    h = await startHarness({ home, env: { TALOS_APP_BUNDLE: bundle } })
    await waitFor(() => readStatusFile(statusPath(home))?.relay.connected === true, 3000, 'connected')
    const s = raw(home)
    expect(s.app_path).toBe(bundle)
    expect(Object.keys(s).sort()).toEqual([...STATUS_KEYS, 'app_path'].sort())
    expect(parseStatusFile(s)?.app_path).toBe(bundle)
  })

  test('a real bridge with no variable, a relative path, a non-.app path or a missing folder writes no app_path key at all', async () => {
    const plain = tempHome()
    mkdirSync(join(plain, 'folder'))
    writeFileSync(join(plain, 'File.app'), 'x')
    for (const bad of [
      undefined,
      'Talos.app',
      './Talos.app',
      '',
      join(plain, 'folder'),
      join(plain, 'Gone.app'),
      join(plain, 'File.app'),
    ]) {
      const home = tempHome()
      h = await startHarness({ home, ...(bad === undefined ? {} : { env: { TALOS_APP_BUNDLE: bad } }) })
      await waitFor(() => readStatusFile(statusPath(home))?.relay.connected === true, 3000, 'connected')
      expect(Object.keys(raw(home)).sort(), String(bad)).toEqual([...STATUS_KEYS].sort())
      await h.stop()
      h = undefined
    }
  })

  test('validAppPath: absolute, ends in .app, a folder that exists; a link to one stands for the real folder', () => {
    const dir = tempHome()
    const good = app(dir)
    expect(validAppPath(good)).toBe(good)
    symlinkSync(good, join(dir, 'Link.app'))
    expect(validAppPath(join(dir, 'Link.app'))).toBe(good)
    for (const bad of [
      undefined,
      '',
      'Talos.app',
      `${good}/..`,
      `${good}/Contents.app`,
      join(dir, 'x.app', '..', 'y'),
      '/',
    ]) {
      expect(validAppPath(bad), String(bad)).toBeUndefined()
    }
    expect(validAppPath(`${good}\n`)).toBeUndefined()
  })

  const timers: Array<{ at: number; fn: () => void }> = []
  const clockAt = (t: { ms: number }) => ({
    now: () => t.ms,
    setTimeout: (fn: () => void, ms: number) => {
      timers.push({ at: t.ms + ms, fn })
      return timers.length
    },
    clearTimeout: () => {},
  })
  const snap = () => ({
    mode: 'live' as const,
    relay: { connected: true, last_connect_at: null, last_close_code: null },
    queue_depth: 0,
    unseen_oldest_at: null,
    permission_relay: false,
    permission_relay_declared: false,
  })

  test('the writer keeps app_path across heartbeats, and the parser ignores a bad value instead of failing the file', () => {
    const home = tempHome()
    const bundle = app(tempHome())
    const t = { ms: Date.parse('2026-11-01T10:00:00Z') }
    timers.length = 0
    const w = new StatusWriter({
      path: statusPath(home),
      clock: clockAt(t),
      log: nullLogger,
      instance: 'a',
      appPath: bundle,
      snapshot: snap,
    })
    w.start()
    t.ms += 15_000
    timers[0]?.fn()
    expect(readStatusFile(statusPath(home))?.app_path).toBe(bundle)
    w.stop()
    const base = JSON.parse(readFileSync(statusPath(home), 'utf8')) as Record<string, unknown>
    for (const bad of [7, 'rel.app', '/tmp/notapp', null]) {
      const p = parseStatusFile({ ...base, app_path: bad })
      expect(p?.pid).toBe(process.pid)
      expect(p?.app_path).toBeUndefined()
    }
    expect(parseStatusFile({ ...base, app_path: undefined })?.app_path).toBeUndefined()
  })
})
