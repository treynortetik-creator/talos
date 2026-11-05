// Subagent activity panel, protocol half (docs/SUBAGENTS.md, WP-A0). One snapshot of the session's subagents, teammates,
// background shells and monitors, built by the Talos mod, checked and size-trimmed by the bridge, kept IN MEMORY ONLY by
// the relay (like session.state) and drawn by the app. Outbound models are strict; engine data is parsed leniently by
// agentRowsFromEngine. Every string passes through oneLine(). Nothing here is ever persisted or pushed.
import { z } from 'zod'
import { IsoTs } from './ids.ts'
import type { SessionStateT } from './session.ts'

export const AGENT_LIMITS = {
  /** Rows per snapshot. */
  rows: 50,
  /** `recent` lines per row. */
  recent: 8,
  /** Characters per one-line text (title, activity, recent line). */
  text: 160,
  /** UTF-8 bytes of the serialized snapshot in a `session.agents` frame (and in `ready.session_agents`). */
  frameBytes: 64_000,
  /** Ended rows leave the panel (and the mod's tracker) this long after they end. */
  keepEndedMs: 600_000,
} as const

/** The relay feature (`ready.features`) that says it passes `session.agents` on. The bridge sends none without it. */
export const AGENTS_FEATURE = 'agents/1'
/** A live mod's unchanged snapshot is re-sent this often, so a restarted relay refills `ready` (as session.state). */
export const AGENTS_HEARTBEAT_MS = 10_000
/** The bridge sends `session.agents` at most this often (trailing edge: the latest change always goes out). */
export const AGENTS_EMIT_INTERVAL_MS = 2_000
/** The mod reads the subagent status line tee's file only when it is younger than this. */
export const AGENTS_TEE_FRESH_MS = 12_000
/** The mod's tracker holds at most this many task ids. */
export const AGENTS_TRACKER_MAX_IDS = 100

export const AgentKind = z.enum(['subagent', 'teammate', 'shell', 'monitor', 'workflow', 'remote'])
export type AgentKindT = z.infer<typeof AgentKind>
export const AgentRunStatus = z.enum([
  'pending',
  'running',
  'waiting',
  'idle',
  'completed',
  'failed',
  'killed',
  'unknown',
])
export type AgentRunStatusT = z.infer<typeof AgentRunStatus>

/** Still going: Stop can apply, the chip counts it (`pending` is live but not counted, see agentCounts). */
export const AGENT_LIVE_STATUSES = [
  'pending',
  'running',
  'waiting',
  'idle',
] as const satisfies readonly AgentRunStatusT[]
export const AGENT_ENDED_STATUSES = ['completed', 'failed', 'killed'] as const satisfies readonly AgentRunStatusT[]
export const isLiveAgentStatus = (s: string): boolean => (AGENT_LIVE_STATUSES as readonly string[]).includes(s)
export const isEndedAgentStatus = (s: string): boolean => (AGENT_ENDED_STATUSES as readonly string[]).includes(s)

// C0 and C1 controls, line/paragraph separators and bidi overrides/isolates: none belong in a one-line panel text.
// biome-ignore lint/suspicious/noControlCharactersInRegex: rejecting control characters is the point
const CONTROL_CHARS = /[\u0000-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069]/
// biome-ignore lint/suspicious/noControlCharactersInRegex: stripping control characters is the point
const CONTROL_CHARS_G = /[\u0000-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069]/g

/** One line of at most `max` characters, no control characters. The outbound schema refuses anything else. */
const lineOf = (max: number) =>
  z
    .string()
    .max(max)
    .refine((s) => !CONTROL_CHARS.test(s), { message: 'control characters are not allowed' })
const Line = lineOf(AGENT_LIMITS.text)

/**
 * Makes any engine string safe for the panel: control characters become spaces, runs of whitespace collapse to one
 * space, the ends are trimmed, and anything longer than `max` is clipped to `max` characters ending in `…` (never in the
 * middle of a surrogate pair). A non-string is `undefined`; an all-blank string is `''`.
 */
export function oneLine(v: unknown, max: number = AGENT_LIMITS.text): string | undefined {
  if (typeof v !== 'string') return undefined
  const s = v.replace(CONTROL_CHARS_G, ' ').replace(/\s+/g, ' ').trim()
  if (s.length <= max) return s
  if (max <= 1) return max === 1 ? '…' : ''
  let cut = max - 1
  const c = s.charCodeAt(cut - 1)
  if (c >= 0xd800 && c <= 0xdbff) cut-- // don't leave half a surrogate pair
  return `${s.slice(0, cut).trimEnd()}…`
}

