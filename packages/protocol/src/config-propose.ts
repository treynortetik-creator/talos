// O1 (SETTINGS-MAP 3.4): the agent may PROPOSE a change to the settings the table turns on (and, for threads, to the per-thread
// fields in THREAD_FIELD_RULES); the owner approves it on a card and the BRIDGE applies it. The agent never writes. Nothing here
// can be reached by a `config.patch` from an app (that has its own, wider rules in the settings table) and nothing here widens it.
//
// The list is closed: a path that is not on it is refused, whatever else is true. A path is a table row the agent rule is on
// for, `threads.<new_id>` (a new thread), or `threads.<id>.<field>`. Devices, keys, enrollment and security settings, and every
// row whose risk is `mac`, are never on it. A change is `low` or `high` by the table (how much it matters). The bridge makes it
// at once when the owner asked and his settings are not locked, else it is a card. The check runs when the agent proposes AND
// again when it is written, on the payload actually written (a card's bound payload, what was shown), never on what the agent
// said later.
import { z } from 'zod'
import { type AgentConfigT, trustOn } from './config.ts'
import { isInheritedName, ThreadId } from './ids.ts'
import type { CardT, ThreadT } from './models.ts'
import {
  AGENT_REFUSED_NAMES,
  AGENT_RULES,
  AGENT_SETTING_PATHS,
  type AgentRule,
  type AgentSettingPath,
  type AlsoHigh,
  readSettingValue,
  SETTINGS_TABLE,
  sessionRefusal,
  THREAD_FIELD_RULES,
  THREAD_FIELDS,
  type ThreadField,
  type ThreadFieldRow,
} from './settings-table.ts'

/** Advertised by a relay whose Card enum knows `kind:'config'`. The bridge mints these cards only against such a relay. */
export const CONFIG_PROPOSE_FEATURE = 'config-propose/1'

/**
 * Advertised by a relay that ships the web build that can preview and apply a `theme` card (K9c). `config-propose/1` alone
 * is not enough: a newer bridge in front of an older relay and web would mint a theme card the app cannot show.
 */
export const CUSTOM_THEMES_FEATURE = 'custom-themes/1'
/** The bridge reads `settings_lock` ("Lock Talos settings"): the app offers the switch only to a bridge that says so. */
export const SETTINGS_LOCK_FEATURE = 'settings-lock/1'

/** The table rows the agent rule is on for (`threads` stands for the per-thread paths). */
export const AGENT_CONFIG_ALLOWLIST = AGENT_SETTING_PATHS
/** A path of a proposal: a table row, `threads.<new_id>` or `threads.<id>.<field>`. */
export type AgentConfigPath = string

/**
 * Settings that are refused by name, so the refusal can say so plainly. This is documentation for the agent and the owner,
 * not the gate: the gate is the target lookup below, which refuses everything else too.
 */
export const AGENT_CONFIG_REFUSED = AGENT_REFUSED_NAMES

export const MAX_CONFIG_CHANGES = 6
/**
 * Agent-made threads past which a proposal carries a warning (Pantheon 2026-11-15: a warning, not a refusal; trust mode skips
 * it), and threads in all, archived ones included, which is the config's own limit and still refuses.
 */
export const MAX_AGENT_THREADS = 20
export const MAX_THREADS_TOTAL = 40

type RowPath = Exclude<AgentSettingPath, 'threads'>
type Risk = 'low' | 'high'

/** What a path of a proposal points at. */
type Target =
  | { kind: 'row'; path: RowPath; rule: AgentRule; risk: Risk; alsoHigh?: AlsoHigh }
  | { kind: 'new_thread'; id: string; rule: AgentRule; risk: Risk }
  | { kind: 'thread_field'; id: string; field: ThreadField; row: ThreadFieldRow }

const hasOwn = (o: object, k: string) => Object.hasOwn(o, k)
const THREAD_PATH = /^threads\.([^.]+)(?:\.([^.]+))?$/

