// Problem reports, relay side (docs/ERRORS.md). One route, `POST /api/problems`, for the app and the iPhone shell, and one
// recorder for the relay's own errors. Both end the same way: a scrubbed `Problem` in a durable, consumable
// `problem.item` frame addressed to the Mac. The frame id IS the problem id, so a retried POST never stores twice.
// The relay is a courier here: it checks the session, the size, the rate and the shape, and the Mac scrubs again.
import { existsSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  framesFromV8Stack,
  newUlid,
  PROBLEM_LIMITS,
  PROBLEMS_FEATURE,
  PROTOCOL_VERSION,
  Problem,
  type ProblemT,
  problemFingerprint,
  RollingLimit,
  scrubProblem,
} from '@talos-app/protocol'
import { Hono } from 'hono'
import { rateLimit, requireCsrf, requireSession } from '../auth/contract.ts'
import type { AppEnv, RelayServices } from '../services.ts'
import { VERSION } from '../version.ts'
import { registerRelayFeature } from './features.ts'
import { findRuntime } from './runtime.ts'

export function registerProblems(_services: RelayServices): void {
  registerRelayFeature(PROBLEMS_FEATURE)
}

/** What the Mac gets for a relay-made error. Class name and message only; the stack is cut to names and positions. */
export function relayProblemFrom(err: unknown, now: number, fatal = false): ProblemT {
  const e = err instanceof Error ? err : new Error(String(err))
  const frames = framesFromV8Stack(e.stack ?? '')
  const draft: ProblemT = {
    id: newUlid(),
    source: 'relay',
    kind: 'auto',
    fingerprint: '0'.repeat(32),
    at: new Date(now).toISOString(),
    name: `${fatal ? 'fatal ' : ''}${e.name || 'Error'}`,
    message: e.message,
    frames,
    versions: { relay: VERSION, protocol: String(PROTOCOL_VERSION) },
    device: 'relay',
    routes: [],
    truncated: false,
  }
  const clean = scrubProblem(draft)
  return { ...clean, fingerprint: problemFingerprint(clean) }
}

/**
 * A client that hung up mid-request. Node's http server fails the request body with `Error: aborted` and code ECONNRESET;
 * nothing went wrong on the relay, so it is not a problem report. Both must match: ECONNRESET alone is also what an
 * outbound call to an upstream gets (`read ECONNRESET`, `socket hang up`), and "aborted" alone could be anything, and
 * those are real faults. An AbortError from our own timeout never matches either.
 */
export function isClientHangup(err: unknown): boolean {
  return err instanceof Error && (err as { code?: unknown }).code === 'ECONNRESET' && err.message === 'aborted'
}

/**
 * Remembers what it already reported: the same fingerprint once per window, and a rolling hourly cap per process, so one bug that
 * fires on every request is one report. A report is never made while another is being made (the recorder's own failure
 * must not feed itself).
 */
export class RelayProblemRecorder {
  private last = new Map<string, number>()
  private budget = new RollingLimit()
  private busy = false
  dropped = 0
  constructor(private services: RelayServices) {}

  record(err: unknown): boolean {
    if (this.busy) return false
    this.busy = true
    try {
      const rt = findRuntime(this.services)
      if (!rt) return false
      const now = this.services.clock.now()
      const p = relayProblemFrom(err, now)
      const prev = this.last.get(p.fingerprint)
      if (prev !== undefined && now - prev < PROBLEM_LIMITS.samePerWindowMs) return false // a repeat: one report is enough
      if (!this.budget.take(now)) {
        this.dropped++
        return false
      }
      if (this.dropped > 0) {
        // warn, never error: an error here would be recorded as a problem again
        this.services.log.warn({ dropped: this.dropped }, 'relay errors held back by the hourly limit')
        this.dropped = 0
      }
      this.last.set(p.fingerprint, now)
      if (this.last.size > 200) this.last.delete(this.last.keys().next().value as string)
      void rt.hub.toBridge({ type: 'problem.item', id: p.id, problem: p }, { durable: true }).catch((e) => {
        // warn, never error: an error here would be recorded as a problem again
        this.services.log.warn({ err: (e as Error).name }, 'problem not queued')
      })
      return true
    } catch (e) {
      this.services.log.warn({ err: (e as Error).name }, 'problem not recorded')
      return false
    } finally {
      this.busy = false
    }
  }
}

