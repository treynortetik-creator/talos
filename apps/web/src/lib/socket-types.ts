// The public types of the socket client: its options, the client itself, and what the queue keeps.
import type { DeviceKey } from '@talos-app/protocol'
import type { SendResult, TalosClient } from './client.ts'
import type { createMetaStore } from './connectionMeta.ts'
import type { FetchLike } from './http.ts'
import type { Storage } from './storage.ts'

export type OutboxKind = 'message' | 'voice_note' | 'voice.ask'
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
export type PendingVoice = {
  clientMsgId: string
  threadId: string
  mime: string
  name: string
  durationMs?: number
  waveform?: string
  blob: Blob
  order: number
  /** The device key that was signed in when it was queued; a note from another identity is never sent by this one. */
  deviceId?: string
  /** When it was recorded, so the row it gets back after a restart sits where it belongs. */
  createdAt?: string
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
  /** How long a queued voice note waits before its upload is tried again (default 10 s). */
  voiceRetryMs?: number
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
  setPinned(pinned: boolean): void
  /** Stores an offline voice note (blob kept in IndexedDB); it is uploaded and signed when the connection is back. */
  queueVoiceNote(args: {
    threadId: string
    blob: Blob
    durationMs?: number
    waveform?: string
    name: string
  }): Promise<SendResult>
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
