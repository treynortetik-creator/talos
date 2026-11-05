// The real provider: OpenAI GPT-Live over WebRTC with a server-side sideband (spec 6.1, 6.2). The API key never leaves
// the relay process. Nothing here is unit tested against the network; scripts/smoke/wp4.md covers it with a real key.
import OpenAI from 'openai'
import { SidebandWS } from 'openai/resources/live/sideband/ws'
import type { Logger } from '../services.ts'
import type { CreateSessionArgs, Sideband, SidebandEvent, VoiceProvider } from './provider.ts'
import { buildSessionConfig } from './session-config.ts'

/**
 * Longest the relay waits for the provider to answer a create. Without a bound the relay can outlast the app's own POST
 * limit and the app gives up on a session the relay then creates, which nobody ends. With the 10 s a superseded call can
 * take to close (CLOSE_WAIT_MS) the relay always answers within about 20 s, inside the app's 30 s.
 */
export const PROVIDER_CREATE_TIMEOUT_MS = 10_000

class WsSideband implements Sideband {
  private handler: (e: SidebandEvent) => void = () => {}
  private disconnect: () => void = () => {}
  private done = false
  constructor(private readonly ws: SidebandWS) {
    ws.on('event', (e) => this.handler(e as unknown as SidebandEvent))
    ws.on('close', () => {
      if (!this.done) this.disconnect()
    })
  }
  onEvent(h: (e: SidebandEvent) => void) {
    this.handler = h
  }
  onDisconnect(h: () => void) {
    this.disconnect = h
  }
  send(event: Record<string, unknown>) {
    this.ws.send(event as never)
  }
  close() {
    this.done = true
    this.ws.close()
  }
}

export class GptLiveProvider implements VoiceProvider {
  readonly name = 'live' as const
  private readonly client: OpenAI
  private readonly sidebands = new Map<string, WsSideband>()

  constructor(
    apiKey: string,
    private readonly model: string,
    private readonly log: Logger,
  ) {
    this.client = new OpenAI({ apiKey })
  }

  async create(args: CreateSessionArgs) {
    const res = await this.client.live.create(
      {
        session: buildSessionConfig({ model: this.model, ...args }),
        transport: { type: 'webrtc', sdp: args.sdp },
      },
      // No retries: each retry would restart the clock and push the answer past the app's limit.
      { timeout: PROVIDER_CREATE_TIMEOUT_MS, maxRetries: 0 },
    )
    return { provider_session_id: res.session.id, sdp_answer: res.transport.sdp }
  }

  attach(providerSessionId: string): Sideband {
    const ws = new SidebandWS(this.client, {
      session_id: providerSessionId,
      graceful_close: true,
      // R5: a dropped sideband must not silently lift the server-side cap; retry before giving up.
      reconnect: { maxRetries: 3, onReconnecting: () => {} },
    })
    ws.on('error', (err) => this.log.warn({ err: String(err) }, 'voice sideband error'))
    const sb = new WsSideband(ws)
    this.sidebands.set(providerSessionId, sb)
    return sb
  }

  async close(providerSessionId: string) {
    this.sidebands.get(providerSessionId)?.close()
    this.sidebands.delete(providerSessionId)
  }
}
