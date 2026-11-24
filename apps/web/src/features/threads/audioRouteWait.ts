// The message player's wait for the audio route (audioPlayer.ts). In the iPhone app a start takes the route and calls play() when the
// shell answers or after ROUTE_WAIT_MS, whichever is first: a clip that is already buffered sounds at once, and a route call that
// lands on top of it can make iOS pause it at the same spot. A browser has no answer, so there play() stays inside the tap. This file
// holds the wait and the timestamps the audio trace reports as `order`; what ending the wait means is the player's business.
import type { AudioOrder } from '../problems/audioTrace.ts'

/** How long a start in the iPhone app waits for the shell's answer before play() goes ahead. */
export const ROUTE_WAIT_MS = 250

export type RouteWait = {
  gen: number
  /** When the tap (or the restart) took the route. */
  at: number
  timer: ReturnType<typeof setTimeout> | null
  done: boolean
  /** Whether this start armed the stall watch (a tap joining an earlier try must not move its clock). */
  rearm: boolean
  /** The element was paused when the wait began: a pause event that lands in it belongs to something before it. */
  still: boolean
  /** Where the element was then: a clip that has moved since is playing, whatever the clock says. */
  pos: number
  onRefused: (() => void) | undefined
}

/** The start that has taken the route and not called play() yet. At most one. */
let current: RouteWait | null = null
/** When the last start asked for the route, when the shell answered, when play() was called, and whether the cap let play() through. */
const stamp = {
  route: null as number | null,
  answered: null as number | null,
  played: null as number | null,
  capped: false,
}

/** The wait of start `gen` while it is still waiting and no older than `maxAgeMs`. */
export function pendingWait(gen: number, maxAgeMs = Number.POSITIVE_INFINITY): RouteWait | null {
  const rw = current
  return rw && !rw.done && rw.gen === gen && Date.now() - rw.at <= maxAgeMs ? rw : null
}

/** Ends the wait once (its timer goes too): false when it was already over. */
export function finishRouteWait(rw: RouteWait): boolean {
  if (rw.done) return false
  rw.done = true
  if (rw.timer) clearTimeout(rw.timer)
  if (current === rw) current = null
  return true
}

/** A wait that is over for any reason (a pause, a stop, a newer start): play() is never called for it. */
export function cancelRouteWait(): void {
  if (current) finishRouteWait(current)
}

/** A start took the route at `at`. */
export function markRoute(at: number | null): void {
  Object.assign(stamp, { route: at, answered: null, played: null, capped: false })
}
export function markPlayed(): void {
  stamp.played = Date.now()
}
export function markCapped(capped: boolean): void {
  stamp.capped = capped
}

/**
 * Waits for the shell's `answered` promise or the cap, whichever is first, and calls `end` once with the wait and which one (`live`:
 * this start is still the current one, so a late answer of an older start is not recorded).
 */
export function beginRouteWait(
  start: Omit<RouteWait, 'timer' | 'done'>,
  answered: Promise<void>,
  live: () => boolean,
  end: (rw: RouteWait, how: 'answer' | 'cap') => void,
): void {
  const rw: RouteWait = { ...start, timer: null, done: false }
  current = rw
  rw.timer = setTimeout(() => end(rw, 'cap'), ROUTE_WAIT_MS)
  const answer = () => {
    if (live()) stamp.answered ??= Date.now()
    end(rw, 'answer')
  }
  answered.then(answer, answer)
}

/** Ages in ms since the last start's route call, its answer (`cap`: play() went ahead without one) and play(): see AudioOrder. */
export function orderNow(): AudioOrder {
  const now = Date.now()
  const since = (t: number | null) => (t === null ? undefined : now - t)
  return {
    r: since(stamp.route),
    ...(stamp.answered !== null ? { a: now - stamp.answered } : stamp.capped ? { a: 'cap' as const } : {}),
    p: since(stamp.played),
  }
}
