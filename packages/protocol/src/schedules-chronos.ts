// The Chronos 0.3 `chronos api <verb>` wire format (JSON on stdout), as the REAL CLI prints it: the vendored goldens
// (packages/testkit/fixtures/chronos-0.3/) plus real output for records an upgraded or hand-edited install holds
// (packages/testkit/review-fixtures/). packages/protocol/test/chronos-goldens.test.ts and review-s0-real-chronos.test.ts
// prove they all parse.
//
// Rules (review F1, F2):
// - The wire schemas describe what Chronos EMITS, not what Talos lets the owner write. Edit limits (name 60, catch-up
//   15-1440, ...) live in ScheduleDraft only; a job beyond them is shown read-only by scheduleFromChronos().
// - A snapshot is read ROW BY ROW (parseChronosSnapshot): one unreadable record becomes one `unreadable` row plus an
//   issue, never a dead list.
import { z } from 'zod'
import { IsoTs, Sha256Ref, type ThreadId } from './ids.ts'
import {
  DayState,
  DISPLAY_LIMITS,
  deriveWaitReason,
  EDIT_LIMITS,
  IanaZone,
  JobMeta,
  RunId,
  RunKey,
  type ScheduleChangeT,
  ScheduleDraft,
  ScheduleId,
  ScheduleLastRun,
  ScheduleNotify,
  SchedulePermissions,
  SchedulePreview,
  ScheduleRunner,
  type ScheduleT,
  ScheduleWhen,
  safeLine,
} from './schedules.ts'

const Fields = z.array(z.strictObject({ path: z.string(), message: z.string() }))

/** Every verb's failure shape: `{"error":{code, message, fields}}`, exit 1. Codes are Chronos's own (not_found, ...). */
export const ChronosError = z.strictObject({
  error: z.strictObject({ code: z.string().min(1).max(64), message: z.string(), fields: Fields }),
})

/**
 * Loose on purpose: a key a newer Chronos adds here must not close the whole scheduler (detect() throws on a parse
 * failure). `features` (`times`, `meta`) arrived with Chronos PR #6; an unreadable value reads as "none".
 */
export const ChronosVersion = z.looseObject({
  api: z.number().int(),
  chronos: z.string().max(40),
  session_runner: z.enum(['talos', 'hook']),
  approval_required: z.boolean(),
  features: z.array(z.string().max(40)).max(40).optional().catch(undefined),
})

/** A job as Chronos reports it (`describe()`): loose on lengths and ranges, strict on shape. */
/** A run as Chronos reports it. Runs it rebuilt from older ran-markers carry run_id, started_at and runner as null
 * (they were never recorded); Talos's run type leaves those fields out instead, so nulls are dropped before the check. */
export const ChronosLastRun = z.preprocess(
  (v) =>
    v !== null && typeof v === 'object' && !Array.isArray(v)
      ? Object.fromEntries(Object.entries(v).filter(([, x]) => x !== null))
      : v,
  ScheduleLastRun,
)

export const ChronosJob = z.strictObject({
  id: ScheduleId,
  name: z.string().min(1),
  description: z.string(),
  kind: z.enum(['claude', 'command']),
  when: ScheduleWhen,
  when_text: z.string(),
  catchup_min: z.number().int(),
  enabled: z.boolean(),
  paused: z.boolean(),
  runner: ScheduleRunner,
  permissions: SchedulePermissions,
  allowed_tools: z.array(z.string()),
  model: z.string().nullable(),
  notify: ScheduleNotify,
  triggers_count: z.number().int().nonnegative(),
  next_run: IsoTs.nullable(),
  today: DayState,
  ds: RunKey, // the run key of the slot (or date) the job is "at"; the same job can show either shape on different days
  date_key: RunKey.optional(), // Chronos 0.3.1+: the key Run now would use; Talos asks for it with `ds: null` and never reads it
  window_ends: IsoTs.nullable(),
  last_run: ChronosLastRun.nullable(),
  meta: JobMeta.optional(),
  prompt_preview: z.string(),
  prompt_bytes: z.number().int().nonnegative(),
  editable: z.boolean(),
  read_only_reason: z.string().nullable(),
  changed_outside: z.boolean(),
  etag: Sha256Ref,
  content_hash: Sha256Ref,
  state_rev: Sha256Ref,
})
/** Chronos's own "this record is broken" row. */
export const ChronosBrokenJob = z.strictObject({ id: z.string(), error: z.string() })
export const ChronosJobRow = z.union([ChronosJob, ChronosBrokenJob])

