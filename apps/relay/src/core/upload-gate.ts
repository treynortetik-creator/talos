// A small cap on bodies that are still being read before anyone has proved who sent them.
//
// The bridge signature covers the body. A request that carries the body's hash (the Mac's `x-talos-sha256` on every
// upload) is checked BEFORE the body is read, so a stranger cannot take a slot here: only a request that cannot be
// proven up front (an old peer without the hash, a frame post) is counted. The header check (`preflightBridgeHttp`)
// turns away strangers who do not know a trusted key id; this bounds the rest, so the worst case is a fixed amount of
// memory, not the sum of everything an attacker can open. The hook receiver shares the same counter.
//
// The header check cannot test the signature: it covers sha256(body), which is unknown until the body is read (or the
// caller sends the hash). So a hash-less read holds a slot until the body ends, the client leaves, or the 408 deadline
// fires (`readBodyWithDeadline`); the deadline is what makes every slot come back.
import type { RelayServices } from '../services.ts'

/** Media uploads in flight at once across all addresses. 6 x 50 MB is the most an unproven caller can make the relay hold. */
export const UNVERIFIED_READS_MAX = 6
/** Media uploads in flight at once from one address. The Mac sends its uploads one after another, so this is generous. */
export const UNVERIFIED_READS_PER_IP = 4
/** Frame posts (256 KiB at most, so 48 of them are 12 MiB) get their own pool: a stalled upload never blocks a frame. */
export const UNVERIFIED_FRAMES_MAX = 48
export const UNVERIFIED_FRAMES_PER_IP = 12
/** Hook bodies (1 MB at most): 32 in flight is 32 MB, and a delivery holds its slot for milliseconds. */
export const HOOK_READS_MAX = 32
export const HOOK_READS_PER_IP = 8
/** Bodies at or under this declared size skip the gate: the global cap already bounds them tightly. */
export const SMALL_BODY_BYTES = 64 * 1024

export class InflightGate {
  private total = 0
  private byIp = new Map<string, number>()
  constructor(
    private readonly max: number,
    private readonly perIp: number,
  ) {}

  /** How many reads hold a slot right now (for tests and diagnostics). */
  get inFlight(): number {
    return this.total
  }

  /** A release function, or null when the gate is full (in all, or for this address). Release is safe to call twice. */
  enter(ip: string): (() => void) | null {
    const mine = this.byIp.get(ip) ?? 0
    if (this.total >= this.max || mine >= this.perIp) return null
    this.total++
    this.byIp.set(ip, mine + 1)
    let done = false
    return () => {
      if (done) return
      done = true
      this.total--
      const n = (this.byIp.get(ip) ?? 1) - 1
      if (n <= 0) this.byIp.delete(ip)
      else this.byIp.set(ip, n)
    }
  }
}

type Pools = { media: InflightGate; frames: InflightGate; hooks: InflightGate }
const pools = new WeakMap<RelayServices, Pools>()
const poolsOf = (services: RelayServices): Pools => {
  let p = pools.get(services)
  if (!p) {
    p = {
      media: new InflightGate(UNVERIFIED_READS_MAX, UNVERIFIED_READS_PER_IP),
      frames: new InflightGate(UNVERIFIED_FRAMES_MAX, UNVERIFIED_FRAMES_PER_IP),
      hooks: new InflightGate(HOOK_READS_MAX, HOOK_READS_PER_IP),
    }
    pools.set(services, p)
  }
  return p
}
export const uploadGate = (services: RelayServices): InflightGate => poolsOf(services).media
export const frameGate = (services: RelayServices): InflightGate => poolsOf(services).frames
export const hookGate = (services: RelayServices): InflightGate => poolsOf(services).hooks
