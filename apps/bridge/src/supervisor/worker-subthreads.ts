// Sub-threads for the Linux supervisor (P3d5, part A): the Mac's SubThreads.swift, rule for rule, on config.json as read (raw
// JSON, not the protocol's parsed shape), so a value a hand edit garbled is decided the way the Mac's launcher decides it.
//
// A sub-thread is a thread with a `parent_id`. Its folder, model and effort come from its own `session_opts`, else from its live
// parent's. Its MCP list is its own list limited to its parent's (own ∩ parent; no list on one side is no limit from it), or its
// parent's when it has none. Only one level is followed: a parent that itself has a parent, an archived or missing parent, and a
// `parent_id` that cannot be read all count as no parent (the sub-thread keeps its own list, and with none gets the empty list).
// `ops_read` and `idle_park_min` are never inherited. The permission ceiling is Main's, never the parent's (workers-wiring.ts).
// Pure: nothing here reads the disk.
import { folderSame, McpAllowList, ThreadId, WorkerEffort, WorkerModel } from '@talos-app/protocol'

type Raw = Record<string, unknown>

export type SubOpts = {
  cwd?: string
  model?: string
  effort?: string
  /** undefined: no list (the session gets what Claude Code gives it); a list, even empty: only those. */
  mcpAllow?: string[]
  /** Which of cwd, model, effort, mcp_allow came from the parent, in that order. */
  inherited: string[]
  /** Names on the sub-thread's own MCP list that its parent's list does not have: left out of `mcpAllow`. */
  dropped: string[]
  /** A model or effort the thread sets that is not valid (read as not set), by name, with the value as a short plain string. */
  unreadable: Record<string, string>
  /** A cwd the thread sets that is present, not null and not text: the value shown. The folder is then refused, never inherited. */
  cwdUnreadable?: string
}

export type SubLaunch = {
  parentId: string
  /** The live parent's own folder; null when the sub-thread cannot start (see `refusal`). */
  parentCwd: string | null
  /** The sub-thread sets its own folder, not the parent's: it must be inside the parent's (made when missing) or an existing one outside. */
  ownCwd: boolean
  /** It runs in its parent's folder (the agent folder when the parent has none): it names none, or the parent's own. */
  shares: boolean
  inherited: string[]
  dropped: string[]
  /** The sub-thread's own model and effort settings that were not valid, by name, with the value. */
  unreadable: Record<string, string>
  /** Why this session cannot start, when it cannot. */
  refusal: string | null
}

const isObject = (v: unknown): v is Raw => typeof v === 'object' && v !== null && !Array.isArray(v)
const present = (v: unknown) => v !== undefined && v !== null

/**
 * A value as a short, printable string for a message (Swift's `shown`): text as is; a one-item list or one-key object by its
 * item or key; a number (a JSON true/false reads as the NSNumber 1/0 there); anything else as JSON. Control characters become
 * spaces; at most 40 characters.
 */
export function shown(v: unknown): string {
  let text: string
  if (typeof v === 'string') text = v
  else if (Array.isArray(v) && v.length === 1) text = shown(v[0])
  else if (isObject(v) && Object.keys(v).length === 1) text = Object.keys(v)[0] as string
  else if (typeof v === 'boolean') text = v ? '1' : '0'
  else if (typeof v === 'number') text = String(v)
  else text = JSON.stringify(v) ?? String(v)
  text = [...text]
    .map((c) => ((c.codePointAt(0) as number) < 0x20 || (c.codePointAt(0) as number) === 0x7f ? ' ' : c))
    .join('')
  return [...new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(text)]
    .slice(0, 40)
    .map((s) => s.segment)
    .join('')
}

/** A list as read: absent is no list; a value that cannot be read is the empty list, never "no list" (McpAllow.read). */
function readList(raw: unknown): string[] | undefined {
  if (raw === undefined) return undefined
  const r = McpAllowList.safeParse(raw)
  if (!r.success) return []
  // a name twice is a list that cannot be read; Swift's Set compares names by canonical equivalence, so two spellings of one
  // name (NFC and NFD, or U+037E and ';') are the same name there: the list fails closed there, and here too
  return new Set(r.data.map((n) => n.normalize('NFC'))).size === r.data.length ? r.data : []
}

/**
 * What the thread itself sets. A session_opts that is present but not an object, or a list that cannot be read, is the empty
 * MCP list, never "no list". A model of `inherit` is not set. A model or effort that is not valid is not set, and is said in
 * `unreadable`.
 */
export function ownOpts(t: Raw): SubOpts {
  const raw = t.session_opts
  const broken = present(raw) && !isObject(raw)
  const o: Raw = isObject(raw) ? raw : {}
  const list = broken ? [] : readList(o.mcp_allow)
  const out: SubOpts = { inherited: [], dropped: [], unreadable: {}, ...(list !== undefined ? { mcpAllow: list } : {}) }
  if (broken) return { ...out, cwdUnreadable: shown(raw) }
  if (present(o.cwd)) {
    if (typeof o.cwd === 'string') out.cwd = o.cwd
    else out.cwdUnreadable = shown(o.cwd)
  }
  if (present(o.model) && o.model !== 'inherit') {
    if (typeof o.model === 'string' && WorkerModel.safeParse(o.model).success) out.model = o.model
    else out.unreadable.model = shown(o.model)
  }
  if (present(o.effort)) {
    if (typeof o.effort === 'string' && WorkerEffort.safeParse(o.effort).success) out.effort = o.effort
    else out.unreadable.effort = shown(o.effort)
  }
  return out
}

