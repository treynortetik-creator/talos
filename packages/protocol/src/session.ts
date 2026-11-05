// Session visibility and control (docs/CLAUDE-CODE.md C2, C4, C7, C8.1). Owned by WP-C0.5: every schema, enum and
// rule the bridge (WP-C1/C2/C3/C7), the mod and the app share. Outbound models are strict; engine data (what the mod
// reads from Claude Code) is parsed leniently by sessionStateFromEngine/inventoryCommandsFromEngine. Every rule fails
// closed: unknown means refused (bridge) or greyed (app).
import { z } from 'zod'
import { ModelValue } from './config.ts'
import { ErrorCode, type ErrorCodeT } from './errors.ts'
import { IsoTs, Sha256Ref, ThreadId, Ulid } from './ids.ts'
import { AgentsSnapshot, type AgentsSnapshotT, isLiveAgentStatus } from './session-agents.ts'

export const CLAUDE_CODE_MIN_VERSION = '2.1.304'
/** Bridge `hello.client.features` entries (echoed in `presence.features`); the app shows nothing without them. */
export const SESSION_FEATURE = 'session/1'
export const PERMISSION_FEATURE = 'permission/1'

export const CONTROL_STALE_MS = 120_000
/** A control stamped further in the future than this is stale too (a wrong phone clock must not stretch the window). */
export const CONTROL_CLOCK_SKEW_MS = 30_000
export const MODEL_SWITCH_TIMEOUT_MS = 15_000
export const SESSIONS_POLL_MS = 15_000
export const MOD_SYNC_INTERVAL_MS = 2_000
/** No sync for this long = no live mod: a new `talos_mod_hello` is allowed (and rotates the key). */
export const MOD_LIVE_WINDOW_MS = 30_000
export const MAX_CONTROL_ARGS = 500

// ---- state and inventory (C2.2) ----------------------------------------------------------------------------------

export const SESSION_CAPABILITIES = [
  'stop',
  'compact',
  'command',
  'clear',
  'model',
  'effort',
  'inventory',
  'permission_close',
  'sessions',
  // docs/SUBAGENTS.md: the agents panel (`$.agent.list()` plus the mod's hooks) and its Stop (`TaskStop` via $.tool.call).
  // Mod -> bridge only: the bridge publishes session.state through wireSessionState(), which drops these two.
  'agents',
  'agent_stop',
] as const
export const SessionCapability = z.enum(SESSION_CAPABILITIES)
export type SessionCapabilityT = z.infer<typeof SessionCapability>
/**
 * The capabilities every published app and relay since C2 knows. Their parser is a strict enum, so a `session.state`
 * listing anything else is refused whole, and so is the `ready` that carries it (an old cached app would never go
 * online). The bridge therefore publishes `session.state` through wireSessionState(), which keeps only these; newer
 * capabilities travel where old peers never look (the agents panel's `agent_stop` rides in `AgentsSnapshot.can_stop`).
 */
export const SESSION_CAPABILITIES_V1 = [
  'stop',
  'compact',
  'command',
  'clear',
  'model',
  'effort',
  'inventory',
  'permission_close',
  'sessions',
] as const satisfies readonly SessionCapabilityT[]
const isKnownCapability = (c: string): c is SessionCapabilityT =>
  (SESSION_CAPABILITIES as readonly string[]).includes(c)
/**
 * Read leniently: a capability this build does not know is dropped (and duplicates collapse), never fatal, so the NEXT
 * capability cannot take a newer app offline the way a strict enum would.
 */
const CapabilityList = z
  .array(z.string().max(40))
  .max(32)
  .default([])
  .transform((xs) => [...new Set(xs.filter(isKnownCapability))])
export const SessionSource = z.enum(['mod', 'hooks', 'statusline', 'agents_json'])

/** Which session a `session.state` describes (docs/OPTION-C.md 9.1). Absent = `main`. */
export const SessionScope = z.union([z.literal('main'), z.strictObject({ thread_id: ThreadId })])
export type SessionScopeT = z.infer<typeof SessionScope>