export const AgentRecentLine = z.strictObject({ at: IsoTs, text: Line })
export type AgentRecentLineT = z.infer<typeof AgentRecentLine>

/** A task id: a `TaskStop` target and a UI key, so the same one-line rule as every other string. */
const AgentId = lineOf(80).pipe(z.string().min(1))

export const AgentRow = z.strictObject({
  id: AgentId,
  kind: AgentKind,
  /** Agent type ('Explore', 'general-purpose'), or 'shell' / 'monitor'. */
  type: lineOf(64),
  /** The name a teammate or a named subagent answers to (SendMessage). */
  name: lineOf(64).optional(),
  /** The Agent call's description, or the shell's description. */
  title: Line,
  status: AgentRunStatus,
  /** The one-line "now" text. */
  activity: Line.optional(),
  /** 'summary' = the CLI's own progress line (the subagent status line tee); 'tool' = built from the latest tool call. */
  activity_source: z.enum(['summary', 'tool']).optional(),
  parent_id: AgentId.optional(),
  model: lineOf(80).optional(),
  tokens: z.number().int().nonnegative().optional(),
  started_at: IsoTs.optional(),
  ended_at: IsoTs.optional(),
  background: z.boolean().default(false),
  /** The `agent_stop` capability is present AND the row is live. Computed by the mod, never taken from the engine. */
  stoppable: z.boolean().default(false),
  recent: z.array(AgentRecentLine).max(AGENT_LIMITS.recent).default([]),
})
export type AgentRowT = z.infer<typeof AgentRow>

export const AgentsSource = z.enum(['mod', 'mod+tee'])
export type AgentsSourceT = z.infer<typeof AgentsSource>

/**
 * What the mod sends in `talos_mod_sync.agents` and what the bridge validates. It may be over the frame cap (the schema
 * caps allow about 80 KB of plain text and more with multi-byte characters): the bridge trims it with
 * trimAgentsSnapshot() before sending. The frame schema (CappedAgentsSnapshot) refuses an untrimmed one.
 */
export const AgentsSnapshot = z.strictObject({
  session_id: z.string().min(1).max(64),
  source: AgentsSource,
  /**
   * The mod can run `agent_stop` (its `TaskStop` probe passed). It lives here, not in `session.state` capabilities,
   * because old apps and relays refuse a state with a capability they don't know (SESSION_CAPABILITIES_V1).
   */
  can_stop: z.boolean().default(false),
  rows: z.array(AgentRow).max(AGENT_LIMITS.rows),
  at: IsoTs,
})
export type AgentsSnapshotT = z.infer<typeof AgentsSnapshot>

const utf8 = new TextEncoder()
/** UTF-8 bytes of the snapshot as JSON: the measure behind AGENT_LIMITS.frameBytes. */
export function agentsSnapshotBytes(s: unknown): number {
  return utf8.encode(JSON.stringify(s)).length
}

/** The snapshot as it travels in `session.agents` and `ready.session_agents`: over AGENT_LIMITS.frameBytes is refused. */
export const CappedAgentsSnapshot = AgentsSnapshot.refine((s) => agentsSnapshotBytes(s) <= AGENT_LIMITS.frameBytes, {
  message: `agents snapshot over ${AGENT_LIMITS.frameBytes} bytes: trim it first`,
})

// ---- trimming (the bridge, before every send) -------------------------------------------------------------------

const t = (iso: string | undefined) => (iso ? Date.parse(iso) : Number.NEGATIVE_INFINITY)
const oldestFirst = (key: (r: AgentRowT) => number) => (a: AgentRowT, b: AgentRowT) => key(a) - key(b)

export type AgentsTrimResult = { snapshot: AgentsSnapshotT; trimmed: boolean; bytes: number }

/**
 * Makes a valid snapshot fit `maxBytes` (default AGENT_LIMITS.frameBytes). While it is over, in this order, one row at
 * a time and oldest first: (1) empty `recent` on ended rows; (2) empty `recent` on the other rows (running, waiting,
 * idle, pending, unknown; oldest `started_at` first); (3) drop ended rows (oldest `ended_at` first). If it is somehow
 * still over (only possible with long multi-byte text in every field), (4) drop the oldest remaining rows. Never
 * mutates the input. The result always fits.
 */
