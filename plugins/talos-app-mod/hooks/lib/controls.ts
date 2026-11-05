// WP-C3: runs the controls the bridge hands the mod in `talos_mod_sync` responses (docs/CLAUDE-CODE.md C2.3, C4.1, C4.2,
// C4.4). Pure: it sees only the EngineLike adapter, so it is testable without the engine.
//
// Rules that shape it:
//  - Never inside an event hook. `$.command.run` rejects inside a hook the turn waits on, so everything here is started
//    from the link's tick (handle) and never from a hook. The one hook (classic.PreModelSwitch) only answers a question.
//  - Executions are DETACHED: a `/model` waiting on a confirmation at the Mac must not block the 2 s sync. `handle()`
//    returns the refusals it knows at once and the rest arrive through `report`, exactly once per control_id.
//  - Fail closed: an unknown action, a malformed control, a command off the allowlist, a shadowed name, a capability the
//    mod did not report each get a result. Nothing is ever built into a shell string; `$.command.run` takes name + args.
import type { Capability } from './capabilities.ts'
import type { EngineLike } from './engine.ts'
import type { EventQueue, SessionFlags } from './events.ts'
import { STOPPED_AT_MAC_REASON } from './events.ts'
import type { Control, ControlResult } from './link.ts'
import { configFacts } from './state.ts'

/** protocol MODEL_SWITCH_TIMEOUT_MS (import-free copy). */
export const SWITCH_TIMEOUT_MS = 15_000
/** protocol STOPPED_AT_MAC_TEXT (import-free copy). */
const STOPPED_AT_MAC_TEXT = 'Stopped at the Mac. Send a message to continue.'
const MAX_TEXT = 4000
const MAX_REASON = 300

type Grammar = 'none' | 'on_off' | 'model' | 'effort' | 'instructions'
/**
 * Import-free copy of protocol BUILTIN_CONTROL_COMMANDS (packages/protocol/src/session.ts); keep the two in step. The mod
 * has no workspace imports (it ships as a plugin folder), so a drift is caught only by review: a name missing here
 * fails closed (refused), never open.
 */
const BUILTIN_CONTROL_COMMANDS: Readonly<Record<string, Grammar>> = Object.freeze({
  context: 'none',
  usage: 'none',
  recap: 'none',
  mcp: 'none',
  'reload-plugins': 'none',
  model: 'model',
  effort: 'effort',
  fast: 'on_off',
  compact: 'instructions',
  clear: 'none',
})
/** These are their own control actions; as a `command` they are refused. */
const OWN_ACTION_COMMANDS = new Set(['compact', 'clear'])
/** protocol DOCUMENTED_EFFORTS (+ 'auto'). */
const EFFORTS = new Set(['low', 'medium', 'high', 'xhigh', 'max', 'auto'])
const ALIAS = /^(default|best|fable|opus|sonnet|haiku)(\[1m\])?$/

type Ctl = {
  id: string
  action: string
  turnId?: string
  command?: string
  args?: string
  ticket?: { to_model: string; expires_at: string }
  /** `agent_stop`: the task id handed to `TaskStop`. */
  agentId?: string
}
type Ticket = { toModel: string; exp: number; controlId: string; inFlight: boolean }

const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined)
/** A `TaskStop` target: one printable line of at most 80 characters (the protocol's AgentId rule). */
// biome-ignore lint/suspicious/noControlCharactersInRegex: a task id is one printable line
const isTaskId = (v: string) => v.length > 0 && v.length <= 80 && !/[\u0000-\u001f\u007f-\u009f]/.test(v)

/** Plain text for the phone: no escape codes or control characters, one line of spaces, bounded. */
export function plain(v: unknown, max = MAX_TEXT): string {
  const s = typeof v === 'string' ? v : ''
  let out = ''
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i)
    if (c === 0x1b) {
      // a terminal escape sequence: ESC [ params letter
      if (s[i + 1] === '[') {
        i += 2
        while (i < s.length && /[0-9;?]/.test(s[i] ?? '')) i++
      }
      continue
    }
    if ((c < 0x20 && c !== 0x0a && c !== 0x09) || c === 0x7f) continue
    out += s[i]
  }
  return out.trim().slice(0, max)
}
const reasonOf = (e: unknown): string =>
  plain(e instanceof Error ? e.message : typeof e === 'string' ? e : '', MAX_REASON)

