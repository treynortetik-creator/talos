// Token buckets (spec 5.4 rate-limit table) and the bridge-hello IP block. In memory: a restart resets them, which is
// fine for a single-owner relay. Time comes from the injected clock so tests drive it with a fake one.
import type { Clock } from '../services.ts'

type Limit = { capacity: number; windowMs: number }

const MIN = 60_000
const HOUR = 3600_000
const DAY = 24 * HOUR

/** Every limit applies per key (the client IP for most surfaces, a constant for the global ones). */
export const LIMITS: Record<string, Limit[]> = {
  auth: [
    { capacity: 10, windowMs: MIN },
    { capacity: 50, windowMs: DAY },
  ],
  // Step-up (options + verify = 2 calls per Face-ID approval) is separate from the login budget, so approving cards
  // cannot lock the owner out of signing in. Both routes need a pinned session.
  stepup: [
    { capacity: 30, windowMs: MIN },
    { capacity: 500, windowMs: DAY },
  ],
  // Device proof in place (options + prove, run on page loads): its own budget so opening the app all day cannot use up the
  // sign-in budget above and lock out login or "Sign out everywhere". Only a signed-in session reaches it.
  prove: [
    { capacity: 30, windowMs: MIN },
    { capacity: 2000, windowMs: DAY },
  ],
  // Device revoke is a rare tap. Its own bucket, so a stranger hammering it cannot spend the sign-in budget.
  revoke: [{ capacity: 20, windowMs: MIN }],
  ws: [{ capacity: 30, windowMs: MIN }],
  bridge_ws: [{ capacity: 10, windowMs: MIN }],
  bridge_http: [{ capacity: 600, windowMs: MIN }],
  hook: [{ capacity: 600, windowMs: MIN }],
  /** Per connection (keyed by connection id): spec 5.4. */
  hook_conn: [{ capacity: 120, windowMs: MIN }],
  media: [{ capacity: 60, windowMs: HOUR }],
  // Native push registration (WP-I5): a phone registers on a tap and refreshes once per open.
  push_apns: [{ capacity: 60, windowMs: HOUR }],
  // Reply / Approve from a notification (no cookie: the signature is the credential). Per IP, checked before any signature work.
  native_act: [
    { capacity: 30, windowMs: MIN },
    { capacity: 600, windowMs: DAY },
  ],
  voice: [{ capacity: 10, windowMs: HOUR }],
  // Dictation: a tap per message. One budget for the owner; the daily megabyte cap (DICTATE_DAILY_MAX_MB) is on top.
  dictate: [{ capacity: 40, windowMs: HOUR }],
  // Schedules (docs/SCHEDULES.md S2.4). sched_read is keyed per socket; the rest are one budget for the single owner.
  sched_read: [{ capacity: 12, windowMs: MIN }],
  sched_patch: [{ capacity: 30, windowMs: HOUR }],
  sched_run_now: [{ capacity: 20, windowMs: HOUR }],
  sched_control: [{ capacity: 60, windowMs: HOUR }],
  sched_retry: [{ capacity: 6, windowMs: HOUR }],
  // Heartbeat test runs (docs/HEARTBEAT.md): each one starts real programs on the Mac, so 6 an hour for the owner.
  heartbeat_test: [{ capacity: 6, windowMs: HOUR }],
  // v2 features (docs/V2-FEATURES.md V3.4, V4.5, V5.4). search and memory are keyed per socket; share per IP / token.
  search: [{ capacity: 120, windowMs: MIN }],
  memory: [{ capacity: 60, windowMs: MIN }],
  // Read aloud: the first ask of a tap plus about one follow-up per 1.5 s while the Mac makes the audio.
  speak: [{ capacity: 90, windowMs: MIN }],
  // Signed history pages and media re-uploads, per socket: a page or a file per tap is far under these.
  history: [{ capacity: 60, windowMs: MIN }],
  media_fetch: [{ capacity: 120, windowMs: MIN }],
  // MCP Apps (spec M4.6): app.request, one budget for the owner (sockets and reconnects share it), on top of the 30/s app-frame bucket.
  app_request: [{ capacity: 60, windowMs: MIN }],
  // Problem reports (docs/ERRORS.md): one budget for the owner, however many pages and devices send.
  problems: [{ capacity: 30, windowMs: HOUR }],
  share_ip: [{ capacity: 10, windowMs: MIN }],
  share_token: [{ capacity: 30, windowMs: HOUR }],
}

/** Names whose bucket is shared by every caller (a single-owner relay: one bucket is the whole budget). */
const GLOBAL = new Set([
  'hook',
  'media',
  'problems',
  'voice',
  'dictate',
  'sched_patch',
  'sched_run_now',
  'sched_control',
  'sched_retry',
  'heartbeat_test',
  'app_request',
])

