// Pure helpers for the agents panel (docs/SUBAGENTS.md 6.1, 6.2). Policy stays in @talos-app/protocol: which rows are
// live, the counts and who may Stop come from there; this file only shapes rows for display.
import {
  AGENT_LIMITS,
  type AgentKindT,
  type AgentRowT,
  type AgentRunStatusT,
  type AgentsSnapshotT,
  agentCounts,
  isEndedAgentStatus,
  isLiveAgentStatus,
} from '@talos-app/protocol'

/** The rail is docked at this width and up; below it, a header chip opens a sheet. */
export const RAIL_QUERY = '(min-width: 1280px)'
export const SHELL_KINDS: readonly AgentKindT[] = ['shell', 'monitor']
export const MOD_MISSING_TEXT = 'Needs the Talos mod (Settings → Session).'
export const EMPTY_TEXT = 'No agents running.'
/** An empty snapshot from a mod that has since lapsed: the app cannot claim nothing runs now. */
export const EMPTY_OFFLINE_TEXT = 'No agents when the mod was last seen.'

export const STATUS_WORD: Record<AgentRunStatusT, string> = {
  pending: 'starting',
  running: 'running',
  waiting: 'waiting',
  idle: 'idle',
  completed: 'done',
  failed: 'failed',
  killed: 'stopped',
  unknown: 'unknown',
}

/** Ended rows stay this long after `ended_at` (the CLI's 30 s is too short for a phone you glance at). */
export function isExpired(row: AgentRowT, nowMs: number): boolean {
  if (!isEndedAgentStatus(row.status) || !row.ended_at) return false
  const t = Date.parse(row.ended_at)
  return Number.isFinite(t) && nowMs - t > AGENT_LIMITS.keepEndedMs
}

export type AgentNode = {
  row: AgentRowT
  depth: 0 | 1 /** descendants deeper than one level, shown as `(+N)` */
  more: number
}

/**
 * Rows in display order: each top-level row followed by its direct children (indented one level). Anything deeper is
 * folded into its level-1 ancestor's `(+N)`, like the CLI. A row whose parent is not in the list is top-level.
 */
export function agentTree(rows: readonly AgentRowT[]): AgentNode[] {
  const byId = new Map(rows.map((r) => [r.id, r]))
  const kids = new Map<string, AgentRowT[]>()
  const roots: AgentRowT[] = []
  for (const r of rows) {
    if (r.parent_id && r.parent_id !== r.id && byId.has(r.parent_id)) {
      const k = kids.get(r.parent_id) ?? []
      k.push(r)
      kids.set(r.parent_id, k)
    } else roots.push(r)
  }
  const countDeep = (id: string, seen: Set<string>): number => {
    let n = 0
    for (const c of kids.get(id) ?? []) {
      if (seen.has(c.id)) continue
      seen.add(c.id)
      n += 1 + countDeep(c.id, seen)
    }
    return n
  }
  const out: AgentNode[] = []
  for (const r of roots) {
    out.push({ row: r, depth: 0, more: 0 })
    for (const c of kids.get(r.id) ?? []) out.push({ row: c, depth: 1, more: countDeep(c.id, new Set([r.id, c.id])) })
  }
  return out
}

export type AgentGroups = {
  agents: AgentNode[]
  shells: AgentNode[]
  /** "2 shells · 1 monitor": the live ones, or every row when none is live (the mod lapsed, or they all ended). */
  shellSummary: string
}

export function groupAgents(snap: AgentsSnapshotT | undefined, nowMs: number): AgentGroups {
  const rows = (snap?.rows ?? []).filter((r) => !isExpired(r, nowMs))
  const isShell = (r: AgentRowT) => SHELL_KINDS.includes(r.kind)
  const c = agentCounts(snap)
  return {
    agents: agentTree(rows.filter((r) => !isShell(r))),
    shells: agentTree(rows.filter(isShell)),
    shellSummary:
      [plural(c.shells, 'shell'), plural(c.monitors, 'monitor')].filter(Boolean).join(' · ') ||
      [
        plural(rows.filter((r) => r.kind === 'shell').length, 'shell'),
        plural(rows.filter((r) => r.kind === 'monitor').length, 'monitor'),
      ]
        .filter(Boolean)
        .join(' · '),
  }
}

export const plural = (n: number, word: string) => (n > 0 ? `${n} ${word}${n === 1 ? '' : 's'}` : '')