export const SessionState = z.strictObject({
  session_id: z.string().min(1).max(64),
  scope: SessionScope.optional(),
  source: SessionSource,
  capabilities: CapabilityList,
  version: z.string().max(40).optional(),
  model: z.strictObject({ id: z.string().max(80), display: z.string().max(40).optional() }).optional(),
  effort: z.string().max(16).optional(),
  permission_mode: z.string().max(24).optional(),
  busy: z.boolean().optional(),
  turn_id: z.string().max(64).optional(), // the running turn, for Stop
  compacting: z.boolean().optional(),
  stopped_at_mac: z.boolean().optional(), // "refused until the user's next input"
  context: z
    .strictObject({
      tokens: z.number().int().nonnegative().optional(),
      window: z.number().int().nonnegative().optional(),
      percent: z.number().min(0).max(100).optional(),
    })
    .optional(),
  cost_usd: z.number().nonnegative().optional(), // client-side list-price estimate
  rate_limits: z
    .array(
      z.strictObject({
        kind: z.string().max(24),
        percent: z.number().min(0).max(100).optional(),
        resets_at: IsoTs.optional(),
      }),
    )
    .max(6)
    .default([]),
  surfaces: z.array(z.string().max(24)).max(8).default([]),
  at: IsoTs,
})
export type SessionStateT = z.infer<typeof SessionState>

/** The state as the bridge publishes it in `session.state`: capabilities limited to SESSION_CAPABILITIES_V1. */
export function wireSessionState(state: SessionStateT): SessionStateT {
  const v1: readonly string[] = SESSION_CAPABILITIES_V1
  return { ...state, capabilities: state.capabilities.filter((c) => v1.includes(c)) }
}

export const CommandSource = z.enum(['builtin', 'plugin', 'user', 'mcp'])
export type CommandSourceT = z.infer<typeof CommandSource>
export const CommandRoute = z.enum(['control', 'message', 'local_only'])
export type CommandRouteT = z.infer<typeof CommandRoute>
/** Command names as the engine lists them (`plugin:command` included). */
export const CommandName = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9:_.-]{0,63}$/)

export const InventoryCommand = z.strictObject({
  name: CommandName,
  description: z.string().max(200),
  source: CommandSource,
  plugin: z.string().max(64).optional(),
  route: CommandRoute, // C4.2; computed by routeFor(), never taken from the engine
  /** `disable-model-invocation` skill: it won't run from the phone (C4.3). Absent when the mod can't tell. */
  at_mac_only: z.boolean().optional(),
})
export type InventoryCommandT = z.infer<typeof InventoryCommand>

export const SessionInventory = z.strictObject({
  commands: z.array(InventoryCommand).max(400),
  models: z
    .array(z.strictObject({ value: ModelValue, label: z.string().max(60), note: z.string().max(120).optional() }))
    .max(20),
  efforts: z.array(z.string().max(16)).max(8),
  mcp_servers: z
    .array(
      z.strictObject({ name: z.string().max(64), tools: z.number().int(), status: z.enum(['connected', 'unknown']) }),
    )
    .max(100),
  plugins: z.array(z.strictObject({ name: z.string().max(80), enabled: z.boolean() })).max(200),
  codex: z
    .strictObject({ installed: z.boolean(), version: z.string().max(24).optional(), logged_in: z.boolean().optional() })
    .optional(),
  at: IsoTs,
})
export type SessionInventoryT = z.infer<typeof SessionInventory>

// ---- lenient engine parsing (review #6: "every field optional, .passthrough()") ---------------------------------

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
const str = (v: unknown, max: number): string | undefined =>
  typeof v === 'string' && v.length > 0 && v.length <= max ? v : undefined
const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined)
const bool = (v: unknown): boolean | undefined => (typeof v === 'boolean' ? v : undefined)
const pickDefined = <T extends Record<string, unknown>>(o: T): T =>
  Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as T

/**
 * Builds a SessionState from what the mod read off the engine (`$.session.*`, `$.session.usage()`), tolerating missing
 * and unknown fields and dropping any field of the wrong type or size. Only a missing session id fails.
 */
