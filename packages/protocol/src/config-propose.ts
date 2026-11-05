// O1 (SETTINGS-MAP 3.4): the agent may PROPOSE a change to a short list of settings; the owner approves it on a card and
// the BRIDGE applies it. The agent never writes. Nothing here can be reached by a `config.patch` from an app (that has its
// own, wider rules in the settings table) and nothing here widens it.
//
// The list is leaf level and closed: a path that is not on it is refused, whatever else is true. Devices, keys,
// enrollment and security settings are never on it. The check runs when the agent proposes AND again when the owner's
// approval is applied, on the payload that was bound to the card (what was shown), never on what the agent said later.
import { z } from 'zod'
import { type AgentConfigT, HHMM, isIanaZone } from './config.ts'
import type { CardT } from './models.ts'
import { AGENT_REFUSED_NAMES, AGENT_SETTING_PATHS, type AgentSettingPath } from './settings-table.ts'
import { themeProblems, validateTheme } from './theme.ts'

/** Advertised by a relay whose Card enum knows `kind:'config'`. The bridge mints these cards only against such a relay. */
export const CONFIG_PROPOSE_FEATURE = 'config-propose/1'

/**
 * Advertised by a relay that ships the web build that can preview and apply a `theme` card (K9c). `config-propose/1` alone
 * is not enough: a newer bridge in front of an older relay and web would mint a theme card the app cannot show.
 */
export const CUSTOM_THEMES_FEATURE = 'custom-themes/1'

export const AGENT_CONFIG_ALLOWLIST = AGENT_SETTING_PATHS
export type AgentConfigPath = AgentSettingPath

/**
 * Settings that are refused by name, so the refusal can say so plainly. This is documentation for the agent and the owner,
 * not the gate: the gate is the allowlist above, which refuses everything else too.
 */
export const AGENT_CONFIG_REFUSED = AGENT_REFUSED_NAMES

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

export const MAX_CONFIG_CHANGES = 6

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

/** The value each allowlisted leaf accepts: the same rules the config file applies, one place. */
export const AGENT_CONFIG_VALUE: Record<AgentConfigPath, z.ZodType<unknown>> = {
  'agent.name': Plain(1, 32),
  'agent.voice': z.enum(VOICE_CHOICES),
  'owner.display_name': Plain(1, 40),
  timezone: z.string().max(64).refine(isIanaZone, 'a timezone from the list, like Europe/Paris'),
  quiet_window: QuietWindow,
  'voice_notes.reply_with_voice': z.enum(['when_voice', 'always', 'never']),
  theme: ThemeValue,
}

export const AGENT_CONFIG_LABEL: Record<AgentConfigPath, string> = {
  'agent.name': 'Agent name',
  'agent.voice': 'Live-call voice',
  'owner.display_name': 'Your name',
  timezone: 'Timezone',
  quiet_window: 'Quiet hours',
  'voice_notes.reply_with_voice': 'Voice-note replies',
  theme: 'Colour theme',
}

export function isAgentConfigPath(p: unknown): p is AgentConfigPath {
  return typeof p === 'string' && (AGENT_CONFIG_ALLOWLIST as readonly string[]).includes(p)
}

/**
 * How to read each allowlisted path out of a config (absent quiet window is `null`). A record keyed by the allowlist, so an
 * `agent: true` row with no reader here fails `pnpm typecheck`.
 */
const CONFIG_READER: Record<AgentConfigPath, (config: AgentConfigT) => unknown> = {
  'agent.name': (c) => c.agent.name,
  'agent.voice': (c) => c.agent.voice,
  'owner.display_name': (c) => c.owner.display_name,
  timezone: (c) => c.timezone,
  quiet_window: (c) => c.quiet_window ?? null,
  'voice_notes.reply_with_voice': (c) => c.voice_notes.reply_with_voice,
  theme: (c) => c.theme ?? 'talos',
}

