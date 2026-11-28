// The terminal view's frames from the relay (docs/PROTOCOL.md, "The terminal stream"). A signed open, resume or close is checked
// like every owner frame: the signature over the RAW JSON, a pinned and unrevoked device, and `ts` within two minutes (the
// phone's clock skew allowed). The id is then marked seen in the persistent store, so the same bytes never open a view twice, not
// even after a restart. The credit and a viewer-gone are unsigned: they can only slow or end a view, never open or feed one.
// Handlers of the Inbound class (inbound.ts).
import { newUlid, TERM_OPEN_MAX_AGE_MS } from '@talos-app/protocol'
import type { Inbound } from './inbound.ts'
import type { Item, Of } from './inbound-shared.ts'

type Signed = Of<'term.open'> | Of<'term.resume'> | Of<'term.close'>

export const termFrames = {
  onTermFrame(this: Inbound, it: Item) {
    const { ctx } = this
    const f = it.frame as Signed
    const id = f.id
    if (this.inflight.has(id)) return
    this.inflight.add(id)
    this.termQueue = this.termQueue
      .then(async () => {
        const owner = await this.verifyOwner(it, TERM_OPEN_MAX_AGE_MS)
        this.inflight.delete(id)
        if (!owner.ok) return this.ownerFailed(it, owner)
        // after the signature, so only a valid one learns whether an id was used; a failed one is never remembered
        if (this.refuseReplay(id, 'terminal frame')) return
        ctx.store.markSeen(id, ctx.clock.now(), 'ok')
        const term = ctx.term
        if (!term) {
          if (f.type === 'term.open')
            ctx.transport.sendEphemeral({
              v: 1,
              id: newUlid(),
              ts: new Date(ctx.clock.now()).toISOString(),
              type: 'term.closed',
              term_id: f.term_id,
              why: 'unsupported',
            })
          return
        }
        if (f.type === 'term.open') await term.open(f, owner.deviceId)
        else if (f.type === 'term.resume') term.resume(f.term_id, f.from, owner.deviceId)
        else term.close(f.term_id, owner.deviceId)
      })
      .catch((e) => {
        this.inflight.delete(id)
        ctx.log.error('terminal frame handling failed', { type: f.type, id, error: (e as Error).message })
      })
  },
}
