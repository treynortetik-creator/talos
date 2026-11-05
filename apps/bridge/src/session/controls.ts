// Session controls (docs/CLAUDE-CODE.md C2.5, C4.1, C4.2, C4.4). A signed `session.control` from the app arrives here
// AFTER Inbound has checked the owner signature and the frame id. This class is the boundary the mod's threat model
// names: it applies checkSessionControl() against the bridge-held state and inventory BEFORE anything is queued for the
// mod, so nothing the mod reports can allow what the policy would refuse. Results are recorded (history.sqlite kv) before
// the frame is consumed, so a relay replay after a restart re-sends the stored result and never runs a control twice. A history
// kept aside takes those results with it, so `signedBeforeReset` refuses a control the owner signed before the reset.
import {
  checkSessionControl,
  ErrorCode,
  type ErrorCodeT,
  effectiveModelList,
  type Frame,
  MODEL_SWITCH_TIMEOUT_MS,
  type ModControlResultT,
  type ModControlT,
} from '@talos-app/protocol'
import type { BridgeContext } from '../context.ts'
import { sessionControlResultFrame } from '../frames-out.ts'
import { RESET_REFUSAL, signedBeforeReset } from '../history-recover.ts'

type Of<T extends Frame['type']> = Extract<Frame, { type: T }>

/**
 * The backstop for a mod that never answers. Compact waits on a summary model call and a clear sent mid-turn is queued
 * until the session is idle, so both may take minutes: a short backstop would drop the real result and invite a second tap
 * (review R3). Everything else answers inside the mod's own 15 s race.
 */
export const CONTROL_NO_ANSWER_MS = 300_000
export const QUICK_NO_ANSWER_MS = 45_000
const SLOW_ACTIONS = new Set(['compact', 'clear'])
const KEEP_RESULTS = 200
const INDEX_KEY = 'ctl:index'

type Pending = { timer: unknown; finish: () => void }

export class SessionControls {
  private readonly pending = new Map<string, Pending>()

  constructor(private readonly ctx: BridgeContext) {}

  /** Stops every backstop timer (Bridge.stop). A pending control stays unconsumed, so the relay replays it. */
  close(): void {
    for (const p of this.pending.values()) this.ctx.clock.clearTimeout(p.timer)
    this.pending.clear()
  }

  /**
   * `finish` consumes the frame; it runs once the result is recorded (at once for a refusal, later for a control the
   * mod runs). The caller must not mark the frame seen itself.
   */
  onControl(f: Of<'session.control'>, finish: () => void): void {
    const { ctx } = this
    const stored = this.stored(f.control_id)
    if (stored) {
      this.send(stored)
      finish()
      return
    }
    // the history was reset after the owner signed this: whether it already ran is unknown, so it does not run
    if (signedBeforeReset(ctx.store, f.ts)) {
      this.record(f.control_id, RESET_REFUSAL)
      finish()
      return
    }
    // R5: dispatched before a restart and no result recorded. The mod may have run it: never hand it over again.
    if (!this.pending.has(f.control_id) && ctx.store.kvGet(`ctd:${f.control_id}`)) {
      this.record(f.control_id, {
        ok: false,
        code: 'internal',
        text: 'The bridge restarted while this ran, so the outcome is unknown. Check the session before trying again.',
      })
      finish()
      return
    }
    if (this.pending.has(f.control_id)) {
      finish() // a second frame for a control still running
      return
    }
    const inventory = ctx.mod.liveInventory()
    const modelValues = inventory?.models.map((m) => m.value)
    const verdict = checkSessionControl(
      {
        action: f.action,
        ts: f.ts,
        ...(f.turn_id !== undefined ? { turn_id: f.turn_id } : {}),
        ...(f.command !== undefined ? { command: f.command } : {}),
        ...(f.source !== undefined ? { source: f.source } : {}),
        ...(f.args !== undefined ? { args: f.args } : {}),
        ...(f.agent_id !== undefined ? { agent_id: f.agent_id } : {}),
      },
      {
        now: ctx.clock.now(),
        state: ctx.mod.liveState(),
        inventory,
        // docs/SUBAGENTS.md: `agent_stop` passes only for a live, stoppable row of this session's held snapshot
        ...(f.action === 'agent_stop' ? { agents: ctx.mod.liveAgents() } : {}),
        allowedModels: effectiveModelList(
          ctx.config.config.session_models,
          modelValues?.length ? modelValues : undefined,
        ),
      },
    )
    if (!verdict.ok) {
      ctx.log.info('session control refused', { action: f.action, code: verdict.code })
      this.record(f.control_id, { ok: false, code: verdict.code, text: verdict.message })
      finish()
      return
    }
    const control: ModControlT = {
      control_id: f.control_id,
      action: f.action,
      ...(f.turn_id !== undefined ? { turn_id: f.turn_id } : {}),
      ...(f.command !== undefined ? { command: f.command, source: 'builtin' as const } : {}),
      ...(f.args !== undefined ? { args: f.args } : {}),
      ...(f.agent_id !== undefined ? { agent_id: f.agent_id } : {}),
      ...(f.command === 'model'
        ? {
            // C4.4 step 2: pre-approves exactly this switch, once. The mod burns it on use and caps it at 15 s.
            model_ticket: {
              to_model: f.args ?? '',
              expires_at: new Date(ctx.clock.now() + MODEL_SWITCH_TIMEOUT_MS).toISOString(),
            },
          }
        : {}),
    }
    ctx.store.kvSet(`ctd:${f.control_id}`, '1') // dispatched (R5); cleared when a result is recorded
    if (!ctx.mod.enqueue(control)) {
      this.record(f.control_id, { ok: false, code: 'mac_offline', text: 'The Mac is busy. Try again in a moment.' })
      finish()
      return
    }
    const timer = ctx.clock.setTimeout(
      () => {
        if (!this.pending.delete(f.control_id)) return
        ctx.log.warn('session control: the mod did not answer', { action: f.action })
        this.record(f.control_id, { ok: false, code: 'mac_offline', text: 'The Mac did not answer.' })
        finish()
      },
      SLOW_ACTIONS.has(f.action) ? CONTROL_NO_ANSWER_MS : QUICK_NO_ANSWER_MS,
    )
    this.pending.set(f.control_id, { timer, finish })
  }