function targetOf(path: string): Target | undefined {
  if (path !== 'threads' && hasOwn(AGENT_RULES, path)) {
    const p = path as RowPath
    const alsoHigh = AGENT_RULES[p].alsoHigh
    return {
      kind: 'row',
      path: p,
      rule: AGENT_RULES[p],
      risk: SETTINGS_TABLE[p].risk as Risk,
      ...(alsoHigh ? { alsoHigh } : {}),
    }
  }
  const m = THREAD_PATH.exec(path)
  if (!m) return undefined
  const id = m[1] as string
  const field = m[2]
  if (field === undefined)
    return { kind: 'new_thread', id, rule: AGENT_RULES.threads, risk: SETTINGS_TABLE.threads.risk as Risk }
  if (!(THREAD_FIELDS as readonly string[]).includes(field)) return undefined
  return { kind: 'thread_field', id, field: field as ThreadField, row: THREAD_FIELD_RULES[field as ThreadField] }
}

const ruleOf = (t: Target): AgentRule => (t.kind === 'thread_field' ? t.row.rule : t.rule)
const labelOf = (t: Target): string =>
  t.kind === 'row'
    ? t.rule.label
    : t.kind === 'new_thread'
      ? `New thread ${t.id}`
      : `Thread ${t.id} ${t.row.rule.label}`

export function isAgentConfigPath(p: unknown): p is AgentConfigPath {
  return typeof p === 'string' && targetOf(p) !== undefined
}

/** How much a change to `path` matters: `low`, `high`, or undefined for a path the agent may not propose (mac rows and unknown paths). */
export function riskOfPath(path: string): Risk | undefined {
  const t = targetOf(path)
  return !t ? undefined : t.kind === 'thread_field' ? t.row.risk : t.risk
}

/**
 * How much THIS change matters, on the config as it is: the path's risk, raised to high when the value, the config or the thread
 * makes a low field high (setting quiet hours, the timezone while they are set, alerts off, any change to the default thread's
 * alerts). Undefined for a path the agent may not propose.
 */
export function riskOfChange(c: { path: string; new: unknown }, current: AgentConfigT): Risk | undefined {
  const t = targetOf(c.path)
  if (!t) return undefined
  if (t.kind === 'row') return t.risk === 'low' && t.alsoHigh?.when(c.new, current) ? 'high' : t.risk
  if (t.kind !== 'thread_field') return t.risk
  return t.row.risk === 'low' && t.row.alsoHigh?.when(c.new, current, t.id) ? 'high' : t.row.risk
}

/** The name of a path on a card ("Thread trip name"), or the path itself when the agent may not propose it. */
export const labelOfPath = (path: string): string => {
  const t = targetOf(path)
  return t ? labelOf(t) : path
}

const threadOf = (c: AgentConfigT, id: string): ThreadT | undefined => c.threads.find((t) => t.id === id)

/** The value now in `config` at a path of a proposal; null for a thread that does not exist yet. */
export function readConfigPath(config: AgentConfigT, path: AgentConfigPath): unknown {
  const t = targetOf(path)
  if (!t) return undefined
  if (t.kind === 'row') return readSettingValue(config, t.path)
  const thread = threadOf(config, t.id)
  if (t.kind === 'new_thread')
    return thread
      ? {
          name: thread.name,
          ...(thread.topic ? { topic: thread.topic } : {}),
          ...(thread.icon ? { icon: thread.icon } : {}),
        }
      : null
  return thread ? t.row.read(thread) : undefined
}

const mergeDeep = (into: Record<string, unknown>, from: Record<string, unknown>) => {
  for (const [k, v] of Object.entries(from)) {
    const cur = into[k]
    into[k] =
      typeof v === 'object' && v !== null && !Array.isArray(v) && typeof cur === 'object' && cur !== null
        ? mergeDeep({ ...(cur as Record<string, unknown>) }, v as Record<string, unknown>)
        : v
  }
  return into
}

