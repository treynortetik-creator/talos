// MCP Apps, web side (M4.6, M2.1, M2.3): the numbers in one place. Local limits fail fast; the bridge and the relay
// enforce their own, so none of these is the only line of defence.
import { APP_CLIENT_CEILING_MS } from '@talos-app/protocol'

/** Per view, per minute. */
export const PER_MINUTE = { toolsCall: 30, uiMessage: 6, openLink: 6, displayMode: 6, log: 60 } as const
export const WINDOW_MS = 60_000
/** Live app iframes per page; the rest are posters. */
export const MAX_LIVE_FRAMES = 3
/** `notifications/progress` while a `tools/call` with a progress token is pending. */
export const PROGRESS_INTERVAL_MS = 20_000
/** A request with no answer by then fails `timeout`: card expiry + bridge grace + skew, derived in the protocol. */
export const CLIENT_CEILING_MS = APP_CLIENT_CEILING_MS
/** `ui/resource-teardown` waits this long for the view's answer. */
export const TEARDOWN_WAIT_MS = 500
/** host-context-changed for a resize is debounced. */
export const RESIZE_DEBOUNCE_MS = 150
/** Inline height bounds (M2.3). */
export const MIN_HEIGHT = 64
export const DEFAULT_HEIGHT = 320
export const maxInlineHeight = (innerHeight: number) => Math.round(Math.min(640, 0.7 * innerHeight))
/** App log ring buffer: entries x bytes each. */
export const LOG_ENTRIES = 200
export const LOG_ENTRY_CHARS = 1024
/** A view that has not finished `ui/initialize` this long after its frame loaded is shown as failed. */
export const START_WATCHDOG_MS = 10_000
/** The result fetched for `tool_result_media` (JSON, up to 8 MiB). */
export const RESULT_FETCH_TIMEOUT_MS = 15_000

/** Sliding-window counter on a monotonic clock, so a wall-clock jump can neither free nor lock a view. */
export class RateWindow {
  private hits: number[] = []
  constructor(
    private readonly max: number,
    private readonly now: () => number,
    private readonly windowMs = WINDOW_MS,
  ) {}
  /** True (and counted) when the call fits, false (and not counted) when the window is full. */
  take(): boolean {
    const t = this.now()
    // A clock that went backwards (should not happen on a monotonic source) forgets the old hits instead of locking.
    if (this.hits.length > 0 && t < (this.hits[this.hits.length - 1] as number)) this.hits = []
    const cut = t - this.windowMs
    while (this.hits.length > 0 && (this.hits[0] as number) <= cut) this.hits.shift()
    if (this.hits.length >= this.max) return false
    this.hits.push(t)
    return true
  }
}
/** The open-link sheet ignores [Open] for this long after it appears (a tap meant for the view must not land on it). */
export const OPEN_ARM_MS = 400
