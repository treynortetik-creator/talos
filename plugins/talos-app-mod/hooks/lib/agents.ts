// The agents collector (docs/SUBAGENTS.md 5.1). Pure: the hooks in register.ts feed it, the link's 2 s tick asks it for
// a snapshot. Sources, merged by id: `$.agent.list()` (roster, type, status, parent, name), the mod's own hooks
// (`agent.spawn` time and model, a subagent's `tool.call` lines, `turn.step` usage, background shells and monitors), and
// the subagent status line tee's file (the CLI's own progress `label`, `tokenCount`, `startTime`, `model`).
//
// Import-free copies of the protocol's oneLine / agentActivityForTool / row rules (packages/protocol/src/session-agents.ts),
// like the mod's other protocol copies: the mod ships as a plugin folder with no workspace imports. A drift is caught by
// apps/bridge/test/mod-client.test.ts, which parses this module's output with the protocol's strict AgentsSnapshot.
// Inputs only: no tool RESULT text ever goes in (a result is read for one thing, the background task id).

/** protocol AGENT_LIMITS + AGENTS_TEE_FRESH_MS + AGENTS_TRACKER_MAX_IDS (import-free copy). */
export const AGENTS = {
  rows: 50,
  recent: 8,
  text: 160,
  keepEndedMs: 600_000,
  teeFreshMs: 12_000,
  maxIds: 100,
} as const

const LIVE = new Set(['pending', 'running', 'waiting', 'idle'])
const ENDED = new Set(['completed', 'failed', 'killed'])
const STATUSES = new Set([...LIVE, ...ENDED, 'unknown'])
const KINDS = new Set(['subagent', 'teammate', 'shell', 'monitor', 'workflow', 'remote'])
export const isLive = (s: string | undefined): boolean => s !== undefined && LIVE.has(s)
export const isEnded = (s: string | undefined): boolean => s !== undefined && ENDED.has(s)

// biome-ignore lint/suspicious/noControlCharactersInRegex: rejecting control characters is the point
const CONTROL = /[\u0000-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069]/
// biome-ignore lint/suspicious/noControlCharactersInRegex: stripping control characters is the point
const CONTROL_G = /[\u0000-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069]/g

/** protocol oneLine(): control characters to spaces, whitespace collapsed, trimmed, clipped to `max` ending in `…`. */
export function oneLine(v: unknown, max: number = AGENTS.text): string | undefined {
  if (typeof v !== 'string') return undefined
  const s = v.replace(CONTROL_G, ' ').replace(/\s+/g, ' ').trim()
  if (s.length <= max) return s
  if (max <= 1) return max === 1 ? '…' : ''
  let cut = max - 1
  const c = s.charCodeAt(cut - 1)
  if (c >= 0xd800 && c <= 0xdbff) cut--
  return `${s.slice(0, cut).trimEnd()}…`
}
const nonEmpty = (v: unknown, max: number): string | undefined => oneLine(v, max) || undefined
const idOf = (v: unknown): string | undefined =>
  typeof v === 'string' && v.length > 0 && v.length <= 80 && !CONTROL.test(v) ? v : undefined
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined)
/** Year 9999's last millisecond: past it `toISOString()` writes `+0YYYYY-…` (refused by IsoTs), and past 8.64e15 throws. */
const MAX_MS = 253_402_300_799_999
/** Milliseconds since the epoch (the tee's `at` and `startTime` are both ms, DOC), inside the 4-digit-year range. */
const finiteMs = (v: unknown): number | undefined =>
  typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= MAX_MS ? v : undefined
/** ISO time, or undefined for anything outside the range IsoTs takes (never throws). */
const iso = (ms: number | undefined): string | undefined =>
  ms === undefined || !Number.isFinite(ms) || ms < 0 || ms > MAX_MS ? undefined : new Date(ms).toISOString()