export function trimAgentsSnapshot(
  snap: AgentsSnapshotT,
  maxBytes: number = AGENT_LIMITS.frameBytes,
): AgentsTrimResult {
  let bytes = agentsSnapshotBytes(snap)
  if (bytes <= maxBytes) return { snapshot: snap, trimmed: false, bytes }
  const rows: AgentRowT[] = snap.rows.map((r) => ({ ...r }))
  const out: AgentsSnapshotT = { ...snap, rows }
  const fits = () => {
    bytes = agentsSnapshotBytes(out)
    return bytes <= maxBytes
  }
  const ended = (r: AgentRowT) => isEndedAgentStatus(r.status)
  const endedAt = (r: AgentRowT) => t(r.ended_at ?? r.started_at)
  const startedAt = (r: AgentRowT) => t(r.started_at)
  // (1) and (2): empty `recent`, ended rows first
  for (const pick of [ended, (r: AgentRowT) => !ended(r)]) {
    const order = rows
      .filter((r) => pick(r) && r.recent.length > 0)
      .sort(oldestFirst(pick === ended ? endedAt : startedAt))
    for (const r of order) {
      r.recent = []
      if (fits()) return { snapshot: out, trimmed: true, bytes }
    }
  }
  // (3) drop ended rows, then (4) anything, oldest first
  for (const pick of [ended, () => true]) {
    const order = rows.filter(pick).sort(oldestFirst(pick === ended ? endedAt : startedAt))
    for (const r of order) {
      rows.splice(rows.indexOf(r), 1)
      if (fits()) return { snapshot: out, trimmed: true, bytes }
    }
  }
  fits()
  return { snapshot: out, trimmed: true, bytes }
}

// ---- helpers the bridge and the app share -----------------------------------------------------------------------

/** Same rows, same session, same source; `at` ignored. The bridge emits only when this is false. */
export function sameAgentsSnapshot(a: AgentsSnapshotT | undefined, b: AgentsSnapshotT | undefined): boolean {
  if (!a || !b) return a === b
  const { at: _a, ...x } = a
  const { at: _b, ...y } = b
  return JSON.stringify(x) === JSON.stringify(y)
}

/** `session.end`, or a new session: no rows. */
export function emptyAgentsSnapshot(session_id: string, at: string, source: AgentsSourceT = 'mod'): AgentsSnapshotT {
  return { session_id, source, can_stop: false, rows: [], at }
}

/** The mod lapsed: every row that was not ended becomes `unknown` and loses Stop. Ended rows are kept as they were. */
export function markAgentsUnknown(snap: AgentsSnapshotT, at: string): AgentsSnapshotT {
  return {
    ...snap,
    can_stop: false,
    rows: snap.rows.map((r) => (isEndedAgentStatus(r.status) ? r : { ...r, status: 'unknown', stoppable: false })),
    at,
  }
}

/**
 * The chip count: running + waiting + idle (pending rows are not yet doing anything; ended and unknown rows are not
 * counted). `busy` = at least one row is running (the chip pulses).
 */
export function agentCounts(snap: AgentsSnapshotT | undefined): {
  active: number
  busy: boolean
  shells: number
  monitors: number
} {
  const rows = snap?.rows ?? []
  const active = rows.filter((r) => r.status === 'running' || r.status === 'waiting' || r.status === 'idle')
  const liveOf = (k: AgentKindT) => rows.filter((r) => r.kind === k && isLiveAgentStatus(r.status)).length
  return {
    active: active.length,
    busy: rows.some((r) => r.status === 'running'),
    shells: liveOf('shell'),
    monitors: liveOf('monitor'),
  }
}

/**
 * The snapshot the panel may draw next to this session state: none when the state names another session (the relay
 * hands out the last snapshot it saw, so a leftover from a previous session must never show). No state yet: the
 * snapshot as is.
 */
export function agentsForSession(
  snap: AgentsSnapshotT | undefined,
  state: SessionStateT | undefined,
): AgentsSnapshotT | undefined {
  if (!snap) return undefined
  return !state || state.session_id === snap.session_id ? snap : undefined
}

