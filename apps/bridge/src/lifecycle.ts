// Process lifecycle (spec 4.1): the single-bridge PID file, and exit on stdin EOF or a signal.

import { randomBytes } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import type { BridgePaths } from './config.ts'
import { readJsonFile, removeFile, writeJsonAtomic } from './fsutil.ts'
import type { Logger } from './log.ts'
import { isProcToken, processStartTime } from './proc-identity.ts'

export type PidRecord = { pid: number; started_at: string; instance: string }
/** `psLstart`: on Linux, ps's own start-time text beside the /proc token in `lstart`, for pid files an older build wrote. */
export type PsInfo = { lstart: string; command: string; psLstart?: string }
export const BRIDGE_ENTRY = 'apps/bridge/src/server.ts'

/** One line of `ps -o lstart=,command=`: lstart is a fixed 24 characters, the command follows. */
export const parsePsLine = (line: string): PsInfo => ({
  lstart: line.slice(0, 24).trim(),
  command: line.slice(24).trim(),
})

/**
 * On Linux the start time ps prints is replaced by the /proc token (proc-identity.ts): WSL's ps prints one that drifts. When
 * /proc cannot answer (the pid went between the two reads) there is no answer at all, never ps's drifting text.
 */
export function withStableStart(pid: number, info: PsInfo): PsInfo | undefined {
  if (process.platform !== 'linux') return info
  const token = processStartTime(pid)
  return token ? { ...info, lstart: token, psLstart: info.lstart } : undefined
}

/** `ps -p <pid> -o lstart=,command=`, with the start time from withStableStart. Undefined when the pid is gone or unreadable. */
export function psInfo(pid: number): PsInfo | undefined {
  try {
    const r = Bun.spawnSync(['ps', '-p', String(pid), '-o', 'lstart=,command='], {
      stdout: 'pipe',
      stderr: 'ignore',
      env: { ...process.env, LC_ALL: 'C' }, // lstart text must not depend on the shell's locale
    })
    if (r.exitCode !== 0) return undefined
    const line = r.stdout.toString().replace(/\n$/, '')
    if (line.trim() === '') return undefined
    return withStableStart(pid, parsePsLine(line))
  } catch {
    return undefined
  }
}

/**
 * An existing bridge counts as alive and ours only if ps returns the SAME start time (so a recycled pid does not match)
 * AND a command containing apps/bridge/src/server.ts. Never kill by pattern.
 */
export function isOurBridge(rec: PidRecord, ps: (pid: number) => PsInfo | undefined = psInfo): boolean {
  const info = ps(rec.pid)
  if (!info?.command.includes(BRIDGE_ENTRY)) return false
  if (info.lstart === rec.started_at) return true
  // a pid file from a build before Linux read /proc holds ps's text: that one is compared the old way
  return info.psLstart !== undefined && !isProcToken(rec.started_at) && info.psLstart === rec.started_at
}

export type TakeOverDeps = {
  ps?: (pid: number) => PsInfo | undefined
  kill?: (pid: number, signal: NodeJS.Signals) => void
  sleep?: (ms: number) => Promise<void>
  alive?: (pid: number) => boolean
  selfPid?: number
}

const defaultAlive = (pid: number) => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

/** Stops the previous bridge (SIGTERM, waits up to 3 s) when, and only when, the PID file points at one that is ours. */
export async function takeOver(
  p: BridgePaths,
  log: Logger,
  deps: TakeOverDeps = {},
): Promise<'none' | 'stopped' | 'left_alone'> {
  const rec = readJsonFile<PidRecord>(p.pid)
  if (!rec || typeof rec.pid !== 'number' || rec.pid === (deps.selfPid ?? process.pid)) return 'none'
  if (!isOurBridge(rec, deps.ps)) {
    log.info('pid file points at something that is not our bridge; not touching it', { pid: rec.pid })
    return 'left_alone'
  }
  const kill = deps.kill ?? ((pid, sig) => process.kill(pid, sig))
  const sleep = deps.sleep ?? ((ms) => new Promise<void>((r) => setTimeout(r, ms)))
  const alive = deps.alive ?? defaultAlive
  log.info('stopping the previous bridge', { pid: rec.pid })
  try {
    kill(rec.pid, 'SIGTERM')
  } catch {
    return 'none'
  }
  for (let waited = 0; waited < 3000 && alive(rec.pid); waited += 100) await sleep(100)
  return 'stopped'
}

export function writePidFile(p: BridgePaths, selfPs: (pid: number) => PsInfo | undefined = psInfo): PidRecord {
  const rec: PidRecord = {
    pid: process.pid,
    started_at: selfPs(process.pid)?.lstart ?? '',
    instance: randomBytes(8).toString('hex'),
  }
  writeJsonAtomic(p.pid, rec, 0o600)
  return rec
}

export function removePidFileIfOurs(p: BridgePaths, instance: string) {
  if (!existsSync(p.pid)) return
  try {
    const rec = JSON.parse(readFileSync(p.pid, 'utf8')) as PidRecord
    if (rec.instance === instance) removeFile(p.pid)
  } catch {
    // unreadable: leave it
  }
}

/**
 * Bun exits on any unhandled promise rejection, so one SQLite-busy or closed-MCP error on a fire-and-forget path would
 * take the whole bridge (and the Mac's link to the app) down. Log it and keep running. Returns a disposer (tests).
 */
export function installRejectionLogger(log: Logger): () => void {
  const onRejection = (reason: unknown) => {
    log.error(
      'unhandled rejection',
      { error: reason instanceof Error ? reason.message : String(reason) },
      reason instanceof Error && reason.stack ? { stack: reason.stack } : {},
    )
  }
  process.on('unhandledRejection', onRejection)
  return () => process.off('unhandledRejection', onRejection)
}

export type LifecycleOptions = {
  shutdown: (reason: string) => Promise<void>
  log: Logger
  stdin?: NodeJS.ReadStream
  exit?: (code: number) => void
  watchdogMs?: number
}

/** Exit on stdin EOF/close and SIGTERM/INT/HUP; a 5 s watchdog on `stdin.destroyed`. Returns a disposer (tests). */
export function installLifecycle(o: LifecycleOptions): () => void {
  const stdin = o.stdin ?? process.stdin
  const exit = o.exit ?? ((c) => process.exit(c))
  let done = false
  const run = (reason: string) => {
    if (done) return
    done = true
    o.log.info('shutting down', { reason })
    const force = setTimeout(() => exit(0), 4000)
    o.shutdown(reason)
      .catch((e) => o.log.error('shutdown failed', { error: (e as Error).message }))
      .finally(() => {
        clearTimeout(force)
        exit(0)
      })
  }
  const sig = (s: NodeJS.Signals) => () => run(s)
  const onTerm = sig('SIGTERM')
  const onInt = sig('SIGINT')
  const onHup = sig('SIGHUP')
  process.on('SIGTERM', onTerm)
  process.on('SIGINT', onInt)
  process.on('SIGHUP', onHup)
  const onEnd = () => run('stdin closed')
  stdin.on('end', onEnd)
  stdin.on('close', onEnd)
  const dog = setInterval(() => {
    if (stdin.destroyed) run('stdin destroyed')
  }, o.watchdogMs ?? 5000)
  return () => {
    clearInterval(dog)
    process.off('SIGTERM', onTerm)
    process.off('SIGINT', onInt)
    process.off('SIGHUP', onHup)
    stdin.off('end', onEnd)
    stdin.off('close', onEnd)
  }
}
