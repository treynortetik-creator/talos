import { afterEach, describe, expect, it } from 'vitest'
import { resetAuthImplementation } from '../../src/auth/contract.ts'
import { buildApp } from '../../src/routes.ts'
import { setVoiceProvider } from '../../src/voice/index.ts'
import { DAILY_LIMIT_MESSAGE, NO_ASK_MS, STILL_WORKING_MS } from '../../src/voice/manager.ts'
import { createFakeServices } from '../helpers/fake-services.ts'
import { setup, teardown } from './harness.ts'

afterEach(teardown)

describe('POST /api/voice/session', () => {
  it('returns the answer SDP, max minutes and logs a usage row', async () => {
    const h = setup()
    const res = await h.start()
    expect(res.voice_session_id).toMatch(/^v_[0-9A-HJKMNP-TV-Z]{26}$/)
    expect(res.sdp_answer).toContain('fake-answer-1')
    expect(res.max_minutes).toBe(30)
    expect(
      h.db.prepare('select seconds from voice_usage where voice_session_id = ?').get(res.voice_session_id),
    ).toEqual({
      seconds: 0,
    })
    const created = h.provider.created[0]
    expect(created?.voice).toBe('meridian')
    expect(created?.instructions).toContain('You are the voice of Talos')
    expect(h.bus.toAppsLog.map((l) => l.frame.type)).toContain('voice.state')
  })

  it('daily cap -> 429 with the spoken message, before the provider is touched', async () => {
    const h = setup({ VOICE_DAILY_MAX_MIN: '1' })
    h.db
      .prepare('insert into voice_usage (voice_session_id, started_at, seconds) values (?, ?, ?)')
      .run('v_old', h.clock.iso(), 60)
    const res = await h.call()
    expect(res.status).toBe(429)
    expect(await res.json()).toEqual({ error: 'rate_limited', message: DAILY_LIMIT_MESSAGE })
    expect(h.provider.created).toHaveLength(0)
  })

  it('yesterday does not count toward today', async () => {
    const h = setup({ VOICE_DAILY_MAX_MIN: '1' })
    h.db
      .prepare('insert into voice_usage (voice_session_id, started_at, seconds) values (?, ?, ?)')
      .run('v_old', new Date(h.clock.now() - 86_400_000).toISOString(), 600)
    expect((await h.call()).status).toBe(200)
  })

  it('a call in progress counts toward the daily cap, and shrinks max_minutes', async () => {
    const h = setup({ VOICE_DAILY_MAX_MIN: '5', VOICE_SESSION_MAX_MIN: '30' })
    h.db
      .prepare('insert into voice_usage (voice_session_id, started_at, seconds) values (?, ?, ?)')
      .run('v_old', h.clock.iso(), 120)
    expect((await h.start()).max_minutes).toBe(3)
  })

  it('refuses unknown, system and archived threads, and bad bodies', async () => {
    const h = setup()
    expect((await h.call('nope')).status).toBe(404)
    expect((await h.call('inbox')).status).toBe(400)
    const bad = await h.app.request('/api/voice/session', {
      method: 'POST',
      headers: { 'X-Test-Session': 'none', 'content-type': 'application/json' },
      body: '{"thread_id":"general"}',
    })
    expect(bad.status).toBe(400)
  })

  it('401 without a session', async () => {
    const h = setup()
    const res = await h.app.request('/api/voice/session', { method: 'POST', body: '{}' })
    expect(res.status).toBe(401)
  })

  it('no key and no provider -> 503 voice_disabled', async () => {
    resetAuthImplementation()
    setVoiceProvider(null)
    const f = createFakeServices()
    const { register } = await import('../../src/voice/index.ts')
    register(f.services)
    const { installTestAuth } = await import('../helpers/test-auth.ts')
    installTestAuth()
    const res = await buildApp(f.services).request('/api/voice/session', {
      method: 'POST',
      headers: { 'X-Test-Session': 'none', 'content-type': 'application/json' },
      body: JSON.stringify({ thread_id: 'general', sdp: 'x' }),
    })
    expect(res.status).toBe(503)
  })

  it('a provider failure is a 502 with no detail', async () => {
    const h = setup()
    h.provider.failCreate = new Error('upstream said sk-secret')
    const res = await h.call()
    expect(res.status).toBe(502)
    expect(await res.text()).not.toContain('sk-secret')
  })

  it('a new call ends an abandoned one', async () => {
    const h = setup()
    const a = await h.start()
    const b = await h.start()
    expect(b.voice_session_id).not.toBe(a.voice_session_id)
    expect(h.provider.closedIds).toContain('live_fake_1')
  })
})

