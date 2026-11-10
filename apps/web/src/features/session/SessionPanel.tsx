// biome-ignore-all lint/a11y/useSemanticElements: segmented radio rows and groups built from 44px buttons
// The session panel (docs/CLAUDE-CODE.md C4.5): what Claude Code is doing and the controls the mod allows. It lives in
// the sheet (header mascot) and inline in Settings -> Session. Read-only whenever the mod is not live, with one line
// saying how to get it. Failures show the result's own text; "pending" is not an error.
import {
  DOCUMENTED_EFFORTS,
  dedicatedSettings,
  EFFORT_MAY_ASK_NOTE,
  effortKeepsCache,
  modelSwitchNotes,
  type SessionInventoryT,
  type SessionStateT,
  THINKING_NOTE,
} from '@talos-app/protocol'
import { useEffect, useState } from 'react'
import { Link } from 'react-router'
import { useStore } from 'zustand'
import { useTalos } from '../../lib/client.ts'
import { cn } from '../../ui/cn.ts'
import { Badge, Button, Tabs, TabsContent, TabsList, TabsTrigger } from '../../ui/index.ts'
import { StatusDot } from '../../ui/StatusDot.tsx'
import { AgentsList, OfflineBadge, useAgentsView } from '../agents/AgentsList.tsx'
import { chipLabel, EMPTY_TEXT } from '../agents/logic.ts'
import { useWorkersStatus, WORKER_STATE_TEXT } from '../thread-sessions/store.ts'
import {
  CTX_LAST_KNOWN_TEXT,
  compactTokens,
  groupCommands,
  INSTALL_HINT,
  type Phase,
  phaseOf,
  resetsAt,
  resetWords,
  routeBadge,
  titleCase,
  usedPct,
  WARN_USED_PCT,
} from './logic.ts'
import { type Outcome, useSessionController } from './store.ts'
import { useThreadContext } from './threadContext.ts'

// ---- meters -------------------------------------------------------------------------------------------------------

function Meter({
  label,
  value,
  text,
  detail,
  tone = 'accent',
  stale,
  testId,
}: {
  label: string
  /** 0-100 fill; undefined = no reading yet. */
  value: number | undefined
  text: string
  detail?: string
  tone?: 'accent' | 'warn'
  /** A last known reading from a session that is not running: dimmed. */
  stale?: boolean
  testId: string
}) {
  return (
    <div
      data-testid={testId}
      {...(stale ? { 'data-stale': 'true' } : {})}
      className={cn('flex flex-col gap-1.5', stale && 'opacity-60')}
    >
      <div className="flex items-baseline justify-between gap-3">
        <span className="text-sm font-medium">{label}</span>
        <span className={cn('font-mono text-sm', value === undefined ? 'text-text-2' : 'text-text')}>{text}</span>
      </div>
      <div
        role="progressbar"
        aria-label={label}
        aria-valuemin={0}
        aria-valuemax={100}
        {...(value !== undefined ? { 'aria-valuenow': value, 'aria-valuetext': text } : { 'aria-valuetext': text })}
        className="h-2 overflow-hidden rounded-pill border border-line bg-surface-2"
      >
        {value !== undefined && (
          <div
            className={cn('h-full rounded-pill', tone === 'warn' ? 'bg-warn' : 'bg-accent')}
            style={{ width: `${value}%` }}
          />
        )}
      </div>
      {detail ? <span className="text-xs text-text-2">{detail}</span> : null}
    </div>
  )
}

/** A section title in the panel: small capitals, like the mark above a list. */
function SectionTitle({ id, children }: { id: string; children: React.ReactNode }) {
  return (
    <h3 id={id} className="m-0 text-xs font-semibold uppercase tracking-[var(--tracking-caps)] text-text-2">
      {children}
    </h3>
  )
}

