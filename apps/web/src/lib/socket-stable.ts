// The reconnect backoff starts over only for a link that stayed up (the bridge's STABLE_MS rule, relay-client.ts).
import { STABLE_LATE_MAX_MS, STABLE_MS } from './socket-constants.ts'
import type { SocketCtx } from './socket-ctx.ts'

/** A timer may fire this much before the clock says its time (rounding): still a full window. */
const STABLE_SLACK_MS = 100

/**
 * The backoff starts over once this socket has stayed up STABLE_MS: a relay that says `ready` and then hangs up must not be
 * redialled every second for ever (the bridge's rule, relay-client.ts). A timer that fires far off the 30 s it was set for
 * (the machine slept, the clock stepped) proves nothing about the link, so it does not reset: it opens a new window.
 */
export function armStable(c: SocketCtx, sock: WebSocket) {
  const { now } = c
  if (c.stableTimer) clearTimeout(c.stableTimer)
  let since = now()
  const arm = () => {
    c.stableTimer = setTimeout(() => {
      c.stableTimer = null
      if (c.closed || c.ws !== sock || !c.ready) return
      const up = now() - since
      // Late by up to a minute is a busy page. Later still counts only for a link that answered lately (a hidden tab holds
      // timers back for minutes, its keepalive too) and not beyond STABLE_LATE_MAX_MS: hours is a sleep, and proves nothing.
      // "Answered" is the latest keepalive ping's own pong, for a ping sent after this window opened (a pong for an older
      // ping, or any other pong, says nothing about the time since).
      const answeredLately = c.answeredPingAt >= since && now() - c.answeredAt <= 2.5 * c.pingMs
      const onTime = up <= 2 * STABLE_MS || (up <= STABLE_LATE_MAX_MS && answeredLately)
      if (up >= STABLE_MS - STABLE_SLACK_MS && onTime) {
        c.attempt = 0
        return
      }
      since = now()
      arm()
    }, STABLE_MS)
  }
  arm()
}