/**
 * Whether the app may show Stop for a row: the snapshot says the mod can stop (`can_stop`) and belongs to the current
 * session; the row is in it, stoppable and live; and the state is a live mod's (source 'mod' with capabilities: the
 * bridge's "mod offline" state has none). The bridge checks again (checkSessionControl) before anything is queued.
 */
export function canStopAgent(
  snap: AgentsSnapshotT | undefined,
  rowId: string,
  state: SessionStateT | undefined,
): boolean {
  const row = snap?.rows.find((r) => r.id === rowId)
  return (
    !!snap &&
    !!row &&
    snap.can_stop &&
    row.stoppable &&
    isLiveAgentStatus(row.status) &&
    state?.source === 'mod' &&
    state.capabilities.length > 0 &&
    state.session_id === snap.session_id
  )
}

// ---- lenient engine parsing (the mod's merge of $.agent.list(), its hooks and the tee) ---------------------------

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
const idOf = (v: unknown): string | undefined =>
  typeof v === 'string' && v.length > 0 && v.length <= 80 && !CONTROL_CHARS.test(v) ? v : undefined
const nonEmpty = (v: unknown, max: number): string | undefined => {
  const s = oneLine(v, max)
  return s ? s : undefined
}
/** ISO string, Date, epoch ms or epoch s → ISO (same rule as session.ts toIsoTs, repeated to keep this import-light). */
const isoOf = (v: unknown): string | undefined => {
  if (typeof v === 'string') return v.length <= 40 && IsoTs.safeParse(v).success ? v : undefined
  if (v instanceof Date) return Number.isFinite(v.getTime()) ? v.toISOString() : undefined
  if (typeof v !== 'number' || !Number.isFinite(v) || v <= 0) return undefined
  const d = new Date(v < 1e11 ? v * 1000 : v)
  return Number.isFinite(d.getTime()) ? d.toISOString() : undefined
}
const pickDefined = <T extends Record<string, unknown>>(o: T): T =>
  Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as T

function kindOf(r: Record<string, unknown>, type: string | undefined): AgentKindT {
  const k = AgentKind.safeParse(r.kind)
  if (k.success) return k.data
  if (typeof r.teammateId === 'string' || typeof r.teammate_id === 'string') return 'teammate'
  if (type === 'shell' || type === 'local_bash') return 'shell'
  if (type === 'monitor') return 'monitor'
  if (type === 'workflow') return 'workflow'
  if (type === 'remote_agent') return 'remote'
  return 'subagent'
}

/**
 * Builds outbound rows from what the mod gathered (each item: `$.agent.list()` fields, tracker fields and tee fields,
 * camelCase or snake_case), tolerating missing and unknown fields. Strings go through oneLine(); a field of the wrong
 * type is dropped; an unknown status becomes 'unknown'. `stoppable` is computed here (`canStop` and a live status) and
 * never read from the input. Rows without a usable id, and duplicates of an id already taken, are dropped and counted.
 * Over AGENT_LIMITS.rows, live rows are kept first. `recent` keeps the newest AGENT_LIMITS.recent lines.
 */