/** protocol agentActivityForTool(): the one-line "now" text for a tool call, from its INPUT only. */
export function activityForTool(toolName: string, input: unknown): string {
  const i = isObj(input) ? input : {}
  const base = (p: string) =>
    p
      .replace(/[/\\]+$/, '')
      .split(/[/\\]/)
      .pop() ?? p
  const mcp = /^mcp__(.+?)__(.+)$/.exec(toolName)
  let text: string
  if (toolName === 'Bash') text = str(i.description) ?? (str(i.command) ?? '').slice(0, 80)
  else if (toolName === 'Read' || toolName === 'Edit' || toolName === 'Write') {
    const p = str(i.file_path) ?? str(i.path)
    text = p ? `${toolName} ${base(p)}` : toolName
  } else if (toolName === 'Grep' || toolName === 'Glob') {
    const p = str(i.pattern)
    text = p !== undefined ? `Search "${p}"` : 'Search'
  } else if (toolName === 'WebFetch') {
    let host: string | undefined
    try {
      host = new URL(str(i.url) ?? '').host || undefined
    } catch {
      host = undefined
    }
    text = host ?? 'WebFetch'
  } else if (toolName === 'Agent' || toolName === 'Task') {
    const type = str(i.subagent_type) ?? 'agent'
    const d = str(i.description)
    text = d ? `Spawn ${type}: ${d}` : `Spawn ${type}`
  } else if (mcp) text = `${mcp[1]} · ${mcp[2]}`
  else text = toolName
  return oneLine(text) || oneLine(toolName) || 'tool'
}

// ---- engine shapes (structural; the engine's d.ts is not imported by hooks/lib) ---------------------------------

/** `$.agent.list()` row (AgentInfo). */
export type AgentInfoLike = {
  id?: unknown
  teammateId?: unknown
  description?: unknown
  type?: unknown
  status?: unknown
  parentId?: unknown
  name?: unknown
}
/** One `tasks[]` entry as the tee wrote it. */
export type TeeTask = {
  id?: unknown
  name?: unknown
  agentType?: unknown
  status?: unknown
  label?: unknown
  description?: unknown
  startTime?: unknown
  model?: unknown
  tokenCount?: unknown
}
/** The token figure of one `turn.step` result (`usage`: ModelUsage). */
export type StepUsageLike = {
  input_tokens?: unknown
  output_tokens?: unknown
  cache_read_input_tokens?: unknown
  cache_creation_input_tokens?: unknown
}
/** A `classic.Stop` `background_tasks[]` entry (BackgroundTaskSummary). */
export type BackgroundTaskLike = {
  id?: unknown
  type?: unknown
  status?: unknown
  description?: unknown
  command?: unknown
}

export type RecentLine = { at: string; text: string }
export type AgentRowOut = {
  id: string
  kind: 'subagent' | 'teammate' | 'shell' | 'monitor' | 'workflow' | 'remote'
  type: string
  name?: string
  title: string
  status: string
  activity?: string
  activity_source?: 'summary' | 'tool'
  parent_id?: string
  model?: string
  tokens?: number
  started_at?: string
  ended_at?: string
  background: boolean
  stoppable: boolean
  recent: RecentLine[]
}
export type AgentsSnapshotOut = {
  session_id: string
  source: 'mod' | 'mod+tee'
  can_stop: boolean
  rows: AgentRowOut[]
  at: string
}

type Tracked = {
  firstSeen: number
  spawnedAt?: number
  model?: string
  description?: string
  type?: string
  background?: boolean
  tokens?: number
  tool?: string
  ring: Array<{ at: number; text: string }>
  endedAt?: number
}
type Shell = {
  id: string
  kind: 'shell' | 'monitor'
  title: string
  status: string
  startedAt: number
  endedAt?: number
  parentId?: string
}

/**
 * The tee file: `{ v: 1, at: <ms>, session_id, tasks: [...] }`. Fresh only when `at` is within AGENTS.teeFreshMs of
 * now; when `sessionId` is given, a file that names another session is ignored (one file per session, R6).
 */
