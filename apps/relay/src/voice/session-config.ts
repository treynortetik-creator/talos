// The `session` object sent to `openai.live.create` (spec 6.2 step 2). The event names below are checked against
// the installed openai types at compile time (`satisfies`), and again by test/voice/session-config.test.ts.
import type { ClientEvent, InitialItem, MediaSessionConfig, ServerEvent } from 'openai/resources/live/live'

/** Events the untrusted browser may SEND over the data channel. */
export const ALLOWED_CLIENT_EVENTS = [
  'session.close',
  'session.input_audio.mute',
  'session.input_audio.unmute',
] as const satisfies readonly ClientEvent['type'][]

/** Events the browser may RECEIVE. */
export const ALLOWED_SERVER_EVENTS = [
  'session.started',
  'session.closed',
  'session.input_transcript.delta',
  'session.output_transcript.delta',
  'session.delegation.created',
] as const satisfies readonly ServerEvent['type'][]

export function buildSessionConfig(args: {
  model: string
  instructions: string
  voice: string
  seed: InitialItem[]
}): MediaSessionConfig {
  return {
    model: args.model,
    instructions: args.instructions,
    audio: { output: { voice: args.voice } },
    delegation: { type: 'client', acknowledgement_delay_ms: 0 },
    input: args.seed,
    client: {
      data_channel: {
        allowed_client_events: [...ALLOWED_CLIENT_EVENTS],
        allowed_server_events: ALLOWED_SERVER_EVENTS.map((type) => ({ type })),
      },
    },
  }
}
