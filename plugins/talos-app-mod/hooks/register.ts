// The Talos mod, read side and guard (docs/CLAUDE-CODE.md C2.3, C3.4). Optional: without it Talos falls back to hooks
// and the status line, and the app greys out what needs the mod. Everything here is capability-checked with `typeof`;
// a Claude Code that is too old, or missing a method the link needs, makes the mod do nothing at all.
import type { Register } from 'claude-code'
import { AgentsCollector, AgentTracker, taskNotificationOf, teeFileOf } from './lib/agents.ts'
import { reportCapabilities } from './lib/capabilities.ts'
import { ControlRunner } from './lib/controls.ts'
import type { EngineLike } from './lib/engine.ts'
import { EventQueue, PromptTracker, SessionFlags, TimeSource } from './lib/events.ts'
import {
  GUARD_REASON,
  isModTool,
  MOD_BARE_TOOL_RE,
  MOD_TOOL_DESCRIPTION,
  MOD_TOOL_RE,
  shouldDenyModCall,
  shouldDenyModTool,
} from './lib/guard.ts'
import { inputHash } from './lib/hash.ts'
import { BridgeLink } from './lib/link.ts'

type WithToolUse = { tool_use_id?: string; agentId?: string }
type WithResult = { result?: { backgroundTaskId?: unknown; taskId?: unknown } }
/** The agent_stop probe gives up after this long (review R3): the link must never wait on it. */
const PROBE_DEADLINE_MS = 1500