function Context({ state, threadId, live }: { state: SessionStateT | undefined; threadId: string; live: boolean }) {
  const ctl = useSessionController()
  const busyCtl = useStore(ctl.store, (s) => Object.keys(s.pending).length > 0)
  // The thread's own session's context when it has one, never main's (docs/OPTION-C.md 9.3)
  const { kind, ctx } = useThreadContext(threadId)
  // Compact runs on main, so it is offered only where main is what the numbers describe
  const canCompact = kind === 'main' && live && state?.capabilities.includes('compact') === true
  const tokens =
    ctx?.tokens !== undefined && ctx.window ? `${compactTokens(ctx.tokens)} of ${compactTokens(ctx.window)} tokens` : ''
  const detail = [tokens, kind === 'last' ? CTX_LAST_KNOWN_TEXT : ''].filter(Boolean).join(' · ')
  return (
    <section aria-labelledby="session-context-h" className="flex flex-col gap-3" data-testid="session-context">
      <SectionTitle id="session-context-h">Context</SectionTitle>
      <Meter
        testId="meter-context"
        label="Context window"
        value={ctx?.used}
        text={
          kind === 'off'
            ? 'Not running'
            : ctx === undefined
              ? 'No reading yet'
              : `${ctx.used}% used · ${100 - ctx.used}% left`
        }
        tone={ctx !== undefined && ctx.used >= WARN_USED_PCT ? 'warn' : 'accent'}
        {...(kind === 'last' ? { stale: true } : {})}
        {...(detail ? { detail } : {})}
      />
      {canCompact && (
        <div className="flex flex-col gap-1">
          <Button
            variant="outline"
            className="self-start"
            disabled={busyCtl}
            onClick={() => void ctl.compact(threadId)}
          >
            Compact
          </Button>
          {state?.busy && <p className="m-0 text-xs text-text-2">Compacts after this turn</p>}
        </div>
      )}
    </section>
  )
}

function Usage({ state, now }: { state: SessionStateT | undefined; now: number }) {
  // Option C: the plan limits are one pool for main and every thread session, so say so when those can exist
  const pooled = useTalos((s) => (s.config ? dedicatedSettings(s.config).enabled : false))
  const all = pooled ? ' · all sessions' : ''
  const week = usedPct(state, 'seven_day')
  const high = (n: number | undefined) => n !== undefined && n >= WARN_USED_PCT
  return (
    <section aria-labelledby="session-usage-h" className="flex flex-col gap-3" data-testid="session-usage">
      <SectionTitle id="session-usage-h">Usage</SectionTitle>
      <Meter
        testId="meter-week"
        label={`Weekly usage${all}`}
        value={week}
        text={week === undefined ? 'No reading yet' : `${week}% used`}
        tone={high(week) ? 'warn' : 'accent'}
        detail={week === undefined ? undefined : resetWords(resetsAt(state, 'seven_day'), now)}
      />
    </section>
  )
}

// ---- busy word ----------------------------------------------------------------------------------------------------

function BusyWord({ state }: { state: SessionStateT }) {
  const word = state.compacting ? 'Compacting' : state.busy ? 'Working' : 'Idle'
  return (
    <span
      data-testid="session-busy"
      className={cn(
        'inline-flex items-center gap-1.5 text-xs font-semibold uppercase tracking-[var(--tracking-caps)]',
        state.busy || state.compacting ? 'text-accent-text' : 'text-text-2',
      )}
    >
      <StatusDot shape={state.busy || state.compacting ? 'half' : 'ring'} />
      {word}
    </span>
  )
}

// ---- outcome line -------------------------------------------------------------------------------------------------

function OutcomeLine({ outcome, waiting }: { outcome: Outcome | undefined; waiting: boolean }) {
  return (
    <div aria-live="polite" data-testid="session-outcome" className="min-h-5 text-sm">
      {waiting ? (
        <p className="m-0 text-text-2">Waiting for the Mac…</p>
      ) : outcome ? (
        <p
          className={cn(
            'm-0 break-words',
            outcome.kind === 'error' ? 'text-danger' : outcome.kind === 'pending' ? 'text-text-2' : 'text-text',
          )}
          data-kind={outcome.kind}
        >
          {outcome.text}
        </p>
      ) : null}
    </div>
  )
}