export function parseTee(text: string | undefined, now: number, sessionId?: string): TeeTask[] | undefined {
  if (typeof text !== 'string' || text.length === 0 || text.length > 1_000_000) return undefined
  let v: unknown
  try {
    v = JSON.parse(text)
  } catch {
    return undefined
  }
  if (!isObj(v) || !Array.isArray(v.tasks)) return undefined
  if (sessionId !== undefined && v.session_id !== undefined && v.session_id !== sessionId) return undefined
  const at = finiteMs(v.at)
  if (at === undefined || now - at > AGENTS.teeFreshMs || at - now > AGENTS.teeFreshMs) return undefined
  return (v.tasks as unknown[]).filter(isObj).slice(0, 200) as TeeTask[]
}

/** Task id and end status from a `session.append` row that is a background task's notification, or undefined. */
export function taskNotificationOf(e: unknown): { id: string; status: string; durationMs?: number } | undefined {
  if (!isObj(e)) return undefined
  const origin = isObj(e.origin) ? e.origin : {}
  const message = isObj(e.message) ? e.message : {}
  const task = isObj(message.task) ? message.task : isObj(e.task) ? e.task : undefined
  if (task) {
    const id = idOf(task.id)
    if (!id) return undefined
    const d = task.durationMs
    return {
      id,
      status: str(task.status) ?? 'completed',
      ...(typeof d === 'number' && Number.isFinite(d) && d >= 0 ? { durationMs: d } : {}),
    }
  }
  if (origin.kind !== 'task-notification') return undefined
  // The notification row's text: `<task-notification><task-id>…</task-id><status>…</status>…` (SMOKE S-A5).
  const content = message.content
  const text =
    typeof content === 'string'
      ? content
      : Array.isArray(content)
        ? content.map((b) => (isObj(b) && typeof b.text === 'string' ? b.text : '')).join('\n')
        : ''
  const id = idOf(/<task-id>\s*([^<\s]+)\s*<\/task-id>/.exec(text)?.[1])
  if (!id) return undefined
  return { id, status: /<status>\s*([a-z_]+)\s*<\/status>/.exec(text)?.[1] ?? 'completed' }
}

const ENDED_WORDS: Record<string, string> = {
  completed: 'completed',
  done: 'completed',
  success: 'completed',
  failed: 'failed',
  error: 'failed',
  killed: 'killed',
  stopped: 'killed',
  cancelled: 'killed',
}

export class AgentTracker {
  private readonly agents = new Map<string, Tracked>()
  private readonly shells = new Map<string, Shell>()

  /** `agent.spawn` resolved: the subagent's id, its model, when, and what the call said. */
  spawned(
    id: unknown,
    now: number,
    info: { model?: unknown; description?: unknown; type?: unknown; background?: unknown } = {},
  ): void {
    const a = idOf(id) ? this.agent(id as string, now) : undefined
    if (!a) return
    a.spawnedAt = now
    const m = nonEmpty(info.model, 80)
    if (m) a.model = m
    const d = oneLine(info.description)
    if (d !== undefined) a.description = d
    const t = nonEmpty(info.type, 64)
    if (t) a.type = t
    if (typeof info.background === 'boolean') a.background = info.background
  }

  /** A tool call inside a subagent: one activity line (inputs only). */
  toolCall(agentId: unknown, tool: string, input: unknown, now: number): void {
    const a = idOf(agentId) ? this.agent(agentId as string, now) : undefined
    if (!a) return
    const text = activityForTool(tool, input)
    a.tool = text
    a.ring.push({ at: now, text })
    if (a.ring.length > AGENTS.recent) a.ring.splice(0, a.ring.length - AGENTS.recent)
  }

