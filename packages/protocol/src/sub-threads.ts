// Sub-threads: a thread may sit under one parent thread (`Thread.parent_id`), one level deep. A sub-thread takes its
// parent's session settings (folder, model, effort, MCP list) unless it sets its own, and its own folder must be inside
// the parent's, which the Mac re-checks on disk at every start. Instructions need no field: a sub-thread's folder is
// inside its parent's, so Claude Code reads the parent's AGENTS.md as well, and an AGENTS.md in the sub-folder adds to
// or overrides it. Nothing here writes or starts anything; the bridge and the app call these on a config.
import {
  canBeDedicated,
  type ThreadSessionModeT,
  type ThreadSessionOptsT,
  threadSessionMode,
} from './thread-sessions.ts'

/**
 * Bridge feature: this Mac accepts `parent_id` writes. The bridge advertises it only while the Mac app reports
 * `supervisor.subthreads_supported` in workers.json, because an older Mac app would start a sub-thread's session
 * without checking that its folder is inside the parent's. The app hides sub-thread controls without it.
 */
export const SUBTHREADS_FEATURE = 'subthreads/1'

type SubThreadLike = {
  id: string
  kind: string
  archived?: boolean
  parent_id?: string | undefined
  session?: ThreadSessionModeT | undefined
  session_opts?: Partial<ThreadSessionOptsT> | undefined
}
type SubConfigLike = { threads: readonly SubThreadLike[] }

/** The settings a sub-thread inherits, in the order the app lists them. */
export const INHERITED_SESSION_KEYS = ['cwd', 'model', 'effort', 'mcp_allow'] as const
export type InheritedSessionKey = (typeof INHERITED_SESSION_KEYS)[number]

/**
 * The live parent of a thread: undefined for a top-level thread, or when the parent is missing, archived, the thread
 * itself, or a sub-thread itself (only a hand edit makes the last two; one level deep means they count as no parent).
 */
export function parentThread<T extends SubThreadLike>(
  config: { threads: readonly T[] },
  threadId: string,
): T | undefined {
  const t = config.threads.find((x) => x.id === threadId)
  if (!t?.parent_id || t.parent_id === threadId) return undefined
  const p = config.threads.find((x) => x.id === t.parent_id)
  return p && !p.archived && !p.parent_id ? p : undefined
}

/** A thread's sub-threads, archived ones included, in config order. */
export function subThreadsOf<T extends SubThreadLike>(config: { threads: readonly T[] }, parentId: string): T[] {
  return config.threads.filter((t) => t.parent_id === parentId && t.id !== parentId)
}

/** Is `value` set, for inheritance? `model: 'inherit'` and an absent key are not; an empty MCP list is (it means "only talos-app"). */
function isOwnSet(opts: Partial<ThreadSessionOptsT> | undefined, key: InheritedSessionKey): boolean {
  const v = opts?.[key]
  if (v === undefined) return false
  return !(key === 'model' && v === 'inherit')
}

export type EffectiveSessionOpts = {
  cwd?: string | undefined
  model: string
  effort?: string | undefined
  mcp_allow?: readonly string[] | undefined
  /** The keys that came from the parent, for the app to label. */
  inherited: InheritedSessionKey[]
  /** Servers on the sub-thread's own list that its parent's list leaves out: not given (a hand edit or an older bridge wrote them). */
  dropped?: string[]
  /** It names a parent that is missing or archived: nothing is inherited and, unless it has its own list, it gets no MCP servers. */
  orphaned?: true
}

/**
 * The folder, model, effort and MCP list in force for a thread: its own value where it set one, else its live
 * parent's. Mac-only and per-thread options (`ops_read`, `idle_park_min`) are never inherited: a sub-thread never gets
 * more than it was given itself.
 */