/** Archived: anything but false or absent (as in the protocol), a number by its whole part. */
function isArchived(v: unknown): boolean {
  if (v === undefined || v === null) return false
  if (typeof v === 'boolean') return v
  if (typeof v === 'number') return Math.trunc(v) !== 0
  if (typeof v === 'string') return v !== ''
  return true
}

type Link = { kind: 'none' } | { kind: 'live'; parent: Raw } | { kind: 'orphan'; why: string } | { kind: 'broken' }

function link(t: Raw, threads: readonly Raw[]): Link {
  const raw = t.parent_id
  if (!present(raw)) return { kind: 'none' }
  if (typeof raw !== 'string' || !ThreadId.safeParse(raw).success) return { kind: 'broken' }
  // its own parent: no telling what a parent would allow, so not even its own list stands
  if (raw === t.id) return { kind: 'broken' }
  // the first thread with that id; gone if it is archived
  const p = threads.find((x) => isObject(x) && x.id === raw)
  if (!p || isArchived(p.archived)) return { kind: 'orphan', why: 'the parent thread is not there any more' }
  if (present(p.parent_id)) return { kind: 'orphan', why: 'the parent thread is itself a sub-thread' }
  return { kind: 'live', parent: p }
}

/** `t`'s options after inheritance. */
export function effectiveOpts(t: Raw, threads: readonly Raw[]): SubOpts {
  const out = ownOpts(t)
  const l = link(t, threads)
  if (l.kind === 'broken') {
    // cannot tell what the parent allows: nothing
    out.dropped = out.mcpAllow ?? []
    out.mcpAllow = []
  } else if (l.kind === 'orphan') {
    if (out.mcpAllow === undefined) out.mcpAllow = []
  } else if (l.kind === 'live') {
    const up = ownOpts(l.parent)
    if (out.cwd === undefined && out.cwdUnreadable === undefined && up.cwd !== undefined) {
      out.cwd = up.cwd
      out.inherited.push('cwd')
    }
    if (out.model === undefined && up.model !== undefined) {
      out.model = up.model
      out.inherited.push('model')
    }
    if (out.effort === undefined && up.effort !== undefined) {
      out.effort = up.effort
      out.inherited.push('effort')
    }
    const mine = out.mcpAllow
    const theirs = up.mcpAllow
    if (mine === undefined && theirs !== undefined) {
      out.mcpAllow = theirs
      out.inherited.push('mcp_allow')
    } else if (mine !== undefined && theirs !== undefined) {
      out.mcpAllow = mine.filter((s) => theirs.includes(s))
      out.dropped = mine.filter((s) => !theirs.includes(s))
    }
  }
  return out
}

/**
 * Null for a thread with no parent_id (one that cannot be read is a sub-thread with no live parent, never "not a sub-thread").
 * A dedicated sub-thread has a folder of its own inside its parent's, or none, or the parent's own: with none or the same it
 * `shares` the parent's folder (`subthreads_shared_folder`), so a session there is never made, fenced or judged "outside".
 */
export function subLaunch(t: Raw, threads: readonly Raw[]): SubLaunch | null {
  const raw = t.parent_id
  if (!present(raw)) return null
  const mine = ownOpts(t)
  const eff = effectiveOpts(t, threads)
  let parentCwd: string | null = null
  let refusal: string | null = null
  let shares = false
  if (mine.cwdUnreadable !== undefined) {
    refusal = `the sub-thread's folder setting can't be read (${mine.cwdUnreadable}): it must be a path`
  } else {
    const l = link(t, threads)
    if (l.kind === 'live') {
      const up = ownOpts(l.parent)
      parentCwd = up.cwd ?? null
      // a parent whose folder setting cannot be read is refused itself: a child must not fall back to the agent folder (Main's)
      if (up.cwdUnreadable !== undefined)
        refusal = `the parent thread's folder setting can't be read (${up.cwdUnreadable}): fix it, so the sub-thread has a folder to follow`
      else if (mine.cwd === undefined) shares = true
      else if (parentCwd === null) refusal = 'the parent thread has no folder: give the parent a folder first'
      else shares = folderSame(mine.cwd, parentCwd)
    } else if (l.kind === 'orphan') {
      refusal = `${l.why}, so the sub-thread's folder has nothing to be inside`
    } else {
      refusal = "the sub-thread's parent can't be read, so its folder has nothing to be inside"
    }
  }
  return {
    parentId: typeof raw === 'string' ? raw : '',
    parentCwd,
    ownCwd: mine.cwd !== undefined && !shares,
    shares,
    inherited: eff.inherited,
    dropped: eff.dropped,
    unreadable: mine.unreadable,
    refusal,
  }
}