const SWEEP_ABOVE = 5000
const SWEEP_EVERY_MS = 30_000
const MAX_BUCKETS = 20_000

type Bucket = { tokens: number; at: number }

export type TakeResult = { ok: true } | { ok: false; retryAfterS: number }

export class RateLimiter {
  private buckets = new Map<string, Bucket[]>()
  private lastSweepAt = Number.NEGATIVE_INFINITY
  /** `overrides` replace the built-in limits for the names they list (the relay's env settings); the rest stay as written. */
  constructor(
    private clock: Clock,
    private overrides: Record<string, Limit[]> = {},
  ) {}

  private limitsFor(name: string): Limit[] | undefined {
    return this.overrides[name] ?? LIMITS[name]
  }

  /** Takes `cost` tokens from every limit of `name` for `key`. A rejected call takes nothing. */
  take(name: string, key: string, cost = 1): TakeResult {
    const limits = this.limitsFor(name)
    if (!limits) return { ok: true }
    const now = this.clock.now()
    const id = `${name}:${GLOBAL.has(name) ? '*' : key}`
    let state = this.buckets.get(id)
    if (!state) {
      state = limits.map((l) => ({ tokens: l.capacity, at: now }))
      this.buckets.set(id, state)
      if (this.buckets.size > SWEEP_ABOVE) this.makeRoom(now)
    }
    let wait = 0
    limits.forEach((l, i) => {
      const b = state[i] as Bucket
      b.tokens = Math.min(l.capacity, b.tokens + (Math.max(0, now - b.at) * l.capacity) / l.windowMs) // a clock step back adds nothing
      b.at = now
      if (b.tokens < cost) wait = Math.max(wait, ((cost - b.tokens) * l.windowMs) / l.capacity)
    })
    if (wait > 0) return { ok: false, retryAfterS: Math.max(1, Math.ceil(wait / 1000)) }
    for (const b of state) b.tokens -= cost
    return { ok: true }
  }

  /** Number of keys held (tests and diagnostics). */
  get size(): number {
    return this.buckets.size
  }

  /**
   * Keeps the table bounded without stalling the loop. A full sweep is O(n), so it runs at most once per SWEEP_EVERY_MS
   * (a flood of new keys used to trigger one per request, each freeing nothing). If the table is still over MAX_BUCKETS
   * the oldest keys go: an evicted key only starts a fresh budget, and the attacker who filled the table gains nothing a
   * fresh address would not already give.
   */
  private makeRoom(now: number): void {
    if (now - this.lastSweepAt >= SWEEP_EVERY_MS || now < this.lastSweepAt) {
      this.lastSweepAt = now
      this.sweep(now)
    }
    for (const id of this.buckets.keys()) {
      if (this.buckets.size <= MAX_BUCKETS) break
      this.buckets.delete(id)
    }
  }

  private sweep(now: number): void {
    for (const [id, state] of this.buckets) {
      const limits = this.limitsFor(id.slice(0, id.indexOf(':'))) ?? []
      if (state.every((b, i) => now - b.at > (limits[i]?.windowMs ?? 0))) this.buckets.delete(id)
    }
  }
}

/** Per-socket frame budget: 30 frames/s, burst 60 (spec 5.4). */
export class FrameBudget {
  private tokens = 60
  private at: number
  constructor(private clock: Clock) {
    this.at = clock.now()
  }
  /** True if the frame may be processed. */
  allow(): boolean {
    const now = this.clock.now()
    this.tokens = Math.min(60, this.tokens + (Math.max(0, now - this.at) / 1000) * 30)
    this.at = now
    if (this.tokens < 1) return false
    this.tokens -= 1
    return true
  }
}

/** 5 failed bridge hellos in 10 minutes block the IP for 1 hour. */
export class HelloGuard {
  private fails = new Map<string, number[]>()
  private blocked = new Map<string, number>()
  constructor(private clock: Clock) {}

  isBlocked(ip: string): boolean {
    const until = this.blocked.get(ip)
    if (until === undefined) return false
    if (this.clock.now() >= until) {
      this.blocked.delete(ip)
      return false
    }
    return true
  }

  /** Drops IPs whose failures aged out and whose block ended, so the maps do not grow forever. */
  prune(): void {
    const now = this.clock.now()
    for (const [ip, until] of this.blocked) if (now >= until) this.blocked.delete(ip)
    for (const [ip, times] of this.fails) if (times.every((t) => now - t >= 10 * MIN)) this.fails.delete(ip)
  }

  fail(ip: string): void {
    const now = this.clock.now()
    const recent = (this.fails.get(ip) ?? []).filter((t) => now - t < 10 * MIN)
    recent.push(now)
    if (recent.length >= 5) {
      this.blocked.set(ip, now + HOUR)
      this.fails.delete(ip)
    } else this.fails.set(ip, recent)
  }
}
