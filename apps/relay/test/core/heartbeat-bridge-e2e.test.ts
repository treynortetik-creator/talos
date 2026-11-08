// HB5b end to end: the app's signed `heartbeat.test` goes through the REAL relay (apps/relay, in process) to the REAL bridge
// (bun, a separate process, as in production) with the real Chronos CLI behind it, and the answer comes back the same way:
// app -> relay -> bridge -> relay -> app. Nothing in the middle is a fake. Also proves the bridge's `heartbeat/1` reached the relay
// (a relay whose Mac does not list it answers `scheduler_unavailable` instead of passing the frame on).
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  createDeviceKey,
  HEARTBEAT_FEATURE,
  HeartbeatConfig,
  heartbeatConfigHashOf,
  heartbeatTestPassed,
  newUlid,
  parseHeartbeatTestResult,
} from '@talos-app/protocol'
import { FakeApp, FakeClaude, loadExampleConfig } from '@talos-app/testkit'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ChronosBox, draft } from '../../../bridge/test/schedules/chronos-box.ts'
import { startTestRelay, type TestRelay } from './harness.ts'

const BRIDGE_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'bridge')
vi.setConfig({ testTimeout: 60_000 })

let relay: TestRelay | null = null
let claude: FakeClaude | null = null
afterEach(async () => {
  await claude?.stop()
  claude = null
  await relay?.stop()
  relay = null
})

const sh = (dir: string, name: string, body: string) => {
  const p = join(dir, `${name}.sh`)
  writeFileSync(p, `#!/bin/sh\ncat > '${join(dir, `${name}.stdin`)}'\n${body}\n`)
  chmodSync(p, 0o755)
  return p
}
const answer = (items: unknown[]) =>
  JSON.stringify({ schema: 'talos.heartbeat-source/1', status: 'ok', cursor: null, items })

async function world() {
  relay = await startTestRelay()
  const deviceKey = await createDeviceKey()
  relay.pinDevice?.(deviceKey.deviceId)
  const app = new FakeApp({ relayWs: relay.wsBase, headers: relay.appHeaders, deviceKey })
  const box = new ChronosBox(new Date().toISOString())
  box.configure({ sessionRunner: 'talos', approvalRequired: true })
  box.create(draft(), new Date().toISOString())
  const home = mkdtempSync(join(tmpdir(), 'talos-hb-e2e-'))
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
      devices: [{ id: deviceKey.deviceId, name: 'E2E device', pubkey_jwk: deviceKey.publicJwk }],
    }),
    { mode: 0o600 },
  )
  claude = await new FakeClaude({
    command: 'bun',
    args: ['run', join(BRIDGE_DIR, 'src', 'server.ts')],
    cwd: BRIDGE_DIR,
    env: {
      TALOS_APP_HOME: home,
      TALOS_APP_RELAY_URL: relay.httpBase,
      TALOS_APP_BRIDGE: '1',
      TALOS_EXPLAINER: 'off',
      TALOS_APP_CHRONOS_BIN: box.bin,
    },
  }).start()
  const ready = await app.connect()
  return { app, home, ready }
}