export function effectiveSessionOpts(config: SubConfigLike, threadId: string): EffectiveSessionOpts {
  const t = config.threads.find((x) => x.id === threadId)
  const own = t?.session_opts
  const p = parentThread(config, threadId)
  const parent = p?.session_opts
  const out: EffectiveSessionOpts = { model: 'inherit', inherited: [] }
  for (const key of INHERITED_SESSION_KEYS) {
    const from = isOwnSet(own, key) ? own : isOwnSet(parent, key) ? parent : undefined
    if (from === undefined) continue
    if (from === parent) out.inherited.push(key)
    ;(out as Record<string, unknown>)[key] = from[key]
  }
  // fail closed: a list it would have inherited must not turn into "every server" because the parent went away
  if (t?.parent_id && !p) {
    out.orphaned = true
    if (t.parent_id === threadId) {
      // a loop: there is no telling what a parent would allow, so not even its own list stands (the Mac app does the same)
      if (out.mcp_allow?.length) out.dropped = [...out.mcp_allow]
      out.mcp_allow = []
    } else if (out.mcp_allow === undefined) out.mcp_allow = []
  }
  // never more than the parent, whoever wrote the config
  const theirs = parent?.mcp_allow
  if (theirs && own?.mcp_allow) {
    const dropped = own.mcp_allow.filter((s) => !theirs.includes(s))
    if (dropped.length > 0) {
      out.mcp_allow = own.mcp_allow.filter((s) => theirs.includes(s))
      out.dropped = dropped
    }
  }
  return out
}

/**
 * Lexical "strictly inside": `child` is below `parent` once trailing slashes go, and has no `.` or `..` segment that
 * could lead back out. The Mac re-checks on resolved paths.
 */
export function folderInside(child: string, parent: string): boolean {
  const p = parent.replace(/\/+$/, '')
  const c = child.replace(/\/+$/, '')
  if (c.split('/').some((seg) => seg === '.' || seg === '..')) return false
  return c.startsWith(`${p}/`)
}

const sameList = (a: readonly string[] | undefined, b: readonly string[] | undefined) =>
  a === b || (a !== undefined && b !== undefined && a.length === b.length && a.every((x, i) => x === b[i]))

/** `after` gives no more than `before`: an MCP list where there was none, or a list with nothing new on it. */
const narrowerList = (before: readonly string[] | undefined, after: readonly string[] | undefined) =>
  after !== undefined && (before === undefined || after.every((s) => before.includes(s)))

/**
 * Only the parent's MCP list changed under this sub-thread, and it only got narrower. That takes access away, so it is
 * never held back for Mac support: an older Mac app ignores `parent_id`, so the parent's list changes nothing it gives the
 * sub-thread, and a newer one gives less.
 */
function onlyParentNarrowed(
  t: SubThreadLike,
  was: SubThreadLike | undefined,
  parentWas: SubThreadLike | undefined,
  parentNow: SubThreadLike | undefined,
): boolean {
  if (!was || !parentWas || !parentNow) return false
  const same = (a: SubThreadLike, b: SubThreadLike) =>
    a.parent_id === b.parent_id &&
    a.session === b.session &&
    !!a.archived === !!b.archived &&
    a.session_opts?.cwd === b.session_opts?.cwd &&
    sameList(a.session_opts?.mcp_allow, b.session_opts?.mcp_allow)
  if (!same(t, was)) return false
  if (!!parentWas.archived !== !!parentNow.archived || parentWas.session_opts?.cwd !== parentNow.session_opts?.cwd)
    return false
  return narrowerList(parentWas.session_opts?.mcp_allow, parentNow.session_opts?.mcp_allow)
}

const trimSlashes = (p: string) => p.replace(/\/+$/, '')

/**
 * A dedicated sub-thread whose folder is an absolute path outside its parent's, and not the parent's own: it keeps its
 * own folder (the Mac checks on disk that it exists), so it does not get the parent's instructions. `..` and `.` segments
 * and relative paths are never an own folder: they are made under the parent, so they stay inside-only.
 */
