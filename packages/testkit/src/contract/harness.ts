import type { BridgeKeyPair, JwkP256T } from '@talos-app/protocol'
import type { FakeClaude } from '../fake-claude.ts'
import type { FakeRelay } from '../fake-relay.ts'

/**
 * A running relay under test: the real one in WP1 (with WP2's auth, or test-auth until it lands), `FakeRelay` when
 * testing the kit itself. The contract suites use ONLY what is declared here, so a relay that follows the spec can pass
 * them without anything being weakened.
 */
export type RelayHandle = {
  /** `ws://host:port`; FakeApp appends /ws and FakeBridge appends /bridge. */
  wsBase: string
  /** `http://host:port` (bridge HTTP routes are called here). */
  httpBase: string
  /**
   * Headers that authenticate an app socket (session cookie plus Origin; with test-auth: `X-Test-Session`). The
   * contract passes them to every FakeApp. A relay that needs none returns `{}`.
   */
  appHeaders: Record<string, string>
  /** The Ed25519 key pair the relay trusts for the bridge (its BRIDGE_PUBKEY). */
  bridgeKey: BridgeKeyPair
  /**
   * Optional: puts an inbox item with this event id where the relay keeps them. A relay that refuses a change to an item
   * it does not have needs it before `inbox.update` can be accepted; a relay that answers every update need not implement it.
   */
  seedInboxItem?(eventId: string): void
  /** Issues a valid single-use step-up token for `card:<id>`, `config:work` or `device:revoke`. */
  mintStepup(purpose: string): Promise<string> | string
  /**
   * Optional: headers that must make the upgrade fail with 401 (no session). Omit to skip those cases. Headers for a
   * wrong Origin (403) go in `wrongOriginHeaders`.
   */
  unauthenticatedHeaders?: Record<string, string>
  wrongOriginHeaders?: Record<string, string>
  /**
   * Optional: headers for an app socket whose session belongs to `deviceId` (a hello or an owner frame from another device
   * is refused), and, with `pinned: false`, whose device the Mac has not pinned yet (pairing only). Omit to skip the cases
   * about a session tied to a device.
   */
  deviceHeaders?(deviceId: string, opts?: { pinned?: boolean }): Record<string, string>
  /** Optional, with `deviceHeaders`: the Mac pins the device, so its pairing-only socket gets the full `ready`. */
  pinDevice?(deviceId: string): void
  stop(): Promise<void>
}
export type RelayHarness = { start(): Promise<RelayHandle> }

/** A running real bridge wired to FakeClaude (WP5). */
export type BridgeHandle = {
  claude: FakeClaude
  stop(): Promise<void>
}
export type BridgeHarness = {
  /**
   * Starts the real bridge pointed at `relay` in live mode, with `relay.bridgeKey` installed as its key, `pinned`
   * (device id -> public JWK) already in its devices.json, and a FakeClaude attached over stdio.
   */
  launch(relay: FakeRelay, pinned: Record<string, JwkP256T>): Promise<BridgeHandle>
  /**
   * Optional: restart the bridge process keeping its on-disk state (the old process is killed first, with the Claude side
   * not consuming).
   */
  restart?(handle: BridgeHandle): Promise<BridgeHandle>
}

/** Harness for a FakeRelay-backed relay (the kit's self test, and a template for WP1's harness). */
export function fakeRelayHarness(opts: { authHeaders?: boolean } = {}): RelayHarness {
  return {
    async start() {
      const { FakeRelay, TEST_DEVICE_HEADER, TEST_UNPINNED_HEADER } = await import('../fake-relay.ts')
      const origin = 'https://relay.example.com'
      const appHeaders: Record<string, string> = opts.authHeaders ? { 'X-Test-Session': 'owner', Origin: origin } : {}
      const relay = await new FakeRelay(
        opts.authHeaders ? { appAuth: { header: 'x-test-session', value: 'owner' }, origin } : {},
      ).start()
      return {
        wsBase: relay.wsBase,
        httpBase: relay.httpUrl,
        appHeaders,
        bridgeKey: relay.bridgeKey,
        mintStepup: (purpose) => relay.mintStepup(purpose),
        deviceHeaders: (deviceId, o = {}) => ({
          ...appHeaders,
          [TEST_DEVICE_HEADER]: deviceId,
          ...(o.pinned === false ? { [TEST_UNPINNED_HEADER]: '1' } : {}),
        }),
        pinDevice: (deviceId) => relay.pinDevice(deviceId),
        ...(opts.authHeaders
          ? {
              unauthenticatedHeaders: { Origin: origin },
              wrongOriginHeaders: { 'X-Test-Session': 'owner', Origin: 'https://evil.example.net' },
            }
          : {}),
        stop: () => relay.stop(),
      }
    },
  }
}
