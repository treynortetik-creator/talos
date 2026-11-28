import { t } from './time-factor.ts'

/** The part of a ChildProcess these waits need: Node sets exitCode or signalCode the moment the child has exited. */
export type ChildLike = {
  exitCode: number | null
  signalCode: NodeJS.Signals | string | null
  kill(signal?: NodeJS.Signals | number): boolean
}

const exited = (c: ChildLike): boolean => c.exitCode !== null || c.signalCode !== null

/**
 * Resolves when the child process object has exited (its exitCode or signalCode is set), polling every 25 ms, for at most `ms`
 * (t(10_000) by default). A child that has not exited by then gets SIGKILL through the child object, which Node only delivers
 * to a process it has not yet reaped, and 2 more seconds. Never signals a bare pid number: Node reaps a child at once, and a
 * pid can be handed to another process of ours within seconds. A child that has already exited is never signalled, and is not
 * waited for. Returns whether it has exited.
 *
 * The MCP SDK's close() ends stdin, signals, and SIGKILLs without waiting for the exit: whoever then removes the folder the
 * process writes into must wait here first, or the removal races its last write (ENOTEMPTY).
 */
export async function waitForChildGone(child: ChildLike, ms: number = t(10_000)): Promise<boolean> {
  const until = async (limit: number) => {
    for (const end = Date.now() + limit; Date.now() < end; ) {
      if (exited(child)) return true
      await new Promise((r) => setTimeout(r, 25))
    }
    return exited(child)
  }
  if (await until(ms)) return true
  if (!exited(child)) child.kill('SIGKILL') // still running: this object is the process, not a recycled number
  return until(2000)
}

/**
 * Waits, for at most `ms`, until nothing answers to `pid` any more. It only looks: it never sends a signal, because a bare pid
 * may belong to another process by now. For a caller that has no child object to wait on. Returns whether it is gone.
 */
export async function waitForPidToVanish(pid: number, ms: number = t(10_000)): Promise<boolean> {
  const alive = () => {
    try {
      process.kill(pid, 0)
      return true
    } catch (e) {
      return (e as NodeJS.ErrnoException).code === 'EPERM'
    }
  }
  for (const end = Date.now() + ms; Date.now() < end; ) {
    if (!alive()) return true
    await new Promise((r) => setTimeout(r, 25))
  }
  return !alive()
}
