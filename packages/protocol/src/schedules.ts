// Schedules data model (docs/SCHEDULES.md S2.1). Everything a schedule frame, card or adapter carries.
// The scheduler (Chronos) computes every time, hash and plain-words text; Talos only validates and displays them.
// All instants are RFC 3339 with an offset (`IsoTs`). `LocalDateTime` is only `once.at`; a run's key is a `RunKey`.
import { z } from 'zod'
import { HHMM, isIanaZone } from './config.ts'
import { IsoTs, Sha256Ref, ThreadId, Ulid } from './ids.ts'

export const SCHEDULES_PROTOCOL = 1
/** Advertised in the bridge `hello.client.features`, echoed by the relay in `presence.features` (S1.5). */
export const SCHEDULES_FEATURE = 'schedules/1'
/**
 * Jobs with several fire times a day (`when.type: 'times'`), an opaque `meta`, and run keys that carry a slot
 * (docs/HEARTBEAT.md). `snapshot.protocol` stays 1 on purpose: bumping it would turn the whole tab into "Update
 * the app" for an app that could still read every other job. The bridge sends a job that needs this only when the relay's
 * `ready.features` lists it (`needsSchedulesV2`).
 */
export const SCHEDULES_FEATURE_V2 = 'schedules/2'
export const SCHEDULES_FEATURES = [SCHEDULES_FEATURE, SCHEDULES_FEATURE_V2] as const

const utf8Bytes = (s: string) => new TextEncoder().encode(s).length
/** C0 controls (and DEL) except \n and \t. */
// biome-ignore lint/suspicious/noControlCharactersInRegex: rejecting control characters is the point
const BAD_CONTROL = /[\u0000-\u0008\u000b-\u001f\u007f]/

// C0/C1 controls and the bidi overrides/isolates/marks: never allowed in a name or description the owner approves (F11)
// biome-ignore lint/suspicious/noControlCharactersInRegex: rejecting control characters is the point
const UNSAFE_TEXT = /[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/
// biome-ignore lint/suspicious/noControlCharactersInRegex: stripping control characters is the point
const UNSAFE_TEXT_G = /[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]+/g
/** Display form of scheduler-supplied text: controls and bidi marks become one space (the raw text stays in Chronos). */
export function safeLine(s: string): string {
  return s.replace(UNSAFE_TEXT_G, ' ')
}
const SafeText = (min: number, max: number) =>
  z
    .string()
    .min(min)
    .max(max)
    .refine((s) => !UNSAFE_TEXT.test(s), 'contains a control or bidi character')

export const PROMPT_MAX_BYTES = 16 * 1024 // cards and drafts (S2.4)
export const DETAIL_PROMPT_MAX_BYTES = 64 * 1024 // a detail, then truncated
export const GUARD_MAX_BYTES = 16 * 1024
export const REPORT_MAX_BYTES = 4 * 1024
export const MAX_SCHEDULES_PER_SNAPSHOT = 200

/** = Chronos ID_RE. */
export const ScheduleId = z.string().regex(/^[a-z0-9-]{2,40}$/)
/** Minted by the bridge (session runs) or Chronos (headless runs). Never part of a path. */
export const RunId = z.string().regex(/^r_[0-9A-HJKMNP-TV-Z]{26}$/)
/**
 * What Chronos calls `ds`: the key of one run. A date (`2026-10-05`) for a job with one fire time, a slot
 * (`2026-10-05T0945`) for a job with `times`, and an ad-hoc minute (`2026-10-05T1001`) for Run now on such a job. It is an
 * opaque key: never read the time part as one of the job's slot times, and never compare keys as if they were dates
 * (use `dateOfRunKey`). The same job can show either shape on different days.
 */
export const RUN_KEY_RE = /^\d{4}-\d{2}-\d{2}(T\d{4})?$/
export const RunKey = z.string().regex(RUN_KEY_RE)
/** The `YYYY-MM-DD` part of a run key. */
export const dateOfRunKey = (k: string): string => k.slice(0, 10)
export const LocalDateTime = z.string().regex(/^\d{4}-\d{2}-\d{2}T([01]\d|2[0-3]):[0-5]\d$/)
export const IanaZone = z.string().max(64).refine(isIanaZone, 'not an IANA time zone')
export const Weekday = z.enum(['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'])

/** Days a `times` job runs on, as the scheduler prints them: words, or (Chronos 229ac69) integers for a named list. */
const TimesDaysRead = z.union([
  z.literal('daily'),
  z.literal('weekdays'),
  z
    .array(z.union([z.string().max(16), z.number().int().min(0).max(31)]))
    .min(1)
    .max(31),
])
const TimesDaysEditable = z.union([z.literal('daily'), z.literal('weekdays'), z.array(Weekday).min(1).max(7)])
/** Chronos's own floor is 15 minutes (tick safety). Heartbeat's is 60 (docs/HEARTBEAT.md), enforced for what the owner writes. */
export const TIMES_MIN_GAP_MIN = 60
export const TIMES_MAX_EDITABLE = 12
const minutesOf = (t: string) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5))
/**
 * The one rule for a list of fire times the owner or the agent writes: earliest first, no two closer than
 * TIMES_MIN_GAP_MIN, the wrap past midnight included (23:30 and 00:15 are 45 apart). Null when fine, else words.
 */
