// A thread's "compact at" point: tokens at which its own session compacts the conversation (session_opts.compact_window). The bridge
// puts it in the session's environment as CLAUDE_CODE_AUTO_COMPACT_WINDOW (apps/bridge/src/supervisor/compact-window.ts; the Mac's twin
// is WorkerSpec.compactWindowEnv). Claude Code's own floor is 100000.
import { z } from 'zod'

export const COMPACT_WINDOW_MIN = 100000
export const COMPACT_WINDOW_MAX = 1000000

/** What a write accepts: a whole number in range, null (the same as unset) or absent. */
export const CompactWindowStrict = z
  .number()
  .int()
  .min(COMPACT_WINDOW_MIN)
  .max(COMPACT_WINDOW_MAX)
  .nullable()
  .optional()

/** As read: a value this build cannot read (null included) is unset, never a reason to lose another field. */
export const CompactWindowRead = z
  .number()
  .int()
  .min(COMPACT_WINDOW_MIN)
  .max(COMPACT_WINDOW_MAX)
  .optional()
  .catch(undefined)