function keepsOwnFolder(t: SubThreadLike, parent: SubThreadLike | undefined): boolean {
  const cwd = t.session_opts?.cwd
  const parentCwd = parent?.session_opts?.cwd
  if (t.session !== 'dedicated' || !cwd || !parentCwd) return false
  if (!cwd.startsWith('/') || cwd.split('/').some((seg) => seg === '.' || seg === '..')) return false
  if (folderInside(cwd, parentCwd)) return false
  return trimSlashes(cwd) !== trimSlashes(parentCwd)
}

/**
 * Notes for the owner on what a config does to its sub-threads: one line for each live sub-thread with its own session
 * that keeps a folder outside its parent's. Shown beside the change that made it, and on the thread's settings.
 */
export function subThreadWarnings(after: SubConfigLike): string[] {
  const out: string[] = []
  for (const t of after.threads) {
    if (!t.parent_id || t.archived) continue
    const parent = parentThread(after, t.id)
    if (parent && keepsOwnFolder(t, parent))
      out.push(
        `thread "${t.id}" keeps its own folder, so it does not get "${parent.id}"'s instructions; the parent's privacy rules still apply`,
      )
  }
  return out
}

/** Did this change touch the sub-thread fields of `t` (its parent, or the session settings judged against the parent)? */
function touched(
  t: SubThreadLike,
  was: SubThreadLike | undefined,
  parentWas: SubThreadLike | undefined,
  parentNow: SubThreadLike | undefined,
) {
  if (!was) return true
  if (was.parent_id !== t.parent_id || was.session !== t.session || !!was.archived !== !!t.archived) return true
  // the parent was archived, restored or removed under an unchanged child
  if (!!parentWas !== !!parentNow || !!parentWas?.archived !== !!parentNow?.archived) return true
  if (
    was.session_opts?.cwd !== t.session_opts?.cwd ||
    !sameList(was.session_opts?.mcp_allow, t.session_opts?.mcp_allow)
  )
    return true
  // the parent's folder or MCP list moved under an unchanged child
  return (
    parentWas?.session_opts?.cwd !== parentNow?.session_opts?.cwd ||
    !sameList(parentWas?.session_opts?.mcp_allow, parentNow?.session_opts?.mcp_allow)
  )
}

/**
 * Patch-time rule on the exact config the bridge is about to write (`after`) against the one on disk (`before`).
 * Only threads this change touches are judged, so a config that already breaks a rule never blocks unrelated edits.
 * Taking a thread out from under its parent, and archiving a sub-thread, are never refused. `macSupports` is the Mac
 * app's `subthreads_supported`: without it no sub-thread may be created or changed, because an older Mac app would start
 * it without inheritance or the folder check. Returns a reason, or null.
 */
