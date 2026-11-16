// A message's undo point as the app sees it ("Undo to here"): its state rides on the message's `delivered` receipt
// (protocol undo.ts), and on its history rows. Only to a relay that says undo/1: an older relay never sees the field.
// A point recorded after the receipt went (late, or a turn with no folder) is sent on a second `delivered` receipt
// then, so the app learns it without a new frame. A receipt never goes before the message was delivered.
import { UNDO_FEATURE, type UndoPointStateT } from '@talos-app/protocol'
import type { BridgeContext } from '../context.ts'
import { receiptFrame } from '../frames-out.ts'
import { UndoPoints } from './points.ts'

/** Delivered messages remembered, at most: an older one is not sent a late or changed mark (its history row has it). */
const WAITING_MAX = 500

export class UndoMarks {
  private relayFeatures: readonly string[] = []
  /** Messages whose `delivered` receipt went before their point was recorded. */
  private readonly waiting = new Set<string>()
  /** The mark each delivered message was last sent with: a point replaced since (another folder) is sent again. */
  private readonly sent = new Map<string, UndoPointStateT>()
  private points: UndoPoints | undefined

  constructor(private readonly ctx: BridgeContext) {}

  setRelayFeatures(features: readonly string[]): void {
    this.relayFeatures = features
  }

  /** The relay keeps and hands on a message's undo point. */
  on(): boolean {
    return this.relayFeatures.includes(UNDO_FEATURE)
  }

  /** The point of an owner message, for its row or its receipt; undefined when it has none, or the relay would not know it. */
  of(messageId: string): { state: UndoPointStateT } | undefined {
    if (!this.on()) return undefined
    this.points ??= new UndoPoints(this.ctx.store.db)
    const row = this.points.get(messageId)
    return row ? { state: row.state } : undefined
  }

  /** The message was delivered: its receipt's mark, or none yet (then it is sent once its point is recorded). */
  delivered(messageId: string): { state: UndoPointStateT } | undefined {
    if (!this.on()) return undefined
    const mark = this.of(messageId)
    if (mark) capped(this.sent, messageId, mark.state)
    else capped(this.waiting, messageId)
    return mark
  }

  /**
   * Points were recorded for these messages: one already delivered gets its mark (or its changed mark) on a second
   * `delivered` receipt. One not delivered yet gets it on its own receipt.
   */
  recorded(messageIds: readonly string[]): void {
    for (const id of messageIds) {
      const waited = this.waiting.delete(id)
      if (!waited && !this.sent.has(id)) continue
      const mark = this.of(id)
      if (!mark || this.sent.get(id) === mark.state) continue
      capped(this.sent, id, mark.state)
      this.ctx.transport.sendEphemeral(receiptFrame(this.ctx.clock.now(), id, 'delivered', mark))
    }
  }
}

/** Adds to a set or map that keeps only the newest WAITING_MAX entries. */
function capped(c: Set<string>, id: string): void
function capped(c: Map<string, UndoPointStateT>, id: string, state: UndoPointStateT): void
function capped(c: Set<string> | Map<string, UndoPointStateT>, id: string, state?: UndoPointStateT): void {
  c.delete(id)
  if (c instanceof Set) c.add(id)
  else c.set(id, state as UndoPointStateT)
  if (c.size > WAITING_MAX) c.delete(c.keys().next().value as string)
}