const SnapshotHead = {
  api: z.number().int(),
  chronos: z.string().max(40),
  as_of: IsoTs,
  tz: IanaZone,
  session_runner: z.enum(['talos', 'hook']),
  approval_required: z.boolean(),
  paused_all: z.boolean(),
  session_beat_age_s: z.number().int().nonnegative().nullable(),
  tick_age_s: z.number().int().nonnegative().nullable(),
  jobs_file: z.string(),
  state_dir: z.string(),
  registry_synced_folder: z.boolean(),
}
/** The whole answer, every row typed (what the goldens are checked against). */
export const ChronosSnapshot = z.strictObject({ ...SnapshotHead, schedules: z.array(ChronosJobRow) })
/** The envelope the adapter parses first; rows go through parseChronosSnapshot one by one. A new head key is ignored, not fatal. */
export const ChronosSnapshotEnvelope = z.looseObject({ ...SnapshotHead, schedules: z.array(z.unknown()) })

export const ChronosDetail = z.strictObject({
  schedule: ChronosJob,
  prompt: z.string(), // Chronos allows 200 KB; the adapter truncates to 64 KiB
  prompt_truncated: z.boolean(),
  guard: z.string().nullable(),
  next_runs: z.array(IsoTs).max(3),
  runs: z.array(ChronosLastRun),
})

/** The draft as Chronos sees it: Talos-only fields stripped (S3.4 step 1). */
export const ChronosDraft = ScheduleDraft.omit({ thread_id: true })
export const ChronosChange = z.discriminatedUnion('op', [
  z.strictObject({ op: z.literal('create'), draft: ChronosDraft }),
  z.strictObject({
    op: z.literal('update'),
    id: ScheduleId,
    base_etag: Sha256Ref,
    set: ChronosDraft.omit({ id: true }).partial().extend({ meta: JobMeta.nullable().optional() }),
  }),
  z.strictObject({ op: z.literal('delete'), id: ScheduleId, base_etag: Sha256Ref }),
  z.strictObject({ op: z.literal('adopt'), id: ScheduleId, content_hash: Sha256Ref }),
])

export const ChronosValidateOk = z.strictObject({
  ok: z.literal(true),
  normalized: ChronosChange,
  preview: SchedulePreview,
  expected_etag: Sha256Ref.nullable(),
})
export const ChronosWriteOk = z.strictObject({ ok: z.literal(true), id: ScheduleId, etag: Sha256Ref.nullable() })
export const ChronosApproved = z
  .strictObject({
    content_hash: Sha256Ref,
    prompt: z.string(),
    guard: z.string().nullable(),
    approved_at: IsoTs,
    via: z.enum(['api_apply', 'ui', 'adopt', 'migrate']),
  })
  .nullable()
export const ChronosConfigSetOk = z.strictObject({
  ok: z.literal(true),
  set: z.strictObject({
    session_runner: z.enum(['talos', 'hook']).optional(),
    approval_required: z.boolean().optional(),
    session_wait_notify_min: z.number().int().nonnegative().optional(),
  }),
})
export const ChronosPauseOk = z.strictObject({
  ok: z.literal(true),
  scope: z.union([z.literal('all'), ScheduleId]),
  paused: z.boolean(),
  paused_all: z.boolean(),
})
export const ChronosDueItem = z.strictObject({ id: ScheduleId, ds: RunKey, fire_at: IsoTs, window_ends: IsoTs })
/** Items are read one by one (parseChronosDue): one slot the adapter can't read must not hide the others. */
export const ChronosDue = z.strictObject({ due: z.array(z.unknown()), beat: IsoTs })
export const ChronosSessionBeat = z.strictObject({ ok: z.literal(true), beat: IsoTs })
export const ChronosMigrate = z.strictObject({
  approved: z.array(ScheduleId),
  held: z.array(ScheduleId),
  converted: z.array(ScheduleId),
  switched: z.boolean(),
  blocking: z.array(ScheduleId),
})

// ---- WP-C2 run verbs (checked against the feat/0.3-runs goldens) ------------------------------------------------

