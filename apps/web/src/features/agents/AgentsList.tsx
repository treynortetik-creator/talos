// The agents list (docs/SUBAGENTS.md 6.2): rows like the CLI's agent panel, grouped Agents, then Shells & monitors.
// Tap a row for its detail (inline on the rail, a push view in a sheet) with the last activity lines and, only when
// canStopAgent says so, Stop. Shared by the desktop rail, the phone sheet and the session sheet's Agents section.
import type { AgentRowT, AgentRunStatusT, AgentsSnapshotT } from '@talos-app/protocol'
import { useEffect, useRef, useState } from 'react'
import { useStore } from 'zustand'
import { useTalos } from '../../lib/client.ts'
import { cn } from '../../ui/cn.ts'
import { IconBack, IconChevron } from '../../ui/icons.tsx'
import { Badge, Button } from '../../ui/index.ts'
import { phaseOf } from '../session/logic.ts'
import { showsAgentStop, useSessionController, visibleAgents } from '../session/store.ts'
import {
  type AgentNode,
  ago,
  EMPTY_OFFLINE_TEXT,
  EMPTY_TEXT,
  elapsedMs,
  formatElapsed,
  formatTokens,
  groupAgents,
  hasTicking,
  MOD_MISSING_TEXT,
  rowLabel,
  STATUS_WORD,
  shortModel,
} from './logic.ts'
import { useNowTick } from './useNowTick.ts'

// ---- view state ----------------------------------------------------------------------------------------------------

export type AgentsView = {
  snap: AgentsSnapshotT | undefined
  /** The mod lapsed (rows are `unknown`) or the Mac is offline: the panel greys and Stop hides. */
  offline: 'mod' | 'mac' | null
}

export function useAgentsView(): AgentsView {
  const ctl = useSessionController()
  const snap = useStore(ctl.store, visibleAgents)
  const state = useStore(ctl.store, (s) => s.state)
  const modOnline = useStore(ctl.store, (s) => s.modOnline)
  const macOnline = useTalos((s) => s.presence.bridge_online)
  const phase = phaseOf(state, modOnline)
  return { snap, offline: !macOnline ? 'mac' : phase === 'offline' ? 'mod' : null }
}

// ---- status mark ---------------------------------------------------------------------------------------------------

const MARK_TONE: Record<AgentRunStatusT, string> = {
  pending: 'text-text-2',
  running: 'text-accent-text',
  waiting: 'text-accent-text',
  idle: 'text-text-2',
  completed: 'text-ok',
  failed: 'text-warn',
  killed: 'text-text-2',
  unknown: 'text-text-2 opacity-70',
}

/** A drawn mark (never a glyph) plus the status as text for screen readers: colour is never the only signal. */
export function AgentStatusMark({ status, size = 12 }: { status: AgentRunStatusT; size?: number }) {
  return (
    <span
      role="img"
      aria-label={STATUS_WORD[status]}
      data-status={status}
      className={cn(
        'inline-grid shrink-0 place-items-center',
        MARK_TONE[status],
        status === 'running' && 'agent-pulse',
      )}
    >
      <svg width={size} height={size} viewBox="0 0 12 12" aria-hidden="true" fill="none" stroke="currentColor">
        {status === 'running' && <circle cx="6" cy="6" r="4.5" fill="currentColor" stroke="none" />}
        {(status === 'waiting' || status === 'idle') && <circle cx="6" cy="6" r="4.25" strokeWidth="1.6" />}
        {status === 'pending' && (
          <>
            <circle cx="6" cy="6" r="4.25" strokeWidth="1.6" />
            <path d="M6 6V1.75A4.25 4.25 0 0 1 10.25 6z" fill="currentColor" stroke="none" />
          </>
        )}
        {status === 'completed' && (
          <path d="M2 6.4l2.6 2.6L10 3.4" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" />
        )}
        {status === 'failed' && (
          <>
            <path d="M6 1.5l5 9H1z" strokeWidth="1.5" strokeLinejoin="round" />
            <path d="M6 5v2.4M6 9h.01" strokeWidth="1.5" strokeLinecap="round" />
          </>
        )}
        {status === 'killed' && <rect x="2.5" y="2.5" width="7" height="7" rx="1" fill="currentColor" stroke="none" />}
        {status === 'unknown' && <circle cx="6" cy="6" r="4.25" strokeWidth="1.4" strokeDasharray="2 1.6" />}
      </svg>
    </span>
  )
}

// ---- one row -------------------------------------------------------------------------------------------------------

