// One row per setting in config.json: who may change it, whether a change needs step-up, its default, and for the few
// settings the agent may propose, what to call it, what values it takes and how to read it. The lists that used to be kept
// by hand (CONFIG_PATCH_ALLOWLIST, CONFIG_SESSION_STEPUP_FIELDS, AGENT_CONFIG_ALLOWLIST, AGENT_CONFIG_REFUSED, the value
// rules, labels and readers of config_propose, the words the agent is told, the work and memory-browser rules in
// checkConfigPatch and the bridge) are read from this table.
//
// A setting added to `AgentConfig` with no row here fails `pnpm typecheck`: the table is checked against every config
// path. A setting with no way to change it from a phone or by the agent is Mac only: say so with `phone: false` and
// `agent: false`. A row with `agent: true` and no `agentRule` fails it too.
//
// What stays outside: the shape and the load-time leniency of each field (`AgentConfig` in config.ts). `SettingPath` and each
// row's `default` type are taken from it, so a field added there needs a row here, and `settings-table.test.ts` checks every
// `default` against what the schema really gives.
import { z } from 'zod'
import { type AgentConfigT, HHMM, isIanaZone } from './config.ts'
import { themeProblems, validateTheme } from './theme.ts'

/**
 * Stock voices GPT-Live documents. The default, `meridian`, is documented as North American. One list for the Settings
 * select and for `agent.voice` proposals: a guessed id the provider would refuse never reaches a card.
 */
export const VOICE_CHOICES = [
  'meridian',
  'marin',
  'alloy',
  'ash',
  'ballad',
  'beacon',
  'bossa',
  'cedar',
  'cinder',
  'coral',
  'delta',
  'echo',
  'gleam',
  'quartz',
  'ripple',
  'sage',
  'shida',
  'shimmer',
  'stone',
  'tempo',
  'verse',
  'vesper',
  'willow',
] as const

// biome-ignore lint/suspicious/noControlCharactersInRegex: rejecting control characters is the point
const UNSAFE_TEXT = /[\u0000-\u001f\u007f-\u009f؜‎‏‪-‮⁦-⁩]/
const Plain = (min: number, max: number) =>
  z
    .string()
    .min(min)
    .max(max)
    .refine(
      (s) => !UNSAFE_TEXT.test(s) && s.trim() === s && s.trim().length >= min,
      'plain text, no control characters',
    )

const QuietWindow = z
  .object({ start: HHMM, end: HHMM })
  .strict()
  .refine((w) => w.start !== w.end, 'start and end must differ')
  .nullable()

/** A whole custom theme, checked by the one validator the app and the config file use. Every problem is named in the refusal. */
const ThemeValue = z.unknown().transform((v, ctx) => {
  const problems = themeProblems(v)
  if (problems.length > 0) {
    ctx.addIssue({ code: 'custom', message: `refused, nothing was proposed. ${problems.join('; ')}` })
    return z.NEVER
  }
  return validateTheme(v).ok ? (validateTheme(v) as { theme: unknown }).theme : z.NEVER
})

/** Config sections whose children are settings of their own. Every other top-level field is one setting. */
type Section = 'agent' | 'owner' | 'notifications' | 'work' | 'voice_notes'
/** `version` and `rev` belong to the file, not to the owner. */
type FileField = 'version' | 'rev'

/** Every setting path: a top-level field, or `section.child` for the sections above. */
export type SettingPath =
  | Exclude<keyof AgentConfigT, Section | FileField>
  | { [S in Section]: `${S}.${keyof AgentConfigT[S] & string}` }[Section]

type ValueAt<P extends string> = P extends `${infer S}.${infer K}`
  ? S extends keyof AgentConfigT
    ? K extends keyof AgentConfigT[S]
      ? AgentConfigT[S][K]
      : never
    : never
  : P extends keyof AgentConfigT
    ? AgentConfigT[P]
    : never

/** The step-up purposes a change can need (`packages/protocol/src/stepup.ts`). */
export type SettingStepup = 'config:session' | 'config:work'

type Dotted = `${string}.${string}`

