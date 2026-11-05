// How the bridge gets frames to the relay. The live bridge sends over the socket, keeps every durable frame in a
// persisted outbox until the relay acks it, and falls back to the signed HTTP API; headless processes only have HTTP.
import { type Frame, MAX_FRAME_BYTES } from '@talos-app/protocol'
import type { Clock } from './clock.ts'
import type { HistoryStore } from './history-store.ts'
import type { Logger } from './log.ts'
import { type BridgeToRelayFrame, HTTP_POSTABLE, type RelayHttp } from './relay-http.ts'

export type DurableResult = { state: 'acked'; seq?: number } | { state: 'queued' }

export interface Transport {
  readonly live: boolean
  /** Frames the relay stores (reply, card.*, transcript, thread.*, config.sync, inbox.update, device.pinned). */
  sendDurable(frame: Frame): Promise<DurableResult>
  /** ack, error, receipt, status, voice.progress, history.page. Dropped when there is no socket. */
  sendEphemeral(frame: Frame): boolean
}

/** What the transport needs from the socket (RelayClient implements it). */
export type Wire = { readonly connected: boolean; send(frame: Record<string, unknown>): boolean }

export const ACK_WAIT_MS = 8000
/**
 * A durable row the relay still has not acked after this long is given up on. Reconnect count never drops a row: a
 * flappy link (relay redeploy, Mac sleep and wake) must not lose a reply. Generous on purpose.
 */
export const OUTBOX_RETENTION_MS = 24 * 3_600_000

/** The relay closes the socket (and HTTP answers 413) for any frame whose JSON text is over MAX_FRAME_BYTES. */
export class FrameTooLargeError extends Error {
  constructor(
    readonly type: string,
    readonly bytes: number,
  ) {
    super(`${type} frame is too large (${bytes} bytes; the relay accepts at most ${MAX_FRAME_BYTES}). Shorten it.`)
  }
}

/** The relay answered a durable frame with error{ref}: it will never accept it, so it is not retried. */
export class RelayRejectedError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(`the relay rejected it (${code}): ${message}`)
  }
}

/**
 * An older relay answers a card of a kind it has never heard of with `bad_frame` at `card.kind`. That is the relay being
 * behind, not the card being wrong, and the agent should hear which, so the owner is told to update the relay.
 */
export function refusedCardKind(type: string | undefined, json: string | undefined, code: string, message: string) {
  if (type !== 'card.create' || code !== 'bad_frame' || !/ at card\.kind$/.test(message) || !json) return undefined
  try {
    const kind = (JSON.parse(json) as { card?: { kind?: unknown } }).card?.kind
    return typeof kind === 'string' ? kind : undefined
  } catch {
    return undefined
  }
}

export type DropReason = 'too_large' | 'expired' | 'refused'

export const frameBytes = (frame: unknown): number => Buffer.byteLength(JSON.stringify(frame))

export function assertFrameFits(frame: { type: string }): void {
  const bytes = frameBytes(frame)
  if (bytes > MAX_FRAME_BYTES) throw new FrameTooLargeError(frame.type, bytes)
}

type Settled = { seq: number | undefined } | { rejected: RelayRejectedError }

export class LiveTransport implements Transport {
  readonly live = true
  private waiters = new Map<string, (r: Settled) => void>()

  constructor(
    private readonly client: Wire,
    private readonly store: HistoryStore,
    private readonly http: RelayHttp,
    private readonly clock: Clock,
    private readonly log: Logger,
    /** Called for every row given up on, so the agent can be told. */
    private readonly onDrop: (row: {
      id: string
      type: string
      reason: DropReason
      cardKind?: string
    }) => void = () => {},
  ) {}

  /** The relay's `ack{ref, seq}` for something we sent. */
  onAck(ref: string, seq: number | undefined) {
    const row = this.store.outboxGet(ref)
    this.store.outboxDelete(ref)
    if (seq !== undefined && row?.type === 'reply') {
      try {
        this.store.setSeq((JSON.parse(row.json) as { message: { id: string } }).message.id, seq)
      } catch {
        // a malformed row cannot be linked to a message; the ack still counts
      }
    }
    const w = this.waiters.get(ref)
    if (w) {
      this.waiters.delete(ref)
      w({ seq })
    }
  }

