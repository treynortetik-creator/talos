import type { ClientEvent, ServerEvent } from 'openai/resources/live/live'
import { describe, expect, expectTypeOf, it } from 'vitest'
import { ALLOWED_CLIENT_EVENTS, ALLOWED_SERVER_EVENTS, buildSessionConfig } from '../../src/voice/session-config.ts'

describe('session config', () => {
  it('the allowed event names are real event types in the installed openai types (compile-time)', () => {
    expectTypeOf<(typeof ALLOWED_CLIENT_EVENTS)[number]>().toExtend<ClientEvent['type']>()
    expectTypeOf<(typeof ALLOWED_SERVER_EVENTS)[number]>().toExtend<ServerEvent['type']>()
    // and the exact set the spec lists (6.2) so a rename in the SDK or a stray addition fails loudly
    expectTypeOf<(typeof ALLOWED_CLIENT_EVENTS)[number]>().toEqualTypeOf<
      'session.close' | 'session.input_audio.mute' | 'session.input_audio.unmute'
    >()
    expectTypeOf<(typeof ALLOWED_SERVER_EVENTS)[number]>().toEqualTypeOf<
      | 'session.started'
      | 'session.closed'
      | 'session.input_transcript.delta'
      | 'session.output_transcript.delta'
      | 'session.delegation.created'
    >()
    expect(ALLOWED_CLIENT_EVENTS).toHaveLength(3)
    expect(ALLOWED_SERVER_EVENTS).toHaveLength(5)
  })

  it('builds the spec 6.2 session object', () => {
    const cfg = buildSessionConfig({ model: 'gpt-live-1', instructions: 'be brief', voice: 'meridian', seed: [] })
    expect(cfg).toMatchObject({
      model: 'gpt-live-1',
      instructions: 'be brief',
      audio: { output: { voice: 'meridian' } },
      delegation: { type: 'client', acknowledgement_delay_ms: 0 },
      input: [],
    })
  })
})
