// Scripted provider for tests: no network. `emit` pushes a server event into the attached sideband.
import type { CreateSessionArgs, Sideband, SidebandEvent, VoiceProvider } from './provider.ts'

export class FakeSideband implements Sideband {
  readonly sent: Array<Record<string, unknown>> = []
  closed = false
  private handler: ((e: SidebandEvent) => void) | null = null
  private disconnect: (() => void) | null = null
  /** When set, `session.close` is answered with a `session.closed` carrying these seconds. */
  autoCloseSeconds: number | null = 0

  onEvent(handler: (e: SidebandEvent) => void) {
    this.handler = handler
  }
  onDisconnect(handler: () => void) {
    this.disconnect = handler
  }
  send(event: Record<string, unknown>) {
    this.sent.push(event)
    if (event.type === 'session.close' && this.autoCloseSeconds !== null) {
      this.emit({
        type: 'session.closed',
        event_id: 'evt_closed',
        reason: 'close_requested',
        usage: { seconds: this.autoCloseSeconds },
      })
    }
  }
  close() {
    this.closed = true
  }
  emit(event: SidebandEvent) {
    this.handler?.(event)
  }
  drop() {
    this.disconnect?.()
  }
  /** Commands of one type, in order. */
  of(type: string) {
    return this.sent.filter((e) => e.type === type)
  }
}

export class FakeVoiceProvider implements VoiceProvider {
  readonly name = 'live' as const
  readonly created: CreateSessionArgs[] = []
  readonly sidebands = new Map<string, FakeSideband>()
  readonly closedIds: string[] = []
  failCreate: Error | null = null
  private n = 0

  async create(args: CreateSessionArgs) {
    if (this.failCreate) throw this.failCreate
    this.created.push(args)
    const id = `live_fake_${++this.n}`
    return { provider_session_id: id, sdp_answer: `v=0\r\na=fake-answer-${this.n}\r\n` }
  }
  attach(id: string) {
    const sb = new FakeSideband()
    this.sidebands.set(id, sb)
    return sb
  }
  async close(id: string) {
    this.closedIds.push(id)
  }
  /** The latest sideband. */
  get last(): FakeSideband {
    const all = [...this.sidebands.values()]
    const sb = all[all.length - 1]
    if (!sb) throw new Error('no sideband attached')
    return sb
  }
}