/** The ticket's model against the model the switch resolved to: equal, or an alias whose word the id contains. */
export function ticketMatches(ticketModel: string, toModel: string): boolean {
  if (ticketModel === toModel) return true
  const m = ALIAS.exec(ticketModel)
  if (!m?.[1]) return false
  // 'default' matches anything; 'best' is matched like any other word (a resolved id rarely contains it, so it fails
  // closed into the engine's normal prompt). SMOKE: confirm what `to_model` holds for each alias on a real Mac.
  return m[1] === 'default' || toModel.includes(m[1])
}

export class ControlRunner {
  private ticket: Ticket | undefined
  private deferredCompact: { instructions?: string } | undefined
  private readonly inFlight = new Set<string>()
  /** The model a PostModelSwitch named since the mod's own /model began (R2). */
  private switchedTo: string | undefined

  constructor(
    private readonly engine: EngineLike,
    private readonly flags: SessionFlags,
    private readonly events: EventQueue,
    private readonly caps: ReadonlySet<Capability>,
    /** Late results (the link's `reportResult`). */
    private readonly report: (r: ControlResult) => void,
  ) {}

  // ---- entry points --------------------------------------------------------------------------------------------

  /** Answers what it can at once; everything slow is started and reported later. Never throws. */
  async handle(controls: Control[]): Promise<ControlResult[]> {
    const now: ControlResult[] = []
    for (const raw of controls) {
      const id = str(raw?.control_id)
      if (!id) continue // nobody to answer
      if (this.inFlight.has(id)) continue // redelivered while still running: the result is coming
      try {
        const ctl = this.parse(raw, id)
        const refusal = 'ok' in ctl ? ctl : this.preflight(ctl)
        if (refusal) {
          now.push(refusal)
          continue
        }
        this.detach(id, () => this.execute(ctl as Ctl))
      } catch {
        now.push(fail(id, 'internal', 'The mod could not run that.'))
      }
    }
    return now
  }

  /** The link's 2 s tick: runs a compact that was waiting for the turn to end. Never inside an event hook. */
  async onTick(): Promise<void> {
    if (!this.deferredCompact || this.flags.busy || this.flags.compacting) return
    const { instructions } = this.deferredCompact
    this.deferredCompact = undefined
    // Its result was already sent ("Compacts after this turn."); a veto or failure now has no one to tell. The engine's
    // own `compacting` / stopped-at-Mac facts still reach the app through state and events.
    await this.compactNow(instructions).catch((e) => this.flags.noteRefusal(reasonOf(e)))
  }

  /** The register hook's PostModelSwitch: the engine confirms a switch happened. */
  noteModelSwitched(to: string): void {
    this.switchedTo = to
  }

  /**
   * classic.PreModelSwitch: true only for a live, unexpired, unspent ticket, while the mod's own `/model` for that
   * control is in flight, and the switch is the one the ticket names. Burns the ticket.
   */
  async allowsSwitch(e: { to_model?: unknown; source?: unknown; requested_model?: unknown }): Promise<boolean> {
    const t = this.ticket
    if (!t?.inFlight) return false
    const now = await this.engine.clock.now()
    if (this.ticket !== t) return false // spent or burned while we asked the clock
    if (now > t.exp) {
      this.ticket = undefined
      return false
    }
    if (e.source !== undefined && e.source !== 'command') return false // a picker or SDK switch is not ours
    // R7: the switch names what was asked (`requested_model`: an alias, a full id, or null for the default). Compare that
    // exactly; fall back to the resolved id only when the engine does not say.
    if (e.requested_model !== undefined) {
      const asked = e.requested_model === null ? 'default' : e.requested_model
      if (asked !== t.toModel) return false
    } else if (typeof e.to_model !== 'string' || !ticketMatches(t.toModel, e.to_model)) return false
    this.ticket = undefined
    return true
  }

  // ---- parsing and refusals that need no engine ----------------------------------------------------------------

  private parse(raw: Control, id: string): Ctl | ControlResult {
    const action = str(raw.action)
    if (!action) return fail(id, 'args_invalid', 'Not a valid control.')
    const c: Ctl = { id, action }
    const t = str(raw.turn_id)
    if (t !== undefined) c.turnId = t
    const cmd = str(raw.command)
    if (cmd !== undefined) c.command = cmd
    const a = str(raw.args)
    if (a !== undefined) c.args = a
    const ag = str(raw.agent_id)
    if (ag !== undefined) c.agentId = ag
    const tk = raw.model_ticket as { to_model?: unknown; expires_at?: unknown } | undefined
    if (tk && typeof tk.to_model === 'string' && typeof tk.expires_at === 'string')
      c.ticket = { to_model: tk.to_model, expires_at: tk.expires_at }
    if (raw.source !== undefined && raw.source !== 'builtin') return fail(id, 'args_invalid', 'Not a valid control.')
    return c
  }

