// What FakeRelay's modules share: the option and record types, and the frame-type sets the relay routes by. No state.
import type { IncomingMessage } from 'node:http'
import {
  type AgentConfigT,
  CONSUMABLE_FRAME_TYPES,
  HEARTBEAT_OWNER_FRAME_TYPES,
  SCHEDULE_OWNER_FRAME_TYPES,
  V2_READ_OWNER_FRAME_TYPES,
} from '@talos-app/protocol'

export type RelayDirection = 'from_app' | 'from_bridge' | 'to_app' | 'to_bridge'

export type FakeRelayOptions = {
  host?: string
  /** 'enforce' (default): hello signature, key_id and HTTP signatures are checked with `relay.bridgeKey`. */
  bridgeAuth?: 'enforce' | 'off'
  helloTimeoutMs?: number
  agentConfig?: AgentConfigT
  /** Require this header on the /ws upgrade (stands in for the session cookie): 401 without it. */
  appAuth?: { header: string; value: string }
  /** Require `Origin` to equal this on /ws: 403 otherwise. */
  origin?: string
  /** Oldest seq the relay still buffers. A catch-up from before it gets `catchup.reset{min_seq}`. */
  bufferFloor?: number
  /**
   * Like the real hub's FrameRejected: refuse a durable bridge frame with `error{ref}` and no ack (nothing is stored).
   * Return undefined to accept it.
   */
  rejectBridgeFrame?: (frame: Record<string, unknown>) => { code: string; message: string } | undefined
  /**
   * What this relay supports, sent to the bridge in `ready.features` (docs/SCHEDULES.md S1.5: the bridge mints no
   * schedule card until it lists `schedules/1`). Default `['schedules/1']`; pass `[]` to play an older relay.
   */
  relayFeatures?: string[]
  /** `ready.features` the APP sees (what a real relay lists, e.g. 'share/1'). Default none, like a relay with the feature off. */
  appFeatures?: string[]
  /**
   * What POST /bridge/devices/:id/revoke says about the passkey. `true`/`false` play a relay that reports it; leave it out to
   * play a relay from before the field existed (the answer is then just `{ ok: true }`).
   */
  revokeSharedPasskey?: boolean
  /** The relay's clock for card expiry. Default `Date.now`; pass a test's injected clock when the Mac runs on one. */
  now?: () => number
}

/**
 * Upgrade headers that bind an app socket to a device, the way the real relay's session cookie does. They are the same
 * two headers the real relay's test sign-in understands (apps/relay/test/helpers/test-auth.ts), so one contract drives both.
 *   X-Test-Device    the session belongs to this device id: a hello or an owner frame from another device is refused.
 *   X-Test-Unpinned  the Mac has not pinned the device yet: pairing only, until `relay.pinDevice(id)` or a `device.pinned`.
 */
export const TEST_DEVICE_HEADER = 'x-test-device'
export const TEST_UNPINNED_HEADER = 'x-test-unpinned'

export type BufferEntry = { frame: Record<string, unknown>; delivered: boolean; consumed: boolean }
export type HttpRecord = {
  method: string
  path: string
  headers: IncomingMessage['headers']
  body: Buffer
  status: number
}

// session.control is consumable (docs/CLAUDE-CODE.md C2.5): kept until the bridge records its result.
export const CONSUMABLE = new Set<string>([
  ...CONSUMABLE_FRAME_TYPES,
  'session.control',
  'thread.session.control',
  'agent.recover',
])
export const BRIDGE_DURABLE = new Set([...CONSUMABLE, 'config.patch', 'device.enrolled', 'device.revoked'])
export const OWNER_FRAMES = new Set([
  'message',
  'voice_note',
  'card.resolve',
  'config.patch',
  'voice.ask',
  'session.control',
])
// docs/SCHEDULES.md S4: never stored or buffered, seq-less dedup, request/response by request_id, mac_offline at once.
export const SCHEDULE_OWNER = new Set<string>([...SCHEDULE_OWNER_FRAME_TYPES, ...HEARTBEAT_OWNER_FRAME_TYPES])
export const V2_READ = new Set<string>(V2_READ_OWNER_FRAME_TYPES)
export const CATCHUP_PAGE = 200

/** What an UNPINNED app socket may receive and send (core/hub.ts PAIRING_OUT / PAIRING_IN). */
export const PAIRING_OUT = new Set(['ready', 'presence', 'device.pinned', 'ack', 'error', 'ping', 'pong'])
export const PAIRING_IN = new Set(['hello', 'ping', 'pong', 'visibility'])

/** Bridge frames the relay stamps, acks and remembers by id (core/hub.ts processBridgeDurable). */
export const BRIDGE_STORED = new Set([
  'reply',
  'card.create',
  'card.update',
  'transcript',
  'thread.upsert',
  'thread.archive',
  'config.sync',
  'inbox.update',
  'device.pinned',
  'session.control.result',
  'agent.recover.result',
  'app.update',
])
/** Bridge frames that reach the apps. */
export const BRIDGE_TO_APPS = new Set([
  'reply',
  'card.create',
  'card.update',
  'transcript',
  'receipt',
  'status',
  'thread.upsert',
  'thread.archive',
  'config.sync',
  'inbox.update',
  'history.page',
  'device.pinned',
  'session.state',
  'session.inventory',
  'session.control.result',
  'agent.recover.result',
  'session.agents',
  'workers.status',
  'app.update',
])

export function safeJson(b: Buffer): unknown {
  try {
    return JSON.parse(b.toString('utf8'))
  } catch {
    return undefined
  }
}
