import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir, userInfo } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { FakeApp, FakeClaude, FakeRelay, loadExampleConfig, sleep, t, waitFor } from '@talos-app/testkit'
import { afterEach, describe, expect, it } from 'vitest'
import { ChronosBox, draft, TZ } from '../test/schedules/chronos-box.ts'
import { bridgeEnv, makeRoot } from './bridge-env.ts'

const BRIDGE_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/**
 * The owner's real home, as a test machine has one: a Chronos under ~/.local/share/chronos with a job that is due right now, and
 * an inbox under ~/.talos-inbox. A contract bridge must not find the one, ask it anything (a verb as small as `due` writes its
 * beat), be offered its job, or touch the other.
 */
describe('the contract harness keeps the bridge out of the owner’s real home', () => {
  const cleanup: Array<() => void | Promise<void>> = []
  afterEach(async () => {
    for (const fn of cleanup.splice(0).reverse()) await fn()
  })

  /** A contract bridge, spawned the way the harness spawns it, on a fresh relay; `extra` is laid over its env. */
  async function launch(extra: Record<string, string> = {}) {
    const relay = await new FakeRelay().start()
    cleanup.push(() => relay.stop())
    const app = new FakeApp({ relayWs: relay.wsBase })
    await app.connect()
    cleanup.push(() => app.close())
    const root = makeRoot()
    const home = join(root, 'home')
    mkdirSync(home, { recursive: true })
    writeFileSync(join(home, 'config.json'), JSON.stringify(loadExampleConfig('default')), { mode: 0o600 })
    writeFileSync(
      join(home, 'bridge.key'),
      JSON.stringify({
        v: 1,
        pkcs8: relay.bridgeKey.privateKeyPkcs8B64,
        public: relay.bridgeKey.publicKeyB64,
        key_id: relay.bridgeKey.keyId,
      }),
      { mode: 0o600 },
    )
    writeFileSync(
      join(home, 'devices.json'),
      JSON.stringify({
        version: 1,
        devices: [{ id: app.device.deviceId, name: 'Contract device', pubkey_jwk: app.device.publicJwk }],
      }),
      { mode: 0o600 },
    )
    const claude = await new FakeClaude({
      command: 'bun',
      args: ['run', join(BRIDGE_DIR, 'src', 'server.ts')],
      cwd: BRIDGE_DIR,
      env: bridgeEnv(home, relay.httpUrl, root, {
        // let a job come due within seconds (the real default is a minute)
        TALOS_APP_SCHEDULE_RUNNER_S: '5',
        TALOS_APP_SCHEDULE_REFRESH_S: '5',
        ...extra,
      }),
    }).start()
    cleanup.push(() => claude.stop())
    await relay.rec.expectFrame('ready', () => true, { direction: 'to_bridge' })
    return {
      claude,
      home,
      root,
      logText: () => (existsSync(join(home, 'bridge.log')) ? readFileSync(join(home, 'bridge.log'), 'utf8') : ''),
    }
  }

  /** A Chronos that logs every call it gets and answers like a real, ready one. */
  const loggingChronos = (where: string) => {
    mkdirSync(join(where, 'bin'), { recursive: true })
    const bin = join(where, 'bin', 'chronos')
    const calls = join(where, 'chronos-calls')
    writeFileSync(
      bin,
      `#!/bin/sh\necho "$@" >> '${calls}'\ncase "$1 $2" in\n  "api version") echo '{"api":1,"chronos":"0.5.1","session_runner":"talos","approval_required":true}' ;;\n  *) echo '{}' ;;\nesac\n`,
    )
    chmodSync(bin, 0o755)
    return { bin, calls }
  }

  it('a bridge spawned the way a contract harness spawns it never uses the real Chronos or inbox', async () => {
    const fakeHome = mkdtempSync(join(tmpdir(), 'talos-fake-real-home-'))
    cleanup.push(() => rmSync(fakeHome, { recursive: true, force: true }))
    // a real Chronos with one job that came due a minute ago, found where discovery looks: ~/.local/share/chronos/bin/chronos
    const now = new Date()
    const minuteAgo = new Date(now.getTime() - 60_000)
    const hhmm = new Intl.DateTimeFormat('en-GB', {
      timeZone: TZ,
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    }).format(minuteAgo)
    const box = new ChronosBox(now.toISOString())
    cleanup.push(() => box.dispose())
    box.configure({ sessionRunner: 'talos', approvalRequired: false })
    box.create(
      draft({ when: { type: 'daily', time: hhmm }, prompt: 'The owner’s real job, due now.\n' }),
      now.toISOString(),
    )
    const calls = join(fakeHome, 'chronos-calls')
    const realBin = join(fakeHome, '.local', 'share', 'chronos', 'bin', 'chronos')
    mkdirSync(dirname(realBin), { recursive: true })
    writeFileSync(realBin, `#!/bin/sh\necho "$@" >> '${calls}'\nexec '${box.bin}' "$@"\n`)
    chmodSync(realBin, 0o755)
    const inbox = join(fakeHome, '.talos-inbox')
    mkdirSync(inbox, { recursive: true })
    writeFileSync(join(inbox, 'marker.txt'), 'owner inbox')
    const inboxBefore = readdirSync(inbox).sort()

    // the machine this runs on: HOME is the owner's home
    const savedHome = process.env.HOME
    process.env.HOME = fakeHome
    cleanup.push(() => {
      if (savedHome === undefined) delete process.env.HOME
      else process.env.HOME = savedHome
    })

    const { claude } = await launch()
    // long enough for discovery and two schedule runner ticks (5 s each)
    await sleep(t(14_000))
    expect(
      claude.notifications.map((n) => n.meta.kind).filter((k) => k === 'schedule_run' || k === 'schedule_held'),
      "the owner's real job was offered to the test bridge",
    ).toEqual([])
    const asked = existsSync(calls) ? readFileSync(calls, 'utf8') : ''
    expect(asked, 'what the real Chronos was asked').toBe('')
    expect(readdirSync(inbox).sort(), 'the real inbox changed').toEqual(inboxBefore)
  }, 60_000)

  // The guard alone, with the harness's own isolation not in the way: discovery is off in the env, but a bridge that is pinned to a
  // real-looking Chronos (TALOS_APP_CHRONOS_BIN wins over discovery) still must not start it, because it is outside the test root.
  it('a bridge pinned to a Chronos outside its test root never starts it, and its log says it was refused', async () => {
    const outside = mkdtempSync(join(tmpdir(), 'talos-outside-chronos-'))
    cleanup.push(() => rmSync(outside, { recursive: true, force: true }))
    const away = loggingChronos(outside)
    const { logText } = await launch({ TALOS_APP_CHRONOS_BIN: away.bin })
    await waitFor(() => /outside the test folder was refused/.test(logText()), t(20_000), 'the refusal in bridge.log')
    await sleep(t(6_000)) // two runner ticks: nothing starts it later either
    expect(existsSync(away.calls), 'the Chronos outside the root was started').toBe(false)
  }, 60_000)

  it('a Chronos linked into the test root from outside it is refused too', async () => {
    const outside = mkdtempSync(join(tmpdir(), 'talos-outside-chronos-'))
    cleanup.push(() => rmSync(outside, { recursive: true, force: true }))
    const away = loggingChronos(outside)
    // the link sits inside the root the bridge will get: the harness names it, so make it first
    const root = makeRoot()
    const link = join(root, 'chronos')
    symlinkSync(away.bin, link)
    mkdirSync(join(root, 'home'), { recursive: true })
    // its HOME is inside the root too, so the link is the only thing wrong
    const { logText } = await launch({ TALOS_TEST_ROOT: root, HOME: join(root, 'home'), TALOS_APP_CHRONOS_BIN: link })
    await waitFor(() => /outside the test folder was refused/.test(logText()), t(20_000), 'the refusal in bridge.log')
    expect(existsSync(away.calls), 'the linked Chronos was started').toBe(false)
  }, 60_000)
})

describe('the safety net', () => {
  it('a bridge about to start with the real home as its HOME fails the run before it starts', () => {
    const root = makeRoot()
    expect(() => bridgeEnv(join(root, 'home'), 'http://127.0.0.1:1', root, { HOME: userInfo().homedir })).toThrow(
      /real home/,
    )
    expect(bridgeEnv(join(root, 'home'), 'http://127.0.0.1:1', root).HOME).toBe(join(root, 'userhome'))
  })

  it('a link to the real home is the real home', () => {
    const root = makeRoot()
    const link = join(root, 'looks-harmless')
    symlinkSync(userInfo().homedir, link)
    expect(() => bridgeEnv(join(root, 'home'), 'http://127.0.0.1:1', root, { HOME: link })).toThrow(/real home/)
  })
})
