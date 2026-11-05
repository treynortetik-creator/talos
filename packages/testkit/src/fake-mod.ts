// FakeEngine + FakeMod: a stand-in for the Talos mod running inside a Claude Code session (docs/CLAUDE-CODE.md C2.3,
// C4). FakeEngine models the documented engine behaviour the mod relies on: `$.turn.abort` refuses a turn that is not
// the running one; `$.session.compact` rejects mid-turn; after the user interrupts, new work is refused until the
// user's next input; `/model` asks while the cache is warm and the target is not the model that answered last; a
// PreModelSwitch decision follows deny > ask > allow and `ask` is a refusal off the terminal; effort changes ask on
// models that do not keep the cache. FakeMod drives it the way the real mod must (capability check by typeof, the
// fail-closed guard, one-shot model tickets, the 15 s pending timeout) and builds `talos_mod_sync` requests.
// Agents panel (docs/SUBAGENTS.md): FakeEngine also holds a task registry (subagents, teammates, shells, monitors) with
// `TaskStop` semantics; FakeMod turns it into `agents` on a sync (only when it changed) and runs `agent_stop`.
import {
  AGENT_LIMITS,
  type AgentKindT,
  type AgentRunStatusT,
  type AgentsSnapshotT,
  agentActivityForTool,
  agentsSnapshotFromEngine,
  CLAUDE_CODE_MIN_VERSION,
  DEFAULT_SESSION_MODELS,
  DOCUMENTED_EFFORTS,
  effortKeepsCache,
  inventoryCommandsFromEngine,
  isLiveAgentStatus,
  isModToolName,
  isShadowedBuiltin,
  MODEL_SWITCH_TIMEOUT_MS,
  ModControl,
  type ModControlResultT,
  type ModControlT,
  type ModEventT,
  type ModSyncRequestT,
  OWN_ACTION_COMMANDS,
  routeFor,
  type SessionCapabilityT,
  type SessionInventoryT,
  type SessionStateT,
  STOPPED_AT_MAC_TEXT,
  sameAgentsSnapshot,
} from '@talos-app/protocol'
import type { Clock } from './clock.ts'
import type { EngineDriver, ModDriver, ModEngineOptions } from './contract/mod-control.ts'

/** Engine methods the mod checks with `typeof` at session.start, and the capability each one gives. */
const METHOD_CAPS: Array<[string, SessionCapabilityT[]]> = [
  ['turn.abort', ['stop']],
  ['session.compact', ['compact']],
  ['command.run', ['command', 'clear', 'model', 'effort']],
  ['command.list', ['inventory']],
  ['tool.check', ['permission_close']],
  ['agent.list', ['sessions', 'agents']],
  // the mod probes `$.tool.call({ tool: 'TaskStop', ... })` with a bogus id (docs/SUBAGENTS.md, SMOKE S-A6)
  ['tool.call', ['agent_stop']],
]

/** One entry of the fake engine's task registry: what `$.agent.list()`, the mod's hooks and the tee would tell it. */
export type FakeTask = {
  id: string
  kind: AgentKindT
  type: string
  description: string
  status: AgentRunStatusT
  background: boolean
  startedAt: number
  endedAt?: number
  parentId?: string
  name?: string
  model?: string
  tokens?: number
  /** The tee's progress summary, when the CLI has one. */
  label?: string
  /** The latest tool-call line. */
  toolLine?: string
  recent: Array<{ at: number; text: string }>
}

/** What `$.command.list()` returns in the fake: the C4.2 built-ins, a few local-only ones, one skill. */
const ENGINE_COMMANDS = [
  ...['context', 'usage', 'recap', 'mcp', 'reload-plugins', 'model', 'effort', 'fast', 'compact', 'clear'].map(
    (name) => ({
      name,
      description: `/${name}`,
      source: 'builtin',
    }),
  ),
  ...['permissions', 'login', 'resume', 'config'].map((name) => ({ name, description: `/${name}`, source: 'builtin' })),
  { name: 'release-notes', description: 'Draft release notes', source: 'user' },
]