/** The thread a created-thread change adds: an agent thread at the end of the list, notify all, dated `now`. */
function newThread(id: string, value: unknown, current: AgentConfigT, now: string, index: number): ThreadT {
  const v = value as { name: string; topic?: string; icon?: string }
  return {
    id,
    name: v.name,
    ...(v.icon ? { icon: v.icon } : {}),
    ...(v.topic ? { topic: v.topic } : {}),
    kind: 'agent',
    order: Math.max(0, ...current.threads.map((t) => t.order)) + 1 + index,
    notify: 'all',
    voice_context: 'recent',
    archived: false,
    created_at: now,
  }
}

/**
 * The RFC 7386 merge patch for the changes. It can only ever name the rows and thread fields the targets above allow. The
 * `threads` list is replaced as a whole by a config patch, so thread changes put every thread in it (the ones not touched as they
 * are now) and a created thread at the end; `null` clears a key, as in the app's own patch.
 */
export function agentConfigPatch(
  changes: ReadonlyArray<{ path: AgentConfigPath; new: unknown }>,
  current: AgentConfigT,
  now: string = new Date().toISOString(),
): Record<string, unknown> {
  const patch: Record<string, unknown> = {}
  const edits = new Map<string, Record<string, unknown>>()
  const created: ThreadT[] = []
  for (const c of changes) {
    const t = targetOf(c.path)
    if (!t) continue
    if (t.kind === 'thread_field') edits.set(t.id, { ...edits.get(t.id), ...t.row.set(c.new, threadOf(current, t.id)) })
    else if (t.kind === 'new_thread') created.push(newThread(t.id, c.new, current, now, created.length))
    else if (t.rule.patch) mergeDeep(patch, t.rule.patch(c.new))
    else {
      const dot = t.path.indexOf('.')
      if (dot < 0) patch[t.path] = c.new
      else mergeDeep(patch, { [t.path.slice(0, dot)]: { [t.path.slice(dot + 1)]: c.new } })
    }
  }
  if (edits.size || created.length)
    patch.threads = [...current.threads.map((t) => (edits.has(t.id) ? { ...t, ...edits.get(t.id) } : t)), ...created]
  return patch
}

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)

export type ConfigChange = { path: AgentConfigPath; old: unknown; new: unknown }
/** `warnings`: what the agent is told and the proposal goes ahead anyway (present only when there is one). */
export type ResolvedChanges = { ok: true; changes: ConfigChange[]; warnings?: string[] } | { ok: false; error: string }

/** Why a path is refused, in words the agent can relay. Anything not on the list gets the same refusal. */
export function refusalFor(path: string): string {
  const top = path.split('.')[0] ?? path
  const named =
    (AGENT_CONFIG_REFUSED as readonly string[]).includes(path) ||
    (AGENT_CONFIG_REFUSED as readonly string[]).includes(top)
  return named
    ? `${path} can't be changed by you. The owner changes it in Settings. Allowed: ${allowed()}.`
    : `${path} is not a setting you may propose. Allowed: ${allowed()}. Devices, keys, enrollment and security settings are never on the list.`
}
const allowed = () => AGENT_SETTING_PATHS.map((p) => (p === 'threads' ? 'threads.<id>.<field>' : p)).join(', ')

const validIds = (c: AgentConfigT) =>
  c.threads
    .filter((t) => !t.archived)
    .map((t) => t.id)
    .join(', ')

/** Threads this proposal adds before the one being judged: the limits count them, or one proposal could pass the limit. */
type Batch = { agent: number; total: number; warnings: string[] }
const manyThreads = (n: number) =>
  `this makes ${n} active agent threads, more than ${MAX_AGENT_THREADS}; check with the owner that he wants them all, or archive one`