describe('caps and timers', () => {
  it('session cap warns one minute before and then closes', async () => {
    const h = setup({ VOICE_SESSION_MAX_MIN: '2' })
    const s = await h.start()
    const sb = h.provider.last
    h.clock.advance(59_000)
    expect(sb.of('session.commentary.append')).toHaveLength(0)
    h.clock.advance(1_000)
    expect(sb.of('session.commentary.append')).toEqual([
      { type: 'session.commentary.append', content: 'One minute left on this call.', delegation_id: null },
    ])
    expect(sb.of('session.close')).toHaveLength(0)
    sb.autoCloseSeconds = 120
    h.clock.advance(60_000)
    expect(sb.of('session.close')).toHaveLength(1)
    await Promise.resolve()
    expect(h.db.prepare('select seconds from voice_usage where voice_session_id = ?').get(s.voice_session_id)).toEqual({
      seconds: 120,
    })
  })

  it('a delegation with no voice.ask in 3 s gets the "couldn\'t reach" commentary once', async () => {
    const h = setup()
    const s = await h.start()
    h.delegate(s.voice_session_id)
    h.clock.advance(NO_ASK_MS - 1)
    expect(h.provider.last.of('session.commentary.append')).toHaveLength(0)
    h.clock.advance(1)
    expect(h.provider.last.of('session.commentary.append')).toEqual([
      { type: 'session.commentary.append', content: "I couldn't reach Talos just now.", delegation_id: 'dlg_1' },
    ])
    h.clock.advance(60_000)
    expect(h.provider.last.of('session.commentary.append')).toHaveLength(1)
    expect(h.bus.toBridgeLog).toHaveLength(0)
  })

  it('no reply in 20 s -> exactly one still-working commentary', async () => {
    const h = setup()
    const s = await h.start()
    h.delegate(s.voice_session_id)
    await h.ask(s.voice_session_id, 'dlg_1')
    h.clock.advance(NO_ASK_MS + 1_000) // the 3 s timer must be gone
    expect(h.provider.last.of('session.commentary.append')).toHaveLength(0)
    h.clock.advance(STILL_WORKING_MS)
    h.clock.advance(5 * 60_000)
    expect(h.provider.last.of('session.commentary.append')).toEqual([
      {
        type: 'session.commentary.append',
        content: "Talos's still on it. I'll ping you when it's done.",
        delegation_id: 'dlg_1',
      },
    ])
  })

  it('progress resets the 20 s timer; say:false is silent thinking, say:true is commentary', async () => {
    const h = setup()
    const s = await h.start()
    h.delegate(s.voice_session_id)
    await h.ask(s.voice_session_id, 'dlg_1')
    h.clock.advance(15_000)
    await h.progress('dlg_1', 'Reading the calendar', false)
    h.clock.advance(15_000)
    expect(h.provider.last.of('session.commentary.append')).toHaveLength(0)
    await h.progress('dlg_1', 'Found three meetings', true)
    expect(h.provider.last.sent.slice(-2)).toEqual([
      { type: 'session.thinking.append', content: 'Reading the calendar', delegation_id: 'dlg_1' },
      { type: 'session.commentary.append', content: 'Found three meetings', delegation_id: 'dlg_1' },
    ])
  })

  it('progress text is cut to the 500-token limit', async () => {
    const h = setup()
    const s = await h.start()
    h.delegate(s.voice_session_id)
    await h.ask(s.voice_session_id, 'dlg_1')
    await h.progress('dlg_1', 'x'.repeat(2000), false)
    const sent = h.provider.last.of('session.thinking.append')[0]
    expect(String(sent?.content).length).toBeLessThanOrEqual(1500)
  })
})

describe('hand-off', () => {
  it('forwards the signed voice.ask to the bridge exactly as received', async () => {
    const h = setup()
    const s = await h.start()
    h.delegate(s.voice_session_id)
    const replies = await h.ask(s.voice_session_id, 'dlg_1')
    expect(replies).toMatchObject([{ type: 'ack' }]) // accepted: acked (review #8)
    const sent = h.bus.toBridgeLog.filter((l) => l.frame.type === 'voice.ask')
    expect(sent).toHaveLength(1)
    expect(sent[0]?.frame).toMatchObject({
      delegation_id: 'dlg_1',
      voice_session_id: s.voice_session_id,
      osig: expect.any(String),
    })
    expect(sent[0]?.opts).toMatchObject({ durable: true })
  })

  it('a reply with speak while the call is open becomes commentary', async () => {
    const h = setup()
    const s = await h.start()
    h.delegate(s.voice_session_id)
    await h.ask(s.voice_session_id, 'dlg_1')
    await h.reply('dlg_1', { speak: 'You have two meetings.' })
    expect(h.provider.last.of('session.commentary.append')).toEqual([
      { type: 'session.commentary.append', content: 'You have two meetings.', delegation_id: 'dlg_1' },
    ])
    expect(h.push.intents).toEqual([])
    h.clock.advance(60_000)
    expect(h.provider.last.of('session.commentary.append')).toHaveLength(1) // timers cleared
  })

  it('a reply after the call closed sends an "Answer ready" push, once', async () => {
    const h = setup()
    const s = await h.start()
    h.delegate(s.voice_session_id)
    await h.ask(s.voice_session_id, 'dlg_1')
    const closed = await h.app.request(`/api/voice/session/${s.voice_session_id}/close`, {
      method: 'POST',
      headers: { 'X-Test-Session': 'd_abc', 'content-type': 'application/json' },
      body: '{}',
    })
    expect(closed.status).toBe(204)
    await h.reply('dlg_1', { speak: 'Done.' })
    expect(h.push.intents).toEqual([{ template: 'answer_ready', thread_id: 'general' }])
    await h.reply('dlg_1', { speak: 'Done.' })
    expect(h.push.intents).toHaveLength(1)
  })

  it('a reply with no voice_delegation_id is ignored', async () => {
    const h = setup()
    await h.start()
    await h.reply('', { voice_delegation_id: undefined })
    expect(h.push.intents).toEqual([])
  })
})