/**
 * Rules that only make sense for one kind of path, so the wrong kind is a type error. `config:session` and `phoneOffOnly`
 * are read for top-level fields only; `config:work` is read for `section.child` leaves only. A row outside its kind would
 * be ignored, leaving the phone path open. `string` (the loose row the derived lists walk) allows either.
 */
type PathRules<P extends string> = string extends P
  ? { readonly stepup?: SettingStepup; readonly phoneOffOnly?: string; readonly stepupOnTrue?: SettingStepup }
  : P extends Dotted
    ? { readonly stepup?: 'config:work'; readonly phoneOffOnly?: undefined; readonly stepupOnTrue?: undefined }
    : {
        readonly stepup?: 'config:session'
        readonly phoneOffOnly?: string
        /**
         * A boolean the phone may write, where only `true` needs the step-up (`false` and `null` are free). Never skipped
         * by trust mode. Read for top-level rows only; the value must be a boolean or null (`checkConfigPatch`).
         */
        readonly stepupOnTrue?: 'config:session'
      }

/** What the agent needs to propose a setting: its name on a card, the words it is told, and the values it may send. */
export type AgentRule = {
  /** The setting's name on a card: "Agent name: Talos -> Atlas". */
  readonly label: string
  /** The setting in the sentence that tells the agent which settings it may change ("agent name, live-call voice and ..."). */
  readonly phrase: string
  /** The value it takes, in the tool's argument text ("agent.name (1-32 chars)"). */
  readonly hint: string
  /** The value rules: what a proposal, and the card at apply time, may carry. */
  readonly value: z.ZodType<unknown>
  /** What a file without the setting reads as when the owner is shown the old value (`theme` absent is `talos`). */
  readonly whenAbsent?: unknown
  /** One value as a card line reads it; without this, `String(value)`. */
  readonly show?: (v: unknown) => string
}

type AgentSide =
  | { readonly agent: true; readonly agentRule: AgentRule }
  | { readonly agent: false; readonly agentRule?: undefined }

export type SettingRow<P extends string = string> = PathRules<P> &
  AgentSide & {
    /**
     * The phone, over `config.patch`. `'leaf'`: this setting only (a top-level field is its own leaf). `'section'`: the whole
     * top-level section it sits in is open to the phone, whatever key a patch names inside it. `false`: not from a phone.
     * Every row of a section that has a `'section'` row must be `'section'` too (`settingsTableProblems`).
     */
    readonly phone: 'leaf' | 'section' | false
    /** An agent refusal for this setting says "you can't change this, the owner does it in Settings" instead of "not a setting". */
    readonly refusedByName?: boolean
    /**
     * The value when the file does not say. `undefined` means absent: an optional setting that is off, or one with no
     * schema default because `talos-app init` writes it (threads, default_thread, timezone).
     */
    readonly default: Readonly<ValueAt<P>> | undefined
  }

/** The shape `defineSettingsTable` demands: exactly one row per setting path, no more and no fewer. */
export type SettingsTableShape = { readonly [P in SettingPath]: SettingRow<P> }

/** Identity, typed so a missing or unknown row is a type error. Tests use it to prove that. */
export function defineSettingsTable<const T extends SettingsTableShape>(
  rows: T & { readonly [K in Exclude<keyof T, SettingPath>]: never },
): T {
  return rows
}

const MEMORY_BROWSER_OFF_ONLY = 'the memory browser can only be turned on at your Mac (talos-app memory on)'

/**
 * Row order is the order the lists derived from it read in, and the agent sees `AGENT_CONFIG_ALLOWLIST` in its tool
 * description, so move a row only on purpose.
 */
