import { spawnSync } from 'node:child_process'

export type RunResult = { code: number; out: string }
export type Run = (cmd: string[], cwd: string) => RunResult

/** Runs a command with an argument vector (never a shell). stdout and stderr come back together, trimmed. 127 when it can't start. */
export function runCommand(cmd: string[], cwd: string, timeoutMs?: number): RunResult {
  try {
    const r = spawnSync(cmd[0] as string, cmd.slice(1), {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      ...(timeoutMs ? { timeout: timeoutMs } : {}),
    })
    if (r.error) return { code: 127, out: r.error.message }
    return { code: r.status ?? 1, out: `${r.stdout}${r.stderr}`.trim() }
  } catch (e) {
    return { code: 127, out: (e as Error).message }
  }
}
