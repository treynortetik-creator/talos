// Pure helpers for the session sheet, the header chip and the `/` picker (docs/CLAUDE-CODE.md C4.5). No policy lives here:
// routes, grammars and model rules come from @talos-app/protocol.
import type { InventoryCommandT, SessionStateT } from '@talos-app/protocol'
import type { ContextKind, ThreadContext } from './threadContext.ts'

/** Fresh = the bridge heartbeats every 10 s; three missed beats and the mod counts as gone. */
export const MOD_FRESH_MS = 45_000
/** Above the bridge's 45 s backstop; compact and clear may run for minutes, so their backstop is 5 min (R3, R4). */
export const CONTROL_TIMEOUT_MS = 60_000
export const SLOW_CONTROL_TIMEOUT_MS = 330_000
export const NO_ANSWER_TEXT = 'The Mac did not answer'
export const INSTALL_HINT =
  "Controls need the Talos mod, and it isn't loaded on your Mac yet. Load it when you start the agent there; the setup guide's Talos mod section has the one line to add."

export function isModOnline(state: SessionStateT | undefined, nowMs: number): boolean {
  if (state?.source !== 'mod' || state.capabilities.length === 0) return false
  const at = Date.parse(state.at)
  return Number.isFinite(at) && nowMs - at <= MOD_FRESH_MS
}

/** absent: nothing known · other: hooks/statusline data, read-only · offline: a mod that lapsed · live. */
export type Phase = 'absent' | 'other' | 'offline' | 'live'
export function phaseOf(state: SessionStateT | undefined, modOnline: boolean): Phase {
  if (!state) return 'absent'
  if (state.source !== 'mod') return 'other'
  return modOnline ? 'live' : 'offline'
}

// ---- usage rows ---------------------------------------------------------------------------------------------------

const clampPct = (n: number) => Math.min(100, Math.max(0, n))
const round = (n: number) => Math.round(n)

/** Percent USED of a rate-limit window, the same direction as the context meter. `undefined` = no reading yet. Only the weekly window is shown: the 5-hour limit is gone, and a peer that still sends it is read and ignored. */
export function usedPct(state: SessionStateT | undefined, kind: 'seven_day'): number | undefined {
  const w = state?.rate_limits.find((r) => r.kind === kind)
  return w?.percent === undefined ? undefined : round(clampPct(w.percent))
}
/** A meter is in the warning zone from this much used (15% left or less). */
export const WARN_USED_PCT = 85
export function resetsAt(state: SessionStateT | undefined, kind: 'seven_day'): string | undefined {
  return state?.rate_limits.find((r) => r.kind === kind)?.resets_at
}

export function contextUsed(
  state: SessionStateT | undefined,
): { used: number; tokens?: number; window?: number } | undefined {
  const c = state?.context
  if (!c) return undefined
  const pct =
    c.percent !== undefined ? c.percent : c.tokens !== undefined && c.window ? (c.tokens / c.window) * 100 : undefined
  if (pct === undefined) return undefined
  return {
    used: round(clampPct(pct)),
    ...(c.tokens !== undefined ? { tokens: c.tokens } : {}),
    ...(c.window ? { window: c.window } : {}),
  }
}

export function compactTokens(n: number): string {
  if (n >= 1_000_000) return `${+(n / 1_000_000).toFixed(1)}M`
  if (n >= 1000) return `${Math.round(n / 1000)}k`
  return String(n)
}

/** "resets 4:10 PM" (same day), "resets Mon" (within the week), "resets Nov 3"; '' when there is no time. */
export function resetWords(iso: string | undefined, nowMs: number): string {
  if (!iso) return ''
  const t = Date.parse(iso)
  if (!Number.isFinite(t)) return ''
  const d = new Date(t)
  const n = new Date(nowMs)
  if (d.toDateString() === n.toDateString())
    return `resets ${d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}`
  const diff = t - nowMs
  if (diff > 0 && diff < 7 * 86_400_000) return `resets ${d.toLocaleDateString([], { weekday: 'short' })}`
  return `resets ${d.toLocaleDateString([], { month: 'short', day: 'numeric' })}`
}