export const SETTINGS_TABLE = defineSettingsTable({
  'agent.name': {
    phone: 'section',
    agent: true,
    agentRule: { label: 'Agent name', phrase: 'agent name', hint: '1-32 chars', value: Plain(1, 32) },
    default: 'Talos',
  },
  'agent.voice': {
    phone: 'section',
    agent: true,
    agentRule: {
      label: 'Live-call voice',
      phrase: 'live-call voice',
      hint: `one of ${VOICE_CHOICES.join(', ')}`,
      value: z.enum(VOICE_CHOICES),
    },
    default: 'meridian',
  },
  'agent.voice_persona': { phone: 'section', agent: false, refusedByName: true, default: '' },
  'owner.display_name': {
    phone: 'section',
    agent: true,
    agentRule: { label: 'Your name', phrase: "the owner's name", hint: '1-40 chars', value: Plain(1, 40) },
    default: 'You',
  },
  threads: { phone: 'leaf', agent: false, refusedByName: true, default: undefined },
  default_thread: { phone: 'leaf', agent: false, refusedByName: true, default: undefined },
  timezone: {
    phone: 'leaf',
    agent: true,
    agentRule: {
      label: 'Timezone',
      phrase: 'timezone',
      hint: 'an IANA zone like Europe/Paris',
      value: z.string().max(64).refine(isIanaZone, 'a timezone from the list, like Europe/Paris'),
    },
    default: undefined,
  },
  quiet_window: {
    phone: 'leaf',
    agent: true,
    agentRule: {
      label: 'Quiet hours',
      phrase: 'quiet hours',
      hint: '{"start":"22:00","end":"07:00"} or null to turn it off',
      value: QuietWindow,
      whenAbsent: null,
      show: (v) => {
        const w = v as { start: string; end: string } | null
        return w ? `${w.start} to ${w.end}` : 'off'
      },
    },
    default: null,
  },
  'notifications.master': { phone: 'section', agent: false, refusedByName: true, default: true },
  'notifications.show_thread_names': { phone: 'section', agent: false, refusedByName: true, default: 'fixed_only' },
  'voice_notes.reply_with_voice': {
    phone: 'section',
    agent: true,
    agentRule: {
      label: 'Voice-note replies',
      phrase: 'voice-note replies',
      hint: '"when_voice", "always" or "never"',
      value: z.enum(['when_voice', 'always', 'never']),
      show: (v) =>
        ({ when_voice: 'when I send a voice note', always: 'always', never: 'never' })[String(v)] ?? String(v),
    },
    default: 'when_voice',
  },
  'voice_notes.driving_until': { phone: 'section', agent: false, default: null },
  'work.enabled': { phone: 'leaf', agent: false, refusedByName: true, stepup: 'config:work', default: [] },
  'work.thread': { phone: 'leaf', agent: false, refusedByName: true, default: undefined },
  'work.label': { phone: 'leaf', agent: false, refusedByName: true, default: 'Work systems' },
  'work.ask_note': {
    phone: 'leaf',
    agent: false,
    refusedByName: true,
    default: 'Ask your IT team before connecting these.',
  },
  'work.retention': {
    phone: 'leaf',
    agent: false,
    refusedByName: true,
    stepup: 'config:work',
    default: 'passthrough',
  },
  permission_relay: {
    phone: 'leaf',
    agent: false,
    refusedByName: true,
    stepup: 'config:session',
    default: false,
  },
  session_models: {
    phone: 'leaf',
    agent: false,
    refusedByName: true,
    default: ['default', 'opus', 'sonnet', 'haiku'],
  },
  memory_browser: {
    phone: 'leaf',
    agent: false,
    refusedByName: true,
    phoneOffOnly: MEMORY_BROWSER_OFF_ONLY,
    default: true,
  },
  dedicated: { phone: 'leaf', agent: false, refusedByName: true, default: undefined },
  // The applied theme: a stock id picked in Settings, or a custom theme the agent proposed and the owner approved on a card
  // (null over the patch = back to talos).
  theme: {
    phone: 'leaf',
    agent: true,
    agentRule: {
      label: 'Colour theme',
      phrase: 'the app theme',
      hint: 'a whole custom theme object, see the talos-theme skill: only the allowed tokens, typed values and readable contrast; the card shows the owner a preview and they tap Apply, even in trust mode',
      value: ThemeValue,
      whenAbsent: 'talos',
      show: (v) => (typeof v === 'string' ? v : `custom "${(v as { name?: string } | null)?.name ?? '?'}"`),
    },
    default: undefined,
  },
  // The owner, not the agent: off from the app is free, on needs the passkey (the session step-up, never skipped), and
  // `talos-app trust on|off` still works on the Mac. A proposal from the agent is refused by name.
  trust_mode: { phone: 'leaf', agent: false, refusedByName: true, stepupOnTrue: 'config:session', default: undefined },
} as const)