/** What the value rules cannot see, judged on the config as it is now (propose time and again at apply). Null when fine. */
function targetIssue(t: Target, value: unknown, current: AgentConfigT, batch: Batch): string | null {
  const agentActive = () => current.threads.filter((x) => x.kind === 'agent' && !x.archived).length + batch.agent
  if (t.kind === 'row') return t.rule.check?.(value, current) ?? null
  if (t.kind === 'new_thread') {
    const id = t.id
    if (!ThreadId.safeParse(id).success) return 'a new thread id must match ^[a-z][a-z0-9_]{0,31}$ and not be "all"'
    if (id.startsWith('talos__')) return 'ids starting with "talos__" are reserved for the app; pick another'
    if (isInheritedName(id)) return `id "${id}" is a name every object already has; pick another`
    if (threadOf(current, id)) return `thread "${id}" already exists`
    // Past twenty agent threads: a warning, not a refusal (trust mode skips it); the config's own limit (the schema's 40
    // threads in all) still refuses.
    if (!trustOn(current) && agentActive() >= MAX_AGENT_THREADS) batch.warnings.push(manyThreads(agentActive() + 1))
    if (current.threads.length + batch.total >= MAX_THREADS_TOTAL)
      return `at most ${MAX_THREADS_TOTAL} threads in all, archived ones included, so archiving does not make room`
    batch.agent += 1
    batch.total += 1
    return null
  }
  const thread = threadOf(current, t.id)
  if (!thread) return `Unknown thread "${t.id}". Valid thread ids: ${validIds(current)}`
  if (thread.kind === 'system') return `thread ${t.id} is a system thread and can't be changed`
  if (t.field === 'session' && value === 'dedicated') return sessionRefusal(current, t.id)
  if (t.field === 'parent' && value !== null) {
    // judged here whatever the thread's own state: the whole-change rule skips an archived thread, and a dangling or nested
    // parent_id written onto one would be adopted by a later thread of that id. Folders and one-level-deep for the thread
    // itself are judged on the whole change, after this.
    if (value === t.id) return `thread ${t.id} can't be its own parent`
    const parent = threadOf(current, String(value))
    if (!parent) return `there is no thread "${String(value)}". Valid thread ids: ${validIds(current)}`
    if (parent.archived) return `thread ${parent.id} is archived and can't have sub-threads`
    if (parent.kind === 'system') return "the inbox can't have sub-threads"
    if (parent.parent_id) return `"${parent.id}" is a sub-thread itself; sub-threads go one level deep`
  }
  // bringing an agent thread back from the archive is one more active agent thread
  if (t.field === 'archived' && value === false && thread.archived && thread.kind === 'agent') {
    if (!trustOn(current) && agentActive() >= MAX_AGENT_THREADS) batch.warnings.push(manyThreads(agentActive() + 1))
    batch.agent += 1
  }
  if (t.field === 'archived' && value === true) {
    if (thread.kind !== 'agent') return `thread ${t.id} is not an agent thread and cannot be archived`
    if (current.default_thread === t.id)
      return `thread ${t.id} is the owner's default thread and cannot be archived; ask the owner first`
  }
  return null
}

/**
 * Validates what the agent asked for against the closed list and the value rules, and reads the CURRENT value of each (the
 * `old` shown on the card). Pure; used at propose time. `current` is the config on the Mac right now. A thread session passes
 * `opts.thread`: it may name only fields of that thread.
 */