export function timesGapProblem(times: readonly string[]): string | null {
  for (let i = 1; i < times.length; i++) {
    const a = times[i - 1] as string
    const b = times[i] as string
    if (minutesOf(b) <= minutesOf(a)) return `times must be in order, earliest first (${a} then ${b})`
  }
  const gaps: Array<[string, string, number]> = []
  for (let i = 1; i < times.length; i++)
    gaps.push([
      times[i - 1] as string,
      times[i] as string,
      minutesOf(times[i] as string) - minutesOf(times[i - 1] as string),
    ])
  if (times.length > 1) {
    const first = times[0] as string
    const last = times[times.length - 1] as string
    gaps.push([last, first, minutesOf(first) + 1440 - minutesOf(last)])
  }
  const worst = gaps.reduce<[string, string, number] | null>((m, g) => (m === null || g[2] < m[2] ? g : m), null)
  if (worst && worst[2] < TIMES_MIN_GAP_MIN)
    return `${worst[0]} and ${worst[1]} are ${worst[2]} minutes apart; keep fire times at least ${TIMES_MIN_GAP_MIN} minutes apart`
  return null
}
const TimesEditable = z
  .array(HHMM)
  .min(1)
  .max(TIMES_MAX_EDITABLE)
  .superRefine((t, ctx) => {
    const why = timesGapProblem(t)
    if (why) ctx.addIssue({ code: 'custom', message: why })
  })

const When = {
  daily: z.strictObject({ type: z.literal('daily'), time: HHMM }),
  weekdays: z.strictObject({ type: z.literal('weekdays'), time: HHMM }),
  days: z.strictObject({ type: z.literal('days'), days: z.array(Weekday).min(1).max(7), time: HHMM }),
  monthdays: z.strictObject({
    type: z.literal('monthdays'),
    days: z.array(z.number().int().min(1).max(31)).min(1).max(31),
    time: HHMM,
  }),
  once: z.strictObject({ type: z.literal('once'), at: LocalDateTime }),
  events: z.strictObject({ type: z.literal('events') }),
}
/** What a job on the Mac may hold. Only `ScheduleWhenEditable` carries the 60-minute floor: a job already there is shown as it is. */
const TimesRead = z.strictObject({ type: z.literal('times'), days: TimesDaysRead, times: z.array(HHMM).min(1).max(24) })
const TimesWrite = z.strictObject({ type: z.literal('times'), days: TimesDaysEditable, times: TimesEditable })
export const ScheduleWhen = z.discriminatedUnion('type', [
  When.daily,
  When.weekdays,
  When.days,
  When.monthdays,
  TimesRead,
  When.once,
  When.events,
])
/** Defined explicitly: a zod discriminated union has no `.exclude()`. */
export const ScheduleWhenEditable = z.discriminatedUnion('type', [
  When.daily,
  When.weekdays,
  When.days,
  When.monthdays,
  TimesWrite,
  When.once,
])

/** Where a job runs. 'both' is the Chronos 0.2 meaning of in_session:true and is read-only (S2.1 runner table). */
export const ScheduleRunner = z.enum(['session', 'headless', 'both'])
export const ScheduleRunnerEditable = z.enum(['session', 'headless'])
export const SchedulePermissions = z.enum(['full', 'restricted', 'command']) // command = read-only in v1
export const RunStatus = z.enum(['running', 'ok', 'failed', 'timed_out', 'launch_stalled', 'session_ended', 'skipped'])
export const DayState = z.enum([
  'not_due',
  'pending',
  'waiting',
  'running',
  'ran',
  'failed',
  'stalled',
  'missed',
  'held',
])
/**
 * Only when `today` is 'waiting'. Derived by the ADAPTER (N6), never by Chronos: `no_session` if Chronos's
 * `session_beat_age_s` > 180 (or unknown), `offered` if the sidecar's offer for (id, ds) is < 2 min old, else
 * `agent_busy`. See `deriveWaitReason`.
 */