  private preflight(c: Ctl): ControlResult | undefined {
    const need = (cap: Capability): ControlResult | undefined =>
      this.caps.has(cap) ? undefined : fail(c.id, 'capability_missing', 'This Claude Code cannot do that.')
    switch (c.action) {
      case 'stop':
        return need('stop') ?? (c.turnId ? undefined : fail(c.id, 'args_invalid', 'Not a valid control.'))
      case 'compact':
        return need('compact')
      case 'agent_stop':
        return (
          need('agent_stop') ??
          (c.agentId && isTaskId(c.agentId) && !c.args ? undefined : fail(c.id, 'args_invalid', 'Not a valid control.'))
        )
      case 'clear':
        return need('clear')
      case 'command': {
        const name = c.command
        if (!name) return fail(c.id, 'args_invalid', 'Not a valid control.')
        if (!Object.hasOwn(BUILTIN_CONTROL_COMMANDS, name) || OWN_ACTION_COMMANDS.has(name))
          return fail(c.id, 'command_not_allowed', 'Run this at the Mac.')
        const cap: Capability = name === 'model' ? 'model' : name === 'effort' ? 'effort' : 'command'
        const missing = need(cap)
        if (missing) return missing
        const grammar = BUILTIN_CONTROL_COMMANDS[name]
        if (grammar === 'none' && c.args) return fail(c.id, 'args_invalid', 'That command takes no arguments.')
        if (name === 'model' && (!c.args || !c.ticket || c.ticket.to_model !== c.args))
          return fail(c.id, 'args_invalid', 'No matching approval for this switch.')
        if (name === 'effort' && !(c.args && EFFORTS.has(c.args)))
          return fail(c.id, 'args_invalid', 'Pick an effort level.')
        return undefined
      }
      default:
        return fail(c.id, 'capability_missing', 'This Talos mod cannot do that.')
    }
  }

  // ---- execution -----------------------------------------------------------------------------------------------

  /** Runs `work` off the tick; whatever it does, exactly one result is reported. */
  private detach(id: string, work: () => Promise<ControlResult>): void {
    this.inFlight.add(id)
    void work()
      .catch((): ControlResult => fail(id, 'internal', 'The mod could not run that.'))
      .then((r) => {
        this.inFlight.delete(id)
        try {
          this.report(r)
        } catch {
          // reporting must never throw out of a detached task
        }
      })
  }

  /** A rejection becomes a result. A refusal naming the stop at the Mac is its own code, whatever was asked. */
  private refused(id: string, e: unknown, code: string, fallback: string): ControlResult {
    const reason = reasonOf(e)
    if (reason.includes(STOPPED_AT_MAC_REASON)) {
      this.flags.noteRefusal(reason)
      return fail(id, 'stopped_at_mac', STOPPED_AT_MAC_TEXT)
    }
    return fail(id, code, reason || fallback)
  }

  private async execute(c: Ctl): Promise<ControlResult> {
    switch (c.action) {
      case 'stop':
        return this.stop(c)
      case 'compact':
        return this.compact(c)
      case 'clear':
        return this.clear(c)
      case 'command':
        return this.command(c)
      case 'agent_stop':
        return this.agentStop(c)
      default:
        return fail(c.id, 'capability_missing', 'This Talos mod cannot do that.')
    }
  }

  private async stop(c: Ctl): Promise<ControlResult> {
    const turnId = c.turnId as string
    // Set BEFORE the abort: turn.complete(isAborted) is what flags "stopped at the Mac", and it must see this is ours.
    this.flags.modAbortTurnId = turnId
    try {
      await this.engine.turn.abort({ turnId })
      return ok(c.id, 'Stopped.')
    } catch (e) {
      if (this.flags.modAbortTurnId === turnId) this.flags.modAbortTurnId = undefined
      const reason = reasonOf(e)
      if (reason.includes(STOPPED_AT_MAC_REASON)) return this.refused(c.id, e, 'stopped_at_mac', '')
      return fail(c.id, 'turn_mismatch', 'That turn already ended. Nothing was stopped.')
    }
  }

  /**
   * docs/SUBAGENTS.md: `TaskStop` through `$.tool.call`, from the tick (never inside a hook). The bridge already checked
   * that the row is live and stoppable in the current session; a tool that refuses (the task ended meanwhile, or the id is
   * unknown) is `agent_not_found`; a success carries the tool's own text.
   */
  private async agentStop(c: Ctl): Promise<ControlResult> {
    const id = c.agentId as string
    const notFound = () => fail(c.id, 'agent_not_found', 'That agent already ended. Nothing was stopped.')
    if (!this.engine.tasks) return fail(c.id, 'capability_missing', 'This Claude Code cannot do that.')
    try {
      const r = await this.engine.tasks.stop(id)
      if (!r || typeof r.deny === 'string' || r.isError) return notFound()
      return ok(c.id, plain(r.text, MAX_REASON) || 'Stopped.')
    } catch {
      return notFound()
    }
  }