export function subThreadPatchIssue(
  before: SubConfigLike,
  after: SubConfigLike,
  opts: { macSupports: boolean; ownFolder?: boolean },
): string | null {
  const find = (c: SubConfigLike, id: string | undefined) => (id ? c.threads.find((x) => x.id === id) : undefined)
  for (const t of after.threads) {
    if (!t.parent_id) continue
    const was = find(before, t.id)
    const parent = find(after, t.parent_id)
    if (t.archived) continue // an archived sub-thread never runs, so archiving one (alone or with its parent) is never refused
    const parentWas = find(before, t.parent_id)
    if (!touched(t, was, parentWas, parent)) continue
    const label = `thread "${t.id}"`
    // Nothing of the sub-thread changed and its parent only lost servers: never refused, not for Mac support and not for a
    // rule the sub-thread already broke (a hand edit), because effectiveSessionOpts cuts its own list to the parent's
    if (onlyParentNarrowed(t, was, parentWas, parent)) continue
    if (!opts.macSupports) return 'sub-threads need the Talos app on your Mac to be updated first'
    if (t.parent_id === t.id) return `${label} can't be its own parent`
    if (!parent)
      return `${label}: there is no thread "${t.parent_id}"; take it out from under that thread or archive it`
    if (parent.archived)
      return `${label}: the thread "${parent.id}" is archived; archive its sub-threads with it, or take them out first`
    if (parent.kind === 'system') return `${label}: the inbox can't have sub-threads`
    if (t.kind === 'system') return "the inbox can't be a sub-thread"
    if (parent.parent_id) return `${label}: "${parent.id}" is a sub-thread itself; sub-threads go one level deep`
    if (subThreadsOf(after, t.id).length > 0)
      return `${label} has sub-threads of its own, so it can't be a sub-thread; sub-threads go one level deep`
    const cwd = t.session_opts?.cwd
    const parentCwd = parent.session_opts?.cwd
    if (t.session === 'dedicated') {
      if (!cwd) return `${label}: a sub-thread with its own session needs its own folder inside its parent's folder`
      if (!parentCwd) return `${label}: give "${parent.id}" a folder first; a sub-thread's folder goes inside it`
    }
    if (cwd && parentCwd && !folderInside(cwd, parentCwd) && !(opts.ownFolder === true && keepsOwnFolder(t, parent)))
      return `${label}: a sub-thread's folder must be inside its parent's folder`
    const mine = t.session_opts?.mcp_allow
    const theirs = parent.session_opts?.mcp_allow
    if (mine && theirs) {
      const extra = mine.find((s) => !theirs.includes(s))
      if (extra !== undefined)
        return `${label}: "${extra}" is not on its parent's MCP list; a sub-thread gets no more than its parent`
    }
  }
  return null
}

// ---- who answers a sub-thread, and where a lead may post -----------------------------------------------------------------

type LeadConfigLike = SubConfigLike & { default_thread: string; dedicated?: unknown }

/**
 * The thread whose own session (lead) answers `threadId`: the thread itself when it has its own session, else its live
 * parent when that has one, else none (the main session answers). Config only; whether that session is reachable is the
 * router's question.
 */
export function leadThreadFor(config: LeadConfigLike, threadId: string): string | undefined {
  if (threadSessionMode(config, threadId) === 'dedicated') return threadId
  const t = config.threads.find((x) => x.id === threadId)
  if (!t || t.archived) return undefined
  // main's front doors (the default thread, general, inbox, system threads) are main's, whatever their parent
  if (!canBeDedicated(config, threadId)) return undefined
  const p = parentThread(config, threadId)
  return p && threadSessionMode(config, p.id) === 'dedicated' ? p.id : undefined
}

/**
 * Where the lead of `leadThread` may post (reply, cards, status, receipts): its own thread and the live sub-threads it
 * answers (those without a lead of their own). A sub-thread with its own lead is that lead's alone. Empty when the thread
 * has no session of its own.
 */
export function leadPostThreads(config: LeadConfigLike, leadThread: string): string[] {
  if (threadSessionMode(config, leadThread) !== 'dedicated') return []
  const subs = subThreadsOf(config, leadThread).filter((s) => leadThreadFor(config, s.id) === leadThread)
  return [leadThread, ...subs.map((s) => s.id)]
}

/** What the lead of `leadThread` may read: its own thread and every sub-thread under it, led or not, archived or not. */
export function leadReadThreads(config: LeadConfigLike, leadThread: string): string[] {
  if (threadSessionMode(config, leadThread) !== 'dedicated') return []
  const t = config.threads.find((x) => x.id === leadThread)
  if (!t || (t.parent_id && t.parent_id !== leadThread)) return [leadThread] // a sub-thread's lead reads only its own
  // main's front doors are never a lead's to read, whatever their parent
  return [
    leadThread,
    ...subThreadsOf(config, leadThread)
      .filter((s) => canBeDedicated(config, s.id) || s.archived)
      .map((s) => s.id),
  ]
}