/** The value now in `config` at an allowlisted path. */
export const readConfigPath = (config: AgentConfigT, path: AgentConfigPath): unknown => CONFIG_READER[path](config)

/** The RFC 7386 merge patch for allowlisted changes. It can only ever name allowlisted leaves. */
export function agentConfigPatch(
  changes: ReadonlyArray<{ path: AgentConfigPath; new: unknown }>,
): Record<string, unknown> {
  const patch: Record<string, unknown> = {}
  for (const c of changes) {
    const dot = c.path.indexOf('.')
    if (dot < 0) patch[c.path] = c.new
    else {
      const top = c.path.slice(0, dot)
      const sub = c.path.slice(dot + 1)
      const cur = (patch[top] as Record<string, unknown> | undefined) ?? {}
      cur[sub] = c.new
      patch[top] = cur
    }
  }
  return patch
}

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)

export type ConfigChange = { path: AgentConfigPath; old: unknown; new: unknown }
export type ResolvedChanges = { ok: true; changes: ConfigChange[] } | { ok: false; error: string }

/** Why a path is refused, in words the agent can relay. Anything not on the list gets the same refusal. */
export function refusalFor(path: string): string {
  const top = path.split('.')[0] ?? path
  const named =
    (AGENT_CONFIG_REFUSED as readonly string[]).includes(path) ||
    (AGENT_CONFIG_REFUSED as readonly string[]).includes(top)
  return named
    ? `${path} can't be changed by you. The owner changes it in Settings. Allowed: ${AGENT_CONFIG_ALLOWLIST.join(', ')}.`
    : `${path} is not a setting you may propose. Allowed: ${AGENT_CONFIG_ALLOWLIST.join(', ')}. Devices, keys, enrollment and security settings are never on the list.`
}

/**
 * Validates what the agent asked for against the allowlist and the value rules, and reads the CURRENT value of each (the
 * `old` shown on the card). Pure; used at propose time. `current` is the config on the Mac right now.
 */
export function resolveConfigChanges(raw: unknown, current: AgentConfigT): ResolvedChanges {
  if (!Array.isArray(raw) || raw.length === 0) return { ok: false, error: 'changes must be a list of {path, value}' }
  if (raw.length > MAX_CONFIG_CHANGES)
    return { ok: false, error: `At most ${MAX_CONFIG_CHANGES} settings in one proposal.` }
  const seen = new Set<string>()
  const out: ConfigChange[] = []
  for (const item of raw) {
    const o = item as { path?: unknown; value?: unknown } | null
    if (!o || typeof o !== 'object' || typeof o.path !== 'string' || !('value' in o))
      return { ok: false, error: 'every change needs a path and a value' }
    if (!isAgentConfigPath(o.path)) return { ok: false, error: refusalFor(o.path) }
    if (seen.has(o.path)) return { ok: false, error: `${o.path} is listed twice` }
    seen.add(o.path)
    const parsed = AGENT_CONFIG_VALUE[o.path].safeParse(o.value)
    if (!parsed.success)
      return { ok: false, error: `${o.path}: ${parsed.error.issues[0]?.message ?? 'not a valid value'}` }
    const old = readConfigPath(current, o.path)
    if (same(old, parsed.data)) return { ok: false, error: `${o.path} is already that value. Nothing to propose.` }
    out.push({ path: o.path, old, new: parsed.data })
  }
  return { ok: true, changes: out }
}

/** What a config card binds (the card's `payload`): exactly the changes the owner was shown, and the revision they were drawn on. */
export const ConfigCardPayload = z.strictObject({
  v: z.literal(1),
  base_rev: z.number().int().nonnegative(),
  reason: z.string().max(280),
  changes: z
    .array(
      z.strictObject({
        path: z.enum(AGENT_CONFIG_ALLOWLIST),
        old: z.unknown(),
        new: z.unknown(),
      }),
    )
    .min(1)
    .max(MAX_CONFIG_CHANGES),
})
export type ConfigCardPayloadT = z.infer<typeof ConfigCardPayload>

