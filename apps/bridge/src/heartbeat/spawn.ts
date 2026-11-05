// Runs one heartbeat source as a process (docs/HEARTBEAT.md, docs/SCHEDULES.md S1.7): argv exactly as configured, never a
// shell, an own process group so a hung source and everything it started can be killed by PID, a minimal base environment
// (no inherited secrets), and a hard cap on what it may print. Never throws: every way it can go wrong is a plain result.
import { spawn } from 'node:child_process'
import { HEARTBEAT_SOURCE_MAX_BYTES } from '@talos-app/protocol'

/** Not a secret, and enough for a source to find its own tools and its own credential files. Nothing else is inherited. */
const BASE_PATH = '/usr/bin:/bin:/usr/sbin:/sbin:/usr/local/bin:/opt/homebrew/bin'
const STDERR_KEEP = 1024

export function baseEnv(userHome: string, extra: Record<string, string> = {}): Record<string, string> {
  return { PATH: BASE_PATH, HOME: userHome, LANG: 'C.UTF-8', TALOS_HEARTBEAT: '1', ...extra }
}

export type SpawnResult =
  | { ok: true; stdout: string; stderr: string; code: number }
  | { ok: false; reason: 'timeout' | 'aborted' | 'too_big' | 'spawn'; message: string }

export type SpawnOptions = {
  argv: readonly string[]
  cwd?: string | undefined
  env: Record<string, string>
  stdin: string
  timeoutMs: number
  signal?: AbortSignal | undefined
  maxBytes?: number
}

/**
 * Kills a process group by PID, never by name. `leaderGone`: the leader has already exited, so only the group is signalled (a
 * lone-PID signal could hit an unrelated process that reused the number).
 */
export function killGroup(pid: number | undefined, leaderGone = false) {
  if (!pid) return
  try {
    process.kill(-pid, 'SIGKILL')
  } catch {
    if (leaderGone) return
    try {
      process.kill(pid, 'SIGKILL')
    } catch {
      // already gone
    }
  }
}

export function runSource(o: SpawnOptions): Promise<SpawnResult> {
  const max = o.maxBytes ?? HEARTBEAT_SOURCE_MAX_BYTES
  return new Promise((resolve) => {
    const [cmd, ...args] = o.argv
    if (!cmd) return resolve({ ok: false, reason: 'spawn', message: 'the command is empty' })
    if (o.signal?.aborted) return resolve({ ok: false, reason: 'aborted', message: 'stopped before it started' })
    let child: ReturnType<typeof spawn>
    try {
      child = spawn(cmd, args, {
        stdio: ['pipe', 'pipe', 'pipe'],
        env: o.env,
        ...(o.cwd ? { cwd: o.cwd } : {}),
        detached: true,
      })
    } catch (e) {
      return resolve({ ok: false, reason: 'spawn', message: `could not start it: ${(e as Error).message}` })
    }
    const out: Buffer[] = []
    let bytes = 0
    let stderr = ''
    let settled = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const done = (r: SpawnResult) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      o.signal?.removeEventListener('abort', onAbort)
      resolve(r)
    }
    const stop = (r: Extract<SpawnResult, { ok: false }>) => {
      if (settled) return
      killGroup(child.pid)
      child.stdout?.destroy()
      child.stderr?.destroy()
      done(r) // the caller never waits for a pipe a grandchild may hold open
    }
    const onAbort = () => stop({ ok: false, reason: 'aborted', message: 'stopped' })
    o.signal?.addEventListener('abort', onAbort, { once: true })
    timer = setTimeout(
      () => stop({ ok: false, reason: 'timeout', message: `no answer within ${Math.round(o.timeoutMs / 1000)} s` }),
      o.timeoutMs,
    )
    child.on('error', (e) => done({ ok: false, reason: 'spawn', message: `could not start it: ${e.message}` }))
    child.stdout?.on('data', (d: Buffer) => {
      bytes += d.length
      if (bytes > max) return stop({ ok: false, reason: 'too_big', message: `printed more than ${max} bytes` })
      out.push(d)
    })
    child.stderr?.on('data', (d: Buffer) => {
      if (stderr.length < STDERR_KEEP) stderr += d.toString('utf8').slice(0, STDERR_KEEP - stderr.length)
    })
    child.on('close', (code) => {
      // A source that exits cleanly can leave a child running (a backgrounded helper with its pipes closed). The group goes
      // with it. A process that left the group on purpose (setsid) is out of reach: a known limit, see docs/HEARTBEAT.md.
      if (!settled) killGroup(child.pid, true)
      done({ ok: true, stdout: Buffer.concat(out).toString('utf8'), stderr, code: code ?? -1 })
    })
    // a source that never reads its stdin must not crash the bridge with EPIPE
    child.stdin?.on('error', () => {})
    child.stdin?.end(o.stdin)
  })
}