export function sessionStateFromEngine(
  raw: unknown,
  meta: { source: z.infer<typeof SessionSource>; capabilities: readonly SessionCapabilityT[]; at: string },
): { ok: true; state: SessionStateT } | { ok: false; reason: string } {
  if (!isObj(raw)) return { ok: false, reason: 'engine state is not an object' }
  const id = str(raw.id ?? raw.session_id ?? raw.sessionId, 64)
  if (!id) return { ok: false, reason: 'no session id' }
  const m = raw.model
  const modelId = typeof m === 'string' ? str(m, 80) : isObj(m) ? str(m.id, 80) : undefined
  const usage = isObj(raw.usage) ? raw.usage : {}
  const c = isObj(usage.context) ? usage.context : undefined
  const pct = (v: unknown) => {
    const n = num(v)
    return n !== undefined && n >= 0 && n <= 100 ? n : undefined
  }
  const ctx = c
    ? pickDefined({
        tokens: Number.isInteger(c.tokens) && (c.tokens as number) >= 0 ? (c.tokens as number) : undefined,
        window: Number.isInteger(c.window) && (c.window as number) >= 0 ? (c.window as number) : undefined,
        percent: pct(c.percent),
      })
    : undefined
  // mods reference, `$.session` row: rateLimits is a list of `{ kind, percentUsed, resetsAt }`
  const limits = Array.isArray(usage.rateLimits)
    ? (usage.rateLimits as unknown[])
        .filter(isObj)
        .map((l) => pickDefined({ kind: str(l.kind, 24), percent: pct(l.percentUsed), resets_at: toIsoTs(l.resetsAt) }))
        .filter((l) => typeof l.kind === 'string')
        .slice(0, 6)
    : []
  // The docs name `cost` but not its shape: a number is read as US dollars, anything else is dropped (SMOKE S4).
  const cost = num(usage.cost)
  const surfaces = Array.isArray(raw.surfaces)
    ? (raw.surfaces as unknown[])
        .map((s) => str(s, 24))
        .filter((s): s is string => !!s)
        .slice(0, 8)
    : []
  const display = isObj(m) ? str(m.display ?? m.displayName, 40) : undefined
  const state = pickDefined({
    session_id: id,
    source: meta.source,
    capabilities: [...meta.capabilities],
    version: str(raw.version, 40),
    model: modelId ? pickDefined({ id: modelId, display }) : undefined,
    effort: str(raw.effort, 16),
    permission_mode: str(raw.permissionMode ?? raw.permission_mode, 24),
    busy: bool(raw.busy),
    turn_id: str(raw.turnId ?? raw.turn_id, 64),
    compacting: bool(raw.compacting),
    stopped_at_mac: bool(raw.stoppedAtMac ?? raw.stopped_at_mac),
    context: ctx && Object.keys(ctx).length > 0 ? ctx : undefined,
    cost_usd: cost !== undefined && cost >= 0 ? cost : undefined,
    rate_limits: limits,
    surfaces,
    at: meta.at,
  })
  const parsed = SessionState.safeParse(state)
  return parsed.success ? { ok: true, state: parsed.data } : { ok: false, reason: 'engine state did not fit' }
}

/**
 * A reset time as the engine or the status line gives it: an ISO string, epoch milliseconds, or epoch seconds (the
 * status line's `resets_at`). Anything else is dropped.
 */
export function toIsoTs(v: unknown): string | undefined {
  if (typeof v === 'string') return v.length <= 40 && IsoTs.safeParse(v).success ? v : undefined
  if (v instanceof Date) return Number.isFinite(v.getTime()) ? v.toISOString() : undefined
  if (typeof v !== 'number' || !Number.isFinite(v) || v <= 0) return undefined
  const ms = v < 1e11 ? v * 1000 : v
  const d = new Date(ms)
  return Number.isFinite(d.getTime()) ? d.toISOString() : undefined
}

/**
 * Builds a SessionState from the status line JSON (statusline docs, "Available data"; source 'statusline', no
 * capabilities: the status line can't control anything). Missing windows and fields stay absent.
 */
export function sessionStateFromStatusline(
  raw: unknown,
  meta: { at: string },
): { ok: true; state: SessionStateT } | { ok: false; reason: string } {
  if (!isObj(raw)) return { ok: false, reason: 'status line JSON is not an object' }
  const id = str(raw.session_id, 64)
  if (!id) return { ok: false, reason: 'no session id' }
  const m = isObj(raw.model) ? raw.model : {}
  const cw = isObj(raw.context_window) ? raw.context_window : {}
  const pct = (v: unknown) => {
    const n = num(v)
    return n !== undefined && n >= 0 && n <= 100 ? n : undefined
  }
  const rl = isObj(raw.rate_limits) ? raw.rate_limits : {}
  const limits = Object.entries(rl)
    .filter((e): e is [string, Record<string, unknown>] => isObj(e[1]))
    .map(([kind, w]) =>
      pickDefined({ kind: str(kind, 24), percent: pct(w.used_percentage), resets_at: toIsoTs(w.resets_at) }),
    )
    .filter((l) => typeof l.kind === 'string')
    .slice(0, 6)
  const window = Number.isInteger(cw.context_window_size) ? (cw.context_window_size as number) : undefined
  const ctx = pickDefined({ window, percent: pct(cw.used_percentage) })
  const cost = isObj(raw.cost) ? num(raw.cost.total_cost_usd) : undefined
  const effort = isObj(raw.effort) ? str(raw.effort.level, 16) : undefined
  const modelId = str(m.id, 80)
  const state = pickDefined({
    session_id: id,
    source: 'statusline' as const,
    capabilities: [],
    version: str(raw.version, 40),
    model: modelId ? pickDefined({ id: modelId, display: str(m.display_name, 40) }) : undefined,
    effort,
    context: Object.keys(ctx).length > 0 ? ctx : undefined,
    cost_usd: cost !== undefined && cost >= 0 ? cost : undefined,
    rate_limits: limits,
    surfaces: [],
    at: meta.at,
  })
  const parsed = SessionState.safeParse(state)
  return parsed.success ? { ok: true, state: parsed.data } : { ok: false, reason: 'status line state did not fit' }
}