export const WaitReason = z.enum(['offered', 'no_session', 'agent_busy'])
export const ScheduleNotify = z.enum(['failure', 'always', 'never'])

const PromptText = (max: number) =>
  z
    .string()
    .min(1)
    .refine((s) => utf8Bytes(s) <= max, `longer than ${max} bytes (UTF-8)`)
    .refine((s) => !BAD_CONTROL.test(s), 'contains a control character other than newline or tab')

/**
 * What the owner can EDIT from the app (S2.4, the ScheduleDraft limits). A job beyond any of them is shown read-only
 * ("Edit it at the Mac"), never refused: the scheduler holds what it holds (0.2 upgrades, hand edits).
 */
export const EDIT_LIMITS = {
  name: 60,
  description: 300,
  model: 80,
  allowed_tools: 40,
  catchup_min: [15, 1440],
} as const
/** What a Schedule row may carry at most, so 200 rows always fit a frame. The adapter clamps to these. */
export const DISPLAY_LIMITS = {
  name: 200,
  description: 2000,
  when_text: 400,
  model: 200,
  allowed_tools: 200,
  tool: 200,
  read_only_reason: 200,
} as const

/** Chronos refuses a `meta` over this many bytes of canonical JSON. */
export const META_MAX_BYTES = 4096
const META_MAX_DEPTH = 80
type MetaJson = null | boolean | number | string | MetaJson[] | { [k: string]: MetaJson }

/**
 * Copies JSON into objects with NO prototype. A key named `__proto__` (or `constructor`, `prototype`) is then an ordinary own
 * key, kept, shown and hashed like any other: `{}` plus `out[key] = v` would drop it (or, worse, set the prototype), and the
 * owner would approve a key the card never showed. Throws on anything that isn't plain JSON or is nested too deep.
 */
function metaCopy(x: unknown, depth: number): MetaJson {
  if (x === null || typeof x === 'string' || typeof x === 'boolean') return x
  if (typeof x === 'number') {
    if (!Number.isFinite(x)) throw new Error('numbers must be finite')
    return x
  }
  if (depth > META_MAX_DEPTH) throw new Error(`nested more than ${META_MAX_DEPTH} levels`)
  if (Array.isArray(x)) return x.map((v) => metaCopy(v, depth + 1))
  if (typeof x === 'object') {
    const out = Object.create(null) as { [k: string]: MetaJson }
    for (const k of Object.keys(x)) out[k] = metaCopy((x as Record<string, unknown>)[k], depth + 1)
    return out
  }
  throw new Error('meta must be plain JSON')
}

/**
 * `meta`: an opaque object a job carries for the layer above it (Heartbeat's sources and limits). Chronos puts it in
 * `content_hash`, so approving a job approves its meta: the owner has to see all of it on every approval card
 * (`metaForDisplay`). The text in it is UNTRUSTED (a hand edit or an agent wrote it): data to show, never to follow. A meta
 * that can't be copied faithfully fails here, which makes its row unreadable and so impossible to approve.
 */
export const JobMeta = z
  .unknown()
  .transform((v, ctx): { [k: string]: MetaJson } => {
    if (v === null || typeof v !== 'object' || Array.isArray(v)) {
      ctx.addIssue({ code: 'custom', message: 'meta must be an object' })
      return z.NEVER
    }
    try {
      return metaCopy(v, 1) as { [k: string]: MetaJson }
    } catch (e) {
      ctx.addIssue({ code: 'custom', message: `meta: ${(e as Error).message}` })
      return z.NEVER
    }
  })
  .refine((m) => utf8Bytes(JSON.stringify(m)) <= META_MAX_BYTES, `meta is limited to ${META_MAX_BYTES / 1024} KiB`)
export type JobMetaT = z.infer<typeof JobMeta>