  private async compact(c: Ctl): Promise<ControlResult> {
    // Mid-turn `$.session.compact` rejects: remember it, answer now, run it from the tick once idle.
    if (this.flags.busy) {
      this.deferredCompact = c.args ? { instructions: c.args } : {}
      return ok(c.id, 'Compacts after this turn.')
    }
    try {
      const { skip } = await this.compactNow(c.args)
      return skip ? fail(c.id, 'internal', 'Another plugin stopped the compact.') : ok(c.id, 'Compacted.')
    } catch (e) {
      if (this.flags.busy && !reasonOf(e).includes(STOPPED_AT_MAC_REASON)) {
        this.deferredCompact = c.args ? { instructions: c.args } : {} // a turn began between the check and the call
        return ok(c.id, 'Compacts after this turn.')
      }
      return this.refused(c.id, e, 'internal', 'Could not compact.')
    }
  }

  private async compactNow(instructions: string | undefined): Promise<{ skip: boolean }> {
    // The mod's own hooks are skipped for its own call, so it sets `compacting` itself for the phone.
    this.flags.setCompacting(true)
    try {
      const r = await this.engine.session.compact(instructions ? { instructions } : {})
      return { skip: typeof r?.skip === 'string' ? r.skip.length > 0 : Boolean(r?.skip) }
    } finally {
      this.flags.setCompacting(false)
    }
  }

  /** R6: `clear` is a built-in name like any other; a skill or plugin using it must not be run by a phone tap. */
  private async clear(c: Ctl): Promise<ControlResult> {
    try {
      const listed = await this.engine.command.list()
      if ((Array.isArray(listed) ? listed : []).some((x) => x.name === 'clear' && x.source !== 'builtin'))
        return fail(c.id, 'command_not_allowed', 'A skill or plugin uses this name too. Run it at the Mac.')
    } catch {
      return fail(c.id, 'command_not_allowed', 'Run this at the Mac.')
    }
    return this.plainRun(c, 'clear', undefined)
  }

  private async currentModel(): Promise<string | undefined> {
    try {
      const m = await this.engine.session.model()
      return typeof m === 'string' && m.length > 0 ? m : undefined
    } catch {
      return undefined
    }
  }

  private async currentEffort(): Promise<string | undefined> {
    try {
      return configFacts(await this.engine.config.list()).effort
    } catch {
      return undefined
    }
  }

  private async plainRun(c: Ctl, command: string, args: string | undefined): Promise<ControlResult> {
    try {
      const r = await this.engine.command.run(args ? { command, args } : { command })
      return ok(c.id, plain(r?.text) || 'Done.')
    } catch (e) {
      return this.refused(c.id, e, 'command_not_allowed', 'That command was refused.')
    }
  }

  private async command(c: Ctl): Promise<ControlResult> {
    const name = c.command as string
    // `$.command.run` takes a name only, so which command runs is the engine's choice: re-read the list now and refuse a
    // name that is not a built-in, or that a skill, plugin or MCP prompt also uses (review R3).
    let listed: Awaited<ReturnType<EngineLike['command']['list']>>
    try {
      listed = await this.engine.command.list()
    } catch {
      return fail(c.id, 'command_not_allowed', 'Run this at the Mac.')
    }
    const rows = (Array.isArray(listed) ? listed : []).filter((x) => x.name === name)
    if (rows.length === 0 || rows.some((x) => x.source !== 'builtin'))
      return fail(c.id, 'command_not_allowed', 'A skill or plugin uses this name too. Run it at the Mac.')
    if (name === 'model') return this.model(c)
    if (name === 'effort') return this.effort(c)
    return this.plainRun(c, name, c.args)
  }

  // ---- /model (C4.4) -------------------------------------------------------------------------------------------

