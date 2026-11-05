// @vitest-environment jsdom
// Audit D37: the lock screen and Control Center inside the iPhone app. The shell's TalosAudio plugin is a recorder here, the
// dock and the Capacitor platform adapter are the real ones, and jsdom's missing media is driven by hand (as in
// audio-dock.test.tsx). What this cannot show is what iOS draws: that is the phone check in the PR.
import { newId } from '@talos-app/protocol'
import { act } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { __resetDockForTests, audioDock, dockElement, SAVE_EVERY_MS } from '../../src/features/threads/audioDock.ts'
import { COMMAND_DEDUPE_MS, createCapacitorPlatform } from '../../src/lib/capacitorPlatform.ts'
import { getPlatform, setPlatform, webPlatform } from '../../src/lib/platform.ts'

type Call = { method: string; options: Record<string, unknown> | undefined }

function shell() {
  const calls: Call[] = []
  const modes: string[] = []
  let command: ((d: unknown) => void) | null = null
  const plugin = {
    setMode: async (o?: { mode?: string }) => void modes.push(String(o?.mode)),
    setNowPlaying: async (o?: Record<string, unknown>) => void calls.push({ method: 'setNowPlaying', options: o }),
    updateNowPlaying: async (o?: Record<string, unknown>) =>
      void calls.push({ method: 'updateNowPlaying', options: o }),
    clearNowPlaying: async () => void calls.push({ method: 'clearNowPlaying', options: undefined }),
    addListener: async (_e: string, cb: (d: unknown) => void) => {
      command = cb
      return { remove: async () => {} }
    },
  }
  const scope = {
    Capacitor: { isNativePlatform: () => true, getPlatform: () => 'ios', Plugins: { TalosAudio: plugin } },
  }
  return {
    scope,
    calls,
    modes,
    last: (m: string) => [...calls].reverse().find((c) => c.method === m)?.options,
    count: (m: string) => calls.filter((c) => c.method === m).length,
    /** The system pressed a lock-screen control. */
    press: (d: unknown) => act(() => void command?.(d)),
    hasListener: () => command !== null,
  }
}

/** The page's own navigator.mediaSession, recorded: WebKit may or may not publish it inside the shell (#124). */
function webSession() {
  const handlers = new Map<string, ((d?: { seekTime?: number }) => void) | null>()
  const ms = {
    metadata: null as unknown,
    playbackState: 'none',
    setActionHandler: (a: string, fn: ((d?: { seekTime?: number }) => void) | null) => void handlers.set(a, fn),
    setPositionState: vi.fn(),
  }
  Object.defineProperty(navigator, 'mediaSession', { configurable: true, value: ms })
  vi.stubGlobal(
    'MediaMetadata',
    class {
      constructor(public init: unknown) {}
    },
  )
  return { ms, handlers }
}

const att = () => ({
  key: newId('m'),
  mediaId: newId('md'),
  title: 'Weekly report',
  threadId: 'general',
  durationMs: 120_000,
})

function media(duration: number, at = 0) {
  const a = dockElement()
  const clock = { t: at }
  Object.defineProperty(a, 'duration', { configurable: true, get: () => duration })
  Object.defineProperty(a, 'readyState', { configurable: true, get: () => 4 })
  Object.defineProperty(a, 'currentTime', {
    configurable: true,
    get: () => clock.t,
    set: (v: number) => {
      clock.t = v
    },
  })
  return {
    a,
    meta: () => act(() => void a.dispatchEvent(new Event('loadedmetadata'))),
    at: (v: number) => {
      clock.t = v
      act(() => void a.dispatchEvent(new Event('timeupdate')))
    },
  }
}

beforeEach(() => {
  localStorage.clear()
  __resetDockForTests()
  vi.spyOn(HTMLMediaElement.prototype, 'play').mockImplementation(function (this: HTMLMediaElement) {
    this.dispatchEvent(new Event('play'))
    return Promise.resolve()
  })
  vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(function (this: HTMLMediaElement) {
    this.dispatchEvent(new Event('pause'))
  })
  vi.spyOn(HTMLMediaElement.prototype, 'load').mockImplementation(() => {})
})
afterEach(() => {
  vi.useRealTimers()
  __resetDockForTests()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  Reflect.deleteProperty(navigator, 'mediaSession')
  setPlatform(webPlatform)
  localStorage.clear()
})