function versionAtLeast(v: string, floor: string): boolean {
  const a = v.split('.').map((x) => Number.parseInt(x, 10))
  const b = floor.split('.').map((x) => Number.parseInt(x, 10))
  for (let i = 0; i < 3; i++) {
    const x = a[i] ?? 0
    const y = b[i] ?? 0
    if (!Number.isFinite(x)) return false
    if (x !== y) return x > y
  }
  return true
}

export class FakeEngine implements EngineDriver {
  model: string
  effort: string | undefined
  compactions = 0
  clears = 0
  busy = false
  turnId: string | undefined
  stoppedAtMac = false
  cacheWarm: boolean
  lastResponseModel: string
  readonly events: ModEventT[] = []
  /** A compact the mod is holding until the running turn completes. */
  pendingCompact = false
  /** The task registry, in spawn order. */
  readonly tasks = new Map<string, FakeTask>()
  /** Every `TaskStop` the mod called, in order. */
  readonly taskStops: string[] = []

  constructor(
    private readonly clock: Clock,
    opts: ModEngineOptions,
  ) {
    this.model = opts.model ?? 'claude-opus-5-5'
    this.effort = opts.effort
    this.cacheWarm = opts.cacheWarm ?? false
    this.lastResponseModel = this.model
  }

  private at() {
    return new Date(this.clock.now()).toISOString()
  }
  emit(e: Record<string, unknown>) {
    this.events.push({ ...e, at: this.at() } as ModEventT)
  }

  startTurn(turnId: string): void {
    this.busy = true
    this.turnId = turnId
    this.emit({ type: 'turn_start', turn_id: turnId })
  }
  completeTurn(): void {
    if (!this.busy || !this.turnId) return
    this.emit({ type: 'turn_complete', turn_id: this.turnId, aborted: false })
    this.busy = false
    this.turnId = undefined
    this.cacheWarm = true
    this.lastResponseModel = this.model
    if (this.pendingCompact) {
      this.pendingCompact = false
      this.compact()
    }
  }
  abort(): void {
    if (this.turnId) this.emit({ type: 'turn_complete', turn_id: this.turnId, aborted: true })
    this.busy = false
    this.turnId = undefined
  }
  userInterrupt(): void {
    this.abort()
    this.stoppedAtMac = true
    this.emit({ type: 'stopped_at_mac' })
  }
  userInput(): void {
    this.stoppedAtMac = false
  }
  compact(): void {
    this.emit({ type: 'compacting', on: true })
    this.compactions++
    this.cacheWarm = false
    this.emit({ type: 'compacting', on: false })
  }

  // ---- agents (docs/SUBAGENTS.md) ----------------------------------------------------------------------------------