type Table = typeof SETTINGS_TABLE
type PathsWhere<K extends keyof SettingRow, V> = {
  [P in keyof Table]: Table[P][K & keyof Table[P]] extends V ? P : never
}[keyof Table]

/** The settings the agent may propose. */
export type AgentSettingPath = PathsWhere<'agent', true>

const rows = Object.entries(SETTINGS_TABLE) as Array<[SettingPath, SettingRow]>
const topOf = (path: string) => path.split('.')[0] as string
const unique = <T>(xs: T[]): T[] => [...new Set(xs)]

/** What `config.patch` accepts: a whole section (`agent`) or one leaf (`work.thread`). */
export const PHONE_PATCH_ENTRIES: readonly string[] = unique(
  rows.flatMap(([path, r]) => (r.phone === 'section' ? [topOf(path)] : r.phone === 'leaf' ? [path] : [])),
)

/** Top-level fields whose change needs the session step-up. */
export const SESSION_STEPUP_TOP_FIELDS: readonly string[] = rows
  .filter(([path, r]) => r.stepup === 'config:session' && !path.includes('.'))
  .map(([path]) => path)

/** Top-level booleans the phone may write whose `true` needs the session step-up (`false` and `null` are free). */
export const STEPUP_ON_TRUE_TOP_FIELDS: readonly string[] = rows
  .filter(([path, r]) => r.stepupOnTrue === 'config:session' && !path.includes('.'))
  .map(([path]) => path)

/** `section.child` paths whose change needs the work step-up. */
export const WORK_STEPUP_PATHS: readonly string[] = rows.filter(([, r]) => r.stepup === 'config:work').map(([p]) => p)

/**
 * Options inside `threads[].session_opts`. The rows above are config paths; `threads` is one leaf there, so a per-thread
 * option gets its row here, in the same file. `phone: false` and `agent: false` mean the owner sets it on the Mac only
 * (by hand in config.json): `threadOptsIssue` refuses any `config.patch`, phone, app or agent card, that turns it on, while
 * turning it off or sending the saved value back (Settings does, on any other edit) is fine. `risk: 'high'` marks an option
 * that opens something a thread session is fenced from.
 */
export const THREAD_SESSION_OPT_ROWS = {
  /** The thread's own session may run `talos-app errors list` and `errors show`, and nothing else (apps/bridge worker/cli-refusal.ts). */
  ops_read: { phone: false, agent: false, risk: 'high', default: false },
} as const satisfies Record<string, { phone: false; agent: false; risk: 'high'; default: boolean }>

/**
 * Registry view: the per-thread options that open something a session is fenced from, as setting paths (`threads.session_opts.<key>`). A risk table or app-control check reads these with the views derived from `SETTINGS_TABLE`.
 */
export const HIGH_RISK_SETTING_PATHS: readonly string[] = Object.entries(THREAD_SESSION_OPT_ROWS)
  .filter(([, r]) => r.risk === 'high')
  .map(([k]) => `threads.session_opts.${k}`)

type ThreadsLike = { threads?: unknown }
const listOf = (v: unknown): ReadonlyArray<unknown> => (Array.isArray(v) ? v : [])
const optsOf = (t: unknown): Record<string, unknown> => {
  const o = (t as { session_opts?: unknown } | null)?.session_opts
  return typeof o === 'object' && o !== null ? (o as Record<string, unknown>) : {}
}

/** The reason a patch may not be written when `next` turns on a Mac-only thread option that `current` did not have on, else null. */
export function threadOptsIssue(current: ThreadsLike, next: ThreadsLike): string | null {
  const before = new Map<string, unknown>()
  for (const t of listOf(current.threads)) before.set(String((t as { id?: unknown })?.id), t)
  for (const t of listOf(next.threads)) {
    const id = String((t as { id?: unknown })?.id)
    for (const key of Object.keys(THREAD_SESSION_OPT_ROWS)) {
      if (optsOf(t)[key] === true && optsOf(before.get(id))[key] !== true)
        return `thread "${id}": ${key} can only be turned on by the owner at the Mac (config.json)`
    }
  }
  return null
}