/** Line 1: `type · title`, with the SendMessage name in place of the type when it has one. */
export function rowLabel(r: AgentRowT): { who: string; title: string } {
  return { who: r.name || r.type || r.kind, title: r.title }
}

/** 950 → "950", 12_300 → "12.3k", 123_456 → "123k", 1_250_000 → "1.3M" (the CLI's style). */
export function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${+(n / 1_000_000).toFixed(1)}M`
  if (n >= 100_000) return `${Math.round(n / 1000)}k`
  if (n >= 1000) return `${+(n / 1000).toFixed(1)}k`
  return String(n)
}

/**
 * Elapsed from `started_at`. A live row runs on the client clock; any other row is frozen at `ended_at`, or, when the
 * engine gave none (`ended_at` is optional), at the snapshot's own time, so a finished row never keeps counting.
 * "45s", "2m 14s", "1h 3m".
 */
export function elapsedMs(r: AgentRowT, nowMs: number, snapAt?: string): number | undefined {
  if (!r.started_at) return undefined
  const start = Date.parse(r.started_at)
  const frozenAt = isLiveAgentStatus(r.status) ? undefined : (r.ended_at ?? snapAt)
  const end = frozenAt ? Date.parse(frozenAt) : nowMs
  if (!Number.isFinite(start) || !Number.isFinite(end)) return undefined
  return Math.max(0, end - start)
}

/** Something on screen ticks: a live row with a start time. Nothing live = no 1 s clock. */
export function hasTicking(snap: AgentsSnapshotT | undefined): boolean {
  return (snap?.rows ?? []).some((r) => isLiveAgentStatus(r.status) && r.started_at !== undefined)
}

export function formatElapsed(ms: number): string {
  const s = Math.floor(ms / 1000)
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m ${String(s % 60).padStart(2, '0')}s`
  const h = Math.floor(m / 60)
  return `${h}h ${m % 60}m`
}

/** "now", "40s ago", "3m ago", "2h ago" for the recent lines. */
export function ago(iso: string, nowMs: number): string {
  const t = Date.parse(iso)
  if (!Number.isFinite(t)) return ''
  const s = Math.max(0, Math.round((nowMs - t) / 1000))
  if (s < 5) return 'now'
  if (s < 60) return `${s}s ago`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m ago`
  return `${Math.floor(m / 60)}h ago`
}

const ACTIVE = (r: AgentRowT) => r.status === 'running' || r.status === 'waiting' || r.status === 'idle'

/**
 * The chip: `agentCounts().active` tasks, named like the CLI's pill (2.1.312): the kind when they are all one kind
 * ("3 agents", "2 shells"), "tasks" when mixed. A shell or a monitor is never called an agent. `agents` is the Agents
 * group alone (subagents, teammates, workflows, remote), for the "N active" beside the Agents heading.
 */
export function chipLabel(snap: AgentsSnapshotT | undefined): {
  count: number
  unit: string
  agents: number
  busy: boolean
  full: string
} {
  const c = agentCounts(snap)
  const active = (snap?.rows ?? []).filter(ACTIVE)
  const shells = active.filter((r) => r.kind === 'shell').length
  const monitors = active.filter((r) => r.kind === 'monitor').length
  const agents = active.length - shells - monitors
  const kinds = [agents, shells, monitors].filter((n) => n > 0).length
  const one = c.active === 1
  const unit =
    kinds > 1
      ? one
        ? 'task'
        : 'tasks'
      : shells > 0
        ? one
          ? 'shell'
          : 'shells'
        : monitors > 0
          ? one
            ? 'monitor'
            : 'monitors'
          : one
            ? 'agent'
            : 'agents'
  const parts = [plural(agents, 'agent'), plural(shells, 'shell'), plural(monitors, 'monitor')].filter(Boolean)
  return {
    count: c.active,
    unit,
    agents,
    busy: c.busy,
    full: `${parts.length ? parts.join(', ') : 'none active'}${c.busy ? ', running' : ''}`,
  }
}

export function shortModel(id: string | undefined): string | undefined {
  if (!id) return undefined
  const m = /^claude-([a-z]+)-(\d+)-(\d+)/.exec(id)
  return m ? `${m[1]?.charAt(0).toUpperCase()}${m[1]?.slice(1)} ${m[2]}.${m[3]}` : id
}