// ---- controls -----------------------------------------------------------------------------------------------------

function isCurrentModel(value: string, state: SessionStateT): boolean {
  const id = state.model?.id ?? ''
  return value !== 'default' && id.includes(value)
}

function Controls({
  state,
  inventory,
  threadId,
}: {
  state: SessionStateT
  inventory: SessionInventoryT | undefined
  threadId: string
}) {
  const ctl = useSessionController()
  const busyCtl = useStore(ctl.store, (s) => Object.keys(s.pending).length > 0)
  const [menu, setMenu] = useState(false)
  const [confirmClear, setConfirmClear] = useState(false)
  const caps = state.capabilities
  const can = (c: (typeof caps)[number]) => caps.includes(c)
  const efforts: string[] = [...(inventory?.efforts.length ? inventory.efforts : DOCUMENTED_EFFORTS)]
  if (!efforts.includes('auto')) efforts.push('auto')
  const models = ctl.allowedModels()
  const label = (v: string) => inventory?.models.find((m) => m.value === v)?.label ?? titleCase(v)
  const note = (v: string) => inventory?.models.find((m) => m.value === v)?.note
  const notes = modelSwitchNotes('default')
  const showStop = can('stop') && state.busy === true && Boolean(state.turn_id)
  const modelOk = can('model') && can('command') && models.length > 0
  const effortOk = can('effort') && can('command')

  return (
    <div className="flex flex-col gap-4" data-testid="session-controls">
      <div className="flex flex-wrap gap-2">
        {showStop && (
          <Button
            variant="danger"
            className="border border-danger"
            disabled={busyCtl}
            onClick={() => void ctl.stopTurn(threadId)}
          >
            Stop
          </Button>
        )}
        {can('clear') && !confirmClear && (
          <Button variant="ghost" disabled={busyCtl} onClick={() => setConfirmClear(true)}>
            New conversation
          </Button>
        )}
      </div>
      {confirmClear && (
        <div
          role="group"
          aria-label="Confirm new conversation"
          className="incised flex flex-col gap-3 rounded-card border border-line bg-surface-2 p-3"
        >
          <p className="m-0 text-sm">Start a new conversation? Your threads stay; Claude forgets this chat.</p>
          <div className="flex gap-2">
            <Button
              onClick={() => {
                setConfirmClear(false)
                void ctl.clear(threadId)
              }}
            >
              Start new
            </Button>
            <Button variant="ghost" onClick={() => setConfirmClear(false)}>
              Cancel
            </Button>
          </div>
        </div>
      )}

      {modelOk && (
        <div className="flex flex-col gap-2">
          <button
            type="button"
            aria-expanded={menu}
            aria-controls="session-model-menu"
            disabled={busyCtl}
            onClick={() => setMenu((m) => !m)}
            className="flex min-h-11 items-center justify-between gap-3 rounded-button border border-line px-4 text-sm font-medium hover:bg-surface-2 disabled:opacity-50"
          >
            <span>Model</span>
            <span className="text-text-2">{state.model?.display ?? state.model?.id ?? 'Unknown'} ▾</span>
          </button>
          {menu && (
            <div id="session-model-menu" className="flex flex-col gap-2">
              <div role="radiogroup" aria-label="Model" className="flex flex-col gap-1">
                {models.map((v) => {
                  const credits = modelSwitchNotes(v).credits
                  const current = isCurrentModel(v, state)
                  return (
                    <div key={v}>
                      <button
                        type="button"
                        role="radio"
                        aria-checked={current}
                        onClick={() => {
                          setMenu(false)
                          void ctl.command(threadId, 'model', v)
                        }}
                        className={cn(
                          'flex min-h-11 w-full items-center justify-between gap-3 rounded-button px-4 text-left text-sm hover:bg-surface-2',
                          current && 'bg-surface-2 font-semibold',
                        )}
                      >
                        <span>{label(v)}</span>
                        {note(v) ? (
                          <span className="text-xs text-text-2">{note(v)}</span>
                        ) : current ? (
                          <span className="text-xs text-text-2">Current</span>
                        ) : null}
                      </button>
                      {credits && <p className="m-0 px-4 pb-1 text-xs text-warn">{credits}</p>}
                    </div>
                  )
                })}
              </div>
              <p data-testid="model-reread" className="m-0 text-xs text-text-2">
                {notes.reread}
              </p>
              <p className="m-0 text-xs text-text-2">{notes.default_note}</p>
            </div>
          )}
        </div>
      )}

      {effortOk && (
        <div className="flex flex-col gap-2">
          <span id="effort-label" className="text-sm font-medium">
            Effort
          </span>
          <div
            role="radiogroup"
            aria-labelledby="effort-label"
            className="flex flex-wrap overflow-hidden rounded-button border border-line"
          >
            {efforts.map((e) => (
              <button
                key={e}
                type="button"
                role="radio"
                aria-checked={state.effort === e}
                disabled={busyCtl}
                onClick={() => void ctl.command(threadId, 'effort', e)}
                className={cn(
                  'min-h-11 min-w-12 flex-1 border-r border-line px-1 text-[0.8125rem] last:border-r-0 hover:bg-surface-2 disabled:opacity-50',
                  state.effort === e && 'bg-accent font-semibold text-on-accent hover:bg-accent',
                )}
              >
                {e}
              </button>
            ))}
          </div>
          <p className="m-0 text-xs text-text-2">
            Applies from the next message
            {!effortKeepsCache(state.model?.id) ? (
              <>
                {' '}
                · <span data-testid="effort-may-ask">{EFFORT_MAY_ASK_NOTE}</span>
              </>
            ) : null}
          </p>
          <p className="m-0 text-xs text-text-2">{THINKING_NOTE}</p>
        </div>
      )}
    </div>
  )
}

