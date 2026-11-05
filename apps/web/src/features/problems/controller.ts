// The page's problem reporter: global handlers, the boundaries' hook, the queue and the flush. One per page.
//   - an uncaught error or unhandled rejection becomes a report (once per fingerprint per 10 minutes, 20 per session);
//   - the report goes into the queue first, then a flush tries to send it, so offline loses nothing;
//   - the queue is flushed when the connection comes (or comes back), when the browser says it is online, and at start.
// Nothing here reads a message, a thread name or a card.
import type { ProblemT } from '@talos-app/protocol'
import type { TalosClient } from '../../lib/client.ts'
import type { Storage } from '../../lib/storage.ts'
import { type CaptureEnv, CaptureThrottle, problemFromError, skipReason } from './capture.ts'
import { drainCrashes } from './crashDrain.ts'
import { deviceKind, versionsNow } from './environment.ts'
import { postProblem } from './post.ts'
import { type FlushResult, ProblemQueue } from './queue.ts'
import { routeTrail } from './routes.ts'

export type ControllerOptions = {
  storage: Storage
  client: Pick<TalosClient, 'uploadMedia' | 'store'>
  /** Tests pass their own. */
  env?: () => CaptureEnv
  post?: typeof postProblem
  target?: Pick<Window, 'addEventListener' | 'removeEventListener'>
  now?: () => number
}

export type ProblemStatus = {
  waiting: number
  /** Reports held back by the 10-minute and per-session limits since the page opened. */
  held: number
  /** Dropped from the waiting list to keep it short. */
  dropped: number
  lastFlush: FlushResult | null
}

export class ProblemController {
  readonly queue: ProblemQueue
  readonly throttle: CaptureThrottle
  private lastFlush: FlushResult | null = null
  private listeners = new Set<() => void>()
  private off: Array<() => void> = []
  private reporting = false
  private readonly now: () => number

  constructor(private o: ControllerOptions) {
    this.now = o.now ?? (() => Date.now())
    this.queue = new ProblemQueue(o.storage)
    this.throttle = new CaptureThrottle(this.now)
  }

  env(): CaptureEnv {
    return (
      this.o.env?.() ?? {
        origin: location.origin,
        versions: versionsNow(),
        device: deviceKind(),
        routes: routeTrail(),
        now: this.now,
      }
    )
  }

  /** Called by the handlers and the boundaries. Never throws, never logs through console.error (that could loop). */
  report(error: unknown): void {
    if (this.reporting) return
    this.reporting = true
    try {
      const env = this.env()
      if (skipReason(error, env.origin)) return
      const p = problemFromError(error, env)
      if (!this.throttle.allow(p.fingerprint)) {
        this.emit()
        return
      }
      void this.submit(p)
    } catch {
      // a reporter that fails stays quiet: the app already has its own error to deal with
    } finally {
      this.reporting = false
    }
  }

  /** Queue first, then try to send. The queue write is what makes "offline" safe. */
  async submit(p: ProblemT, shot?: { type: string; name: string; bytes: ArrayBuffer }): Promise<FlushResult | null> {
    try {
      await this.queue.add(p, this.now(), shot)
    } catch {
      return null
    }
    this.emit()
    return this.flush()
  }

  async flush(): Promise<FlushResult | null> {
    try {
      const r = await this.queue.flush({
        post: (p) => (this.o.post ?? postProblem)(p),
        upload: (blob, name) =>
          this.o.client.uploadMedia(blob, { name }) as Promise<NonNullable<ProblemT['screenshot']>>,
      })
      this.lastFlush = r
      this.emit()
      return r
    } catch {
      return null
    }
  }

  async status(): Promise<ProblemStatus> {
    return {
      waiting: await this.queue.size().catch(() => 0),
      held: this.throttle.held,
      dropped: this.queue.dropped,
      lastFlush: this.lastFlush,
    }
  }

  subscribe(fn: () => void): () => void {
    this.listeners.add(fn)
    return () => this.listeners.delete(fn)
  }

  private emit(): void {
    for (const fn of this.listeners) fn()
  }

  start(): void {
    const target = this.o.target ?? window
    const onError = (e: Event) => {
      const ev = e as ErrorEvent
      // A script error from another origin has no usable error object; `report` filters it as noise.
      this.report(ev.error ?? new Error(ev.message || 'Script error.'))
    }
    const onRejection = (e: Event) => this.report((e as PromiseRejectionEvent).reason)
    const onOnline = () => void this.flush()
    target.addEventListener('error', onError)
    target.addEventListener('unhandledrejection', onRejection)
    target.addEventListener('online', onOnline)
    this.off.push(
      () => target.removeEventListener('error', onError),
      () => target.removeEventListener('unhandledrejection', onRejection),
      () => target.removeEventListener('online', onOnline),
    )
    // "On connect": every time the socket comes up, and once now if it already is.
    const store = this.o.client.store
    let was = store.getState().connection
    this.off.push(
      store.subscribe((s) => {
        if (s.connection === 'online' && was !== 'online') void this.flush()
        was = s.connection
      }),
    )
    void this.flush()
    // iPhone shell only: the system's crash reports wait in the shell until the page is up. Once now, and each time the app
    // comes back to the front.
    void drainCrashes(this)
    const onVisible = () => {
      if (typeof document !== 'undefined' && document.visibilityState === 'visible') void drainCrashes(this)
    }
    if (typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', onVisible)
      this.off.push(() => document.removeEventListener('visibilitychange', onVisible))
    }
  }

  stop(): void {
    for (const f of this.off.splice(0)) f()
  }
}

let current: ProblemController | null = null

export function installProblems(o: ControllerOptions): ProblemController {
  current?.stop()
  current = new ProblemController(o)
  current.start()
  return current
}

export function problems(): ProblemController | null {
  return current
}

/** For the error boundaries: reports a caught render error if the reporter is running, and does nothing otherwise. */
export function reportCaught(error: unknown): void {
  current?.report(error)
}

/** Tests only. */
export function uninstallProblems(): void {
  current?.stop()
  current = null
}