describe('end of call', () => {
  it('records usage from session.closed, writes voice_turn + call_record, and tells the bridge', async () => {
    const h = setup()
    const s = await h.start()
    const sb = h.provider.last
    sb.autoCloseSeconds = 95
    sb.emit({ type: 'session.started', event_id: 'e0', session: {} })
    sb.emit({ type: 'session.input_transcript.delta', delta: 'What is ', start_ms: 0, end_ms: 1, event_id: 'a' })
    sb.emit({ type: 'session.input_transcript.delta', delta: 'on my plate?', start_ms: 0, end_ms: 1, event_id: 'b' })
    sb.emit({ type: 'session.output_transcript.delta', delta: 'On it.', start_ms: 0, end_ms: 1, event_id: 'c' })
    h.delegate(s.voice_session_id)
    h.clock.advance(1_000)
    const res = await h.app.request(`/api/voice/session/${s.voice_session_id}/close`, {
      method: 'POST',
      headers: { 'X-Test-Session': 'd_abc', 'content-type': 'application/json' },
      body: '{}',
    })
    expect(res.status).toBe(204)
    expect(h.db.prepare('select seconds from voice_usage where voice_session_id = ?').get(s.voice_session_id)).toEqual({
      seconds: 95,
    })
    expect(h.appended).toMatchObject([
      { kind: 'voice_turn', author: 'owner', text: 'What is on my plate?', via: 'voice', thread_id: 'general' },
      { kind: 'voice_turn', author: 'agent', text: 'On it.' },
      {
        kind: 'call_record',
        author: 'system',
        text: 'Voice call · 2 min',
        call: { voice_session_id: s.voice_session_id, duration_s: 95, delegations: 1 },
      },
    ])
    const ended = h.bus.toBridgeLog.find((l) => l.frame.type === 'voice.ended')
    expect(ended?.frame).toMatchObject({
      voice_session_id: s.voice_session_id,
      thread_id: 'general',
      duration_s: 95,
      transcript: [
        { who: 'owner', text: 'What is on my plate?' },
        { who: 'agent', text: 'On it.' },
      ],
    })
    expect(ended?.opts).toMatchObject({ durable: true })
    expect(h.provider.closedIds).toContain('live_fake_1')
    expect(h.bus.toAppsLog.at(-1)?.frame).toMatchObject({ type: 'voice.state', state: 'ended' })
  })

  it('closes with the elapsed time when the provider never confirms', async () => {
    const h = setup()
    const s = await h.start()
    h.provider.last.autoCloseSeconds = null
    const closing = h.app.request(`/api/voice/session/${s.voice_session_id}/close`, {
      method: 'POST',
      headers: { 'X-Test-Session': 'd_abc', 'content-type': 'application/json' },
      body: '{}',
    })
    h.clock.advance(10_000)
    expect((await closing).status).toBe(204)
    expect(h.db.prepare('select seconds from voice_usage where voice_session_id = ?').get(s.voice_session_id)).toEqual({
      seconds: 10,
    })
  })

  it('a dropped sideband ends the call', async () => {
    const h = setup()
    const s = await h.start()
    h.provider.last.drop()
    await Promise.resolve()
    await Promise.resolve()
    expect(h.bus.toBridgeLog.some((l) => l.frame.type === 'voice.ended')).toBe(true)
    expect(h.appended.length).toBe(1)
    void s
  })

  it('closing an unknown call is a quiet 204', async () => {
    const h = setup()
    const res = await h.app.request('/api/voice/session/v_nope/close', {
      method: 'POST',
      headers: { 'X-Test-Session': 'd_abc', 'content-type': 'application/json' },
      body: '{}',
    })
    expect(res.status).toBe(204)
  })
})