  /** The relay's `error{ref}` for a frame we sent: a durable frame it refused is dropped from the outbox for good. */
  onError(ref: string, code: string, message: string): boolean {
    const row = this.store.outboxGet(ref)
    const w = this.waiters.get(ref)
    if (!row && !w) return false
    this.store.outboxDelete(ref)
    const kind = refusedCardKind(row?.type, row?.json, code, message)
    this.log.warn('relay rejected a durable frame; dropped from the outbox', {
      type: row?.type,
      id: ref,
      code,
      ...(kind ? { card_kind: kind } : {}),
    })
    if (w) {
      this.waiters.delete(ref)
      const why = kind ? `${message}. The relay does not know the card kind "${kind}". Update the relay.` : message
      w({ rejected: new RelayRejectedError(code, why) })
    } else if (row) {
      // nobody is waiting on it (a row resent after a reconnect): the agent was told "queued", so it must hear this
      this.onDrop({ id: row.id, type: row.type, reason: 'refused', ...(kind ? { cardKind: kind } : {}) })
    }
    return true
  }

  sendEphemeral(frame: Frame): boolean {
    return this.client.send(frame as unknown as Record<string, unknown>)
  }

  async sendDurable(frame: Frame): Promise<DurableResult> {
    assertFrameFits(frame)
    this.store.outboxAdd(frame.id, frame.type, JSON.stringify(frame), this.clock.now())
    if (this.client.connected) {
      const acked = new Promise<Settled>((resolve) => this.waiters.set(frame.id, resolve))
      let timer: unknown
      const timeout = new Promise<'timeout'>((resolve) => {
        timer = this.clock.setTimeout(() => resolve('timeout'), ACK_WAIT_MS)
      })
      this.client.send(frame as unknown as Record<string, unknown>)
      const r = await Promise.race([acked, timeout])
      this.clock.clearTimeout(timer)
      if (r !== 'timeout') {
        if ('rejected' in r) throw r.rejected
        return { state: 'acked', ...(r.seq !== undefined ? { seq: r.seq } : {}) }
      }
      this.waiters.delete(frame.id)
    }
    if (HTTP_POSTABLE.has(frame.type)) {
      try {
        const res = await this.http.post(frame as BridgeToRelayFrame)
        this.onAck(frame.id, res.ack.seq)
        return { state: 'acked', ...(res.ack.seq !== undefined ? { seq: res.ack.seq } : {}) }
      } catch (e) {
        this.log.warn('http post fallback failed', { type: frame.type, error: (e as Error).message })
      }
    }
    return { state: 'queued' }
  }

  private expired(createdAt: number): 'expired' | undefined {
    return this.clock.now() - createdAt > OUTBOX_RETENTION_MS ? 'expired' : undefined
  }

  /**
   * After `ready`: resend every durable frame the relay has not acked, oldest first. Receivers dedupe on id.
   * `idleOnly` (a periodic retry on a link that stayed up) skips a row whose own send is still waiting for its ack.
   */
  flushOutbox(opts: { idleOnly?: boolean } = {}) {
    for (const row of this.store.outboxList()) {
      if (opts.idleOnly && this.waiters.has(row.id)) continue
      // a row the relay cannot take (too big) would make it hang up on every `ready`; one older than the retention
      // window is given up on. A plain missing ack is retried on every `ready`.
      const reason = Buffer.byteLength(row.json) > MAX_FRAME_BYTES ? 'too_large' : this.expired(row.created_at)
      if (reason) {
        this.log.warn('dropping an undeliverable outbox row', { type: row.type, id: row.id, reason })
        this.store.outboxDelete(row.id)
        this.onDrop({ id: row.id, type: row.type, reason })
        continue
      }
      try {
        const frame = JSON.parse(row.json) as Record<string, unknown>
        if (opts.idleOnly && !this.client.connected) continue
        this.store.outboxAttempt(row.id)
        this.client.send(frame)
      } catch {
        this.store.outboxDelete(row.id)
      }
    }
  }
}

export class HttpTransport implements Transport {
  readonly live = false
  constructor(private readonly http: RelayHttp) {}

  async sendDurable(frame: Frame): Promise<DurableResult> {
    assertFrameFits(frame)
    if (!HTTP_POSTABLE.has(frame.type)) throw new Error(`${frame.type} needs a live session (TALOS_APP_BRIDGE=1)`)
    const res = await this.http.post(frame as BridgeToRelayFrame)
    return { state: 'acked', ...(res.ack.seq !== undefined ? { seq: res.ack.seq } : {}) }
  }

  sendEphemeral(): boolean {
    return false
  }
}
