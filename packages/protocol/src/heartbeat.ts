// The Heartbeat contract (docs/SCHEDULES.md S1.7): the shapes a heartbeat job uses. The runner that produces and consumes
// them is HB2; nothing here runs anything.
//
// Strict where Talos writes (a config, an item, a result): an unknown key or level is refused. Tolerant where Talos reads
// (`HeartbeatItemRead`, `parseHeartbeatItems`, `heartbeatConfigFromMeta`, `parseHeartbeatSourceResponse`): unknown keys
// are ignored at every depth, one unreadable row costs that row and is counted, a source kind from a newer Talos is
// skipped, never an empty list.
//
// Text that came from outside (an item's title and detail, a source's error) is untrusted: it is capped, and every control,
// hidden and bidi character becomes a visible `⟦U+XXXX⟧` (visibleMetaText), so what a person reads is what is stored.
// Escape ONCE, where the text enters (the write schemas). The read schemas only check that the text is already escaped, so
// reading a row and writing it back never changes it.
import { z } from 'zod'
import { payloadHash } from './canonical.ts'
import { IsoTs } from './ids.ts'
import { JobMeta, type JobMetaT, META_MAX_BYTES, RunKey, visibleMetaText } from './schedules.ts'

const utf8Bytes = (s: string) => new TextEncoder().encode(s).length

/** The key in a job's `meta` that holds a HeartbeatConfig. Other keys beside it are allowed and are not Heartbeat's. */
export const HEARTBEAT_META_KEY = 'talos.heartbeat'
export const HEARTBEAT_CONFIG_SCHEMA = 'talos.heartbeat/1'
export const HEARTBEAT_SOURCE_SCHEMA = 'talos.heartbeat-source/1'
export const HEARTBEAT_TITLE_MAX_CHARS = 120
/** Raw code points kept from a detail; the escaped text can be up to 10 times longer. */
export const HEARTBEAT_DETAIL_MAX_CHARS = 500
export const HEARTBEAT_WHY_MAX_CHARS = 60
export const HEARTBEAT_ERROR_MAX_CHARS = 200
export const HEARTBEAT_MAX_SOURCES = 12
export const HEARTBEAT_MAX_MUTES = 20
export const HEARTBEAT_WAKES_MIN = 1
export const HEARTBEAT_WAKES_MAX = 6
export const HEARTBEAT_WAKES_DEFAULT = 3
export const HEARTBEAT_SOURCE_TIMEOUT_MIN_S = 5
export const HEARTBEAT_SOURCE_TIMEOUT_MAX_S = 60
export const HEARTBEAT_RUN_TIMEOUT_MIN_S = 30
export const HEARTBEAT_RUN_TIMEOUT_MAX_S = 150
export const HEARTBEAT_RUN_TIMEOUT_DEFAULT_S = 120
/** A source's whole stdout, cursor included. Over it is a source error, never a cut-off list. */
export const HEARTBEAT_SOURCE_MAX_BYTES = 256 * 1024
export const HEARTBEAT_SOURCE_MAX_ITEMS = 50
/** A low-risk mute may end at most this long after the card is made. */
export const HEARTBEAT_MUTE_LOW_RISK_DAYS = 30

/** At most `max` code points of `s`, then escaped; a cut text ends with "…". */
function capEscape(s: string, max: number): string {
  const cps = [...s]
  return cps.length <= max ? visibleMetaText(s) : `${visibleMetaText(cps.slice(0, max).join(''))}…`
}
/** Write side: untrusted text in, capped and escaped (once). */
const Untrusted = (max: number) => z.string().transform((s) => capEscape(s, max))

const ESCAPE_TOKEN = /⟦U\+([0-9A-F]{4,6})⟧/g
/** True when `s` holds no raw hidden character and no escape token that visibleMetaText would not itself have made. */
function isEscaped(s: string): boolean {
  const rest = s.replace(ESCAPE_TOKEN, (token, hex: string) => {
    const cp = Number.parseInt(hex, 16)
    return cp <= 0x10ffff && visibleMetaText(String.fromCodePoint(cp)) === token ? '' : token
  })
  return visibleMetaText(rest) === rest
}
/** Read side: text Talos already stored. It is checked, never changed. `max` is in raw code points (an escape is up to 10). */
const Stored = (max: number) =>
  z
    .string()
    .refine((s) => [...s].length <= max * 10 + 1, 'text is too long')
    .refine(isEscaped, 'text has a hidden or control character that is not escaped')

