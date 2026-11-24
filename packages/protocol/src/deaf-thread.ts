// The deaf-thread alarm: a thread's own session shows something Talos does not recognise on its screen, so Talos cannot type
// into it, and its messages, scheduled runs and card taps go to Main at their deadline if it stays that way. Two files in $TALOS_APP_HOME, each with ONE writer:
// - deaf-threads.json: the supervisor (the Mac app, or the Linux supervisor) writes which threads cannot be typed into right
//   now, since when and how many refusals this hour; `talos-app doctor`, the Health page and `workers.status` read it.
// - main-handled.json: the bridge's router writes what it gave Main because a thread's session did not take it; the supervisor
//   reads it to say, when typing works again, what Main answered meanwhile. Entries only ever get appended (and old ones age
//   out), so the reader never has to clear anything.
// Both are read defensively: a missing, unreadable, stale or future-dated file says nothing.
import { z } from 'zod'
import { ThreadId } from './ids.ts'

export const DEAF_THREADS_FILE = 'deaf-threads.json'
export const MAIN_HANDLED_FILE = 'main-handled.json'
/** A real file is a few hundred bytes; a bigger one is not read. */
export const DEAF_FILE_MAX_BYTES = 64 * 1024
/** The tally holds up to MAIN_HANDLED_MAX_PER_THREAD entries per thread, compact: well under this for every thread a week can list. */
export const MAIN_HANDLED_MAX_BYTES = 256 * 1024

/** Seconds of continuous refusal before the thread is told (once). */
export const DEAF_NOTICE_AFTER_S = 60
/** Seconds of continuous refusal before it shows as Needs you (the phone, the thread list). */
export const DEAF_NEEDS_YOU_AFTER_S = 600
/** The supervisor rewrites deaf-threads.json at least this often while a thread is deaf. */
export const DEAF_FILE_WRITE_MS = 15_000
/** Older than this by its own `at`: the supervisor is not running, and an old wait must not read as now. */
export const DEAF_FILE_STALE_MS = 60_000
/** Dated further ahead than this: a skewed or forged clock says nothing. */
export const DEAF_FILE_MAX_FUTURE_MS = 5_000

/** What Main handled for a thread whose session could not be reached: an owner message, a scheduled run, a card tap. */
export const MAIN_HANDLED_KINDS = ['message', 'run', 'card'] as const
export type MainHandledKindT = (typeof MAIN_HANDLED_KINDS)[number]
/** Entries kept per thread, and how long (the longest hold seen was about 35 hours). */
export const MAIN_HANDLED_MAX_PER_THREAD = 100
export const MAIN_HANDLED_KEEP_MS = 7 * 24 * 3600_000

const Ms = z.number().int().nonnegative().max(8_640_000_000_000_000)

export const DeafThreadsFile = z.object({
  v: z.literal(1),
  /** When the supervisor wrote it, epoch ms. */
  at: Ms,
  threads: z
    .record(
      ThreadId,
      z.object({
        /** When the refusals began, epoch ms. */
        since: Ms,
        /** Refusals of a key for this thread in the last hour. */
        refusals_1h: z.number().int().nonnegative().max(1_000_000),
      }),
    )
    .default({}),
})
export type DeafThreadsFileT = z.infer<typeof DeafThreadsFile>

export const MainHandledFile = z.object({
  v: z.literal(1),
  threads: z
    .record(
      ThreadId,
      z
        .array(z.object({ at: Ms, kind: z.enum(MAIN_HANDLED_KINDS).catch('message') }))
        .max(MAIN_HANDLED_MAX_PER_THREAD * 10),
    )
    .default({}),
})
export type MainHandledFileT = z.infer<typeof MainHandledFile>

/** How long a thread has been deaf, in whole minutes (at least 1 once it is listed). */
export const deafMinutes = (sinceMs: number, nowMs: number): number =>
  Math.max(1, Math.floor((nowMs - sinceMs) / 60_000))
