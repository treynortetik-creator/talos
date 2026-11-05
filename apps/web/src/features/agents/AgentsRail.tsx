// The docked right rail at >= 1280 px (docs/SUBAGENTS.md 6.1): 320 px beside the timeline, collapsible to a 44 px strip
// with the count. It opens by itself while there are rows, unless the owner collapsed it (kept in localStorage).
import { useSyncExternalStore } from 'react'
import { cn } from '../../ui/cn.ts'
import { IconChevron } from '../../ui/icons.tsx'
import { StatusDot } from '../../ui/StatusDot.tsx'
import { useSessionSupported } from '../session/SessionTrigger.tsx'
import { useMediaQuery } from '../settings/useMedia.ts'
import { AgentsList, type AgentsView, OfflineBadge, useAgentsView } from './AgentsList.tsx'
import { chipLabel, groupAgents, RAIL_QUERY } from './logic.ts'
import { useNowTick } from './useNowTick.ts'

export const RAIL_PREF_KEY = 'talos-agents-rail'
export type RailPref = 'open' | 'closed' | null

const prefSubs = new Set<() => void>()
function readPref(): RailPref {
  try {
    const v = localStorage.getItem(RAIL_PREF_KEY)
    return v === 'open' || v === 'closed' ? v : null
  } catch {
    return null
  }
}
let pref: RailPref = typeof window === 'undefined' ? null : readPref()
export function setRailPref(p: RailPref) {
  pref = p
  try {
    if (p) localStorage.setItem(RAIL_PREF_KEY, p)
    else localStorage.removeItem(RAIL_PREF_KEY)
  } catch {}
  for (const s of prefSubs) s()
}
function useRailPref(): RailPref {
  return useSyncExternalStore(
    (cb) => {
      prefSubs.add(cb)
      return () => void prefSubs.delete(cb)
    },
    () => pref,
  )
}

/** The owner's choice wins; with none, the rail is open whenever there is something to show. */
export function railOpen(p: RailPref, hasRows: boolean): boolean {
  return p === 'closed' ? false : p === 'open' ? true : hasRows
}

/** The live count: the number plus what it counts ("3 active"), so it is never announced as a bare number. */
export function AgentsCount({
  count,
  unit,
  hideUnit,
  className,
}: {
  count: number
  unit: string
  hideUnit?: boolean
  className?: string
}) {
  return (
    <span aria-live="polite" data-testid="agents-count" className={className}>
      {count}
      <span className={hideUnit ? 'sr-only' : undefined}> {unit}</span>
    </span>
  )
}

export function AgentsRail({ threadId }: { threadId: string }) {
  const supported = useSessionSupported()
  const wide = useMediaQuery(RAIL_QUERY)
  const view = useAgentsView()
  // No snapshot = an old relay or bridge, or a mod without `agents`: no rail at all (the chip hides the same way).
  if (!supported || !wide || !view.snap) return null
  return <Rail threadId={threadId} view={view} />
}

function Rail({ threadId, view }: { threadId: string; view: AgentsView }) {
  const now = useNowTick(false) // the list keeps its own 1 s clock; this only decides whether there is anything to show
  const p = useRailPref()
  const g = groupAgents(view.snap, now)
  const open = railOpen(p, g.agents.length + g.shells.length > 0)
  const chip = chipLabel(view.snap)

  if (!open)
    return (
      <aside
        aria-label="Agents"
        data-testid="agents-rail"
        data-state="collapsed"
        className="flex w-11 shrink-0 flex-col items-center gap-2 border-l border-line bg-surface pt-[max(0.5rem,env(safe-area-inset-top))]"
      >
        <button
          type="button"
          aria-label={`Show agents, ${chip.count} ${chip.unit}`}
          aria-expanded={false}
          data-testid="agents-rail-toggle"
          onClick={() => setRailPref('open')}
          className="flex min-h-11 w-11 flex-col items-center justify-center gap-1 rounded-button hover:bg-surface-2"
        >
          <IconChevron width={16} height={16} className="rotate-180 text-text-2" />
          <StatusDot
            shape={chip.busy ? 'half' : 'ring'}
            className={cn(chip.busy ? 'agent-pulse text-accent-text' : 'text-text-2')}
          />
          <AgentsCount
            count={chip.count}
            unit={chip.unit}
            hideUnit
            className="font-mono text-xs tabular-nums text-text-2"
          />
        </button>
      </aside>
    )

  return (
    <aside
      aria-label="Agents"
      data-testid="agents-rail"
      data-state="open"
      className="flex w-80 shrink-0 flex-col border-l border-line bg-surface"
    >
      <div className="flex items-center gap-2 px-3 pt-[max(0.625rem,env(safe-area-inset-top))] pb-1">
        <h2 className="m-0 font-display text-lg font-semibold leading-tight">Agents</h2>{' '}
        {view.snap ? (
          <span className="inline-flex items-center gap-1.5 font-mono text-xs text-text-2">
            <StatusDot
              shape={chip.busy ? 'half' : 'ring'}
              className={cn(chip.busy ? 'agent-pulse text-accent-text' : 'text-text-2')}
            />
            <AgentsCount count={chip.agents} unit="active" className="tabular-nums" />
          </span>
        ) : null}
        <span className="ml-auto">
          <OfflineBadge offline={view.offline} />
        </span>
        <button
          type="button"
          aria-label="Hide agents"
          aria-expanded={true}
          data-testid="agents-rail-toggle"
          onClick={() => setRailPref('closed')}
          className="grid size-11 shrink-0 place-items-center rounded-pill hover:bg-surface-2"
        >
          <IconChevron width={18} height={18} className="text-text-2" />
        </button>
      </div>
      <div className="mx-3 mb-2 h-px bg-line" />
      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-1 pb-4">
        <AgentsList threadId={threadId} mode="inline" view={view} className="px-2" />
      </div>
    </aside>
  )
}
