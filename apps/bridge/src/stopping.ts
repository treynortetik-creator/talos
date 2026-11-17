// A bridge that has started to stop hands nothing over any more. Bridge.stop() sets `ctx.closing` before it awaits anything;
// from then on a delivery point (the agent's channel, a thread's route row, a restore wait that ends) throws BridgeStopping
// instead, and the frame behind it is neither marked seen nor acked, so the relay keeps it and the next bridge replays it.
// It is the same state a crash at that point would leave, which the replay already handles; what stop() must never do is
// finish a hand-over to a session that is going away and then tell the relay the message is consumed.
import type { BridgeContext } from './context.ts'

export class BridgeStopping extends Error {
  constructor() {
    super('the bridge is stopping')
    this.name = 'BridgeStopping'
  }
}

/** Throws BridgeStopping once the bridge has started to stop. Put it right after every wait that ends in a hand-over. */
export function refuseWhenStopping(ctx: Pick<BridgeContext, 'closing'>): void {
  if (ctx.closing) throw new BridgeStopping()
}

export const isStopping = (e: unknown): e is BridgeStopping => e instanceof BridgeStopping

/** Waits for `p`, but never longer than `capMs` (real time: a stop must end before lifecycle.ts's force-exit). */
export async function within(p: Promise<unknown>, capMs: number): Promise<void> {
  let cap: ReturnType<typeof setTimeout> | undefined
  await Promise.race([
    p,
    new Promise<void>((r) => {
      cap = setTimeout(r, capMs)
      cap.unref?.()
    }),
  ])
  clearTimeout(cap)
}

/**
 * `read_inbound` responses that are not yet written to the agent's transport. `read_inbound` claims what it returns, so a
 * session stopped between the claim and the write would strand the batch. server.ts says when a request is pending and when its
 * response was handed to the transport; stop() waits for the pending ones, within a cap.
 */
export class PendingResults {
  private readonly pending = new Map<string | number, { done: () => void; landed: Promise<void> }>()

  add(requestId: string | number): void {
    let done = () => {}
    const landed = new Promise<void>((r) => {
      done = r
    })
    this.pending.set(requestId, { done, landed })
  }

  written(requestId: string | number): void {
    const e = this.pending.get(requestId)
    this.pending.delete(requestId)
    e?.done()
  }

  /** The request was cancelled: no response will be written, so there is nothing to wait for. */
  cancelled(requestId: string | number): void {
    this.written(requestId)
  }

  settled(capMs: number): Promise<void> {
    if (!this.pending.size) return Promise.resolve()
    return within(Promise.all([...this.pending.values()].map((e) => e.landed)), capMs)
  }
}

type Wire = { send(message: never): Promise<void> }

/**
 * Wraps a transport's `send` so `onWritten(id)` runs after a RESPONSE (a message with an id and a result or an error) was
 * written. A write that fails does not call it: the response never reached the agent, so what it carries is still pending and a
 * stop must not take that for done (it waits, within its cap, and the claim behind it stays visible as unfinished).
 */
export function trackWrites<T extends Wire>(transport: T, onWritten: (id: string | number) => void): void {
  const send = transport.send.bind(transport) as (m: unknown) => Promise<void>
  transport.send = (async (message: unknown) => {
    await send(message)
    const m = message as { id?: string | number; result?: unknown; error?: unknown }
    if (m.id !== undefined && ('result' in m || 'error' in m)) onWritten(m.id)
  }) as T['send']
}