/** A key or id Talos compares: shown and matched as written, so a hidden or control character is refused, not rewritten. */
const PlainKey = (max: number) =>
  z
    .string()
    .min(1)
    .max(max)
    .refine((s) => visibleMetaText(s) === s, 'contains a control or hidden character')

export const HeartbeatLevel = z.enum(['silent', 'fyi', 'act'])
export const HeartbeatItemClass = z.enum(['work', 'own'])
export const HeartbeatMode = z.enum(['shadow', 'live'])
export const HeartbeatSourceKind = z.enum(['github', 'schedule-failures', 'inbox', 'command'])
export const HeartbeatSourceId = z
  .string()
  .regex(/^[a-z0-9-]{2,24}$/, 'a source id is 2 to 24 lowercase letters, digits or hyphens')
export const HeartbeatOutcome = z.enum(['silent', 'fyi', 'woke', 'capped', 'quiet', 'partial', 'failed'])

/** https only, no login in the link, and nothing a person could not see: what is shown is what is opened. */
const ItemUrl = z
  .string()
  .max(500)
  .refine((u) => visibleMetaText(u) === u, 'the link has a hidden or control character')
  .refine((u) => /^https:\/\/[^\s]+$/.test(u), 'not an https link')
  .refine((u) => {
    try {
      const p = new URL(u)
      return p.protocol === 'https:' && p.username === '' && p.password === '' && p.hostname !== ''
    } catch {
      return false
    }
  }, 'not an https link')

/** The fields a source reports; the runner adds first_seen, last_seen and count when it stores an item. */
function sourceItemShape(write: boolean) {
  return {
    key: PlainKey(200),
    /** A content signature: the same key with a new sig is the same thing, changed. Key plus sig is the identity. */
    sig: PlainKey(80),
    title: write ? Untrusted(HEARTBEAT_TITLE_MAX_CHARS) : Stored(HEARTBEAT_TITLE_MAX_CHARS),
    level: HeartbeatLevel,
    class: HeartbeatItemClass,
    /** A short plain reason, e.g. the rule that fired. */
    why: write ? Untrusted(HEARTBEAT_WHY_MAX_CHARS) : Stored(HEARTBEAT_WHY_MAX_CHARS),
    url: ItemUrl.optional(),
    deadline: write ? IsoTs.nullable() : IsoTs.nullish().transform((d) => d ?? null),
    detail: (write ? Untrusted(HEARTBEAT_DETAIL_MAX_CHARS) : Stored(HEARTBEAT_DETAIL_MAX_CHARS)).optional(),
  }
}
function itemShape() {
  return {
    source: HeartbeatSourceId,
    ...sourceItemShape(false),
    first_seen: IsoTs,
    last_seen: IsoTs,
    count: z.number().int().min(1).max(1_000_000),
  }
}
/**
 * The row Talos STORES, and the schema HB2 stores through. Check-only: it never changes text. The one place untrusted text is
 * escaped is the source parse (`parseHeartbeatSourceResponse`); a row with a raw hidden or control character in `title`,
 * `detail` or `why`, or an escape token the escaper would not make, is refused here, not "fixed". Parse the source output,
 * add `source`, `first_seen`, `last_seen` and `count`, then `HeartbeatItem.parse`: the text is identical on every run.
 */
export const HeartbeatItem = z.strictObject(itemShape())
/** The same row as read back: keys it doesn't know are ignored; the text is checked, not changed. */
export const HeartbeatItemRead = z.object(itemShape())
/** What a source process prints for one item, with its text escaped here (strict: Talos's own check, e.g. in a test run). */
export const HeartbeatSourceItem = z.strictObject(sourceItemShape(true))
const HeartbeatSourceItemIn = z.object(sourceItemShape(true))

// ---- config

const Repo = z
  .string()
  .regex(/^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/, 'a repo is written owner/name')
  .refine((r) => r.split('/').every((p) => p !== '.' && p !== '..'), 'a repo owner or name cannot be "." or ".."')
const NoNul = (s: string) => !s.includes('\u0000')
const AbsPath = z
  .string()
  .max(500)
  .refine((s) => s.startsWith('/'), 'must be an absolute path')
  .refine(NoNul, 'must not contain a NUL character')
