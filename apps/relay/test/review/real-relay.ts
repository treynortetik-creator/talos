// A relay on a free port with the REAL auth module (sessions, pinning, rate limits, step-up) and the real hub, hooks and
// voice modules. Sessions are minted straight into the auth store (no passkey ceremony), everything else goes over HTTP
// and WebSocket exactly as the PWA and the Mac do. The testkit fakes and the unit-test auth hide the bugs these tests catch.
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  type BridgeKeyPair,
  createDeviceKey,
  type DeviceKey,
  generateBridgeKey,
  newId,
  signBridgeHttp,
} from '@talos-app/protocol'
import { type Clock, FakeApp, FakeBridge, realClock } from '@talos-app/testkit'
import { resetAuthImplementation } from '../../src/auth/contract.ts'
import { authState } from '../../src/auth/state.ts'
import { COOKIE_NAME } from '../../src/auth/util.ts'
import { NoopTransport } from '../../src/core/push.ts'
import { runtimeOf } from '../../src/core/runtime.ts'
import { loadEnv } from '../../src/env.ts'
import { type RunningRelay, startRelay } from '../../src/index.ts'
import { TEST_DATA_KEY } from '../helpers/fake-services.ts'

export const ORIGIN = 'https://relay.example.com'

export type Owner = { cookie: string; token: string; sessionId: string; device: DeviceKey; credentialId: string }

export type RealRelay = {
  relay: RunningRelay
  httpBase: string
  wsBase: string
  bridgeKey: BridgeKeyPair
  transport: NoopTransport
  runtime: ReturnType<typeof runtimeOf>
  auth: ReturnType<typeof authState>
  /** A signed-in owner session on a freshly enrolled device (pinned unless `pinned: false`). */
  owner(opts?: { pinned?: boolean; credentialId?: string }): Promise<Owner>
  app(o: Owner, opts?: { visible?: boolean }): FakeApp
  bridge(): FakeBridge
  /** POST JSON with the cookie, Origin and CSRF header every browser call carries. */
  post(path: string, body: unknown, o: Owner | null, extra?: Record<string, string>): Promise<Response>
  /** POST JSON signed as the Mac's bridge (the CLI path). */
  bridgePost(path: string, body: unknown): Promise<Response>
  stop(): Promise<void>
}

export async function startRealRelay(opts: { env?: Record<string, string>; clock?: Clock } = {}): Promise<RealRelay> {
  resetAuthImplementation() // the real auth module installs itself in register()
  const dir = mkdtempSync(join(tmpdir(), 'talos-real-'))
  const bridgeKey = await generateBridgeKey()
  const env = loadEnv({
    NODE_ENV: 'test',
    DATA_DIR: dir,
    PUBLIC_ORIGIN: ORIGIN,
    RP_ID: 'relay.example.com',
    DATA_KEY: TEST_DATA_KEY,
    LOG_LEVEL: 'silent',
    BRIDGE_PUBKEY: bridgeKey.publicKeyB64,
    ...opts.env,
  })
  const transport = new NoopTransport()
  const relay = await startRelay({ env, host: '127.0.0.1', port: 0, clock: opts.clock ?? realClock, transport })
  const auth = authState(relay.services)
  const wsBase = `ws://127.0.0.1:${relay.port}`
  const httpBase = `http://127.0.0.1:${relay.port}`
  return {
    relay,
    httpBase,
    wsBase,
    bridgeKey,
    transport,
    runtime: runtimeOf(relay.services),
    auth,
    async owner(o = {}) {
      const credentialId = o.credentialId ?? 'cred-1'
      const { core } = auth
      if (!core.credential(credentialId))
        core.addCredential({
          credentialId,
          publicKey: new Uint8Array([1, 2, 3]),
          counter: 0,
          deviceName: 'Test passkey',
        })
      const device = await createDeviceKey()
      core.upsertDevice({
        id: device.deviceId as never,
        name: 'Test phone',
        pubkeyJwk: device.publicJwk,
        credentialId,
        binding: 'b',
        codeId: newId('c'),
      })
      if (o.pinned !== false) core.setPinned(device.deviceId, true)
      const token = core.createSession(credentialId, device.deviceId)
      const row = core.lookupSession(token)
      return { cookie: `${COOKIE_NAME}=${token}`, token, sessionId: row?.id as string, device, credentialId }
    },
    app: (o, a = {}) =>
      new FakeApp({ relayWs: wsBase, headers: { Cookie: o.cookie, Origin: ORIGIN }, deviceKey: o.device, ...a }),
    bridge: () => new FakeBridge({ relayWs: wsBase, key: bridgeKey }),
    post: (path, body, o, extra = {}) =>
      fetch(`${httpBase}${path}`, {
        method: 'POST',
        headers: {
          Origin: ORIGIN,
          'X-Talos-CSRF': '1',
          'content-type': 'application/json',
          ...(o ? { Cookie: o.cookie } : {}),
          ...extra,
        },
        body: JSON.stringify(body),
      }),
    async bridgePost(path, body) {
      const raw = JSON.stringify(body)
      const authorization = await signBridgeHttp({
        privateKey: bridgeKey.privateKey,
        keyId: bridgeKey.keyId,
        method: 'POST',
        pathWithQuery: path,
        body: raw,
        ts: Math.floor(Date.now() / 1000),
      })
      return fetch(`${httpBase}${path}`, { method: 'POST', headers: { Authorization: authorization }, body: raw })
    },
    async stop() {
      await relay.stop()
      resetAuthImplementation()
      rmSync(dir, { recursive: true, force: true })
    },
  }
}

/** Resolves with the WebSocket close code, or null if it stays open for `ms`. */
export function closeCodeWithin(app: { ws: import('ws').WebSocket | null }, ms: number): Promise<number | null> {
  const ws = app.ws
  if (!ws) return Promise.resolve(null)
  if (ws.readyState === ws.CLOSED) return Promise.resolve(null)
  return new Promise((resolve) => {
    const t = setTimeout(() => resolve(null), ms)
    ws.once('close', (code) => {
      clearTimeout(t)
      resolve(code)
    })
  })
}
