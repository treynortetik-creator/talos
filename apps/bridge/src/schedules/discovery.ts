// Discovery (docs/SCHEDULES.md S1.4): the first step that hits wins. All paths come from the environment.
//   1. TALOS_APP_SCHEDULER=off            -> off
//   2. TALOS_APP_CHRONOS_BIN              -> use it
//   3. `chronos` on PATH, then ~/.local/share/chronos/bin/chronos -> the first that answers `chronos api version` in 5 s
//   4. nothing found                      -> none (not_installed); a 0.2 install (no `api`) is `unsupported`
import { execFile, spawnSync } from 'node:child_process'
import { accessSync, constants } from 'node:fs'
import { hostname } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { safeLine } from '@talos-app/protocol'
import type { BridgeEnv } from '../config.ts'
import type { SchedulerAdapter } from './adapter.ts'
import { AdapterError, type AdapterMeta, ChronosAdapter } from './chronos-adapter.ts'
import { ClosedAdapter } from './closed-adapter.ts'

export const DISCOVERY_TIMEOUT_MS = 5000

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

const execFileP = promisify(execFile)

const isExecutable = (p: string) => {
  try {
    accessSync(p, constants.X_OK)
    return true
  } catch {
    return false
  }
}

let cachedHostLabel: string | undefined
const cleanLabel = (name: string) => safeLine(name).trim().slice(0, 64) || 'This Mac'

/** The Mac's ComputerName, sanitized (S2.1 `host_label`). Off the event loop; remembered for the sync caller. */
export async function hostLabelAsync(): Promise<string> {
  let name = ''
  if (process.platform === 'darwin') {
    try {
      name = (
        await execFileP('/usr/sbin/scutil', ['--get', 'ComputerName'], { encoding: 'utf8', timeout: 2000 })
      ).stdout.trim()
    } catch {
      // fall back to the hostname
    }
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
  },
): Promise<Discovered> {
  const timeoutMs = deps.timeoutMs ?? DISCOVERY_TIMEOUT_MS
  const label = await hostLabelAsync()
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
    const probe = new ChronosAdapter({
      bin,
      config: env.chronosConfig,
      timeoutMs,
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
        await adapter.detect() // learns the version for the health row
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
      try {
        const v = await execFileP(bin, ['version'], { encoding: 'utf8', timeout: timeoutMs })
        const m = /^chronos\s+(\d+\.\d+(?:\.\d+)?)/m.exec(v.stdout)
        if (m && isOldVersion(m[1] as string)) legacy = m[1]
        else unanswered = true
      } catch (e2) {
        if ((e2 as { killed?: boolean }).killed) unanswered = true
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