  /** A subagent's `turn.step` result: input + cache + output of the step as its token figure (SMOKE S-A3). */
  stepUsage(agentId: unknown, usage: StepUsageLike | null | undefined, now: number): void {
    if (!usage || !idOf(agentId)) return
    const n = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : 0)
    const total =
      n(usage.input_tokens) +
      n(usage.output_tokens) +
      n(usage.cache_read_input_tokens) +
      n(usage.cache_creation_input_tokens)
    if (total <= 0) return
    const a = this.agent(agentId as string, now)
    if (a) a.tokens = Math.round(total)
  }

  /** A background `Bash` or a `Monitor` returned its task id (main loop or a subagent's). */
  shellStarted(id: unknown, kind: 'shell' | 'monitor', title: string, now: number, parentId?: unknown): void {
    const sid = idOf(id)
    if (!sid) return
    const p = idOf(parentId)
    this.shells.set(sid, {
      id: sid,
      kind,
      title: oneLine(title) ?? '',
      status: 'running',
      startedAt: now,
      ...(p ? { parentId: p } : {}),
    })
    this.bound(now)
  }

  /** A task notification ended a shell or monitor (or a subagent: its end is recorded for `ended_at`). */
  taskEnded(id: unknown, status: unknown, now: number): void {
    const sid = idOf(id)
    if (!sid) return
    const word = ENDED_WORDS[typeof status === 'string' ? status.toLowerCase() : ''] ?? 'completed'
    const s = this.shells.get(sid)
    if (s && !isEnded(s.status)) {
      s.status = word
      s.endedAt = now
    }
    const a = this.agents.get(sid)
    if (a && a.endedAt === undefined) a.endedAt = now
  }

  /**
   * `classic.Stop`'s `background_tasks`: the engine's own list of what is still in flight. Shells and monitors on it are
   * live (new ones added); live ones missing from it have ended. Subagents on it are ignored ($.agent.list owns them).
   */
  backgroundSnapshot(tasks: unknown, now: number): void {
    if (!Array.isArray(tasks)) return
    const live = new Set<string>()
    for (const t of tasks.slice(0, 200) as BackgroundTaskLike[]) {
      if (!isObj(t)) continue
      const kind = t.type === 'shell' ? 'shell' : t.type === 'monitor' ? 'monitor' : undefined
      const id = idOf(t.id)
      if (!kind || !id) continue
      live.add(id)
      const status = typeof t.status === 'string' && LIVE.has(t.status) ? t.status : 'running'
      const known = this.shells.get(id)
      if (known) {
        known.status = status
        delete known.endedAt
      } else
        this.shells.set(id, {
          id,
          kind,
          // spec 4.3: the description, else the first 80 characters of the command
          title: oneLine(str(t.description) ?? (str(t.command) ?? '').slice(0, 80)) ?? '',
          status,
          startedAt: now,
        })
    }
    for (const s of this.shells.values())
      if (!live.has(s.id) && !isEnded(s.status)) {
        s.status = 'completed'
        s.endedAt = now
      }
    this.bound(now)
  }

  /** `session.end`: nothing of this session is live any more. */
  reset(): void {
    this.agents.clear()
    this.shells.clear()
  }

  get size(): number {
    return this.agents.size + this.shells.size
  }

  /**
   * The merged rows, in the protocol's outbound shape: the roster from `$.agent.list()`, then shells and monitors.
   * Activity = the tee's `label` when it differs from the description (the CLI's summary), else the latest tool line.
   * Ended rows older than AGENTS.keepEndedMs leave. `stoppable` = `canStop` and a live status, never read from input.
   */
  rows(
    list: unknown,
    tee: TeeTask[] | undefined,
    now: number,
    canStop: boolean,
  ): { rows: AgentRowOut[]; tee: boolean } {
    const teeById = new Map<string, TeeTask>()
    for (const t of tee ?? []) {
      const id = idOf(t.id)
      if (id && !teeById.has(id)) teeById.set(id, t)
    }
    const out: AgentRowOut[] = []
    const seen = new Set<string>()
    let usedTee = false
    for (const r of (Array.isArray(list) ? list : []).slice(0, 500) as AgentInfoLike[]) {
      if (!isObj(r)) continue
      const id = idOf(r.id)
      if (!id || seen.has(id)) continue
      seen.add(id)
      try {
        const a = this.agent(id, now) as Tracked
        const t = teeById.get(id)
        if (t) usedTee = true
        const status = typeof r.status === 'string' && STATUSES.has(r.status) ? r.status : 'unknown'
        if (isEnded(status) && a.endedAt === undefined) a.endedAt = now
        if (!isEnded(status) && status !== 'unknown') delete a.endedAt
        if (a.endedAt !== undefined && now - a.endedAt > AGENTS.keepEndedMs) continue
        const type = nonEmpty(r.type, 64) ?? nonEmpty(t?.agentType, 64) ?? a.type ?? 'agent'
        const description = oneLine(r.description) ?? oneLine(t?.description) ?? a.description ?? ''
        const label = nonEmpty(t?.label, AGENTS.text)
        const summary = label && label !== description ? label : undefined
        const activity = summary ?? a.tool
        const tokens = t?.tokenCount
        const started = finiteMs(t?.startTime) ?? a.spawnedAt ?? a.firstSeen
        const parent = idOf(r.parentId)
        const name = nonEmpty(r.name, 64)
        const model = nonEmpty(t?.model, 80) ?? a.model
        const teammate = typeof r.teammateId === 'string'
        out.push(
          clean({
            id,
            kind: teammate ? 'teammate' : kindOf(type),
            type,
            name,
            title: description,
            status,
            activity,
            activity_source: activity ? (summary ? 'summary' : 'tool') : undefined,
            parent_id: parent,
            model,
            tokens:
              typeof tokens === 'number' && Number.isSafeInteger(tokens) && tokens >= 0
                ? tokens
                : (a.tokens ?? undefined),
            started_at: iso(started),
            ended_at: isEnded(status) ? iso(a.endedAt) : undefined,
            background: a.background ?? false,
            stoppable: canStop && isLive(status),
            recent: a.ring
              .slice(-AGENTS.recent)
              .map((l) => ({ at: iso(l.at), text: l.text }))
              .filter((l): l is RecentLine => l.at !== undefined),
          }),
        )
      } catch {
        // one row the engine or the tee made odd never sinks the snapshot: that row is left out this tick
      }
    }
    for (const s of this.shells.values()) {
      if (seen.has(s.id)) continue
      if (s.endedAt !== undefined && now - s.endedAt > AGENTS.keepEndedMs) continue
      seen.add(s.id)
      try {
        out.push(
          clean({
            id: s.id,
            kind: s.kind,
            type: s.kind,
            title: s.title,
            status: s.status,
            parent_id: s.parentId,
            started_at: iso(s.startedAt),
            ended_at: isEnded(s.status) ? iso(s.endedAt) : undefined,
            background: true,
            stoppable: canStop && isLive(s.status),
            recent: [],
          }),
        )
      } catch {
        // as above
      }
    }
    this.forgetMissing(seen, now)
    return { rows: capRows(out), tee: usedTee }
  }

  // ---- internals -------------------------------------------------------------------------------------------------

  private agent(id: string, now: number): Tracked | undefined {
    let a = this.agents.get(id)
    if (!a) {
      a = { firstSeen: now, ring: [] }
      this.agents.set(id, a)
      this.bound(now)
    }
    return a
  }

  /** Ids the roster no longer lists are kept for keepEndedMs (their hooks may still arrive), then dropped. */
  private forgetMissing(listed: Set<string>, now: number) {
    for (const [id, a] of this.agents)
      if (!listed.has(id)) {
        a.endedAt ??= now
        if (now - a.endedAt > AGENTS.keepEndedMs) this.agents.delete(id)
      }
    for (const [id, s] of this.shells)
      if (s.endedAt !== undefined && now - s.endedAt > AGENTS.keepEndedMs) this.shells.delete(id)
  }

  /** At most AGENTS.maxIds ids: ended ones go first (oldest end), then the oldest seen. */
  private bound(now: number) {
    for (const [id, a] of this.agents)
      if (a.endedAt !== undefined && now - a.endedAt > AGENTS.keepEndedMs) this.agents.delete(id)
    for (const [id, s] of this.shells)
      if (s.endedAt !== undefined && now - s.endedAt > AGENTS.keepEndedMs) this.shells.delete(id)
    let over = this.agents.size + this.shells.size - AGENTS.maxIds
    if (over <= 0) return
    type Entry = { id: string; ended: number | undefined; seen: number; shell: boolean }
    const all: Entry[] = [
      ...[...this.agents].map(([id, a]) => ({ id, ended: a.endedAt, seen: a.firstSeen, shell: false })),
      ...[...this.shells].map(([id, s]) => ({ id, ended: s.endedAt, seen: s.startedAt, shell: true })),
    ]
    all.sort((x, y) => {
      if ((x.ended !== undefined) !== (y.ended !== undefined)) return x.ended !== undefined ? -1 : 1
      return (x.ended ?? x.seen) - (y.ended ?? y.seen)
    })
    for (const e of all) {
      if (over-- <= 0) break
      if (e.shell) this.shells.delete(e.id)
      else this.agents.delete(e.id)
    }
  }
}

