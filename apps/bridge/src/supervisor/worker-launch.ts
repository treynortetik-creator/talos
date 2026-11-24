// What a running thread session was started with against its thread's settings now (P3d4, part 2; the Mac's LaunchChange.swift and
// WorkerLaunchChange.swift). Each start records its launch (the entry's `launched`); each tick the manager compares it with the
// thread's folder, model, effort and MCP list. A difference that has stood, unchanged, for launch_change_settle_s restarts the
// session through the normal park after its turn: a new folder starts a fresh conversation there, the rest resume the same one.
// Pure but for the folder's realpath; workers.ts acts on what this decides.
import { realpathSync } from 'node:fs'
import { WORKER_TIMING, WorkerLaunched, type WorkerLaunchedT } from '@talos-app/protocol'
import { osSandboxRecheck, SWITCH_UNREADABLE_NOTE } from '../guards/os-sandbox.ts'
import { subThreadFence, subThreadTarget } from './worker-policy.ts'
import type { UnreadOpt, WorkerRuntime, WorkerThread } from './worker-types.ts'

/**
 * What a launch is made from. The list is sorted (compared as a set); null is no list, which differs from an empty one. A cwd of
 * null is a folder that cannot be known now (not resolvable, or session_opts that cannot be read): never compared.
 */
export type LaunchSig = { cwd: string | null; model: string; effort: string | null; mcpAllow: string[] | null }

export type LaunchChange =
  | { kind: 'none' }
  | { kind: 'restart'; wanted: LaunchSig; changed: Array<'model' | 'effort' | 'mcp_allow'> }
  | { kind: 'fresh'; wanted: LaunchSig }

/** A change waiting out its settle time (monotonic seconds). */
export type LaunchDebounce = { pending: LaunchChange | null; since: number }
export const NO_CHANGE_PENDING: LaunchDebounce = { pending: null, since: 0 }

/**
 * The folder a thread's session would start in now, resolved as the planner resolves it; null when it cannot be resolved (a mount
 * not up yet, a folder renamed): a transient failure is not a new folder, and the start says what is wrong with it.
 */
export function wantedFolder(cwd: string): string | null {
  try {
    return realpathSync(cwd)
  } catch {
    return null
  }
}

const sorted = (l: readonly string[] | undefined | null): string[] | null => (l ? [...l].sort() : null)
const sameList = (a: string[] | null, b: string[] | null) => JSON.stringify(a) === JSON.stringify(b)

/** A launch field whose configured value cannot be read: its default stands in, and is never compared. */
export function unread(t: Pick<WorkerThread, 'optsUnread'>, f: Exclude<UnreadOpt, 'session_opts'>): boolean {
  return t.optsUnread !== undefined && (t.optsUnread.includes('session_opts') || t.optsUnread.includes(f))
}

export function wantedLaunch(t: WorkerThread, real: (cwd: string) => string | null = wantedFolder): LaunchSig {
  return {
    cwd: unread(t, 'cwd') ? null : real(t.cwd),
    model: t.model,
    effort: t.effort ?? null,
    mcpAllow: sorted(t.mcpAllow),
  }
}

/**
 * No record of the launch (an entry an older build wrote) is never a change: the next start records it. A session option that
 * cannot be read (the folder, the model, the effort, or all of them) is its default, not the owner's setting, and restarts
 * nothing; the MCP list is always compared (one that cannot be read is the empty list: a narrowing is never put off).
 */
export function compareLaunch(
  launched: WorkerLaunchedT | undefined,
  wanted: LaunchSig,
  t: Pick<WorkerThread, 'optsUnread'> = {},
): LaunchChange {
  if (!launched) return { kind: 'none' }
  if (wanted.cwd !== null && launched.cwd !== wanted.cwd) return { kind: 'fresh', wanted }
  const changed: Array<'model' | 'effort' | 'mcp_allow'> = []
  if (!unread(t, 'model') && launched.model !== wanted.model) changed.push('model')
  if (!unread(t, 'effort') && (launched.effort ?? null) !== wanted.effort) changed.push('effort')
  if (!sameList(sorted(launched.mcp_allow), wanted.mcpAllow)) changed.push('mcp_allow')
  return changed.length === 0 ? { kind: 'none' } : { kind: 'restart', wanted, changed }
}

const same = (a: LaunchChange | null, b: LaunchChange) => JSON.stringify(a) === JSON.stringify(b)

/**
 * A change is acted on once it has stood, unchanged, for `settle` seconds, and then once (the wait starts again). A different
 * change starts the wait again; no change forgets it, so a change back before the settle passes restarts nothing.
 */