export function agentRowsFromEngine(raw: unknown, meta: { canStop: boolean }): { rows: AgentRowT[]; dropped: number } {
  if (!Array.isArray(raw)) return { rows: [], dropped: 0 }
  const rows: AgentRowT[] = []
  const seen = new Set<string>()
  let dropped = 0
  for (const r of raw.slice(0, 500)) {
    const id = isObj(r) ? idOf(r.id ?? r.agentId ?? r.agent_id ?? r.taskId ?? r.task_id) : undefined
    if (!isObj(r) || !id || seen.has(id)) {
      dropped++
      continue
    }
    seen.add(id)
    const type = nonEmpty(r.type ?? r.agentType ?? r.agent_type, 64)
    const kind = kindOf(r, type)
    const st = AgentRunStatus.safeParse(r.status)
    const status: AgentRunStatusT = st.success ? st.data : 'unknown'
    const title = oneLine(r.title ?? r.description ?? r.command) ?? ''
    const activity = nonEmpty(r.activity ?? r.label, AGENT_LIMITS.text)
    const src = r.activity_source ?? r.activitySource
    const tokens = r.tokens ?? r.tokenCount ?? r.token_count
    const recent = Array.isArray(r.recent)
      ? (r.recent as unknown[])
          .filter(isObj)
          .map((l) => ({ at: isoOf(l.at), text: nonEmpty(l.text, AGENT_LIMITS.text) }))
          .filter((l): l is AgentRecentLineT => !!l.at && !!l.text)
          .slice(-AGENT_LIMITS.recent)
      : []
    const row = AgentRow.safeParse(
      pickDefined({
        id,
        kind,
        type: type ?? (kind === 'shell' || kind === 'monitor' ? kind : 'agent'),
        name: nonEmpty(r.name, 64),
        title,
        status,
        activity,
        activity_source: activity && (src === 'summary' || src === 'tool') ? src : undefined,
        parent_id: idOf(r.parent_id ?? r.parentId),
        model: nonEmpty(r.model, 80),
        tokens: Number.isSafeInteger(tokens) && (tokens as number) >= 0 ? (tokens as number) : undefined,
        started_at: isoOf(r.started_at ?? r.startedAt ?? r.startTime),
        ended_at: isoOf(r.ended_at ?? r.endedAt ?? r.endTime),
        background: typeof r.background === 'boolean' ? r.background : kind === 'shell' || kind === 'monitor',
        stoppable: meta.canStop && isLiveAgentStatus(status),
        recent,
      }),
    )
    if (row.success) rows.push(row.data)
    else dropped++
  }
  if (rows.length <= AGENT_LIMITS.rows) return { rows, dropped }
  const live = rows.filter((r) => !isEndedAgentStatus(r.status))
  const ended = rows.filter((r) => isEndedAgentStatus(r.status))
  const kept = new Set([...live, ...ended].slice(0, AGENT_LIMITS.rows))
  return { rows: rows.filter((r) => kept.has(r)), dropped: dropped + rows.length - kept.size }
}

/** agentRowsFromEngine plus the envelope. Only a missing session id fails. */
export function agentsSnapshotFromEngine(
  raw: unknown,
  meta: { session_id: unknown; source: AgentsSourceT; canStop: boolean; at: string },
): { ok: true; snapshot: AgentsSnapshotT; dropped: number } | { ok: false; reason: string } {
  const session_id =
    typeof meta.session_id === 'string' && meta.session_id.length > 0 && meta.session_id.length <= 64
      ? meta.session_id
      : undefined
  if (!session_id) return { ok: false, reason: 'no session id' }
  const { rows, dropped } = agentRowsFromEngine(raw, { canStop: meta.canStop })
  const parsed = AgentsSnapshot.safeParse({
    session_id,
    source: meta.source,
    can_stop: meta.canStop,
    rows,
    at: meta.at,
  })
  return parsed.success
    ? { ok: true, snapshot: parsed.data, dropped }
    : { ok: false, reason: 'agents snapshot did not fit' }
}

/**
 * The activity line the mod builds from a subagent's tool call (docs/SUBAGENTS.md "Activity text"). Inputs only: tool
 * results never go in. Returns a oneLine()d string.
 */
export function agentActivityForTool(toolName: string, input: unknown): string {
  const i = isObj(input) ? input : {}
  const s = (v: unknown) => (typeof v === 'string' ? v : undefined)
  const base = (p: string) =>
    p
      .replace(/[/\\]+$/, '')
      .split(/[/\\]/)
      .pop() ?? p
  const mcp = /^mcp__(.+?)__(.+)$/.exec(toolName)
  let text: string
  if (toolName === 'Bash') text = s(i.description) ?? (s(i.command) ?? '').slice(0, 80)
  else if (toolName === 'Read' || toolName === 'Edit' || toolName === 'Write') {
    const p = s(i.file_path) ?? s(i.path)
    text = p ? `${toolName} ${base(p)}` : toolName
  } else if (toolName === 'Grep' || toolName === 'Glob') {
    const p = s(i.pattern)
    text = p !== undefined ? `Search "${p}"` : 'Search'
  } else if (toolName === 'WebFetch') {
    let host: string | undefined
    try {
      host = new URL(s(i.url) ?? '').host || undefined
    } catch {
      host = undefined
    }
    text = host ?? 'WebFetch'
  } else if (toolName === 'Agent' || toolName === 'Task') {
    const type = s(i.subagent_type) ?? 'agent'
    const d = s(i.description)
    text = d ? `Spawn ${type}: ${d}` : `Spawn ${type}`
  } else if (mcp) text = `${mcp[1]} · ${mcp[2]}`
  else text = toolName
  return oneLine(text) || oneLine(toolName) || 'tool'
}
