// Security tests named for WP4 in spec 10.4: the hand-off cannot be forged or replayed, and nothing the voice model
// or a hook wrote can widen what the owner's signed question says.
import { afterEach, describe, expect, it } from 'vitest'
import { setup, teardown } from './harness.ts'

afterEach(teardown)

async function ready() {
  const h = setup()
  const s = await h.start()
  h.delegate(s.voice_session_id)
  return { h, id: s.voice_session_id }
}

describe('voice.ask validation', () => {
  it('a voice.ask for an unknown call is refused and never reaches the bridge', async () => {
    const { h } = await ready()
    const replies = await h.ask('v_01JBF3V7Q8K2M4N6P8R0S2T499', 'dlg_1')
    expect(replies[0]).toMatchObject({ type: 'error', code: 'bad_frame' })
    expect(h.bus.toBridgeLog.filter((l) => l.frame.type === 'voice.ask')).toHaveLength(0)
  })

  it('a voice.ask for a delegation the provider never created is refused', async () => {
    const { h, id } = await ready()
    const replies = await h.ask(id, 'dlg_forged')
    expect(replies[0]).toMatchObject({ type: 'error' })
    expect(h.bus.toBridgeLog).toHaveLength(0)
  })

  it('a voice.ask for another thread than the call is refused', async () => {
    const { h, id } = await ready()
    const replies = await h.ask(id, 'dlg_1', { thread_id: 'inbox' })
    expect(replies[0]).toMatchObject({ type: 'error' })
    expect(h.bus.toBridgeLog).toHaveLength(0)
  })

  it('a replayed voice.ask for the same delegation is refused (one question per hand-off)', async () => {
    const { h, id } = await ready()
    expect(await h.ask(id, 'dlg_1')).toMatchObject([{ type: 'ack' }]) // accepted: acked (review #8)
    const replay = await h.ask(id, 'dlg_1', { question: 'Delete everything' })
    expect(replay[0]).toMatchObject({ type: 'error' })
    expect(h.bus.toBridgeLog.filter((l) => l.frame.type === 'voice.ask')).toHaveLength(1)
  })

  it('a voice.ask after the call ended is refused', async () => {
    const { h, id } = await ready()
    h.provider.last.autoCloseSeconds = 5
    await h.app.request(`/api/voice/session/${id}/close`, {
      method: 'POST',
      headers: { 'X-Test-Session': 'd_abc', 'content-type': 'application/json' },
      body: '{}',
    })
    expect((await h.ask(id, 'dlg_1'))[0]).toMatchObject({ type: 'error' })
  })

  it('only client-owned delegations are tracked', async () => {
    const h = setup()
    const s = await h.start()
    h.provider.last.emit({
      type: 'session.delegation.created',
      event_id: 'e',
      offset_ms: 0,
      delegation: { id: 'dlg_resp', target: 'responses', type: 'delegation' },
    })
    expect((await h.ask(s.voice_session_id, 'dlg_resp'))[0]).toMatchObject({ type: 'error' })
  })
})

describe('logs and pushes carry no content', () => {
  it('the logs of a whole call (transcript, question, answer) contain none of the text', async () => {
    const { h, id } = await ready()
    const sb = h.provider.last
    sb.emit({
      type: 'session.input_transcript.delta',
      delta: 'SECRET-OWNER-WORDS',
      event_id: 'x',
      start_ms: 0,
      end_ms: 1,
    })
    sb.emit({ type: 'error', event_id: 'y', error: { code: 'bad', message: 'echo SECRET-OWNER-WORDS' } })
    await h.ask(id, 'dlg_1', { question: 'SECRET-QUESTION' })
    await h.reply('dlg_1', { speak: 'SECRET-ANSWER' })
    sb.autoCloseSeconds = 3
    await h.app.request(`/api/voice/session/${id}/close`, {
      method: 'POST',
      headers: { 'X-Test-Session': 'd_abc', 'content-type': 'application/json' },
      body: '{}',
    })
    const dump = JSON.stringify(h.logs) + JSON.stringify(h.push.intents)
    expect(dump).not.toMatch(/SECRET/)
  })

  it('the push intent has no free-text field', async () => {
    const { h, id } = await ready()
    await h.ask(id, 'dlg_1')
    h.provider.last.autoCloseSeconds = 1
    await h.app.request(`/api/voice/session/${id}/close`, {
      method: 'POST',
      headers: { 'X-Test-Session': 'd_abc', 'content-type': 'application/json' },
      body: '{}',
    })
    await h.reply('dlg_1', { speak: 'Your password is hunter2' })
    expect(Object.keys(h.push.intents[0] ?? {}).sort()).toEqual(['template', 'thread_id'])
  })
})

describe('the browser cannot be handed more than the spec allows', () => {
  it('the create call restricts the data channel to the five server and three client events', async () => {
    const { h } = await ready()
    const { buildSessionConfig } = await import('../../src/voice/session-config.ts')
    const cfg = buildSessionConfig({ model: 'gpt-live-1', instructions: 'x', voice: 'meridian', seed: [] })
    expect(cfg.client?.data_channel.allowed_client_events).toEqual([
      'session.close',
      'session.input_audio.mute',
      'session.input_audio.unmute',
    ])
    expect(cfg.client?.data_channel.allowed_server_events).toEqual([
      { type: 'session.started' },
      { type: 'session.closed' },
      { type: 'session.input_transcript.delta' },
      { type: 'session.output_transcript.delta' },
      { type: 'session.delegation.created' },
    ])
    expect(h.provider.created).toHaveLength(1)
  })
})