// ---- agents: this session's helpers, then the thread sessions ------------------------------------------------------

function GroupTitle({ children }: { children: React.ReactNode }) {
  return <h4 className="m-0 text-sm font-medium">{children}</h4>
}

/** Each thread that has its own session, with the state the Mac last reported (`workers.status`). */
function ThreadSessionRows() {
  const status = useWorkersStatus()
  const threads = useTalos((s) => s.threads)
  if (!status || status.threads.length === 0) return null
  return (
    <div className="flex flex-col gap-1" data-testid="session-thread-sessions">
      <GroupTitle>Thread sessions</GroupTitle>
      <ul className="m-0 flex list-none flex-col p-0">
        {status.threads.map((w) => (
          <li key={w.thread_id} className="flex min-h-11 items-center justify-between gap-3 text-sm">
            <Link to={`/t/${w.thread_id}`} className="min-w-0 truncate font-medium">
              {threads.find((t) => t.id === w.thread_id)?.name ?? w.thread_id}
            </Link>
            <span className="shrink-0 text-text-2">{WORKER_STATE_TEXT[w.state]}</span>
          </li>
        ))}
      </ul>
    </div>
  )
}

function AgentsSection({ threadId }: { threadId: string }) {
  const view = useAgentsView()
  // Always shown: "No agents running." is the answer when nothing is. Without a snapshot at all (an old relay or bridge, a mod
  // without `agents`) the app cannot say more, so it says only that, and never blames the mod (the hint above covers that).
  return (
    <section aria-labelledby="session-agents-h" data-testid="session-agents" className="flex flex-col gap-3">
      <div className="flex items-center gap-2">
        <SectionTitle id="session-agents-h">Agents</SectionTitle>
        {view.snap ? (
          <span aria-live="polite" data-testid="agents-count" className="font-mono text-xs text-text-2">
            {chipLabel(view.snap).agents} active
          </span>
        ) : null}
        <span className="ml-auto">
          <OfflineBadge offline={view.offline} />
        </span>
      </div>
      <div className="flex flex-col gap-1">
        <GroupTitle>This session</GroupTitle>
        {view.snap ? (
          <AgentsList threadId={threadId} view={view} />
        ) : (
          <p data-testid="agents-empty" className="m-0 text-sm text-text-2">
            {EMPTY_TEXT}
          </p>
        )}
      </div>
      <ThreadSessionRows />
    </section>
  )
}

