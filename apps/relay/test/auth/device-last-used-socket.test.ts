// "Last used" must find a forgotten device, so an idle open socket must not count as use. This drives the REAL hub over a
// REAL websocket with the REAL auth module (NODE_ENV is not "test", so test-auth is refused), on a fake clock: a hidden tab
// held open through ping ticks, the 10 minute sweep and another device's revoke leaves the time alone; a frame that shows
// a person moves it.
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createDeviceKey, generateBridgeKey } from '@talos-app/protocol'
import { FakeApp, type FakeClock, fakeClock } from '@talos-app/testkit'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { resetAuthImplementation } from '../../src/auth/contract.ts'
import { DEVICE_USE_INTERVAL_MS } from '../../src/auth/core.ts'
import { authState } from '../../src/auth/state.ts'
import { COOKIE_NAME } from '../../src/auth/util.ts'
import { NoopTransport } from '../../src/core/push.ts'
import { loadEnv } from '../../src/env.ts'
import { type RunningRelay, startRelay } from '../../src/index.ts'
import { advance } from '../core/helpers.ts'
import { TEST_DATA_KEY } from '../helpers/fake-services.ts'

vi.setConfig({ testTimeout: 60_000 })

const ORIGIN = 'https://relay.example.com'

let relay: RunningRelay
let clock: FakeClock
let dir: string
const apps: FakeApp[] = []

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'talos-lastused-'))
  clock = fakeClock('2026-11-01T20:00:00.000Z')
  const bridgeKey = await generateBridgeKey()
  relay = await startRelay({
    env: loadEnv({
      NODE_ENV: 'development',
      DATA_DIR: dir,
      PUBLIC_ORIGIN: ORIGIN,
      RP_ID: 'relay.example.com',
      DATA_KEY: TEST_DATA_KEY,
      BRIDGE_PUBKEY: bridgeKey.publicKeyB64,
      LOG_LEVEL: 'silent',
    }),
    host: '127.0.0.1',
    port: 0,
    transport: new NoopTransport(),
    clock,
  })
})
afterEach(async () => {
  for (const a of apps.splice(0)) await a.close().catch(() => undefined)
  await relay.stop()
  resetAuthImplementation()
  rmSync(dir, { recursive: true, force: true })
})

/** A pinned device with a real session, and a socket client holding that session. Never used: last_used_at is null. */
async function pinnedPhone(name: string, visible: boolean) {
  const core = authState(relay.services).core
  const key = await createDeviceKey()
  core.addCredential({
    credentialId: `cred-${name}`,
    publicKey: new Uint8Array([1, 2, 3]),
    counter: 0,
    deviceName: name,
  })
  core.upsertDevice({
    id: key.deviceId as never,
    name,
    pubkeyJwk: key.publicJwk,
    credentialId: `cred-${name}`,
    binding: 'b',
    codeId: `c-${name}`,
  })
  core.setPinned(key.deviceId, true)
  const token = core.createSession(`cred-${name}`, key.deviceId)
  const app = new FakeApp({
    relayWs: `ws://127.0.0.1:${relay.port}`,
    headers: { Cookie: `${COOKIE_NAME}=${token}`, Origin: ORIGIN },
    deviceKey: key,
    visible,
  })
  apps.push(app)
  return { id: key.deviceId, app, core }
}

const lastUsed = (id: string) => authState(relay.services).core.device(id)?.lastUsedAt ?? null

/** The relay handles one socket's frames in order, so once its pong is back every frame sent before the ping was handled. */
async function barrier(app: FakeApp) {
  const nonce = `b${Math.random().toString(36).slice(2, 10)}`
  app.send({ type: 'ping', nonce })
  await app.expectFrame('pong', (f) => f.nonce === nonce)
}

describe('an open socket is not a device in use', () => {
  it('a hidden tab held open through ping ticks, the sweep and another device revoke keeps its last-used time', async () => {
    const tab = await pinnedPhone('Hidden tab', false)
    const other = await pinnedPhone('Other phone', false)
    await tab.app.connect()
    await other.app.connect()
    expect(lastUsed(tab.id)).toBeNull()

    // Overnight: far past the 10 minute sweep and many 25 s ping ticks (each runs the relay's own session re-check).
    await advance(clock, 3 * DEVICE_USE_INTERVAL_MS)
    expect(lastUsed(tab.id)).toBeNull()

    // The client's own keepalive reaches the hub too.
    await barrier(tab.app)
    expect(lastUsed(tab.id)).toBeNull()

    // Another device's revoke re-checks every socket (the routes call this); it must not stamp the others.
    tab.core.revokeDevice(other.id)
    relay.services.bus.revalidateApps()
    await barrier(tab.app)
    expect(lastUsed(tab.id)).toBeNull()
  })

  it('a frame that shows a person moves the time, and only for the device that sent it', async () => {
    const mine = await pinnedPhone('Mine', false)
    const theirs = await pinnedPhone('Theirs', false)
    await mine.app.connect()
    await theirs.app.connect()
    await advance(clock, 2 * DEVICE_USE_INTERVAL_MS)
    expect(lastUsed(mine.id)).toBeNull()

    mine.app.send({ type: 'visibility', state: 'visible' }) // what the app sends on a touch or a key
    await barrier(mine.app)
    expect(lastUsed(mine.id)).toBe(clock.now())
    expect(lastUsed(theirs.id)).toBeNull()
  })

  it('a hidden report is not use, and a second visible report inside the window does not write again', async () => {
    const p = await pinnedPhone('Phone', true)
    await p.app.connect()
    p.app.send({ type: 'visibility', state: 'hidden' })
    await barrier(p.app)
    expect(lastUsed(p.id)).toBeNull()

    p.app.send({ type: 'visibility', state: 'visible' })
    await barrier(p.app)
    const first = lastUsed(p.id)
    expect(first).toBe(clock.now())
    await advance(clock, DEVICE_USE_INTERVAL_MS / 2) // in steps, so the app answers each ping and stays connected
    p.app.send({ type: 'visibility', state: 'visible' })
    await barrier(p.app)
    expect(lastUsed(p.id)).toBe(first)
    await advance(clock, DEVICE_USE_INTERVAL_MS)
    p.app.send({ type: 'visibility', state: 'visible' })
    await barrier(p.app)
    expect(lastUsed(p.id)).toBe(clock.now())
  })

  it('a socket that reconnects by itself (an upgrade with no person) does not count', async () => {
    const p = await pinnedPhone('Phone', false)
    await p.app.connect()
    await p.app.close()
    await advance(clock, 2 * DEVICE_USE_INTERVAL_MS)
    await p.app.connect()
    expect(lastUsed(p.id)).toBeNull()
  })
})
