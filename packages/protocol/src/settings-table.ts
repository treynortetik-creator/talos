// One row per setting in config.json: who may change it, whether a change needs step-up, and its default. The lists that
// used to be kept by hand (CONFIG_PATCH_ALLOWLIST, CONFIG_SESSION_STEPUP_FIELDS, AGENT_CONFIG_ALLOWLIST,
// AGENT_CONFIG_REFUSED, the work and memory-browser rules in checkConfigPatch and the bridge) are read from this table.
//
// A setting added to `AgentConfig` with no row here fails `pnpm typecheck`: the table is checked against every config
// path. A setting with no way to change it from a phone or by the agent is Mac only: say so with `phone: false` and
// `agent: false`.
import type { AgentConfigT } from './config.ts'

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

export type SettingRow<P extends string = string> = PathRules<P> & {
  /**
   * The phone, over `config.patch`. `'leaf'`: this setting only (a top-level field is its own leaf). `'section'`: the whole
   * top-level section it sits in is open to the phone, whatever key a patch names inside it. `false`: not from a phone.
   * Every row of a section that has a `'section'` row must be `'section'` too (`settingsTableProblems`).
   */
  readonly phone: 'leaf' | 'section' | false
  /** The agent, by proposing it with `config_propose` and a card the owner approves. */
  readonly agent: boolean
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
  'agent.name': { phone: 'section', agent: true, default: 'Talos' },
  'agent.voice': { phone: 'section', agent: true, default: 'meridian' },
  'agent.voice_persona': { phone: 'section', agent: false, refusedByName: true, default: '' },
  'owner.display_name': { phone: 'section', agent: true, default: 'You' },
  threads: { phone: 'leaf', agent: false, refusedByName: true, default: undefined },
  default_thread: { phone: 'leaf', agent: false, refusedByName: true, default: undefined },
  timezone: { phone: 'leaf', agent: true, default: undefined },
  quiet_window: { phone: 'leaf', agent: true, default: null },
  'notifications.master': { phone: 'section', agent: false, refusedByName: true, default: true },
  'notifications.show_thread_names': { phone: 'section', agent: false, refusedByName: true, default: 'fixed_only' },
  'voice_notes.reply_with_voice': { phone: 'section', agent: true, default: 'when_voice' },
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
  theme: { phone: 'leaf', agent: true, default: undefined },
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
