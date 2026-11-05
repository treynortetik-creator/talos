// Signed schedule frames: the owner signature is checked here, then the scheduler service answers.
// Handlers of the Inbound class (inbound.ts), which forwards to them. Dispatch and the first trust checks are in inbound.ts;
// some handlers here run their own seen-id, age or card-state checks, so read both when auditing trust.
import { type Frame, ScheduleChange } from '@talos-app/protocol'
import { errorFrame } from './frames-out.ts'
import type { Inbound } from './inbound.ts'
import type { Item } from './inbound-shared.ts'

export const scheduleFrames = {
  /**
   * The five signed schedule frames are not durable and not consumable: no ack stage, no batching, no replay. The owner
   * signature is checked here on the RAW JSON, then the scheduler service answers with ack{ref} or error{ref}. A repeated
   * frame id is refused, but only after the signature: a forged frame gets the same answer whatever ids the Mac has seen.
   */
  onScheduleFrame(this: Inbound, it: Item) {
    const { ctx } = this
    const id = it.frame.id
    if (this.inflight.has(id)) return
    this.inflight.add(id)
    this.schedQueue = this.schedQueue
      .then(async () => {
        const owner = await this.verifyOwner(it)
        if (!owner.ok) {
          this.inflight.delete(id)
          return this.ownerFailed(it, owner)
        }
        this.inflight.delete(id)
        if (this.refuseReplay(id, 'schedule frame')) return
        ctx.store.markSeen(id, ctx.clock.now(), 'ok')
        if (!ctx.schedules) {
          ctx.transport.sendEphemeral(
            errorFrame(ctx.clock.now(), 'scheduler_unavailable', 'Schedules are not available.', id),
          )
          return
        }
        void ctx.schedules.handleOwnerFrame(it.frame)
      })
      .catch((e) => {
        this.inflight.delete(id)
        ctx.log.error('schedule frame handling failed', { type: it.frame.type, id, error: (e as Error).message })
      })
  },

  /**
   * An owner schedule frame that did not parse. If its signature holds, the owner (or their app) sent something invalid
   * and the form gets `schedule_invalid` with field paths; if it does not, it is a signature failure like any other.
   */
  onBadScheduleFrame(this: Inbound, raw: Record<string, unknown>, id: string, type: string, message: string) {
    const { ctx } = this
    this.inflight.add(id)
    this.schedQueue = this.schedQueue
      .then(async () => {
        const it = { raw, frame: { type, id, ts: raw.ts } as unknown as Frame, receivedAt: ctx.clock.now() } as Item
        const owner = await this.verifyOwner(it)
        if (!owner.ok) {
          this.inflight.delete(id)
          return this.ownerFailed(it, owner)
        }
        let fields: Array<{ path: string; message: string }> = []
        if (type === 'schedule.patch') {
          const p = ScheduleChange.safeParse(raw.change)
          if (!p.success)
            fields = p.error.issues
              .slice(0, 20)
              .map((i) => ({ path: i.path.join('.') || 'change', message: i.message }))
        }
        if (!fields.length) fields = [{ path: '', message }]
        this.reject(
          it,
          type === 'schedule.patch' ? 'schedule_invalid' : 'bad_frame',
          'That request is not valid.',
          [],
          fields,
        )
      })
      .catch((e) => {
        this.inflight.delete(id)
        ctx.log.error('bad schedule frame handling failed', { type, id, error: (e as Error).message })
      })
  },
}
