// One row per setting in config.json: who may change it, its default, and for the few
// settings the agent may propose, what to call it, what values it takes and how to read it. The lists that used to be kept
// by hand (CONFIG_PATCH_ALLOWLIST, CONFIG_SESSION_STEPUP_FIELDS, AGENT_CONFIG_ALLOWLIST, AGENT_CONFIG_REFUSED, the value
// rules, labels and readers of config_propose, the words the agent is told, the work and memory-browser rules in
// checkConfigPatch and the bridge) are read from this table.
//
// Every row carries a `risk`, required so a row added without one fails `pnpm typecheck`: `low` and `high` (the agent may change
// it: made at once when the owner asked and his settings are not locked, otherwise a card; `high` is how much it matters, marked
// on its card), `mac` (the agent never sets it; refused by name, and only a row with `agent: false` may say so). For a row the agent cannot propose,
// `low`/`high` only say how sensitive it would be. The per-thread operations (create, rename, topic, icon, alerts, own session,
// archive) are not config paths of their own: they are `THREAD_FIELD_RULES` below, with their risk, in this same file.
//
// A setting added to `AgentConfig` with no row here fails `pnpm typecheck`: the table is checked against every config
// path. A setting with no way to change it from a phone or by the agent is Mac only: say so with `phone: false` and
// `agent: false`. A row with `agent: true` and no `agentRule` fails it too.
//
// What stays outside: the shape and the load-time leniency of each field (`AgentConfig` in config.ts). `SettingPath` and each
// row's `default` type are taken from it, so a field added there needs a row here, and `settings-table.test.ts` checks every
// `default` against what the schema really gives.

import { z } from 'zod'
import { SEND_KINDS } from './always-allow.ts'
import { type AgentConfigT, HHMM, isIanaZone, MAX_SESSION_MODELS, ModelValue } from './config.ts'
import { IsoTs, ThreadId } from './ids.ts'
import { THREAD_TOPIC_MAX, type ThreadT } from './models.ts'
import { themeProblems, validateTheme } from './theme.ts'
import { canBeDedicated, DEFAULT_IDLE_PARK_MIN, threadSessionsAllowed } from './thread-sessions.ts'

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
type Section = 'agent' | 'owner' | 'notifications' | 'work' | 'voice_notes' | 'dev'
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

type Dotted = `${string}.${string}`

/**
 * Rules that only make sense for one kind of path, so the wrong kind is a type error. `phoneOffOnly` is read for top-level
 * fields only. (No row asks for a passkey step-up: the owner's ruling of 2026-11-14 removed it everywhere but sign-in.)
 */
type PathRules<P extends string> = string extends P
  ? { readonly phoneOffOnly?: string }
  : P extends Dotted
    ? { readonly phoneOffOnly?: undefined }
    : { readonly phoneOffOnly?: string }

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
  /** Where the value lives when it is not the leaf at the row's path (`dedicated` is the master switch inside an object). */
  readonly read?: (config: AgentConfigT) => unknown
  /** The merge patch for one new value when it is not `{ path: value }` (`dedicated` writes only `enabled`). */
  readonly patch?: (value: unknown) => Record<string, unknown>
  /** What the value rules cannot see: a refusal in words from the config as it is now, or null. Runs at propose and again at apply. */
  readonly check?: (value: unknown, config: AgentConfigT) => string | null
  /** Only on a low row: a value, or the config it lands on, that makes this change high. */
  readonly alsoHigh?: AlsoHigh
}

/** How much a change matters (see the header). */
export const SETTING_RISKS = ['low', 'high', 'mac'] as const
export type SettingRisk = (typeof SETTING_RISKS)[number]

/**
 * A value, or the config it lands on, that makes a `low` row high: a change for which `when` is true is a card even in trust
 * mode. `phrase` is how the agent is told ("setting quiet hours").
 */
export type AlsoHigh = {
  readonly phrase: string
  readonly when: (value: unknown, config: AgentConfigT) => boolean
}

type AgentSide =
  | { readonly agent: true; readonly agentRule: AgentRule; readonly risk: 'low' | 'high' }
  | { readonly agent: false; readonly agentRule?: undefined; readonly risk: SettingRisk }

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
     * `false`: the relay keeps this setting for its own use and never sends it to the phones or the web app (not in `ready`, not in
     * a stored or sent `config.sync`). `stripDeviceHidden` is the one function that takes it out.
     */
    readonly devices?: false
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