  private async model(c: Ctl): Promise<ControlResult> {
    const tk = c.ticket as { to_model: string; expires_at: string }
    const parsed = Date.parse(tk.expires_at)
    const now = await this.engine.clock.now()
    // Never longer than 15 s, whatever the bridge wrote.
    const exp = Math.min(Number.isFinite(parsed) ? parsed : Number.NEGATIVE_INFINITY, now + SWITCH_TIMEOUT_MS)
    if (exp <= now) return fail(c.id, 'args_invalid', 'That approval expired.')
    if (this.ticket) return fail(c.id, 'model_switch_pending', 'Another switch is still waiting.')
    const ticket: Ticket = { toModel: tk.to_model, exp, controlId: c.id, inFlight: false }
    this.ticket = ticket
    const burn = () => {
      if (this.ticket === ticket) this.ticket = undefined
    }
    ticket.inFlight = true // from here a PreModelSwitch for this model may be allowed, once
    this.switchedTo = undefined
    const before = await this.currentModel()
    return this.raced(() => this.engine.command.run({ command: 'model', args: tk.to_model }), {
      id: c.id,
      // R2: `/model` that is refused (a user hook's deny, a confirmation cancelled at the Mac) prints and RESOLVES. Success
      // is a PostModelSwitch, or the session's model now being different; otherwise the printed text is the reason.
      done: async (v) => {
        const after = this.switchedTo ?? (await this.currentModel())
        const changed =
          this.switchedTo !== undefined || (after !== undefined && before !== undefined && after !== before)
        const already =
          after !== undefined && after === before && tk.to_model !== 'default' && ticketMatches(tk.to_model, after)
        if (changed) return ok(c.id, 'Switched.')
        if (already) return ok(c.id, 'Already on that model.')
        return fail(
          c.id,
          'model_switch_denied',
          plain((v as { text?: string } | undefined)?.text, MAX_REASON) || 'The switch was refused.',
        )
      },
      rejected: (e) => {
        const r = this.refused(c.id, e, 'model_switch_denied', 'The switch was refused.')
        return r
      },
      pending: () => fail(c.id, 'model_switch_pending', 'Waiting for confirmation at the Mac.'),
      settle: burn,
    })
  }

  private async effort(c: Ctl): Promise<ControlResult> {
    const level = c.args as string
    return this.raced(() => this.engine.command.run({ command: 'effort', args: level }), {
      id: c.id,
      // R2: a refused `/effort` also resolves. Re-read the level; `auto` clears it, so it cannot be compared.
      done: async (v) => {
        const now = await this.currentEffort()
        if (level !== 'auto' && now !== undefined && now !== level)
          return fail(
            c.id,
            'command_not_allowed',
            plain((v as { text?: string } | undefined)?.text, MAX_REASON) || 'That level was refused.',
          )
        this.events.push('effort_changed', { effort: level.slice(0, 16) })
        return ok(c.id, 'Applies from the next message.')
      },
      rejected: (e) => this.refused(c.id, e, 'command_not_allowed', 'That command was refused.'),
      // effort_change_pending is the mod's to report (the bridge does not time it): no confirmed change in 15 s.
      pending: () => fail(c.id, 'effort_change_pending', 'Waiting for confirmation at the Mac.'),
      // A change confirmed after the pending result went out still happened: tell the app, but send no second result.
      late: async () => {
        const now = await this.currentEffort()
        if (level === 'auto' || now === undefined || now === level)
          this.events.push('effort_changed', { effort: level.slice(0, 16) })
      },
      settle: () => {},
    })
  }

  /**
   * Races the engine call against the 15 s timer. Exactly one result comes back; a completion after the timer won runs
   * `late` (events only) and sends nothing.
   */
  private raced(
    run: () => Promise<unknown>,
    h: {
      id: string
      done: (v: unknown) => Promise<ControlResult> | ControlResult
      rejected: (e: unknown) => ControlResult
      pending: () => ControlResult
      late?: (v: unknown) => Promise<void> | void
      settle: () => void
    },
  ): Promise<ControlResult> {
    return new Promise<ControlResult>((resolve) => {
      let finished = false
      const finish = (r: ControlResult) => {
        if (finished) return
        finished = true
        h.settle()
        resolve(r)
      }
      try {
        this.engine.clock.after(SWITCH_TIMEOUT_MS, () => finish(h.pending()))
      } catch {
        // no timer: the run's own outcome still ends this
      }
      run().then(
        async (v) => {
          try {
            if (finished) await h.late?.(v)
            else finish(await h.done(v))
          } catch {
            finish(fail(h.id, 'internal', 'The mod could not run that.'))
          }
        },
        (e) => finish(h.rejected(e)),
      )
    })
  }
}

const ok = (control_id: string, text: string): ControlResult => ({ control_id, ok: true, text: plain(text) })
const fail = (control_id: string, code: string, text: string): ControlResult => ({
  control_id,
  ok: false,
  code,
  text: plain(text) || 'Could not do that.',
})
