import { spawn, spawnSync } from 'node:child_process'
import { CHILD_GRACE_MS, stillRunning, waitChild } from './child-wait.ts'

export type RunResult = { code: number; out: string }
/** What a caller may ask of one run: a time limit, and a whole environment for the command (none: it inherits this process's). */
export type RunOpts = { timeoutMs?: number; env?: Record<string, string | undefined> }
export type Run = (cmd: string[], cwd: string, opts?: RunOpts) => RunResult

/** Runs a command with an argument vector (never a shell). stdout and stderr come back together, trimmed. 127 when it can't start. A number is a time limit in ms. */
export function runCommand(cmd: string[], cwd: string, opts?: number | RunOpts): RunResult {
  const o: RunOpts = typeof opts === 'number' ? { timeoutMs: opts } : (opts ?? {})
  try {
    const r = spawnSync(cmd[0] as string, cmd.slice(1), {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      ...(o.timeoutMs ? { timeout: o.timeoutMs } : {}),
      ...(o.env ? { env: o.env } : {}),
    })
    if (r.error) return { code: 127, out: r.error.message }
    return { code: r.status ?? 1, out: `${r.stdout}${r.stderr}`.trim() }
  } catch (e) {
    return { code: 127, out: (e as Error).message }
  }
}

/** `stopped`: the command was stopped early by `stopAt`. Its code is then 0 but stdout is CUT: check `stopped`. */
export type AsyncRunResult = { code: number; stdout: string; stderr: string; stopped?: true }
export type AsyncRunOpts = {
  env?: Record<string, string | undefined>
  signal?: AbortSignal
  /** Written to the command's stdin, which is then closed (none: stdin is empty). */
  input?: string
  /** Stop the command once stdout holds more than `nuls` NUL bytes or more than `bytes` characters (a long -z list). */
  stopAt?: { nuls: number; bytes: number }
}
export type RunAsync = (cmd: string[], cwd: string, opts?: AsyncRunOpts) => Promise<AsyncRunResult>

/**
 * runCommand without blocking the event loop, with its own environment and an abort signal that kills the command.
 * stdout and stderr come back apart (git prints an object id on stdout and warnings on stderr). 127 when it can't start.
 * It returns once the command exits (plus a short grace for its output), even when a background child still holds its output.
 */
export function runCommandAsync(cmd: string[], cwd: string, opts: AsyncRunOpts = {}): Promise<AsyncRunResult> {
  return new Promise((resolve) => {
    let child: ReturnType<typeof spawn>
    try {
      child = spawn(cmd[0] as string, cmd.slice(1), {
        cwd,
        stdio: [opts.input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
        ...(opts.env ? { env: opts.env } : {}),
      })
      if (opts.input !== undefined) {
        child.stdin?.on('error', () => {}) // a command that exits without reading: its exit code says what happened
        child.stdin?.end(opts.input)
      }
    } catch (e) {
      resolve({ code: 127, stdout: '', stderr: (e as Error).message })
      return
    }
    let stdout = ''
    let stderr = ''
    let done = false
    let nuls = 0
    const finish = (code: number, stopped = false) => {
      if (done) return
      done = true
      opts.signal?.removeEventListener('abort', onAbort)
      clearTimeout(hard)
      child.stdout?.destroy()
      child.stderr?.destroy()
      resolve({ code, stdout: stdout.replace(/\n$/, ''), stderr: stderr.trim(), ...(stopped ? { stopped: true } : {}) })
    }
    child.stdout?.setEncoding('utf8').on('data', (d: string) => {
      stdout += d
      const cap = opts.stopAt
      if (!cap) return
      for (let i = d.indexOf('\0'); i !== -1; i = d.indexOf('\0', i + 1)) nuls++
      if (nuls > cap.nuls || stdout.length > cap.bytes) {
        if (stillRunning(child)) child.kill()
        finish(0, true)
      }
    })
    child.stderr?.setEncoding('utf8').on('data', (d: string) => {
      stderr += d
    })
    let spawnError = ''
    child.on('error', (e) => {
      spawnError ||= e.message
    })
    // An abort kills the command (by pid), only while it runs: once it has exited its number may be someone else's. SIGTERM
    // first; one that ignores it gets SIGKILL after the grace, so an abort always ends the wait.
    let hard: ReturnType<typeof setTimeout> | undefined
    function onAbort() {
      if (!stillRunning(child)) return
      child.kill()
      hard = setTimeout(() => {
        if (stillRunning(child)) child.kill('SIGKILL')
      }, CHILD_GRACE_MS)
    }
    opts.signal?.addEventListener('abort', onAbort, { once: true })
    if (opts.signal?.aborted) onAbort()
    // 'close' waits for every holder of the pipes, and a child of the command (a hook's background job) may hold them for
    // good: the exit of the command itself, plus a short grace for its output, is enough.
    void waitChild(child, { deadlineMs: Number.POSITIVE_INFINITY }).then((end) => {
      if (end.how === 'error') {
        stderr = spawnError
        return finish(127)
      }
      finish(end.code ?? 1)
    })
  })
}
