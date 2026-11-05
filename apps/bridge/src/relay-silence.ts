// O6: the relay watchdog cannot tell you the Mac can't reach the relay when the relay itself is what you can't reach, and
// the Mac's own health beat travels over the same socket. So the bridge watches its own relay connection and, after
// 10 minutes without one while the Mac is awake, posts once to an ntfy topic (TALOS_APP_ALERT_NTFY_URL in bridge.env),
// and once more when the connection returns. Inert when the URL is unset. Docs: docs/HEALTH.md.
//
// Sleep must not count as silence. The watch advances on a short tick and adds only the time between two ticks that
// arrived on schedule; a tick that arrives late (the Mac slept, or the clock jumped) adds nothing and restarts the count,
// because a sleeping Mac was not "awake without a relay" and its socket needs a fresh connect anyway.
import type { Clock } from './clock.ts'
import { isLoopbackUrl } from './config.ts'
import type { Logger } from './log.ts'

export const SILENCE_MS = 10 * 60_000
export const TICK_MS = 30_000
export const NTFY_TIMEOUT_MS = 5_000

export const ALERT_TEXT =
  'This Mac has had no connection to the relay for 10 minutes. Messages from your phone will not reach it until it reconnects.'
export const BACK_TEXT = 'This Mac is connected to the relay again.'

export type RelaySilenceOptions = {
  /** TALOS_APP_ALERT_NTFY_URL; undefined or empty = inert. */
  url: string | undefined
  connected: () => boolean
  clock: Clock
  log: Logger
  fetchFn?: typeof fetch
  tickMs?: number
  silenceMs?: number
}

/** `https://` only; plain http only for a topic on this machine (tests). Anything else would send the alert in cleartext. */
export function validNtfyUrl(url: string): boolean {
  try {
    const u = new URL(url)
    return u.protocol === 'https:' || (u.protocol === 'http:' && isLoopbackUrl(url))
  } catch {
    return false
  }
}

export class RelaySilence {
  private timer: unknown = null
  private last = 0
  private silentMs = 0
  private alerted = false
  /** The in-flight or finished alert post of this outage: true when ntfy accepted it. */
  private alertSent: Promise<boolean> | undefined
  private stopped = true
  private readonly tickMs: number
  private readonly silenceMs: number
  readonly enabled: boolean

  constructor(private readonly o: RelaySilenceOptions) {
    this.tickMs = o.tickMs ?? TICK_MS
    this.silenceMs = o.silenceMs ?? SILENCE_MS
    const url = o.url?.trim()
    this.enabled = !!url && validNtfyUrl(url)
    // never print the URL: the topic name is the only secret
    if (url && !this.enabled) o.log.warn('TALOS_APP_ALERT_NTFY_URL is ignored: it must be an https:// URL')
  }

  /** Tests: has an outage alert gone out that is not yet answered by a "back"? */
  get inOutage(): boolean {
    return this.alerted
  }

  start() {
    if (!this.enabled || !this.stopped) return
    this.stopped = false
    this.last = this.o.clock.now()
    this.silentMs = 0
    this.schedule()
  }

  stop() {
    this.stopped = true
    if (this.timer !== null) this.o.clock.clearTimeout(this.timer)
    this.timer = null
  }

  private schedule() {
    this.timer = this.o.clock.setTimeout(() => {
      this.tick()
      if (!this.stopped) this.schedule()
    }, this.tickMs)
  }

  /** One step. Public so a test can drive it without timers. */
  tick() {
    const now = this.o.clock.now()
    const delta = now - this.last
    this.last = now
    if (this.o.connected()) {
      this.silentMs = 0
      if (this.alerted) {
        this.alerted = false
        // "connected again" answers an alert that really went out; a failed alert has nothing to answer
        const sent = this.alertSent
        this.alertSent = undefined
        void sent?.then((ok) => (ok ? this.post(BACK_TEXT) : undefined))
      }
      return
    }
    // a late tick (slept) or a clock set backwards says nothing about how long the relay has been missing
    if (delta < 0 || delta > this.tickMs * 2) {
      this.silentMs = 0
      return
    }
    this.silentMs += delta
    if (this.silentMs >= this.silenceMs && !this.alerted) {
      this.alerted = true // once per outage, even if the post fails
      this.alertSent = this.post(ALERT_TEXT)
    }
  }

  /** Resolves true only when the ntfy server accepted the post. */
  private async post(text: string): Promise<boolean> {
    const url = this.o.url?.trim()
    if (!url) return false
    const doFetch = this.o.fetchFn ?? fetch
    const once = async () => {
      const res = await doFetch(url, {
        method: 'POST',
        body: text,
        headers: { Title: 'Talos', Tags: 'warning' },
        signal: AbortSignal.timeout(NTFY_TIMEOUT_MS),
        redirect: 'error',
      })
      await res.arrayBuffer().catch(() => undefined)
      if (!res.ok) throw new Error(`ntfy answered ${res.status}`)
    }
    try {
      await once()
      return true
    } catch {
      try {
        await once()
        return true
      } catch (e) {
        this.o.log.warn('relay-silence alert could not be sent', { err: e instanceof Error ? e.name : 'error' })
        return false
      }
    }
  }
}
