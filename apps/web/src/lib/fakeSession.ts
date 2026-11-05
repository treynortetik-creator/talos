// A scripted fake Claude Code session for VITE_FAKE (CC-C3): state, inventory, a heartbeat, and answers to
// session.control that go through the real checkSessionControl, so tests cannot pass on a policy the app never meets.
import {
  AgentRow,
  type AgentRowT,
  AgentsSnapshot,
  type AgentsSnapshotT,
  checkSessionControl,
  type ErrorCodeT,
  markAgentsUnknown,
  SessionInventory,
  type SessionInventoryT,
  SessionState,
  type SessionStateT,
} from '@talos-app/protocol'

export type FakeModMode = 'live' | 'offline' | 'absent'
/** docs/SUBAGENTS.md: 'demo' = a scripted roster, 'empty' = a mod with `agents` and no rows, 'none' = a mod without it. */
export type FakeAgentsMode = 'demo' | 'empty' | 'none'

export interface FakeSession {
  mode(): FakeModMode
  /** live: state with capabilities + heartbeat. offline: the bridge's "mod lapsed" state (no capabilities). absent: nothing. */
  setMod(mode: FakeModMode): void
  /** Merge into the state and push it (e.g. `{busy:true, turn_id:'turn_1'}`). */
  patch(p: Partial<SessionStateT>): void
  /** Push a state whose `at` is old, as a mod that stopped heartbeating would leave it. */
  pushStale(ageMs: number): void
  setInventory(inv: SessionInventoryT): void
  /** The next control is answered with this failure. */
  failNext(code: ErrorCodeT, text: string): void
  /** Stop answering controls (the "no answer" path). */
  mute(on: boolean): void
  /** The agents snapshot (bridge-held, unstripped); undefined = the mod has no `agents`. */
  agents(): AgentsSnapshotT | undefined
  /** Replace the rows (partial rows get defaults) and push a `session.agents`; `null` drops the snapshot. */
  setAgents(rows: Array<Partial<AgentRowT> & { id: string }> | null, over?: Partial<AgentsSnapshotT>): void
  /** Every session.control frame received, in order. */
  readonly controls: Array<Record<string, unknown>>
  state(): SessionStateT | undefined
  inventory(): SessionInventoryT | undefined
  /** Used by fakeClient. */
  readyFields(): {
    session_state?: SessionStateT
    session_inventory?: SessionInventoryT
    session_agents?: AgentsSnapshotT
  }
  handle(frame: Record<string, unknown>): void
  startHeartbeat(): void
  dispose(): void
}

const MODELS: Record<string, { id: string; display: string }> = {
  default: { id: 'claude-opus-5-5', display: 'Opus 5.5' },
  opus: { id: 'claude-opus-5-5', display: 'Opus 5.5' },
  sonnet: { id: 'claude-sonnet-5-5', display: 'Sonnet 5.5' },
  haiku: { id: 'claude-haiku-5-5', display: 'Haiku 5.5' },
}

const CAPS = ['stop', 'compact', 'command', 'clear', 'model', 'effort', 'inventory'] as const

export function fakeInventory(at: string): SessionInventoryT {
  return SessionInventory.parse({
    commands: [
      { name: 'context', description: 'Show context usage', source: 'builtin', route: 'control' },
      { name: 'usage', description: 'Show plan usage', source: 'builtin', route: 'control' },
      { name: 'compact', description: 'Compact the conversation', source: 'builtin', route: 'control' },
      { name: 'clear', description: 'Start a new conversation', source: 'builtin', route: 'control' },
      { name: 'model', description: 'Switch model', source: 'builtin', route: 'control' },
      { name: 'effort', description: 'Set effort', source: 'builtin', route: 'control' },
      { name: 'permissions', description: 'Manage permissions', source: 'builtin', route: 'local_only' },
      { name: 'help', description: 'Show help', source: 'builtin', route: 'local_only' },
      { name: 'release-notes', description: 'Draft release notes from merged PRs', source: 'user', route: 'message' },
      {
        name: 'deploy',
        description: 'Ship it. Only a person at the keyboard may run this.',
        source: 'user',
        route: 'message',
        at_mac_only: true,
      },
      {
        name: 'frontend-design:polish',
        description: 'Polish a UI until it ships',
        source: 'plugin',
        plugin: 'frontend-design',
        route: 'message',
      },
      {
        name: 'github:summarize-pr',
        description: 'Summarize a pull request',
        source: 'mcp',
        plugin: 'github',
        route: 'message',
      },
    ],
    models: [
      { value: 'default', label: 'Default' },
      { value: 'opus', label: 'Opus' },
      { value: 'sonnet', label: 'Sonnet' },
      { value: 'haiku', label: 'Haiku' },
    ],
    efforts: ['low', 'medium', 'high', 'xhigh', 'max'],
    mcp_servers: [
      { name: 'github', tools: 12, status: 'connected' },
      { name: 'notion', tools: 0, status: 'unknown' },
    ],
    plugins: [
      { name: 'frontend-design', enabled: true },
      { name: 'talos-app-mod', enabled: true },
      { name: 'old-linter', enabled: false },
    ],
    at,
  })
}