function playClip() {
  const s = shell()
  setPlatform(createCapacitorPlatform(s.scope))
  const it = att()
  const m = media(120, 0)
  audioDock.open(it, `/media/${it.mediaId}?c=2`, [], { play: true })
  m.meta()
  return { s, m, it }
}

describe('D37: the dock writes the native Now Playing info', () => {
  it('playing a clip sets title, then duration, position and rate, and asks for the transport commands', () => {
    const { s } = playClip()
    expect(s.last('setNowPlaying')).toMatchObject({ title: 'Weekly report', artist: 'Talos' })
    expect(s.last('setNowPlaying')?.actions).toEqual(
      expect.arrayContaining(['play', 'pause', 'seekbackward', 'seekforward', 'seekto']),
    )
    expect(s.last('updateNowPlaying')).toEqual({ duration: 120, position: 0, rate: 1 })
  })

  it('a seek, a pause and a speed change each move the lock screen', () => {
    const { s } = playClip()
    audioDock.seek(40)
    expect(s.last('updateNowPlaying')).toMatchObject({ position: 40, rate: 1 })
    audioDock.pause()
    expect(s.last('updateNowPlaying')).toMatchObject({ rate: 0 })
    audioDock.resume()
    expect(s.last('updateNowPlaying')).toMatchObject({ rate: 1 })
    audioDock.setSpeed(1.5)
    expect(s.last('updateNowPlaying')).toMatchObject({ rate: 1.5 })
  })

  it('the 5 s save tick sends the position, and nothing between ticks does', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-11-01T10:00:00Z'))
    const { s, m } = playClip()
    const before = s.count('updateNowPlaying')
    m.at(3)
    expect(s.count('updateNowPlaying')).toBe(before)
    vi.setSystemTime(Date.now() + SAVE_EVERY_MS + 1)
    m.at(9)
    expect(s.count('updateNowPlaying')).toBe(before + 1)
    expect(s.last('updateNowPlaying')).toMatchObject({ position: 9, rate: 1 })
  })

  it('stop() clears the native info, and a late tick or command cannot bring it back', () => {
    const { s, m } = playClip()
    audioDock.stop()
    expect(s.count('clearNowPlaying')).toBe(1)
    const updates = s.count('updateNowPlaying')
    const sets = s.count('setNowPlaying')
    m.at(50)
    audioDock.seek(10)
    audioDock.setSpeed(2)
    expect(s.count('updateNowPlaying')).toBe(updates)
    expect(s.count('setNowPlaying')).toBe(sets)
    // the system sends play after we cleared (its queue was a step behind): nothing resumes
    s.press({ action: 'play' })
    expect(audioDock.state().playing).toBe(false)
  })
})

