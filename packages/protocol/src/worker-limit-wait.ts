// Claude Code's own wait at a usage limit, as workers.json keeps it in a session's entry (thread-sessions.ts WorkerEntry.limit_wait).
import { z } from 'zod'
import { IsoTs } from './ids.ts'

/**
 * Claude Code's own wait at a usage limit (its `autoContinueAtUsageLimit` timer, armed in the session's process) was on the pane since
 * `since`, ending at `reset` when the notice named one. While it shows, nothing automatic parks or restarts the session (the timer would
 * go with the process); it ends at the reset plus 15 minutes or 6 hours after `since`, whichever is first. A value that does not fit
 * reads as none.
 */
export const WorkerLimitWait = z.object({ since: IsoTs, reset: IsoTs.optional().catch(undefined) })
export type WorkerLimitWaitT = z.infer<typeof WorkerLimitWait>