  /** A result the mod reported on a sync. Unknown or already-answered ids are dropped. */
  onModResult(r: ModControlResultT): void {
    const p = this.pending.get(r.control_id)
    if (!p) return
    this.pending.delete(r.control_id)
    this.ctx.clock.clearTimeout(p.timer)
    this.record(r.control_id, { ok: r.ok, ...(r.code ? { code: r.code } : {}), text: r.text })
    p.finish()
  }

  /** Records (and sends) a result decided elsewhere: Option C's thread.session.control (router/controls.ts). */
  recordResult(controlId: string, r: { ok: boolean; code?: ErrorCodeT; text: string }): void {
    if (this.stored(controlId)) this.resend(controlId)
    else this.record(controlId, r)
  }

  /** A result was already recorded for this control id. */
  hasResult(controlId: string): boolean {
    return this.stored(controlId) !== undefined
  }

  /** A replayed control whose first run already finished: its stored result goes out again. */
  resend(controlId: string): void {
    const stored = this.stored(controlId)
    if (stored) this.send(stored)
  }

  // ---- results -----------------------------------------------------------------------------------------------------

  private stored(controlId: string): Of<'session.control.result'> | undefined {
    const raw = this.ctx.store.kvGet(`ctl:${controlId}`)
    if (!raw) return undefined
    try {
      return JSON.parse(raw) as Of<'session.control.result'>
    } catch {
      return undefined
    }
  }

  private record(controlId: string, r: { ok: boolean; code?: ErrorCodeT | string; text: string }): void {
    const { ctx } = this
    const text = Array.from(r.text, (c) => (c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127 ? ' ' : c))
      .join('')
      .slice(0, 4000)
    const code = ErrorCode.safeParse(r.code)
    const frame = sessionControlResultFrame(ctx.clock.now(), {
      control_id: controlId,
      ok: r.ok,
      ...(code.success ? { code: code.data } : {}),
      text,
    })
    ctx.store.kvSet(`ctl:${controlId}`, JSON.stringify(frame))
    ctx.store.kvDelete(`ctd:${controlId}`)
    this.remember(controlId)
    this.send(frame)
  }

  private send(frame: Of<'session.control.result'>): void {
    this.ctx.transport
      .sendDurable(frame)
      .catch((e) => this.ctx.log.warn('session control result not sent', { error: (e as Error).message }))
  }

  /** Keeps the newest KEEP_RESULTS results so the kv table cannot grow without bound. */
  private remember(controlId: string): void {
    const { store } = this.ctx
    let ids: string[] = []
    try {
      ids = JSON.parse(store.kvGet(INDEX_KEY) ?? '[]') as string[]
    } catch {
      ids = []
    }
    ids.push(controlId)
    while (ids.length > KEEP_RESULTS) {
      const old = ids.shift()
      if (old) store.kvDelete(`ctl:${old}`)
    }
    store.kvSet(INDEX_KEY, JSON.stringify(ids))
  }
}
