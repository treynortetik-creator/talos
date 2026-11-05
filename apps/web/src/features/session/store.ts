// The per-client session store (docs/CLAUDE-CODE.md C2.5, C4): last session.state / session.inventory, whether the mod
// is live, controls in flight and their outcomes. One controller per client (WeakMap), started from the app root so no
// frame is missed. Policy is never reimplemented here: planPaletteRun and checkSessionControl decide.
import {
  type AgentsSnapshotT,
  agentsForSession,
  canStopAgent,
  checkSessionControl,
  DEFAULT_SESSION_MODELS,
  type ErrorCodeT,
  effectiveModelList,
  type FrameOf,
  type InventoryCommandT,
  isStoppedAtMacReason,
  newUlid,
  planPaletteRun,
  type SessionInventoryT,
  type SessionStateT,
  STOPPED_AT_MAC_TEXT,
} from '@talos-app/protocol'
import { useEffect, useMemo } from 'react'
import { type StoreApi, useStore } from 'zustand'
import { createStore } from 'zustand/vanilla'
import { NotSentError, type TalosClient, TalosClientError, useTalosClient } from '../../lib/client.ts'
import { CONTROL_TIMEOUT_MS, isModOnline, NO_ANSWER_TEXT, SLOW_CONTROL_TIMEOUT_MS } from './logic.ts'

export type Outcome = {
  kind: 'ok' | 'pending' | 'error'
  text: string
  code?: ErrorCodeT
  /** Refused on the phone before anything was sent. */
  local?: boolean
}
export type Pending = { controlId: string; label: string /** agent_stop: the row being stopped. */; agentId?: string }

export type SessionStoreState = {
  state: SessionStateT | undefined
  inventory: SessionInventoryT | undefined
  /** docs/SUBAGENTS.md 6.3: the last agents snapshot (`ready.session_agents` / `session.agents`), replaced wholesale. */
  agents: AgentsSnapshotT | undefined
  now: number
  modOnline: boolean
  pending: Record<string, Pending>
  last: (Outcome & { at: number }) | undefined
  /** Agent Stop outcomes by agent id, apart from `last`: they outlive the row's detail and are announced by that row only. */
  agentOutcomes: Record<string, Outcome & { at: number }>
}

export type ControlFields =
  | { action: 'stop'; turn_id: string }
  | { action: 'compact'; args?: string }
  | { action: 'clear' }
  | { action: 'command'; command: string; args?: string }
  | { action: 'agent_stop'; agent_id: string }

export function buildControlFrame(threadId: string, controlId: string, f: ControlFields): Record<string, unknown> {
  return {
    type: 'session.control',
    control_id: controlId,
    thread_id: threadId,
    action: f.action,
    ...(f.action === 'stop' ? { turn_id: f.turn_id } : {}),
    ...(f.action === 'agent_stop' ? { agent_id: f.agent_id } : {}),
    ...(f.action === 'command' ? { command: f.command, source: 'builtin' } : {}),
    ...('args' in f && f.args !== undefined ? { args: f.args } : {}),
  }
}

/** The snapshot the panel draws: never a leftover of another session (docs/SUBAGENTS.md 6.1). */
export function visibleAgents(s: Pick<SessionStoreState, 'agents' | 'state'>): AgentsSnapshotT | undefined {
  return agentsForSession(s.agents, s.state)
}

/** Stop shows only for a stoppable live row of a can_stop snapshot, with a live (fresh) mod of that session. */
export function showsAgentStop(s: Pick<SessionStoreState, 'agents' | 'state' | 'modOnline'>, rowId: string): boolean {
  return s.modOnline && canStopAgent(visibleAgents(s), rowId, s.state)
}

export const AGENT_GONE_TEXT = 'That agent already ended. Nothing was stopped.'

const PENDING_CODES: readonly ErrorCodeT[] = ['model_switch_pending', 'effort_change_pending']