export const CHRONOS_CLAIM_REFUSALS = [
  'already_done',
  'running_elsewhere',
  'not_due',
  'window_passed',
  'held',
  'paused',
  'failed_today',
] as const
export const ChronosClaimResult = z.union([
  z.strictObject({ ok: z.literal(true), run_id: RunId, ds: RunKey }),
  z.strictObject({ ok: z.literal(false), reason: z.enum(CHRONOS_CLAIM_REFUSALS) }),
])
export const ChronosFinishResult = z.union([
  z.strictObject({ ok: z.literal(true) }),
  z.strictObject({ ok: z.literal(false), reason: z.enum(['not_owner', 'late']) }),
])
export const ChronosOrphan = z.strictObject({
  id: ScheduleId,
  ds: RunKey,
  run_id: RunId,
  bridge_instance: z.string().max(80).optional(),
})
export const ChronosOrphans = z.strictObject({ orphans: z.array(z.unknown()) })
/** `start` answers its refusals as `{ok:false, code, message}` (exit 0), not the error envelope. */
export const ChronosStartResult = z.union([
  z.strictObject({ ok: z.literal(true), run_id: RunId, ds: RunKey }),
  z.strictObject({
    ok: z.literal(false),
    code: z.enum(['already_running', 'headless_blocked', 'held', 'schedule_invalid']),
    message: z.string(),
  }),
])
export const ChronosSessionPrompt = z.strictObject({
  guard: z.string().nullable(),
  prompt: z.string(),
  content_hash: Sha256Ref,
})
export const ChronosProbe = z.strictObject({
  ok: z.boolean(),
  text: z.string(),
  // informational: Talos reads only ok and text, so a stalled entry in a shape it doesn't know costs nothing
  stalled_in_window: z.array(z.looseObject({ id: z.string().max(80), ds: z.string().max(40) })),
})
/** Raw health signals; the adapter turns them into a SchedulerHealth (texts, fixes, severity, state). */
export const ChronosHealth = z.strictObject({
  as_of: IsoTs,
  tz: IanaZone,
  session_runner: z.enum(['talos', 'hook']),
  paused_all: z.boolean(),
  tick_age_s: z.number().int().nonnegative().nullable(),
  session_beat_age_s: z.number().int().nonnegative().nullable(),
  headless: z.enum(['ok', 'blocked', 'unused', 'unknown']),
  blocked: z
    .strictObject({
      since: IsoTs,
      id: ScheduleId.nullable().catch(null),
      ds: RunKey.nullable().catch(null), // a block names the slot that stalled; one in a shape we don't know is just "not named"
      run_id: RunId.nullable().catch(null),
      source: z.string().nullable(), // Chronos emits null for a block file the watchdog did not write
    })
    .nullable(),
  tcc_suspected: z.boolean(),
  claude_path_changed: z.boolean(),
  registry_synced_folder: z.boolean(),
  issues: z.array(z.strictObject({ code: z.string(), schedule_id: ScheduleId.nullable().catch(null) })),
})

const or = <T extends z.ZodType>(ok: T) => z.union([ok, ChronosError])

/**
 * Output schema per verb, success or error. `any` is the bare error shape (an unknown verb, a crash the CLI caught).
 * The adapter picks the schema by the verb it ran.
 */
export const CHRONOS_API = {
  version: or(ChronosVersion),
  snapshot: or(ChronosSnapshot),
  detail: or(ChronosDetail),
  validate: or(ChronosValidateOk),
  apply: or(ChronosWriteOk),
  approved: or(ChronosApproved),
  config_set: or(ChronosConfigSetOk),
  disable: or(ChronosWriteOk),
  pause: or(ChronosPauseOk),
  due_session: or(ChronosDue),
  session_beat: or(ChronosSessionBeat),
  migrate: or(ChronosMigrate),
  claim: or(ChronosClaimResult),
  finish: or(ChronosFinishResult),
  orphans: or(ChronosOrphans),
  start: or(ChronosStartResult),
  session_prompt: or(ChronosSessionPrompt),
  probe: or(ChronosProbe),
  health: or(ChronosHealth),
  any: ChronosError,
} as const
export type ChronosVerb = keyof typeof CHRONOS_API