export function resolveConfigChanges(
  raw: unknown,
  current: AgentConfigT,
  opts: { thread?: string } = {},
): ResolvedChanges {
  if (!Array.isArray(raw) || raw.length === 0) return { ok: false, error: 'changes must be a list of {path, value}' }
  if (raw.length > MAX_CONFIG_CHANGES)
    return { ok: false, error: `At most ${MAX_CONFIG_CHANGES} settings in one proposal.` }
  const seen = new Set<string>()
  const out: ConfigChange[] = []
  const batch: Batch = { agent: 0, total: 0, warnings: [] }
  const named = new Set(raw.map((i) => (i as { path?: unknown } | null)?.path))
  for (const item of raw) {
    const o = item as { path?: unknown; value?: unknown } | null
    if (!o || typeof o !== 'object' || typeof o.path !== 'string' || !('value' in o))
      return { ok: false, error: 'every change needs a path and a value' }
    const t = targetOf(o.path)
    if (!t) return { ok: false, error: refusalFor(o.path) }
    if (opts.thread !== undefined && !(t.kind === 'thread_field' && t.id === opts.thread))
      return {
        ok: false,
        error: `This session belongs to thread "${opts.thread}" and can only change its own thread (threads.${opts.thread}.<field>). Nothing was proposed.`,
      }
    // a sub-thread's session is held to its parent's folder, model and MCP list: it may not ask to move its own thread
    if (opts.thread !== undefined && t.kind === 'thread_field' && t.field === 'parent')
      return {
        ok: false,
        error:
          "A thread's own session can't move its thread under or out of another thread. The owner does that in the thread's settings. Nothing was proposed.",
      }
    if (seen.has(o.path)) return { ok: false, error: `${o.path} is listed twice` }
    seen.add(o.path)
    const parsed = ruleOf(t).value.safeParse(o.value)
    if (!parsed.success)
      return { ok: false, error: `${o.path}: ${parsed.error.issues[0]?.message ?? 'not a valid value'}` }
    const old = t.kind === 'new_thread' ? null : readConfigPath(current, o.path)
    if (t.kind !== 'new_thread' && same(old, parsed.data))
      return { ok: false, error: `${o.path} is already that value. Nothing to propose.` }
    const issue = targetIssue(t, parsed.data, current, batch)
    if (issue) return { ok: false, error: `${o.path}: ${issue}` }
    out.push({ path: o.path, old, new: parsed.data })
    // Archiving a dedicated thread also switches its session to shared (clearArchivedSessions): the card shows that as a change
    // of its own, so what is applied is what was shown, and the undo can bring the session back.
    if (t.kind === 'thread_field' && t.field === 'archived' && parsed.data === true) {
      const sessionPath = `threads.${t.id}.session`
      if (threadOf(current, t.id)?.session === 'dedicated' && !named.has(sessionPath))
        out.push({ path: sessionPath, old: 'dedicated', new: 'shared' })
    }
  }
  if (out.length > MAX_CONFIG_CHANGES)
    return {
      ok: false,
      error: `At most ${MAX_CONFIG_CHANGES} settings in one proposal (archiving a dedicated thread also switches its session to shared, which counts as one).`,
    }
  return batch.warnings.length
    ? { ok: true, changes: out, warnings: [...new Set(batch.warnings)] }
    : { ok: true, changes: out }
}

/** What a config card binds (the card's `payload`): exactly the changes the owner was shown, and the revision they were drawn on. */
export const ConfigCardPayload = z.strictObject({
  v: z.literal(1),
  base_rev: z.number().int().nonnegative(),
  reason: z.string().max(280),
  changes: z
    .array(
      z.strictObject({
        path: z.string().max(80).refine(isAgentConfigPath, 'not a setting the agent may propose'),
        old: z.unknown(),
        new: z.unknown(),
      }),
    )
    .min(1)
    .max(MAX_CONFIG_CHANGES),
})
export type ConfigCardPayloadT = z.infer<typeof ConfigCardPayload>

/**
 * The second check, at apply time, on the BOUND payload: every path still on the list, every new value still valid and still
 * allowed by the config as it is now, and every old value still what the config holds. Returns the changes to write, or why
 * nothing is written. `now` dates a created thread.
 */