export function outcomeFromResult(f: { ok: boolean; code?: ErrorCodeT | undefined; text: string }): Outcome {
  const code = f.code
  if (f.ok) return { kind: 'ok', text: f.text || 'Done.' }
  if (code && PENDING_CODES.includes(code))
    return { kind: 'pending', text: f.text || 'Waiting for confirmation at the Mac.', code }
  if (code === 'stopped_at_mac' || isStoppedAtMacReason(f.text)) {
    return { kind: 'error', text: STOPPED_AT_MAC_TEXT, ...(code ? { code } : {}) }
  }
  return { kind: 'error', text: f.text || 'That did not work.', ...(code ? { code } : {}) }
}

export type ControllerOptions = { now?: () => number; timeoutMs?: number; tickMs?: number }

export type SessionController = {
  readonly store: StoreApi<SessionStoreState>
  /** Subscribes to the relay frames; refcounted, returns the unsubscribe. */
  start(): () => void
  allowedModels(): string[]
  stopTurn(threadId: string): Promise<Outcome>
  compact(threadId: string, args?: string): Promise<Outcome>
  clear(threadId: string): Promise<Outcome>
  /** `/model x`, `/effort x`, ...: any built-in through planPaletteRun. */
  command(threadId: string, name: string, args: string): Promise<Outcome>
  /** A picked or typed `/` command: planPaletteRun decides message vs control. */
  runPalette(threadId: string, pick: { source: string; name: string; args: string }): Promise<Outcome>
  /** docs/SUBAGENTS.md 6.2: a signed `session.control {action:'agent_stop', agent_id}` for one row. */
  stopAgent(threadId: string, agentId: string): Promise<Outcome>
  /** Clears one row's Stop outcome (calm results fade). */
  dismissAgentOutcome(agentId: string): void
  /** `/compact`, `/clear`, `/model x` typed in the composer: null unless the list knows a built-in of that name. */
  typed(threadId: string, text: string): (() => Promise<Outcome>) | null
  dismiss(): void
}