const ArgvItem = z.string().max(500).refine(NoNul, 'must not contain a NUL character')
const RISKY_ENV = /^(LD_|DYLD_|PYTHON|PERL5)|^(NODE_OPTIONS|NODE_PATH|RUBYOPT|BASH_ENV|ENV|PATH|HOME|SHELL|IFS)$/
const ENV_NAME = /^[A-Z_][A-Z0-9_]*$/
const RISKY_ENV_WORDS =
  'changes how a program loads code or finds things (LD_*, DYLD_*, NODE_OPTIONS, NODE_PATH, PYTHON*, PERL5*, RUBYOPT, BASH_ENV, ENV, PATH, HOME, SHELL, IFS)'
const SECRET_PREFIX = /^(ghp_|gho_|github_pat_|xox[bp]-|sk-|AKIA)/
/** Bits per character of `s` (Shannon). */
function entropy(s: string): number {
  const n = new Map<string, number>()
  for (const ch of s) n.set(ch, (n.get(ch) ?? 0) + 1)
  let h = 0
  for (const c of n.values()) h -= (c / s.length) * Math.log2(c / s.length)
  return h
}
/** An env value is shown on the approval card and stored in jobs.json, so it may not look like a credential. */
const looksSecret = (v: string) =>
  SECRET_PREFIX.test(v) ||
  (v.length > 32 && /^[A-Za-z0-9_+=.-]+$/.test(v) && /[0-9]/.test(v) && /[A-Za-z]/.test(v) && entropy(v) >= 3.5)
const EnvValue = ArgvItem.refine(
  (v) => !looksSecret(v),
  'this environment value looks like a secret; credentials must not be put here (it is shown on the approval card and stored in the job file)',
)

function sourceConfigSchema(strict: boolean) {
  const obj = <T extends z.ZodRawShape>(s: T) => (strict ? z.strictObject(s) : z.object(s))
  // `class` marks every item from the source as work or own. Absent = the source's own word per item. Reading treats a value
  // this Talos does not know as `work` (never `own`: a newer class may be stricter); writing refuses it.
  const klass = strict ? HeartbeatItemClass.optional() : HeartbeatItemClass.optional().catch('work')
  const common = { id: HeartbeatSourceId, enabled: z.boolean(), class: klass }
  const timeout = z.number().int().min(HEARTBEAT_SOURCE_TIMEOUT_MIN_S).max(HEARTBEAT_SOURCE_TIMEOUT_MAX_S)
  return z.discriminatedUnion('kind', [
    obj({
      ...common,
      kind: z.literal('github'),
      args: obj({ repos: z.array(Repo).min(1).max(20) }),
      timeout_s: timeout,
    }),
    obj({ ...common, kind: z.literal('schedule-failures'), args: obj({}).default({}), timeout_s: timeout }),
    obj({ ...common, kind: z.literal('inbox'), args: obj({}).default({}), timeout_s: timeout }),
    obj({
      ...common,
      kind: z.literal('command'),
      args: obj({
        /** Run directly, never through a shell. argv[0] is the program and must be an absolute path. */
        argv: z
          .array(ArgvItem)
          .min(1)
          .max(20)
          .refine((a) => (a[0] ?? '').startsWith('/'), 'the first item of argv must be an absolute path'),
        cwd: AbsPath.optional(),
        env: z
          .record(z.string(), EnvValue)
          .superRefine((e, ctx) => {
            const names = Object.keys(e)
            if (names.length > 10) ctx.addIssue({ code: 'custom', message: 'at most 10 environment variables' })
            for (const n of names) {
              if (!ENV_NAME.test(n))
                ctx.addIssue({
                  code: 'custom',
                  path: [n],
                  message: 'an environment name is capital letters, digits and _',
                })
              else if (RISKY_ENV.test(n))
                ctx.addIssue({
                  code: 'custom',
                  path: [n],
                  message: `this environment name ${RISKY_ENV_WORDS}; it is not allowed`,
                })
            }
          })
          .optional(),
      }),
      timeout_s: timeout,
    }),
  ])
}
export const HeartbeatSourceConfig = sourceConfigSchema(true)
const HeartbeatSourceConfigLoose = sourceConfigSchema(false)

function muteSchema(strict: boolean) {
  const shape = {
    source: HeartbeatSourceId,
    /** Without a key the whole source is muted. */
    key: PlainKey(200).optional(),
    until: IsoTs,
  }
  return strict ? z.strictObject(shape) : z.object(shape)
}
export const HeartbeatMute = muteSchema(true)

