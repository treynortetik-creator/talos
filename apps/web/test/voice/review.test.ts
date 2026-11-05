// Reviewer test for PR #3 (WP4). Expected to FAIL on wp4/live-voice as submitted.
import { describe, expect, it } from 'vitest'
import { CallController } from '../../src/features/voice/callController.ts'
import { createFakeClient } from '../../src/lib/fakeClient.ts'
import { fakeDeps } from './fakes.ts'

describe('R5 client-side call cap backstop', () => {
  it('the app hangs up by itself shortly after max_minutes even if the relay never says "ended"', async () => {
    const timers: Array<{ fn: () => void; ms: number }> = []
    const f = fakeDeps({
      fetchResponses: [
        Response.json({
          voice_session_id: 'v_01JBF3V7Q8K2M4N6P8R0S2T426',
          sdp_answer: 'v=0\r\na=a\r\n',
          max_minutes: 1,
        }),
      ],
      setTimeout: (fn, ms) => {
        timers.push({ fn, ms })
        return timers.length
      },
      clearTimeout: () => {},
    })
    const c = new CallController(f.deps)
    const started = c.start(createFakeClient(), 'general')
    await new Promise((r) => setTimeout(r, 10))
    f.peer.dc.emit({ type: 'session.started' })
    await started
    expect(c.store.getState().phase).toBe('live')
    // The relay's voice.state 'ended' is not durable: an app whose socket is down at the cap never hears it.
    for (const t of timers.filter((t) => t.ms >= 60_000 && t.ms <= 3 * 60_000)) t.fn()
    await new Promise((r) => setTimeout(r, 10))
    expect(c.store.getState().phase).toBe('idle')
    expect(f.peer.closed).toBe(true)
  })
})

describe('R6 question timing (needs Mac smoke with a real OpenAI key)', () => {
  it.todo(
    'waits for input-transcript deltas to go quiet (~800 ms) before building the question after session.delegation.created',
  )
})