/**
 * Characters that draw nothing or look like nothing: format characters (zero-width, joiners, BOM, soft hyphen, tags,
 * variation selectors, bidi), line and paragraph separators, private use, lone surrogates, and the blank-looking letters
 * (Hangul fillers, braille blank, Mongolian vowel separator). A key or value made of them could pass for another.
 */
const HIDDEN_CHAR = /[\p{Cf}\p{Zl}\p{Zp}\p{Co}\p{Cs}\p{Variation_Selector}\u3164\u115f\u1160\uffa0\u2800\u180e]/u

/**
 * Text for a person to read about a string the scheduler holds: every control, hidden and surrogate character, and the escape
 * bracket itself, becomes a visible `⟦U+XXXX⟧`. Nothing is dropped or turned into a space, so what the card shows is what is
 * hashed, and two different strings never show alike.
 */
export function visibleMetaText(s: string): string {
  let out = ''
  for (const ch of s) {
    const c = ch.codePointAt(0) as number
    if (ch === '⟦' || (c >= 0xd800 && c <= 0xdfff) || UNSAFE_TEXT.test(ch) || HIDDEN_CHAR.test(ch))
      out += `⟦U+${c.toString(16).toUpperCase().padStart(4, '0')}⟧`
    else out += ch
  }
  return out
}

/** A copy of `meta` with every key and string through `visibleMetaText` (still null-prototype objects), ready for JSON.stringify. */
export function metaForDisplay(m: JobMetaT): JobMetaT {
  const walk = (x: unknown): MetaJson => {
    if (typeof x === 'string') return visibleMetaText(x)
    if (Array.isArray(x)) return x.map(walk)
    if (x !== null && typeof x === 'object') {
      const out = Object.create(null) as { [k: string]: MetaJson }
      for (const k of Object.keys(x)) out[visibleMetaText(k)] = walk((x as Record<string, unknown>)[k])
      return out
    }
    return x as MetaJson
  }
  return walk(m) as JobMetaT
}

export const ScheduleRun = z.strictObject({
  run_id: RunId,
  ds: RunKey,
  started_at: IsoTs,
  runner: z.enum(['session', 'headless']),
  trigger: z.enum(['clock', 'run_now', 'event']),
  status: RunStatus,
  duration_s: z.number().int().nonnegative().optional(),
  ended_at: IsoTs.optional(), // Chronos 0.3.1 sends it on a finished run
  cost_usd: z.number().nonnegative().optional(), // headless only (session cost is not metered per job)
  summary: z.string().max(280).optional(), // plain text
  late_note: z.string().max(280).optional(), // a schedule_run_done that arrived after the run was closed (S3.3)
  has_report: z.boolean(),
})
/**
 * A run as `last_run`/`runs` carry it: `run_id`, `started_at`, `runner` and `trigger` are absent when Chronos knows the
 * day only from a 0.2-era `ran-`/`failed-` marker (no runs.jsonl row), or a headless start that died before its row
 * was written: `{ds, status, has_report}`. Real output on every upgraded install with history (review F1).
 */
export const ScheduleLastRun = ScheduleRun.partial({ run_id: true, started_at: true, runner: true, trigger: true })

export const Schedule = z.strictObject({
  id: ScheduleId,
  name: z.string().min(1).max(DISPLAY_LIMITS.name),
  description: z.string().max(DISPLAY_LIMITS.description),
  kind: z.enum(['claude', 'command']),
  when: ScheduleWhen,
  when_text: z.string().max(DISPLAY_LIMITS.when_text), // the scheduler's own words, e.g. "Weekdays at 7:30 AM"
  catchup_min: z.number().int().nonnegative(), // the API writes 15-1440; hand-written records may hold anything
  enabled: z.boolean(), // registry field (turning on needs a card)
  paused: z.boolean(), // pause switch (no card, S8.3)
  runner: ScheduleRunner,
  permissions: SchedulePermissions,
  allowed_tools: z.array(z.string().max(DISPLAY_LIMITS.tool)).max(DISPLAY_LIMITS.allowed_tools),
  model: z.string().max(DISPLAY_LIMITS.model).nullable(),
  notify: ScheduleNotify,
  thread_id: ThreadId.nullable(), // Talos sidecar (S3.5); null = default_thread
  memory: z.boolean().optional(), // job memory (S3.8): present only when on; absent = off
  triggers_count: z.number().int().nonnegative(),
  next_run: IsoTs.nullable(),
  today: DayState,
  wait_reason: WaitReason.nullable(),
  window_ends: IsoTs.nullable(), // fire + catchup_min for the current ds, when waiting/running
  last_run: ScheduleLastRun.nullable(),
  meta: JobMeta.optional(), // schedules/2: opaque, untrusted text (metaForDisplay); part of content_hash
  prompt_preview: z.string().max(400), // first 400 chars, control chars stripped; '' for command jobs
  prompt_bytes: z.number().int().nonnegative(),
  editable: z.boolean(),
  read_only_reason: z.string().max(DISPLAY_LIMITS.read_only_reason).nullable(),
  changed_outside: z.boolean(), // content_hash != Chronos's approved record, or no record (N1)
  etag: Sha256Ref, // config concurrency
  content_hash: Sha256Ref, // what the agent will be told to do and how it may act
  state_rev: Sha256Ref, // run state; moves on every claim, finish, pause, stall, hold
})