// config.patch still only turns the memory browser off. Since 2026-11-15 (the owner's ask) picking folders in Settings turns it
// on too, but not through here: the owner's signed memory.roots_set does it in the Mac's own handler (frames-memory-roots.ts,
// bridge memory/roots.ts), after checking every folder against its own listing.
const MEMORY_BROWSER_OFF_ONLY = 'the memory browser can only be turned on at your Mac (talos-app memory on)'

const onOff = (v: unknown) => (v === true ? 'on' : v === false ? 'off' : String(v))
const none = (v: unknown) => (v === '' || v === null || v === undefined ? 'none' : String(v))

/** The model picker's list: the same alias grammar the config file reads. */
const ModelList = z.array(ModelValue).min(1).max(MAX_SESSION_MODELS)

/** A new thread: a name, and optionally the "what goes here" line and an icon. Strict, so nothing else (a folder, a kind) can ride along. */
const NewThread = z.strictObject({
  name: Plain(1, 40),
  topic: Plain(0, THREAD_TOPIC_MAX).optional(),
  icon: Plain(0, 16).optional(),
})

/**
 * Row order is the order the lists derived from it read in, and the agent sees `AGENT_CONFIG_ALLOWLIST` in its tool
 * description, so move a row only on purpose.
 */
export const SETTINGS_TABLE = defineSettingsTable({
  'agent.name': {
    phone: 'section',
    agent: true,
    risk: 'low',
    agentRule: { label: 'Agent name', phrase: 'agent name', hint: '1-32 chars', value: Plain(1, 32) },
    default: 'Talos',
  },
  'agent.voice': {
    phone: 'section',
    agent: true,
    risk: 'low',
    agentRule: {
      label: 'Live-call voice',
      phrase: 'live-call voice',
      hint: `one of ${VOICE_CHOICES.join(', ')}`,
      value: z.enum(VOICE_CHOICES),
    },
    default: 'meridian',
  },
  // The text injected into the live-voice prompt: an agent writing its own standing prompt is the one thing a card cannot make safe.
  // The text added to the live-voice prompt: the agent sets it only when the owner asks for a persona, and the owner is told at once
  // what it now says and how to undo it. High: whatever it says, the voice reads it on every call.
  'agent.voice_persona': {
    phone: 'section',
    agent: true,
    risk: 'high',
    agentRule: {
      label: 'Live-call persona',
      phrase: 'live-call persona',
      hint: 'up to 4000 chars; empty for none',
      value: z.string().max(4000),
      show: none,
    },
    default: '',
  },
  'owner.display_name': {
    phone: 'section',
    agent: true,
    risk: 'low',
    agentRule: { label: 'Your name', phrase: "the owner's name", hint: '1-40 chars', value: Plain(1, 40) },
    default: 'You',
  },
  // The agent reaches the list through the paths in THREAD_FIELD_RULES (one thread at a time, old and new on the card); this
  // row's rule is the one for a NEW thread (`threads.<new_id>`), and its risk is that of creating one.
  threads: {
    phone: 'leaf',
    agent: true,
    risk: 'low',
    agentRule: {
      label: 'New thread',
      phrase: 'threads',
      hint: 'a new thread: {"name":"1-40 chars","topic":"what goes here","icon":"key"}',
      value: NewThread,
      show: (v) => {
        if (v === null || v === undefined) return 'does not exist'
        const t = v as { name: string; topic?: string; icon?: string }
        return `"${t.name}"${t.topic ? ` (${t.topic})` : ''}${t.icon ? `, icon ${t.icon}` : ''}`
      },
    },
    default: undefined,
  },
  default_thread: {
    phone: 'leaf',
    agent: true,
    risk: 'high', // decides where approval cards and security notices land
    agentRule: {
      label: 'Default thread',
      phrase: 'the default thread',
      hint: 'a thread id from list_threads, not archived and not a system thread',
      value: ThreadId,
      check: (v, c) => {
        const t = c.threads.find((x) => x.id === v)
        if (!t)
          return `Unknown thread "${String(v)}". Valid thread ids: ${c.threads
            .filter((x) => !x.archived)
            .map((x) => x.id)
            .join(', ')}`
        if (t.archived || t.kind === 'system')
          return `thread ${t.id} can't be the default thread (archived or a system thread)`
        return null
      },
    },
    default: undefined,
  },
  // The quiet window is read in this zone, so moving the zone moves the window, and a zone moved first would make a later
  // quiet-hours card the owner approves land at other hours (audit 2026-11-10 #5). It rarely changes: always a card.
  timezone: {
    phone: 'leaf',
    agent: true,
    risk: 'high',
    agentRule: {
      label: 'Timezone',
      phrase: 'timezone',
      hint: 'an IANA zone like Europe/Paris',
      value: z.string().max(64).refine(isIanaZone, 'a timezone from the list, like Europe/Paris'),
    },
    default: undefined,
  },
  // The relay's quiet window holds every non-system push, approval cards included, so an agent that sets one could keep the
  // owner from hearing about anything. Setting or moving it is high, and its notice is pushed through quiet hours; turning it
  // off stays low.
  quiet_window: {
    phone: 'leaf',
    agent: true,
    risk: 'low',
    agentRule: {
      label: 'Quiet hours',
      phrase: 'quiet hours',
      hint: '{"start":"22:00","end":"07:00"} or null to turn it off',
      alsoHigh: { phrase: 'setting quiet hours', when: (v) => v != null },
      value: QuietWindow,
      whenAbsent: null,
      show: (v) => {
        const w = v as { start: string; end: string } | null
        return w ? `${w.start} to ${w.end}` : 'off'
      },
    },
    default: null,
  },
  // Turning every notification off is a change the owner must see: high, and its notice is pushed past the switch itself.
  'notifications.master': {
    phone: 'section',
    agent: true,
    risk: 'high',
    agentRule: {
      label: 'Notifications',
      phrase: 'notifications on or off',
      hint: 'true or false',
      value: z.boolean(),
      show: onOff,
    },
    default: true,
  },
  // Thread names on the lock screen leave the phone, so this is a card too.
  'notifications.show_thread_names': {
    phone: 'section',
    agent: true,
    risk: 'high',
    agentRule: {
      label: 'Thread names in notifications',
      phrase: 'thread names in notifications',
      hint: '"fixed_only", "all" or "none"',
      value: z.enum(['fixed_only', 'all', 'none']),
      show: (v) => ({ fixed_only: 'fixed threads only', all: 'all threads', none: 'none' })[String(v)] ?? String(v),
    },
    default: 'fixed_only',
  },
  'voice_notes.reply_with_voice': {
    phone: 'section',
    agent: true,
    risk: 'low',
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
  'voice_notes.driving_until': {
    phone: 'section',
    agent: true,
    risk: 'low',
    agentRule: {
      label: 'Driving mode until',
      phrase: 'driving mode',
      hint: 'an ISO time with offset (the bridge clamps it to 12 hours from now) or null to turn it off',
      value: IsoTs.nullable(),
      whenAbsent: null,
      show: (v) => (v === null || v === undefined ? 'off' : String(v)),
    },
    default: null,
  },
  'work.enabled': {
    phone: 'leaf',
    agent: false,
    risk: 'high',
    refusedByName: true,
    default: [],
  },
  'work.thread': { phone: 'leaf', agent: false, risk: 'high', refusedByName: true, default: undefined },
  'work.label': {
    phone: 'leaf',
    agent: true,
    risk: 'low',
    agentRule: { label: 'Work section name', phrase: 'the work section name', hint: '1-40 chars', value: Plain(1, 40) },
    default: 'Work systems',
  },
  'work.ask_note': {
    phone: 'leaf',
    agent: true,
    risk: 'low',
    agentRule: { label: 'Work note', phrase: 'the work note', hint: '1-120 chars', value: Plain(1, 120) },
    default: 'Ask your IT team before connecting these.',
  },
  'work.retention': {
    phone: 'leaf',
    agent: false,
    risk: 'high',
    refusedByName: true,
    default: 'passthrough',
  },
  permission_relay: {
    phone: 'leaf',
    agent: false,
    risk: 'mac',
    refusedByName: true,
    default: false,
  },
  session_models: {
    phone: 'leaf',
    agent: true,
    risk: 'low',
    agentRule: {
      label: 'Model list',
      phrase: 'the model list',
      hint: `1 to ${MAX_SESSION_MODELS} model aliases or ids, like ["default","opus","sonnet","haiku"]`,
      value: ModelList,
      show: (v) => (Array.isArray(v) ? v.join(', ') : String(v)),
    },
    default: ['default', 'opus', 'sonnet', 'haiku'],
  },
  // The phone may only turn it off (a lost phone must not open the memory); the agent turns it either way when the owner asks.
  memory_browser: {
    phone: 'leaf',
    agent: true,
    risk: 'low',
    agentRule: {
      label: 'Memory browser',
      phrase: 'the memory browser',
      hint: 'true or false',
      value: z.boolean(),
      show: onOff,
    },
    phoneOffOnly: MEMORY_BROWSER_OFF_ONLY,
    default: true,
  },
  // How long downloaded attachments stay on this computer. The app asks before it shortens the time, and the bridge waits an hour
  // after a change before it removes anything, whoever made it.
  media_keep_days: {
    phone: 'leaf',
    agent: true,
    risk: 'low',
    agentRule: {
      label: 'Keep attachments',
      phrase: 'how long attachments are kept',
      hint: '1-3650 days, or null to keep them for good',
      value: z.number().int().min(1).max(3650).nullable(),
      // the file says null for "for good"; read as null so a card's old value matches what is there
      whenAbsent: null,
      show: (v) => (v === null || v === undefined ? 'for good' : `${String(v)} days`),
    },
    default: null,
  },
  // "Lock Talos settings": the agent may turn it ON when asked (true is the only value it may propose); only the owner turns it
  // off, from the app or at the computer. On, the agent changes nothing itself (config-propose/service.ts).
  // "Always allow" (always-allow.ts): the owner's, from a card's third button or Settings (a signed tap). Through the agent, ADDING
  // a kind is always a one-tap card "Always allow <kind>" (a standing grant to send or pay as him: never from the two-hour window,
  // Pantheon 2026-11-14); REMOVING one is made at once when he asks. The agent names kinds; the bridge writes the entries.
  always_allow: {
    phone: 'leaf',
    agent: true,
    risk: 'high',
    agentRule: {
      label: 'Always allowed',
      phrase: 'which kinds of sending are always allowed',
      hint: `a list of kinds from ${SEND_KINDS.join(', ')}; [] for none`,
      value: z.array(z.enum(SEND_KINDS)).max(SEND_KINDS.length),
      read: (c) => (c.always_allow ?? []).map((e) => e.kind),
      patch: (v) => ({ always_allow: [...new Set(v as string[])].map((kind) => ({ kind, destination: null })) }),
      show: (v) => (Array.isArray(v) && v.length ? v.join(', ') : 'none'),
    },
    default: [],
  },
  // Developer: the thread fence (dev.ts DEV_ROWS; owner ruling 2026-11-15). The owner turns it off or on in Settings → Developer
  // (a signed tap), or asks the agent: off is made at once only when he asked in his own words and the lock is off (otherwise a
  // card); a thread's own session can never name it (it may only change its own thread). Takes effect at each session's next start.
  'dev.thread_fence': {
    phone: 'leaf',
    agent: true,
    risk: 'high',
    agentRule: {
      label: 'Thread fence',
      phrase: 'the thread fence (developer)',
      hint: 'true (on: thread sessions cannot read the Talos home) or false (off: they can, from their next start)',
      value: z.boolean(),
      show: onOff,
    },
    default: true,
  },
  // Developer: the notes lookup for thread sessions (dev.ts DEV_ROWS). Turning it off opens nothing, so it is a low-risk change the
  // agent makes when asked, like the memory browser's switch.
  'dev.note_lookup': {
    phone: 'leaf',
    agent: true,
    risk: 'low',
    agentRule: {
      label: 'Notes that may matter',
      phrase: 'the notes lookup for thread sessions (developer)',
      hint: 'true (on: thread sessions are pointed at notes a message names) or false (off: no pointers)',
      value: z.boolean(),
      show: onOff,
    },
    default: true,
  },
  settings_lock: {
    phone: 'leaf',
    agent: true,
    risk: 'low',
    agentRule: {
      label: 'Lock Talos settings',
      phrase: 'the settings lock (on only)',
      hint: 'true; only the owner turns it off',
      value: z.literal(true),
      show: onOff,
    },
    default: false,
  },
  // The master switch for a thread's own session. The path is `dedicated`, the value a boolean: only `enabled` is written, so
  // the limits (`max_live`, the governor) stay. Turning it on lets threads start sessions that use the owner's plan: a card every time.
  dedicated: {
    phone: 'leaf',
    agent: true,
    risk: 'high',
    agentRule: {
      label: 'Thread sessions',
      phrase: 'thread sessions',
      hint: 'true to let threads have their own sessions, false to turn them all off',
      value: z.boolean(),
      show: onOff,
      // as the owner sees it (on until written off): the agent and Settings agree
      read: (c) => threadSessionsAllowed(c),
      patch: (v) => ({ dedicated: { enabled: v } }),
    },
    default: undefined,
  },
  // The applied theme: a stock id picked in Settings, or a custom theme the agent proposed and the owner approved on a card
  // (null over the patch = back to talos). Asked for, it is applied at once (applying it is the preview) and the undo names
  // "reset the theme"; not asked for, its card shows him a preview first.
  theme: {
    phone: 'leaf',
    agent: true,
    risk: 'high',
    agentRule: {
      label: 'Colour theme',
      phrase: 'the app theme',
      hint: 'a whole custom theme object, see the talos-theme skill: only the allowed tokens, typed values and readable contrast; applied at once when the owner asked for it, else a card with a preview',
      value: ThemeValue,
      whenAbsent: 'talos',
      show: (v) => (typeof v === 'string' ? v : `custom "${(v as { name?: string } | null)?.name ?? '?'}"`),
    },
    default: undefined,
  },
  // The owner, not the agent: a signed tap in the app turns it on or off (no passkey since 2026-11-14), and
  // `talos-app trust on|off` still works at the computer. A proposal from the agent is refused by name.
  trust_mode: {
    phone: 'leaf',
    agent: false,
    risk: 'mac',
    refusedByName: true,
    default: undefined,
  },
  // Where the relay announces a new bug report. Off when absent. The owner's: set at the computer or in the app's Settings (a
  // signed tap; no passkey since 2026-11-14), and never by the agent (refused by name).
  // `devices: false`: the URL may carry a token, so the relay uses it and never hands it back to a phone or the web app; they
  // see `bug_webhook_host` instead. The relay checks the address before it takes the patch (bug-reports.ts checkWebhookUrl).
  bug_webhook_url: {
    phone: 'leaf',
    agent: false,
    risk: 'mac',
    refusedByName: true,
    devices: false,
    default: undefined,
  },
  // Derived by the relay for devices: the host of `bug_webhook_url`. Nobody sets it.
  bug_webhook_host: {
    phone: false,
    agent: false,
    risk: 'mac',
    default: undefined,
  },
  // Linked agents: the owner's other installs (peer.ts). Set at the computer only (never from a phone, never by the agent). `devices:
  // false`: each URL may carry a token, so the relay uses it and never hands it back. No stand-in is sent: devices need no names yet.
  peers: {
    phone: false,
    agent: false,
    risk: 'mac',
    refusedByName: true,
    devices: false,
    default: [],
  },
} as const)

/**
 * The webhook's host as devices may see it: a label that could be the receiver's secret (16 characters or more, or 6 digits or
 * more, as in `eo1a2b3c4d5e6f7.m.pipedream.net`) is shown as `…`, so "hooks.example.com" stays readable and a token does not.
 */
export function shownWebhookHost(hostname: string): string {
  const labels = hostname.split('.').map((l) => (l.length >= 16 || (l.match(/\d/g)?.length ?? 0) >= 6 ? '…' : l))
  return labels.filter((l, i) => !(l === '…' && labels[i - 1] === '…')).join('.')
}

/** Settings paths the relay keeps to itself (`devices: false` rows). */
const DEVICE_HIDDEN: readonly string[] = Object.entries(SETTINGS_TABLE as Record<string, { devices?: false }>)
  .filter(([, r]) => r.devices === false)
  .map(([p]) => p)

/**
 * The config as phones and the web app may see it: a copy without the settings marked `devices: false`. The relay calls this where
 * it builds `ready` and where it stores and sends `config.sync`; its own copy (`agentConfig()`) keeps the full value.
 */
export function stripDeviceHidden<T extends object>(config: T): T {
  if (DEVICE_HIDDEN.length === 0) return config
  const out = { ...config } as Record<string, unknown>
  // the bug webhook's host, never its URL (whose path may be the token): "reports go to hooks.example.com"
  delete out.bug_webhook_host
  const hook = out.bug_webhook_url
  if (typeof hook === 'string')
    try {
      out.bug_webhook_host = shownWebhookHost(new URL(hook).hostname)
    } catch {
      // not a URL: shown as off
    }
  for (const path of DEVICE_HIDDEN) {
    const [top, sub] = path.split('.') as [string, string | undefined]
    if (sub === undefined) delete out[top]
    else if (typeof out[top] === 'object' && out[top] !== null) {
      const section = { ...(out[top] as Record<string, unknown>) }
      delete section[sub]
      out[top] = section
    }
  }
  return out as T
}

/** The thread fields whose change is a `setting.changed` event; name and archived have events of their own. */
export const THREAD_SETTING_EVENT_FIELDS = ['topic', 'icon', 'notify', 'session'] as const

/** The fields of one thread the agent may change, and what the thread-scoped paths `threads.<id>.<field>` mean. */
export const THREAD_FIELDS = [
  'name',
  'topic',
  'icon',
  'notify',
  'session',
  'archived',
  'parent',
  'idle_park_min',
] as const
export type ThreadField = (typeof THREAD_FIELDS)[number]

export type ThreadFieldRow = {
  /** `high`: how much it matters (marked on its card); asked for, it is made at once like a low one. */
  readonly risk: 'low' | 'high'
  /** `label` is the field's name in "Thread trip name: Trip → Travel"; the value rules, words and hint are the same kind as a row's. */
  readonly rule: AgentRule
  /**
   * A value or a thread that makes a `low` field high: a change for which `when` is true is high. `phrase`
   * is how the agent is told ("turning a thread's alerts off").
   */
  readonly alsoHigh?: {
    readonly phrase: string
    readonly when: (value: unknown, config: AgentConfigT, threadId: string) => boolean
  }
  /** The value now on the thread; what the card shows as old. */
  readonly read: (t: ThreadT) => unknown
  /**
   * The keys to put on the thread for a new value (`null` clears a key; a threads patch drops it). `t` is the thread as it is now,
   * for a field inside an object of the thread (`session_opts`), whose other keys must stay.
   */
  readonly set: (v: unknown, t?: ThreadT) => Record<string, unknown>
}

/**
 * Per-thread operations, with their risk. Name, topic, icon and alerts are low; a thread's own session, archiving it and putting
 * it under another thread are high (a session uses the owner's plan; archiving keeps the thread's inbox copies; a sub-thread takes
 * its parent's folder, model and MCP list).
 */
export const THREAD_FIELD_RULES: Readonly<Record<ThreadField, ThreadFieldRow>> = {
  name: {
    risk: 'low',
    rule: { label: 'name', phrase: 'thread names', hint: '1-40 chars', value: Plain(1, 40) },
    read: (t) => t.name,
    set: (v) => ({ name: v }),
  },
  topic: {
    risk: 'low',
    rule: {
      label: 'topic',
      phrase: 'thread topics',
      hint: `the "what goes here" line, up to ${THREAD_TOPIC_MAX} chars, "" to clear it`,
      value: Plain(0, THREAD_TOPIC_MAX),
      show: none,
    },
    read: (t) => t.topic ?? '',
    set: (v) => ({ topic: v === '' ? null : v }),
  },
  icon: {
    risk: 'low',
    rule: {
      label: 'icon',
      phrase: 'thread icons',
      hint: 'an icon key or one emoji, up to 16 chars, "" to clear it',
      value: Plain(0, 16),
      show: none,
    },
    read: (t) => t.icon ?? '',
    set: (v) => ({ icon: v === '' ? null : v }),
  },
  notify: {
    risk: 'low',
    rule: {
      label: 'alerts',
      phrase: 'thread alerts',
      hint: '"all", "needs_you" or "off"',
      value: z.enum(['all', 'needs_you', 'off']),
    },
    // A thread on 'off' gets no push at all, approval-card pushes included (relay push.ts `thread_off`; security notices and health
    // alarms are system templates and still arrive). So 'off' is high, and so is any change to the default thread's alerts, where
    // the approval cards land.
    alsoHigh: {
      phrase: "turning a thread's alerts off or changing the default thread's alerts",
      when: (v, c, id) => v === 'off' || id === c.default_thread,
    },
    read: (t) => t.notify,
    set: (v) => ({ notify: v }),
  },
  session: {
    risk: 'high',
    rule: {
      label: 'own session',
      phrase: 'thread sessions',
      hint: '"dedicated" (its own Claude Code session) or "shared" (the main session answers)',
      value: z.enum(['shared', 'dedicated']),
    },
    read: (t) => t.session ?? 'shared',
    set: (v) => ({ session: v }),
  },
  archived: {
    risk: 'high',
    rule: {
      label: 'archived',
      phrase: 'archiving threads',
      hint: 'true to archive an agent-made thread (never the default thread), false to bring it back',
      value: z.boolean(),
      show: (v) => (v === true ? 'yes' : v === false ? 'no' : String(v)),
    },
    read: (t) => t.archived,
    set: (v) => ({ archived: v }),
  },
  parent: {
    risk: 'high',
    rule: {
      label: 'under',
      phrase: 'putting a thread under another thread or taking it out',
      hint: 'the id of a top-level thread to put it under (sub-threads go one level deep), or null to take it out',
      value: ThreadId.nullable(),
      show: (v) => (v === null ? 'no thread (top level)' : String(v)),
    },
    read: (t) => t.parent_id ?? null,
    set: (v) => ({ parent_id: v }),
  },
  // How long a thread's own session may sit idle before it is parked (Pantheon 2026-11-15, with the dev panel). Only this key of
  // session_opts is written; the folder, model and MCP list stay as they are.
  idle_park_min: {
    risk: 'low',
    rule: {
      label: 'idle minutes before parking',
      phrase: "how long a thread's own session idles before it is parked",
      hint: `5-720 minutes (default ${DEFAULT_IDLE_PARK_MIN})`,
      value: z.number().int().min(5).max(720),
      show: (v) => `${String(v)} min`,
    },
    read: (t) => t.session_opts?.idle_park_min ?? DEFAULT_IDLE_PARK_MIN,
    set: (v, t) => ({ session_opts: { ...(t?.session_opts ?? {}), idle_park_min: v } }),
  },
}

/** Whether a thread may have its own session, in the words a refusal uses; null when it may. */
export function sessionRefusal(config: AgentConfigT, threadId: string): string | null {
  return canBeDedicated(config, threadId)
    ? null
    : `thread ${threadId} can't have its own session: the default thread, general, inbox and archived threads are always shared`
}

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

/**
 * Options inside `threads[].session_opts`. The rows above are config paths; `threads` is one leaf there, so a per-thread
 * option gets its row here, in the same file. `phone: false` and `agent: false` mean the owner sets it on the Mac only
 * (by hand in config.json): `threadOptsIssue` refuses any `config.patch`, phone, app or agent card, that turns it on, while
 * turning it off or sending the saved value back (Settings does, on any other edit) is fine. `risk: 'mac'` is the same word the
 * rows above use for a setting the agent never sets: an option that opens something a thread session is fenced from is the owner's, at the Mac.
 */
export const THREAD_SESSION_OPT_ROWS = {
  /** The thread's own session may run `talos-app errors list` and `errors show`, and nothing else (apps/bridge worker/cli-refusal.ts). */
  ops_read: { phone: false, agent: false, risk: 'mac', default: false },
} as const satisfies Record<string, { phone: false; agent: false; risk: 'high' | 'mac'; default: boolean }>

/**
 * Registry view: the per-thread options that open something a session is fenced from (`high` or `mac`), as setting paths (`threads.session_opts.<key>`). A risk table or app-control check reads these with the views derived from `SETTINGS_TABLE`.
 */
export const HIGH_RISK_SETTING_PATHS: readonly string[] = Object.entries(THREAD_SESSION_OPT_ROWS)
  .filter(([, r]) => (['high', 'mac'] as readonly string[]).includes(r.risk))
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
 * path; any other is named by its top-level field. The per-thread Mac-only options (`HIGH_RISK_SETTING_PATHS`, today
 * `threads.session_opts.ops_read`) are named by their full path.
 */
export const AGENT_REFUSED_NAMES: readonly string[] = unique([
  ...rows
    .filter(([, r]) => r.refusedByName)
    .map(([path]) => (rows.some(([p, r]) => r.agent && topOf(p) === topOf(path)) ? path : topOf(path))),
  ...HIGH_RISK_SETTING_PATHS,
])

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
    if (!(SETTING_RISKS as readonly string[]).includes(r.risk)) out.push(`${path}: risk must be low, high or mac`)
    if (r.agent && (r.risk as string) === 'mac')
      out.push(`${path}: a mac row is never proposed by the agent, so it cannot be agent: true`)
    if (sectionsOpen.has(topOf(path)) && r.phone !== 'section')
      out.push(`${path}: its section is open to the phone as a whole, so this row must be phone: 'section'`)
    if (r.phoneOffOnly !== undefined && dotted) out.push(`${path}: phoneOffOnly is only read on top-level rows`)
  }
  return out
}