export const register: Register = (on) => {
  let startedLink = false
  // WP-C3: set once the link starts; classic.PreModelSwitch below asks it about the mod's own in-flight /model.
  let runner: ControlRunner | undefined
  let teeClear: (sessionId: string) => Promise<void> = () => Promise.resolve()
  const time = new TimeSource()
  const events = new EventQueue(time.now)
  const flags = new SessionFlags(events)
  const prompts = new PromptTracker(events)
  // docs/SUBAGENTS.md: fed by the observe-only hooks below from the first moment; read by the link's tick.
  const tracker = new AgentTracker()
  let collector: AgentsCollector | undefined

  // ---- the link ------------------------------------------------------------------------------------------------
  // session.start runs again after a reload; the module's variables start over with it, so one link per module run.
  on('session.start', async ($, e, next) => {
    const result = await next(e)
    if (!startedLink) {
      startedLink = true
      // `$` is never bound or passed (the engine's static rule): the lib sees this adapter, each member a lambda spelled
      // `$.noun.method()` at its call site.
      const home = async () =>
        (await $.env.get('TALOS_APP_HOME')) || `${(await $.env.get('HOME')) ?? ''}/.config/talos/app`
      const engine: EngineLike = {
        plugin: { name: $.plugin.name },
        secret: {
          read: async () => (await $.fs.read(`${await home()}/mod.key`)).trim(),
        },
        clock: {
          now: () => $.clock.now(),
          every: (ms, fn) => $.clock.every(ms, fn),
          after: (ms, fn) => $.clock.after(ms, fn),
        },
        mcp: { call: (server, tool, args) => $.mcp.call(server, tool, args) },
        tool: { list: () => $.tool.list() },
        command: {
          list: () => $.command.list(),
          run: (input) => $.command.run(input),
        },
        turn: { abort: (input) => $.turn.abort(input) },
        config: { list: () => $.config.list() },
        session: {
          id: () => $.session.id(),
          model: () => $.session.model(),
          version: () => $.session.version(),
          usage: () => $.session.usage(),
          surfaces: () => $.session.surfaces(),
          compact: (input) => $.session.compact(input),
        },
        agent: { list: () => $.agent.list() },
        tee: {
          read: async (sessionId) => {
            const file = teeFileOf(sessionId)
            return file ? $.fs.read(`${await home()}/${file}`) : ''
          },
          clear: async (sessionId) => {
            const file = teeFileOf(sessionId)
            const path = file ? `${await home()}/${file}` : undefined
            if (path && (await $.fs.exists(path))) await $.fs.write(path, '')
          },
        },
        tasks: { stop: (taskId) => $.tool.call({ tool: 'TaskStop', task_id: taskId }) },
      }
      teeClear = (sessionId) => engine.tee?.clear(sessionId) ?? Promise.resolve()
      // Harmless calls only. turn.abort and command.run are probed with a call the engine must reject (a made-up turn id
      // / command name): a normal Error means the method exists, a TypeError "not a function" means it does not.
      // session.compact has NO safe probe (a real call compacts the conversation), so it is probed with a no-op and is
      // reported whenever the version check passed. SMOKE must confirm `$.session.compact` on a real Mac.
      const probes = {
        core: {
          'tool.list': () => $.tool.list(),
          'command.list': () => $.command.list(),
          'config.list': () => $.config.list(),
          'session.id': () => $.session.id(),
          'session.usage': () => $.session.usage(),
          'session.version': () => $.session.version(),
        },
        methods: {
          'command.list': () => $.command.list(),
          'tool.check': () => $.tool.check({ tool: 'Read', input: {} }),
          'agent.list': () => $.agent.list(),
          'turn.abort': () => $.turn.abort({ turnId: '__talos_probe__' }),
          'command.run': () => $.command.run({ command: '__talos_probe__' }),
          'session.compact': () => Promise.resolve(),
          // agent_stop needs `$.tool.call` to reach TaskStop. Probed by LISTING, never by calling it: a real call at session
          // start could wait on a prompt (and hold the whole link) or show a row (review R3). The list read has its own
          // short deadline; a tool the list does not name, or no answer in time, is no agent_stop (SMOKE S-A6).
          'tool.call': async () => {
            const listed = await Promise.race([
              $.tool.list(),
              new Promise<undefined>((resolve) => $.clock.after(PROBE_DEADLINE_MS, () => resolve(undefined))),
            ])
            if (!Array.isArray(listed) || !listed.some((t) => t?.name === 'TaskStop'))
              throw new TypeError('TaskStop is not a function in this session')
          },
        },
      }
      // Never held on: a slow or absent bridge must not slow the session down.
      void (async () => {
        try {
          const report = await reportCapabilities(probes)
          if (!report.ok) {
            $.ui.log(
              `${engine.plugin.name}: idle (${report.reason}${report.missing ? `: ${report.missing.join(', ')}` : ''})`,
              {
                to: 'debug',
              },
            )
            return
          }
          let link: BridgeLink | undefined
          const caps = new Set(report.capabilities)
          collector = caps.has('agents') ? new AgentsCollector(engine, tracker, caps.has('agent_stop')) : undefined
          const run = new ControlRunner(engine, flags, events, new Set(report.capabilities), (r) =>
            link?.reportResult(r),
          )
          runner = run
          link = new BridgeLink(
            engine,
            flags,
            events,
            { capabilities: report.capabilities, version: report.version },
            time,
            (controls) => run.handle(controls),
            () => run.onTick(),
            collector,
          )
          link.start()
        } catch {
          // fail closed: no link, no report
        }
      })()
    }
    return result
  })

  // ---- turn facts ----------------------------------------------------------------------------------------------
  on('turn.start', (_$, e, next) => {
    if (e.agentId === undefined) flags.turnStart(e.turnId)
    return next(e)
  })
  // ---- the agents collector (docs/SUBAGENTS.md 5.1): observe only --------------------------------------------------
  // Each hook passes the call on unchanged and catches its own bookkeeping, so it can never change a verdict, a result
  // or a chunk. Nothing here talks to the bridge: the link's tick reads the tracker.
  on('agent.spawn', async (_$, e, next) => {
    const r = await next(e)
    try {
      const got = r as { agentId?: unknown; model?: unknown }
      tracker.spawned(got.agentId, time.now(), {
        model: got.model,
        description: e.description,
        type: e.subagentType,
        background: e.background,
      })
    } catch {
      // bookkeeping only
    }
    return r
  })
  // One unmatched tool.call hook (the engine allows one per event): the C3.4 closer (prompt_closed once the call ends)
  // and the agents collector (a subagent's activity line; a background shell's or monitor's task id).
  on('tool.call', async (_$, e, next) => {
    const agentId = (e as WithToolUse).agentId
    try {
      if (agentId !== undefined && !isModTool(e.tool)) tracker.toolCall(agentId, e.tool, e, time.now())
    } catch {
      // bookkeeping only
    }
    let r: Awaited<ReturnType<typeof next>>
    try {
      r = await next(e)
    } finally {
      prompts.closed((e as WithToolUse).tool_use_id)
    }
    if (e.tool !== 'Bash' && e.tool !== 'Monitor') return r
    try {
      // a background Bash (run_in_background, or moved there at the Mac) answers its task id; a Monitor always does
      const res = (r as WithResult).result
      const i = e as { description?: unknown; command?: unknown }
      const title = typeof i.description === 'string' ? i.description : String(i.command ?? '').slice(0, 80)
      if (e.tool === 'Bash') tracker.shellStarted(res?.backgroundTaskId, 'shell', title, time.now(), agentId)
      else tracker.shellStarted(res?.taskId, 'monitor', title, time.now(), agentId)
    } catch {
      // bookkeeping only
    }
    return r
  })
  on('turn.step', async function* (_$, e, next) {
    const r = yield* next(e)
    try {
      if (e.agentId !== undefined) tracker.stepUsage(e.agentId, r?.usage, time.now())
    } catch {
      // bookkeeping only
    }
    return r
  })
  on('session.append', (_$, e, next) => {
    try {
      const n = taskNotificationOf(e)
      if (n) tracker.taskEnded(n.id, n.status, time.now())
    } catch {
      // bookkeeping only
    }
    return next(e)
  })
  on('classic.Stop', (_$, e, next) => {
    try {
      tracker.backgroundSnapshot((e as { background_tasks?: unknown }).background_tasks, time.now())
    } catch {
      // bookkeeping only
    }
    return next(e)
  })
  on('session.end', async (_$, e, next) => {
    try {
      if (collector) collector.sessionEnded(e.sessionId)
      else tracker.reset()
      await teeClear(e.sessionId)
    } catch {
      // bookkeeping only
    }
    return next(e)
  })

  on('turn.complete', (_$, e, next) => {
    if (e.agentId === undefined) {
      flags.turnComplete(e.turnId, e.isAborted === true)
      prompts.closeAll()
    }
    return next(e)
  })
  on('session.compact', async (_$, e, next) => {
    if (e.agentId !== undefined) return next(e)
    flags.setCompacting(true)
    try {
      return await next(e)
    } finally {
      flags.setCompacting(false)
    }
  })
  on('session.attach', ($, e, next) => {
    void $.session.surfaces().then((s) => events.push('surfaces', { surfaces: s.slice(0, 8) }))
    return next(e)
  })
  on('session.detach', ($, e, next) => {
    void $.session.surfaces().then((s) => events.push('surfaces', { surfaces: s.slice(0, 8) }))
    return next(e)
  })
  on('classic.PostModelSwitch', (_$, e, next) => {
    if (typeof e.to_model === 'string' && e.to_model.length > 0) {
      events.push('model_switched', { model: e.to_model.slice(0, 80) })
      runner?.noteModelSwitched(e.to_model) // R2: the mod's own /model only reports "Switched" when this arrived
    }
    return next(e)
  })

  // The bridge's one-shot `/model` ticket (WP-C3, C4.4). Ask the rest first so the user's own hooks (a deny, an ask) and
  // the engine's own behaviour decide as always; only when nothing beneath has an opinion does the ticket upgrade the
  // answer to `allow`, and only for the switch the mod itself is running. The d.ts gives the result as the flat classic
  // field `permissionDecision` (ClassicResultFields.PreModelSwitch), not a nested hookSpecificOutput.
  on('classic.PreModelSwitch', async (_$, e, next) => {
    const r = await next(e)
    if (r.permissionDecision !== undefined || !runner) return r
    try {
      return (await runner.allowsSwitch(e)) ? { ...r, permissionDecision: 'allow' as const } : r
    } catch {
      return r
    }
  })

  // ---- the guard (C2.3): only the mod itself may call talos_mod_* ------------------------------------------------
  // Three hooks, all fail closed (an engine guard that throws is skipped, so each is wrapped in .catch). `tool.check` and
  // `tool.call` deny the model and subagents. `$.mcp.call`, which is how another plugin would reach the bridge, raises
  // neither of those, so it has its own gate: only this plugin's own call goes through. When this mod is not loaded the
  // bridge refuses these tools by itself (it needs the key file's contents).
  on('tool.check', { tool: MOD_TOOL_RE }, (_$, e, next) =>
    shouldDenyModTool(e.tool) ? { decision: 'deny' as const, reason: GUARD_REASON } : next(e),
  ).catch(() => ({ decision: 'deny' as const, reason: GUARD_REASON }))

  on('tool.call', { tool: MOD_TOOL_RE }, (_$, e, next) =>
    shouldDenyModTool(e.tool) ? { deny: GUARD_REASON } : next(e),
  ).catch(() => ({ deny: GUARD_REASON }))

  // The engine skips a plugin's own hooks for its own calls, so this gate only ever sees OTHER plugins' calls. It denies
  // them; the origin test is belt and braces.
  on('mcp.call', { tool: MOD_BARE_TOOL_RE }, ($, e, next) =>
    shouldDenyModCall(e.tool, next.origin?.plugin, $.plugin.name) ? { deny: GUARD_REASON } : next(e),
  ).catch(() => ({ deny: GUARD_REASON }))

  // Both bridge tools sit behind ToolSearch, described as internal, so the model is never shown them.
  on('tool.describe', { tool: MOD_TOOL_RE }, async (_$, e, next) => {
    const r = await next(e)
    return { ...r, description: MOD_TOOL_DESCRIPTION, isDeferred: true as const }
  })

  // ---- the C3.4 closer -----------------------------------------------------------------------------------------
  on('tool.check', async (_$, e, next) => {
    const verdict = await next(e)
    try {
      if (verdict.decision === 'ask' && !isModTool(e.tool)) {
        const hash = await inputHash(e.input)
        if (hash) prompts.opened(e.tool_use_id, e.tool, hash)
      }
    } catch {
      // reporting must never change a verdict
    }
    return verdict
  })
  on('classic.PermissionDenied', (_$, e, next) => {
    prompts.closed((e as { tool_use_id?: string }).tool_use_id)
    return next(e)
  })
}
