// Events the mod queues for the next sync, and the C3.4 prompt tracker. Nothing here talks to the bridge: the link
// drains the queue every 2 s. Events are small facts (a turn started, a prompt opened), never message text.
import type { ModFlags } from './state.ts'

export const MAX_QUEUED_EVENTS = 200

/**
 * The engine's clock is async (`$.clock.now()` is a promise) but events are stamped inside synchronous hooks. The link
 * refreshes this at the start of every tick and each hook reads the last value; before the first tick it is wall time.
 */
export class TimeSource {
  private value = Date.now()
  set(ms: number): void {
    if (Number.isFinite(ms)) this.value = ms
  }
  now = (): number => this.value
}

export type QueuedEvent = { type: string; at: string; [k: string]: unknown }

export class EventQueue {
  private q: QueuedEvent[] = []
  constructor(private readonly now: () => number) {}

  push(type: string, fields: Record<string, unknown> = {}): void {
    this.q.push({ type, ...fields, at: new Date(this.now()).toISOString() })
    if (this.q.length > MAX_QUEUED_EVENTS) this.q.splice(0, this.q.length - MAX_QUEUED_EVENTS)
  }
  drain(): QueuedEvent[] {
    return this.q.splice(0)
  }
  /** A failed sync puts its events back in front, in order, so none are lost to a bridge restart. */
  requeue(events: QueuedEvent[]): void {
    this.q = [...events, ...this.q].slice(-MAX_QUEUED_EVENTS)
  }
  get size(): number {
    return this.q.length
  }
}

/** What the hooks change and the state builder reads. */
export class SessionFlags implements ModFlags {
  busy = false
  turnId: string | undefined = undefined
  compacting = false
  stoppedAtMac = false
  /** WP-C3 sets this to the turn it is about to abort, so a phone Stop is not reported as "stopped at the Mac". */
  modAbortTurnId: string | undefined = undefined

  constructor(private readonly events: EventQueue) {}

  turnStart(turnId: string): void {
    this.busy = true
    this.turnId = turnId
    this.stoppedAtMac = false
    this.events.push('turn_start', { turn_id: turnId.slice(0, 64) })
  }

  turnComplete(turnId: string | undefined, aborted: boolean): void {
    this.busy = false
    const id = (turnId ?? this.turnId ?? '').slice(0, 64)
    this.turnId = undefined
    if (id) this.events.push('turn_complete', { turn_id: id, aborted })
    // "refused until the user's next input" (mods api): an abort the mod did not start is the user's Esc
    if (aborted && (turnId === undefined || turnId !== this.modAbortTurnId)) {
      this.stoppedAtMac = true
      this.events.push('stopped_at_mac')
    }
    if (turnId === this.modAbortTurnId) this.modAbortTurnId = undefined
  }

  setCompacting(on: boolean): void {
    if (this.compacting === on) return
    this.compacting = on
    this.events.push('compacting', { on })
  }

  /** A refusal from the engine whose reason says nobody has sent input since the stop. */
  noteRefusal(reason: unknown): void {
    if (typeof reason === 'string' && reason.includes(STOPPED_AT_MAC_REASON) && !this.stoppedAtMac) {
      this.stoppedAtMac = true
      this.events.push('stopped_at_mac')
    }
  }
}

/** The engine's refusal after the user interrupted at the Mac (mods api); same string as the protocol's. */
export const STOPPED_AT_MAC_REASON = 'the session was stopped and nobody has sent input since'

/**
 * C3.4: `prompt_open` when `tool.check` says ask; `prompt_closed` when the call it belonged to finishes or is denied.
 * The bridge supersedes a card only on an exact (tool_name, input_hash) match with exactly one candidate, and in auto mode
 * a `tool.check` ask can be settled by the classifier without a dialog, so an open alone never changes a card.
 */
export class PromptTracker {
  private open = new Map<string, { tool_name: string; input_hash: string }>()
  constructor(private readonly events: EventQueue) {}

  opened(toolUseId: string | undefined, toolName: string, hash: string): void {
    if (!toolUseId) return // a `$.tool.check` query, not a real call: no prompt can open
    if (this.open.has(toolUseId) || this.open.size >= 100) return
    this.open.set(toolUseId, { tool_name: toolName.slice(0, 200), input_hash: hash })
    this.events.push('prompt_open', {
      tool_name: toolName.slice(0, 200),
      input_hash: hash,
      tool_use_id: toolUseId.slice(0, 80),
    })
  }

  closed(toolUseId: string | undefined): void {
    if (!toolUseId) return
    const p = this.open.get(toolUseId)
    if (!p) return
    this.open.delete(toolUseId)
    this.events.push('prompt_closed', { ...p, tool_use_id: toolUseId.slice(0, 80) })
  }

  /** The turn ended: nothing it asked can still be open. */
  closeAll(): void {
    for (const id of [...this.open.keys()]) this.closed(id)
  }

  get size(): number {
    return this.open.size
  }
}