export const HealthCode = z.enum([
  'paused_all',
  'tick_missing',
  'launch_stalled',
  'tcc_suspected',
  'headless_blocked',
  'run_hung',
  'registry_unreadable',
  'adapter_timeout',
  'version_unsupported',
  'not_installed',
  'missed_recently',
  'session_runner_conflict',
  'registry_synced_folder',
  'legacy_both_runner',
  'held_jobs',
  'truncated',
])
export const HealthIssue = z.strictObject({
  code: HealthCode,
  severity: z.enum(['info', 'warn', 'error']),
  text: z.string().max(200),
  fix: z.string().max(600).nullable(),
  schedule_id: ScheduleId.nullable(),
  since: IsoTs,
})
export const SchedulerHealth = z.strictObject({
  state: z.enum(['ok', 'degraded', 'stuck', 'paused', 'not_installed', 'unsupported', 'off', 'error']),
  adapter: z.strictObject({
    id: z.string().max(20),
    version: z.string().max(20).nullable(),
    api: z.number().int().nullable(),
  }),
  tz: IanaZone, // the SCHEDULER's zone; the app labels times when it differs from config.timezone
  host_label: z.string().max(64), // the Mac's ComputerName, sanitized
  session_runner: z.enum(['talos', 'hook', 'unknown']),
  paused_all: z.boolean(),
  headless: z.enum(['ok', 'blocked', 'unused', 'unknown']), // unused = no headless jobs
  tick_age_s: z.number().int().nonnegative().nullable(),
  issues: z.array(HealthIssue).max(10),
  checked_at: IsoTs,
})
/**
 * A row the adapter could not read (Chronos emits `{id, error}` on purpose: "one broken record must not hide the
 * others"; the adapter adds rows that fail the schema). Shown read-only with the reason; the rest of the list is
 * unaffected (review F1).
 */
export const ScheduleUnreadable = z.strictObject({
  id: z.string().min(1).max(200),
  unreadable: z.string().max(300),
})
export const ScheduleSnapshot = z.strictObject({
  protocol: z.number().int(), // the app checks === SCHEDULES_PROTOCOL BEFORE parsing the rest
  health: SchedulerHealth,
  schedules: z.array(Schedule).max(MAX_SCHEDULES_PER_SNAPSHOT),
  /** Rows that couldn't be read; each also raises a `registry_unreadable` issue naming it. */
  unreadable: z.array(ScheduleUnreadable).max(MAX_SCHEDULES_PER_SNAPSHOT),
  as_of: IsoTs,
})
export const ScheduleDetail = z.strictObject({
  schedule: Schedule,
  prompt: z.string().refine((s) => utf8Bytes(s) <= DETAIL_PROMPT_MAX_BYTES, 'longer than 64 KiB'), // then truncated
  prompt_truncated: z.boolean(),
  guard: z
    .string()
    .refine((s) => utf8Bytes(s) <= GUARD_MAX_BYTES, 'longer than 16 KiB')
    .nullable(), // read-only standing rules
  next_runs: z.array(IsoTs).max(3),
  runs: z.array(ScheduleLastRun).max(10),
})