/** The agent's settings, in table order. */
export const AGENT_SETTING_PATHS = rows.filter(([, r]) => r.agent).map(([p]) => p) as unknown as readonly [
  AgentSettingPath,
  ...AgentSettingPath[],
]

/**
 * Names an agent refusal calls out. A section the agent can reach part of (`agent`, `voice_notes`) is named by the full
 * path; any other is named by its top-level field.
 */
export const AGENT_REFUSED_NAMES: readonly string[] = unique(
  rows
    .filter(([, r]) => r.refusedByName)
    .map(([path]) => (rows.some(([p, r]) => r.agent && topOf(p) === topOf(path)) ? path : topOf(path))),
)

/** The refusal for a phone patch that sets `memory_browser`-style settings the wrong way round, or null. */
export function phoneValueIssue(patch: Record<string, unknown>): string | null {
  for (const [path, r] of rows) {
    if (!r.phoneOffOnly || path.includes('.')) continue
    if (path in patch && patch[path] !== false) return r.phoneOffOnly
  }
  return null
}

/**
 * What is wrong with a table, in words; empty when it is sound. Each line names a row whose rule the derived lists would
 * ignore. The types catch most of these; this catches the rest, and a test runs it on `SETTINGS_TABLE`.
 */
export function settingsTableProblems(table: Readonly<Record<string, SettingRow>>): string[] {
  const out: string[] = []
  const entries = Object.entries(table)
  const sectionsOpen = new Set(entries.filter(([, r]) => r.phone === 'section').map(([p]) => topOf(p)))
  for (const [path, r] of entries) {
    const dotted = path.includes('.')
    if (sectionsOpen.has(topOf(path)) && r.phone !== 'section')
      out.push(`${path}: its section is open to the phone as a whole, so this row must be phone: 'section'`)
    if (r.stepup === 'config:session' && dotted) out.push(`${path}: config:session is only read on top-level rows`)
    if (r.stepup === 'config:work' && (!dotted || r.phone !== 'leaf'))
      out.push(`${path}: config:work is only read on dotted rows that are phone: 'leaf'`)
    if (r.phoneOffOnly !== undefined && dotted) out.push(`${path}: phoneOffOnly is only read on top-level rows`)
    if (r.stepupOnTrue !== undefined && (dotted || r.phone !== 'leaf'))
      out.push(`${path}: stepupOnTrue is only read on top-level rows that are phone: 'leaf'`)
  }
  return out
}

/** The agent's rule for each setting it may propose. A record over `AgentSettingPath`, so a missing rule cannot be written. */
export const AGENT_RULES = Object.fromEntries(
  rows.filter(([, r]) => r.agent).map(([p, r]) => [p, r.agentRule]),
) as unknown as Readonly<Record<AgentSettingPath, AgentRule>>

/** The value now in `config` at a setting path (`a.b` reads `config.a.b`), or the row's `whenAbsent` when the file has none. */
export function readSettingValue(config: AgentConfigT, path: AgentSettingPath): unknown {
  const [top, sub] = path.split('.') as [keyof AgentConfigT, string | undefined]
  const section = config[top] as unknown
  const v = sub === undefined ? section : (section as Record<string, unknown> | undefined)?.[sub]
  return v ?? AGENT_RULES[path].whenAbsent
}

/** The settings the agent may change, as a sentence part: "agent name, live-call voice and the app theme". */
export const AGENT_SETTINGS_PHRASE: string = (() => {
  const p = AGENT_SETTING_PATHS.map((x) => AGENT_RULES[x].phrase)
  return p.length < 2 ? p.join('') : `${p.slice(0, -1).join(', ')} and ${p[p.length - 1]}`
})()

/** The value rules in the tool's argument text: "agent.name (1-32 chars), agent.voice (one of ...), ...". */
export const AGENT_VALUE_HINTS: string = AGENT_SETTING_PATHS.map((p) => `${p} (${AGENT_RULES[p].hint})`).join(', ')