function configShape(strict: boolean) {
  const sources = z
    .array(strict ? HeartbeatSourceConfig : HeartbeatSourceConfigLoose)
    .min(1)
    .max(HEARTBEAT_MAX_SOURCES)
  const mutes = z.array(muteSchema(strict)).max(HEARTBEAT_MAX_MUTES)
  const fields = {
    schema: z.literal(HEARTBEAT_CONFIG_SCHEMA),
    mode: HeartbeatMode.default('shadow'),
    sources,
    mutes,
    wake_cap_per_day: z
      .number()
      .int()
      .min(HEARTBEAT_WAKES_MIN)
      .max(HEARTBEAT_WAKES_MAX)
      .default(HEARTBEAT_WAKES_DEFAULT),
    run_timeout_s: z
      .number()
      .int()
      .min(HEARTBEAT_RUN_TIMEOUT_MIN_S)
      .max(HEARTBEAT_RUN_TIMEOUT_MAX_S)
      .default(HEARTBEAT_RUN_TIMEOUT_DEFAULT_S),
  }
  return (strict ? z.strictObject(fields) : z.object(fields)).superRefine((c, ctx) => {
    const ids = new Set<string>()
    for (const [i, s] of c.sources.entries()) {
      if (ids.has(s.id))
        ctx.addIssue({ code: 'custom', path: ['sources', i, 'id'], message: `source id "${s.id}" is used twice` })
      ids.add(s.id)
    }
    for (const [i, m] of c.mutes.entries())
      if (!ids.has(m.source))
        ctx.addIssue({
          code: 'custom',
          path: ['mutes', i, 'source'],
          message: `mutes a source that is not in this heartbeat`,
        })
  })
}

/**
 * The heartbeat's settings, carried in the Chronos job's `meta` under `HEARTBEAT_META_KEY` (4 KiB for the whole meta, so
 * keep ids and args short). Strict: this is what Talos writes.
 */
export const HeartbeatConfig = configShape(true)
const HeartbeatConfigLoose = configShape(false)

/** `sha256:<hex>` over the canonical (sorted-key) form of a config: the same settings always hash the same. */
export function configHash(config: HeartbeatConfigT): string {
  return payloadHash(config as unknown as Record<string, unknown>)
}

/**
 * The hash a Heartbeat test is bound to: `configHash` of the STRICT parse of the raw `talos.heartbeat` object, so defaults (mode,
 * caps, timeouts) are part of it. The app and the bridge both call this, so they cannot disagree. Throws when `raw` is not a
 * heartbeat this Talos could write: it never hashes something it could not have produced.
 */
export function heartbeatConfigHashOf(raw: unknown): string {
  return configHash(HeartbeatConfig.parse(raw))
}

// ---- source process I/O

/** What the runner writes to a source's stdin. */
export const HeartbeatSourceRequest = z.strictObject({
  schema: z.literal(HEARTBEAT_SOURCE_SCHEMA),
  now: IsoTs,
  since: IsoTs.nullable(),
  cursor: z.record(z.string(), z.unknown()).nullable(),
  dry: z.boolean(),
})

/** What a source prints. `ok` carries items and a cursor and no error; `error` carries an error. */
const HeartbeatSourceResponseEnvelope = z.discriminatedUnion('status', [
  z.object({
    schema: z.literal(HEARTBEAT_SOURCE_SCHEMA),
    status: z.literal('ok'),
    error: z.undefined({ error: 'an ok answer cannot carry an error' }).optional(),
    cursor: z.record(z.string(), z.unknown()).nullable(),
    items: z.array(z.unknown()),
  }),
  z.object({
    schema: z.literal(HEARTBEAT_SOURCE_SCHEMA),
    status: z.literal('error'),
    error: Untrusted(HEARTBEAT_ERROR_MAX_CHARS),
    cursor: z.record(z.string(), z.unknown()).nullable().default(null),
    items: z.array(z.unknown()).default([]),
  }),
])

export type HeartbeatSourceItemT = z.infer<typeof HeartbeatSourceItem>
export type HeartbeatSourceResponse =
  | { ok: true; cursor: Record<string, unknown> | null; items: HeartbeatSourceItemT[]; unreadable: number }
  | { ok: false; error: string }