function kindOf(type: string): AgentRowOut['kind'] {
  if (KINDS.has(type) && type !== 'subagent') return type as AgentRowOut['kind']
  if (type === 'local_bash') return 'shell'
  if (type === 'remote_agent') return 'remote'
  return 'subagent'
}

/** Drops undefined members (the outbound schema is strict about shape, not about absence). */
function clean(r: Record<string, unknown>): AgentRowOut {
  return Object.fromEntries(Object.entries(r).filter(([, v]) => v !== undefined)) as AgentRowOut
}

/** Over AGENTS.rows: live rows first, then ended, in order. */
function capRows(rows: AgentRowOut[]): AgentRowOut[] {
  if (rows.length <= AGENTS.rows) return rows
  const keep = new Set(
    [...rows.filter((r) => !isEnded(r.status)), ...rows.filter((r) => isEnded(r.status))].slice(0, AGENTS.rows),
  )
  return rows.filter((r) => keep.has(r))
}

/** Same rows, session, source and can_stop; `at` ignored. The link sends `agents` only when this is false. */
export function agentsDigest(s: AgentsSnapshotOut | undefined): string | undefined {
  if (!s) return undefined
  const { at: _at, ...rest } = s
  return JSON.stringify(rest)
}

/** Where the tee writes, one file per session (R6): `$TALOS_APP_HOME/state/agents-tee/<session id>.json`. */
export const TEE_DIR = 'state/agents-tee'
/** The session's tee file under the home, or undefined for an id that cannot be a file name. */
export function teeFileOf(sessionId: string): string | undefined {
  return /^[A-Za-z0-9_-]{1,80}$/.test(sessionId) ? `${TEE_DIR}/${sessionId}.json` : undefined
}