  /** A subagent (or teammate, workflow, remote agent) starts. */
  spawnAgent(a: {
    id: string
    type?: string
    description: string
    kind?: AgentKindT
    background?: boolean
    parentId?: string
    name?: string
    model?: string
  }): void {
    this.tasks.set(a.id, {
      id: a.id,
      kind: a.kind ?? 'subagent',
      type: a.type ?? 'general-purpose',
      description: a.description,
      status: 'running',
      background: a.background ?? true,
      startedAt: this.clock.now(),
      recent: [],
      ...(a.parentId ? { parentId: a.parentId } : {}),
      ...(a.name ? { name: a.name } : {}),
      ...(a.model ? { model: a.model } : {}),
    })
  }
  /** A background shell (`Bash` with run_in_background) or a `Monitor` starts. */
  startShell(id: string, description: string, kind: 'shell' | 'monitor' = 'shell'): void {
    this.tasks.set(id, {
      id,
      kind,
      type: kind,
      description,
      status: 'running',
      background: true,
      startedAt: this.clock.now(),
      recent: [],
    })
  }
  /** A tool call inside a subagent (the mod's `tool.call` hook with `e.agentId`). Inputs only, never results. */
  agentTool(id: string, toolName: string, input: unknown): void {
    const t = this.tasks.get(id)
    if (!t) return
    const text = agentActivityForTool(toolName, input)
    t.toolLine = text
    t.recent.push({ at: this.clock.now(), text })
    if (t.recent.length > AGENT_LIMITS.recent) t.recent.splice(0, t.recent.length - AGENT_LIMITS.recent)
  }
  /** The CLI's own progress summary for the task (the `subagentStatusLine` tee). */
  agentSummary(id: string, label: string | undefined): void {
    const t = this.tasks.get(id)
    if (t) t.label = label
  }
  agentUsage(id: string, tokens: number): void {
    const t = this.tasks.get(id)
    if (t) t.tokens = tokens
  }
  setTaskStatus(id: string, status: AgentRunStatusT): void {
    const t = this.tasks.get(id)
    if (!t) return
    t.status = status
    if (!isLiveAgentStatus(status) && status !== 'unknown') t.endedAt = this.clock.now()
  }
  /** `TaskStop`: stops a live task; refuses an unknown or ended one (as the tool does, with an error). */
  stopTask(id: string): boolean {
    this.taskStops.push(id)
    const t = this.tasks.get(id)
    if (!t || !isLiveAgentStatus(t.status)) return false
    this.setTaskStatus(id, 'killed')
    return true
  }
}

export type FakeModOptions = ModEngineOptions & { clock: Clock }

export class FakeMod implements ModDriver {
  readonly engine: FakeEngine
  private readonly clock: Clock
  private readonly opts: FakeModOptions
  private readonly missing: Set<string>
  private results: ModControlResultT[] = []
  private sentInventory = false
  private sentAgents: AgentsSnapshotT | undefined

  constructor(opts: FakeModOptions) {
    this.opts = opts
    this.clock = opts.clock
    this.missing = new Set(opts.missingMethods ?? [])
    this.engine = new FakeEngine(opts.clock, opts)
  }

  get version(): string {
    return this.opts.version ?? '2.1.312'
  }

  private has(method: string): boolean {
    return versionAtLeast(this.version, CLAUDE_CODE_MIN_VERSION) && !this.missing.has(method)
  }

  /** The capability report: below the floor version, nothing; otherwise one entry per method found. */
  capabilities(): SessionCapabilityT[] {
    if (!versionAtLeast(this.version, CLAUDE_CODE_MIN_VERSION)) return []
    const out = new Set<SessionCapabilityT>()
    for (const [m, caps] of METHOD_CAPS) if (this.has(m)) for (const c of caps) out.add(c)
    return [...out]
  }

  state(): SessionStateT {
    const e = this.engine
    const s: SessionStateT = {
      session_id: 'sess_fake',
      source: 'mod',
      capabilities: this.capabilities(),
      version: this.version,
      model: { id: e.model },
      busy: e.busy,
      compacting: false,
      stopped_at_mac: e.stoppedAtMac,
      rate_limits: [],
      surfaces: ['cli'],
      at: new Date(this.clock.now()).toISOString(),
    }
    if (e.effort !== undefined) s.effort = e.effort
    if (e.turnId !== undefined) s.turn_id = e.turnId
    return s
  }

  inventory(): SessionInventoryT {
    return {
      commands: inventoryCommandsFromEngine(this.engineCommands()).commands,
      models: DEFAULT_SESSION_MODELS.map((value) => ({ value, label: value[0]?.toUpperCase() + value.slice(1) })),
      efforts: [...DOCUMENTED_EFFORTS],
      mcp_servers: [{ name: 'talos-app', tools: 12, status: 'connected' }],
      plugins: [{ name: 'talos-app-mod', enabled: true }],
      at: new Date(this.clock.now()).toISOString(),
    }
  }

  private engineCommands() {
    return [...ENGINE_COMMANDS, ...(this.opts.extraCommands ?? [])]
  }