/**
 * A source's stdout, checked. Over 256 KiB, over 50 items, not JSON, a wrong `schema` or an unknown `status` is a source
 * error (never a cut-off list or an empty one). Inside a good answer, one item that doesn't parse is dropped and counted in
 * `unreadable`; keys it doesn't know are ignored. Item text is capped and escaped here, once.
 */
export function parseHeartbeatSourceResponse(stdout: string): HeartbeatSourceResponse {
  const bytes = utf8Bytes(stdout)
  if (bytes > HEARTBEAT_SOURCE_MAX_BYTES)
    return {
      ok: false,
      error: `the source printed ${bytes} bytes; the limit is ${HEARTBEAT_SOURCE_MAX_BYTES} (256 KiB)`,
    }
  let json: unknown
  try {
    json = JSON.parse(stdout)
  } catch {
    return { ok: false, error: 'the source did not print JSON' }
  }
  const p = HeartbeatSourceResponseEnvelope.safeParse(json)
  if (!p.success) return { ok: false, error: `the source's answer is not valid: ${plainProblem(p.error)}` }
  if (p.data.status === 'error') return { ok: false, error: p.data.error }
  if (p.data.items.length > HEARTBEAT_SOURCE_MAX_ITEMS)
    return {
      ok: false,
      error: `the source returned ${p.data.items.length} items; the limit is ${HEARTBEAT_SOURCE_MAX_ITEMS}`,
    }
  const items: HeartbeatSourceItemT[] = []
  let unreadable = 0
  for (const r of p.data.items) {
    const i = HeartbeatSourceItemIn.safeParse(r)
    if (i.success) items.push(i.data)
    else unreadable++
  }
  return { ok: true, cursor: p.data.cursor, items, unreadable }
}

// ---- result

const LevelCounts = z.strictObject({
  silent: z.number().int().min(0),
  fyi: z.number().int().min(0),
  act: z.number().int().min(0),
})
const sumLevels = (c: z.infer<typeof LevelCounts>) => c.silent + c.fyi + c.act

export const HeartbeatSourceResult = z
  .strictObject({
    id: HeartbeatSourceId,
    ok: z.boolean(),
    ms: z
      .number()
      .int()
      .min(0)
      .max(HEARTBEAT_RUN_TIMEOUT_MAX_S * 1000),
    /** Items this source sent that could not be read and were dropped. */
    unreadable: z.number().int().min(0),
    /** Already escaped by the source parse (`parseHeartbeatSourceResponse`); checked here, never escaped again. */
    error: Stored(HEARTBEAT_ERROR_MAX_CHARS).optional(),
  })
  .refine((s) => !(s.ok && s.error !== undefined), {
    message: 'a source that is ok cannot carry an error',
    path: ['error'],
  })

/**
 * What one heartbeat run reports. `run_key` is the Chronos run key of the slot (or an ad-hoc Run now key). `partial` is a
 * run where some sources answered and some failed.
 */
export const HeartbeatResult = z
  .strictObject({
    run_key: RunKey,
    outcome: HeartbeatOutcome,
    items_seen: z.number().int().min(0),
    items_new: z.number().int().min(0),
    seen_by_level: LevelCounts,
    new_by_level: LevelCounts,
    sources: z.array(HeartbeatSourceResult).max(HEARTBEAT_MAX_SOURCES),
  })
  .superRefine((r, ctx) => {
    if (r.outcome === 'silent') {
      const i = r.sources.findIndex((s) => s.unreadable > 0)
      if (i >= 0)
        ctx.addIssue({
          code: 'custom',
          path: ['sources', i, 'unreadable'],
          message: 'a run that dropped unreadable items cannot be silent; report it as partial',
        })
    }
    if (sumLevels(r.seen_by_level) !== r.items_seen)
      ctx.addIssue({
        code: 'custom',
        path: ['seen_by_level'],
        message: 'the counts by level do not add up to items_seen',
      })
    if (sumLevels(r.new_by_level) !== r.items_new)
      ctx.addIssue({
        code: 'custom',
        path: ['new_by_level'],
        message: 'the counts by level do not add up to items_new',
      })
  })

export type HeartbeatLevelT = z.infer<typeof HeartbeatLevel>
export type HeartbeatItemT = z.infer<typeof HeartbeatItem>
export type HeartbeatSourceConfigT = z.infer<typeof HeartbeatSourceConfig>
export type HeartbeatMuteT = z.infer<typeof HeartbeatMute>
export type HeartbeatConfigT = z.infer<typeof HeartbeatConfig>
export type HeartbeatResultT = z.infer<typeof HeartbeatResult>
export type HeartbeatSourceRequestT = z.infer<typeof HeartbeatSourceRequest>

