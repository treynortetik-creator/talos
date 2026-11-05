// The voice provider seam (spec 6.1). The relay codes against these interfaces; `gpt-live.ts` talks to OpenAI,
// `fake-provider.ts` is scripted for tests.
import type { InitialItem } from 'openai/resources/live/live'

/** A server event off the sideband. Only `type` is relied on; the rest is read defensively by the manager. */
export type SidebandEvent = { type: string } & Record<string, unknown>

export interface Sideband {
  /** Registers the (single) event handler. */
  onEvent(handler: (event: SidebandEvent) => void): void
  /** Called once if the sideband socket dies without `session.closed`. */
  onDisconnect(handler: () => void): void
  /** Sends a client command (`session.commentary.append`, `session.close`, ...). */
  send(event: Record<string, unknown>): void
  close(): void
}

export type CreateSessionArgs = {
  sdp: string
  instructions: string
  voice: string
  seed: InitialItem[]
}

export interface VoiceProvider {
  readonly name: 'live'
  create(args: CreateSessionArgs): Promise<{ provider_session_id: string; sdp_answer: string }>
  attach(providerSessionId: string): Sideband
  /** Releases anything held for the session (the sideband socket). Idempotent. */
  close(providerSessionId: string): Promise<void>
}
