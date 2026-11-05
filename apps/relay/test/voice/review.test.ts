// Reviewer tests for PR #3 (WP4). Each one is expected to FAIL on wp4/live-voice as submitted.
import { afterEach, describe, expect, it } from 'vitest'
import { type AuthContract, setAuthImplementation } from '../../src/auth/contract.ts'
import { getVoiceManager, register } from '../../src/voice/index.ts'
import { createTestAuth, testAppHeaders } from '../helpers/test-auth.ts'
import { setup, teardown } from './harness.ts'

afterEach(teardown)

describe('R1 cost caps under concurrency', () => {
  it('two concurrent session creates cannot both get the full remaining daily budget', async () => {
    const h = setup({ VOICE_DAILY_MAX_MIN: '30', VOICE_SESSION_MAX_MIN: '30' })
    const [a, b] = await Promise.all([h.call(), h.call()])
    const ok = [a, b].filter((r) => r.status === 200)
    const granted = (await Promise.all(ok.map((r) => r.json()))) as Array<{ max_minutes: number }>
    const open = [...h.provider.sidebands.values()].filter((sb) => sb.of('session.close').length === 0)
    // Either the second request is refused / supersedes the first, or the two grants fit inside the daily cap.
    expect(open.length).toBeLessThanOrEqual(1)
    expect(granted.reduce((n, g) => n + g.max_minutes, 0)).toBeLessThanOrEqual(30)
  })
})

describe('R2 usage survives a relay restart', () => {
  it('a call that was in progress when the relay restarted still counts toward the daily cap', async () => {
    const h = setup({ VOICE_DAILY_MAX_MIN: '60' })
    await h.start()
    h.clock.advance(20 * 60_000) // 20 minutes into the call, then the process dies (no session.closed, no finalize)
    register(h.services) // fresh process: new manager, same database
    const remaining = getVoiceManager()?.dailyRemainingSeconds() ?? -1
    expect(remaining).toBeLessThanOrEqual(40 * 60)
  })
})

describe('R3 voice.ended fits in one bridge frame', () => {
  it('a long, chatty call produces a voice.ended under the 256 KiB post-auth frame limit', async () => {
    const h = setup()
    const s = await h.start()
    const sb = h.provider.last
    const chunk = 'x'.repeat(4000)
    for (let i = 0; i < 500; i++) {
      sb.emit({
        type: i % 2 ? 'session.output_transcript.delta' : 'session.input_transcript.delta',
        delta: chunk,
        event_id: `e${i}`,
        start_ms: i,
        end_ms: i + 1,
      })
    }
    sb.autoCloseSeconds = 1800
    await h.app.request(`/api/voice/session/${s.voice_session_id}/close`, {
      method: 'POST',
      headers: { 'X-Test-Session': 'd_abc', 'content-type': 'application/json' },
      body: '{}',
    })
    const ended = h.bus.toBridgeLog.find((l) => l.frame.type === 'voice.ended')
    expect(ended).toBeDefined()
    expect(Buffer.byteLength(JSON.stringify(ended?.frame))).toBeLessThanOrEqual(256 * 1024)
  })
})

describe('R4 rate-limit bucket', () => {
  function recordingAuth(log: string[]): AuthContract {
    const base = createTestAuth()
    return {
      ...base,
      requireSession: async (c, next) => {
        log.push('session')
        return base.requireSession(c, next)
      },
      rateLimit: (name) => async (_c, next) => {
        log.push(`rl:${name}`)
        await next()
      },
    }
  }

  it("an unauthenticated request does not spend the owner's 10/hour voice bucket", async () => {
    const h = setup()
    const log: string[] = []
    setAuthImplementation(recordingAuth(log), { test: true })
    const res = await h.app.request('/api/voice/session', {
      method: 'POST',
      headers: { Origin: 'https://relay.example.com', 'content-type': 'application/json' },
      body: JSON.stringify({ thread_id: 'general', sdp: 'v=0' }),
    })
    expect(res.status).toBe(401)
    expect(log).not.toContain('rl:voice')
  })

  it('hanging up does not spend a call-creation token (10/hour must mean 10 calls)', async () => {
    const h = setup()
    const s = await h.start()
    const log: string[] = []
    setAuthImplementation(recordingAuth(log), { test: true })
    h.provider.last.autoCloseSeconds = 5
    const res = await h.app.request(`/api/voice/session/${s.voice_session_id}/close`, {
      method: 'POST',
      headers: { ...testAppHeaders('https://relay.example.com', 'd_abc'), 'content-type': 'application/json' },
      body: '{}',
    })
    expect(res.status).toBe(204)
    expect(log).not.toContain('rl:voice')
  })
})

describe('R2 checkpoints', () => {
  it('writes elapsed seconds every 30 s while a call is live, and on shutdown', async () => {
    const h = setup()
    const s = await h.start()
    const read = () =>
      (
        h.db.prepare('select seconds from voice_usage where voice_session_id = ?').get(s.voice_session_id) as {
          seconds: number
        }
      ).seconds
    h.clock.advance(31_000)
    expect(read()).toBeGreaterThanOrEqual(30)
    h.clock.advance(10_000)
    getVoiceManager()?.shutdown()
    expect(read()).toBeGreaterThanOrEqual(41)
  })
})