/** Owner-editable fields only. kind is always 'claude'. Strict, no defaults (SPEC 3.5). */
export const ScheduleDraft = z.strictObject({
  id: ScheduleId,
  name: SafeText(1, EDIT_LIMITS.name),
  description: SafeText(0, EDIT_LIMITS.description),
  when: ScheduleWhenEditable,
  catchup_min: z.number().int().min(15).max(1440),
  enabled: z.boolean(),
  runner: ScheduleRunnerEditable,
  permissions: z.enum(['full', 'restricted']),
  allowed_tools: z.array(z.string().max(200)).max(40),
  model: z.string().max(80).nullable(),
  notify: ScheduleNotify,
  thread_id: ThreadId.nullable(), // Talos-only, stripped before the scheduler (S3.4)
  memory: z.boolean().optional(), // Talos-only like thread_id (S3.8): job memory; absent = off
  prompt: PromptText(PROMPT_MAX_BYTES), // <= 16 KiB UTF-8, no C0 controls except \n \t
  meta: JobMeta.optional(), // schedules/2
})
export const ScheduleChange = z.discriminatedUnion('op', [
  z.strictObject({ op: z.literal('create'), draft: ScheduleDraft }),
  // `set` holds ONLY the fields the owner changed; the app never resends unchanged values from a (relay-carried) detail
  z.strictObject({
    op: z.literal('update'),
    id: ScheduleId,
    base_etag: Sha256Ref,
    // `meta: null` clears it
    set: ScheduleDraft.omit({ id: true }).partial().extend({ meta: JobMeta.nullable().optional() }),
  }),
  z.strictObject({ op: z.literal('delete'), id: ScheduleId, base_etag: Sha256Ref }),
  // accept changes made outside the app (S8.2)
  z.strictObject({ op: z.literal('adopt'), id: ScheduleId, content_hash: Sha256Ref }),
])
export const SchedulePreview = z.strictObject({
  when_text: z.string().max(120),
  next_runs: z.array(IsoTs).max(3),
  tz: IanaZone,
})
export const SCHEDULE_CARD_SCHEMA = 'talos.schedule-change/1'
export const ScheduleCardPayload = z.strictObject({
  schema: z.literal(SCHEDULE_CARD_SCHEMA),
  change: ScheduleChange, // the adapter-normalized change (validate), never the raw proposal
  expected_etag: Sha256Ref.nullable(), // the etag the write must produce (null for delete); the bridge asserts it
  proposed_by: z.enum(['agent', 'owner_form']),
  client_ref: Ulid.nullable(), // echoes schedule.patch.id so the app opens the card it asked for
  preview: SchedulePreview,
})

/** One entry of `schedule.status.changed`: ids and hashes only, never a name or prompt (S2.2). */
export const ScheduleStatusChange = z.strictObject({ id: ScheduleId, etag: Sha256Ref, state_rev: Sha256Ref })
export const ScheduleStatusAlert = z.strictObject({
  kind: z.enum(['job_failed', 'scheduler_stuck']),
  key: z.string().max(80),
})
export const ScheduleReport = z.strictObject({
  run_id: RunId,
  text: z.string().refine((s) => utf8Bytes(s) <= REPORT_MAX_BYTES, 'longer than 4 KiB'),
})
export const ScheduleControlAction = z.enum(['pause', 'resume', 'pause_all', 'resume_all', 'disable', 'retry_headless'])
/** Actions that name one job; the rest must send `schedule_id: null`. */
export const SCHEDULE_CONTROL_NEEDS_ID = ['pause', 'resume', 'disable'] as const

/**
 * N6: the adapter's rule for `wait_reason`. `sessionBeatAgeS` is Chronos's `session_beat_age_s` (null = never),
 * `offerAgeS` the age of the sidecar's offer for (id, ds) (null = none).
 */
export function deriveWaitReason(
  today: z.infer<typeof DayState>,
  sessionBeatAgeS: number | null,
  offerAgeS: number | null,
): z.infer<typeof WaitReason> | null {
  if (today !== 'waiting') return null
  if (sessionBeatAgeS === null || sessionBeatAgeS > 180) return 'no_session'
  if (offerAgeS !== null && offerAgeS < 120) return 'offered'
  return 'agent_busy'
}

/**
 * The first reason a change breaks the fire-time floor, for code that holds a change but not a parsed ScheduleChange
 * (the adapter, which sees what Chronos normalized). Null when it is fine or has no fire times.
 */
export function changeTimesProblem(c: unknown): string | null {
  const x = c as {
    op?: string
    draft?: { when?: { type?: string; times?: unknown } }
    set?: { when?: { type?: string; times?: unknown } }
  }
  const when = x?.op === 'create' ? x.draft?.when : x?.op === 'update' ? x.set?.when : undefined
  if (when?.type !== 'times') return null
  const t = when.times
  if (!Array.isArray(t) || !t.every((e) => typeof e === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(e)))
    return 'times must be a list of HH:MM'
  return timesGapProblem(t as string[])
}

