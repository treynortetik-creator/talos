// How a worker-mode bridge sends (docs/OPTION-C.md). Hub up: every frame goes to main's live bridge over hub.sock, and
// the hub checks, sends and acks it. Hub down: replies and cards go over the signed HTTP path like any headless job, after
// the same checks the hub runs (hub/worker-fence.ts): the fence must not depend on the hub being up (bridge-fence #22).
import type { Frame } from '@talos-app/protocol'
import type { HubClient } from '../hub/client.ts'
import { type FenceDeps, workerFrameProblem } from '../hub/worker-fence.ts'
import type { Logger } from '../log.ts'
import { type DurableResult, RelayRejectedError, type Transport } from '../transport.ts'
import type { WorkerStore } from './store.ts'

export class WorkerTransport implements Transport {
  constructor(
    private readonly threadId: string,
    private readonly hub: HubClient,
    private readonly http: Transport,
    private readonly store: WorkerStore,
    private readonly log: Logger,
    private readonly now: () => number,
    /** What the fence needs, once the bridge's context exists; without it nothing goes over HTTP. */
    private readonly fence?: () => FenceDeps | undefined,
  ) {}

  /** `set_status` and receipts need the hub; replies and cards also work over HTTP. */
  get live(): boolean {
    return this.hub.connected
  }

  async sendDurable(frame: Frame): Promise<DurableResult> {
    // the worker's own `card` tool just minted this id; the hub refuses a card.create with no raiser row of this thread
    if (frame.type === 'card.create') this.store.setCardRaiser(frame.card.id, this.threadId, this.now())
    if (this.hub.connected) {
      const a = await this.hub.out(frame)
      if (a.state === 'sent') return { state: 'acked' }
      if (a.state === 'queued') return { state: 'queued' }
      if (a.code !== 'hub_down' && a.code !== 'hub_closed' && a.code !== 'timeout')
        throw new RelayRejectedError(a.code ?? 'refused', a.message ?? 'the hub refused it')
      this.log.warn('hub did not take a frame; falling back to HTTP', { type: frame.type, code: a.code })
    }
    const deps = this.fence?.()
    const why = deps
      ? workerFrameProblem(frame, this.threadId, deps)
      : { code: 'worker_fence', message: 'the hub is down and this session cannot check the frame' }
    if (why) throw new RelayRejectedError(why.code, why.message)
    return this.http.sendDurable(frame) // throws for types the HTTP API doesn't take (card.update, …)
  }

  sendEphemeral(frame: Frame): boolean {
    return this.hub.fire(frame)
  }
}