/**
 * The second check, at apply time, on the BOUND payload: every path still on the allowlist, every new value still valid,
 * and every old value still what the config holds. Returns the changes to write, or why nothing is written.
 */
export function verifyConfigPayload(
  payload: unknown,
  current: AgentConfigT,
):
  | { ok: true; changes: ConfigChange[]; patch: Record<string, unknown> }
  | { ok: false; error: string; stale?: boolean } {
  const p = ConfigCardPayload.safeParse(payload)
  if (!p.success) return { ok: false, error: 'The card could not be read, or names a setting you may not change.' }
  const changes: ConfigChange[] = []
  for (const c of p.data.changes) {
    if (!isAgentConfigPath(c.path)) return { ok: false, error: refusalFor(String(c.path)) } // defence in depth: the enum already refused it
    const v = AGENT_CONFIG_VALUE[c.path].safeParse(c.new)
    if (!v.success) return { ok: false, error: `${c.path} is no longer a valid value.` }
    if (!same(readConfigPath(current, c.path), c.old))
      return {
        ok: false,
        stale: true,
        error: `${AGENT_CONFIG_LABEL[c.path]} changed since this card was drawn, so nothing was changed. Ask again.`,
      }
    changes.push({ path: c.path, old: c.old, new: v.data })
  }
  return { ok: true, changes, patch: agentConfigPatch(changes) }
}

/** One line of a card body: "Agent name: Talos → Atlas". */
export function describeValue(path: AgentConfigPath, v: unknown): string {
  if (path === 'quiet_window') {
    const w = v as { start: string; end: string } | null
    return w ? `${w.start} to ${w.end}` : 'off'
  }
  if (path === 'voice_notes.reply_with_voice')
    return { when_voice: 'when I send a voice note', always: 'always', never: 'never' }[String(v)] ?? String(v)
  if (path === 'theme') return typeof v === 'string' ? v : `custom "${(v as { name?: string } | null)?.name ?? '?'}"`
  return String(v)
}
export const describeChange = (c: ConfigChange): string =>
  `${AGENT_CONFIG_LABEL[c.path]}: ${describeValue(c.path, c.old)} → ${describeValue(c.path, c.new)}`

export type ConfigCardInput = {
  cardId: string
  threadId: string
  now: string
  expiresAt: string
  origin: 'chat' | 'background'
  baseRev: number
  reason: string
  changes: ConfigChange[]
}

/** The card as it is drawn: pending, no editing, revise allowed, old and new of each setting in the body. Hash is set by the caller. */
export function configCardCandidate(i: ConfigCardInput): Omit<CardT, 'payload_hash'> & { payload_hash: string } {
  const one = i.changes.length === 1 ? i.changes[0] : undefined
  const payload: ConfigCardPayloadT = { v: 1, base_rev: i.baseRev, reason: i.reason, changes: i.changes }
  return {
    id: i.cardId,
    thread_id: i.threadId,
    kind: 'config',
    title: one ? `Change ${AGENT_CONFIG_LABEL[one.path].toLowerCase()}` : `Change ${i.changes.length} settings`,
    summary: i.reason.slice(0, 280),
    destination: i.changes.slice(0, 6).map((c) => ({ label: 'Setting', value: AGENT_CONFIG_LABEL[c.path] })),
    body: `${i.changes.map(describeChange).join('\n')}\n\nWhy: ${i.reason}`.slice(0, 20_000),
    body_format: 'plain',
    fields: [],
    attachments: [],
    warning: 'Changes a setting on your Mac. You can change it back in Settings.',
    primary_label: 'Apply',
    kill_label: one?.path === 'theme' ? 'Keep current' : 'Keep settings',
    allow_edit: false,
    allow_revise: true,
    risk: 'low',
    origin: i.origin,
    payload,
    payload_hash: `sha256:${'0'.repeat(64)}`,
    state: 'pending',
    created_at: i.now,
    expires_at: i.expiresAt,
  }
}
