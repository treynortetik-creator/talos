// @vitest-environment jsdom
// Audit D37: the lock screen and Control Center inside the iPhone app. The shell's TalosAudio plugin is a recorder here, the
// dock and the Capacitor platform adapter are the real ones, and jsdom's missing media is driven by hand (as in
// audio-player.test.tsx). What this cannot show is what iOS draws: that is the phone check in the PR.
import { newId } from '@talos-app/protocol'
import { act } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  __resetAudioForTests,
  audioElement,
  audioPlayer,
  SAVE_EVERY_MS,
} from '../../src/features/threads/audioPlayer.ts'
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
  durationMs: 120_000,
})

function media(duration: number, at = 0) {
  const a = audioElement()
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
  __resetAudioForTests()
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
  __resetAudioForTests()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  Reflect.deleteProperty(navigator, 'mediaSession')
  setPlatform(webPlatform)
  localStorage.clear()
})

/** The route call is answered by the shell (a promise): play() follows it, a few microtasks later. */
const settled = () =>
  act(async () => {
    for (let i = 0; i < 6; i++) await Promise.resolve()
  })

async function playClip() {
  const s = shell()
  setPlatform(createCapacitorPlatform(s.scope))
  const it = att()
  const m = media(120, 0)
  audioPlayer.open(it, `/media/${it.mediaId}?c=2`, [], { play: true })
  await settled()
  m.meta()
  return { s, m, it }
}

describe('D37: the dock writes the native Now Playing info', () => {
  it('playing a clip sets title, then duration, position and rate, and asks for the transport commands', async () => {
    const { s } = await playClip()
    expect(s.last('setNowPlaying')).toMatchObject({ title: 'Weekly report', artist: 'Talos' })
    expect(s.last('setNowPlaying')?.actions).toEqual(
      expect.arrayContaining(['play', 'pause', 'seekbackward', 'seekforward', 'seekto']),
    )
    expect(s.last('updateNowPlaying')).toEqual({ duration: 120, position: 0, rate: 1 })
  })

  it('a seek, a pause and a speed change each move the lock screen', async () => {
    const { s } = await playClip()
    audioPlayer.seek(40)
    expect(s.last('updateNowPlaying')).toMatchObject({ position: 40, rate: 1 })
    audioPlayer.pause()
    expect(s.last('updateNowPlaying')).toMatchObject({ rate: 0 })
    audioPlayer.resume()
    await settled()
    expect(s.last('updateNowPlaying')).toMatchObject({ rate: 1 })
    audioPlayer.setSpeed(1.5)
    expect(s.last('updateNowPlaying')).toMatchObject({ rate: 1.5 })
  })

  it('the 5 s save tick sends the position, and nothing between ticks does', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-11-01T10:00:00Z'))
    const { s, m } = await playClip()
    const before = s.count('updateNowPlaying')
    m.at(3)
    expect(s.count('updateNowPlaying')).toBe(before)
    vi.setSystemTime(Date.now() + SAVE_EVERY_MS + 1)
    m.at(9)
    expect(s.count('updateNowPlaying')).toBe(before + 1)
    expect(s.last('updateNowPlaying')).toMatchObject({ position: 9, rate: 1 })
  })

  it('stop() clears the native info, and a late tick or command cannot bring it back', async () => {
    const { s, m } = await playClip()
    audioPlayer.stop()
    expect(s.count('clearNowPlaying')).toBe(1)
    const updates = s.count('updateNowPlaying')
    const sets = s.count('setNowPlaying')
    m.at(50)
    audioPlayer.seek(10)
    audioPlayer.setSpeed(2)
    expect(s.count('updateNowPlaying')).toBe(updates)
    expect(s.count('setNowPlaying')).toBe(sets)
    // the system sends play after we cleared (its queue was a step behind): nothing resumes
    s.press({ action: 'play' })
    await settled()
    expect(audioPlayer.state().playing).toBe(false)
  })
})