  /**
   * The agents snapshot the mod would build now (docs/SUBAGENTS.md), or undefined without `$.agent.list`. Activity is
   * the tee's summary when it differs from the description, else the latest tool line. Ended tasks older than
   * AGENT_LIMITS.keepEndedMs are left out.
   */
  agents(): AgentsSnapshotT | undefined {
    if (!this.has('agent.list')) return undefined
    const now = this.clock.now()
    const rows = [...this.engine.tasks.values()]
      .filter((t) => t.endedAt === undefined || now - t.endedAt <= AGENT_LIMITS.keepEndedMs)
      .map((t) => {
        const summary = t.label && t.label !== t.description ? t.label : undefined
        const activity = summary ?? t.toolLine
        return {
          id: t.id,
          kind: t.kind,
          type: t.type,
          description: t.description,
          status: t.status,
          background: t.background,
          startTime: t.startedAt,
          ...(t.endedAt !== undefined ? { endedAt: t.endedAt } : {}),
          ...(t.parentId ? { parentId: t.parentId } : {}),
          ...(t.name ? { name: t.name } : {}),
          ...(t.model ? { model: t.model } : {}),
          ...(t.tokens !== undefined ? { tokenCount: t.tokens } : {}),
          ...(activity ? { activity, activitySource: summary ? 'summary' : 'tool' } : {}),
          recent: t.recent,
        }
      })
    const tee = [...this.engine.tasks.values()].some((t) => t.label !== undefined)
    const r = agentsSnapshotFromEngine(rows, {
      session_id: 'sess_fake',
      source: tee ? 'mod+tee' : 'mod',
      canStop: this.has('tool.call'),
      at: new Date(now).toISOString(),
    })
    return r.ok ? r.snapshot : undefined
  }

  /**
   * The body of one `talos_mod_sync` call: state always, inventory on the first sync, drained events and results, and
   * `agents` only when it changed since the last one sent (an empty list before any task counts as unchanged).
   */
  syncRequest(modKey: string): ModSyncRequestT {
    const req: ModSyncRequestT = { mod_key: modKey, state: this.state() }
    if (!this.sentInventory) {
      req.inventory = this.inventory()
      this.sentInventory = true
    }
    const agents = this.agents()
    const last = this.sentAgents ?? (agents ? { ...agents, rows: [] } : undefined)
    if (agents && !sameAgentsSnapshot(last, agents)) {
      req.agents = agents
      this.sentAgents = agents
    }
    const events = this.engine.events.splice(0)
    if (events.length) req.events = events
    const results = this.results.splice(0)
    if (results.length) req.results = results
    return req
  }

  /** The `tool.check` guard: every caller's call to a mod tool is denied; a guard that throws still denies. */
  async guard(e: { toolName: string; agentId?: string }): Promise<{ decision: 'deny' } | undefined> {
    return (async () => (isModToolName(e.toolName) ? ({ decision: 'deny' } as const) : undefined))().catch(
      () => ({ decision: 'deny' }) as const,
    )
  }

  async execute(raw: ModControlT): Promise<ModControlResultT> {
    const r = await this.run(raw)
    this.results.push(r)
    return r
  }