const SESSION_ID = 'sess_fake'

/** The demo roster, times relative to now: what a busy session looks like in the CLI's agent panel. */
export function fakeAgentRows(nowMs: number): AgentRowT[] {
  const ago = (s: number) => new Date(nowMs - s * 1000).toISOString()
  return [
    {
      id: 'a00f4f30ac1399f7f',
      kind: 'subagent',
      type: 'Explore',
      title: 'research mods API',
      status: 'running',
      activity: 'Running memory and search vitest suites',
      activity_source: 'summary',
      model: 'claude-sonnet-5-5',
      tokens: 12_300,
      started_at: ago(134),
      background: true,
      stoppable: true,
      recent: [
        { at: ago(120), text: 'Read docs/SUBAGENTS.md' },
        { at: ago(96), text: 'Search "agent.list"' },
        { at: ago(51), text: 'Read register.ts' },
        { at: ago(8), text: 'Run vitest suites' },
      ],
    },
    {
      id: 'tm_reviewer_1',
      kind: 'teammate',
      type: 'general-purpose',
      name: 'reviewer',
      title: 'Review the protocol diff',
      status: 'idle',
      activity: 'Search "AgentsSnapshot"',
      activity_source: 'tool',
      parent_id: 'a00f4f30ac1399f7f',
      model: 'claude-opus-5-5',
      tokens: 4100,
      started_at: ago(120),
      background: true,
      stoppable: true,
      recent: [{ at: ago(30), text: 'Search "AgentsSnapshot"' }],
    },
    {
      id: 'a7d1e0c55b2f',
      kind: 'subagent',
      type: 'Explore',
      title: 'find the trim tests',
      status: 'running',
      activity: 'Read session-agents.test.ts',
      activity_source: 'tool',
      parent_id: 'tm_reviewer_1',
      tokens: 900,
      started_at: ago(25),
      background: true,
      stoppable: true,
      recent: [],
    },
    {
      id: 'a3c9b1f27e04',
      kind: 'subagent',
      type: 'general-purpose',
      title: 'Fix the flaky e2e spec',
      status: 'failed',
      activity: 'Bash: pnpm test:e2e exited 1',
      activity_source: 'tool',
      model: 'claude-sonnet-5-5',
      tokens: 31_800,
      started_at: ago(610),
      ended_at: ago(95),
      background: true,
      stoppable: false,
      recent: [
        { at: ago(140), text: 'Edit fake-mode.spec.ts' },
        { at: ago(97), text: 'Run e2e on WebKit' },
      ],
    },
    {
      id: 'a51d0c7e2f9b4a113',
      kind: 'subagent',
      type: 'general-purpose',
      title: 'Draft release notes',
      status: 'completed',
      model: 'claude-haiku-5-5',
      tokens: 8800,
      started_at: ago(900),
      ended_at: ago(449),
      background: false,
      stoppable: false,
      recent: [{ at: ago(460), text: 'Write release-notes.md' }],
    },
    {
      id: 'b7c2e91d',
      kind: 'shell',
      type: 'shell',
      title: 'Run the dev server',
      status: 'running',
      activity: 'pnpm dev',
      activity_source: 'tool',
      started_at: ago(1400),
      background: true,
      stoppable: true,
      recent: [],
    },
    {
      id: 'b0aa41c3',
      kind: 'shell',
      type: 'shell',
      title: 'Watch the type checker',
      status: 'running',
      activity: 'tsc --watch',
      activity_source: 'tool',
      started_at: ago(700),
      background: true,
      stoppable: true,
      recent: [],
    },
    {
      id: 'm19f2e7a',
      kind: 'monitor',
      type: 'monitor',
      title: 'Wait for CI on PR 58',
      status: 'running',
      started_at: ago(300),
      background: true,
      stoppable: true,
      recent: [],
    },
  ]
}