// ---- tabs ---------------------------------------------------------------------------------------------------------

function CommandsTab({ inventory }: { inventory: SessionInventoryT | undefined }) {
  if (!inventory || inventory.commands.length === 0)
    return <p className="m-0 py-3 text-sm text-text-2">Nothing listed yet.</p>
  return (
    <div className="flex flex-col gap-4 py-3">
      {groupCommands(inventory.commands).map((g) => (
        <section key={g.source} aria-label={g.label}>
          <h4 className="m-0 mb-1 text-xs font-semibold uppercase tracking-[var(--tracking-caps)] text-text-2">
            {g.label}
          </h4>
          <ul className="m-0 flex list-none flex-col divide-y divide-line p-0">
            {g.items.map((c) => {
              const b = routeBadge(c)
              const macOnly = b.text === 'At the Mac only'
              return (
                <li
                  key={`${c.source}:${c.name}`}
                  className={cn('flex min-h-11 items-start justify-between gap-3 py-2', macOnly && 'italic')}
                >
                  <span className="min-w-0">
                    <span className="block truncate font-mono text-sm">/{c.name}</span>
                    <span className="block text-xs text-text-2">{c.description}</span>
                  </span>
                  <Badge tone={b.tone} className="shrink-0 normal-case tracking-normal">
                    {b.text}
                  </Badge>
                </li>
              )
            })}
          </ul>
        </section>
      ))}
    </div>
  )
}

function McpTab({ inventory }: { inventory: SessionInventoryT | undefined }) {
  if (!inventory || inventory.mcp_servers.length === 0)
    return <p className="m-0 py-3 text-sm text-text-2">No MCP servers listed.</p>
  return (
    <ul className="m-0 list-none divide-y divide-line p-0 py-1">
      {inventory.mcp_servers.map((s) => (
        <li key={s.name} className="flex min-h-11 items-center justify-between gap-3 py-2">
          <span className="min-w-0 truncate text-sm font-medium">{s.name}</span>
          <span className="flex items-center gap-2 text-xs text-text-2">
            {s.tools} tools
            <Badge tone={s.status === 'connected' ? 'ok' : 'neutral'}>
              {s.status === 'connected' ? 'Connected' : 'Unknown'}
            </Badge>
          </span>
        </li>
      ))}
    </ul>
  )
}

function PluginsTab({ inventory }: { inventory: SessionInventoryT | undefined }) {
  if (!inventory || inventory.plugins.length === 0)
    return <p className="m-0 py-3 text-sm text-text-2">No plugins listed.</p>
  return (
    <ul className="m-0 list-none divide-y divide-line p-0 py-1">
      {inventory.plugins.map((p) => (
        <li key={p.name} className="flex min-h-11 items-center justify-between gap-3 py-2">
          <span className="min-w-0 truncate text-sm font-medium">{p.name}</span>
          <Badge tone={p.enabled ? 'ok' : 'neutral'}>{p.enabled ? 'Enabled' : 'Off'}</Badge>
        </li>
      ))}
    </ul>
  )
}

// ---- the panel ----------------------------------------------------------------------------------------------------