describe('D37: lock-screen commands reach the dock', () => {
  it('pause, play, skip and scrub from the lock screen drive the dock', async () => {
    const { s, m } = await playClip()
    m.at(30)
    s.press({ action: 'pause' })
    expect(audioPlayer.state().playing).toBe(false)
    s.press({ action: 'play' })
    await settled()
    expect(audioPlayer.state().playing).toBe(true)
    s.press({ action: 'seekforward' })
    expect(audioPlayer.state().cur).toBe(40)
    s.press({ action: 'seekbackward' })
    expect(audioPlayer.state().cur).toBe(30)
    s.press({ action: 'seekto', position: 75 })
    expect(audioPlayer.state().cur).toBe(75)
  })

  it('hostile or unknown events do nothing', async () => {
    const { s, m } = await playClip()
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
    expect(audioPlayer.state().cur).toBe(30)
    expect(audioPlayer.state().playing).toBe(true)
  })

  it('a tap that arrives from WebKit and from the plugin runs once, two real taps run twice', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-11-01T10:00:00Z'))
    const web = webSession()
    const { s, m } = await playClip()
    m.at(30)
    web.handlers.get('seekforward')?.() // WebKit's own session
    s.press({ action: 'seekforward' }) // and the plugin, same tap
    expect(audioPlayer.state().cur).toBe(40)
    vi.setSystemTime(Date.now() + COMMAND_DEDUPE_MS + 10)
    s.press({ action: 'seekforward' }) // a second, later tap
    expect(audioPlayer.state().cur).toBe(50)
  })

  it('the page session still gets its metadata, handlers and position state', async () => {
    const web = webSession()
    const { m } = await playClip()
    m.at(10)
    expect(web.ms.metadata).toBeTruthy()
    expect(web.handlers.get('pause')).toBeTypeOf('function')
    expect(web.ms.setPositionState).toHaveBeenCalledWith({ duration: 120, position: 0, playbackRate: 1 })
    expect(web.ms.playbackState).toBe('playing')
    audioPlayer.stop()
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

  it("after Drive closes, a player clip that is still loaded gets its own lock screen back, not Drive's", async () => {
    const { s, it } = await playClip()
    audioPlayer.pause()
    const p = createCapacitorPlatform(s.scope)
    setPlatform(p)
    p.mediaSession.set({ title: 'Talos is talking', artist: 'Talos' }, { play: () => {}, nexttrack: () => {} })
    p.mediaSession.clear()
    audioPlayer.reclaimSession()
    expect(s.last('setNowPlaying')).toMatchObject({ title: it.title })
    // and the player's handlers, not Drive's, answer
    s.press({ action: 'play' })
    await settled()
    expect(audioPlayer.state().playing).toBe(true)
    expect(s.last('updateNowPlaying')).toMatchObject({ rate: 1 })
  })
})

describe('D37: a paused clip keeps its place on the lock screen', () => {
  it('pausing holds the session (paused), playing takes the route again, stop() gives it back', async () => {
    const { s } = await playClip()
    expect(s.modes.at(-1)).toBe('playback')
    audioPlayer.pause()
    // a pause is not an idle: 'idle' would let a mixing session drop Talos as the Now Playing app
    expect(s.modes.at(-1)).toBe('paused')
    expect(s.modes).not.toContain('idle')
    s.press({ action: 'play' })
    await settled()
    expect(s.modes.at(-1)).toBe('playback')
    s.press({ action: 'pause' })
    expect(s.modes.at(-1)).toBe('paused')
    audioPlayer.stop()
    expect(s.modes.at(-1)).toBe('idle')
  })

  it('a pause that arrives only as the element event (the system, not a tap) sends nothing: the route is not asked for while iOS has it', async () => {
    const { s, m } = await playClip()
    const before = s.modes.length
    act(() => void m.a.dispatchEvent(new Event('pause')))
    expect(s.modes.length).toBe(before)
    expect(audioPlayer.state().playing).toBe(false)
    // the next Play takes the route again, and stop() still gives it back
    s.press({ action: 'play' })
    await settled()
    expect(s.modes.at(-1)).toBe('playback')
    act(() => void m.a.dispatchEvent(new Event('pause')))
    audioPlayer.stop()
    expect(s.modes.at(-1)).toBe('idle')
  })

  it('Play after a pause: the shell is asked first, and play() waits for its answer', async () => {
    const s = shell()
    let answer: (v?: undefined) => void = () => {}
    let held = false
    s.scope.Capacitor.Plugins.TalosAudio.setMode = (o?: { mode?: string }) => {
      s.modes.push(String(o?.mode))
      return held
        ? new Promise<undefined>((r) => {
            answer = r
          })
        : Promise.resolve(undefined)
    }
    setPlatform(createCapacitorPlatform(s.scope))
    const it = att()
    const m = media(120, 0)
    audioPlayer.open(it, `/media/${it.mediaId}?c=2`, [], { play: true })
    await settled()
    m.at(49)
    audioPlayer.pause()
    const plays = vi.mocked(HTMLMediaElement.prototype.play).mock.calls.length
    held = true
    s.press({ action: 'play' }) // the lock screen
    expect(s.modes.at(-1)).toBe('playback')
    await settled()
    expect(vi.mocked(HTMLMediaElement.prototype.play).mock.calls.length).toBe(plays) // not yet
    answer()
    await settled()
    expect(vi.mocked(HTMLMediaElement.prototype.play).mock.calls.length).toBe(plays + 1)
    expect(audioPlayer.state().playing).toBe(true)
  })
})

describe('D37: a clip that fails does not leave the lock screen playing', () => {
  it('a load error stops the clock', async () => {
    const { s, m } = await playClip()
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
    audioPlayer.open(it, `/media/${it.mediaId}?c=2`, [], { play: true })
    await settled()
    expect(s.last('updateNowPlaying')).toMatchObject({ rate: 0 })
  })

  it('a play() that throws stops the clock', async () => {
    const s = shell()
    setPlatform(createCapacitorPlatform(s.scope))
    vi.spyOn(HTMLMediaElement.prototype, 'play').mockImplementation(() => {
      throw new Error('boom')
    })
    const it = att()
    media(120, 0)
    audioPlayer.open(it, `/media/${it.mediaId}?c=2`, [], { play: true })
    await settled()
    expect(s.last('updateNowPlaying')).toMatchObject({ rate: 0 })
  })
})

describe("D37: Drive does not inherit the player's scrubber", () => {
  it('Drive started while a report is paused at 5:00 of 12:00 shows its own title, from the start, moving', async () => {
    const { s, m } = await playClip()
    m.at(300)
    audioPlayer.pause() // last = { duration: 120, position: 300, rate: 0 }
    const p = getPlatform()
    p.mediaSession.set({ title: 'Talos is talking', artist: 'Talos' }, { play: () => {}, pause: () => {} })
    const np = s.last('setNowPlaying')
    expect(np).toMatchObject({ title: 'Talos is talking', position: 0, rate: 1 })
    expect(np).not.toHaveProperty('duration')
  })

  it('the same clip re-set on every play keeps its place', async () => {
    const { s, m } = await playClip()
    m.at(60)
    audioPlayer.pause()
    s.press({ action: 'play' })
    await settled()
    expect(s.last('setNowPlaying')).toMatchObject({ title: 'Weekly report', position: 60 })
  })
})

describe('D37: older or missing shells', () => {
  it('never throws when the plugin lacks the new methods or the event', () => {
    setPlatform(createCapacitorPlatform({ Capacitor: { Plugins: { TalosAudio: { setMode: async () => {} } } } }))
    const it = att()
    media(120, 0)
    expect(() => audioPlayer.open(it, '/media/x?c=2', [], { play: true })).not.toThrow()
    expect(() => audioPlayer.seek(5)).not.toThrow()
    expect(() => audioPlayer.stop()).not.toThrow()
    setPlatform(createCapacitorPlatform({ Capacitor: { Plugins: {} } }))
    expect(() => audioPlayer.open(it, '/media/x?c=2', [], { play: true })).not.toThrow()
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
      audioPlayer.open(it, `/media/${it.mediaId}?c=2`, [], { play: true })
    }
    expect(adds).toBe(1)
  })
})