/** Reads a list one item at a time: the readable ones, and a line for each that wasn't (path and first reason). */
function readItems<T extends z.ZodType>(
  schema: T,
  items: unknown[],
  label: string,
): { items: Array<z.infer<T>>; bad: string[] } {
  const out: Array<z.infer<T>> = []
  const bad: string[] = []
  for (const [n, x] of items.entries()) {
    const r = schema.safeParse(x)
    if (r.success) out.push(r.data)
    else
      bad.push(
        `${label}[${n}].${r.error.issues[0]?.path.join('.') || '(item)'}: ${r.error.issues[0]?.message ?? 'invalid'}`,
      )
  }
  return { items: out, bad }
}

/** `chronos api due --for session`, item by item. `bad` is one line per slot that could not be read; the caller reports it. */
export function parseChronosDue(
  raw: unknown,
): { ok: true; due: ChronosDueItemT[]; beat: string; bad: string[] } | { ok: false; message: string } {
  const env = ChronosDue.safeParse(raw)
  if (!env.success)
    return { ok: false, message: `${env.error.issues[0]?.path.join('.') || '(root)'}: ${env.error.issues[0]?.message}` }
  const r = readItems(ChronosDueItem, env.data.due, 'due')
  return { ok: true, due: r.items, beat: env.data.beat, bad: r.bad }
}

/** `chronos api orphans`, item by item (same rule as parseChronosDue). */
export function parseChronosOrphans(
  raw: unknown,
): { ok: true; orphans: ChronosOrphanT[]; bad: string[] } | { ok: false; message: string } {
  const env = ChronosOrphans.safeParse(raw)
  if (!env.success)
    return { ok: false, message: `${env.error.issues[0]?.path.join('.') || '(root)'}: ${env.error.issues[0]?.message}` }
  const r = readItems(ChronosOrphan, env.data.orphans, 'orphans')
  return { ok: true, orphans: r.items, bad: r.bad }
}

const cut = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s)

/**
 * Chronos job -> Talos `Schedule`. Drops `ds`; adds the Talos-only `thread_id` (sidecar) and the adapter-derived
 * `wait_reason` (N6); makes scheduler text safe to display (controls and bidi marks out, F11); clamps to DISPLAY_LIMITS
 * and marks a job beyond the EDIT_LIMITS read-only ("Edit it at the Mac") instead of refusing it (F1). No schedule maths.
 */
export function scheduleFromChronos(
  job: ChronosJobT,
  extra: { thread_id: z.infer<typeof ThreadId> | null; offerAgeS: number | null; sessionBeatAgeS?: number | null },
): ScheduleT {
  const { ds: _ds, date_key: _dateKey, meta, ...j } = job
  const over: string[] = []
  if (j.name.length > EDIT_LIMITS.name) over.push('name')
  if (j.description.length > EDIT_LIMITS.description) over.push('description')
  if (j.model !== null && j.model.length > EDIT_LIMITS.model) over.push('model')
  if (j.allowed_tools.length > EDIT_LIMITS.allowed_tools) over.push('tool list')
  if (j.catchup_min < EDIT_LIMITS.catchup_min[0] || j.catchup_min > EDIT_LIMITS.catchup_min[1]) over.push('catch-up')
  const name = cut(safeLine(j.name), DISPLAY_LIMITS.name).trim() || j.id
  // The owner form holds one fire time: opening a times job in it would save `daily` with no time. Until the app has a
  // form for several (HB5), the agent proposes changes to one and the card shows them.
  const severalTimes = j.when.type === 'times'
  const editable = j.editable && over.length === 0 && !severalTimes
  const reason =
    j.read_only_reason ??
    (over.length
      ? `Its ${over.join(', ')} is beyond what the app can edit. Edit it at the Mac`
      : severalTimes
        ? 'Edit its fire times at the Mac, or ask the agent to change them'
        : null)
  return {
    ...j,
    name,
    description: cut(safeLine(j.description), DISPLAY_LIMITS.description),
    when_text: cut(safeLine(j.when_text), DISPLAY_LIMITS.when_text),
    allowed_tools: j.allowed_tools.slice(0, DISPLAY_LIMITS.allowed_tools).map((t) => cut(t, DISPLAY_LIMITS.tool)),
    model: j.model === null ? null : cut(j.model, DISPLAY_LIMITS.model),
    ...(meta === undefined ? {} : { meta }), // as hashed; the card shows it with visibleMetaText
    prompt_preview: [...j.prompt_preview].slice(0, 400).join(''),
    editable,
    read_only_reason: editable ? null : reason === null ? null : cut(reason, DISPLAY_LIMITS.read_only_reason),
    thread_id: extra.thread_id,
    wait_reason: deriveWaitReason(job.today, extra.sessionBeatAgeS ?? null, extra.offerAgeS),
  }
}

