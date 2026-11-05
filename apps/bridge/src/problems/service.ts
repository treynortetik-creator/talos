// Problem reports on the Mac (docs/ERRORS.md). Three ways in, one way out:
//   in:  a `problem.item` from the relay (the app, the iPhone shell, the relay itself), the bridge's own `error` log
//        lines, and its own unhandled rejections;
//   out: a file in `problems/open/` (store.ts) and, for the FIRST sighting only, a content-free line in the Inbox thread.
// Nothing here wakes the agent, starts a fix or restarts anything: a notice carries no `toAgent`, and a person (or the lead)
// decides whether a builder looks. The service logs its own trouble with `warn`, never `error`, and a guard refuses a
// report made while another is being made, so it cannot feed itself.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  framesFromV8Stack,
  newUlid,
  PROBLEM_LIMITS,
  PROTOCOL_VERSION,
  type ProblemT,
  problemFingerprint,
  RollingLimit,
  scrubProblem,
} from '@talos-app/protocol'
import type { Clock } from '../clock.ts'
import { readJsonFile, writeJsonAtomic } from '../fsutil.ts'
import type { ErrorTap, Logger } from '../log.ts'
import { type FileOutcome, fileProblem, problemDirs } from './store.ts'

/** Log lines the tap leaves alone: the rejection handler reports with a stack through `recordError` itself. */
const OWN_LINES = new Set(['problem not filed', 'problem notice not sent'])

type State = {
  /** Local day (owner's zone) the counters below belong to. */
  day: string
  /** Reports not announced or not stored today because of a limit. */
  dropped: { notices: number; full: number; failed: number }
  /** When the last notices went out (ms), for the per-hour cap. */
  notices: number[]
}

export type ProblemServiceDeps = {
  home: string
  clock: Clock
  log: Logger
  /** The owner's time zone, for "daily". */
  timezone: () => string
  bridgeVersion: string
  userHome?: string
  /** A line in the Inbox thread. No agent wake-up. */
  notice: (text: string) => Promise<void>
  /** Fetches the screenshot a report names; throws when it cannot be had or verified. */
  fetchScreenshot?: (ref: NonNullable<ProblemT['screenshot']>) => Promise<{ path: string }>
}

