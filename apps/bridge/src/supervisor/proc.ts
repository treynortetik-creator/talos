// Running tmux and signalling process groups, for the Linux (and WSL) supervisor.
// A process is identified by pid AND start time, so a reused pid is never mistaken for ours. Reading the start time is the
// shared pid-identity helper's job (proc-identity.ts: /proc/<pid>/stat field 22 on Linux and WSL, where `ps -o lstart` drifts);
// this file never reads it itself. The host takes a ProcIdentity so a test can fake a reused pid.
export type RunResult = { ok: boolean; status: number; out: string; err: string; timedOut: boolean }

import { processGroup, processStartTime } from '../proc-identity.ts'

/** The pid-identity functions the supervisor needs. */
export interface ProcIdentity {
  /** A value that never changes for one process, or null when it is gone. */
  processStartTime(pid: number): string | null
  /** The process group id, or null when the process is gone. */
  processGroup(pid: number): number | null
}

/** The shared helper (proc-identity.ts): /proc/<pid>/stat on Linux and WSL, where `ps -o lstart` drifts. */
export const systemIdentity: ProcIdentity = {
  processStartTime: (pid) => processStartTime(pid),
  processGroup: (pid) => processGroup(pid),
}

/** Runs argv (no shell) with exactly `env`, kills it after `timeoutMs`. A tool that cannot start is status 127. */
export async function runTool(argv: string[], env: Record<string, string>, timeoutMs = 10_000): Promise<RunResult> {
  let proc: ReturnType<typeof Bun.spawn>
  try {
    proc = Bun.spawn(argv, { env, stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' })
  } catch (e) {
    return { ok: false, status: 127, out: '', err: (e as Error).message, timedOut: false }
  }
  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    proc.kill('SIGKILL')
  }, timeoutMs)
  try {
    const [out, err, status] = await Promise.all([
      new Response(proc.stdout as ReadableStream).text(),
      new Response(proc.stderr as ReadableStream).text(),
      proc.exited,
    ])
    return { ok: status === 0 && !timedOut, status: timedOut ? -1 : status, out, err, timedOut }
  } finally {
    clearTimeout(timer)
  }
}

/** Anything still alive in process group `pgid` (kill 0 to the group; EPERM means alive but not ours to signal). */
export function groupAlive(pgid: number): boolean {
  if (!Number.isInteger(pgid) || pgid <= 1) return false
  try {
    process.kill(-pgid, 0)
    return true
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM'
  }
}

/**
 * Signals the process group led by `pid` (the agent this host started at `started`). The Mac's GroupSignaller rule:
 * - while `pid` is alive it must still be that process (same start time) and still lead its own group; a reused pid, or one
 *   that left its group, is never signalled, and a pid whose start time cannot be read is not provably ours;
 * - once `pid` is gone, its group is signalled while anything is left in it: the agent's children (MCP servers) outlive it,
 *   and the cleanup before a restart must end them. Linux does not hand out a pid that is still in use as a group id, so a
 *   live group `pid` is still that agent's group;
 * - never this process's own group, never pid 0 or 1.
 */
export function signalOwnGroup(id: ProcIdentity, pid: number, started: string, signal: NodeJS.Signals): boolean {
  if (!Number.isInteger(pid) || pid <= 1 || pid === process.pid) return false
  if (pid === id.processGroup(process.pid)) return false
  if (leaderAlive(pid)) {
    if (id.processStartTime(pid) !== started || id.processGroup(pid) !== pid) return false
  } else if (!groupAlive(pid)) return false
  try {
    process.kill(-pid, signal)
    return true
  } catch {
    return false
  }
}

function leaderAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM'
  }
}
