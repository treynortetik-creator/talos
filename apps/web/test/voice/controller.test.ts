import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CallController } from '../../src/features/voice/callController.ts'
import { createFakeClient } from '../../src/lib/fakeClient.ts'
import { fakeDeps } from './fakes.ts'

const tick = () => new Promise((r) => setTimeout(r, 10))
const THREAD = 'general'
const SESSION = 'v_01JBF3V7Q8K2M4N6P8R0S2T426'

beforeEach(() => localStorage.clear())
afterEach(() => localStorage.clear())

async function live(over: Parameters<typeof fakeDeps>[0] = {}) {
  const f = fakeDeps(over)
  const client = createFakeClient()
  const c = new CallController(f.deps)
  const started = c.start(client, THREAD)
  await tick()
  f.peer.dc.emit({ type: 'session.started' })
  await started
  return { ...f, client, c }
}

describe('starting a call', () => {
  it('creates the data channel before the offer, posts the SDP with the CSRF header, and goes live on session.started', async () => {
    const { c, peer, calls } = await live()
    expect(peer.log).toEqual([
      'createDataChannel:oai-events',
      'addTrack',
      'createOffer',
      'setLocalDescription',
      'setRemoteDescription',
    ])
    expect(calls[0]?.url).toBe('/api/voice/session')
    expect(calls[0]?.init.headers).toMatchObject({ 'X-Talos-CSRF': '1' })
    expect(JSON.parse(String(calls[0]?.init.body))).toEqual({ thread_id: THREAD, sdp: 'v=0\r\no=- offer\r\n' })
    expect(peer.remote).toBe('v=0\r\na=answer\r\n')
    expect(c.store.getState()).toMatchObject({ phase: 'live', voiceSessionId: SESSION, error: null })
  })

  it('shows the relay message when the daily cap is hit and releases the microphone', async () => {
    const f = fakeDeps({
      fetchResponses: [
        Response.json({ error: 'rate_limited', message: "Today's live-voice limit is used up." }, { status: 429 }),
      ],
    })
    const c = new CallController(f.deps)
    await c.start(createFakeClient(), THREAD)
    expect(c.store.getState()).toMatchObject({ phase: 'idle', error: "Today's live-voice limit is used up." })
    expect(f.track.stopped).toBe(true)
    expect(f.peer.closed).toBe(true)
  })

  it('says so when voice is not set up (503) and when the mic is refused', async () => {
    const a = fakeDeps({ fetchResponses: [new Response('{}', { status: 503 })] })
    const ca = new CallController(a.deps)
    await ca.start(createFakeClient(), THREAD)
    expect(ca.store.getState().error).toMatch(/isn't set up/)
    const b = fakeDeps({
      getUserMedia: async () => {
        throw Object.assign(new Error('x'), { name: 'NotAllowedError' })
      },
    })
    const cb = new CallController(b.deps)
    await cb.start(createFakeClient(), THREAD)
    expect(cb.store.getState().error).toBe('Allow the microphone to start a call.')
  })

  it('shows "Tap to hear" when autoplay is blocked, and clears it once audio plays', async () => {
    const { c, peer, audio } = await live()
    audio.rejectPlay = true
    peer.ontrack()
    await Promise.resolve()
    await Promise.resolve()
    expect(c.store.getState().needsTapToHear).toBe(true)
    audio.rejectPlay = false
    await c.playAudio()
    expect(c.store.getState().needsTapToHear).toBe(false)
  })
})

describe('presence during a call', () => {
  it('tells the relay someone is here every 20 s while live, and stops when the call ends', async () => {
    vi.useFakeTimers()
    try {
      const f = fakeDeps({
        setTimeout: (fn, ms) => globalThis.setTimeout(fn, ms),
        clearTimeout: (h) => globalThis.clearTimeout(h as number),
      })
      const client = createFakeClient()
      const reports: number[] = []
      ;(client as { reportPresence?: () => void }).reportPresence = () => void reports.push(Date.now())
      const c = new CallController(f.deps)
      const started = c.start(client, THREAD)
      await vi.advanceTimersByTimeAsync(10)
      f.peer.dc.emit({ type: 'session.started' })
      await started
      expect(reports).toHaveLength(1)
      await vi.advanceTimersByTimeAsync(61_000)
      expect(reports).toHaveLength(4)
      await c.end()
      const after = reports.length
      await vi.advanceTimersByTimeAsync(120_000)
      expect(reports).toHaveLength(after)
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('mute and hold-to-talk', () => {
  it('mute disables the track AND tells the model; unmute reverses both', async () => {
    const { c, track, peer } = await live()
    c.setMuted(true)
    expect(track.enabled).toBe(false)
    expect(peer.dc.of('session.input_audio.mute')).toHaveLength(1)
    expect(c.store.getState().muted).toBe(true)
    c.setMuted(false)
    expect(track.enabled).toBe(true)
    expect(peer.dc.of('session.input_audio.unmute')).toHaveLength(1)
  })

  it('hold-to-talk opens the mic only while pressed', async () => {
    const { c, track } = await live()
    c.setMode('hold')
    expect(track.enabled).toBe(false)
    c.pressToTalk()
    expect(track.enabled).toBe(true)
    expect(c.store.getState().talking).toBe(true)
    c.releaseToTalk()
    expect(track.enabled).toBe(false)
    c.setMode('hands_free')
    expect(track.enabled).toBe(true)
    expect(localStorage.getItem('talos.voice.mode')).toBe('hands_free')
  })

  it('a call started in hold mode begins muted', async () => {
    localStorage.setItem('talos.voice.mode', 'hold')
    const { track, c } = await live()
    expect(track.enabled).toBe(false)
    expect(c.store.getState().mode).toBe('hold')
  })

  it('a call started in hold mode never has an open microphone, from the moment the peer gets the track until the press', async () => {
    localStorage.setItem('talos.voice.mode', 'hold')
    const f = fakeDeps()
    const c = new CallController(f.deps)
    const started = c.start(createFakeClient(), THREAD)
    await tick()
    // still connecting: the relay has answered, the model has not said started
    expect(c.store.getState().phase).toBe('connecting')
    expect(f.peer.enabledAtAdd).toEqual([false])
    expect(f.track.enabled).toBe(false)
    f.peer.dc.emit({ type: 'session.started' })
    await started
    expect(f.track.enabled).toBe(false)
    expect(f.track.sets).not.toContain(true)
    c.pressToTalk()
    expect(f.track.enabled).toBe(true)
  })

  it('a hands-free call still starts with the microphone open', async () => {
    const f = fakeDeps()
    const c = new CallController(f.deps)
    const started = c.start(createFakeClient(), THREAD)
    await tick()
    expect(f.peer.enabledAtAdd).toEqual([true])
    f.peer.dc.emit({ type: 'session.started' })
    await started
    expect(f.track.enabled).toBe(true)
  })

  it('press-to-talk does nothing in hands-free mode', async () => {
    const { c, peer } = await live()
    c.pressToTalk()
    expect(peer.dc.of('session.input_audio.unmute')).toHaveLength(0)
  })
})

describe('ending', () => {
  it('End sends session.close, tells the relay, stops the mic and closes the peer', async () => {
    const { c, calls, track, peer, audio } = await live()
    await c.end()
    expect(peer.dc.of('session.close')).toHaveLength(1)
    expect(calls.at(-1)?.url).toBe(`/api/voice/session/${SESSION}/close`)
    expect(track.stopped).toBe(true)
    expect(peer.closed).toBe(true)
    expect(audio.removed).toBe(true)
    expect(c.store.getState().phase).toBe('idle')
  })

  it('the page going hidden ends the call', async () => {
    const { c, hide, calls } = await live()
    hide()
    await tick()
    expect(c.store.getState().phase).toBe('idle')
    expect(calls.at(-1)?.url).toMatch(/\/close$/)
    expect(calls.at(-1)?.init).toMatchObject({ keepalive: true })
  })

  it('session.closed from the model ends it without a second close request', async () => {
    const { c, peer, calls } = await live()
    peer.dc.emit({ type: 'session.closed' })
    await tick()
    expect(c.store.getState().phase).toBe('idle')
    expect(calls.filter((x) => x.url.endsWith('/close'))).toHaveLength(0)
  })

  it('a voice.state ended from the relay (cap reached) ends it', async () => {
    const { c, client } = await live()
    client.emit('voice.state', { voice_session_id: SESSION, state: 'ended' })
    await tick()
    expect(c.store.getState().phase).toBe('idle')
  })

  it('can start again after ending', async () => {
    const { c, client, peer } = await live()
    await c.end()
    const again = c.start(client, THREAD)
    await tick()
    peer.dc.emit({ type: 'session.started' })
    await again
    expect(c.store.getState().phase).toBe('live')
  })
})

describe('hand-off', () => {
  it('signs the exact question the owner said and shows it on the chip, then flips on the reply', async () => {
    const { c, client, peer } = await live()
    peer.dc.emit({ type: 'session.input_transcript.delta', delta: 'What is on ' })
    peer.dc.emit({ type: 'session.input_transcript.delta', delta: 'my plate today?' })
    peer.dc.emit({ type: 'session.output_transcript.delta', delta: 'On it.' })
    peer.dc.emit({ type: 'session.delegation.created', delegation: { id: 'dlg_1', target: 'client' } })
    // The fake client signs with WebCrypto (real async work): wait for the frame, not for a fixed delay.
    const ask = await vi.waitFor(() => {
      const a = client.sent.find((f) => f.type === 'voice.ask')
      expect(a).toBeDefined()
      return a
    })
    expect(ask).toMatchObject({
      voice_session_id: SESSION,
      delegation_id: 'dlg_1',
      thread_id: THREAD,
      question: 'What is on my plate today?',
      transcript_tail: [
        { who: 'owner', text: 'What is on my plate today?' },
        { who: 'agent', text: 'On it.' },
      ],
    })
    expect(c.store.getState().handoffs[0]).toMatchObject({ question: 'What is on my plate today?' })
    // the fake client echoes a reply for the delegation
    await vi.waitFor(() =>
      expect(c.store.getState().handoffs[0]).toMatchObject({
        state: 'done',
        answer: 'echo: What is on my plate today?',
      }),
    )
  })

  it('the second hand-off carries only what was said after the first', async () => {
    const { client, peer, advance } = await live()
    peer.dc.emit({ type: 'session.input_transcript.delta', delta: 'First thing' })
    peer.dc.emit({ type: 'session.delegation.created', delegation: { id: 'dlg_1', target: 'client' } })
    await tick()
    advance(5_000)
    peer.dc.emit({ type: 'session.output_transcript.delta', delta: 'Working' })
    advance(5_000)
    peer.dc.emit({ type: 'session.input_transcript.delta', delta: 'Second thing' })
    peer.dc.emit({ type: 'session.delegation.created', delegation: { id: 'dlg_2', target: 'client' } })
    await vi.waitFor(() => expect(client.sent.filter((f) => f.type === 'voice.ask')).toHaveLength(2))
    const asks = client.sent.filter((f) => f.type === 'voice.ask')
    expect(asks.map((a) => a.question)).toEqual(['First thing', 'Second thing'])
  })

  it('does not ask when the owner said nothing, and ignores a repeated delegation id', async () => {
    const { client, peer } = await live()
    peer.dc.emit({ type: 'session.delegation.created', delegation: { id: 'dlg_x', target: 'client' } })
    await tick()
    expect(client.sent.filter((f) => f.type === 'voice.ask')).toHaveLength(0)
    peer.dc.emit({ type: 'session.input_transcript.delta', delta: 'Hello there' })
    peer.dc.emit({ type: 'session.delegation.created', delegation: { id: 'dlg_y', target: 'client' } })
    peer.dc.emit({ type: 'session.delegation.created', delegation: { id: 'dlg_y', target: 'client' } })
    await vi.waitFor(() => expect(client.sent.filter((f) => f.type === 'voice.ask')).toHaveLength(1))
    await tick()
    expect(client.sent.filter((f) => f.type === 'voice.ask')).toHaveLength(1)
  })

  it('marks the chip failed when the signed frame cannot be sent', async () => {
    const { c, client, peer } = await live()
    client.sendVoiceAsk = async () => {
      throw new Error('no key')
    }
    peer.dc.emit({ type: 'session.input_transcript.delta', delta: 'Do a thing' })
    peer.dc.emit({ type: 'session.delegation.created', delegation: { id: 'dlg_z', target: 'client' } })
    await tick()
    expect(c.store.getState().handoffs[0]?.state).toBe('failed')
  })

  it('ignores garbage on the data channel', async () => {
    const { c, peer } = await live()
    for (const l of [null]) void l
    ;(peer.dc as unknown as { emit(e: unknown): void }).emit({ type: 42 })
    expect(c.store.getState().phase).toBe('live')
  })
})