function Figures({ row, now, snapAt }: { row: AgentRowT; now: number; snapAt: string | undefined }) {
  const ms = elapsedMs(row, now, snapAt)
  const parts = [
    row.tokens !== undefined ? formatTokens(row.tokens) : null,
    ms !== undefined ? formatElapsed(ms) : null,
  ]
  const text = parts.filter(Boolean).join(' · ')
  if (!text) return null
  return (
    <span data-testid="agent-figures" className="shrink-0 font-mono text-xs tabular-nums text-text-2">
      {text}
    </span>
  )
}

function RowLines({ node, now, snapAt }: { node: AgentNode; now: number; snapAt: string | undefined }) {
  const { row } = node
  const { who, title } = rowLabel(row)
  return (
    <>
      <span className="flex min-w-0 items-center gap-2">
        <AgentStatusMark status={row.status} />
        <span className="agent-title flex min-w-0 flex-1 items-baseline gap-1 text-sm">
          <span className="min-w-0 truncate">
            <span className="agent-who font-semibold">{who}</span>
            {title ? <span className="text-text-2"> · </span> : null}
            {title}
          </span>
          {/* the CLI's tree hint sits outside the truncation, so the ellipsis never eats it */}
          {node.more > 0 ? <span className="shrink-0 font-mono text-xs text-text-2">(+{node.more})</span> : null}
        </span>
        <Figures row={row} now={now} snapAt={snapAt} />
      </span>
      {row.activity ? (
        <span
          data-testid="agent-activity"
          data-source={row.activity_source ?? 'summary'}
          className={cn(
            'block truncate pl-5 text-xs text-text-2',
            row.activity_source === 'tool' && 'font-mono italic tracking-tight',
          )}
        >
          {row.activity}
        </span>
      ) : null}
    </>
  )
}

const rowButton =
  'flex min-h-11 w-full min-w-0 flex-col justify-center gap-0.5 rounded-button px-2 py-1.5 text-left hover:bg-surface-2 focus-visible:outline-2 focus-visible:outline-focus'

// ---- detail --------------------------------------------------------------------------------------------------------

function StopAgent({ row, threadId, macOnline }: { row: AgentRowT; threadId: string; macOnline: boolean }) {
  const ctl = useSessionController()
  const allowed = useStore(ctl.store, (s) => showsAgentStop(s, row.id)) && macOnline
  const stopping = useStore(ctl.store, (s) => Object.values(s.pending).some((p) => p.agentId === row.id))
  if (!allowed) return null
  return (
    <Button
      variant="danger"
      data-testid="agent-stop"
      className="self-start border border-danger"
      disabled={stopping}
      onClick={() => void ctl.stopAgent(threadId, row.id)}
    >
      {stopping ? 'Stopping…' : 'Stop'}
    </Button>
  )
}

/**
 * One row's Stop progress and result, from the store (keyed by agent id), in a live region that stays mounted with the
 * row: collapsing the detail or going back never loses a failed Stop, and it is announced once, here only.
 */
function AgentOutcome({ agentId }: { agentId: string }) {
  const ctl = useSessionController()
  const stopping = useStore(ctl.store, (s) => Object.values(s.pending).some((p) => p.agentId === agentId))
  const result = useStore(ctl.store, (s) => s.agentOutcomes[agentId])
  // Calm results fade; an error stays until the next Stop of this row.
  useEffect(() => {
    if (!result || result.kind === 'error') return
    const t = setTimeout(() => ctl.dismissAgentOutcome(agentId), 10_000)
    return () => clearTimeout(t)
  }, [result, ctl, agentId])
  const shown = stopping || result !== undefined
  return (
    <div aria-live="polite" {...(shown ? { 'data-testid': 'agent-outcome' } : {})} className="px-2 text-sm">
      {stopping ? (
        <p className="m-0 pb-2 text-text-2">Waiting for the Mac…</p>
      ) : result ? (
        <p
          data-kind={result.kind}
          className={cn('m-0 break-words pb-2', result.kind === 'error' ? 'text-danger' : 'text-text')}
        >
          {result.text}
        </p>
      ) : null}
    </div>
  )
}