/** Whether a job (as the app would receive it) or a change needs `schedules/2` to travel: times, meta, or job memory. */
export function needsSchedulesV2(x: { when: { type: string }; meta?: unknown; memory?: boolean | undefined }): boolean {
  return x.when.type === 'times' || x.meta !== undefined || x.memory !== undefined
}
export function changeNeedsSchedulesV2(c: ScheduleChangeT): boolean {
  if (c.op === 'create') return needsSchedulesV2(c.draft)
  if (c.op === 'update') return c.set.when?.type === 'times' || c.set.meta !== undefined || c.set.memory !== undefined
  return false
}

export type ScheduleWhenT = z.infer<typeof ScheduleWhen>
export type ScheduleRunT = z.infer<typeof ScheduleRun>
export type ScheduleLastRunT = z.infer<typeof ScheduleLastRun>
export type ScheduleUnreadableT = z.infer<typeof ScheduleUnreadable>
export type ScheduleT = z.infer<typeof Schedule>
export type HealthIssueT = z.infer<typeof HealthIssue>
export type SchedulerHealthT = z.infer<typeof SchedulerHealth>
export type ScheduleSnapshotT = z.infer<typeof ScheduleSnapshot>
export type ScheduleDetailT = z.infer<typeof ScheduleDetail>
export type ScheduleDraftT = z.infer<typeof ScheduleDraft>
export type ScheduleChangeT = z.infer<typeof ScheduleChange>
export type SchedulePreviewT = z.infer<typeof SchedulePreview>
export type ScheduleCardPayloadT = z.infer<typeof ScheduleCardPayload>
export type DayStateT = z.infer<typeof DayState>
export type WaitReasonT = z.infer<typeof WaitReason>
export type RunStatusT = z.infer<typeof RunStatus>
export type ScheduleControlActionT = z.infer<typeof ScheduleControlAction>

/** The strict snapshot with the rows left unread, so one row the app can't read costs one row (review F10, HB1). */
const ScheduleSnapshotEnvelope = z.strictObject({
  protocol: z.number().int(),
  health: SchedulerHealth,
  schedules: z.array(z.unknown()).max(MAX_SCHEDULES_PER_SNAPSHOT),
  unreadable: z.array(ScheduleUnreadable).max(MAX_SCHEDULES_PER_SNAPSHOT),
  as_of: IsoTs,
})

/**
 * The app's read of `schedules.snapshot.snapshot` (S1.5): `protocol` FIRST, then the strict schema. A newer bridge's
 * snapshot is "update the app", never a bad frame (review F10). Rows are read one by one: a job with a shape this app
 * doesn't know yet (a newer `when`, say) becomes an `unreadable` entry that says to update, and every other job shows.
 */
export function parseScheduleSnapshot(
  raw: unknown,
): { ok: true; snapshot: ScheduleSnapshotT } | { ok: false; reason: 'update_app' | 'invalid'; message: string } {
  const protocol = (raw as { protocol?: unknown } | null)?.protocol
  if (protocol !== SCHEDULES_PROTOCOL)
    return {
      ok: false,
      reason: 'update_app',
      message: `snapshot protocol ${String(protocol)} is not ${SCHEDULES_PROTOCOL}`,
    }
  const env = ScheduleSnapshotEnvelope.safeParse(raw)
  if (!env.success) return { ok: false, reason: 'invalid', message: env.error.issues[0]?.path.join('.') || '(root)' }
  const schedules: ScheduleT[] = []
  const unreadable = [...env.data.unreadable]
  for (const [n, row] of env.data.schedules.entries()) {
    const r = Schedule.safeParse(row)
    if (r.success) {
      schedules.push(r.data)
      continue
    }
    const id = (row as { id?: unknown } | null)?.id
    unreadable.push({
      id: typeof id === 'string' && id.length ? safeLine(id).slice(0, 200) : `#${n + 1}`,
      unreadable:
        `This app can't read this job yet. Update Talos. (${r.error.issues[0]?.path.join('.') || 'row'})`.slice(0, 300),
    })
  }
  return {
    ok: true,
    snapshot: {
      ...env.data,
      schedules,
      unreadable: unreadable.slice(0, MAX_SCHEDULES_PER_SNAPSHOT),
    },
  }
}