describe('D37: lock-screen commands reach the dock', () => {
  it('pause, play, skip and scrub from the lock screen drive the dock', () => {
    const { s, m } = playClip()
    m.at(30)
    s.press({ action: 'pause' })
    expect(audioDock.state().playing).toBe(false)
    s.press({ action: 'play' })
    expect(audioDock.state().playing).toBe(true)
    s.press({ action: 'seekforward' })
    expect(audioDock.state().cur).toBe(40)
    s.press({ action: 'seekbackward' })
    expect(audioDock.state().cur).toBe(30)
    s.press({ action: 'seekto', position: 75 })
    expect(audioDock.state().cur).toBe(75)
  })

  it('hostile or unknown events do nothing', () => {
    const { s, m } = playClip()
    m.at(30)
    for (const d of [
      null,
      undefined,
      {},
      { action: 5 },
      { action: '__proto__' },
      { action: 'constructor' },
      { action: 'seekto' },
      { action: 'seekto', position: Number.NaN },
      { action: 'seekto', position: -3 },
      { action: 'seekto', position: '9' },
    ])
      s.press(d)
    expect(audioDock.state().cur).toBe(30)
    expect(audioDock.state().playing).toBe(true)
  })

  it('a tap that arrives from WebKit and from the plugin runs once, two real taps run twice', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-11-01T10:00:00Z'))
    const web = webSession()
    const { s, m } = playClip()
    m.at(30)
    web.handlers.get('seekforward')?.() // WebKit's own session
    s.press({ action: 'seekforward' }) // and the plugin, same tap
    expect(audioDock.state().cur).toBe(40)
    vi.setSystemTime(Date.now() + COMMAND_DEDUPE_MS + 10)
    s.press({ action: 'seekforward' }) // a second, later tap
    expect(audioDock.state().cur).toBe(50)
  })

  it('the page session still gets its metadata, handlers and position state', () => {
    const web = webSession()
    const { m } = playClip()
    m.at(10)
    expect(web.ms.metadata).toBeTruthy()
    expect(web.handlers.get('pause')).toBeTypeOf('function')
    expect(web.ms.setPositionState).toHaveBeenCalledWith({ duration: 120, position: 0, playbackRate: 1 })
    expect(web.ms.playbackState).toBe('playing')
    audioDock.stop()
    expect(web.ms.metadata).toBeNull()
    expect(web.handlers.get('pause')).toBeNull()
  })
})

describe('D37: Drive and the dock share one lock screen', () => {
  it("Drive's handlers work, and its clear() leaves nothing of Drive on the lock screen", () => {
    const s = shell()
    const p = createCapacitorPlatform(s.scope)
    setPlatform(p)
    const queue = { play: vi.fn(), pause: vi.fn(), skip: vi.fn(), back: vi.fn() }
    p.mediaSession.set(
      { title: 'Talos is talking', artist: 'Talos' },
      { play: queue.play, pause: queue.pause, nexttrack: queue.skip, seekbackward: () => queue.back() },
    )
    expect(s.last('setNowPlaying')?.actions).toEqual(['play', 'pause', 'nexttrack', 'seekbackward'])
    s.press({ action: 'nexttrack' })
    s.press({ action: 'pause' })
    expect(queue.skip).toHaveBeenCalledTimes(1)
    expect(queue.pause).toHaveBeenCalledTimes(1)
    p.mediaSession.clear()
    expect(s.count('clearNowPlaying')).toBe(1)
    s.press({ action: 'play' })
    expect(queue.play).not.toHaveBeenCalled()
  })

  it("after Drive closes, a dock clip that is still loaded gets its own lock screen back, not Drive's", () => {
    const { s, it } = playClip()
    audioDock.pause()
    const p = createCapacitorPlatform(s.scope)
    setPlatform(p)
    p.mediaSession.set({ title: 'Talos is talking', artist: 'Talos' }, { play: () => {}, nexttrack: () => {} })
    p.mediaSession.clear()
    audioDock.reclaimSession()
    expect(s.last('setNowPlaying')).toMatchObject({ title: it.title })
    // and the dock's handlers, not Drive's, answer
    s.press({ action: 'play' })
    expect(audioDock.state().playing).toBe(true)
    expect(s.last('updateNowPlaying')).toMatchObject({ rate: 1 })
  })
})

describe('D37: a paused clip keeps its place on the lock screen', () => {
  it('pausing holds the session (paused), playing takes the route again, stop() gives it back', () => {
    const { s } = playClip()
    expect(s.modes.at(-1)).toBe('playback')
    audioDock.pause()
    // a pause is not an idle: 'idle' would let a mixing session drop Talos as the Now Playing app
    expect(s.modes.at(-1)).toBe('paused')
    expect(s.modes).not.toContain('idle')
    s.press({ action: 'play' })
    expect(s.modes.at(-1)).toBe('playback')
    s.press({ action: 'pause' })
    expect(s.modes.at(-1)).toBe('paused')
    audioDock.stop()
    expect(s.modes.at(-1)).toBe('idle')
  })

  it('a pause that arrives only as the element event (no call to pause()) is held the same way', () => {
    const { s, m } = playClip()
    act(() => void m.a.dispatchEvent(new Event('pause')))
    expect(s.modes.at(-1)).toBe('paused')
  })
})

