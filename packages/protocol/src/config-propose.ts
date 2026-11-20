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
import { effectiveSessionOpts, folderInside, folderSame, parentThread } from './sub-threads.ts'
import { checkWorkerCwd, NEVER_DEDICATED_THREADS } from './thread-sessions.ts'
import { clipUnits } from './untrusted.ts'

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
// `threads.<id>`, `threads.<id>.<field>`, and the one field with a dot in it, `threads.<id>.session_opts.cwd`
const THREAD_PATH = /^threads\.([^.]+)(?:\.(session_opts\.cwd|[^.]+))?$/

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

/** The keys of a new thread that make creating it high: each is a high field when set on its own. */
const NEW_THREAD_HIGH_KEYS = ['parent', 'session', 'session_opts', 'model', 'mcp_allow'] as const

/**
 * How much THIS change matters, on the config as it is: the path's risk, raised to high when the value, the config or the thread
 * makes a low field high (setting quiet hours, the timezone while they are set, alerts off, any change to the default thread's
 * alerts). Undefined for a path the agent may not propose.
 */
export function riskOfChange(c: { path: string; new: unknown }, current: AgentConfigT): Risk | undefined {
  const t = targetOf(c.path)
  if (!t) return undefined
  if (t.kind === 'row') return t.risk === 'low' && t.alsoHigh?.when(c.new, current) ? 'high' : t.risk
  // a new thread is low, unless it is made under another thread or with a session, folder, model or MCP list of its own
  if (t.kind === 'new_thread') {
    const v = c.new
    return typeof v === 'object' && v !== null && NEW_THREAD_HIGH_KEYS.some((k) => k in v) ? 'high' : t.risk
  }
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

type NewThreadValue = {
  name: string
  topic?: string
  icon?: string
  color?: string
  parent?: string
  session?: 'shared' | 'dedicated'
  session_opts?: { cwd?: string }
  model?: string
  effort?: string
  mcp_allow?: string[]
  idle_park_min?: number
}

/** The thread a created-thread change adds: an agent thread at the end of the list, notify all, dated `now`. */
function newThread(id: string, value: unknown, current: AgentConfigT, now: string, index: number): ThreadT {
  const v = value as NewThreadValue
  const opts = {
    ...(v.session_opts?.cwd ? { cwd: v.session_opts.cwd } : {}),
    ...(v.model ? { model: v.model } : {}),
    ...(v.effort ? { effort: v.effort } : {}),
    ...(v.mcp_allow ? { mcp_allow: v.mcp_allow } : {}),
    ...(v.idle_park_min !== undefined ? { idle_park_min: v.idle_park_min } : {}),
  }
  return {
    id,
    name: v.name,
    ...(v.icon ? { icon: v.icon } : {}),
    ...(v.topic ? { topic: v.topic } : {}),
    ...(v.color ? { color: v.color } : {}),
    ...(v.parent ? { parent_id: v.parent } : {}),
    ...(v.session ? { session: v.session } : {}),
    ...(Object.keys(opts).length ? { session_opts: opts as ThreadT['session_opts'] } : {}),
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
  // each thread as the changes so far leave it, so a created thread takes the fields set on it after, and two fields of one
  // thread's `session_opts` (folder and model, say) both land
  const built = new Map<string, ThreadT>()
  const created: string[] = []
  for (const c of changes) {
    const t = targetOf(c.path)
    if (!t) continue
    if (t.kind === 'thread_field') {
      const base = built.get(t.id) ?? threadOf(current, t.id)
      if (base) built.set(t.id, { ...base, ...t.row.set(c.new, base) } as ThreadT)
    } else if (t.kind === 'new_thread') {
      built.set(t.id, newThread(t.id, c.new, current, now, created.length))
      created.push(t.id)
    } else if (t.rule.patch) mergeDeep(patch, t.rule.patch(c.new))
    else {
      const dot = t.path.indexOf('.')
      if (dot < 0) patch[t.path] = c.new
      else mergeDeep(patch, { [t.path.slice(0, dot)]: { [t.path.slice(dot + 1)]: c.new } })
    }
  }
  if (built.size)
    patch.threads = [
      ...current.threads.map((t) => built.get(t.id) ?? t),
      ...created.map((id) => built.get(id) as ThreadT),
    ]
  return patch
}

/** The thread list as the changes would leave it (the current one when they touch no thread). */
const threadsAfter = (
  changes: ReadonlyArray<{ path: AgentConfigPath; new: unknown }>,
  current: AgentConfigT,
  now: string,
) => (agentConfigPatch(changes, current, now).threads as ThreadT[] | undefined) ?? current.threads
const withThreads = (current: AgentConfigT, threads: ThreadT[]): AgentConfigT => ({ ...current, threads })

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
type Batch = { agent: number; total: number; warnings: string[]; base: AgentConfigT }
const manyThreads = (n: number) =>
  `this makes ${n} active agent threads, more than ${MAX_AGENT_THREADS}; check with the owner that he wants them all, or archive one`

/** The folders a thread may never work in; the bridge passes the machine's own (the lexical half of `checkWorkerCwd`). */
export type FolderRoots = {
  home: string
  talosHome: string
  claudeDir?: string | null
}
/** What the checks need beyond the config: without `roots` a folder cannot be judged, so none is accepted. */
export type ProposeEnv = { roots?: FolderRoots }

/** A session model: `inherit`, or one the app offers (`session_models`). The value rule is only the grammar. */
function modelIssue(model: unknown, current: AgentConfigT): string | null {
  if (model === 'inherit' || current.session_models.includes(String(model))) return null
  return `"${String(model)}" is not one of the models the app offers (${['inherit', ...current.session_models].join(', ')})`
}

/** A session folder, lexically: the same rule every thread folder meets. The disk check (exists, realpath) is the bridge's. */
function cwdIssue(cwd: unknown, env: ProposeEnv): string | null {
  if (!env.roots) return "the folder can't be checked here, so it can't be set from a proposal"
  return checkWorkerCwd(String(cwd), env.roots)
}

/** A parent for `id`: it must exist, be live, be an ordinary thread and be top-level itself. */
function parentIssue(id: string, value: unknown, current: AgentConfigT): string | null {
  // judged here whatever the thread's own state: the whole-change rule skips an archived thread, and a dangling or nested
  // parent_id written onto one would be adopted by a later thread of that id. Folders and one-level-deep for the thread
  // itself are judged on the whole change, after this.
  if (value === id) return `thread ${id} can't be its own parent`
  const parent = threadOf(current, String(value))
  if (!parent) return `there is no thread "${String(value)}". Valid thread ids: ${validIds(current)}`
  if (parent.archived) return `thread ${parent.id} is archived and can't have sub-threads`
  if (parent.kind === 'system') return "the inbox can't have sub-threads"
  if (parent.parent_id) return `"${parent.id}" is a sub-thread itself; sub-threads go one level deep`
  return null
}

/** What the value rules cannot see, judged on the config as it is now (propose time and again at apply). Null when fine. */
function targetIssue(
  t: Target,
  value: unknown,
  current: AgentConfigT,
  batch: Batch,
  env: ProposeEnv = {},
): string | null {
  const agentActive = () => batch.base.threads.filter((x) => x.kind === 'agent' && !x.archived).length + batch.agent
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
    if (batch.base.threads.length + batch.total >= MAX_THREADS_TOTAL)
      return `at most ${MAX_THREADS_TOTAL} threads in all, archived ones included, so archiving does not make room`
    const v = value as NewThreadValue
    // main's front doors are never dedicated, whatever a new thread of that id asks (as sessionRefusal does for an existing one)
    if (v.session === 'dedicated' && (NEVER_DEDICATED_THREADS as readonly string[]).includes(id))
      return `thread ${id} can't have its own session: the default thread, general, inbox and archived threads are always shared`
    const own =
      (v.parent !== undefined ? parentIssue(id, v.parent, current) : null) ??
      (v.model !== undefined ? modelIssue(v.model, current) : null) ??
      (v.session_opts?.cwd !== undefined ? cwdIssue(v.session_opts.cwd, env) : null)
    if (own) return own
    batch.agent += 1
    batch.total += 1
    return null
  }
  const thread = threadOf(current, t.id)
  if (!thread) return `Unknown thread "${t.id}". Valid thread ids: ${validIds(current)}`
  if (thread.kind === 'system') return `thread ${t.id} is a system thread and can't be changed`
  if (t.field === 'session' && value === 'dedicated') return sessionRefusal(current, t.id)
  if (t.field === 'parent' && value !== null) {
    const why = parentIssue(t.id, value, current)
    if (why) return why
  }
  if (t.field === 'model') {
    const why = modelIssue(value, current)
    if (why) return why
  }
  if (t.field === 'session_opts.cwd') {
    const why = cwdIssue(value, env)
    if (why) return why
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

/** A new thread's refusal in words, with the key inside the object ("session_opts.cwd: ...") so the agent sees which field. */
const issueText = (i: { path: ReadonlyArray<PropertyKey>; message: string } | undefined): string =>
  i ? `${i.path.length ? `${i.path.map(String).join('.')}: ` : ''}${i.message}` : 'not a valid value'

/** The fields of its own thread that a thread's session may change: the low ones (name, topic, icon, colour, alerts, idle time, effort). */
const OWN_FIELDS: readonly ThreadField[] = ['name', 'topic', 'icon', 'color', 'notify', 'idle_park_min', 'effort']

const noMove =
  "A thread's own session can't move its thread under or out of another thread. The owner does that in the thread's settings. Nothing was proposed."

/**
 * Who may name what, for a thread's own session `me` (main is not judged here). It may change the low fields of its own
 * thread, make a sub-thread of its own (`parent: me`, and only when it is not a sub-thread itself), and change any field of
 * its own sub-threads except their parent. `madeHere` is the threads this proposal creates under it. Null when allowed.
 */
function scopeIssue(
  me: string,
  t: Target,
  value: unknown,
  current: AgentConfigT,
  madeHere: ReadonlySet<string>,
): string | null {
  const own = `This session belongs to thread "${me}" and can only change its own thread (threads.${me}.<field>) and the sub-threads under it. Nothing was proposed.`
  if (t.kind === 'row') return own
  if (t.kind === 'new_thread') {
    if (threadOf(current, me)?.parent_id)
      return `Thread "${me}" is a sub-thread, and sub-threads go one level deep, so it can't make threads of its own. Nothing was proposed.`
    const parent = (value as { parent?: unknown } | null)?.parent
    return parent === me
      ? null
      : `This session belongs to thread "${me}" and can only make threads under it: put "parent":"${me}" in the new thread. Nothing was proposed.`
  }
  // a sub-thread's session is held to its parent's folder and MCP list (model and effort are free): it may not ask to move its own thread
  if (t.field === 'parent') return noMove
  if (t.id === me) {
    return OWN_FIELDS.includes(t.field)
      ? null
      : `A thread's own session can't change its thread's ${t.row.rule.label}; main or the owner does that. Nothing was proposed.`
  }
  if (madeHere.has(t.id)) return null
  const thread = threadOf(current, t.id)
  return thread?.parent_id === me && thread.kind !== 'system' && t.id !== current.default_thread ? null : own
}

/**
 * What no single change shows: a thread the proposal touches, with a live parent, may not reach past it (its MCP list a subset
 * of the parent's, for every caller; for a thread session also its folder inside the parent's), and a thread with sub-threads of
 * its own can't be put under another thread. Judged on the threads as the changes leave them. A parent with no list limits its
 * sub-threads' lists nothing, as today; a thread session's sub-thread gets no folder under a parent with none. Main's folders are
 * the owner's own rules (`scoped` is false for Main). Lexical: the bridge adds the on-disk check. Null when fine.
 */
function reachIssue(
  changes: ReadonlyArray<ConfigChange>,
  current: AgentConfigT,
  now: string,
  scoped: boolean,
): string | null {
  const after = withThreads(current, threadsAfter(changes, current, now))
  const fields = new Map<string, Set<string>>()
  for (const c of changes) {
    const t = targetOf(c.path)
    if (t?.kind === 'new_thread') fields.set(t.id, new Set(['parent', 'session_opts.cwd', 'mcp_allow']))
    else if (t?.kind === 'thread_field') fields.set(t.id, (fields.get(t.id) ?? new Set()).add(t.field))
  }
  // what to judge on which thread: the thread itself when its parent, folder or list is set here, or when its own session starts
  // (it becomes dedicated, or comes back from the archive dedicated: the folder and list it already has start to count). A thread
  // session can't move its own folder, so no parent's folder moves under a child here; a parent's list narrowing is not judged: the
  // child's own list is trimmed to it when it runs (effectiveSessionOpts).
  type What = { cwd: boolean; mcp: boolean; moved: boolean }
  const judge = new Map<string, What>()
  const want = (id: string, k: keyof What) =>
    judge.set(id, { cwd: false, mcp: false, moved: false, ...judge.get(id), [k]: true })
  // Folders are judged here only for a thread session's proposal. Main gets the owner's own folder rules, which the bridge applies
  // to every proposal and every save (`subThreadPatchIssue`: the own-folder opt-in, keepsOwnFolder, a folderless parent judged
  // against the agent folder), because the owner asked that Main pick which folder each agent works out of.
  const wantCwd = (id: string) => {
    if (scoped) want(id, 'cwd')
  }
  for (const [id, touched] of fields) {
    if (touched.has('parent')) {
      wantCwd(id)
      want(id, 'mcp')
      want(id, 'moved')
    }
    if (touched.has('session_opts.cwd')) wantCwd(id)
    if (touched.has('mcp_allow')) want(id, 'mcp')
    const me = threadOf(after, id)
    if (me?.session === 'dedicated' && (touched.has('session') || touched.has('archived'))) {
      wantCwd(id)
      want(id, 'mcp')
    }
  }
  for (const [id, what] of judge) {
    const t = threadOf(after, id)
    if (!t || t.archived || !t.parent_id) continue
    const parent = threadOf(after, t.parent_id)
    // an archived parent still holds its children's folders (they come back with it), so only a missing or nested one is skipped
    if (!parent || parent.parent_id) continue // the parent rules above judge those
    const label = `thread "${id}"`
    if (what.moved && after.threads.some((x) => x.parent_id === id && x.id !== id))
      return `${label} has sub-threads of its own, so it can't go under another thread; sub-threads go one level deep`
    const cwd = t.session_opts?.cwd
    const theirCwd = parent.session_opts?.cwd
    // A thread session is held inside its parent's folder: the owner's own-folder opt-in (a sub-thread keeping a folder elsewhere)
    // is his, and Main's, not a thread session's. A parent with no folder runs in the agent folder, which is Main's own area, so
    // it gives a thread session's sub-thread no folder: the parent needs one first.
    if (what.cwd && cwd) {
      if (!theirCwd) return `${label}: give "${parent.id}" a folder first; a sub-thread's folder goes inside it`
      if (!folderInside(cwd, theirCwd) && !folderSame(cwd, theirCwd))
        return `${label}: its folder must be inside "${parent.id}"'s folder (${theirCwd})`
    }
    const mine = t.session_opts?.mcp_allow
    const theirs = effectiveSessionOpts(after, parent.id).mcp_allow
    if (what.mcp && mine && theirs) {
      const extra = mine.find((x) => !theirs.includes(x))
      if (extra !== undefined)
        return `${label}: "${extra}" is not on its parent's MCP list; a sub-thread gets no more than its parent`
    }
  }
  return null
}

/**
 * Validates what the agent asked for against the closed list and the value rules, and reads the CURRENT value of each (the
 * `old` shown on the card). Pure; used at propose time. `current` is the config on the Mac right now. A thread session passes
 * `opts.thread`: it may change the low fields of its own thread and any field of its sub-threads (scopeIssue), and make
 * sub-threads of its own; main (no `opts.thread`) may name any thread. A thread made in the proposal can take fields in the
 * same proposal (`threads.<id>` first). `opts.roots` is what a folder is judged against: without it none is accepted.
 */
export function resolveConfigChanges(
  raw: unknown,
  current: AgentConfigT,
  opts: { thread?: string; roots?: FolderRoots; now?: string } = {},
): ResolvedChanges {
  if (!Array.isArray(raw) || raw.length === 0) return { ok: false, error: 'changes must be a list of {path, value}' }
  if (raw.length > MAX_CONFIG_CHANGES)
    return { ok: false, error: `At most ${MAX_CONFIG_CHANGES} settings in one proposal.` }
  const now = opts.now ?? new Date().toISOString()
  const seen = new Set<string>()
  const out: ConfigChange[] = []
  const batch: Batch = { agent: 0, total: 0, warnings: [], base: current }
  const named = new Set(raw.map((i) => (i as { path?: unknown } | null)?.path))
  const madeHere = new Set<string>()
  // the config with the threads this proposal made so far in it, so a field of a new thread is judged like any other
  let working = current
  for (const item of raw) {
    const o = item as { path?: unknown; value?: unknown } | null
    if (!o || typeof o !== 'object' || typeof o.path !== 'string' || !('value' in o))
      return { ok: false, error: 'every change needs a path and a value' }
    const t = targetOf(o.path)
    if (!t) return { ok: false, error: refusalFor(o.path) }
    if (opts.thread !== undefined) {
      const why = scopeIssue(opts.thread, t, o.value, working, madeHere)
      if (why) return { ok: false, error: why }
    }
    if (seen.has(o.path)) return { ok: false, error: `${o.path} is listed twice` }
    seen.add(o.path)
    const parsed = ruleOf(t).value.safeParse(o.value)
    if (!parsed.success) {
      const first = parsed.error.issues[0]
      return {
        ok: false,
        error: `${o.path}: ${t.kind === 'new_thread' ? issueText(first) : (first?.message ?? 'not a valid value')}`,
      }
    }
    const old = t.kind === 'new_thread' ? null : readConfigPath(working, o.path)
    if (t.kind !== 'new_thread' && same(old, parsed.data))
      return { ok: false, error: `${o.path} is already that value. Nothing to propose.` }
    const issue = targetIssue(t, parsed.data, working, batch, opts)
    if (issue) return { ok: false, error: `${o.path}: ${issue}` }
    out.push({ path: o.path, old, new: parsed.data })
    if (t.kind === 'new_thread') {
      if (opts.thread !== undefined && (parsed.data as NewThreadValue).parent === opts.thread) madeHere.add(t.id)
      working = withThreads(current, threadsAfter(out, current, now))
    } else if (t.kind === 'thread_field') working = withThreads(current, threadsAfter(out, current, now))
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
  const reach = reachIssue(out, current, now, opts.thread !== undefined)
  if (reach) return { ok: false, error: reach }
  return batch.warnings.length
    ? { ok: true, changes: out, warnings: [...new Set(batch.warnings)] }
    : { ok: true, changes: out }
}

/** What a config card binds (the card's `payload`): exactly the changes the owner was shown, and the revision they were drawn on. */
export const ConfigCardPayload = z.strictObject({
  v: z.literal(1),
  base_rev: z.number().int().nonnegative(),
  reason: z.string().max(280),
  /** The thread session that proposed it; absent when main did. Bound by the hash, so apply judges the same caller. */
  scope: ThreadId.optional(),
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
  env: ProposeEnv = {},
):
  | { ok: true; changes: ConfigChange[]; patch: Record<string, unknown> }
  | { ok: false; error: string; stale?: boolean } {
  const p = ConfigCardPayload.safeParse(payload)
  if (!p.success) return { ok: false, error: 'The card could not be read, or names a setting you may not change.' }
  const changes: ConfigChange[] = []
  const batch: Batch = { agent: 0, total: 0, warnings: [], base: current }
  let working = current
  const madeHere = new Set<string>()
  for (const c of p.data.changes) {
    const t = targetOf(c.path)
    if (!t) return { ok: false, error: refusalFor(String(c.path)) } // defence in depth: the payload schema already refused it
    // a thread session's card is held to the scope it was proposed under, on the config as it is now (the owner may have moved
    // a sub-thread since)
    if (p.data.scope !== undefined) {
      const why = scopeIssue(p.data.scope, t, c.new, working, madeHere)
      if (why) return { ok: false, error: why.replace('Nothing was proposed.', 'Nothing was changed.') }
    }
    const v = ruleOf(t).value.safeParse(c.new)
    if (!v.success) return { ok: false, error: `${c.path} is no longer a valid value.` }
    if (!same(readConfigPath(working, c.path), c.old))
      return {
        ok: false,
        stale: true,
        error: `${labelOf(t)} changed since this card was drawn, so nothing was changed. Ask again.`,
      }
    const issue = targetIssue(t, v.data, working, batch, env)
    if (issue) return { ok: false, error: `${labelOf(t)}: ${issue}. Nothing was changed.` }
    changes.push({ path: c.path, old: c.old, new: v.data })
    if (t.kind === 'new_thread' && p.data.scope !== undefined && (v.data as NewThreadValue).parent === p.data.scope)
      madeHere.add(t.id)
    if (t.kind !== 'row') working = withThreads(current, threadsAfter(changes, current, now))
  }
  const reach = reachIssue(changes, current, now, p.data.scope !== undefined)
  if (reach) return { ok: false, error: `${reach}. Nothing was changed.` }
  return { ok: true, changes, patch: agentConfigPatch(changes, current, now) }
}

/**
 * One line of a card body: "Agent name: Talos → Atlas". With `config`, a sub-thread's missing folder or MCP list reads "same as
 * <parent>" (it inherits the parent's), in the words only: the value read, compared and hashed stays null.
 */
export function describeValue(path: AgentConfigPath, v: unknown, config?: AgentConfigT): string {
  const t = targetOf(path)
  if (config && t?.kind === 'thread_field' && (v === null || v === undefined)) {
    const key = t.field === 'session_opts.cwd' ? 'cwd' : t.field === 'mcp_allow' ? 'mcp_allow' : undefined
    const parent = key ? parentThread(config, t.id) : undefined
    if (key && parent?.session_opts?.[key] !== undefined) return `same as ${parent?.id}`
  }
  return (t ? ruleOf(t).show?.(v) : undefined) ?? String(v)
}
export const describeChange = (c: ConfigChange, config?: AgentConfigT): string =>
  `${labelOfPath(c.path)}: ${describeValue(c.path, c.old, config)} → ${describeValue(c.path, c.new, config)}`

/**
 * How to revert, from the old values: "To undo: Timezone back to UTC; archive thread errands." A created thread is undone by
 * archiving it. The old value is shown the way the card showed it.
 */
export function undoText(changes: ReadonlyArray<ConfigChange>, config?: AgentConfigT): string {
  const parts = changes.map((c) => {
    const t = targetOf(c.path)
    if (t?.kind === 'new_thread') return `archive thread ${t.id}`
    // archiving keeps the thread's inbox copies, so un-archiving brings everything back
    if (t?.kind === 'thread_field' && t.field === 'archived' && c.new === true) return `unarchive thread ${t.id}`
    // the agent never turns the lock off: the owner does
    if (c.path === 'settings_lock') return 'turn Lock Talos settings off in Settings'
    // a theme that turns out unreadable still has a way back that needs no reading of the screen
    if (c.path === 'theme')
      return `${labelOfPath(c.path)} back to ${describeValue(c.path, c.old)}, or say "reset the theme"`
    return `${labelOfPath(c.path)} back to ${describeValue(c.path, c.old, config)}`
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
  /** The thread session that proposed it (main: none), recorded in the payload so apply can hold it to the same scope. */
  scope?: string
  /** The config the changes were judged on: only for the words ("same as <parent>" for an inherited folder or list). */
  config?: AgentConfigT
}

/**
 * The card's own risk. Only what this change added is high (a thread session's folder, model or MCP list, and a new thread that
 * sets one); everything that existed before keeps the card risk it had, which was low, because a high card can't be approved from
 * a notification. `riskOfChange` is the table's fuller answer and is not what a card shows.
 */
const CARD_HIGH_FIELDS: readonly ThreadField[] = ['session_opts.cwd', 'model', 'mcp_allow']
const CARD_HIGH_NEW_KEYS = ['session_opts', 'model', 'mcp_allow'] as const
function cardRisk(changes: ReadonlyArray<{ path: string; new: unknown }>): Risk {
  return changes.some((c) => {
    const t = targetOf(c.path)
    if (t?.kind === 'thread_field') return CARD_HIGH_FIELDS.includes(t.field)
    const v = c.new
    return t?.kind === 'new_thread' && typeof v === 'object' && v !== null && CARD_HIGH_NEW_KEYS.some((k) => k in v)
  })
    ? 'high'
    : 'low'
}

/** The card as it is drawn: pending, no editing, revise allowed, old and new of each setting in the body. Hash is set by the caller. */
export function configCardCandidate(i: ConfigCardInput): Omit<CardT, 'payload_hash'> & { payload_hash: string } {
  const one = i.changes.length === 1 ? i.changes[0] : undefined
  const oneTarget = one ? targetOf(one.path) : undefined
  const payload: ConfigCardPayloadT = {
    v: 1,
    base_rev: i.baseRev,
    reason: i.reason,
    ...(i.scope !== undefined ? { scope: i.scope } : {}),
    changes: i.changes,
  }
  return {
    id: i.cardId,
    thread_id: i.threadId,
    kind: 'config',
    title: !one
      ? `Change ${i.changes.length} settings`
      : oneTarget?.kind === 'new_thread'
        ? `Create thread ${oneTarget.id}`
        : `Change ${labelOfPath(one.path).toLowerCase()}`,
    summary: clipUnits(i.reason, 280),
    destination: i.changes.slice(0, 6).map((c) => ({ label: 'Setting', value: labelOfPath(c.path) })),
    body: clipUnits(`${i.changes.map((c) => describeChange(c, i.config)).join('\n')}\n\nWhy: ${i.reason}`, 20_000),
    body_format: 'plain',
    fields: [],
    attachments: [],
    warning: 'Changes a setting on your Mac. You can change it back in Settings.',
    primary_label: 'Apply',
    kill_label: one?.path === 'theme' ? 'Keep current' : 'Keep settings',
    allow_edit: false,
    allow_revise: true,
    risk: cardRisk(i.changes),
    origin: i.origin,
    payload,
    payload_hash: `sha256:${'0'.repeat(64)}`,
    state: 'pending',
    created_at: i.now,
    expires_at: i.expiresAt,
  }
}