function dayKey(ms: number, zone: string): string {
  try {
    return new Intl.DateTimeFormat('en-CA', {
      timeZone: zone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(new Date(ms))
  } catch {
    return new Date(ms).toISOString().slice(0, 10)
  }
}

export class ProblemService {
  private busy = false
  private lastLocal = new Map<string, number>()
  private budget = new RollingLimit()
  private timer: unknown = null
  /** Own errors the hourly cap held back since the last daily line. Kept in memory: a hot path must not write a file. */
  private limited = 0

  constructor(private d: ProblemServiceDeps) {}

  private get statePath() {
    return join(problemDirs(this.d.home).root, '.state.json')
  }

  private loadState(): State {
    const s = readJsonFile<State>(this.statePath)
    const today = dayKey(this.d.clock.now(), this.d.timezone())
    if (s && typeof s.day === 'string' && s.dropped && Array.isArray(s.notices)) return s
    return { day: today, dropped: { notices: 0, full: 0, failed: 0 }, notices: [] }
  }

  private saveState(s: State): void {
    try {
      writeJsonAtomic(this.statePath, s)
    } catch (e) {
      this.d.log.warn('problem state not saved', { error: (e as Error).message })
    }
  }

  // ---- from the relay ------------------------------------------------------------------------------------------------

  /**
   * Files one problem. Returns 'done' when the frame may be answered `consumed` (filed, merged, a replay, or refused for
   * good) and 'retry' when it must stay with the relay (the disk write failed).
   */
  async onItem(problem: ProblemT): Promise<'done' | 'retry'> {
    // The Mac knows its own version; the sender cannot, and a report that came through the relay never carries it.
    problem = { ...problem, versions: { ...problem.versions, bridge: this.d.bridgeVersion.slice(0, 40) } }
    let shot: { bytes: Uint8Array } | 'unavailable' | undefined
    if (problem.screenshot) {
      try {
        if (!this.d.fetchScreenshot) throw new Error('no media store')
        const got = await this.d.fetchScreenshot(problem.screenshot)
        shot = { bytes: new Uint8Array(readFileSync(got.path)) }
      } catch (e) {
        // The report matters more than its picture: file it, and say the picture did not make it.
        this.d.log.warn('problem screenshot not fetched', { error: (e as Error).message })
        shot = 'unavailable'
      }
    }
    let out: FileOutcome
    try {
      out = fileProblem(this.d.home, problem, {
        nowIso: new Date(this.d.clock.now()).toISOString(),
        paths: { ...(this.d.userHome ? { userHome: this.d.userHome } : {}), appHome: this.d.home },
        ...(shot ? { screenshot: shot } : {}),
      })
    } catch (e) {
      this.d.log.warn('problem not filed', { error: (e as Error).message })
      this.bump('failed')
      return 'retry'
    }
    if (out.result === 'refused') {
      this.d.log.warn('problem not filed: the problem folder is full of open problems', {
        fingerprint: out.fingerprint,
      })
      this.bump('full')
      return 'done'
    }
    if (out.result === 'filed') await this.announce(out.fingerprint, problem.source, out.count)
    await this.maybeDailyNotice()
    return 'done'
  }

  // ---- from the bridge itself ----------------------------------------------------------------------------------------

  /** The `error` tap for the logger: every error line the live bridge writes becomes at most one report per window. */
  readonly tap: ErrorTap = (msg, fields, detail) => {
    if (OWN_LINES.has(msg)) return
    const err = typeof fields?.error === 'string' ? fields.error : ''
    this.recordError({
      name: 'logged error',
      message: `${msg}${err ? `: ${err}` : ''}`,
      ...(detail.stack ? { stack: detail.stack } : {}),
    })
  }

  recordError(e: { name: string; message: string; stack?: string }): boolean {
    if (this.busy) return false
    this.busy = true
    try {
      const now = this.d.clock.now()
      const draft: ProblemT = {
        id: newUlid(),
        source: 'bridge',
        kind: 'auto',
        fingerprint: '0'.repeat(32),
        at: new Date(now).toISOString(),
        name: e.name,
        message: e.message,
        frames: e.stack ? framesFromV8Stack(e.stack) : [],
        versions: { bridge: this.d.bridgeVersion, protocol: String(PROTOCOL_VERSION) },
        device: 'bridge',
        routes: [],
        truncated: false,
      }
      const clean = scrubProblem(draft)
      const fp = problemFingerprint(clean)
      const prev = this.lastLocal.get(fp)
      if (prev !== undefined && now - prev < PROBLEM_LIMITS.samePerWindowMs) return false
      if (!this.budget.take(now)) {
        this.limited++
        return false
      }
      this.lastLocal.set(fp, now)
      if (this.lastLocal.size > 200) this.lastLocal.delete(this.lastLocal.keys().next().value as string)
      // synchronous on purpose: no await between "check" and "write", so two errors in one tick cannot both file
      void this.onItem({ ...clean, fingerprint: fp }).catch((err) =>
        this.d.log.warn('problem not filed', { error: (err as Error).message }),
      )
      return true
    } catch (err) {
      this.d.log.warn('problem not recorded', { error: (err as Error).message })
      return false
    } finally {
      this.busy = false
    }
  }

  // ---- notices -------------------------------------------------------------------------------------------------------

  private bump(k: keyof State['dropped']): void {
    const s = this.loadState()
    s.dropped[k]++
    this.saveState(s)
  }

  private async announce(fingerprint: string, source: string, count: number): Promise<void> {
    const now = this.d.clock.now()
    const s = this.loadState()
    s.notices = s.notices.filter((t) => now - t < 3600_000)
    if (s.notices.length >= PROBLEM_LIMITS.noticesPerHour) {
      s.dropped.notices++
      this.saveState(s)
      return
    }
    s.notices.push(now)
    this.saveState(s)
    const id = fingerprint.slice(0, 12)
    // Fixed words and three values we computed ourselves. Nothing the report said.
    const text = `Problem report ${id} from ${source}, seen ${count} time${count === 1 ? '' : 's'}. Nothing has been started. To read it: talos-app errors show ${id}`
    try {
      await this.d.notice(text)
    } catch (e) {
      this.d.log.warn('problem notice not sent', { error: (e as Error).message })
    }
  }

  /** One line per day, only when something was dropped: how many, and why. Safe to call as often as you like. */
  async maybeDailyNotice(): Promise<boolean> {
    const s = this.loadState()
    const today = dayKey(this.d.clock.now(), this.d.timezone())
    if (s.day === today) return false
    const limited = this.limited
    this.limited = 0
    const total = s.dropped.notices + s.dropped.full + s.dropped.failed + limited
    // Roll the day first: a notice that fails must not repeat on every call.
    const next: State = { day: today, dropped: { notices: 0, full: 0, failed: 0 }, notices: s.notices }
    this.saveState(next)
    if (total === 0) return false
    const parts = [
      s.dropped.notices ? `${s.dropped.notices} not announced (limit of ${PROBLEM_LIMITS.noticesPerHour} an hour)` : '',
      s.dropped.full ? `${s.dropped.full} not stored (the problem folder is full of open problems)` : '',
      s.dropped.failed ? `${s.dropped.failed} could not be written` : '',
      limited
        ? `${limited} not filed (the hourly limit of ${PROBLEM_LIMITS.perSession} errors from the Mac itself)`
        : '',
    ].filter(Boolean)
    try {
      await this.d.notice(`Problem reports yesterday that hit a limit: ${parts.join('; ')}. Run: talos-app errors list`)
    } catch (e) {
      this.d.log.warn('problem notice not sent', { error: (e as Error).message })
    }
    return true
  }

  start(): void {
    // Once an hour is plenty for a daily line; `unref` so it never keeps a stopping bridge alive.
    const tick = () => {
      void this.maybeDailyNotice().catch(() => {})
      this.timer = this.d.clock.setTimeout(tick, 3600_000)
      ;(this.timer as { unref?: () => void } | null)?.unref?.()
    }
    void this.maybeDailyNotice().catch(() => {})
    this.timer = this.d.clock.setTimeout(tick, 3600_000)
  }

  stop(): void {
    if (this.timer) this.d.clock.clearTimeout(this.timer)
    this.timer = null
  }
}