describe('D37: a clip that fails does not leave the lock screen playing', () => {
  it('a load error stops the clock', () => {
    const { s, m } = playClip()
    expect(s.last('updateNowPlaying')).toMatchObject({ rate: 1 })
    act(() => void m.a.dispatchEvent(new Event('error')))
    expect(s.last('updateNowPlaying')).toMatchObject({ rate: 0 })
  })

  it('a play() the browser refuses stops the clock', async () => {
    const s = shell()
    setPlatform(createCapacitorPlatform(s.scope))
    vi.spyOn(HTMLMediaElement.prototype, 'play').mockImplementation(() => Promise.reject(new Error('NotAllowed')))
    const it = att()
    media(120, 0)
    audioDock.open(it, `/media/${it.mediaId}?c=2`, [], { play: true })
    await act(async () => {
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(s.last('updateNowPlaying')).toMatchObject({ rate: 0 })
  })

  it('a play() that throws stops the clock', () => {
    const s = shell()
    setPlatform(createCapacitorPlatform(s.scope))
    vi.spyOn(HTMLMediaElement.prototype, 'play').mockImplementation(() => {
      throw new Error('boom')
    })
    const it = att()
    media(120, 0)
    audioDock.open(it, `/media/${it.mediaId}?c=2`, [], { play: true })
    expect(s.last('updateNowPlaying')).toMatchObject({ rate: 0 })
  })
})

describe("D37: Drive does not inherit the dock's scrubber", () => {
  it('Drive started while a report is paused at 5:00 of 12:00 shows its own title, from the start, moving', () => {
    const { s, m } = playClip()
    m.at(300)
    audioDock.pause() // last = { duration: 120, position: 300, rate: 0 }
    const p = getPlatform()
    p.mediaSession.set({ title: 'Talos is talking', artist: 'Talos' }, { play: () => {}, pause: () => {} })
    const np = s.last('setNowPlaying')
    expect(np).toMatchObject({ title: 'Talos is talking', position: 0, rate: 1 })
    expect(np).not.toHaveProperty('duration')
  })

  it('the same clip re-set on every play keeps its place', () => {
    const { s, m } = playClip()
    m.at(60)
    audioDock.pause()
    s.press({ action: 'play' })
    expect(s.last('setNowPlaying')).toMatchObject({ title: 'Weekly report', position: 60 })
  })
})

describe('D37: older or missing shells', () => {
  it('never throws when the plugin lacks the new methods or the event', () => {
    setPlatform(createCapacitorPlatform({ Capacitor: { Plugins: { TalosAudio: { setMode: async () => {} } } } }))
    const it = att()
    media(120, 0)
    expect(() => audioDock.open(it, '/media/x?c=2', [], { play: true })).not.toThrow()
    expect(() => audioDock.seek(5)).not.toThrow()
    expect(() => audioDock.stop()).not.toThrow()
    setPlatform(createCapacitorPlatform({ Capacitor: { Plugins: {} } }))
    expect(() => audioDock.open(it, '/media/x?c=2', [], { play: true })).not.toThrow()
  })

  it('listens for commands once, however many clips play', () => {
    const s = shell()
    let adds = 0
    const plugins = s.scope.Capacitor.Plugins.TalosAudio
    const inner = plugins.addListener
    plugins.addListener = async (e: string, cb: (d: unknown) => void) => {
      adds++
      return inner(e, cb)
    }
    setPlatform(createCapacitorPlatform(s.scope))
    for (let i = 0; i < 3; i++) {
      const it = att()
      media(120, 0)
      audioDock.open(it, `/media/${it.mediaId}?c=2`, [], { play: true })
    }
    expect(adds).toBe(1)
  })
})