/** Reads stored or received items one at a time: a row that doesn't parse is counted in `unreadable`, never fatal. */
export function parseHeartbeatItems(raw: unknown): { items: z.infer<typeof HeartbeatItemRead>[]; unreadable: number } {
  if (!Array.isArray(raw)) return { items: [], unreadable: 1 }
  const items: z.infer<typeof HeartbeatItemRead>[] = []
  let unreadable = 0
  for (const r of raw) {
    const p = HeartbeatItemRead.safeParse(r)
    if (p.success) items.push(p.data)
    else unreadable++
  }
  return { items, unreadable }
}

/** `{'talos.heartbeat': config}` as a job `meta`, or a plain-words refusal when it would not fit (4 KiB for the whole meta). */
export function heartbeatMetaOf(
  config: HeartbeatConfigT,
): { ok: true; meta: JobMetaT } | { ok: false; problem: string } {
  const raw = { [HEARTBEAT_META_KEY]: config }
  const bytes = utf8Bytes(JSON.stringify(raw))
  if (bytes > META_MAX_BYTES)
    return {
      ok: false,
      problem: `This heartbeat is too big to save (${bytes} of ${META_MAX_BYTES} bytes). Remove a source or a mute, or shorten the names.`,
    }
  const meta = JobMeta.safeParse(raw)
  return meta.success
    ? { ok: true, meta: meta.data }
    : { ok: false, problem: `This heartbeat can't be saved: ${meta.error.issues[0]?.message ?? 'not valid'}` }
}

export type HeartbeatFromMeta =
  | { config: HeartbeatConfigT /** sources from a newer Talos this one skipped */; skipped: number }
  | { problem: string }

function plainProblem(e: z.ZodError): string {
  const i = e.issues[0]
  const where = i?.path.length ? `${i.path.join('.')}: ` : ''
  return capEscape(`${where}${i?.message ?? 'not valid'}`, 200)
}

/**
 * The heartbeat in a job's `meta`, or `null` when the job has none (no `talos.heartbeat` key). Tolerant: a source whose kind
 * this Talos doesn't know is skipped (and any mute for it dropped) and counted; unknown keys are ignored at every depth.
 * Anything else wrong is a plain-words `problem`, never a throw.
 */
export function heartbeatConfigFromMeta(meta: unknown): HeartbeatFromMeta | null {
  if (meta === null || typeof meta !== 'object' || Array.isArray(meta)) return null
  if (!Object.hasOwn(meta, HEARTBEAT_META_KEY)) return null
  const raw = (meta as Record<string, unknown>)[HEARTBEAT_META_KEY]
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw))
    return { problem: 'the heartbeat settings are not an object' }
  const r = raw as Record<string, unknown>
  let skipped = 0
  const skippedIds = new Set<string>()
  let sources: unknown = r.sources
  if (Array.isArray(sources)) {
    sources = sources.filter((s) => {
      const known = HeartbeatSourceKind.safeParse((s as { kind?: unknown } | null)?.kind).success
      const looksLikeSource = s !== null && typeof s === 'object' && typeof (s as { kind?: unknown }).kind === 'string'
      if (looksLikeSource && !known) {
        skipped++
        skippedIds.add(String((s as { id?: unknown }).id))
        return false
      }
      return true
    })
  }
  const mutes = Array.isArray(r.mutes)
    ? r.mutes.filter((m) => !skippedIds.has(String((m as { source?: unknown } | null)?.source)))
    : r.mutes
  const p = HeartbeatConfigLoose.safeParse({ ...r, sources, mutes })
  return p.success ? { config: p.data as HeartbeatConfigT, skipped } : { problem: plainProblem(p.error) }
}

/**
 * Why a job may NOT carry this meta, in plain words, or null. A meta with a `talos.heartbeat` key has to be a heartbeat this
 * Talos can read in full (the strict config, no skipped source kind and no unknown key) and the job has to fire at several
 * times a day. Every way a change reaches the scheduler (the agent's propose tool, the owner's form frame) asks this before
 * a card is made, so no card ever offers an unreadable heartbeat for approval.
 */