/** `$.command.list()` rows → inventory commands. Rows without a usable name or a known source are dropped (counted). */
export function inventoryCommandsFromEngine(raw: unknown): { commands: InventoryCommandT[]; dropped: number } {
  if (!Array.isArray(raw)) return { commands: [], dropped: 0 }
  const commands: InventoryCommandT[] = []
  let dropped = 0
  for (const row of raw.slice(0, 1000)) {
    const name = isObj(row) ? row.name : undefined
    const source = isObj(row) ? CommandSource.safeParse(row.source) : undefined
    if (!isObj(row) || !CommandName.safeParse(name).success || !source?.success) {
      dropped++
      continue
    }
    const cmd = {
      name: name as string,
      description: typeof row.description === 'string' ? row.description.slice(0, 200) : '',
      source: source.data,
      route: routeFor({ source: source.data, name: name as string }),
      ...(typeof row.plugin === 'string' && row.plugin.length <= 64 ? { plugin: row.plugin } : {}),
    }
    if (commands.length < 400) commands.push(cmd)
    else dropped++
  }
  // A built-in whose name a skill, plugin command or MCP prompt also uses can't be run from the phone: `$.command.run`
  // takes a name only, so which one runs is the engine's choice (review R3, SMOKE S5). Fail closed: local_only.
  for (const c of commands) if (c.source === 'builtin' && isShadowedBuiltin(commands, c.name)) c.route = 'local_only'
  return { commands, dropped }
}

/** True when `name` is listed as a built-in AND under any other source. */
export function isShadowedBuiltin(commands: readonly { name: string; source: string }[], name: string): boolean {
  return commands.some((c) => c.name === name && c.source !== 'builtin')
}

// ---- command policy (C4.2), keyed on (source, name) ---------------------------------------------------------------

type Grammar = 'none' | 'on_off' | 'model' | 'effort' | 'instructions'

/** The built-ins the phone may run, with each one's argument grammar. Everything else built-in is local_only. */
export const BUILTIN_CONTROL_COMMANDS: Readonly<Record<string, Grammar>> = Object.freeze({
  context: 'none',
  usage: 'none',
  recap: 'none',
  mcp: 'none', // no arguments: `/mcp disable <server>` stays at the Mac
  'reload-plugins': 'none', // `--force` refused
  model: 'model', // C4.4: only from the configured list
  effort: 'effort',
  fast: 'on_off',
  compact: 'instructions', // own action: $.session.compact()
  clear: 'none', // own action, in-app confirm
})
/** Built-ins that are their own `session.control` action instead of `action:'command'`. */
export const OWN_ACTION_COMMANDS = ['compact', 'clear'] as const

export const DEFAULT_SESSION_MODELS = ['default', 'opus', 'sonnet', 'haiku'] as const
/** Levels documented for current models; used when the engine does not list them. `auto` clears (C4.4). */
export const DOCUMENTED_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'] as const

export function routeFor(cmd: { source: string; name: string }): CommandRouteT {
  if (cmd.source === 'builtin') return Object.hasOwn(BUILTIN_CONTROL_COMMANDS, cmd.name) ? 'control' : 'local_only'
  if (cmd.source === 'plugin' || cmd.source === 'user' || cmd.source === 'mcp') return 'message'
  return 'local_only'
}

// C0 and C1 controls, line/paragraph separators and bidi overrides: none of them belong in a command argument.
// biome-ignore lint/suspicious/noControlCharactersInRegex: rejecting control characters is the point
const BAD_ARG = /[\u0000-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069]/
export function argsWellFormed(args: string | undefined): boolean {
  if (args === undefined) return true
  return typeof args === 'string' && args.length <= MAX_CONTROL_ARGS && !BAD_ARG.test(args)
}