export function observeChange(
  d: LaunchDebounce,
  change: LaunchChange,
  t: number,
  settle: number = WORKER_TIMING.launch_change_settle_s,
): { state: LaunchDebounce; fire: LaunchChange | null } {
  if (change.kind === 'none') return { state: NO_CHANGE_PENDING, fire: null }
  if (!same(d.pending, change)) return { state: { pending: change, since: t }, fire: null }
  if (t - d.since < settle) return { state: d, fire: null }
  return { state: NO_CHANGE_PENDING, fire: change }
}

/**
 * What a start records: the folder it launched in (resolved), and the thread's model, effort and list as configured (names that
 * were not found included: it is compared with the config, not with the file). A value the schema would read differently is not
 * recorded at all: a record that never matches the settings would restart the session for good.
 */
export function launchedRecord(
  t: WorkerThread,
  cwd: string,
  /** The launch's spec hash and instructions digest (launch-spec.ts), as the plan gave them; none: the plan gave none. */
  hashes: { specHash?: string; instructionsHash?: string } = {},
  /** The spec an update restart was tried for, kept across the start it gave (update-restart.ts: never a second try). */
  updateTriedHash?: string,
): WorkerLaunchedT | undefined {
  const raw = {
    cwd,
    model: t.model,
    ...(t.effort ? { effort: t.effort } : {}),
    ...(t.mcpAllow !== undefined ? { mcp_allow: [...t.mcpAllow] } : {}),
    // the launch's spec hash, for restart-on-update (launch-spec.ts); none when the plan gave none
    ...(hashes.specHash !== undefined ? { spec_hash: hashes.specHash } : {}),
    ...(hashes.instructionsHash !== undefined ? { instructions_hash: hashes.instructionsHash } : {}),
    ...(updateTriedHash !== undefined ? { update_tried_hash: updateTriedHash } : {}),
  }
  const r = WorkerLaunched.safeParse(raw)
  if (!r.success) return undefined
  return compareLaunch(
    r.data,
    wantedLaunch(t, () => cwd),
  ).kind === 'none'
    ? r.data
    : undefined
}

/**
 * The folder the conversation was last launched in: the record's, or, for an entry an older build wrote, the entry's own cwd (every
 * start set it to the folder it launched in, resolved). None for an entry that never had a session.
 */
export function lastFolder(entry: {
  launched?: WorkerLaunchedT
  cwd: string
  session_id: string | null
}): string | null {
  if (entry.session_id === null) return null
  return entry.launched?.cwd ?? entry.cwd
}

/**
 * A start that resumes would resume in a folder other than the one its conversation was in (the folder changed while the session
 * was not running, or the change was seen only now): its transcript is not there, so the start is a fresh one in the new folder.
 * A folder that cannot be resolved, or none known for the conversation, is never a change.
 */
export function folderMoved(last: string | null, folder: string | null): boolean {
  return last !== null && folder !== null && last !== folder
}

/**
 * Stuck: its turn never ends by itself (a start not done, a dialog or a prompt on screen, a start held for a slot), so a restart
 * is at once rather than after the turn. The prompt PromptWatch is watching counts, as it does for the idle park.
 */
export function stuck(w: WorkerRuntime): boolean {
  return (
    w.entry.state === 'starting' ||
    w.notes.needsYou !== null ||
    w.notes.promptWatch.current !== null ||
    w.entry.dialog !== undefined ||
    w.held !== null
  )
}

/**
 * One tick's look at one worker (the Mac's checkLaunchChanges): what to do now, if anything. Only a running session (live or busy,
 * not still being adopted, still dedicated) is compared; anything else forgets a pending change, so a restart already on its way
 * (stopping, parking) never gets a second one, and a session that is not running takes the settings at its next start.
 */
export function launchCheck(
  w: WorkerRuntime,
  thread: WorkerThread | undefined,
  o: { pending: boolean; now: number; real?: (cwd: string) => string | null },
): Exclude<LaunchChange, { kind: 'none' }> | null {
  const s = w.entry.state
  if (o.pending || !thread || (s !== 'live' && s !== 'busy')) {
    w.launchChange = NO_CHANGE_PENDING
    return null
  }
  const wanted = wantedLaunch(thread, o.real)
  const change = compareLaunch(w.entry.launched, wanted, thread)
  const r = observeChange(w.launchChange, change, o.now)
  w.launchChange = r.state
  return r.fire && r.fire.kind !== 'none' ? r.fire : null
}