  private async run(raw: ModControlT): Promise<ModControlResultT> {
    const parsed = ModControl.safeParse(raw)
    const id = (raw as { control_id?: string }).control_id ?? ''
    const res = (ok: boolean, text: string, code?: ModControlResultT['code']): ModControlResultT =>
      code ? { control_id: id, ok, code, text } : { control_id: id, ok, text }
    if (!parsed.success) return res(false, 'Not a valid control.', 'args_invalid')
    const c = parsed.data
    const e = this.engine
    if (e.stoppedAtMac) return res(false, STOPPED_AT_MAC_TEXT, 'stopped_at_mac')
    const need = (m: string) =>
      this.has(m) ? null : res(false, 'This Claude Code cannot do that.', 'capability_missing')
    switch (c.action) {
      case 'stop': {
        const missing = need('turn.abort')
        if (missing) return missing
        if (!e.busy || e.turnId !== c.turn_id)
          return res(false, 'That turn already ended. Nothing was stopped.', 'turn_mismatch')
        e.abort()
        return res(true, 'Stopped.')
      }
      case 'compact': {
        const missing = need('session.compact')
        if (missing) return missing
        if (e.busy) {
          e.pendingCompact = true
          return res(true, 'Compacts after this turn.')
        }
        e.compact()
        return res(true, 'Compacted.')
      }
      case 'clear': {
        const missing = need('command.run')
        if (missing) return missing
        e.clears++
        e.cacheWarm = false
        return res(true, 'New conversation started.')
      }
      case 'command': {
        const missing = need('command.run')
        if (missing) return missing
        const name = c.command as string
        if (
          routeFor({ source: 'builtin', name }) !== 'control' ||
          (OWN_ACTION_COMMANDS as readonly string[]).includes(name)
        )
          return res(false, 'Run this at the Mac.', 'command_not_allowed')
        if (isShadowedBuiltin(this.engineCommands(), name))
          return res(false, 'A skill or plugin uses this name too. Run it at the Mac.', 'command_not_allowed')
        if (name === 'model') return this.switchModel(c, res)
        if (name === 'effort') return this.setEffort(c, res)
        return res(true, `/${name}${c.args ? ` ${c.args}` : ''} output`)
      }
      case 'agent_stop': {
        const missing = need('tool.call')
        if (missing) return missing
        return e.stopTask(c.agent_id as string)
          ? res(true, 'Stopped.')
          : res(false, 'That agent already ended. Nothing was stopped.', 'agent_not_found')
      }
    }
  }

  private wait(ms: number): Promise<void> {
    return new Promise((r) => this.clock.setTimeout(r, ms))
  }

  private async switchModel(
    c: ModControlT,
    res: (ok: boolean, text: string, code?: ModControlResultT['code']) => ModControlResultT,
  ): Promise<ModControlResultT> {
    const e = this.engine
    const to = c.args ?? ''
    const t = c.model_ticket
    // The ticket must name exactly this switch and still be live; it is burned either way.
    if (!t || t.to_model !== to || this.clock.now() > Date.parse(t.expires_at))
      return res(false, 'No matching approval for this switch.', 'args_invalid')
    const user = this.opts.userModelHook ?? 'none'
    const modAllows = this.opts.modDecisionHonoured ?? true
    // PreModelSwitch precedence: deny > ask > allow
    if (user === 'deny')
      return res(
        false,
        `Blocked by a PreModelSwitch hook: ${this.opts.userModelHookReason ?? 'no reason given'}`,
        'model_switch_denied',
      )
    if (user === 'ask')
      return res(
        false,
        'A PreModelSwitch hook asked to confirm; away from the terminal that is a refusal.',
        'model_switch_denied',
      )
    const asks = e.cacheWarm && to !== e.lastResponseModel
    const allowed = user === 'allow' || modAllows
    if (asks && !allowed) {
      await this.wait(MODEL_SWITCH_TIMEOUT_MS)
      return res(false, 'Waiting for confirmation at the Mac.', 'model_switch_pending')
    }
    e.model = to
    e.cacheWarm = false
    e.emit({ type: 'model_switched', model: to })
    return res(true, `Model set to ${to}. Also becomes the default for new sessions.`)
  }

  private async setEffort(
    c: ModControlT,
    res: (ok: boolean, text: string, code?: ModControlResultT['code']) => ModControlResultT,
  ): Promise<ModControlResultT> {
    const e = this.engine
    const level = c.args ?? ''
    if (level !== 'auto' && !(DOCUMENTED_EFFORTS as readonly string[]).includes(level))
      return res(false, 'Pick an effort level.', 'args_invalid')
    if (e.cacheWarm && !effortKeepsCache(e.model)) {
      await this.wait(MODEL_SWITCH_TIMEOUT_MS)
      return res(false, 'Waiting for confirmation at the Mac.', 'effort_change_pending')
    }
    e.effort = level === 'auto' ? undefined : level
    e.emit({ type: 'effort_changed', effort: level })
    return res(true, 'Applies from the next message.')
  }
}
