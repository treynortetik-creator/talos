// Discovery (docs/SCHEDULES.md S1.4): the first step that hits wins. All paths come from the environment.
//   1. TALOS_APP_SCHEDULER=off            -> off
//   2. TALOS_APP_CHRONOS_BIN              -> use it
//   3. `chronos` on PATH, then ~/.local/share/chronos/bin/chronos -> the first that answers `chronos api version` in 5 s
//   4. nothing found                      -> none (not_installed); a 0.2 install (no `api`) is `unsupported`
// Every step (scutil, then each candidate's `api version` and `version`) gets the smaller of its own budget and what is left
// of DISCOVERY_TOTAL_MS, so a stuck Chronos (or two) holds the scheduler's queue for that long at most. Out of time with a
// candidate still unasked: unanswered, never "no scheduler".
import { spawn, spawnSync } from 'node:child_process'
import { accessSync, constants } from 'node:fs'
import { hostname } from 'node:os'
import { join } from 'node:path'
import { safeLine } from '@talos-app/protocol'
import { stillRunning, waitChild } from '../child-wait.ts'
import type { BridgeEnv } from '../config.ts'
import { say } from '../owner-words.ts'
import type { SchedulerAdapter } from './adapter.ts'
import { AdapterError, type AdapterMeta, ChronosAdapter } from './chronos-adapter.ts'
import { ClosedAdapter } from './closed-adapter.ts'

export const DISCOVERY_TIMEOUT_MS = 5000
/** The whole discovery's budget: stays well inside the app's SCHEDULES_ANSWER_MS (test/schedules/discovery-budget). */
export const DISCOVERY_TOTAL_MS = 10_000

export type Discovered = {
  adapter: SchedulerAdapter
  chronos?: ChronosAdapter
  /** The reason it is not usable, or 'ready'. */
  state: 'ready' | 'off' | 'not_installed' | 'unsupported'
  sessionRunner?: 'talos' | 'hook'
  /**
   * A candidate was there but did not answer within the timeout, and nothing else was ready. This is NOT "no scheduler" or
   * "old scheduler": the service must not cache it and asks again on its next tick.
   */
  unanswered?: true
}

/**
 * Runs `bin args` and reads its stdout, settling in bounded time however the child ends: this runs inside the scheduler's
 * one-at-a-time queue, so a child (or a grandchild holding its stdout) that never ends must never stop every schedule. Killed
 * (by pid) at `timeoutMs` only while it is still running. `timedOut`: it was still running then; `code` is its own otherwise.
 */
async function readFrom(
  bin: string,
  args: string[],
  timeoutMs: number,
): Promise<{ stdout: string; code: number | null; timedOut: boolean }> {
  let child: ReturnType<typeof spawn>
  try {
    child = spawn(bin, args, { stdio: ['ignore', 'pipe', 'ignore'] })
  } catch {
    return { stdout: '', code: null, timedOut: false }
  }
  let stdout = ''
  child.stdout?.setEncoding('utf8').on('data', (d: string) => {
    stdout += d
  })
  const end = await waitChild(child, { deadlineMs: timeoutMs })
  if (end.how === 'deadline' && stillRunning(child)) child.kill('SIGKILL')
  child.stdout?.destroy() // a grandchild may still hold it: we are done reading
  return { stdout, code: end.code, timedOut: end.how === 'deadline' }
}

const isExecutable = (p: string) => {
  try {
    accessSync(p, constants.X_OK)
    return true
  } catch {
    return false
  }
}

let cachedHostLabel: string | undefined
const cleanLabel = (name: string) =>
  safeLine(name).trim().slice(0, 64) || say({ mac: 'This Mac', linux: 'This computer' })

/** The Mac's ComputerName, sanitized (S2.1 `host_label`). Off the event loop; remembered for the sync caller. */
export async function hostLabelAsync(budgetMs = 2000, scutil = '/usr/sbin/scutil'): Promise<string> {
  let name = ''
  if (process.platform === 'darwin') {
    const r = await readFrom(scutil, ['--get', 'ComputerName'], budgetMs)
    if (r.code === 0) name = r.stdout.trim() // anything else falls back to the hostname
  }
  if (!name) name = hostname()
  cachedHostLabel = cleanLabel(name)
  return cachedHostLabel
}

/** Sync form for a caller that cannot await: the last async answer, else one blocking read. */
export function hostLabel(): string {
  if (cachedHostLabel) return cachedHostLabel
  let name = ''
  if (process.platform === 'darwin') {
    const r = spawnSync('/usr/sbin/scutil', ['--get', 'ComputerName'], { encoding: 'utf8', timeout: 2000 })
    if (r.status === 0) name = r.stdout.trim()
  }
  if (!name) name = hostname()
  return cleanLabel(name)
}

export function localZone(env: BridgeEnv): string {
  return env.tz || Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'
}