export function heartbeatMetaProblem(meta: unknown, when: { type?: string } | null | undefined): string | null {
  if (meta === null || typeof meta !== 'object' || Array.isArray(meta) || !Object.hasOwn(meta, HEARTBEAT_META_KEY))
    return null
  const raw = (meta as Record<string, unknown>)[HEARTBEAT_META_KEY]
  if (
    raw !== null &&
    typeof raw === 'object' &&
    !Array.isArray(raw) &&
    Array.isArray((raw as { sources?: unknown }).sources)
  )
    for (const s of (raw as { sources: unknown[] }).sources) {
      const kind = (s as { kind?: unknown } | null)?.kind
      if (typeof kind === 'string' && !HeartbeatSourceKind.safeParse(kind).success)
        return `The heartbeat has a source of a kind this Talos doesn't know ("${capEscape(kind, 40)}"). Update Talos, or use github, schedule-failures, inbox or command. Nothing was saved.`
    }
  const p = HeartbeatConfig.safeParse(raw)
  if (!p.success) return `The heartbeat settings are not valid (${plainProblem(p.error)}). Nothing was saved.`
  if (when?.type !== 'times')
    return 'A heartbeat has to be a job that fires at several times a day (a "times" schedule). Nothing was saved.'
  return null
}

const stable = (x: unknown): string =>
  JSON.stringify(x, (_k, v) =>
    v && typeof v === 'object' && !Array.isArray(v)
      ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
      : v,
  )

const rawHeartbeat = (m: unknown): Record<string, unknown> | null => {
  if (m === null || typeof m !== 'object' || Array.isArray(m) || !Object.hasOwn(m, HEARTBEAT_META_KEY)) return null
  const h = (m as Record<string, unknown>)[HEARTBEAT_META_KEY]
  return h !== null && typeof h === 'object' && !Array.isArray(h) ? (h as Record<string, unknown>) : null
}

/**
 * True when `after` differs from `before` ONLY by mutes that can only quiet one exact item for a while. The raw heartbeat
 * objects are compared with `mutes` taken out: any other difference, an unknown key included, is not a mute change. Both
 * sides must be valid strict heartbeats. Every mute that is new must name an exact key (a whole-source mute is not low risk)
 * and end within 30 days of `now`; without a `now` a new mute cannot be judged, so it is not low risk. Removing a mute is
 * always fine.
 */
export function heartbeatMuteOnlyChange(before: unknown, after: unknown, now?: string): boolean {
  const a = rawHeartbeat(before)
  const b = rawHeartbeat(after)
  if (!a || !b) return false
  if (!HeartbeatConfig.safeParse(a).success || !HeartbeatConfig.safeParse(b).success) return false
  const others = (m: unknown) => {
    const { [HEARTBEAT_META_KEY]: _hb, ...rest } = m as Record<string, unknown>
    return stable(rest)
  }
  if (others(before) !== others(after)) return false
  const { mutes: ma, ...restA } = a
  const { mutes: mb, ...restB } = b
  if (stable(restA) !== stable(restB)) return false
  const had = new Set((Array.isArray(ma) ? ma : []).map(stable))
  const limit = now === undefined ? Number.NaN : Date.parse(now) + HEARTBEAT_MUTE_LOW_RISK_DAYS * 86_400_000
  for (const m of Array.isArray(mb) ? mb : []) {
    if (had.has(stable(m))) continue
    const { key, until } = m as { key?: unknown; until?: unknown }
    if (typeof key !== 'string') return false
    const t = typeof until === 'string' ? Date.parse(until) : Number.NaN
    if (!Number.isFinite(t) || !Number.isFinite(limit) || t > limit) return false
  }
  return true
}

/**
 * True when a mute covers `item` at `now`. Keys match by EXACT string equality: never a prefix, a pattern, a different case
 * or a trimmed form. A mute with no key covers its whole source. A mute that has ended (its `until` is not after `now`), or
 * a `now` that can't be read, covers nothing.
 */
export function heartbeatMuteMatches(
  mutes: ReadonlyArray<{ source: string; key?: string | undefined; until: string }>,
  item: { source: string; key: string },
  now: string,
): boolean {
  const t = Date.parse(now)
  if (!Number.isFinite(t)) return false
  return mutes.some((m) => {
    const end = Date.parse(m.until)
    return Number.isFinite(end) && end > t && m.source === item.source && (m.key === undefined || m.key === item.key)
  })
}