/** The agent's rule for each setting it may propose. A record over `AgentSettingPath`, so a missing rule cannot be written. */
export const AGENT_RULES = Object.fromEntries(
  rows.filter(([, r]) => r.agent).map(([p, r]) => [p, r.agentRule]),
) as unknown as Readonly<Record<AgentSettingPath, AgentRule>>

/** The value now in `config` at a setting path (`a.b` reads `config.a.b`), or the row's `whenAbsent` when the file has none. */
export function readSettingValue(config: AgentConfigT, path: AgentSettingPath): unknown {
  const read = AGENT_RULES[path].read
  if (read) return read(config)
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

/** The paths a proposal may name, with the value each takes: the agent rows, and for threads the per-thread forms. */
const PATH_FORMS: Array<{ form: string; hint: string }> = AGENT_SETTING_PATHS.flatMap((p) =>
  p === 'threads'
    ? [
        { form: 'threads.<new_id>', hint: AGENT_RULES.threads.hint },
        ...THREAD_FIELDS.map((f) => ({ form: `threads.<id>.${f}`, hint: THREAD_FIELD_RULES[f].rule.hint })),
      ]
    : [{ form: p, hint: AGENT_RULES[p].hint }],
)

/** The value rules in the tool's argument text: "agent.name (1-32 chars), agent.voice (one of ...), ...". */
export const AGENT_VALUE_HINTS: string = PATH_FORMS.map((f) => `${f.form} (${f.hint})`).join(', ')

/** The paths a proposal may name, as the tool lists them. */
export const AGENT_PATH_FORMS: readonly string[] = PATH_FORMS.map((f) => f.form)

/**
 * The words of every high agent row and thread field (what matters most; kept for the docs and tests),
 * for the tool's description. Built from the risk column, so a row that turns high shows up here without anyone editing text.
 */
export const AGENT_ALWAYS_CARD_PHRASE: string = (() => {
  const words = unique([
    ...AGENT_SETTING_PATHS.filter((p) => p !== 'threads' && SETTINGS_TABLE[p].risk === 'high').map(
      (p) => AGENT_RULES[p].phrase,
    ),
    ...AGENT_SETTING_PATHS.flatMap((p) => AGENT_RULES[p].alsoHigh?.phrase ?? []),
    ...THREAD_FIELDS.filter((f) => THREAD_FIELD_RULES[f].risk === 'high').map((f) => THREAD_FIELD_RULES[f].rule.phrase),
    ...THREAD_FIELDS.flatMap((f) => THREAD_FIELD_RULES[f].alsoHigh?.phrase ?? []),
  ])
  return words.length < 2 ? words.join('') : `${words.slice(0, -1).join(', ')} and ${words[words.length - 1]}`
})()

/**
 * The setting names an event may carry (`setting.changed`): every table path but the thread list, plus `threads.<field>` for the
 * per-thread fields that have no event of their own (a name is `thread.renamed`, archiving is `thread.archived`). Names, never values.
 */
export const SETTING_EVENT_KEYS = [
  ...(Object.keys(SETTINGS_TABLE) as SettingPath[]).filter((p) => p !== 'threads'),
  ...THREAD_SETTING_EVENT_FIELDS.map((f) => `threads.${f}`),
] as unknown as readonly [string, ...string[]]