/** Chronos older than 0.3 (the first with `api`). Anything that does not parse is not old. */
function isOldVersion(v: string): boolean {
  const m = /^(\d+)\.(\d+)/.exec(v)
  if (!m) return false
  return Number(m[1]) === 0 && Number(m[2]) < 3
}

export async function discover(
  env: BridgeEnv,
  deps: {
    meta: AdapterMeta
    now: () => number
    clockIso: () => string
    chronosNow?: () => string | undefined
    onProblem?: (e: AdapterError) => void
    /** Test seam: the `chronos api version` budget. Default DISCOVERY_TIMEOUT_MS. */
    timeoutMs?: number
    /** Test seam: the whole discovery's budget. Default DISCOVERY_TOTAL_MS. */
    totalMs?: number
    /** Test seam: the `scutil` that names the Mac. */
    scutilBin?: string
  },
): Promise<Discovered> {
  const timeoutMs = deps.timeoutMs ?? DISCOVERY_TIMEOUT_MS
  const end = performance.now() + (deps.totalMs ?? DISCOVERY_TOTAL_MS)
  const left = () => Math.max(0, Math.floor(end - performance.now()))
  const label = await hostLabelAsync(Math.min(2000, left()), deps.scutilBin)
  const closedInfo = (version?: string, unanswered = false) => ({
    tz: localZone(env),
    hostLabel: label,
    now: deps.clockIso,
    ...(version ? { version } : {}),
    ...(unanswered ? { unanswered } : {}),
  })
  if (env.scheduler === 'off') return { adapter: new ClosedAdapter('off', closedInfo()), state: 'off' }
  if (!env.chronosBin && !env.chronosAutoDiscover)
    return { adapter: new ClosedAdapter('off', closedInfo()), state: 'off' }

  const childEnv = { path: env.pathDirs.join(':'), home: env.userHome, ...(env.tz ? { tz: env.tz } : {}) }
  const candidates = env.chronosBin
    ? [env.chronosBin]
    : [
        ...env.pathDirs.map((d) => join(d, 'chronos')),
        join(env.userHome, '.local', 'share', 'chronos', 'bin', 'chronos'),
      ]
  let legacy: string | undefined
  let unanswered = false
  for (const bin of candidates) {
    if (!isExecutable(bin)) continue
    if (left() === 0) {
      unanswered = true // a candidate we had no time left to ask
      break
    }
    const probe = new ChronosAdapter({
      bin,
      config: env.chronosConfig,
      timeoutMs: Math.min(timeoutMs, left()),
      chronosNow: deps.chronosNow ?? (() => env.chronosNow),
      env: childEnv,
    })
    try {
      const d = await probe.detect()
      if (d.installed && d.supported) {
        const adapter = new ChronosAdapter({
          bin,
          config: env.chronosConfig,
          timeoutMs: env.schedulerTimeoutMs,
          chronosNow: deps.chronosNow ?? (() => env.chronosNow),
          env: childEnv,
          meta: deps.meta,
          hostLabel: label,
          now: deps.now,
          ...(deps.onProblem ? { onProblem: deps.onProblem } : {}),
        })
        adapter.adoptDetected(probe) // the version for the health row, from the answer just read (one call, not two)
        return {
          adapter,
          chronos: adapter,
          state: 'ready',
          ...(d.sessionRunner ? { sessionRunner: d.sessionRunner } : {}),
        }
      }
      if (d.installed) {
        // Only a parsed version below 0.3, or a parsed answer on another api, is an old Chronos. An answer with no version in it is
        // a bad moment on a busy Mac, not an old install.
        if (d.version && (isOldVersion(d.version) || (d.api !== undefined && d.api !== 1))) legacy = d.version
        else unanswered = true
      }
    } catch (e) {
      // A slow answer is not an old Chronos: never look for a legacy version after a timeout, and do not report "no scheduler".
      if (e instanceof AdapterError && e.kind === 'timeout') {
        unanswered = true
        continue
      }
      // No `api` subcommand (Chronos 0.2 and older): look at what it calls itself, off the event loop.
      if (left() === 0) {
        unanswered = true
        break
      }
      const v = await readFrom(bin, ['version'], Math.min(timeoutMs, left()))
      if (v.timedOut) unanswered = true
      else if (v.code === 0) {
        const m = /^chronos\s+(\d+\.\d+(?:\.\d+)?)/m.exec(v.stdout)
        if (m && isOldVersion(m[1] as string)) legacy = m[1]
        else unanswered = true
      }
    }
  }
  // A probe that got no answer outranks an old version found beside it: the live one may be the slow one.
  if (unanswered)
    return {
      adapter: new ClosedAdapter('not_installed', closedInfo(undefined, true)),
      state: 'not_installed',
      unanswered: true,
    }
  if (legacy) return { adapter: new ClosedAdapter('unsupported', closedInfo(legacy)), state: 'unsupported' }
  return { adapter: new ClosedAdapter('not_installed', closedInfo()), state: 'not_installed' }
}
