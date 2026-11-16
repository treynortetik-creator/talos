// Waits for a child process to end, in bounded time. 'close' alone is not enough: it waits for every holder of the child's
// pipes, and a grandchild (a backgrounded helper, `sleep 30 &`) can hold stdout open long after the child itself exited, or
// forever. 'exit' alone is not enough either: output the child wrote can still be on its way. So: the first of 'close' or
// 'exit' wins; after 'exit' we wait up to `graceMs` for 'close' so the output can drain, then settle anyway.
//
// It never signals anything. A caller that kills on the deadline must check `stillRunning(child)` first: once the child has
// exited it is reaped, and its pid (and the process group of that number) can belong to someone else. A group is signalled
// after that only while it still has members (heartbeat/leftovers.ts).
import type { ChildProcess } from 'node:child_process'

export const CHILD_GRACE_MS = 500

export type ChildEnd = {
  code: number | null
  signal: NodeJS.Signals | null
  /**
   * close: the child exited and its pipes closed (all output read). exit: the child exited but its pipes were still held after
   * the grace (output a grandchild writes later is not read). deadline: still running at the deadline (code and signal null).
   * error: it never started.
   */
  how: 'close' | 'exit' | 'deadline' | 'error'
}

/** The child has not exited (as far as this process has seen): signalling its pid or group is still safe. */
export function stillRunning(child: ChildProcess): boolean {
  return child.exitCode === null && child.signalCode === null
}

/**
 * Settles on the first of: 'close'; 'exit' plus up to `graceMs` for 'close'; `deadlineMs` (Infinity: none); 'error' from a child
 * that never started (an error from a started child, such as an abort or a failed kill, does not end the wait: its exit still
 * comes). Codes are the child's own, never made up. Attach it right after spawn, before the child can end.
 */
export function waitChild(child: ChildProcess, o: { graceMs?: number; deadlineMs: number }): Promise<ChildEnd> {
  const graceMs = o.graceMs ?? CHILD_GRACE_MS
  return new Promise((resolve) => {
    let settled = false
    let deadline: ReturnType<typeof setTimeout> | undefined
    let grace: ReturnType<typeof setTimeout> | undefined
    const settle = (r: ChildEnd) => {
      if (settled) return
      settled = true
      clearTimeout(deadline)
      clearTimeout(grace)
      resolve(r)
    }
    const exited = () => {
      if (settled || grace) return
      grace = setTimeout(
        () => settle({ code: child.exitCode, signal: child.signalCode as NodeJS.Signals | null, how: 'exit' }),
        graceMs,
      )
    }
    child.on('close', (code: number | null, signal: NodeJS.Signals | null) => settle({ code, signal, how: 'close' }))
    child.on('exit', exited)
    child.on('error', () => {
      if (child.pid === undefined) settle({ code: null, signal: null, how: 'error' })
    })
    if (!stillRunning(child)) exited()
    if (Number.isFinite(o.deadlineMs))
      deadline = setTimeout(
        () => {
          // Exited already, inside the grace: that is an exit, not a deadline.
          if (!stillRunning(child))
            settle({ code: child.exitCode, signal: child.signalCode as NodeJS.Signals | null, how: 'exit' })
          else settle({ code: null, signal: null, how: 'deadline' })
        },
        Math.max(0, o.deadlineMs),
      )
  })
}
