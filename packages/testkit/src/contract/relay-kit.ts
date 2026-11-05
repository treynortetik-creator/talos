// Helpers the relay contract cases share: a FakeApp/FakeBridge pair factory wired to a relay handle, and the "has the
// relay got that far" probe.
import { signBridgeHttp } from '@talos-app/protocol'
import { FakeApp } from '../fake-app.ts'
import { FakeBridge, type FakeBridgeOptions } from '../fake-bridge.ts'
import { mkFrame } from '../frame-utils.ts'
import type { RelayHandle } from './harness.ts'

export function kit(relay: RelayHandle) {
  const app = (opts: { deviceKey?: FakeApp['device'] } = {}) =>
    new FakeApp({ relayWs: relay.wsBase, headers: relay.appHeaders, ...opts })
  const bridge = (opts: Partial<FakeBridgeOptions> = {}) =>
    new FakeBridge({ relayWs: relay.wsBase, key: relay.bridgeKey, ...opts })
  const connectedApp = async () => {
    const a = app()
    await a.connect()
    return a
  }
  return { app, bridge, connectedApp }
}

/**
 * The relay handles one socket's frames in order, so its pong to a later ping proves it has processed everything the
 * bridge sent before (an `ack consumed` leaves no other trace to wait on).
 */
export async function relayCaughtUp(b: FakeBridge) {
  const nonce = mkFrame('ping').id.slice(-12)
  b.send({ type: 'ping', nonce })
  await b.expectFrame('pong', (f) => f.nonce === nonce, { direction: 'in' })
}

export const textOf = (b: Buffer | string) => (typeof b === 'string' ? b : b.toString('utf8'))

export async function signedPost(
  relay: RelayHandle,
  frame: Record<string, unknown>,
  opts: { key?: RelayHandle['bridgeKey']; body?: string } = {},
) {
  const key = opts.key ?? relay.bridgeKey
  const body = opts.body ?? JSON.stringify(frame)
  const header = await signBridgeHttp({
    privateKey: key.privateKey,
    keyId: key.keyId,
    method: 'POST',
    pathWithQuery: '/bridge/post',
    body,
  })
  return { body, header }
}