/**
 * A running sub-thread whose settings now refuse a start (its parent archived or gone, its folder setting unreadable), or whose
 * folder is no longer strictly inside its parent's (the parent moved; the folder fence, read from disk each time): parked
 * after its turn once that has stood for launch_change_settle_s, so a session the rules would not start does not run on until
 * its next start (which is refused, with the reason). The Mac does the same (1a9ee1b2). 'wait' while it
 * settles, and no launch change is looked at meanwhile (no restart for a session that is going down for good).
 */
export function refusedSubCheck(
  w: WorkerRuntime,
  thread: WorkerThread | undefined,
  o: {
    pending: boolean
    now: number
    since: Map<string, number>
    /** Why the sub-thread's own folder is not (or can no longer be) strictly inside its parent's now, as on disk; null when it is. */
    fence?: (t: WorkerThread, w: WorkerRuntime) => string | null
  },
): 'none' | 'wait' | 'park' {
  const s = w.entry.state
  const running = !o.pending && thread?.sub !== undefined && (s === 'live' || s === 'busy') && !w.turnWait
  // refused by its settings, or by the folder fence (the parent moved, and the sub-thread's folder is no longer inside its
  // folder); the fence reads the disk, so only for a session that is running
  const refused = running
    ? (thread?.sub?.refusal ??
      (thread?.sub?.ownCwd && thread.parentCwd !== null ? (o.fence?.(thread, w) ?? null) : null))
    : null
  if (!refused) {
    o.since.delete(w.id)
    return 'none'
  }
  w.launchChange = NO_CHANGE_PENDING
  const since = o.since.get(w.id) ?? o.now
  o.since.set(w.id, since)
  if (o.now - since < WORKER_TIMING.launch_change_settle_s) return 'wait'
  o.since.delete(w.id)
  return 'park'
}

/**
 * The folder fence for a running sub-thread: its folder as configured and, with no record of its launch (an older build's
 * entry), the folder it really runs in, each firmly outside the parent's; or a parent folder no session may use (as a start
 * would refuse). A folder that cannot be resolved for a moment is no verdict: never a reason to stop a session that runs.
 */
export function subFenceProblem(
  t: WorkerThread,
  w: WorkerRuntime,
  parentFolderProblem?: (parentCwd: string) => string | null,
): string | null {
  const parent = t.parentCwd
  if (parent === null) return null
  const folders = w.entry.launched ? [t.cwd] : [t.cwd, w.entry.cwd]
  if (folders.some((f) => subThreadFence(f, parent) === 'outside'))
    return "the sub-thread's folder must be inside its parent thread's folder"
  const why = parentFolderProblem?.(parent) ?? null
  return why ? `the parent's folder: ${why}` : null
}

/**
 * The folder a thread's next start launches in, resolved (`real`: the manager's seam, else wantedFolder). A sub-thread's own
 * folder not made yet is where the planner will make it (inside its parent's), never "unknown": a change to a new subfolder is a
 * change of folder, as on the Mac.
 */
export function folderOf(t: WorkerThread, real: ((cwd: string) => string | null) | undefined): string | null {
  const r = (real ?? wantedFolder)(t.cwd)
  if (r !== null || !t.sub?.ownCwd || t.parentCwd === null) return r
  return subThreadTarget(t.cwd, t.parentCwd)
}

/**
 * Are `a` and `b` one family for the folder claim: a parent and a dedicated sub-thread of its that shares its folder, or two such
 * sub-threads of one parent? The folder claimed is then the parent's effective folder (a sharing sub-thread's `cwd` is that
 * folder); a sub-thread with a subfolder of its own, a pair of different parents, and any unrelated pair are not.
 */
export function inOneFamily(a: WorkerThread, known: readonly WorkerThread[], otherId: string): boolean {
  const b = known.find((x) => x.id === otherId)
  if (!b || a.id === b.id) return false
  const pa = a.sub?.shares && !a.sub.refusal ? a.sub.parentId : undefined
  const pb = b.sub?.shares && !b.sub.refusal ? b.sub.parentId : undefined
  return (pa !== undefined && (pa === b.id || pa === pb)) || (pb !== undefined && pb === a.id)
}

/** One start's launch; with the extra lock on it carries the check the host runs as its last step before the process starts. */
export function workerLaunch(
  thread: string,
  argv: string[],
  spec: { cwd: string; env: Record<string, string> },
  lock: { home: string; folder: string } | null,
  unreadable = false,
) {
  return {
    launch: {
      session: `t-${thread}`,
      argv,
      cwd: spec.cwd,
      env: spec.env,
      ...(lock ? { beforeStart: osSandboxRecheck(lock.home, lock.folder) } : {}),
    },
    ...(unreadable ? { lockNote: SWITCH_UNREADABLE_NOTE } : {}),
  }
}
