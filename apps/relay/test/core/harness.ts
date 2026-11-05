// An in-process relay on a free port with a temp DATA_DIR, wired to test-auth, for the contract suites and the WP1 tests.
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { type BridgeKeyPair, generateBridgeKey, type PushIntent } from '@talos-app/protocol'
import { type Clock, type RelayHandle, realClock } from '@talos-app/testkit'
import { resetAuthImplementation } from '../../src/auth/contract.ts'
import { NoopTransport } from '../../src/core/push.ts'
import { runtimeOf } from '../../src/core/runtime.ts'
import { loadEnv } from '../../src/env.ts'
import { type RunningRelay, startRelay } from '../../src/index.ts'
import type { Logger } from '../../src/services.ts'
import { TEST_DATA_KEY } from '../helpers/fake-services.ts'
import { installTestAuth, mintTestStepup, pinTestDevice, testAppHeaders } from '../helpers/test-auth.ts'

export const ORIGIN = 'https://relay.example.com'

export type TestRelay = RelayHandle & {
  relay: RunningRelay
  dir: string
  transport: NoopTransport
  /** Push intents the relay asked to send (before the policy), via the services' push. */
  runtime: ReturnType<typeof runtimeOf>
  seedInboxItem(eventId: string): void
  stopKeepData(): Promise<void>
}

export async function startTestRelay(
  opts: {
    clock?: Clock
    env?: Record<string, string>
    dir?: string
    webDir?: string
    bridgeKey?: BridgeKeyPair
    log?: Logger
    /** The fetch the ntfy sink uses (a test points it at a local sink; the env only allows https URLs). */
    ntfyFetch?: typeof fetch
    /** WP-I5: where the APNs sender connects (a local HTTP/2 fake). Needs the APNS_* env to be set. */
    apnsAuthority?: (env: 'sandbox' | 'production') => string
  } = {},
): Promise<TestRelay> {
  const dir = opts.dir ?? mkdtempSync(join(tmpdir(), 'talos-relay-'))
  const bridgeKey = opts.bridgeKey ?? (await generateBridgeKey())
  installTestAuth({ bridgeKey })
  const env = loadEnv({
    NODE_ENV: 'test',
    DATA_DIR: dir,
    PUBLIC_ORIGIN: ORIGIN,
    RP_ID: 'relay.example.com',
    DATA_KEY: TEST_DATA_KEY,
    LOG_LEVEL: 'silent',
    ...opts.env,
  })
  const transport = new NoopTransport()
  const relay = await startRelay({
    env,
    host: '127.0.0.1',
    port: 0,
    clock: opts.clock ?? realClock,
    transport,
    ...(opts.log ? { log: opts.log } : {}),
    ...(opts.ntfyFetch ? { ntfyFetch: opts.ntfyFetch } : {}),
    ...(opts.apnsAuthority ? { apnsAuthority: opts.apnsAuthority } : {}),
    ...(opts.webDir ? { webDir: opts.webDir } : {}),
  })
  let stopped = false
  const stopKeepData = async () => {
    if (stopped) return
    stopped = true
    await relay.stop()
    resetAuthImplementation()
  }
  return {
    relay,
    dir,
    transport,
    runtime: runtimeOf(relay.services),
    wsBase: `ws://127.0.0.1:${relay.port}`,
    httpBase: `http://127.0.0.1:${relay.port}`,
    appHeaders: testAppHeaders(ORIGIN),
    bridgeKey,
    mintStepup: (purpose) => mintTestStepup(purpose),
    deviceHeaders: (deviceId, o = {}) => testAppHeaders(ORIGIN, deviceId, o),
    pinDevice: (deviceId) => pinTestDevice(deviceId),
    seedInboxItem: (eventId) => {
      runtimeOf(relay.services)
        .store.db.prepare(
          `insert into hooks_events (event_id, conn_id, integration, thread, priority, ts, event_json, created_at)
           values (?, 'c1', 'generic', 'general', 'normal', '2026-10-28T15:00:00.000Z', '{}', 1)`,
        )
        .run(eventId)
    },
    unauthenticatedHeaders: { Origin: ORIGIN },
    wrongOriginHeaders: testAppHeaders('https://evil.example.net'),
    stopKeepData,
    stop: async () => {
      await stopKeepData()
      rmSync(dir, { recursive: true, force: true })
    },
  }
}

export type { PushIntent }