export type PaletteContext = {
  inventory: SessionInventoryT | undefined
  /** effectiveModelList(config.session_models, options of the /config model row). */
  allowedModels: readonly string[]
}
type Fail = { ok: false; code: ErrorCodeT; message: string }
export type PalettePlan =
  | { ok: true; kind: 'message'; text: string }
  | { ok: true; kind: 'control'; action: 'compact'; args?: string }
  | { ok: true; kind: 'control'; action: 'clear' }
  | { ok: true; kind: 'control'; action: 'command'; command: string; args?: string }
  | Fail

const fail = (code: ErrorCodeT, message: string): Fail => ({ ok: false, code, message })

/**
 * What a picked `/` command becomes (C4.2, C4.3). The app calls it to build the frame; the bridge calls it again (via
 * checkSessionControl) against the CURRENT inventory before queuing anything.
 */
export function planPaletteRun(pick: { source: string; name: string; args: string }, ctx: PaletteContext): PalettePlan {
  if (!argsWellFormed(pick.args)) return fail('args_invalid', 'Arguments must be one line of up to 500 characters.')
  const args = pick.args.trim()
  const listed = ctx.inventory?.commands.find((c) => c.name === pick.name && c.source === pick.source)
  if (!listed) return fail('command_changed', 'This command changed since the list was loaded. Reload it.')
  const route = routeFor(pick)
  if (route === 'local_only') return fail('command_not_allowed', 'Run this at the Mac.')
  if (route === 'control' && isShadowedBuiltin(ctx.inventory?.commands ?? [], pick.name))
    return fail('command_not_allowed', 'A skill or plugin uses this name too. Run it at the Mac.')
  if (route === 'message') return { ok: true, kind: 'message', text: args ? `/${pick.name} ${args}` : `/${pick.name}` }
  const grammar = BUILTIN_CONTROL_COMMANDS[pick.name] as Grammar
  switch (grammar) {
    case 'none':
      if (args !== '') return fail('args_invalid', `/${pick.name} takes no arguments here.`)
      break
    case 'on_off':
      if (args !== 'on' && args !== 'off') return fail('args_invalid', `/${pick.name} takes on or off.`)
      break
    case 'model':
      if (!ModelValue.safeParse(args).success) return fail('args_invalid', 'Pick a model.')
      if (!ctx.allowedModels.includes(args)) return fail('model_not_allowed', 'That model is not in your model list.')
      break
    case 'effort': {
      const levels: readonly string[] = ctx.inventory?.efforts.length ? ctx.inventory.efforts : DOCUMENTED_EFFORTS
      if (args !== 'auto' && !levels.includes(args)) return fail('args_invalid', 'Pick an effort level.')
      break
    }
    case 'instructions':
      break
  }
  if (pick.name === 'compact')
    return args
      ? { ok: true, kind: 'control', action: 'compact', args }
      : { ok: true, kind: 'control', action: 'compact' }
  if (pick.name === 'clear') return { ok: true, kind: 'control', action: 'clear' }
  return args
    ? { ok: true, kind: 'control', action: 'command', command: pick.name, args }
    : { ok: true, kind: 'control', action: 'command', command: pick.name }
}

export const SessionControlAction = z.enum(['stop', 'compact', 'command', 'clear', 'agent_stop'])
export type SessionControlActionT = z.infer<typeof SessionControlAction>

export type SessionControlCheckInput = {
  action: SessionControlActionT
  ts: string
  turn_id?: string
  command?: string
  /** The source the phone rendered; `action:'command'` is for built-ins only (C4.2: keyed on (source, name)). */
  source?: string
  args?: string
  /** Required for `agent_stop`: the row the phone showed (docs/SUBAGENTS.md). */
  agent_id?: string
}
export type SessionControlCheckContext = {
  now: number
  state: SessionStateT | undefined
  inventory: SessionInventoryT | undefined
  allowedModels: readonly string[]
  /** The last agents snapshot the bridge holds (live mod only). `agent_stop` is refused without it. */
  agents?: AgentsSnapshotT | undefined
}

const NEEDS: Record<SessionControlActionT, SessionCapabilityT> = {
  stop: 'stop',
  compact: 'compact',
  command: 'command',
  clear: 'clear',
  agent_stop: 'agent_stop',
}

/**
 * The bridge's check of a signed `session.control` after osig and dedupe, BEFORE it is queued for the mod (C2.3: "the
 * boundary is the bridge"). Uses only bridge-held data: the last mod-reported state is used to refuse, never to allow
 * something the policy would not.
 */
