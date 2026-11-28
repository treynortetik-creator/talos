// A thread's "compact at" point (session_opts.compact_window) as the environment variable Claude Code reads for it. It outranks the
// autoCompactWindow setting there. The name is one the launch keeps from a login environment (claude-env.ts KEEP), so a launch that
// sets it passes validateSpec. It is also written into the worker's --settings env (worker-spec.ts), since the owner's user settings
// env outranks the process env. WorkerInputs.compactWindow is the thread's value (null or absent: not set). Plain digits (Claude Code also reads 400k, but one spelling is one spec hash).
import { COMPACT_WINDOW_MAX, COMPACT_WINDOW_MIN } from '@talos-app/protocol'

export const COMPACT_WINDOW_ENV = 'CLAUDE_CODE_AUTO_COMPACT_WINDOW'

/** The variable for a thread's value: nothing for unset, and nothing for a value outside the range (never a value Claude Code would refuse). */
export function compactWindowEnv(n: number | null | undefined): Record<string, string> {
  const ok = typeof n === 'number' && Number.isInteger(n) && n >= COMPACT_WINDOW_MIN && n <= COMPACT_WINDOW_MAX
  return ok ? { [COMPACT_WINDOW_ENV]: String(n) } : {}
}
