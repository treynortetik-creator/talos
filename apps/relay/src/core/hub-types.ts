// What the hub files share: the socket shapes, the timing and size constants, the frame sets that decide who may send
// or receive what, and the rejection error. hub.ts re-exports the pieces other code imports from it.
import { CONSUMABLE_FRAME_TYPES } from '@talos-app/protocol'
import type { Session } from '../auth/contract.ts'
import type { RelayEnv } from '../env.ts'
import type { AppFrameContext, BridgeFrameContext, Clock, Logger } from '../services.ts'
import type { FileMediaStore } from './media.ts'
import type { CorePush } from './push.ts'
import type { Store } from './store.ts'

/** App frames whose module handlers do the durable write, so the hub runs them before it acks (see `inbox.update`). */
export const HANDLERS_RUN_BEFORE_ACK: ReadonlySet<string> = new Set(['inbox.update'])

export interface Conn {
  send(text: string): void
  close(code: number, reason?: string): void
  terminate(): void
}

export const CATCHUP_PAGE = 200
export const REF_TTL_MS = 10 * 60_000
export const HANDSHAKE_MS = 10_000
export const PING_MS = 25_000
export const DEAD_MS = 75_000
export const QUEUE_CAP = 500
export const TWO_STAGE_KEY = 'bridge_two_stage' // set once the bridge sends a `consumed` ack
export const BURST = 60
export const RATE_PER_S = 30
export const BACKLOG_AFTER_MS = 15 * 60_000
export const SESSION_STOPPED_AFTER_MS = 5 * 60_000
export const QUEUED_AFTER_MS = 30_000
export const RESEND_MS = [5_000, 30_000, 120_000]
// session.control is consumable once the bridge records its result (docs/CLAUDE-CODE.md C2.5); the protocol lists it apart.
// thread.session.control (docs/OPTION-C.md) follows the same rule.
export const CONSUMABLE = new Set<string>([
  ...CONSUMABLE_FRAME_TYPES,
  'session.control',
  'thread.session.control',
  'agent.recover',
])

/** What an UNPINNED app socket may receive and send: enough to finish pairing and nothing of the owner's data. */
export const PAIRING_OUT = new Set(['ready', 'presence', 'device.pinned', 'ack', 'error', 'ping', 'pong'])
export const PAIRING_IN = new Set(['hello', 'ping', 'pong', 'visibility'])
/**
 * App frames that show a person at the device, for the "last used" time. An action the owner took (send, resolve a card,
 * change a setting, mark unread, ask the voice agent) or a "visible" report, which the app sends on a touch, a key or a
 * return to the screen. Not here: ping/pong, catch-up, history, media and read marks, which an app sends by itself.
 */
export const SHOWS_A_PERSON = new Set([
  'message',
  'voice_note',
  'card.resolve',
  'config.patch',
  'thread.unread',
  'voice.ask',
  'visibility',
])

export type AppConn = {
  id: string
  conn: Conn
  ip: string
  session: Session | null
  deviceId: string | null
  authed: boolean
  visible: boolean
  /** Relay clock time of the last sign someone is at this screen: a hello, or any visibility frame (the web app re-sends one on activity). */
  activeAt: number
  lastInbound: number
  queue: string[]
  draining: boolean
  tokens: number
  refilledAt: number
  handshake: unknown
  /** The session's device is not pinned (yet): it gets an empty `ready` and may only finish pairing. */
  limited: boolean
  helloSeq: number
}
export type BridgeConn = {
  id: string
  conn: Conn
  ip: string
  authed: boolean
  keyId: string
  lastInbound: number
  handshake: unknown
  /** `hello.client.features`, echoed in `ready` and `presence` (docs/SCHEDULES.md S1.5). */
  features: string[]
}

export const HISTORY_REQ_TTL_MS = 2 * 60_000
export const HISTORY_FRAME_ID_MS = 24 * 3600_000

export type Ref = { socketId: string; threadId: string | null; at: number; volatile?: boolean }
export type AppHandler = (frame: never, ctx: AppFrameContext) => void | Promise<void>
export type BridgeHandler = (frame: never, ctx: BridgeFrameContext) => void | Promise<void>

/** A rejection with a protocol error code (WS: error frame; HTTP: 400). */
export class FrameRejected extends Error {
  constructor(
    readonly code: 'bad_frame' | 'internal',
    message: string,
  ) {
    super(message)
  }
}

/** A visible screen with no activity report for this long is not someone being there (pushes go to the phone). */
export const PRESENCE_WINDOW_MS = 60_000

export type HubDeps = {
  store: Store
  clock: Clock
  log: Logger
  env: RelayEnv
  push: CorePush
  media: FileMediaStore
  /** How long after its last activity report a visible screen still counts as someone being there. Default 60 s. */
  presenceWindowMs?: number
}