const recorders = new WeakMap<RelayServices, RelayProblemRecorder>()
export function recorderOf(services: RelayServices): RelayProblemRecorder {
  let r = recorders.get(services)
  if (!r) {
    r = new RelayProblemRecorder(services)
    recorders.set(services, r)
  }
  return r
}

// ---- fatal errors -----------------------------------------------------------------------------------------------------

const FATAL_FILE = 'fatal-problem.json'

/**
 * Called from the process's last-chance handlers: writes ONE row to the data folder, synchronously and without touching
 * the database (it may be the thing that broke). The first fatal wins; a crash loop does not pile up files.
 */
export function saveFatalProblem(dataDir: string, err: unknown, now = Date.now()): void {
  try {
    writeFileSync(join(dataDir, FATAL_FILE), JSON.stringify(relayProblemFrom(err, now, true)), {
      flag: 'wx',
      mode: 0o600,
    })
  } catch {
    // already one waiting, or the disk is the problem: the process is going down either way
  }
}

type ProcLike = {
  on(ev: 'uncaughtException' | 'unhandledRejection', fn: (err: unknown) => void): unknown
  off(ev: 'uncaughtException' | 'unhandledRejection', fn: (err: unknown) => void): unknown
}

/** Saves the fatal problem, prints the error as node would have, and exits 1. Returns a disposer (tests). */
export function installFatalHandlers(o: {
  dataDir: string
  proc?: ProcLike
  exit?: (code: number) => void
  print?: (err: unknown) => void
}): () => void {
  const proc = o.proc ?? (process as unknown as ProcLike)
  const exit = o.exit ?? ((c) => process.exit(c))
  const print = o.print ?? ((e) => console.error(e))
  const onFatal = (err: unknown) => {
    saveFatalProblem(o.dataDir, err)
    print(err)
    exit(1)
  }
  proc.on('uncaughtException', onFatal)
  proc.on('unhandledRejection', onFatal)
  return () => {
    proc.off('uncaughtException', onFatal)
    proc.off('unhandledRejection', onFatal)
  }
}

/** On boot: the fatal problem the last run left, queued for the Mac and removed. A file that does not parse is dropped. */
export async function fileFatalProblem(services: RelayServices): Promise<boolean> {
  const rt = findRuntime(services)
  const path = join(rt?.dataDir ?? services.env.DATA_DIR, FATAL_FILE)
  if (!rt || !existsSync(path)) return false
  let p: ProblemT
  try {
    const parsed = Problem.safeParse(JSON.parse(readFileSync(path, 'utf8')))
    if (!parsed.success) throw new Error('shape')
    p = parsed.data
  } catch {
    services.log.warn({}, 'fatal problem file unreadable; removed')
    unlinkSync(path)
    return false
  }
  await rt.hub.toBridge({ type: 'problem.item', id: p.id, problem: p }, { durable: true })
  unlinkSync(path) // only after the frame is stored: a failure above leaves the file for the next boot
  return true
}

// ---- the route --------------------------------------------------------------------------------------------------------

export const problemRoutes = new Hono<AppEnv>()

problemRoutes.post('/api/problems', requireSession, requireCsrf, rateLimit('problems'), async (c) => {
  const services = c.get('services')
  const rt = findRuntime(services)
  if (!rt) return c.json({ error: 'server_error' }, 500)
  let body: unknown
  try {
    body = await c.req.json()
  } catch {
    return c.json({ error: 'bad_request' }, 400)
  }
  const parsed = Problem.safeParse(body)
  if (!parsed.success) return c.json({ error: 'bad_request', message: 'not a problem report' }, 400)
  // The relay knows its own version and the app does not; set it here so every report from the app carries it.
  const p = scrubProblem({ ...parsed.data, versions: { ...parsed.data.versions, relay: VERSION.slice(0, 40) } })
  if (p.screenshot) {
    // The picture must be one this relay holds, byte for byte what the report says. The app uploads it first.
    const row = rt.store.getMediaRow(p.screenshot.media_id)
    if (!row || row.sha256 !== p.screenshot.sha256 || row.size !== p.screenshot.size)
      return c.json({ error: 'screenshot_missing', message: 'Upload the screenshot again.' }, 400)
  }
  if (rt.store.getEventByFrameId(p.id)) return c.json({ ok: true, id: p.id }, 202) // a retry of one already queued
  await rt.hub.toBridge({ type: 'problem.item', id: p.id, problem: p }, { durable: true })
  return c.json({ ok: true, id: p.id }, 202)
})