/** The pieces of EngineLike the collector reads (structural, so tests pass a bare object). */
export type AgentsEngineLike = {
  agent?: { list(): Promise<unknown> }
  tee?: { read(sessionId: string): Promise<string> }
}

/**
 * Builds the snapshot on the link's tick: `$.agent.list()`, the tee file when fresh, the tracker. Undefined when the
 * engine has no `$.agent.list` (the mod does not report `agents` then) or the list call fails this tick.
 */
export class AgentsCollector {
  /** The session `session.end` named: from then on its snapshot is empty (the process may go on under a new id). */
  private endedSession: string | undefined

  constructor(
    private readonly $: AgentsEngineLike,
    readonly tracker: AgentTracker,
    private readonly canStop: boolean,
  ) {}

  /** `session.end`: forget everything; that session's snapshot is empty from now on. */
  sessionEnded(sessionId: unknown): void {
    this.tracker.reset()
    if (typeof sessionId === 'string' && sessionId.length > 0) this.endedSession = sessionId
  }

  async snapshot(sessionId: string, now: number): Promise<AgentsSnapshotOut | undefined> {
    const at = new Date(now).toISOString()
    if (sessionId === this.endedSession) return { session_id: sessionId, source: 'mod', can_stop: false, rows: [], at }
    if (!this.$.agent) return undefined
    let list: unknown
    try {
      list = await this.$.agent.list()
    } catch {
      return undefined // a failed read sends nothing this tick, never an empty roster
    }
    let tee: TeeTask[] | undefined
    try {
      tee = this.$.tee ? parseTee(await this.$.tee.read(sessionId), now, sessionId) : undefined
    } catch {
      tee = undefined // no tee file: the rows use the tool line and the mod's own token count
    }
    const { rows, tee: usedTee } = this.tracker.rows(list, tee, now, this.canStop)
    return { session_id: sessionId, source: usedTee ? 'mod+tee' : 'mod', can_stop: this.canStop, rows, at }
  }
}