export function createSessionController(client: TalosClient, opts: ControllerOptions = {}): SessionController {
  const now = opts.now ?? Date.now
  // R4: the phone waits LONGER than the bridge's backstop (45 s; 5 min for compact and clear), so the bridge's own
  // answer wins; a result that still lands after the phone gave up replaces its "did not answer" (see settle).
  const timeoutFor = (action: string) =>
    opts.timeoutMs ?? (action === 'compact' || action === 'clear' ? SLOW_CONTROL_TIMEOUT_MS : CONTROL_TIMEOUT_MS)
  const timedOut = new Set<string>()
  const store = createStore<SessionStoreState>(() => ({
    state: undefined,
    inventory: undefined,
    agents: undefined,
    now: now(),
    modOnline: false,
    pending: {},
    last: undefined,
    agentOutcomes: {},
  }))
  const timers = new Map<string, ReturnType<typeof setTimeout>>()
  const waiters = new Map<string, (o: Outcome) => void>()
  /** control id -> agent id for agent_stop, so its answer lands on that row, never on the panel's `last`. */
  const agentOf = new Map<string, string>()

  const patch = (p: Partial<SessionStoreState>) =>
    store.setState((s) => {
      const n = { ...s, ...p }
      return { ...n, modOnline: isModOnline(n.state, n.now) }
    })

  const outcomeFor = (controlId: string, o: Outcome): Partial<SessionStoreState> => {
    const agentId = agentOf.get(controlId)
    if (!agentId) return { last: { ...o, at: now() } }
    return { agentOutcomes: { ...store.getState().agentOutcomes, [agentId]: { ...o, at: now() } } }
  }

  const settle = (controlId: string, o: Outcome) => {
    const w = waiters.get(controlId)
    if (!w && !store.getState().pending[controlId]) {
      // R4: a real answer after the phone gave up replaces the "did not answer" it showed
      if (timedOut.delete(controlId) && !(o.kind === 'error' && o.text === NO_ANSWER_TEXT))
        patch(outcomeFor(controlId, o))
      agentOf.delete(controlId)
      return
    }
    if (o.kind === 'error' && o.text === NO_ANSWER_TEXT) {
      timedOut.add(controlId)
      if (timedOut.size > 50)
        for (const k of timedOut) {
          timedOut.delete(k)
          agentOf.delete(k)
          break
        }
    }
    const t = timers.get(controlId)
    if (t) clearTimeout(t)
    timers.delete(controlId)
    waiters.delete(controlId)
    const { [controlId]: _gone, ...rest } = store.getState().pending
    patch({ pending: rest, ...outcomeFor(controlId, o) })
    if (!timedOut.has(controlId)) agentOf.delete(controlId) // a timed-out stop keeps it for a late answer
    w?.(o)
  }

  const local = (text: string, code?: ErrorCodeT): Outcome => {
    const o: Outcome = { kind: 'error', text, local: true, ...(code ? { code } : {}) }
    patch({ last: { ...o, at: now() } })
    return o
  }

  const allowedModels = () => {
    const inv = store.getState().inventory
    const configured = client.store.getState().config?.session_models ?? DEFAULT_SESSION_MODELS
    return effectiveModelList(configured, inv?.models.length ? inv.models.map((m) => m.value) : undefined)
  }

  async function send(label: string, threadId: string, f: ControlFields): Promise<Outcome> {
    const s = store.getState()
    // agent_stop: the published session.state never lists `agent_stop` (wireSessionState strips it for old peers), so
    // the phone's check is canStopAgent on the snapshot it drew (stopAgent); the bridge runs checkSessionControl.
    const pre =
      f.action === 'agent_stop'
        ? ({ ok: true } as const)
        : checkSessionControl(
            {
              action: f.action,
              ts: new Date(now()).toISOString(),
              ...(f.action === 'stop' ? { turn_id: f.turn_id } : {}),
              ...(f.action === 'command' ? { command: f.command, source: 'builtin' } : {}),
              ...('args' in f && f.args !== undefined ? { args: f.args } : {}),
            },
            { now: now(), state: s.state, inventory: s.inventory, allowedModels: allowedModels() },
          )
    if (!pre.ok) return local(pre.message, pre.code)
    const send_ = client.sendOwnerFrame
    if (!send_) return local('This build cannot send session controls.')
    const controlId = newUlid()
    const answered = new Promise<Outcome>((res) => waiters.set(controlId, res))
    timers.set(
      controlId,
      setTimeout(() => settle(controlId, { kind: 'error', text: NO_ANSWER_TEXT }), timeoutFor(f.action)),
    )
    const pend: Pending = { controlId, label, ...(f.action === 'agent_stop' ? { agentId: f.agent_id } : {}) }
    if (f.action === 'agent_stop') {
      agentOf.set(controlId, f.agent_id)
      const { [f.agent_id]: _old, ...others } = s.agentOutcomes
      patch({ pending: { ...s.pending, [controlId]: pend }, agentOutcomes: others })
    } else patch({ pending: { ...s.pending, [controlId]: pend }, last: undefined })
    try {
      await send_.call(client, buildControlFrame(threadId, controlId, f))
    } catch (e) {
      settle(controlId, {
        kind: 'error',
        text: e instanceof TalosClientError && e.message ? e.message : "Couldn't reach the Mac.",
        ...(e instanceof TalosClientError ? { code: e.code } : {}),
        // Failed before anything was sent: the typed command can go back in the box. A timeout may have arrived.
        ...(e instanceof NotSentError ? { local: true } : {}),
      })
    }
    return answered
  }

  async function runPalette(threadId: string, pick: { source: string; name: string; args: string }): Promise<Outcome> {
    const s = store.getState()
    const plan = planPaletteRun(pick, { inventory: s.inventory, allowedModels: allowedModels() })
    if (!plan.ok) return local(plan.message, plan.code)
    if (plan.kind === 'message') {
      try {
        await client.sendMessage({ threadId, text: plan.text })
        return { kind: 'ok', text: 'Sent.' }
      } catch {
        return local("Couldn't send.")
      }
    }
    const label = `/${pick.name}`
    if (plan.action === 'compact')
      return send(label, threadId, plan.args ? { action: 'compact', args: plan.args } : { action: 'compact' })
    if (plan.action === 'clear') return send(label, threadId, { action: 'clear' })
    return send(
      label,
      threadId,
      plan.args
        ? { action: 'command', command: plan.command, args: plan.args }
        : { action: 'command', command: plan.command },
    )
  }

  let refs = 0
  let off: Array<() => void> = []
  let tick: ReturnType<typeof setInterval> | undefined

  const ctl: SessionController = {
    store,
    start() {
      if (refs++ === 0) {
        off = [
          client.onFrame('session.state', (f: FrameOf<'session.state'>) => {
            // a thread's own session (docs/OPTION-C.md) has its own state; this store is main's
            if (f.state.scope !== undefined && f.state.scope !== 'main') return
            patch({ state: f.state, now: now() })
          }),
          client.onFrame('session.inventory', (f: FrameOf<'session.inventory'>) => patch({ inventory: f.inventory })),
          client.onFrame('session.agents', (f: FrameOf<'session.agents'>) => patch({ agents: f.agents })),
          client.onFrame('session.control.result', (f: FrameOf<'session.control.result'>) =>
            settle(f.control_id, outcomeFromResult(f)),
          ),
          client.onFrame('ready', (f: FrameOf<'ready'>) =>
            patch({
              now: now(),
              // main's slot: a scoped state is a thread session's, wherever it arrives
              ...(f.session_state && (f.session_state.scope ?? 'main') === 'main' ? { state: f.session_state } : {}),
              ...(f.session_inventory ? { inventory: f.session_inventory } : {}),
              ...(f.session_agents ? { agents: f.session_agents } : {}),
            }),
          ),
        ]
        tick = setInterval(() => patch({ now: now() }), opts.tickMs ?? 5000)
      }
      let done = false
      return () => {
        if (done) return
        done = true
        if (--refs === 0) {
          for (const o of off) o()
          off = []
          if (tick) clearInterval(tick)
        }
      }
    },
    allowedModels,
    stopTurn(threadId) {
      const s = store.getState().state
      if (!s?.turn_id) return Promise.resolve(local('That turn already ended. Nothing was stopped.', 'turn_mismatch'))
      return send('Stop', threadId, { action: 'stop', turn_id: s.turn_id })
    },
    stopAgent(threadId, agentId) {
      const s = store.getState()
      if (!showsAgentStop(s, agentId)) {
        const o: Outcome = { kind: 'error', text: AGENT_GONE_TEXT, code: 'agent_not_found', local: true }
        patch({ agentOutcomes: { ...s.agentOutcomes, [agentId]: { ...o, at: now() } } })
        return Promise.resolve(o)
      }
      return send('Stop agent', threadId, { action: 'agent_stop', agent_id: agentId })
    },
    dismissAgentOutcome(agentId) {
      const { [agentId]: _gone, ...rest } = store.getState().agentOutcomes
      patch({ agentOutcomes: rest })
    },
    compact: (threadId, args) => runPalette(threadId, { source: 'builtin', name: 'compact', args: args ?? '' }),
    clear: (threadId) => runPalette(threadId, { source: 'builtin', name: 'clear', args: '' }),
    command: (threadId, name, args) => runPalette(threadId, { source: 'builtin', name, args }),
    runPalette,
    typed(threadId, text) {
      const m = /^\/(\S+)(?:\s+(.*))?$/s.exec(text.trim())
      const inv = store.getState().inventory
      if (!m || !inv) return null
      const name = m[1] as string
      const same: InventoryCommandT[] = inv.commands.filter((c) => c.name === name)
      if (!same.some((c) => c.source === 'builtin') || same.some((c) => c.source !== 'builtin')) return null
      return () => runPalette(threadId, { source: 'builtin', name, args: (m[2] ?? '').trim() })
    },
    dismiss() {
      patch({ last: undefined })
    },
  }
  return ctl
}

const controllers = new WeakMap<TalosClient, SessionController>()
export function getSessionController(client: TalosClient, opts?: ControllerOptions): SessionController {
  let c = controllers.get(client)
  if (!c) {
    c = createSessionController(client, opts)
    controllers.set(client, c)
  }
  return c
}

/** The controller for the current client, started while the component is mounted (refcounted). */
export function useSessionController(): SessionController {
  const client = useTalosClient()
  const c = useMemo(() => getSessionController(client), [client])
  useEffect(() => c.start(), [c])
  return c
}

export function useSession<T>(selector: (s: SessionStoreState) => T): T {
  return useStore(useSessionController().store, selector)
}