/**
 * `inline` is Settings > Session: it also lists the commands, MCP servers and plugins. The docked panel and the sheets
 * leave those out and link there instead.
 */
export function SessionPanel({ threadId, inline }: { threadId: string; inline?: boolean }) {
  const ctl = useSessionController()
  const state = useStore(ctl.store, (s) => s.state)
  const inventory = useStore(ctl.store, (s) => s.inventory)
  const modOnline = useStore(ctl.store, (s) => s.modOnline)
  const now = useStore(ctl.store, (s) => s.now)
  const last = useStore(ctl.store, (s) => s.last)
  // An agent Stop is announced by its own row (docs/SUBAGENTS.md 6.2), never here as well.
  const waiting = useStore(ctl.store, (s) => Object.values(s.pending).some((p) => !p.agentId))
  const phase: Phase = phaseOf(state, modOnline)

  // Calm results fade; an error stays until the next action.
  useEffect(() => {
    if (!last || last.kind === 'error') return
    const t = setTimeout(() => ctl.dismiss(), 10_000)
    return () => clearTimeout(t)
  }, [last, ctl])

  const surfaces = state?.surfaces ?? []
  return (
    <div className="flex flex-col gap-5" data-testid="session-panel" data-phase={phase}>
      {state && (
        <div className="flex flex-wrap items-center gap-2">
          {state.model && (
            <span
              data-testid="session-model"
              className="rounded-pill border border-line bg-surface-2 px-3 py-1 text-sm font-semibold"
            >
              {state.model.display ?? state.model.id}
            </span>
          )}
          {state.effort && (
            <span
              data-testid="session-effort-pill"
              className="font-mono text-xs uppercase tracking-[var(--tracking-mono)] text-text-2"
            >
              {state.effort}
            </span>
          )}
          <span className="ml-auto">
            {phase === 'offline' ? (
              <Badge tone="neutral" data-testid="mod-offline">
                Mod offline
              </Badge>
            ) : state.busy !== undefined || state.compacting ? (
              <BusyWord state={state} />
            ) : null}
          </span>
        </div>
      )}

      {phase !== 'live' && (
        <p
          data-testid="mod-hint"
          className="m-0 rounded-button border border-line bg-surface-2 px-3 py-2 text-sm text-text-2"
        >
          {INSTALL_HINT}
        </p>
      )}

      <Context state={state} threadId={threadId} live={phase === 'live'} />

      <Usage state={state} now={now} />

      <AgentsSection threadId={threadId} />

      {state && (state.version || surfaces.length > 0) && (
        <p className="m-0 text-xs text-text-2" data-testid="session-facts">
          {state.version ? `Claude Code ${state.version}` : null}
          {state.version && surfaces.length > 0 ? ' · ' : null}
          {surfaces.length > 0 ? `Also open in: ${surfaces.join(', ')}` : null}
        </p>
      )}

      {phase === 'live' && state && <Controls state={state} inventory={inventory} threadId={threadId} />}
      <OutcomeLine outcome={last} waiting={waiting} />

      {inline ? (
        <Tabs defaultValue="commands">
          <TabsList className="flex w-full">
            <TabsTrigger value="commands">Commands</TabsTrigger>
            <TabsTrigger value="mcp">MCP servers</TabsTrigger>
            <TabsTrigger value="plugins">Plugins</TabsTrigger>
          </TabsList>
          <TabsContent value="commands">
            <CommandsTab inventory={inventory} />
          </TabsContent>
          <TabsContent value="mcp">
            <McpTab inventory={inventory} />
          </TabsContent>
          <TabsContent value="plugins">
            <PluginsTab inventory={inventory} />
          </TabsContent>
        </Tabs>
      ) : (
        <Link
          to="/settings/session"
          className="min-h-11 text-sm text-accent-text underline"
          data-testid="session-settings-link"
        >
          Commands, MCP servers and plugins: Settings › Session
        </Link>
      )}
    </div>
  )
}