export function checkSessionControl(c: SessionControlCheckInput, ctx: SessionControlCheckContext): { ok: true } | Fail {
  const ts = Date.parse(c.ts)
  if (!Number.isFinite(ts) || ctx.now - ts > CONTROL_STALE_MS || ts - ctx.now > CONTROL_CLOCK_SKEW_MS)
    return fail('control_stale', 'That tap is more than 2 minutes old. Try again.')
  const s = ctx.state
  if (s?.source !== 'mod') return fail('capability_missing', 'Session controls need the Talos mod.')
  if (s.stopped_at_mac) return fail('stopped_at_mac', 'Stopped at the Mac. Send a message to continue.')
  if (!s.capabilities.includes(NEEDS[c.action])) return fail('capability_missing', 'This Claude Code cannot do that.')
  if (!argsWellFormed(c.args)) return fail('args_invalid', 'Arguments must be one line of up to 500 characters.')
  if ((c.action === 'agent_stop') !== (c.agent_id !== undefined))
    return fail('args_invalid', 'Only an agent stop names an agent.')
  switch (c.action) {
    case 'agent_stop': {
      if (c.args !== undefined) return fail('args_invalid', 'Stopping an agent takes no arguments.')
      const snap = ctx.agents?.session_id === s.session_id && ctx.agents.can_stop ? ctx.agents : undefined
      const row = snap?.rows.find((r) => r.id === c.agent_id)
      if (!row?.stoppable || !isLiveAgentStatus(row.status))
        return fail('agent_not_found', 'That agent already ended. Nothing was stopped.')
      return { ok: true }
    }
    case 'stop':
      if (!s.busy || !s.turn_id || c.turn_id !== s.turn_id)
        return fail('turn_mismatch', 'That turn already ended. Nothing was stopped.')
      return { ok: true }
    case 'compact':
      return { ok: true }
    case 'clear':
      if (c.args !== undefined && c.args.trim() !== '')
        return fail('args_invalid', 'New conversation takes no arguments.')
      return { ok: true }
    case 'command': {
      const name = c.command ?? ''
      if (c.source !== 'builtin') return fail('command_not_allowed', 'Only built-in commands run as controls.')
      if (!Object.hasOwn(BUILTIN_CONTROL_COMMANDS, name) || (OWN_ACTION_COMMANDS as readonly string[]).includes(name))
        return fail('command_not_allowed', 'Run this at the Mac.')
      if ((name === 'model' || name === 'effort') && !s.capabilities.includes(name))
        return fail('capability_missing', 'This Claude Code cannot do that.')
      if (!ctx.inventory) return fail('capability_missing', 'No command list from the session yet.')
      const plan = planPaletteRun({ source: 'builtin', name, args: c.args ?? '' }, ctx)
      if (!plan.ok) return plan
      return plan.kind === 'control' && plan.action === 'command'
        ? { ok: true }
        : fail('command_not_allowed', 'Run this at the Mac.')
    }
  }
}

// ---- model and effort (C4.4) --------------------------------------------------------------------------------------

/** The short names the engine's own model row lists. Anything else in the picker list is a full model id the owner typed. */
const MODEL_ALIAS = /^(default|best|opusplan|opus|sonnet|haiku|fable)(\[[^\]]*\])?$/

/**
 * The picker list: the configured models. An alias is narrowed to the `/config` model row's options when the engine shows
 * them (that row only ever lists aliases). A model id the owner typed is never narrowed away: the row cannot know about it,
 * and the owner chose it.
 */
export function effectiveModelList(configured: readonly string[], rowOptions: readonly string[] | undefined): string[] {
  return rowOptions === undefined
    ? [...configured]
    : configured.filter((m) => !MODEL_ALIAS.test(m) || rowOptions.includes(m))
}