export function createFakeSession(deps: {
  now: () => number
  emit: (type: string, fields: Record<string, unknown>) => void
  initial?: FakeModMode
  agents?: FakeAgentsMode
  allowedModels: () => readonly string[]
}): FakeSession {
  const iso = (ms = deps.now()) => new Date(ms).toISOString()
  let mode: FakeModMode = deps.initial ?? 'live'
  let state: SessionStateT | undefined
  let inventory: SessionInventoryT | undefined
  let fail: { code: ErrorCodeT; text: string } | null = null
  let muted = false
  let beat: ReturnType<typeof setInterval> | undefined
  const controls: Array<Record<string, unknown>> = []
  const agentsMode: FakeAgentsMode = deps.agents ?? 'none'
  let agents: AgentsSnapshotT | undefined =
    agentsMode === 'none' || mode === 'absent'
      ? undefined
      : AgentsSnapshot.parse({
          session_id: SESSION_ID,
          source: 'mod+tee',
          can_stop: true,
          rows: agentsMode === 'demo' ? fakeAgentRows(deps.now()) : [],
          at: iso(),
        })
  // The bridge marks live rows `unknown` when the mod lapses (docs/SUBAGENTS.md 5.3).
  if (agents && mode === 'offline') agents = markAgentsUnknown(agents, iso())
  const pushAgents = () => {
    if (agents) deps.emit('session.agents', { agents })
  }

  const liveState = (): SessionStateT =>
    SessionState.parse({
      session_id: SESSION_ID,
      source: 'mod',
      capabilities: [...CAPS],
      version: '2.1.312',
      model: MODELS.opus,
      effort: 'high',
      busy: false,
      context: { tokens: 310_000, window: 1_000_000, percent: 31 },
      cost_usd: 1.84,
      rate_limits: [
        { kind: 'five_hour', percent: 28, resets_at: iso(deps.now() + 2 * 3_600_000) },
        { kind: 'seven_day', percent: 60, resets_at: iso(deps.now() + 3 * 86_400_000) },
      ],
      surfaces: ['cli', 'talos'],
      at: iso(),
    })

  const push = () => {
    if (state) deps.emit('session.state', { state })
  }
  const setState = (p: Partial<SessionStateT>) => {
    if (!state) state = liveState()
    state = { ...state, ...p, at: p.at ?? iso() }
    push()
  }

  if (mode === 'live') {
    state = liveState()
    inventory = fakeInventory(iso())
  } else if (mode === 'offline') {
    state = { ...liveState(), capabilities: [] }
    inventory = fakeInventory(iso())
  }

  const result = (controlId: string, ok: boolean, text: string, code?: ErrorCodeT) => {
    if (muted) return
    setTimeout(
      () =>
        deps.emit('session.control.result', { control_id: controlId, ok, text, ...(code ? { code } : {}), at: iso() }),
      0,
    )
  }

  const self: FakeSession = {
    mode: () => mode,
    controls,
    state: () => state,
    inventory: () => inventory,
    agents: () => agents,
    setAgents(rows, over = {}) {
      if (rows === null) {
        agents = undefined
        return
      }
      agents = AgentsSnapshot.parse({
        session_id: SESSION_ID,
        source: 'mod+tee',
        can_stop: true,
        ...over,
        rows: rows.map((r) =>
          AgentRow.parse({ kind: 'subagent', type: 'Explore', title: r.id, status: 'running', ...r }),
        ),
        at: iso(),
      })
      pushAgents()
    },
    setMod(m) {
      mode = m
      if (m === 'live') {
        state = { ...(state ?? liveState()), capabilities: [...CAPS], source: 'mod', at: iso() }
        inventory ??= fakeInventory(iso())
        push()
        if (inventory) deps.emit('session.inventory', { inventory })
        self.startHeartbeat()
      } else if (m === 'offline') {
        if (beat) clearInterval(beat)
        beat = undefined
        state = { ...(state ?? liveState()), capabilities: [], at: iso() }
        push()
        if (agents) {
          agents = markAgentsUnknown(agents, iso())
          pushAgents()
        }
      } else if (beat) {
        clearInterval(beat)
        beat = undefined
      }
    },
    patch: setState,
    pushStale(ageMs) {
      if (beat) clearInterval(beat)
      beat = undefined
      state = { ...(state ?? liveState()), at: iso(deps.now() - ageMs) }
      push()
    },
    setInventory(inv) {
      inventory = inv
      deps.emit('session.inventory', { inventory: inv })
    },
    failNext(code, text) {
      fail = { code, text }
    },
    mute(on) {
      muted = on
    },
    readyFields() {
      return {
        ...(state ? { session_state: state } : {}),
        ...(inventory ? { session_inventory: inventory } : {}),
        ...(agents ? { session_agents: agents } : {}),
      }
    },
    startHeartbeat() {
      if (beat || mode !== 'live') return
      beat = setInterval(() => {
        if (mode === 'live' && state) setState({})
      }, 10_000)
      ;(beat as { unref?: () => void }).unref?.()
    },
    dispose() {
      if (beat) clearInterval(beat)
      beat = undefined
    },
    handle(frame) {
      controls.push(frame)
      const id = String(frame.control_id)
      if (fail) {
        const f = fail
        fail = null
        result(id, false, f.text, f.code)
        return
      }
      // The bridge checks against its own, unstripped copy of the mod's state (agents, agent_stop) and its last snapshot.
      const bridgeState =
        state && agents
          ? {
              ...state,
              capabilities: [
                ...state.capabilities,
                'agents' as const,
                ...(agents.can_stop ? ['agent_stop' as const] : []),
              ],
            }
          : state
      const check = checkSessionControl(
        {
          action: frame.action as 'stop' | 'compact' | 'command' | 'clear' | 'agent_stop',
          ts: String(frame.ts),
          ...(typeof frame.turn_id === 'string' ? { turn_id: frame.turn_id } : {}),
          ...(typeof frame.agent_id === 'string' ? { agent_id: frame.agent_id } : {}),
          ...(typeof frame.command === 'string' ? { command: frame.command } : {}),
          ...(typeof frame.source === 'string' ? { source: frame.source } : {}),
          ...(typeof frame.args === 'string' ? { args: frame.args } : {}),
        },
        {
          now: deps.now(),
          state: mode === 'live' ? bridgeState : undefined,
          inventory,
          allowedModels: deps.allowedModels(),
          agents,
        },
      )
      if (!check.ok) {
        result(id, false, check.message, check.code)
        return
      }
      const args = typeof frame.args === 'string' ? frame.args : ''
      switch (frame.action) {
        case 'agent_stop': {
          // TaskStop at the Mac: the row ends as `killed` and the next snapshot says so.
          if (agents) {
            const at = iso()
            agents = {
              ...agents,
              rows: agents.rows.map((r) =>
                r.id === frame.agent_id ? { ...r, status: 'killed', ended_at: at, stoppable: false } : r,
              ),
              at,
            }
            pushAgents()
          }
          result(id, true, 'Stopped.')
          return
        }
        case 'stop':
          setState({ busy: false, turn_id: undefined as never })
          result(id, true, 'Stopped.')
          return
        case 'compact':
          if (state?.busy) {
            result(id, true, 'Compacts after this turn.')
            return
          }
          setState({ compacting: true })
          setTimeout(
            () => setState({ compacting: false, context: { tokens: 90_000, window: 1_000_000, percent: 9 } }),
            400,
          )
          result(id, true, 'Compacted. Context is down to 9%.')
          return
        case 'clear':
          setState({ context: { tokens: 0, window: 1_000_000, percent: 0 } })
          result(id, true, 'Started a new conversation.')
          return
        case 'command': {
          if (frame.command === 'model') {
            if (args === 'haiku') {
              result(id, false, 'Waiting for confirmation at the Mac.', 'model_switch_pending')
              return
            }
            const m = MODELS[args] ?? MODELS.opus
            if (m) setState({ model: m })
            result(id, true, `Switched to ${m?.display ?? args}. Also the default for new sessions.`)
            return
          }
          if (frame.command === 'effort') {
            setState({ effort: args })
            result(id, true, `Effort is ${args}. Applies from the next message.`)
            return
          }
          result(id, true, `Ran /${String(frame.command)}.`)
          return
        }
      }
    },
  }
  return self
}
