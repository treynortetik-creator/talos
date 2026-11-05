// A failed call shows one plain line that goes away; leaving the app while a call connects is not a failure at all.
// Everything here runs through the real CallController with scripted peers and a fake clock.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CallController } from '../../src/features/voice/callController.ts'
import { createFakeClient } from '../../src/lib/fakeClient.ts'
import { expectNothingLeftOpen, FakePeer, fakeDeps } from './fakes.ts'

const THREAD = 'general'

beforeEach(() => {
  localStorage.clear()
  vi.useFakeTimers()
})
afterEach(() => {
  vi.useRealTimers()
  localStorage.clear()
})

/** Fake-clock timers: the controller's own deps.setTimeout runs on vitest's clock. */
const clock = {
  setTimeout: (fn: () => void, ms: number) => globalThis.setTimeout(fn, ms),
  clearTimeout: (h: unknown) => globalThis.clearTimeout(h as number),
}
const settle = () => vi.advanceTimersByTimeAsync(20)

const CLOSE = '/api/voice/session/v_01JBF3V7Q8K2M4N6P8R0S2T426/close'
const CLIENT = () => createFakeClient()
/** A promise the test settles by hand: a microphone request or a relay answer that stays pending. */
function gate<T>() {
  let resolve!: (v: T) => void
  let reject!: (e: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

describe('leaving the app while a call connects', () => {
  it('hidden when the microphone arrives: the stream is stopped, no session is opened, no error', async () => {
    const f = fakeDeps(clock)
    const g = gate<MediaStream>()
    const m = f.mint()
    const c = new CallController({ ...f.deps, getUserMedia: () => g.promise })
    const done = c.start(CLIENT(), THREAD)
    f.hide() // the page goes away while the permission request is up
    expect(c.store.getState().phase).toBe('connecting') // nothing is open yet, so nothing to end
    g.resolve(m.stream)
    await settle()
    await done
    expect(c.store.getState()).toMatchObject({ phase: 'idle', error: null })
    expect(f.calls).toEqual([]) // no relay session was opened for a call nobody is attending
    expect(m.track.stopped).toBe(true)
    expectNothingLeftOpen(f)
  })

  it('the permission sheet hiding the page for a moment does not end the call', async () => {
    // Unknown on a real iPhone whether the sheet flips visibilityState. If it does and the page is back by the time
    // the owner answers, the call carries on; it is only dropped if the page is still hidden when the stream arrives.
    const f = fakeDeps(clock)
    const g = gate<MediaStream>()
    const m = f.mint()
    const c = new CallController({ ...f.deps, getUserMedia: () => g.promise })
    const done = c.start(CLIENT(), THREAD)
    f.hide()
    f.show()
    g.resolve(m.stream)
    await settle()
    expect(f.openSessions()).toBe(1)
    f.peer.dc.emit({ type: 'session.started' })
    await done
    expect(c.store.getState()).toMatchObject({ phase: 'live', error: null })
    expect(m.track.stopped).toBe(false)
    await c.end()
    expectNothingLeftOpen(f)
  })

  it('a real microphone refusal while the page is hidden is still shown, and fades only once he can see it', async () => {
    const f = fakeDeps({
      ...clock,
      getUserMedia: async () => {
        f.hide()
        throw Object.assign(new Error('x'), { name: 'NotAllowedError' })
      },
    })
    const c = new CallController(f.deps)
    await c.start(CLIENT(), THREAD)
    expect(c.store.getState().error).toBe('Allow the microphone to start a call.')
    await vi.advanceTimersByTimeAsync(60_000) // a minute hidden: the 10 s clock has not started
    expect(c.store.getState().error).toBe('Allow the microphone to start a call.')
    f.show()
    await vi.advanceTimersByTimeAsync(9_000)
    expect(c.store.getState().error).toBe('Allow the microphone to start a call.')
    await vi.advanceTimersByTimeAsync(2_000)
    expect(c.store.getState().error).toBeNull()
  })

  it('an error fade stops while the page is hidden again and resumes, in full, when it is shown', async () => {
    const f = fakeDeps({ ...clock, fetchResponses: [new Response('{}', { status: 503 })] })
    const c = new CallController(f.deps)
    await c.start(CLIENT(), THREAD)
    await vi.advanceTimersByTimeAsync(8_000)
    f.hide()
    await vi.advanceTimersByTimeAsync(30_000)
    expect(c.store.getState().error).not.toBeNull()
    f.show()
    await vi.advanceTimersByTimeAsync(9_000)
    expect(c.store.getState().error).not.toBeNull()
    await vi.advanceTimersByTimeAsync(2_000)
    expect(c.store.getState().error).toBeNull()
  })

  it('a mic request cut off by the page going away (AbortError, hidden) is quiet', async () => {
    const f = fakeDeps({
      ...clock,
      getUserMedia: async () => {
        f.hide()
        throw Object.assign(new Error('interrupted'), { name: 'AbortError' })
      },
    })
    const c = new CallController(f.deps)
    await c.start(CLIENT(), THREAD)
    expect(c.store.getState()).toMatchObject({ phase: 'idle', error: null })
  })

  it('hidden after the relay session exists: no error, relay told with keepalive, every track stopped', async () => {
    const f = fakeDeps(clock)
    const c = new CallController(f.deps)
    const done = c.start(CLIENT(), THREAD)
    await settle()
    expect(c.store.getState().phase).toBe('connecting')
    f.hide()
    await settle()
    await done
    expect(c.store.getState()).toMatchObject({ phase: 'idle', error: null })
    expect(f.calls.map((x) => x.url)).toEqual(['/api/voice/session', CLOSE])
    // pagehide can be the last thing the page does: the close must be allowed to outlive it
    expect(f.calls[1]?.init).toMatchObject({ keepalive: true })
    expect(f.track.stopped).toBe(true)
    expectNothingLeftOpen(f)
  })

  it('hidden while the connection is still gathering ICE: the microphone is released at once, not after 10 s', async () => {
    const f = fakeDeps(clock)
    f.peer.iceGatheringState = 'gathering'
    const c = new CallController(f.deps)
    const done = c.start(CLIENT(), THREAD)
    await vi.advanceTimersByTimeAsync(100)
    expect(f.track.stopped).toBe(false)
    f.hide()
    expect(f.track.stopped).toBe(true) // synchronous with the event
    await vi.advanceTimersByTimeAsync(11_000)
    await done
    expect(f.openSessions()).toBe(0) // the ended call never reaches the relay
    expect(c.store.getState()).toMatchObject({ phase: 'idle', error: null })
    expectNothingLeftOpen(f)
  })

  it('a relay refusal that lands after the page was hidden is still shown, and fades once he is back', async () => {
    const post = gate<Response>()
    const f = fakeDeps(clock)
    const c = new CallController({
      ...f.deps,
      fetch: ((url: string, init: RequestInit) =>
        url.endsWith('/close') ? f.deps.fetch(url, init) : post.promise) as typeof fetch,
    })
    const done = c.start(CLIENT(), THREAD)
    await settle()
    f.hide()
    post.resolve(new Response('{}', { status: 503 }))
    await settle()
    await done
    expect(c.store.getState()).toMatchObject({ phase: 'idle', error: "Live voice isn't set up on this relay." })
    await vi.advanceTimersByTimeAsync(30_000)
    expect(c.store.getState().error).not.toBeNull()
    f.show()
    await vi.advanceTimersByTimeAsync(11_000)
    expect(c.store.getState().error).toBeNull()
    expectNothingLeftOpen(f)
  })

  it('hidden during the POST, then the relay opens the session anyway: it is closed', async () => {
    const post = gate<Response>()
    const f = fakeDeps(clock)
    const c = new CallController({
      ...f.deps,
      fetch: ((url: string, init: RequestInit) => {
        if (url.endsWith('/close')) return f.deps.fetch(url, init)
        return post.promise
      }) as typeof fetch,
    })
    const done = c.start(CLIENT(), THREAD)
    await settle()
    f.hide()
    post.resolve(
      Response.json({ voice_session_id: 'v_01JBF3V7Q8K2M4N6P8R0S2T426', sdp_answer: 'v=0\r\n', max_minutes: 30 }),
    )
    await settle()
    await done
    expect(f.calls.map((x) => x.url)).toEqual([CLOSE])
    expect(f.calls[0]?.init).toMatchObject({ keepalive: true })
    expect(c.store.getState()).toMatchObject({ phase: 'idle', error: null, voiceSessionId: null })
    expectNothingLeftOpen(f)
  })

  it('a hidden app does not leave a stale error from an earlier failed call', async () => {
    const f = fakeDeps({ ...clock, fetchResponses: [new Response('{}', { status: 503 })] })
    const c = new CallController(f.deps)
    await c.start(CLIENT(), THREAD)
    expect(c.store.getState().error).toMatch(/isn't set up/)
    const next = c.start(CLIENT(), THREAD)
    expect(c.store.getState().error).toBeNull()
    f.hide()
    await settle()
    await next
    expect(c.store.getState().error).toBeNull()
    expectNothingLeftOpen(f)
  })
})

describe('a start that was overtaken', () => {
  it('End while the microphone request is pending: the stream that arrives is stopped, nothing opens, UI stays idle', async () => {
    const f = fakeDeps(clock)
    const g = gate<MediaStream>()
    const m = f.mint()
    const c = new CallController({ ...f.deps, getUserMedia: () => g.promise })
    const done = c.start(CLIENT(), THREAD)
    await c.end()
    expect(c.store.getState().phase).toBe('idle')
    g.resolve(m.stream)
    await settle()
    await done
    expect(m.track.stopped).toBe(true)
    expect(f.calls).toEqual([]) // no POST for a call that was hung up
    expect(f.peers).toEqual([])
    expect(c.store.getState()).toMatchObject({ phase: 'idle', error: null })
    f.peer.dc.emit({ type: 'session.started' }) // nothing is listening: a dead call cannot come back
    await settle()
    expect(c.store.getState().phase).toBe('idle')
    expectNothingLeftOpen(f)
  })

  it('End, then Start again while the first microphone request is still pending: the first stream is stopped, the second call lives', async () => {
    const f = fakeDeps(clock)
    const first = gate<MediaStream>()
    const second = gate<MediaStream>()
    const a = f.mint()
    const b = f.mint()
    const queue = [first, second]
    const c = new CallController({ ...f.deps, getUserMedia: () => (queue.shift() as typeof first).promise })
    const one = c.start(CLIENT(), THREAD)
    await c.end()
    const two = c.start(CLIENT(), THREAD)
    first.resolve(a.stream)
    second.resolve(b.stream)
    await settle()
    expect(a.track.stopped).toBe(true) // the hung-up call's microphone does not stay open
    expect(b.track.stopped).toBe(false)
    expect(f.openSessions()).toBe(1) // one POST, for the call that is current
    f.peer.dc.emit({ type: 'session.started' })
    await Promise.all([one, two])
    expect(c.store.getState().phase).toBe('live')
    await c.end()
    expect(b.track.stopped).toBe(true)
    expectNothingLeftOpen(f)
  })

  it('End during the POST, relay answers 200: the session is closed, the mic stops, it does not go live', async () => {
    const post = gate<Response>()
    const f = fakeDeps(clock)
    const c = new CallController({
      ...f.deps,
      fetch: ((url: string, init: RequestInit) => {
        if (url.endsWith('/close')) return f.deps.fetch(url, init)
        return post.promise
      }) as typeof fetch,
    })
    const done = c.start(CLIENT(), THREAD)
    await settle()
    await c.end()
    expect(f.track.stopped).toBe(true) // released before the relay even answers
    post.resolve(
      Response.json({ voice_session_id: 'v_01JBF3V7Q8K2M4N6P8R0S2T426', sdp_answer: 'v=0\r\n', max_minutes: 30 }),
    )
    await settle()
    await done
    f.peer.dc.emit({ type: 'session.started' })
    await settle()
    expect(c.store.getState()).toMatchObject({ phase: 'idle', error: null, voiceSessionId: null })
    const closes = f.calls.filter((x) => x.url === CLOSE)
    expect(closes).toHaveLength(1)
    expect(closes[0]?.init).toMatchObject({ keepalive: true })
    expectNothingLeftOpen(f)
  })

  it('End once the session exists closes it exactly once, not once per path', async () => {
    const f = fakeDeps(clock)
    const c = new CallController(f.deps)
    const done = c.start(CLIENT(), THREAD)
    await settle()
    await c.end()
    await settle()
    await done
    expect(f.calls.filter((x) => x.url === CLOSE)).toHaveLength(1)
    expectNothingLeftOpen(f)
  })

  it('End while the wake lock is being taken: the lock is released, the call never goes live, presence never starts', async () => {
    const lock = gate<() => void>()
    const f = fakeDeps(clock)
    let released = 0
    const c = new CallController({ ...f.deps, media: { ...f.deps.media, keepAwake: () => lock.promise } })
    const presence = vi.fn()
    const client = Object.assign(createFakeClient(), { reportPresence: presence })
    const done = c.start(client, THREAD)
    await settle()
    f.peer.dc.emit({ type: 'session.started' })
    await settle()
    expect(c.store.getState().phase).toBe('connecting')
    await c.end()
    lock.resolve(() => void released++)
    await settle()
    await done
    expect(released).toBe(1)
    expect(c.store.getState().phase).toBe('idle')
    await vi.advanceTimersByTimeAsync(60_000)
    expect(presence).not.toHaveBeenCalled()
    expectNothingLeftOpen(f)
  })

  it('End with a slow relay close: the microphone is already stopped, and a start still in flight never shows live', async () => {
    const lock = gate<() => void>()
    const closeAnswer = gate<Response>()
    const f = fakeDeps(clock)
    const c = new CallController({
      ...f.deps,
      media: { ...f.deps.media, keepAwake: () => lock.promise },
      fetch: ((url: string, init: RequestInit) =>
        url.endsWith('/close') ? closeAnswer.promise : f.deps.fetch(url, init)) as typeof fetch,
    })
    const phases: string[] = []
    c.store.subscribe((st) => phases.push(st.phase))
    const done = c.start(CLIENT(), THREAD)
    await settle()
    f.peer.dc.emit({ type: 'session.started' })
    await settle()
    const ending = c.end() // the close request is now pending
    await settle()
    expect(f.track.stopped).toBe(true) // not held open while the relay thinks about it
    lock.resolve(() => void 0) // the wake lock lands inside that window
    await settle()
    closeAnswer.resolve(new Response(null, { status: 204 }))
    await ending
    await done
    expect(phases).not.toContain('live')
    expect(c.store.getState().phase).toBe('idle')
    expectNothingLeftOpen(f)
  })

  it('hidden while the wake lock is being taken ends the call too', async () => {
    const lock = gate<() => void>()
    const f = fakeDeps(clock)
    let released = 0
    const c = new CallController({ ...f.deps, media: { ...f.deps.media, keepAwake: () => lock.promise } })
    const done = c.start(CLIENT(), THREAD)
    await settle()
    f.peer.dc.emit({ type: 'session.started' })
    await settle()
    f.hide()
    lock.resolve(() => void released++)
    await settle()
    await done
    expect(released).toBe(1)
    expect(c.store.getState()).toMatchObject({ phase: 'idle', error: null })
    expectNothingLeftOpen(f)
  })

  it('two taps on Start at once open one microphone and one session', async () => {
    const f = fakeDeps(clock)
    const c = new CallController(f.deps)
    const a = c.start(CLIENT(), THREAD)
    const b = c.start(CLIENT(), THREAD)
    await settle()
    f.peer.dc.emit({ type: 'session.started' })
    await Promise.all([a, b])
    expect(f.tracks).toHaveLength(1)
    expect(f.openSessions()).toBe(1)
    await c.end()
    expectNothingLeftOpen(f)
  })

  it("an ended call's data channel closing late does not end the call that replaced it", async () => {
    const f = fakeDeps(clock)
    const c = new CallController(f.deps)
    const one = c.start(CLIENT(), THREAD)
    await settle()
    f.peer.dc.emit({ type: 'session.started' })
    await one
    const oldChannel = f.peer.dc
    await c.end()
    const two = c.start(CLIENT(), THREAD)
    await settle()
    f.peer.dc.emit({ type: 'session.started' })
    await two
    expect(c.store.getState().phase).toBe('live')
    oldChannel.drop() // a real channel fires 'close' some time after close()
    oldChannel.emit({ type: 'session.closed' })
    await settle()
    expect(c.store.getState().phase).toBe('live')
    await c.end()
    expectNothingLeftOpen(f)
  })
})

describe('the relay and the peer', () => {
  it('a POST that never answers ends with a visible error, a stopped microphone and a free button', async () => {
    const f = fakeDeps(clock)
    f.stallPost()
    const c = new CallController(f.deps)
    const done = c.start(CLIENT(), THREAD)
    await vi.advanceTimersByTimeAsync(29_000)
    expect(c.store.getState().phase).toBe('connecting')
    await vi.advanceTimersByTimeAsync(2_000)
    await done
    expect(c.store.getState()).toMatchObject({ phase: 'idle', error: 'The relay took too long. Try again.' })
    expectNothingLeftOpen(f)
  })

  it('a reply the app cannot read still closes the session it names, and says the call failed', async () => {
    const f = fakeDeps({
      ...clock,
      fetchResponses: [Response.json({ voice_session_id: 'v_01JBF3V7Q8K2M4N6P8R0S2T426', max_minutes: 'many' })],
    })
    const c = new CallController(f.deps)
    await c.start(CLIENT(), THREAD)
    expect(c.store.getState()).toMatchObject({ phase: 'idle', error: "Couldn't start the call. Try again." })
    expect(f.calls.map((x) => x.url)).toEqual(['/api/voice/session', CLOSE])
    expectNothingLeftOpen(f)
  })

  it('a reply that is not JSON at all fails visibly', async () => {
    const f = fakeDeps({ ...clock, fetchResponses: [new Response('<html>', { status: 200 })] })
    const c = new CallController(f.deps)
    await c.start(CLIENT(), THREAD)
    expect(c.store.getState()).toMatchObject({ phase: 'idle', error: "Couldn't start the call. Try again." })
    expectNothingLeftOpen(f)
  })

  it('setRemoteDescription rejecting leaves no 15 s timer running', async () => {
    class BadAnswer extends FakePeer {
      override async setRemoteDescription(): Promise<void> {
        throw new Error('bad sdp')
      }
    }
    const f = fakeDeps({ ...clock, createPeer: () => new BadAnswer() })
    const c = new CallController(f.deps)
    await c.start(CLIENT(), THREAD)
    expect(c.store.getState().error).toBe("Couldn't start the call. Try again.")
    expect(vi.getTimerCount()).toBe(1) // only the error's own fade
  })
})

describe('every call error', () => {
  type Case = {
    name: string
    message: string
    over: () => Parameters<typeof fakeDeps>[0]
    /** The microphone was already open when it failed, so it has to be released. */
    micOpen: boolean
  }
  const cases: Case[] = [
    {
      name: 'daily cap (429 with the relay message)',
      message: "Today's live-voice limit is used up.",
      micOpen: true,
      over: () => ({
        fetchResponses: [Response.json({ message: "Today's live-voice limit is used up." }, { status: 429 })],
      }),
    },
    {
      name: 'voice not set up (503)',
      message: "Live voice isn't set up on this relay.",
      micOpen: true,
      over: () => ({ fetchResponses: [new Response('{}', { status: 503 })] }),
    },
    {
      name: 'signed out (401)',
      message: 'Sign in again to start a call.',
      micOpen: true,
      over: () => ({ fetchResponses: [new Response('{}', { status: 401 })] }),
    },
    {
      name: 'any other relay failure',
      message: "Couldn't start the call. Try again.",
      micOpen: true,
      over: () => ({ fetchResponses: [new Response('boom', { status: 500 })] }),
    },
    {
      name: 'network down',
      message: "Couldn't start the call. Try again.",
      micOpen: true,
      over: () => ({ fetchResponses: [new TypeError('Load failed')] }),
    },
    {
      name: 'microphone refused',
      message: 'Allow the microphone to start a call.',
      micOpen: false,
      over: () => ({
        getUserMedia: async () => {
          throw Object.assign(new Error('x'), { name: 'NotAllowedError' })
        },
      }),
    },
    {
      name: 'no microphone',
      message: 'No microphone found.',
      micOpen: false,
      over: () => ({
        getUserMedia: async () => {
          throw Object.assign(new Error('x'), { name: 'NotFoundError' })
        },
      }),
    },
    {
      name: 'microphone fails some other way',
      message: "Couldn't start the call. Try again.",
      micOpen: false,
      over: () => ({
        getUserMedia: async () => {
          throw new Error('weird')
        },
      }),
    },
    {
      name: 'the peer cannot be created',
      message: "Couldn't start the call. Try again.",
      micOpen: true,
      over: () => ({
        createPeer: () => {
          throw new Error('no RTCPeerConnection')
        },
      }),
    },
    {
      name: 'the offer has no SDP',
      message: 'Could not start the call.',
      micOpen: true,
      over: () => {
        class NoSdpPeer extends FakePeer {
          override async createOffer() {
            return { type: 'offer' as const, sdp: '' }
          }
          override async setLocalDescription() {
            this.localDescription = null
          }
        }
        return { createPeer: () => new NoSdpPeer() }
      },
    },
  ]

  async function failed(c: Case) {
    const f = fakeDeps({ ...clock, ...c.over() })
    const ctl = new CallController(f.deps)
    const done = ctl.start(createFakeClient(), THREAD)
    await settle()
    await done
    return { f, ctl }
  }

  it.each(cases)('$name shows its line, ends the call and frees the microphone', async (c) => {
    const { f, ctl } = await failed(c)
    expect(ctl.store.getState()).toMatchObject({ phase: 'idle', error: c.message })
    expect(f.track.stopped).toBe(c.micOpen)
    expectNothingLeftOpen(f)
  })

  it.each(cases)('$name goes away by itself after a short while', async (c) => {
    const { ctl } = await failed(c)
    expect(ctl.store.getState().error).toBe(c.message)
    await vi.advanceTimersByTimeAsync(9_000)
    expect(ctl.store.getState().error).toBe(c.message)
    await vi.advanceTimersByTimeAsync(2_000)
    expect(ctl.store.getState().error).toBeNull()
  })

  it.each(cases)('$name is cleared by dismissError()', async (c) => {
    const { ctl } = await failed(c)
    ctl.dismissError()
    expect(ctl.store.getState().error).toBeNull()
  })

  it('the call that did not connect in time shows its line and also goes away', async () => {
    const f = fakeDeps(clock)
    const ctl = new CallController(f.deps)
    const done = ctl.start(createFakeClient(), THREAD)
    await vi.advanceTimersByTimeAsync(16_000) // session.started never arrives
    await done
    expect(ctl.store.getState()).toMatchObject({ phase: 'idle', error: 'The call did not connect.' })
    expectNothingLeftOpen(f)
    await vi.advanceTimersByTimeAsync(11_000)
    expect(ctl.store.getState().error).toBeNull()
  })

  it('an old timer cannot wipe a newer error', async () => {
    const f = fakeDeps({
      ...clock,
      fetchResponses: [new Response('{}', { status: 503 }), new Response('{}', { status: 401 })],
    })
    const ctl = new CallController(f.deps)
    await ctl.start(createFakeClient(), THREAD)
    await vi.advanceTimersByTimeAsync(8_000)
    await ctl.start(createFakeClient(), THREAD) // clears the first error and its timer, then fails again
    expect(ctl.store.getState().error).toBe('Sign in again to start a call.')
    await vi.advanceTimersByTimeAsync(5_000) // the first timer would fire here
    expect(ctl.store.getState().error).toBe('Sign in again to start a call.')
    await vi.advanceTimersByTimeAsync(6_000)
    expect(ctl.store.getState().error).toBeNull()
  })

  it('starting a new call clears the old error at once', async () => {
    const f = fakeDeps({ ...clock, fetchResponses: [new Response('{}', { status: 503 })] })
    const ctl = new CallController(f.deps)
    await ctl.start(createFakeClient(), THREAD)
    expect(ctl.store.getState().error).not.toBeNull()
    const next = ctl.start(createFakeClient(), THREAD)
    expect(ctl.store.getState()).toMatchObject({ phase: 'connecting', error: null })
    await settle()
    f.peer.dc.emit({ type: 'session.started' })
    await next
    // and the old timer does not touch the live call's state
    await vi.advanceTimersByTimeAsync(15_000)
    expect(ctl.store.getState()).toMatchObject({ phase: 'live', error: null })
  })

  it('a call error that arrives after the owner hung up is not shown, and what it opened is closed', async () => {
    const post = gate<Response>()
    const f = fakeDeps(clock)
    const ctl = new CallController({
      ...f.deps,
      fetch: ((url: string, init: RequestInit) =>
        url.endsWith('/close') ? f.deps.fetch(url, init) : post.promise) as typeof fetch,
    })
    const done = ctl.start(CLIENT(), THREAD)
    await settle()
    await ctl.end()
    post.resolve(new Response('{}', { status: 503 }))
    await settle()
    await done
    expect(ctl.store.getState().error).toBeNull()
    expectNothingLeftOpen(f)
  })
})
