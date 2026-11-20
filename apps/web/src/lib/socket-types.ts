// The public types of the socket client: its options, the client itself, and what the queue keeps.
import type { DeviceKey } from '@talos-app/protocol'
import type { TalosClient } from './client.ts'
import type { createMetaStore } from './connectionMeta.ts'
import type { FetchLike } from './http.ts'
import type { Storage } from './storage.ts'

export type OutboxKind = 'message'
export type OutboxEntry = {
  /** Frame id (also the storage key). */
  id: string
  order: number
  kind: OutboxKind
  clientMsgId: string
  threadId: string
  /** The signed frame exactly as serialized. Resent unchanged. */
  bytes: string
  /**
   * When it was first written to a socket. `null`: never written. Absent (an entry saved by an older build): treated as
   * written, because that build did not say. Saved before the write, so a crash in between counts as written too.
   */
  writtenAt?: number | null
}
export type SocketClientOptions = {
  storage: Storage
  /** `wss://host/ws`; default derives from `location`. */
  wsUrl?: string
  fetchImpl?: FetchLike
  WebSocketImpl?: typeof WebSocket
  clientInfo?: { version: string; standalone: boolean; platform: string }
  /** Backoff: base ms, max ms, jitter 0..1 (random source injectable for tests). */
  backoff?: { baseMs?: number; maxMs?: number; random?: () => number }
  isVisible?: () => boolean
  /** How long a queued frame waits before the flush is tried again after a send that could not be saved (default 10 s). */
  flushRetryMs?: number
  /** How long a socket let go of may still deliver an inbox answer before its changes go out again (default 2 s). */
  inboxAnswerGraceMs?: number
  isOnline?: () => boolean
  now?: () => number
  /** Persisted render cache cap per thread. */
  cacheLimit?: number
}

export interface SocketClient extends TalosClient {
  readonly meta: ReturnType<typeof createMetaStore>
  /** Loads the cache and the device key, then connects (when a key exists). */
  start(opts?: { pinned?: boolean }): Promise<void>
  /**
   * Creates the device key if this storage jar has none. Used by enrollment. `replace` throws the stored key away and
   * makes a new one: for a device the Mac revoked, whose old key the relay will never accept again.
   */
  ensureDevice(opts?: { replace?: boolean }): Promise<DeviceKey>
  deviceKey(): Promise<DeviceKey | null>
  /** Calls `fn` whenever the queue is wiped (a sign-out that keeps nothing, or a replaced key): what a screen keeps in
   * memory for the same session must go too. Returns the way to stop listening. */
  onQueueWiped(fn: () => void): () => void
  setPinned(pinned: boolean): void
  /** Number of signed owner frames waiting for a connection or a pin. */
  outboxSize(): number
  /** Resends a failed owner message with the identical signed bytes. */
  retryMessage(clientMsgId: string): void
  /** Removes a message that never reached the Mac (queued or failed): from the outbox, the timeline and the failed list. */
  discardMessage(clientMsgId: string): Promise<void>
  /** Asks the Mac to re-upload media older than the relay buffer (`media.fetch`); `media.ready` follows. */
  fetchMedia(mediaId: string): void
}

export type Pending = {
  resolve: (seq: number | undefined) => void
  reject: (e: Error) => void
  timer: ReturnType<typeof setTimeout>
}

// Inbox Done/Snooze not yet acknowledged by the relay, newest per item; kept across reloads and sent on every `ready`.
export type InboxPatch = { state?: 'new' | 'read' | 'snoozed' | 'done'; snoozeUntil?: string }
/** How the relay answered a queued inbox change: took it, could not save it (try again), or refused it for good. */
export type InboxOutcome = 'acked' | 'retry' | 'refused'
