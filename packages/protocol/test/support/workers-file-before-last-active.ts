// A pinned copy of the workers.json schema as it was before `last_active_at` (origin/main 2827cd3a): what a bridge that has not been
// updated yet reads the file with. Only the shape of the two objects is pinned here; the parts that did not change (ids, the dialog,
// the launch record, the failure codes) come from the source. Do not edit it to follow the schema: its job is to stay old.
import { z } from 'zod'
import { WorkerDialog } from '../../src/dialog-files.ts'
import { IsoTs, ThreadId } from '../../src/ids.ts'
import {
  AbsolutePath,
  WorkerCeilingAxis,
  WorkerFailure,
  WorkerLaunched,
  WorkerModel,
  WorkerState,
} from '../../src/thread-sessions.ts'

const SessionUuid = z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/)

export const OldWorkerEntry = z.object({
  state: WorkerState,
  session_id: SessionUuid.nullable().default(null),
  previous_ids: z.array(SessionUuid).max(5).default([]),
  tmux: z.string().regex(/^t-[a-z][a-z0-9_]{0,31}$/),
  pane_pid: z.number().int().nonnegative().default(0),
  cwd: AbsolutePath,
  model: WorkerModel.default('inherit'),
  started_at: IsoTs.nullable().default(null),
  last_turn_at: IsoTs.nullable().default(null),
  parked_at: IsoTs.nullable().default(null),
  restarts: z.array(IsoTs).max(10).default([]),
  error: z
    .object({
      code: z.enum([...WorkerFailure.options, 'unknown']).catch('unknown'),
      detail: z.string().max(300).optional(),
      at: IsoTs,
      axis: WorkerCeilingAxis.optional().catch(undefined),
    })
    .nullable()
    .default(null),
  dialog: WorkerDialog.optional().catch(undefined),
  launched: WorkerLaunched.optional().catch(undefined),
})

export const OldWorkersFile = z.object({
  v: z.literal(1),
  supervisor: z.object({
    pid: z.number().int().nonnegative(),
    heartbeat_at: IsoTs,
    workers_supported: z.boolean().default(false),
    main_pane_pid: z.number().int().nonnegative().default(0),
  }),
  threads: z.record(ThreadId, OldWorkerEntry).default({}),
})

/** `parseWorkersFile` of that bridge: null for anything it cannot read. */
export function oldParseWorkersFile(text: string) {
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    return null
  }
  const res = OldWorkersFile.safeParse(raw)
  return res.success ? res.data : null
}