/**
 * Reads a `chronos api snapshot` answer row by row (F1). The envelope must parse (else the whole answer is unreadable);
 * each row that doesn't, and each `{id, error}` row Chronos emits for a broken record, becomes an `unreadable` entry
 * with a short reason and the first failing path.
 */
export type ChronosSnapshotRows =
  | {
      ok: true
      head: Omit<ChronosSnapshotT, 'schedules'>
      jobs: ChronosJobT[]
      unreadable: Array<{ id: string; unreadable: string }>
    }
  | { ok: false; message: string }

export function parseChronosSnapshot(raw: unknown): ChronosSnapshotRows {
  const env = ChronosSnapshotEnvelope.safeParse(raw)
  if (!env.success) {
    const i = env.error.issues[0]
    return { ok: false, message: `${i?.path.join('.') || '(root)'}: ${i?.message ?? 'invalid'}` }
  }
  const { schedules, ...head } = env.data
  const jobs: ChronosJobT[] = []
  const unreadable: Array<{ id: string; unreadable: string }> = []
  for (const [n, row] of schedules.entries()) {
    const idOf = () => {
      const id = (row as { id?: unknown } | null)?.id
      return typeof id === 'string' && id.length ? cut(safeLine(id), 200) : `#${n + 1}`
    }
    const broken = ChronosBrokenJob.safeParse(row)
    if (broken.success) {
      unreadable.push({ id: idOf(), unreadable: cut(safeLine(broken.data.error), 300) })
      continue
    }
    const r = ChronosJob.safeParse(row)
    if (r.success) jobs.push(r.data)
    else {
      const i = r.error.issues[0]
      unreadable.push({
        id: idOf(),
        unreadable: cut(`${i?.path.join('.') || '(row)'}: ${i?.message ?? 'invalid'}`, 300),
      })
    }
  }
  return { ok: true, head, jobs, unreadable }
}

/** Talos change -> Chronos change: strips `thread_id` from the draft or the `set` (S3.4 step 1). */
export function toChronosChange(change: ScheduleChangeT): {
  chronos: ChronosChangeT
  threadId: { set: true; value: string | null } | { set: false }
} {
  if (change.op === 'create') {
    const { thread_id, ...draft } = change.draft
    return { chronos: { op: 'create', draft }, threadId: { set: true, value: thread_id } }
  }
  if (change.op === 'update') {
    const { thread_id, ...set } = change.set
    return {
      chronos: { op: 'update', id: change.id, base_etag: change.base_etag, set },
      threadId: thread_id === undefined ? { set: false } : { set: true, value: thread_id },
    }
  }
  return { chronos: change, threadId: { set: false } }
}

/** Chronos's normalized change + the Talos-only thread choice -> the change a card binds (the inverse of toChronosChange). */
export function fromChronosChange(
  normalized: ChronosChangeT,
  threadId: { set: true; value: string | null } | { set: false },
): ScheduleChangeT {
  if (normalized.op === 'create')
    return { op: 'create', draft: { ...normalized.draft, thread_id: threadId.set ? threadId.value : null } }
  if (normalized.op === 'update')
    return { ...normalized, set: { ...normalized.set, ...(threadId.set ? { thread_id: threadId.value } : {}) } }
  return normalized
}

export type ChronosJobT = z.infer<typeof ChronosJob>
export type ChronosSnapshotT = z.infer<typeof ChronosSnapshot>
export type ChronosDetailT = z.infer<typeof ChronosDetail>
export type ChronosDraftT = z.infer<typeof ChronosDraft>
export type ChronosChangeT = z.infer<typeof ChronosChange>
export type ChronosErrorT = z.infer<typeof ChronosError>
export type ChronosDueItemT = z.infer<typeof ChronosDueItem>
export type ChronosOrphanT = z.infer<typeof ChronosOrphan>
export type ChronosHealthT = z.infer<typeof ChronosHealth>
