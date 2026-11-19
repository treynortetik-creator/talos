// BYOR phase 4 (docs/specs/BYOR-phase4-frame.md §3): POST /api/bridge/attest hands a phone's nonce to the LIVE Mac and gives its
// answer back. The relay does not check the signature: the phone does, against the key it pinned. Nothing here is stored: the
// request goes to the live socket only (never the outbox), at most `waiting` calls are held, and each leaves the map when it
// is answered or after 5 s, so a late or unmatched answer finds nothing and is dropped.
import { ATTEST_FEATURE, type FrameOf, newUlid } from '@talos-app/protocol'
import type { Clock } from '../services.ts'
import type { Hub } from './hub.ts'

/** How long a phone's call waits for the Mac. */
export const ATTEST_WAIT_MS = 5_000

type Answer = { pubkey: string; sig: string; chain: FrameOf<'attest.response'>['chain'] }

/** A token bucket: `capacity` at most, refilled `perSec` a second. */
export class Bucket {
  private tokens: number
  private at: number
  constructor(
    private readonly clock: Clock,
    readonly capacity: number,
    private readonly perSec: number,
  ) {
    this.tokens = capacity
    this.at = clock.now()
  }
  private refill(): void {
    const now = this.clock.now()
    this.tokens = Math.min(this.capacity, this.tokens + (Math.max(0, now - this.at) / 1000) * this.perSec) // a clock step back adds nothing
    this.at = now
  }
  take(): boolean {
    this.refill()
    if (this.tokens < 1) return false
    this.tokens -= 1
    return true
  }
  /** Seconds until one token is there (at least 1): the Retry-After of a 429. */
  waitS(): number {
    this.refill()
    return Math.max(1, Math.ceil((1 - this.tokens) / this.perSec))
  }
  get full(): boolean {
    this.refill()
    return this.tokens >= this.capacity
  }
}

const ADDRESSES_MAX = 5000

export type Gate = { ok: true } | { ok: false; retryAfterS: number }

/**
 * The route's limits, all in memory: per client address 1 per 2 s (burst 3); relay-wide PUBLIC 0.5 a second (burst 2), below
 * the Mac's own 1 a second so strangers cannot use up what the Mac will sign; and PAIRED 0.5 a second (burst 3), used INSTEAD
 * of the public one for a request that carries a valid owner session, so outside traffic cannot push the owner's phones
 * to "unverified".
 */
export class AttestLimits {
  private readonly byAddress = new Map<string, Bucket>()
  private readonly pub: Bucket
  private readonly paired: Bucket
  constructor(private readonly clock: Clock) {
    this.pub = new Bucket(clock, 2, 0.5)
    this.paired = new Bucket(clock, 3, 0.5)
  }
  address(ip: string): Gate {
    let b = this.byAddress.get(ip)
    if (!b) {
      if (this.byAddress.size >= ADDRESSES_MAX) this.makeRoom()
      b = new Bucket(this.clock, 3, 0.5)
      this.byAddress.set(ip, b)
    }
    return b.take() ? { ok: true } : { ok: false, retryAfterS: b.waitS() }
  }
  wide(paired: boolean): Gate {
    const b = paired ? this.paired : this.pub
    return b.take() ? { ok: true } : { ok: false, retryAfterS: b.waitS() }
  }
  /** Drops addresses whose bucket is full again (they hold nothing); if that is not enough, the oldest. */
  private makeRoom(): void {
    for (const [ip, b] of this.byAddress) if (b.full) this.byAddress.delete(ip)
    for (const ip of this.byAddress.keys()) {
      if (this.byAddress.size < ADDRESSES_MAX) break
      this.byAddress.delete(ip)
    }
  }
}

export type AttestHost = Pick<Hub, 'bridgeOnline' | 'bridgeFeatures' | 'toBridge' | 'onBridgeFrame'>

export type AttestResult =
  | { ok: true; answer: Answer }
  | { ok: false; status: 503; error: 'mac_offline' | 'attest_unsupported' }
  | { ok: false; status: 504; error: 'attest_timeout' }

export class AttestRouter {
  readonly limits: AttestLimits
  private readonly calls = new Map<string, { resolve: (a: Answer | null) => void; timer: unknown }>()

  constructor(
    private readonly clock: Clock,
    private readonly hub: AttestHost,
  ) {
    this.limits = new AttestLimits(clock)
    hub.onBridgeFrame('attest.response', (f) => this.onResponse(f))
  }

  /** Calls waiting for the Mac right now (tests). */
  get waiting(): number {
    return this.calls.size
  }

  /** Why the Mac cannot be asked right now, or null: no live bridge, or its hello does not list attest/1. */
  unavailable(): 'mac_offline' | 'attest_unsupported' | null {
    if (!this.hub.bridgeOnline()) return 'mac_offline'
    return this.hub.bridgeFeatures.has(ATTEST_FEATURE) ? null : 'attest_unsupported'
  }

  async ask(nonce: string): Promise<AttestResult> {
    const no = this.unavailable()
    if (no) return { ok: false, status: 503, error: no }
    const id = newUlid()
    const answered = new Promise<Answer | null>((resolve) => {
      const timer = this.clock.setTimeout(() => {
        this.calls.delete(id)
        resolve(null)
      }, ATTEST_WAIT_MS)
      this.calls.set(id, { resolve, timer })
    })
    // live socket only: a non-durable frame is never stored or queued, and with no bridge it goes nowhere
    await this.hub.toBridge({ type: 'attest.request', id, nonce }, { durable: false })
    const a = await answered
    return a ? { ok: true, answer: a } : { ok: false, status: 504, error: 'attest_timeout' }
  }

  private onResponse(f: FrameOf<'attest.response'>): void {
    const call = this.calls.get(f.ref)
    if (!call) return // late or unmatched: dropped silently
    this.calls.delete(f.ref)
    this.clock.clearTimeout(call.timer)
    call.resolve({ pubkey: f.pubkey, sig: f.sig, chain: f.chain })
  }

  /** The relay is stopping: every waiting call ends as if the Mac had not answered. */
  stop(): void {
    for (const [id, c] of this.calls) {
      this.clock.clearTimeout(c.timer)
      this.calls.delete(id)
      c.resolve(null)
    }
  }
}
