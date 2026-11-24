// talos-app doctor's rows for the deaf-thread alarm (deaf-thread.ts): a thread whose session shows something Talos does not
// recognise cannot be typed into, so its messages, scheduled runs and card taps wait for it and, if it stays that way, go to Main at their deadline. A warning, never a failure (the
// doctor exits 0 for a warning, as for the others), so a job that runs the doctor can catch it.
import { DEAF_NOTICE_AFTER_S } from '@talos-app/protocol'
import type { Check } from './doctor-checks.ts'
import { readDeafThreads } from './router/deaf.ts'

/** One WARN row per thread the supervisor reports as untypeable for longer than the alarm's own wait. */
export function deafThreadChecks(home: string, nowMs: number = Date.now()): Check[] {
  return readDeafThreads(home, nowMs)
    .filter((d) => nowMs - d.since >= DEAF_NOTICE_AFTER_S * 1000)
    .map((d) => ({
      level: 'warn' as const,
      name: `thread ${d.thread}`,
      detail: `Talos can't type into this thread's session: ${d.minutes} min, ${d.refusals_1h} refused ${d.refusals_1h === 1 ? 'key' : 'keys'} in the last hour. If it stays that way, Main answers its messages and scheduled runs. Look at what its screen shows.`,
    }))
}