function AgentDetail({
  row,
  threadId,
  now,
  headingRef,
}: {
  row: AgentRowT
  threadId: string
  now: number
  headingRef?: React.Ref<HTMLHeadingElement>
}) {
  const macOnline = useTalos((s) => s.presence.bridge_online)
  const started = row.started_at ? new Date(row.started_at) : undefined
  const facts: Array<[string, string]> = [
    ['Task', row.title],
    ['Status', STATUS_WORD[row.status]],
    ...(row.model ? ([['Model', shortModel(row.model) ?? row.model]] as Array<[string, string]>) : []),
    ...(started && Number.isFinite(started.getTime())
      ? ([['Started', started.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })]] as Array<
          [string, string]
        >)
      : []),
    ...(row.background ? ([['Runs', 'in the background']] as Array<[string, string]>) : []),
  ]
  const recent = [...row.recent].reverse()
  return (
    <div data-testid="agent-detail" className="flex flex-col gap-3 px-2 pt-1 pb-3">
      <h3 ref={headingRef} tabIndex={-1} className="sr-only">
        {rowLabel(row).who}: {row.title}
      </h3>
      {row.name && row.type ? <p className="m-0 text-xs text-text-2">{row.type}</p> : null}
      <dl className="m-0 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs">
        {facts.map(([k, v]) => (
          <div key={k} className="contents">
            <dt className="text-text-2">{k}</dt>
            <dd className="m-0 min-w-0 break-words">{v}</dd>
          </div>
        ))}
      </dl>
      <div>
        <h4 className="m-0 mb-1 text-xs font-semibold uppercase tracking-[var(--tracking-caps)] text-text-2">Recent</h4>
        {recent.length === 0 ? (
          <p className="m-0 text-xs text-text-2">{row.activity ?? 'Nothing yet.'}</p>
        ) : (
          <ol data-testid="agent-recent" className="m-0 flex list-none flex-col gap-1 p-0">
            {recent.map((l) => (
              <li key={`${l.at}:${l.text}`} className="flex min-w-0 items-baseline gap-2 text-xs">
                <span className="w-14 shrink-0 font-mono tabular-nums text-text-2">{ago(l.at, now)}</span>
                <span className="min-w-0 break-words font-mono">{l.text}</span>
              </li>
            ))}
          </ol>
        )}
      </div>
      <StopAgent row={row} threadId={threadId} macOnline={macOnline} />
    </div>
  )
}

// ---- the list ------------------------------------------------------------------------------------------------------

function Rows({
  nodes,
  now,
  mode,
  open,
  onOpen,
  threadId,
  label,
  snapAt,
}: {
  nodes: AgentNode[]
  snapAt: string | undefined
  now: number
  mode: 'inline' | 'push'
  open: string | null
  onOpen: (id: string | null) => void
  threadId: string
  label: string
}) {
  return (
    // biome-ignore lint/a11y/noRedundantRoles: Safari drops list semantics from `list-style: none`; the spec asks for it
    <ul role="list" aria-label={label} className="m-0 flex list-none flex-col gap-0.5 p-0">
      {nodes.map((n) => {
        const expanded = mode === 'inline' && open === n.row.id
        return (
          <li
            key={n.row.id}
            data-testid="agent-row"
            data-id={n.row.id}
            data-status={n.row.status}
            className={cn(
              'min-w-0',
              n.depth === 1 && 'ml-4 border-l border-line pl-1',
              // done rows dim at once: secondary ink, never opacity (it would fail contrast)
              n.row.status === 'completed' &&
                '[&_.agent-who]:font-medium [&_.agent-who]:text-text-2 [&_.agent-title]:text-text-2',
            )}
          >
            <button
              type="button"
              className={rowButton}
              title={n.row.title}
              {...(mode === 'inline' ? { 'aria-expanded': expanded } : {})}
              onClick={() => onOpen(mode === 'inline' && expanded ? null : n.row.id)}
            >
              <RowLines node={n} now={now} snapAt={snapAt} />
            </button>
            {expanded && <AgentDetail row={n.row} threadId={threadId} now={now} />}
            <AgentOutcome agentId={n.row.id} />
          </li>
        )
      })}
    </ul>
  )
}

export function OfflineBadge({ offline }: { offline: AgentsView['offline'] }) {
  if (!offline) return null
  return (
    <Badge tone="neutral" data-testid="agents-offline" className="whitespace-nowrap">
      {offline === 'mac' ? 'Mac offline' : 'Mod offline'}
    </Badge>
  )
}

/** Offline: no colour and secondary ink throughout, so it reads greyed while every line keeps its contrast. */
const GREYED = 'grayscale [&_*]:!text-text-2'