const CREDIT_MODELS = /^(best|fable)(\[|$)|^claude-fable-/
export function modelSwitchNotes(value: string): { reread: string; default_note: string; credits?: string } {
  return {
    reread: 'Switching re-reads the whole conversation: the next turn is slower and uses more of your limits.',
    default_note: 'Also becomes the default for new sessions.',
    ...(CREDIT_MODELS.test(value)
      ? { credits: 'May use usage credits. The consent prompt appears only at the Mac.' }
      : {}),
  }
}

/** Effort changes keep the cache without asking only on these models (prompt-caching docs); anything else may ask. */
export function effortKeepsCache(modelId: string | undefined): boolean {
  return typeof modelId === 'string' && /^claude-((opus|sonnet|haiku)-5-5|fable-5-1)(?![0-9])/.test(modelId)
}
export const EFFORT_MAY_ASK_NOTE = 'May ask at the Mac'
export const THINKING_NOTE = 'This model always thinks; effort sets how much.'

// ---- the mod link (C2.3) ------------------------------------------------------------------------------------------

export const MOD_TOOLS = ['talos_mod_hello', 'talos_mod_sync'] as const
export const MOD_TOOL_DESCRIPTION = 'Internal to the Talos mod. Never call.'
/**
 * The mod's guard matches every caller's call to a bridge mod tool, whatever the server is named. Throws on a
 * non-string so a guard wrapped in `.catch(() => ({decision:'deny'}))` denies what it cannot read.
 */
export function isModToolName(toolName: string): boolean {
  if (typeof toolName !== 'string') throw new TypeError('tool name is not a string')
  return /^mcp__.+__talos_mod_[A-Za-z0-9_]*$/.test(toolName)
}

export const ModKey = z.string().regex(/^[A-Za-z0-9_-]{43}$/)
export const ModHelloResult = z.strictObject({ mod_key: ModKey })

const evt = <T extends string, S extends z.ZodRawShape>(type: T, shape: S) =>
  z.strictObject({ type: z.literal(type), ...shape, at: IsoTs })
export const ModEvent = z.discriminatedUnion('type', [
  evt('turn_start', { turn_id: z.string().max(64) }),
  evt('turn_complete', { turn_id: z.string().max(64), aborted: z.boolean() }),
  // C3.4: the closer supersedes a card only on an exact (tool_name, input_hash) match with exactly one candidate
  evt('prompt_open', {
    tool_name: z.string().max(200),
    input_hash: Sha256Ref,
    tool_use_id: z.string().max(80).optional(),
  }),
  evt('prompt_closed', {
    tool_name: z.string().max(200),
    input_hash: Sha256Ref,
    tool_use_id: z.string().max(80).optional(),
  }),
  evt('compacting', { on: z.boolean() }),
  evt('model_switched', { model: z.string().max(80) }),
  evt('effort_changed', { effort: z.string().max(16) }),
  evt('stopped_at_mac', {}),
  evt('surfaces', { surfaces: z.array(z.string().max(24)).max(8) }),
])
export type ModEventT = z.infer<typeof ModEvent>

/** A control the bridge hands the mod: already osig-checked, deduped and passed checkSessionControl(). */
export const ModControl = z
  .strictObject({
    control_id: Ulid,
    action: SessionControlAction,
    turn_id: z.string().max(64).optional(),
    command: z.string().max(64).optional(),
    /** Always 'builtin' with a command: the mod refuses a name its `$.command.list()` also shows under another source. */
    source: z.literal('builtin').optional(),
    args: z.string().max(MAX_CONTROL_ARGS).optional(),
    /** One-shot pre-approval for exactly this `/model` switch (C4.4 step 2); the mod burns it on use. */
    model_ticket: z.strictObject({ to_model: ModelValue, expires_at: IsoTs }).optional(),
    /** `agent_stop` only: the task id the mod passes to `TaskStop` (docs/SUBAGENTS.md). */
    agent_id: z.string().min(1).max(80).optional(),
  })
  .superRefine((c, ctx) => {
    if ((c.action === 'agent_stop') !== (c.agent_id !== undefined))
      ctx.addIssue({ code: 'custom', path: ['agent_id'], message: 'agent_stop needs agent_id; other actions none' })
    if (c.action === 'agent_stop' && c.args !== undefined)
      ctx.addIssue({ code: 'custom', path: ['args'], message: 'agent_stop takes no args' })
    if (c.action === 'stop' && !c.turn_id)
      ctx.addIssue({ code: 'custom', path: ['turn_id'], message: 'stop needs turn_id' })
    if (c.action !== 'stop' && c.turn_id !== undefined)
      ctx.addIssue({ code: 'custom', path: ['turn_id'], message: 'only stop takes turn_id' })
    if (c.action === 'command' && !c.command)
      ctx.addIssue({ code: 'custom', path: ['command'], message: 'command needs a command' })
    if ((c.action === 'command') !== (c.source !== undefined))
      ctx.addIssue({ code: 'custom', path: ['source'], message: "command takes source 'builtin'; other actions none" })
    if (c.action !== 'command' && c.command !== undefined)
      ctx.addIssue({ code: 'custom', path: ['command'], message: 'only command takes command' })
    const isModel = c.action === 'command' && c.command === 'model'
    if (isModel && !c.model_ticket)
      ctx.addIssue({ code: 'custom', path: ['model_ticket'], message: 'a model switch needs a ticket' })
    if (!isModel && c.model_ticket)
      ctx.addIssue({ code: 'custom', path: ['model_ticket'], message: 'only a model switch takes a ticket' })
  })
export type ModControlT = z.infer<typeof ModControl>

export const ModControlResult = z.strictObject({
  control_id: Ulid,
  ok: z.boolean(),
  code: ErrorCode.optional(),
  text: z.string().max(4000),
})
export type ModControlResultT = z.infer<typeof ModControlResult>

export const ModSyncRequest = z.strictObject({
  mod_key: ModKey,
  state: SessionState.optional(),
  inventory: SessionInventory.optional(),
  events: z.array(ModEvent).max(200).optional(),
  results: z.array(ModControlResult).max(50).optional(),
  /** docs/SUBAGENTS.md: sent only when it changed since the last sync. May be over the frame cap; the bridge trims. */
  agents: AgentsSnapshot.optional(),
})
export type ModSyncRequestT = z.infer<typeof ModSyncRequest>
export const ModSyncResponse = z.strictObject({ controls: z.array(ModControl).max(20) })
export type ModSyncResponseT = z.infer<typeof ModSyncResponse>

/** The engine's refusal after the user interrupted at the Mac (mods api); the app shows STOPPED_AT_MAC_TEXT. */
export const STOPPED_AT_MAC_REASON = 'the session was stopped and nobody has sent input since'
export const STOPPED_AT_MAC_TEXT = 'Stopped at the Mac. Send a message to continue.'
export function isStoppedAtMacReason(text: string): boolean {
  return typeof text === 'string' && text.includes(STOPPED_AT_MAC_REASON)
}

// ---- Sessions view (C4.6) ------------------------------------------------------------------------------------------

/** https://claude.ai/… only: an agent-supplied link must not become a phishing door. */
export function isClaudeAiUrl(u: string): boolean {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: rejecting control characters is the point
  if (typeof u !== 'string' || u.length > 2000 || /[\s\u0000-\u001f\u007f]/.test(u)) return false
  try {
    const p = new URL(u)
    return (
      p.protocol === 'https:' && p.hostname === 'claude.ai' && p.port === '' && p.username === '' && p.password === ''
    )
  } catch {
    return false
  }
}

// `thread`: a thread's own worker session (docs/OPTION-C.md 9.4), parked ones included
export const SessionKind = z.enum(['subagent', 'interactive', 'background', 'cloud', 'headless', 'thread'])
export const SessionStatus = z.enum(['pending', 'working', 'blocked', 'done', 'failed', 'stopped', 'killed', 'unknown'])
export const SpawnKind = z.enum(['subagent', 'background', 'cloud'])

export const SessionListItem = z
  .strictObject({
    id: z.string().min(1).max(80),
    kind: SessionKind,
    title: z.string().max(120),
    status: SessionStatus,
    waiting_for: z.string().max(120).optional(),
    thread_id: ThreadId.optional(),
    url: z.string().refine(isClaudeAiUrl).optional(),
    /** "Show output" (`claude logs <id>`) exists for background sessions only. */
    output: z.enum(['available', 'not_available']),
    updated_at: IsoTs,
  })
  .refine((s) => s.output === 'not_available' || s.kind === 'background', {
    path: ['output'],
    message: 'only background sessions have output',
  })
export type SessionListItemT = z.infer<typeof SessionListItem>

/** `session_report` tool input (C4.6). A url that is not https://claude.ai/… is dropped, never shown. */
export const SessionReportInput = z.object({
  kind: z.enum(['cloud', 'scheduled', 'headless', 'background', 'subagent']),
  title: z.string().min(1).max(120),
  url: z
    .string()
    .optional()
    .transform((u) => (u !== undefined && isClaudeAiUrl(u) ? new URL(u).href : undefined)),
  status: z.string().max(40).optional(),
  thread_id: ThreadId,
})
export type SessionReportInputT = z.infer<typeof SessionReportInput>

// ---- threads (C7.2, C7.3, C8.1) -----------------------------------------------------------------------------------

/** The one dismissible line at the top of the thread list. */
export function threadsExplainer(agentName: string): string {
  return `Threads keep topics apart. ${agentName} replies where you ask and files its own updates by topic.`
}
