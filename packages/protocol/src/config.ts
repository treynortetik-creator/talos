import { z } from 'zod'
import { IntegrationId, IsoTs, ThreadId } from './ids.ts'
import { Thread } from './models.ts'
import { STOCK_THEME_IDS, type Theme, validateTheme } from './theme.ts'
import { DedicatedConfig } from './thread-sessions.ts'

export function isIanaZone(zone: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: zone })
    return true
  } catch {
    return false
  }
}

export const HHMM = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/)

/** A `/model` argument: an alias (`opus`, `sonnet[1m]`) or a model id. Never anything a shell or parser could misread. */
export const ModelValue = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._[\]-]{0,79}$/)

/** How many models the picker may offer (`session_models`). */
export const MAX_SESSION_MODELS = 12

/** A custom theme in the file: the same validator the bridge and the app use, and a fresh copy comes out. */
const CustomTheme = z.unknown().transform((v, ctx): Theme => {
  const r = validateTheme(v)
  if (r.ok) return r.theme
  ctx.addIssue({ code: 'custom', message: r.error })
  return z.NEVER
})

export const AgentConfig = z.object({
  version: z.literal(1),
  rev: z.number().int().nonnegative(), // bumped on every write; optimistic concurrency
  agent: z.object({
    name: z.string().min(1).max(32).default('Talos'),
    voice: z.string().max(32).default('meridian'), // GPT-Live stock voice id; changeable in Settings -> Voice
    voice_persona: z.string().max(4000).default(''), // injected into the live-voice prompt
  }),
  owner: z.object({ display_name: z.string().min(1).max(40).default('You') }),
  threads: z.array(Thread).min(1).max(40), // must contain the system thread 'inbox'
  default_thread: ThreadId, // fallback for proactive messages when no thread matches (4.4)
  timezone: z.string().refine(isIanaZone), // e.g. 'UTC'
  quiet_window: z.object({ start: HHMM, end: HHMM }).nullable().default(null), // a merge-patch null deletes the key, so absent must parse as off; local to `timezone`; may wrap midnight
  notifications: z.object({
    master: z.boolean().default(true),
    show_thread_names: z.enum(['fixed_only', 'all', 'none']).default('fixed_only'),
  }),
  work: z.object({
    label: z.string().max(40).default('Work systems'),
    ask_note: z.string().max(120).default('Ask your IT team before connecting these.'),
    // work integrations the owner switched on. Read leniently: an id this build does not know (a newer peer added one) is dropped,
    // so one new id never costs a whole config frame. Writing stays strict (`checkConfigPatch` refuses an unknown id).
    enabled: z
      .array(z.unknown())
      .transform((a) => a.filter((x): x is z.infer<typeof IntegrationId> => IntegrationId.safeParse(x).success))
      .default([]),
    thread: ThreadId.optional(), // where work events land; falls back to 'inbox'
    retention: z.enum(['passthrough', 'buffer']).default('passthrough'),
  }),
  voice_notes: z.object({
    reply_with_voice: z.enum(['when_voice', 'always', 'never']).default('when_voice'),
    /** Driving mode (docs/V2-FEATURES.md V4.1): every reply is spoken until then. The bridge clamps it to now + 12 h. */
    driving_until: IsoTs.nullable().default(null),
  }),
  // Claude Code integration (docs/CLAUDE-CODE.md C3, C4.4, C4.6). All default to the closed setting; `talos-app init` writes the relay on for a fresh install.
  /** Declare `claude/channel/permission` so tool prompts become permission cards. Read at bridge start. */
  permission_relay: z.boolean().default(false),
  /** The model picker's list; a `/model` value outside it is refused (`model_not_allowed`). */
  session_models: z.array(ModelValue).min(1).max(MAX_SESSION_MODELS).default(['default', 'opus', 'sonnet', 'haiku']),
  /**
   * Memory browser kill switch (docs/V2-FEATURES.md V5.1). The browser is on iff `memory.json.enabled && memory_browser`.
   * Over `config.patch` the bridge accepts `false` only; `true` comes from the Mac (`talos-app memory on`).
   */
  memory_browser: z.boolean().default(true),
  /** Option C (docs/OPTION-C.md): the master switch and limits for per-thread sessions. Absent = off. */
  dedicated: DedicatedConfig.optional().catch(undefined),
  /**
   * The theme the owner applied, the same on every device: a stock id (`talos`, `paper`, `hearth`) or a whole custom theme
   * the agent drafted and the owner tapped Apply on. Absent, or any other value (a custom theme that fails validation), means
   * `talos`. An older bridge drops the key when it reads the file. theme.json in the agent folder is a draft, never read as this.
   */
  theme: z
    .union([z.enum(STOCK_THEME_IDS), CustomTheme])
    .optional()
    .catch(undefined),
  /**
   * Trust mode (docs/SECURITY.md "Trust mode"). Absent or anything but `true` = off, the public default. Written by
   * the owner only: `talos-app trust on|off` on the Mac, or a signed `config.patch` from the app (off is free; on needs the
   * passkey step-up, checked by the relay). No agent proposal can write it. On, the owner's own words are trusted further: fewer cards and fewer passkey steps.
   */
  trust_mode: z.boolean().optional().catch(undefined),
})
export type AgentConfigT = z.infer<typeof AgentConfig>

/**
 * TODO(2026-11-04): drop this after the next release. The Telegram mirror is gone, but the previous web bundle and relay
 * still REQUIRE a top-level `mirror` in AgentConfig and reject the whole ready/config.sync without it. So for one release
 * every frame that carries a config SENDS `mirror: {telegram: 'off'}`. config.json never stores it and nothing reads it.
 */
export function withLegacyMirror<T extends object>(config: T): T & { mirror: { telegram: 'off' } } {
  return { ...config, mirror: { telegram: 'off' } }
}

/** True only when the owner switched trust mode on at the Mac. Every rule that relaxes a check asks this one function. */
export function trustOn(config: { trust_mode?: boolean | undefined } | null | undefined): boolean {
  return config?.trust_mode === true
}

/** Validates the structural rules the schema cannot express (inbox thread present, default/work thread exist). */
export function validateAgentConfig(config: AgentConfigT): string[] {
  const issues: string[] = []
  const ids = new Set(config.threads.map((t) => t.id))
  if (!ids.has('inbox')) issues.push("threads must contain the system thread 'inbox'")
  if (!ids.has(config.default_thread)) issues.push('default_thread is not a configured thread')
  if (config.work.thread && !ids.has(config.work.thread)) issues.push('work.thread is not a configured thread')
  if (ids.size !== config.threads.length) issues.push('duplicate thread ids')
  return issues
}

/**
 * The passkey rule for a card the bridge mints. Trust mode off: whatever the caller asked for. On: only money (a
 * `purchase` card) needs the passkey; every other kind is low. A payment filed under another kind (`generic`) is not
 * caught here; that gap is named in docs/SECURITY.md.
 */
export function riskForTrust(trust: boolean, kind: string, requested: 'low' | 'high'): 'low' | 'high' {
  if (!trust) return requested
  return kind === 'purchase' ? 'high' : 'low'
}
