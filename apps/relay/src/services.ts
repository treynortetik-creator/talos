// The services every relay module receives. Seam: frozen after WP0 (WP8 may edit). Code against these interfaces;
// WP1 provides the implementations, tests provide fakes.
import type { AgentConfigT, AttachmentRefT, FrameOf, FrameType, PushIntent, PushPayloadT } from '@talos-app/protocol'
import type Database from 'better-sqlite3'
import type { RelayEnv } from './env.ts'

export interface Clock {
  now(): number
  setTimeout(fn: () => void, ms: number): unknown
  clearTimeout(handle: unknown): void
}

export interface Logger {
  debug(obj: object | string, msg?: string): void
  info(obj: object | string, msg?: string): void
  warn(obj: object | string, msg?: string): void
  error(obj: object | string, msg?: string): void
  child(bindings: Record<string, unknown>): Logger
}

/** Who sent an inbound frame. */
export interface AppFrameContext {
  socketId: string
  deviceId: string | null
  /** The object exactly as parsed from the wire (signatures are over this, never over a zod-parsed value). */
  raw: Record<string, unknown>
  reply(frame: Record<string, unknown>): void
}
export interface BridgeFrameContext {
  keyId: string
  raw: Record<string, unknown>
  reply(frame: Record<string, unknown>): void
}

export interface Bus {
  /**
   * Sends a frame to every app socket. Durable frames get a `relay.seq` and are written to the buffer first.
   * `onlyDeviceId` targets one device (e.g. an error for one socket). `once` (durable only) is a seen id stored with the
   * frame: a second call with the same key stores and sends nothing.
   */
  toApps(
    frame: Record<string, unknown>,
    opts?: { durable?: boolean; onlyDeviceId?: string; once?: string },
  ): Promise<void>
  /**
   * Sends a frame to the live bridge. `durable` frames get a `relay.seq`, are buffered for `ttl_s` and re-sent on
   * reconnect. Two-stage ack: frames in CONSUMABLE_FRAME_TYPES stay in the buffer until the bridge acks them with stage
   * 'consumed'. On EVERY bridge hello the relay re-sends all unconsumed frames (delivered or not) in `relay.seq` order,
   * so a crash never reorders messages; `replay.request{ids}` from the bridge is an optional hint with the same result.
   * Other durable frames leave the buffer on 'delivered'.
   * `resume`: the caller made the frame id itself and re-sends it until it knows the frame was queued, so a frame of the
   * same type already stored under that id is that frame (only a missing queue row is added). Without it a repeated id is an error.
   */
  toBridge(
    frame: Record<string, unknown>,
    opts: { durable: boolean; ttl_s?: number; resume?: boolean },
  ): Promise<{ queued: boolean }>
  onAppFrame<T extends FrameType>(
    type: T,
    handler: (frame: FrameOf<T>, ctx: AppFrameContext) => void | Promise<void>,
  ): void
  onBridgeFrame<T extends FrameType>(
    type: T,
    handler: (frame: FrameOf<T>, ctx: BridgeFrameContext) => void | Promise<void>,
  ): void
  bridgeOnline(): boolean
  /** A session's turn ended: idle the 'working' rows it owned. Optional so test buses need not implement it. */
  settleWorking?(scope: 'main' | { thread_id: string }): void
  /** Adds fields to the app's `ready` frame. Optional so test buses need not implement it. */
  readyExtra?(fn: () => Record<string, unknown>): void
  /**
   * Re-checks every live app socket against the auth store: a socket whose session is gone is closed (4401), one whose
   * device is no longer pinned goes back to pairing-only, and one whose device the Mac just pinned gets its real
   * `ready`. Call after anything that deletes sessions or changes pinning.
   */
  revalidateApps(): void
}

/** Web Push today; APNs in Phase 2 (spec 14). */
export interface PushTransport {
  readonly name: 'webpush' | 'apns'
  send(
    subscription: { endpoint: string; keys: { p256dh: string; auth: string } },
    payload: PushPayloadT,
    /** `secondsLeft`: how long the thing the push is about has left; a card push is not kept past it. */
    opts?: { secondsLeft?: number },
  ): Promise<{ ok: boolean; gone: boolean }>
}

/** The readable part of a push, for phones that can open a seal. The text is already the plain words, not markdown. */
export type RichPushInput = {
  text: string
  /** A card push only: which card, and what it is worth, so the phone can offer Approve and bind it to what it shows. */
  card?: { id: string; risk: 'low' | 'high'; payload_hash: string }
  /** A card push the owner can only deny: the push gets the Open-only category, with or without a seal. */
  openOnly?: boolean
}

export interface PushService {
  /**
   * Builds the fixed-template payload (never message text) and sends it to every subscription of the owner. `opts.rich` is
   * the text a phone that registered a grant may read: it is sealed to that phone's key and never put in the alert, in a
   * web push or in a log.
   */
  notify(intent: PushIntent, opts?: { rich?: RichPushInput }): Promise<void>
}

export interface MediaStore {
  put(args: { bytes: Uint8Array; mime: string; name: string; durationMs?: number }): Promise<AttachmentRefT>
  get(mediaId: string): Promise<{ bytes: Uint8Array; mime: string; name: string; sha256: string } | null>
  remove(mediaId: string): Promise<void>
}

export interface CryptoService {
  /** AES-256-GCM with DATA_KEY, random 12-byte IV, AAD = table + row id. */
  encrypt(plain: Uint8Array, aad: string): Uint8Array
  decrypt(blob: Uint8Array, aad: string): Uint8Array
}

export interface RelayServices {
  db: Database.Database
  bus: Bus
  push: PushService
  media: MediaStore
  crypto: CryptoService
  /** Last agent config synced from the Mac, or null before the first `config.sync`. */
  agentConfig(): AgentConfigT | null
  clock: Clock
  log: Logger
  env: RelayEnv
}

/** Hono app type shared by every sub-app. `routes.ts` puts the services on the context. */
export type AppEnv = { Variables: { services: RelayServices } }
