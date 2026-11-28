import { z } from 'zod'
import { AlwaysAllowList } from './always-allow.ts'
import { HttpsUrl, IntegrationId, IsoTs, ThreadId } from './ids.ts'
import { cardKindFacts, Thread } from './models.ts'
import { NyxUrl } from './nyx.ts'
import { PEER_MAX, PeerConfig, type PeerConfigT } from './peer.ts'
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

/**
 * The default of `auto_continue_at_limit`, in one place. On matches what Claude Code does with no setting (it reads a missing key as
 * on), so a user who never touches it keeps today's behaviour. Flip this one constant to change the default everywhere.
 */
export const AUTO_CONTINUE_AT_LIMIT_DEFAULT = true
/** The one default for message text in notifications (the owner's ruling: on): the Mac setting for browsers and the iPhone app's Turn on tap both read it from here. */
export const PUSH_TEXT_DEFAULT = true

export const AgentConfig = z.object({
  version: z.literal(1),
  rev: z.number().int().nonnegative(), // bumped on every write; optimistic concurrency
  agent: z.object({
    name: z.string().min(1).max(32).default('Talos'),
    // archived: voice input (docs/archived/voice.md). Old files may still carry `voice` and `voice_persona` here: a key this
    // schema does not name is dropped on read, so they are accepted and ignored.
  }),
  owner: z.object({ display_name: z.string().min(1).max(40).default('You') }),
  threads: z.array(Thread).min(1).max(40), // must contain the system thread 'inbox'
  default_thread: ThreadId, // fallback for proactive messages when no thread matches (4.4)
  timezone: z.string().refine(isIanaZone), // e.g. 'UTC'
  quiet_window: z.object({ start: HHMM, end: HHMM }).nullable().default(null), // a merge-patch null deletes the key, so absent must parse as off; local to `timezone`; may wrap midnight
  notifications: z.object({
    master: z.boolean().default(true),
    show_thread_names: z.enum(['fixed_only', 'all', 'none']).default('fixed_only'),
    /** A browser reply push carries a one-line preview of the reply (on by default; off gives the fixed text). Browsers only. */
    web_message_text: z.boolean().default(PUSH_TEXT_DEFAULT),
  }),
  /**
   * Where the owner's Nyx lives, the memory service Talos links out to. Absent = not connected, the public default (no address is
   * ever shipped). Set by the owner in the app's Memory screen; the agent cannot write it. Talos keeps only the address (https
   * only) and holds no Nyx credentials. An address that is not an https URL reads as not connected.
   */
  memory: z
    .object({ nyx_url: NyxUrl.optional().catch(undefined) })
    .default({})
    .catch({}),
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
    // 'when_voice' ("when I send a voice note") is archived with voice input: still accepted, read as 'never' (docs/archived/voice.md).
    reply_with_voice: z.enum(['when_voice', 'always', 'never']).default('never'),
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
  /**
   * How long this Mac keeps message attachments it downloaded (`md_*` in the media folder), in days; null keeps them for good
   * (the default). Set from the phone or the Mac, or by the agent when the owner asks it to. A file still in use (a send not yet
   * taken, an open card, a retry) is never removed, and nothing is removed in the hour after the setting changes.
   */
  media_keep_days: z.number().int().min(1).max(3650).nullable().default(null),
  /**
   * "Lock Talos settings" (owner ruling 2026-11-14). Off (the default): the agent changes a setting when the owner asks it to, and
   * tells him at once how to undo it. On: the agent changes nothing itself; a change it proposes is a card. The agent may turn it on
   * when asked; only the owner turns it off, from the app or at the computer.
   */
  settings_lock: z.boolean().default(false),
  /**
   * Developer settings (owner ruling 2026-11-15; dev.ts DEV_ROWS is the page). `thread_fence`: on (the default, and a fresh
   * install's), a thread's own session and its sub-agents cannot read or write the Talos home; off, they get the same access Main has,
   * from their next start. `note_lookup`: on (the default), an owner message that names one of his notes reaches a thread's own
   * session with a pointer to it; off, no pointer (nothing else changes). Anything unreadable here reads as the default.
   */
  dev: z
    .object({
      thread_fence: z.boolean().default(true).catch(true),
      note_lookup: z.boolean().default(true).catch(true),
    })
    .default({ thread_fence: true, note_lookup: true })
    .catch({ thread_fence: true, note_lookup: true }),
  /**
   * "Extra lock on protected files" (opt-in OS sandbox, docs/SECURITY.md "OS sandbox"). Absent or anything but `true` = off, the
   * default: no launch changes. On, Main and every thread session start inside Claude Code's own sandbox, so the files that guard the
   * Talos home cannot be changed by any command however it is written. The agent may turn it on or off when the owner asks, like the
   * other guard switches (a card while "Lock Talos settings" is on).
   */
  os_sandbox: z.boolean().optional().catch(undefined),
  /** "Always allow": the send kinds sent without a card (always-allow.ts). An unreadable list is no list. */
  always_allow: AlwaysAllowList.default([]).catch([]),
  /** Option C (docs/OPTION-C.md): the master switch and limits for per-thread sessions. Absent = off. */
  dedicated: DedicatedConfig.optional().catch(undefined),
  /**
   * "Continue at the usage limit": when a session hits a claude.ai usage limit, Claude Code itself waits for the reset and goes on
   * with the task (its own `autoContinueAtUsageLimit` setting, which only ever waits: it never picks usage credits, an upgrade or
   * a plan change). Talos writes this value into each thread session's settings at its start, `true` or `false`, never leaving the
   * key out. Absent or anything but a boolean reads as AUTO_CONTINUE_AT_LIMIT_DEFAULT. Changed from the app or by the agent, no card.
   */
  auto_continue_at_limit: z.boolean().default(AUTO_CONTINUE_AT_LIMIT_DEFAULT).catch(AUTO_CONTINUE_AT_LIMIT_DEFAULT),
  /**
   * The theme the owner applied, the same on every device: a stock id (`talos`, `paper`, `hearth`, `iris`, `harbor`) or a whole custom theme
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
  /**
   * Where the relay tells (a Standard Webhooks call) that a bug report arrived. Absent = off, the public default. Set by the
   * owner, at the Mac or in the app's Settings (with the passkey every time); the agent cannot write it, and phones never
   * read it back (they see `bug_webhook_host`). The signing secret is the relay's `BUG_WEBHOOK_SECRET`,
   * never part of the config the phones receive. Any value that is not an http(s) URL reads as off.
   */
  bug_webhook_url: HttpsUrl.optional().catch(undefined),
  /**
   * What phones and the web app see instead of `bug_webhook_url` (which may carry a token): the host it sends to, put in by
   * the relay (`stripDeviceHidden`) and never read by the Mac. A config.json that has it is ignored for it.
   */
  bug_webhook_host: z.string().max(253).optional().catch(undefined),
  /**
   * Linked agents: the owner's other Talos installs this one may message (peer.ts). Set by the owner at the Mac; the agent cannot
   * write it. The signing SECRET is never in config: the bridge keeps it in its SecretStore. A URL can carry a path token, so
   * the relay never sends this to phones or the web app (`devices: false`, `stripDeviceHidden`). Read leniently: an entry that
   * is not valid is DROPPED (the other peers and the whole config survive; a dropped peer simply is not linked), a repeated
   * name keeps its first entry (the name of a dropped entry stays taken), and entries past PEER_MAX are ignored.
   */
  peers: z
    .array(z.unknown())
    .transform((a) => {
      const seen = new Set<string>()
      const out: PeerConfigT[] = []
      for (const x of a) {
        // the raw name of EVERY entry is reserved, valid or not: a later entry cannot take over the name of one that was dropped
        const raw = typeof x === 'object' && x !== null ? (x as { name?: unknown }).name : undefined
        const taken = typeof raw === 'string' && seen.has(raw)
        if (typeof raw === 'string') seen.add(raw)
        if (taken) continue
        const p = PeerConfig.safeParse(x)
        if (!p.success) continue
        out.push(p.data)
        if (out.length === PEER_MAX) break
      }
      return out
    })
    .default([])
    .catch([]),
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
  return cardKindFacts(kind)?.highRiskUnderTrust ? 'high' : 'low'
}