/** The panel body. `mode` inline = tap expands in place (the rail); push = tap opens a detail view (sheets). */
export function AgentsList({
  threadId,
  mode,
  view,
  className,
}: {
  threadId: string
  mode: 'inline' | 'push'
  view: AgentsView
  className?: string
}) {
  const { snap, offline } = view
  const now = useNowTick(hasTicking(snap))
  const [open, setOpen] = useState<string | null>(null)
  const [shellsOpen, setShellsOpen] = useState(false)
  const g = groupAgents(snap, now)
  const all = [...g.agents, ...g.shells]
  const greyed = offline !== null
  const picked = mode === 'push' && open ? all.find((n) => n.row.id === open) : undefined
  const pickedId = picked?.row.id

  // Push mode swaps the list for the detail, which unmounts the button that had focus: put focus on the detail on the
  // way in and back on the row it came from on the way out (keyboard and screen reader users keep their place).
  const rootRef = useRef<HTMLDivElement>(null)
  const headingRef = useRef<HTMLHeadingElement>(null)
  const focusMove = useRef<{ to: 'detail' } | { to: 'row'; id: string } | null>(null)
  // biome-ignore lint/correctness/useExhaustiveDependencies: runs when the push view switches (pickedId), reading refs
  useEffect(() => {
    const m = focusMove.current
    if (!m) return
    focusMove.current = null
    if (m.to === 'detail') headingRef.current?.focus()
    else
      for (const li of rootRef.current?.querySelectorAll<HTMLElement>('li[data-id]') ?? [])
        if (li.dataset.id === m.id) li.querySelector('button')?.focus()
  }, [pickedId])
  const onOpen = (id: string | null) => {
    if (mode === 'push' && id) focusMove.current = { to: 'detail' }
    setOpen(id)
  }

  if (!snap)
    return (
      <p data-testid="agents-mod-missing" className={cn('m-0 text-sm text-text-2', className)}>
        {offline === 'mac' ? 'The Mac is offline.' : MOD_MISSING_TEXT}
      </p>
    )

  if (picked)
    return (
      <div
        ref={rootRef}
        className={cn('flex flex-col gap-1', greyed && GREYED, className)}
        data-testid="agents-list"
        data-offline={offline ?? undefined}
      >
        <button
          type="button"
          onClick={() => {
            focusMove.current = { to: 'row', id: picked.row.id }
            setOpen(null)
          }}
          className="flex min-h-11 items-center gap-1 self-start rounded-pill pr-3 text-sm font-medium text-text-2 hover:bg-surface-2"
        >
          <IconBack /> All agents
        </button>
        <div>
          <div className="px-2 py-1.5">
            <RowLines node={{ ...picked, depth: 0 }} now={now} snapAt={snap.at} />
          </div>
          <AgentDetail row={picked.row} threadId={threadId} now={now} headingRef={headingRef} />
          <AgentOutcome agentId={picked.row.id} />
        </div>
      </div>
    )

  return (
    <div
      ref={rootRef}
      data-testid="agents-list"
      data-offline={offline ?? undefined}
      className={cn('flex min-w-0 flex-col gap-3', greyed && GREYED, className)}
    >
      {all.length === 0 ? (
        <p data-testid="agents-empty" className="m-0 text-sm text-text-2">
          {offline === 'mod' ? EMPTY_OFFLINE_TEXT : EMPTY_TEXT}
        </p>
      ) : null}
      {g.agents.length > 0 && (
        <section aria-label="Agents" className="flex flex-col gap-1">
          <Rows
            nodes={g.agents}
            now={now}
            mode={mode}
            open={open}
            onOpen={onOpen}
            threadId={threadId}
            snapAt={snap.at}
            label="Agents"
          />
        </section>
      )}
      {g.shells.length > 0 && (
        <section aria-label="Shells and monitors" className="flex flex-col gap-1">
          <button
            type="button"
            aria-expanded={shellsOpen}
            data-testid="agents-shells-toggle"
            onClick={() => setShellsOpen((o) => !o)}
            className="flex min-h-11 w-full items-center gap-2 rounded-button px-2 text-left hover:bg-surface-2"
          >
            <IconChevron
              width={16}
              height={16}
              className={cn('shrink-0 text-text-2 transition-transform', shellsOpen && 'rotate-90')}
            />
            <span className="whitespace-nowrap text-xs font-semibold text-text-2">Shells & monitors</span>
            <span className="ml-auto min-w-0 truncate text-xs text-text-2">{g.shellSummary}</span>
          </button>
          {shellsOpen && (
            <Rows
              nodes={g.shells}
              now={now}
              mode={mode}
              open={open}
              onOpen={onOpen}
              threadId={threadId}
              snapAt={snap.at}
              label="Shells and monitors"
            />
          )}
        </section>
      )}
    </div>
  )
}