/** What the chip and the panel say for a thread session that is not running and has no reading. */
export const CTX_NOT_RUNNING_TEXT = 'not running'
/** Said beside a reading from a session that is parked or stopped. */
export const CTX_LAST_KNOWN_TEXT = 'last known'

/**
 * The header chip: what you need without opening the sheet. Weekly comes from `state` (main's, account-wide); the context
 * comes from `view` when the open thread has a session of its own, otherwise from `state` too.
 */
export function chipParts(
  state: SessionStateT | undefined,
  view?: ThreadContext,
): { week?: number; ctx?: number; kind?: ContextKind } | undefined {
  const kind = view?.kind
  if (!state && !view?.ctx && kind !== 'off') return undefined
  const week = usedPct(state, 'seven_day')
  const ctx = (view ? view.ctx : contextUsed(state))?.used
  if (week === undefined && ctx === undefined && kind !== 'off') return undefined
  return {
    ...(week !== undefined ? { week } : {}),
    ...(ctx !== undefined ? { ctx } : {}),
    ...(kind ? { kind } : {}),
  }
}

/** The spoken reading of the usage numbers, e.g. "weekly usage 60% used, context 31% used". Empty when nothing is known. */
export function usageLabel(parts: ReturnType<typeof chipParts>, phase: Phase): string {
  return [
    parts?.week !== undefined ? `weekly usage ${parts.week}% used` : null,
    parts?.ctx !== undefined
      ? `context ${parts.ctx}% used${parts.kind === 'last' ? `, ${CTX_LAST_KNOWN_TEXT}` : ''}`
      : parts?.kind === 'off'
        ? `context ${CTX_NOT_RUNNING_TEXT}`
        : null,
    phase === 'offline' ? 'mod offline' : null,
  ]
    .filter(Boolean)
    .join(', ')
}

// ---- commands -----------------------------------------------------------------------------------------------------

/** Whether the composer's `/` picker (and the palette) may run a command, and why not. One rule for both. */
export function commandBlock(cmd: InventoryCommandT, modOnline: boolean): { disabled: boolean; reason: string } {
  const macOnly = cmd.route === 'local_only' || cmd.at_mac_only === true
  const needsMod = cmd.route === 'control' && !modOnline
  return {
    disabled: macOnly || needsMod,
    reason: macOnly
      ? cmd.at_mac_only
        ? 'At the Mac only'
        : 'Run this at the Mac'
      : needsMod
        ? 'Needs the Talos mod'
        : '',
  }
}

export const GROUPS: ReadonlyArray<{ source: InventoryCommandT['source']; label: string }> = [
  { source: 'builtin', label: 'Built-in' },
  { source: 'user', label: 'Skills' },
  { source: 'plugin', label: 'Plugins' },
  { source: 'mcp', label: 'MCP prompts' },
]

export function groupCommands(cmds: readonly InventoryCommandT[]) {
  return GROUPS.map((g) => ({ ...g, items: cmds.filter((c) => c.source === g.source) })).filter(
    (g) => g.items.length > 0,
  )
}

export function filterCommands(cmds: readonly InventoryCommandT[], query: string, limit = 60): InventoryCommandT[] {
  const q = query.trim().toLowerCase()
  if (!q) return cmds.slice(0, limit)
  const starts: InventoryCommandT[] = []
  const has: InventoryCommandT[] = []
  for (const c of cmds) {
    const name = c.name.toLowerCase()
    if (name.startsWith(q)) starts.push(c)
    else if (name.includes(q) || c.description.toLowerCase().includes(q)) has.push(c)
  }
  return [...starts, ...has].slice(0, limit)
}

export function routeBadge(c: InventoryCommandT): { text: string; tone: 'ok' | 'neutral' | 'warn' } {
  if (c.route === 'local_only' || c.at_mac_only) return { text: 'At the Mac only', tone: 'neutral' }
  if (c.route === 'control') return { text: 'Runs here', tone: 'ok' }
  return { text: 'Sends as message', tone: 'neutral' }
}

export const MODEL_LABELS: Record<string, string> = { default: 'Default', best: 'Best', fable: 'Fable' }
export const titleCase = (s: string) => MODEL_LABELS[s] ?? s.charAt(0).toUpperCase() + s.slice(1)
