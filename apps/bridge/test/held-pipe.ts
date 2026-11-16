// A child that exits while its own child (a backgrounded `sleep`) keeps the stdout pipe open: 'exit' comes at once, 'close'
// only when the sleep ends (30 s). Every grandchild started here is killed by the pid it printed, by `killHeldPipes`.
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const pids: number[] = []

/** `sh -c` text: background a sleep holding stdout, add its pid to `pidFile`, print `then`, exit with `code`. */
export function heldPipeScript(pidFile: string, then = 'echo done', code = 0): string {
  return `/bin/sleep 30 & echo $! >> '${pidFile}'; ${then}; exit ${code}`
}

/** An executable script at `dir/name` running `heldPipeScript`. */
export function heldPipeBin(dir: string, name: string, pidFile: string, then = 'echo done', code = 0): string {
  const p = join(dir, name)
  writeFileSync(p, `#!/bin/sh\n${heldPipeScript(pidFile, then, code)}\n`, { mode: 0o755 })
  return p
}

export function trackPid(pid: number) {
  if (pid > 0 && !pids.includes(pid)) pids.push(pid)
}

/** Reads the grandchild pids recorded in `files` and kills them (our own, by pid). */
export function killHeldPipes(files: string[] = []) {
  for (const f of files)
    if (existsSync(f)) for (const line of readFileSync(f, 'utf8').split('\n')) trackPid(Number(line))
  for (const pid of pids.splice(0)) {
    try {
      process.kill(pid, 'SIGKILL')
    } catch {
      // already gone
    }
  }
}