export function verifyConfigPayload(
  payload: unknown,
  current: AgentConfigT,
  now: string = new Date().toISOString(),
):
  | { ok: true; changes: ConfigChange[]; patch: Record<string, unknown> }
  | { ok: false; error: string; stale?: boolean } {
  const p = ConfigCardPayload.safeParse(payload)
  if (!p.success) return { ok: false, error: 'The card could not be read, or names a setting you may not change.' }
  const changes: ConfigChange[] = []
  const batch: Batch = { agent: 0, total: 0, warnings: [] }
  for (const c of p.data.changes) {
    const t = targetOf(c.path)
    if (!t) return { ok: false, error: refusalFor(String(c.path)) } // defence in depth: the payload schema already refused it
    const v = ruleOf(t).value.safeParse(c.new)
    if (!v.success) return { ok: false, error: `${c.path} is no longer a valid value.` }
    if (!same(readConfigPath(current, c.path), c.old))
      return {
        ok: false,
        stale: true,
        error: `${labelOf(t)} changed since this card was drawn, so nothing was changed. Ask again.`,
      }
    const issue = targetIssue(t, v.data, current, batch)
    if (issue) return { ok: false, error: `${labelOf(t)}: ${issue}. Nothing was changed.` }
    changes.push({ path: c.path, old: c.old, new: v.data })
  }
  return { ok: true, changes, patch: agentConfigPatch(changes, current, now) }
}

/** One line of a card body: "Agent name: Talos → Atlas". */
export function describeValue(path: AgentConfigPath, v: unknown): string {
  const t = targetOf(path)
  return (t ? ruleOf(t).show?.(v) : undefined) ?? String(v)
}
export const describeChange = (c: ConfigChange): string =>
  `${labelOfPath(c.path)}: ${describeValue(c.path, c.old)} → ${describeValue(c.path, c.new)}`

/**
 * How to revert, from the old values: "To undo: Timezone back to UTC; archive thread errands." A created thread is undone by
 * archiving it. The old value is shown the way the card showed it.
 */
export function undoText(changes: ReadonlyArray<ConfigChange>): string {
  const parts = changes.map((c) => {
    const t = targetOf(c.path)
    if (t?.kind === 'new_thread') return `archive thread ${t.id}`
    // archiving drops the thread's inbox copies (the bridge removes them): un-archiving brings the thread back, not those
    if (t?.kind === 'thread_field' && t.field === 'archived' && c.new === true)
      return `unarchive thread ${t.id} (its inbox copies are not restored)`
    // the agent never turns the lock off: the owner does
    if (c.path === 'settings_lock') return 'turn Lock Talos settings off in Settings'
    // a theme that turns out unreadable still has a way back that needs no reading of the screen
    if (c.path === 'theme')
      return `${labelOfPath(c.path)} back to ${describeValue(c.path, c.old)}, or say "reset the theme"`
    return `${labelOfPath(c.path)} back to ${describeValue(c.path, c.old)}`
  })
  return `To undo: ${parts.join('; ')}.`
}

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

/** Archiving also clears the thread's saved copies of the owner's files; the card says so. */
const archiveNote = (changes: ReadonlyArray<ConfigChange>): string =>
  changes.some((c) => /^threads\.[^.]+\.archived$/.test(c.path) && c.new === true)
    ? "\nArchiving also clears the thread's saved copies of your files."
    : ''

/** The card as it is drawn: pending, no editing, revise allowed, old and new of each setting in the body. Hash is set by the caller. */
export function configCardCandidate(i: ConfigCardInput): Omit<CardT, 'payload_hash'> & { payload_hash: string } {
  const one = i.changes.length === 1 ? i.changes[0] : undefined
  const oneTarget = one ? targetOf(one.path) : undefined
  const payload: ConfigCardPayloadT = { v: 1, base_rev: i.baseRev, reason: i.reason, changes: i.changes }
  return {
    id: i.cardId,
    thread_id: i.threadId,
    kind: 'config',
    title: !one
      ? `Change ${i.changes.length} settings`
      : oneTarget?.kind === 'new_thread'
        ? `Create thread ${oneTarget.id}`
        : `Change ${labelOfPath(one.path).toLowerCase()}`,
    summary: i.reason.slice(0, 280),
    destination: i.changes.slice(0, 6).map((c) => ({ label: 'Setting', value: labelOfPath(c.path) })),
    body: `${i.changes.map(describeChange).join('\n')}${archiveNote(i.changes)}\n\nWhy: ${i.reason}`.slice(0, 20_000),
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
