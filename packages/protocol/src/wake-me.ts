// `wake_me` (docs/OPTION-C.md "Wake me"): an agent asks to be woken at a time with a short note to itself. It is a one-shot
// job in the scheduler, written by the bridge without a card (it only wakes the session that set it, in its own thread),
// delivered as `kind=wake`, `trust=agent`: the agent's own earlier words, never the owner's. These are the shapes and limits
// every side shares; the bridge keeps the record (apps/bridge/src/wake-me).
import { z } from 'zod'
import { IsoTs } from './ids.ts'

/** The note an agent leaves itself, in characters (code points). */
export const WAKE_NOTE_MAX = 280
/** Past this many days ahead the wake is still set, with a warning to the agent. */
export const WAKE_WARN_DAYS = 7
/** Past this many pending wakes in one lane (a thread, or main) a new one is still set, with a warning. */
export const WAKE_WARN_PENDING = 20
/**
 * Sanity caps that refuse: a year ahead, and this many pending across every session together. Each wake is a job in the
 * scheduler, whose snapshot lists 200 jobs at most (MAX_SCHEDULES_PER_SNAPSHOT): wakes keep to half of that, so they can
 * never push the owner's own jobs out of the Schedules tab.
 */
export const WAKE_MAX_DAYS = 366
export const WAKE_MAX_PENDING = 100
/** How often one session's wakes may fire: past either, its wakes are paused (refused when set, dropped when due). */
export const WAKE_FIRES_PER_HOUR = 6
export const WAKE_FIRES_PER_DAY = 48
/**
 * The scheduler job's prompt. The note itself lives only in the bridge's row: a bridge that does not know wakes (an older one
 * after a downgrade) would offer the job as an owner-trusted `schedule_run`, and it must then carry nothing of the agent's.
 */
/** The scheduler job's name, fixed for the same reason. */
export const WAKE_JOB_NAME = 'Talos wake-up'
export const WAKE_JOB_PROMPT = 'Talos wake: delivered by the bridge. Nothing to run here.'
/** How many of a lane's pending wakes `workers.status` carries (soonest first); `wakes_total` says how many there are. */
export const WAKE_STATUS_MAX = 20

/** A wake's id: also its scheduler job id, so it fits the scheduler's id rule (`ScheduleId`). */
export const WAKE_ID_PREFIX = 'talos-wake-'
export const WakeId = z.string().regex(/^talos-wake-[a-z0-9]{12}$/)
export type WakeIdT = z.infer<typeof WakeId>
/** True for an id in the range kept for wakes: the card path refuses a job of its own there. */
export const isWakeJobId = (id: string): boolean => id.startsWith(WAKE_ID_PREFIX)

/**
 * One pending wake as the app sees it. Loose where it reads: a field this build can't read costs the row (`PendingWakes`
 * drops it), never the frame.
 */
export const PendingWake = z.object({
  id: WakeId,
  at: IsoTs,
  note: z.string().max(WAKE_NOTE_MAX * 2),
  set_at: IsoTs.optional().catch(undefined),
})
export type PendingWakeT = z.infer<typeof PendingWake>

/** A list of pending wakes read one row at a time: a row that does not parse is dropped and the rest are kept. */
export const PendingWakes = z
  .array(z.unknown())
  .max(WAKE_STATUS_MAX * 2)
  .transform((rows) =>
    rows.flatMap((r) => {
      const p = PendingWake.safeParse(r)
      return p.success ? [p.data] : []
    }),
  )