describe('heartbeat.test: app -> real relay -> real bridge -> real relay -> app', () => {
  it('is acked, the sources really run (dry), the result parses in the app reader and passes, and the pass is on the Mac', async () => {
    const { app, home } = await world()
    const dir = mkdtempSync(join(tmpdir(), 'hb-e2e-src-'))
    const src = sh(
      dir,
      'news',
      `printf '%s' '${answer([{ key: 'k1', sig: '1', title: 'A thing', level: 'act', class: 'own', why: 'e2e.rule', deadline: null }])}'`,
    )
    const cfg = {
      schema: 'talos.heartbeat/1',
      mode: 'shadow',
      sources: [{ id: 'news', kind: 'command', enabled: true, args: { argv: ['/bin/sh', src] }, timeout_s: 5 }],
      mutes: [],
      wake_cap_per_day: 3,
      run_timeout_s: 30,
    }
    // wait until the relay has the bridge's feature list (it answers scheduler_unavailable without heartbeat/1)
    let f: Record<string, unknown> | null = null
    for (let i = 0; i < 40 && f === null; i++) {
      const sent = await app.testHeartbeat(cfg, { requestId: newUlid() })
      const outcome = await Promise.race([
        app.expectFrame('ack', (x) => x.ref === sent.id, { direction: 'in', timeoutMs: 4000 }).then(() => 'ack'),
        app
          .expectFrame('error', (x) => x.ref === sent.id, { direction: 'in', timeoutMs: 4000 })
          .then((e) => `error ${e.code}`),
      ]).catch(() => 'silence')
      if (outcome === 'ack') f = sent as Record<string, unknown>
      else if (!/mac_offline|scheduler_unavailable/.test(outcome)) throw new Error(`unexpected: ${outcome}`)
      else await new Promise((r) => setTimeout(r, 250))
    }
    expect(f, 'the relay never passed the frame to the bridge').not.toBeNull()
    const res = await app.expectFrame('heartbeat.test_result', (x) => x.request_id === f?.request_id, {
      direction: 'in',
      timeoutMs: 30_000,
    })
    const parsed = parseHeartbeatTestResult(res.result)
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    expect(parsed.result.config_hash).toBe(heartbeatConfigHashOf(cfg))
    expect(parsed.result.sources).toMatchObject([{ id: 'news', ok: true, read: 1, act: 1 }])
    // the config is in shadow mode: it only records, and the live picture is kept apart
    expect(parsed.result.mode).toBe('shadow')
    expect(parsed.result.would_wake).toEqual([])
    expect(parsed.result.if_live?.would_wake).toEqual([{ source: 'news', title: 'A thing', why: 'e2e.rule' }])
    // the app's own reading says pass, with the app's own parse of the config
    expect(heartbeatTestPassed(parsed.result, HeartbeatConfig.parse(cfg), Date.now())).toBe(true)
    expect(JSON.parse(readFileSync(join(dir, 'news.stdin'), 'utf8')).dry).toBe(true)
    const ledger = JSON.parse(readFileSync(join(home, 'heartbeat', 'tests.json'), 'utf8'))
    expect(Object.keys(ledger.passes)).toEqual([heartbeatConfigHashOf(cfg)])
    // the ack came before the result
    const types = app.rec.frames.filter((r) => r.direction === 'in').map((r) => r.raw.type)
    expect(types.indexOf('ack')).toBeLessThan(types.indexOf('heartbeat.test_result'))
    expect(HEARTBEAT_FEATURE).toBe('heartbeat/1')
  })

  it('settings the strict schema refuses come back to the asking app as a plain error, and nothing runs', async () => {
    const { app, home } = await world()
    const dir = mkdtempSync(join(tmpdir(), 'hb-e2e-src-'))
    const src = sh(dir, 'news', `printf '%s' '${answer([])}'`)
    const bad = {
      schema: 'talos.heartbeat/1',
      mutes: [],
      future: 1,
      sources: [{ id: 'news', kind: 'command', enabled: true, args: { argv: ['/bin/sh', src] }, timeout_s: 5 }],
    }
    let code = ''
    for (let i = 0; i < 40 && !['schedule_invalid'].includes(code); i++) {
      const sent = await app.testHeartbeat(bad)
      const e = await app.expectFrame('error', (x) => x.ref === sent.id, { direction: 'in', timeoutMs: 6000 })
      code = String(e.code)
      if (code !== 'schedule_invalid') await new Promise((r) => setTimeout(r, 250))
    }
    expect(code).toBe('schedule_invalid')
    expect(existsSync(join(dir, 'news.stdin'))).toBe(false)
    expect(existsSync(join(home, 'heartbeat', 'tests.json'))).toBe(false)
  })
})
