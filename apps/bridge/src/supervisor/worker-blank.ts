// A thread session's runtime before anything has started or been adopted. Moved out of workers.ts unchanged, to keep that file in budget.
import type { WorkerEntryT } from '@talos-app/protocol'
import { NOTHING_OWED } from './owed-pointer.ts'
import { newOfferState } from './worker-dialogs.ts'
import { NEW_BUSY_WATCH } from './worker-idle.ts'
import { NO_CHANGE_PENDING } from './worker-launch.ts'
import { newNoticeRuntime } from './worker-notices.ts'
import type { WorkerRuntime } from './worker-types.ts'

export function blankWorker(id: string, entry: WorkerEntryT): WorkerRuntime {
  // pane text of an earlier supervisor is never carried (workers.json `quiet_lines`): this one writes its own from what it sees
  const { quiet_lines: _stale, ...rest } = entry
  return {
    id,
    entry: rest as WorkerEntryT,
    host: null,
    startedAt: null,
    parkAt: null,
    killed: false,
    afterPark: null,
    endAs: null,
    baseEnv: null,
    owed: NOTHING_OWED,
    notes: newNoticeRuntime(),
    offer: newOfferState(),
    idle: { lastActiveMs: 0, activeMono: 0, body: null },
    busyWatch: NEW_BUSY_WATCH,
    rows: null,
    held: null,
    turnWait: null,
    launchChange: NO_CHANGE_PENDING,
  }
}
