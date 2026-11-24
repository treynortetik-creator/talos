// @vitest-environment jsdom
// "Play does nothing after a pause" (the owner's iPhone): a pause event the element did not mean, a play() that fires no
// event, a 'play' that never reaches 'playing'. The element here is a small honest fake (paused flips inside play() and
// pause(); their events arrive later and in order, like a browser; play() on an element that is not paused fires nothing),
// installed on the player's real <audio>. The rule under test: a Play tap ends, in bounded time, in sound moving at the
// same spot or in a plain line the row shows, and never in silence.
import { type AttachmentRefT, type MessageT, newId, type SentFileT } from '@talos-app/protocol'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SentFiles } from '../../src/features/files/SentFiles.tsx'
import { recordAudioTrace, STALL_TRACE_MS } from '../../src/features/problems/audioTrace.ts'
import { AudioPlayer, VideoAttachment } from '../../src/features/threads/Attachments.tsx'
import {
  __resetAudioForTests,
  AUDIO_ELEMENT_ID,
  audioElement,
  audioPlayer,
  getAudioState,
  STALL_MS,
} from '../../src/features/threads/audioPlayer.ts'
import { SpeakButton } from '../../src/features/threads/SpeakButton.tsx'
import { REHYDRATE_MS, resetSpeak, speakView } from '../../src/features/threads/speak.ts'
import { ClientProvider, type TalosClient } from '../../src/lib/client.ts'
import { createFakeClient } from '../../src/lib/fakeClient.ts'
import { type AudioSessionType, type MediaHandlers, setPlatform, webPlatform } from '../../src/lib/platform.ts'
import { setup } from '../cards/helpers.tsx'

vi.mock('../../src/features/problems/audioTrace.ts', async (orig) => ({
  ...(await orig<typeof import('../../src/features/problems/audioTrace.ts')>()),
  recordAudioTrace: vi.fn(),
}))
const traced = () => vi.mocked(recordAudioTrace).mock.calls.map((c) => c[0].code)

const att = (): AttachmentRefT => ({
  media_id: newId('md'),
  kind: 'voice_note',
  role: 'attachment',
  mime: 'audio/webm',
  name: 'v.webm',
  size: 3,
  sha256: 'a'.repeat(64),
  duration_ms: 120_000,
})
const item = (a: AttachmentRefT, key = newId('m')) => ({
  key,
  mediaId: a.media_id,
  title: a.name,
  durationMs: a.duration_ms ?? 0,
})
const src = (a: AttachmentRefT) => `/media/${a.media_id}?c=2`

type Mode = 'ok' | 'silent' | 'no-playing'
/** What cures a bad mode: a pause and play (`pause`), only loading the source again (`load`), nothing (`never`). */
type Heal = 'pause' | 'load' | 'never'

/**
 * A browser's audio element, as far as the player can tell. `paused` is the element's flag, `moving` is whether the position
 * advances (a "wedged" element is paused:false and not moving). Modes: 'ok'; 'silent' (play() leaves paused true, fires
 * nothing, its promise never settles); 'no-playing' ('play' fires, 'playing' never does, the position stays put).
 */
function browser(mode: Mode = 'ok', heal: Heal = 'never') {
  const a = audioElement()
  const s = {
    mode,
    heal,
    paused: true,
    moving: false,
    t: 0,
    rs: 4,
    plays: 0,
    pauses: 0,
    loads: 0,
    playsWhileMoving: 0,
    seeking: false,
    /** `loadedmetadata` waits until the test lets it through (a slow load). */
    holdMeta: false,
    /** The playbackRate play() saw, each time. */
    rates: [] as number[],
    /** play() promises that have neither settled nor been aborted. */
    pending: [] as Array<{ resolve: () => void; reject: (e: unknown) => void }>,
    /** Replaces play()'s result once (a rejection, a throw). */
    playOnce: null as null | (() => Promise<void>),
  }
  const abort = () => {
    for (const p of s.pending.splice(0)) p.reject(Object.assign(new Error('aborted'), { name: 'AbortError' }))
  }
  const promise = () => new Promise<void>((resolve, reject) => s.pending.push({ resolve, reject }))
  const later = (fn: () => void) => void setTimeout(fn, 1) // always 1: in order, whether or not a timer is running
  const fire = (name: string) => later(() => void a.dispatchEvent(new Event(name)))
  Object.defineProperty(a, 'paused', { configurable: true, get: () => s.paused })
  Object.defineProperty(a, 'seeking', { configurable: true, get: () => s.seeking })
  Object.defineProperty(a, 'duration', { configurable: true, get: () => 120 })
  Object.defineProperty(a, 'readyState', { configurable: true, get: () => s.rs })
  Object.defineProperty(a, 'currentTime', {
    configurable: true,
    get: () => s.t,
    set: (v: number) => {
      s.t = v
      s.seeking = true
      later(() => {
        s.seeking = false
        a.dispatchEvent(new Event('seeked'))
      })
    },
  })
  a.play = () => {
    s.plays++
    s.rates.push(a.playbackRate)
    const once = s.playOnce
    s.playOnce = null
    if (once) return once()
    if (!s.paused) {
      if (s.moving) s.playsWhileMoving++
      return Promise.resolve() // already "playing": a browser fires nothing
    }
    if (s.mode === 'silent') return promise() // a browser leaves it pending until a pause or a load aborts it
    s.paused = false
    fire('play')
    if (s.mode === 'ok')
      later(() => {
        if (s.paused) return
        s.moving = true
        for (const p of s.pending.splice(0)) p.resolve()
        a.dispatchEvent(new Event('playing'))
      })
    return promise()
  }
  a.pause = () => {
    s.pauses++
    if (s.paused) return // nothing to pause: no event, and (as in the spec) a swallowed play() is not aborted by it
    s.paused = true
    s.moving = false
    abort()
    if (s.mode === 'no-playing' && s.heal === 'pause') s.mode = 'ok'
    fire('pause')
  }
  a.load = () => {
    s.loads++
    s.t = 0
    s.paused = true
    s.moving = false
    s.rs = 0
    abort()
    a.defaultPlaybackRate = 1 // a load starts the element over at 1x (WebKit)
    a.playbackRate = 1
    if (s.heal === 'load') s.mode = 'ok'
    later(() => {
      if (s.holdMeta) return
      s.rs = 4
      a.dispatchEvent(new Event('loadedmetadata'))
    })
  }
  /** Time passes: events arrive, and a moving element advances (and says so, as `timeupdate`). */
  const run = (ms: number) =>
    act(async () => {
      for (let left = ms; left > 0; left -= 100) {
        await vi.advanceTimersByTimeAsync(Math.min(100, left))
        if (s.moving && !s.paused) {
          s.t = Math.min(120, s.t + 0.1 * a.playbackRate)
          a.dispatchEvent(new Event('timeupdate'))
          if (s.t >= 120) {
            // the end of the clip: a browser pauses it (paused flips, 'pause'), then says 'ended'
            s.paused = true
            s.moving = false
            fire('pause')
            fire('ended')
          }
        }
      }
    })
  return {
    a,
    s,
    run,
    /** WebKit's media session is interrupted: not paused, not moving. */
    wedge: () => {
      s.moving = false
    },
    /** A play() the browser swallowed comes alive by itself, late: the element plays, with a 'play' and a 'playing'. */
    revive: () =>
      act(async () => {
        if (!s.pending.length || !s.paused) return
        s.paused = false
        s.moving = true
        for (const p of s.pending.splice(0)) p.resolve()
        a.dispatchEvent(new Event('play'))
        a.dispatchEvent(new Event('playing'))
      }),
    /** A 'pause' event the element did not mean (`paused` is still false). */
    stale: () => act(() => void a.dispatchEvent(new Event('pause'))),
    /** The system paused it for real (a call): the flag and the event agree. */
    interrupt: () => {
      s.paused = true
      s.moving = false
      return act(() => void a.dispatchEvent(new Event('pause')))
    },
    end: () => act(() => void a.dispatchEvent(new Event('ended'))),
  }
}

function recordPlatform() {
  let handlers: MediaHandlers = {}
  setPlatform({
    ...webPlatform,
    audioSession: { set: (_t: AudioSessionType) => {} },
    mediaSession: {
      set: (_m, h) => {
        handlers = h
      },
      clear: () => {},
      controls: () => false,
    },
  })
  return { handlers: () => handlers }
}

function Row({ a, id = 'm_1' }: { a: AttachmentRefT; id?: string }) {
  const client = { ...createFakeClient(), fetchMedia: () => {} } as unknown as TalosClient
  return (
    <ClientProvider client={client}>
      <AudioPlayer att={a} messageId={id} variant="voice_note" />
    </ClientProvider>
  )
}
const tap = (name: 'Play' | 'Pause') => fireEvent.click(screen.getByRole('button', { name }))
const label = () => (screen.queryByRole('button', { name: 'Pause' }) ? 'Pause' : 'Play')
/** The plain lines the row can show instead of sound. */
const LINES = ['audio-refused', 'media-fetching', 'media-failed', 'audio-buffering']
const lines = () => LINES.filter((id) => screen.queryByTestId(id))

/** Lets the events of an element that was just stopped or reset arrive, before another one is set up. */
const settle = () => act(async () => void (await vi.advanceTimersByTimeAsync(10)))

/** Plays a fresh clip with the browser in `mode`, and parks at 49 s with the first stall check behind it. */
async function playingAt49(mode: Mode = 'ok', heal: Heal = 'never') {
  const b = browser(mode, heal)
  const a = att()
  audioPlayer.open(item(a, 'm_1'), src(a))
  await b.run(300)
  b.s.t = 49
  await b.run(STALL_MS + 600)
  return { b, a }
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.mocked(recordAudioTrace).mockClear()
  localStorage.clear()
  __resetAudioForTests()
  resetSpeak()
})
afterEach(() => {
  cleanup()
  resetSpeak()
  __resetAudioForTests()
  vi.useRealTimers()
  vi.restoreAllMocks()
  setPlatform(webPlatform)
  localStorage.clear()
})

describe('A. a pause event the element did not mean (paused is still false, t=49, readyState 4)', () => {
  it('the store follows the element: a stale pause does not mark a playing clip stopped, and says so in the trace', async () => {
    const { b } = await playingAt49()
    expect(b.s.moving).toBe(true)
    await b.stale()
    expect(getAudioState().playing).toBe(true)
    expect(traced()).toContain('interrupted')
    await b.run(STALL_MS * 3)
    expect(getAudioState().playing).toBe(true)
    expect(b.s.t).toBeGreaterThan(49)
  })

  it('the row keeps saying Pause while sound plays through a stale pause', async () => {
    const b = browser()
    const a = att()
    render(<Row a={a} />)
    tap('Play')
    await b.run(300)
    b.s.t = 49
    await b.run(STALL_MS + 600)
    await b.stale()
    expect(label()).toBe('Pause')
  })

  it('a wedged element (paused false, not moving) behind a stale pause gets going again by itself, at 49 s', async () => {
    const { b } = await playingAt49()
    b.wedge()
    await b.stale()
    await b.run(STALL_MS * 8)
    expect(b.s.moving).toBe(true)
    expect(b.s.t).toBeGreaterThan(49)
    expect(b.s.t).toBeLessThan(49 + 20)
    expect(getAudioState()).toMatchObject({ playing: true, refused: false })
  })

  it('Play (resume, the lock screen) right after a stale pause on a wedged element gets the clip moving at 49 s', async () => {
    const { b } = await playingAt49()
    b.wedge()
    await b.stale()
    audioPlayer.resume()
    await b.run(STALL_MS * 8)
    expect(b.s.moving).toBe(true)
    expect(b.s.t).toBeGreaterThan(49)
    expect(b.s.t).toBeLessThan(49 + 20)
    expect(getAudioState().playing).toBe(true)
  })
})

describe('B. Play after a normal pause where play() is silent (no event, a promise that never settles)', () => {
  it('stops within a bounded time with the row saying so and a trace; the next tap gets its own tries', async () => {
    const { b, a } = await playingAt49()
    render(<Row a={a} id="m_1" />)
    await act(async () => audioPlayer.pause())
    await b.run(300)
    b.s.mode = 'silent'
    tap('Play')
    await b.run(STALL_MS * 8)
    expect(getAudioState()).toMatchObject({ playing: false, refused: true })
    expect(screen.getByTestId('audio-refused').textContent).toContain("Couldn't start playing")
    expect(traced()).toContain('give-up')
    expect(b.s.t).toBeGreaterThanOrEqual(49)
    b.s.mode = 'ok'
    tap('Play')
    await b.run(STALL_MS * 3)
    expect(b.s.moving).toBe(true)
    expect(screen.queryByTestId('audio-refused')).toBeNull()
  })

  it('recovers when only loading the source again cures it: same spot, same speed, one element, never two at once', async () => {
    const { b, a } = await playingAt49('ok', 'load')
    audioPlayer.setSpeed(1.25)
    render(<Row a={a} id="m_1" />)
    await act(async () => audioPlayer.pause())
    await b.run(300)
    const loadsBefore = b.s.loads
    b.s.mode = 'silent'
    tap('Play')
    const labels: string[] = [label()]
    for (let i = 0; i < 80; i++) {
      await b.run(100)
      if (label() !== labels.at(-1)) labels.push(label())
    }
    expect(b.s.loads).toBeGreaterThan(loadsBefore)
    expect(b.s.moving).toBe(true)
    expect(b.s.t).toBeGreaterThan(49)
    expect(b.s.t).toBeLessThan(49 + 20)
    expect(audioElement().playbackRate).toBe(1.25)
    expect(document.querySelectorAll(`audio#${AUDIO_ELEMENT_ID}`)).toHaveLength(1)
    expect(b.s.playsWhileMoving).toBe(0)
    expect(labels.length, `the button flip-flopped: ${labels.join(' > ')}`).toBeLessThanOrEqual(2)
    expect(labels.at(-1)).toBe('Pause')
  })
})

describe("C. 'play' without 'playing', the position frozen", () => {
  it('stops within a bounded time with the row saying so and a trace, if nothing cures it', async () => {
    const b = browser('no-playing', 'never')
    const a = att()
    render(<Row a={a} />)
    tap('Play')
    await b.run(STALL_MS * 8)
    expect(getAudioState()).toMatchObject({ playing: false, refused: true })
    expect(screen.getByTestId('audio-refused')).toBeTruthy()
    expect(traced()).toContain('give-up')
  })

  it('a pause and play is the first try: it cures this one without reloading, and the button never shows Play', async () => {
    const b = browser('no-playing', 'pause')
    const a = att()
    render(<Row a={a} />)
    tap('Play')
    const loads = b.s.loads
    const labels = new Set<string>()
    for (let i = 0; i < 60; i++) {
      await b.run(100)
      labels.add(label())
    }
    expect(b.s.moving).toBe(true)
    expect(b.s.loads).toBe(loads)
    expect([...labels]).toEqual(['Pause'])
  })

  it('reloading the source at the same spot is the last try: it cures this one', async () => {
    const { b } = await playingAt49('ok', 'load')
    audioPlayer.setSpeed(1.5)
    audioPlayer.pause()
    await b.run(300)
    b.s.mode = 'no-playing'
    audioPlayer.resume()
    await b.run(STALL_MS * 8)
    expect(b.s.moving).toBe(true)
    expect(b.s.t).toBeGreaterThanOrEqual(49)
    expect(b.s.t).toBeLessThan(49 + 20)
    expect(audioElement().playbackRate).toBe(1.5)
  })
})

describe('D. a recovery in progress is cancelled by whatever ends the clip', () => {
  type Ctl = { b: ReturnType<typeof browser>; other: AttachmentRefT }
  const cancels: Array<[string, (c: Ctl) => void | Promise<void>]> = [
    ['pause()', () => audioPlayer.pause()],
    ['stop()', () => audioPlayer.stop()],
    ['pause({ handOver: true }) (Drive)', () => audioPlayer.pause({ handOver: true })],
    ['sign-out', () => audioPlayer.resetForSignOut()],
    ['ended', (c) => c.b.end()],
  ]
  /** Starts a clip whose Play never takes, and lets the recovery get as far as `stage` (1: one pause and play, 2: the reload). */
  async function stuckAt(stage: 1 | 2) {
    const b = browser('no-playing', 'never')
    const a = att()
    audioPlayer.open(item(a, 'm_1'), src(a))
    const loads = b.s.loads
    if (stage === 1) {
      await b.run(STALL_MS + 300)
      expect(b.s.plays, 'a restart should be under way').toBeGreaterThanOrEqual(2)
    } else {
      for (let i = 0; i < 100 && b.s.loads === loads; i++) await b.run(100)
      expect(b.s.loads, 'the reload should be under way').toBeGreaterThan(loads)
    }
    return b
  }

  for (const stage of [1, 2] as const)
    for (const [name, cancel] of cancels)
      it(`${name} stops it (stage ${stage}): no restart, reload or play afterwards`, async () => {
        const b = await stuckAt(stage)
        await cancel({ b, other: att() })
        await b.run(300)
        const [plays, loads] = [b.s.plays, b.s.loads]
        await b.run(STALL_MS * 10)
        expect([b.s.plays, b.s.loads]).toEqual([plays, loads])
        expect(b.s.moving).toBe(false)
        expect(getAudioState().refused).toBe(false)
        expect(getAudioState().playing).toBe(false)
      })

  for (const stage of [1, 2] as const)
    it(`opening another clip takes over (stage ${stage}): the old clip's recovery does not touch it`, async () => {
      const b = await stuckAt(stage)
      b.s.mode = 'ok'
      const [plays, loads] = [b.s.plays, b.s.loads]
      const other = att()
      audioPlayer.open(item(other, 'm_2'), src(other))
      await b.run(STALL_MS * 10)
      expect(audioElement().getAttribute('src')).toBe(src(other))
      expect(b.s.plays - plays).toBe(1)
      expect(b.s.loads - loads).toBe(1)
      expect(b.s.moving).toBe(true)
      expect(b.s.playsWhileMoving).toBe(0)
      expect(getAudioState()).toMatchObject({ playing: true, item: { key: 'm_2' } })
    })
})

describe('E. a real interruption (a call)', () => {
  it('a pause event with paused true stops the store, is traced, restarts nothing, and Play then works', async () => {
    const { b } = await playingAt49()
    await b.interrupt()
    expect(getAudioState().playing).toBe(false)
    expect(traced()).toContain('interrupted')
    const [plays, loads] = [b.s.plays, b.s.loads]
    await b.run(STALL_MS * 10)
    expect([b.s.plays, b.s.loads]).toEqual([plays, loads]) // nothing plays after a call by itself
    expect(b.s.paused).toBe(true)
    expect(getAudioState()).toMatchObject({ playing: false, refused: false })
    audioPlayer.resume()
    await b.run(STALL_MS * 3)
    expect(b.s.moving).toBe(true)
    expect(b.s.t).toBeGreaterThanOrEqual(49)
    expect(getAudioState().playing).toBe(true)
  })
})

describe('F. the lock screen goes through the same path', () => {
  it('Play after a pause with a silent play() recovers (by reloading at the same spot)', async () => {
    const platform = recordPlatform()
    const { b } = await playingAt49('ok', 'load')
    platform.handlers().pause?.()
    await b.run(300)
    b.s.mode = 'silent'
    platform.handlers().play?.()
    await b.run(STALL_MS * 8)
    expect(b.s.moving).toBe(true)
    expect(b.s.t).toBeGreaterThanOrEqual(49)
    expect(b.s.t).toBeLessThan(49 + 20)
    expect(getAudioState().playing).toBe(true)
  })

  it('Play when nothing can start it ends in refused, the same as the row button', async () => {
    const platform = recordPlatform()
    const { b } = await playingAt49('ok', 'never')
    platform.handlers().pause?.()
    await b.run(300)
    b.s.mode = 'silent'
    platform.handlers().play?.()
    await b.run(STALL_MS * 8)
    expect(getAudioState()).toMatchObject({ playing: false, refused: true })
  })
})

describe('G. buffering is slow, not stuck', () => {
  it('readyState under 3 is left alone: no restart, no reload, no give-up; the row shows a loading line instead', async () => {
    const b = browser()
    const a = att()
    render(<Row a={a} />)
    tap('Play')
    await b.run(300)
    b.s.rs = 2 // the data never comes
    b.s.moving = false
    const [plays, pauses, loads] = [b.s.plays, b.s.pauses, b.s.loads]
    await b.run(STALL_TRACE_MS + STALL_MS * 3)
    expect([b.s.plays, b.s.pauses, b.s.loads]).toEqual([plays, pauses, loads])
    expect(getAudioState()).toMatchObject({ playing: true, refused: false })
    expect(lines()).toContain('audio-buffering')
  })

  it('the loading line goes away when the sound moves again', async () => {
    const b = browser()
    const a = att()
    render(<Row a={a} />)
    tap('Play')
    await b.run(300)
    b.s.rs = 2
    b.s.moving = false
    await b.run(STALL_MS * 3)
    expect(lines()).toContain('audio-buffering')
    b.s.rs = 4
    b.s.moving = true
    await b.run(STALL_MS)
    expect(lines()).not.toContain('audio-buffering')
  })
})

describe('the rule: a Play tap ends in sound moving or in a line the row shows', () => {
  /** Taps Play on a fresh row, lets a bounded time pass, and returns what the user would have. */
  async function tapAndWait(b: ReturnType<typeof browser>) {
    render(<Row a={att()} />)
    tap('Play')
    await b.run(STALL_MS * 8)
    return { moving: b.s.moving && !b.s.paused, shown: lines() }
  }
  const ends = (r: { moving: boolean; shown: string[] }) => r.moving || r.shown.length > 0

  it('play() throws at once: the row says so', async () => {
    const b = browser()
    b.s.playOnce = () => {
      throw new Error('boom')
    }
    const r = await tapAndWait(b)
    expect(ends(r)).toBe(true)
    expect(getAudioState().playing).toBe(false)
  })

  it('play() rejects with NotSupportedError and no error event comes: the row says so', async () => {
    const b = browser()
    b.s.playOnce = () => Promise.reject(Object.assign(new Error('x'), { name: 'NotSupportedError' }))
    expect(ends(await tapAndWait(b))).toBe(true)
  })

  it('play() rejects with NotAllowedError: the row says so', async () => {
    const b = browser()
    b.s.playOnce = () => Promise.reject(Object.assign(new Error('x'), { name: 'NotAllowedError' }))
    const r = await tapAndWait(b)
    expect(r.shown).toContain('audio-refused')
  })

  it('play() rejects with AbortError and nothing follows: the sound moves, or the row says so', async () => {
    const b = browser()
    b.s.playOnce = () => Promise.reject(Object.assign(new Error('x'), { name: 'AbortError' }))
    expect(ends(await tapAndWait(b))).toBe(true)
  })

  it('Play on a clip that failed to load: the row shows the fetch line (and never an empty row)', async () => {
    const platform = recordPlatform()
    const b = browser()
    const a = att()
    render(<Row a={a} />)
    tap('Play')
    await b.run(300)
    await act(async () => void b.a.dispatchEvent(new Event('error')))
    expect(getAudioState().failed).toBe(true)
    platform.handlers().play?.()
    await b.run(STALL_MS * 8)
    expect(lines().length).toBeGreaterThan(0)
  })
})

// ---- review round: other rows, route, clock, suspended pages, taps during a start ---------------------------------------------
const REFUSED_LINE = "Couldn't start playing. Tap Play to try again."
const BUFFERING_LINE = 'Loading audio…'
const reject = (name: string) => () => Promise.reject(Object.assign(new Error(name), { name }))

/** What the platform was told about the audio route and about the lock-screen clock (its rate), in order. */
function recordRoute() {
  const route: string[] = []
  const rates: number[] = []
  setPlatform({
    ...webPlatform,
    audioSession: { set: (t: AudioSessionType) => void route.push(t) },
    mediaSession: {
      set: () => {},
      clear: () => {},
      controls: () => false,
      position: (p) => void rates.push(p.rate),
    },
  })
  return { route, rates }
}

/** The client read aloud talks to: a Mac that answers 'ready' at once, and a media.ready the test can send. */
function speakClient() {
  const fetched: string[] = []
  const frames = new Map<string, Set<(f: Record<string, unknown>) => void>>()
  const client = {
    ...(createFakeClient() as unknown as object),
    fetchMedia: (id: string) => void fetched.push(id),
    onFrame: (type: string, l: (f: Record<string, unknown>) => void) => {
      const set = frames.get(type) ?? new Set()
      set.add(l)
      frames.set(type, set)
      return () => void set.delete(l)
    },
    store: { getState: () => ({ presence: { bridge_online: true } }), subscribe: () => () => {} },
    speak: { request: async () => ({ state: 'ready', media: { media_id: 'md_speak', mime: 'audio/mpeg', size: 3 } }) },
  } as unknown as TalosClient
  const message = { id: newId('m'), thread_id: 'general' } as unknown as MessageT
  return {
    client,
    fetched,
    message,
    emit: (type: string, f: Record<string, unknown>) =>
      act(() => {
        for (const l of [...(frames.get(type) ?? [])]) l(f)
      }),
  }
}
const listenTap = () => act(async () => void fireEvent.click(screen.getByTestId('speak')))

describe('B1. the other rows say it too (read aloud, the Files sheet)', () => {
  async function listening() {
    const b = browser()
    const r = speakClient()
    render(
      <ClientProvider client={r.client}>
        <SpeakButton m={r.message} />
      </ClientProvider>,
    )
    await listenTap()
    await b.run(200)
    return { b, r }
  }

  it('read aloud: Resume refused with NotAllowedError shows the line, it is not silent', async () => {
    const { b } = await listening()
    expect(getAudioState().playing).toBe(true)
    await act(async () => audioPlayer.pause())
    await b.run(200)
    b.s.playOnce = reject('NotAllowedError')
    await listenTap() // Resume
    await b.run(200)
    expect(screen.getByTestId('audio-refused').textContent).toBe(REFUSED_LINE)
  })

  it('read aloud: a play() that never takes ends in the refused line', async () => {
    const { b } = await listening()
    await act(async () => audioPlayer.pause())
    await b.run(200)
    b.s.mode = 'silent'
    await listenTap()
    await b.run(STALL_MS * 8)
    expect(screen.getByTestId('audio-refused').textContent).toBe(REFUSED_LINE)
  })

  it('read aloud: a clip that waits for data shows the loading line', async () => {
    const { b } = await listening()
    b.s.rs = 2
    b.s.moving = false
    await b.run(STALL_MS * 3)
    expect(screen.getByTestId('audio-buffering').textContent).toBe(BUFFERING_LINE)
  })

  const audioFile = (): SentFileT => ({
    message_id: newId('m'),
    thread_id: 'general',
    author: 'agent',
    created_at: new Date().toISOString(),
    index: 0,
    file: {
      media_id: newId('md'),
      kind: 'audio',
      role: 'attachment',
      mime: 'audio/mp4',
      name: 'report.m4a',
      size: 3,
      sha256: 'a'.repeat(64),
    },
    removed: false,
  })
  for (const layout of ['list', 'table'] as const) {
    it(`the Files sheet (${layout}): the row says it when a start never takes, and while it waits for data`, async () => {
      const b = browser()
      const client = setup()
      client.files.sent = (async () => ({ files: [audioFile()], nextCursor: null, days: 90 })) as never
      render(
        <ClientProvider client={client}>
          <MemoryRouter>
            <SentFiles layout={layout} />
          </MemoryRouter>
        </ClientProvider>,
      )
      await b.run(100)
      const row = () => screen.getByTestId('sent-file')
      b.s.mode = 'silent'
      await act(async () => void fireEvent.click(screen.getByRole('button', { name: /Play/ })))
      await b.run(STALL_MS * 8)
      expect(row().textContent).toContain(REFUSED_LINE)
      b.s.mode = 'ok'
      await act(async () => void fireEvent.click(screen.getByRole('button', { name: /Play/ })))
      await b.run(300)
      expect(row().textContent).not.toContain(REFUSED_LINE)
      b.s.rs = 2
      b.s.moving = false
      await b.run(STALL_MS * 3)
      expect(row().textContent).toContain(BUFFERING_LINE)
    })
  }
})

describe('B2. a load failure is told once, and a repeat does not end the Mac fetch', () => {
  it('onError runs once for a rejection and then the element error, either way round', async () => {
    for (const order of ['reject-first', 'event-first']) {
      __resetAudioForTests()
      await settle()
      const b = browser()
      const a = att()
      let n = 0
      audioPlayer.registerRow('m_1', () => ({ src: src(a), onError: () => void n++ }))
      let rej: (e: unknown) => void = () => {}
      b.s.playOnce = () =>
        new Promise<void>((_, r) => {
          rej = r
        })
      audioPlayer.open(item(a, 'm_1'), src(a))
      await b.run(50)
      const fail = () => rej(Object.assign(new Error('x'), { name: 'NotSupportedError' }))
      await act(async () => {
        if (order === 'reject-first') {
          fail()
          await Promise.resolve()
          await Promise.resolve()
          b.a.dispatchEvent(new Event('error'))
        } else {
          b.a.dispatchEvent(new Event('error'))
          fail()
        }
      })
      await b.run(50)
      expect(n, order).toBe(1)
      expect(getAudioState().failed).toBe(true)
    }
  })

  for (const order of ['reject-first', 'event-first'] as const)
    it(`read aloud, the file is gone from the relay (${order}): one ask to the Mac, and the wait is not cut short`, async () => {
      const b = browser()
      const r = speakClient()
      render(
        <ClientProvider client={r.client}>
          <SpeakButton m={r.message} />
        </ClientProvider>,
      )
      let rej: (e: unknown) => void = () => {}
      b.s.playOnce = () =>
        new Promise<void>((_, rj) => {
          rej = rj
        })
      await listenTap()
      await b.run(100)
      await act(async () => {
        if (order === 'reject-first') {
          rej(Object.assign(new Error('x'), { name: 'NotSupportedError' }))
          await Promise.resolve()
          await Promise.resolve()
          b.a.dispatchEvent(new Event('error'))
        } else {
          b.a.dispatchEvent(new Event('error'))
          rej(Object.assign(new Error('x'), { name: 'NotSupportedError' }))
        }
      })
      await b.run(100)
      expect(r.fetched).toEqual(['md_speak'])
      expect(speakView(r.message.id).status).not.toBe('failed') // still waiting for the Mac
      await b.run(REHYDRATE_MS + 100) // the Mac never answers: now it says so
      expect(speakView(r.message.id).status).toBe('failed')
    })

  it('Play from the lock screen on a failed clip does not end the Mac fetch either', async () => {
    const platform = recordPlatform()
    const b = browser()
    const r = speakClient()
    render(
      <ClientProvider client={r.client}>
        <SpeakButton m={r.message} />
      </ClientProvider>,
    )
    await listenTap()
    await b.run(100)
    await act(async () => void b.a.dispatchEvent(new Event('error')))
    expect(r.fetched).toEqual(['md_speak'])
    await act(async () => platform.handlers().play?.())
    await act(async () => platform.handlers().play?.())
    await b.run(100)
    expect(r.fetched).toEqual(['md_speak'])
    expect(speakView(r.message.id).status).not.toBe('failed')
    // and when the Mac does send the file, it plays at the new URL
    await r.emit('media.ready', { media_id: 'md_speak' })
    await b.run(300)
    expect(audioElement().getAttribute('src')).toMatch(/&r=1$/)
    expect(getAudioState()).toMatchObject({ failed: false, playing: true })
  })
})

describe('B3. a system pause whose event has not arrived yet is not played over', () => {
  it('the watch tick between the pause and its event does not play again (no auto-play after a call)', async () => {
    const { b } = await playingAt49()
    audioPlayer.seek(30) // arms the watch from here
    b.s.paused = true // the system paused the element ...
    b.s.moving = false
    const plays = b.s.plays
    await b.run(STALL_MS + 50) // ... and the page's tick comes first
    expect(b.s.plays).toBe(plays)
    expect(getAudioState().playing).toBe(false)
    expect(traced()).toContain('interrupted')
    await b.run(STALL_MS * 4) // the event itself comes late, or never
    await act(async () => void b.a.dispatchEvent(new Event('pause')))
    await b.run(STALL_MS * 4)
    expect(b.s.plays).toBe(plays)
    expect(b.s.moving).toBe(false)
    expect(getAudioState().refused).toBe(false)
  })

  it('a tick that comes long after it was due (the page was suspended) is not a stall: a wedged element is paused, not played again', async () => {
    const { b } = await playingAt49()
    b.wedge()
    await b.stale() // arms the watch
    const plays = b.s.plays
    vi.setSystemTime(Date.now() + 10 * 60_000)
    await b.run(STALL_MS + 100)
    expect(b.s.plays).toBe(plays)
    expect(b.s.paused).toBe(true)
    expect(getAudioState()).toMatchObject({ playing: false, refused: false })
  })

  it('a tick after a long suspension finds the clip moving: it is playing, and is left alone', async () => {
    const { b } = await playingAt49()
    await b.stale() // arms the watch while it plays
    const [plays, pauses] = [b.s.plays, b.s.pauses]
    await b.run(STALL_MS / 2)
    vi.setSystemTime(Date.now() + 10 * 60_000)
    b.s.t += 30 // it played on while the page slept
    await b.run(STALL_MS)
    expect([b.s.plays, b.s.pauses]).toEqual([plays, pauses])
    expect(getAudioState().playing).toBe(true)
  })

  it('a start that was pending when the page was suspended is looked at again from here, not dropped', async () => {
    const { b } = await playingAt49()
    await act(async () => audioPlayer.pause())
    await b.run(300)
    b.s.mode = 'silent'
    audioPlayer.resume()
    vi.setSystemTime(Date.now() + 10 * 60_000)
    await b.run(STALL_MS * 8)
    expect(getAudioState()).toMatchObject({ playing: false, refused: true }) // it still ends in the line
  })
})

describe('S1. the unsized-WebM fix', () => {
  const unsized = (b: ReturnType<typeof browser>) =>
    Object.defineProperty(b.a, 'duration', { configurable: true, get: () => Number.POSITIVE_INFINITY })
  /** The huge seek of the fix never produces a timeupdate. */
  const swallowTimeupdate = (b: ReturnType<typeof browser>) => {
    const real = b.a.dispatchEvent.bind(b.a)
    b.a.dispatchEvent = (e: Event) => (e.type === 'timeupdate' ? true : real(e))
  }

  it('a fix seek that never lands still ends in a line', async () => {
    const b = browser()
    unsized(b)
    render(<Row a={att()} />)
    tap('Play')
    await b.run(50)
    b.s.moving = false
    swallowTimeupdate(b)
    b.a.dispatchEvent(new Event('loadedmetadata'))
    const plays = b.s.plays
    await b.run(STALL_MS * 3)
    expect(b.s.plays).toBe(plays) // the fix is waited for, not "helped" with restarts
    expect(lines()).toContain('audio-buffering')
    await b.run(STALL_MS * 9)
    expect(lines().length).toBeGreaterThan(0)
  })

  it('a fix that lands on a play() that does not take is caught by the watch from there', async () => {
    const { b, a } = await playingAt49('ok', 'never')
    render(<Row a={a} id="m_1" />)
    await act(async () => audioPlayer.pause())
    await b.run(300)
    b.s.mode = 'silent'
    // an unsized clip: its length is Infinity until the fix's jump to the end has landed, and every load starts over
    let landed = false
    Object.defineProperty(b.a, 'duration', { configurable: true, get: () => (landed ? 120 : Number.POSITIVE_INFINITY) })
    Object.defineProperty(b.a, 'currentTime', {
      configurable: true,
      get: () => b.s.t,
      set: (v: number) => {
        b.s.t = v > 1e6 ? 120 : v
        if (v > 1e6)
          setTimeout(() => {
            landed = true
            b.a.dispatchEvent(new Event('timeupdate'))
          }, 1)
      },
    })
    const load = b.a.load.bind(b.a)
    b.a.load = () => {
      landed = false
      load()
    }
    tap('Play')
    b.a.dispatchEvent(new Event('loadedmetadata'))
    await b.run(STALL_MS * 12)
    expect(getAudioState()).toMatchObject({ playing: false, refused: true })
  })
})

describe('S2. a refusal that belongs to an older start does nothing', () => {
  it('clip A is refused after clip B was opened: B is not failed, not stopped, its row is not asked', async () => {
    const b = browser()
    const [a, c] = [att(), att()]
    const asked: string[] = []
    audioPlayer.registerRow('m_2', () => ({ src: src(c), onError: () => void asked.push('B') }))
    let rej: (e: unknown) => void = () => {}
    b.s.playOnce = () =>
      new Promise<void>((_, r) => {
        rej = r
      })
    audioPlayer.open(item(a, 'm_1'), src(a))
    await b.run(100)
    audioPlayer.open(item(c, 'm_2'), src(c))
    await b.run(100)
    rej(Object.assign(new Error('x'), { name: 'NotSupportedError' }))
    await b.run(STALL_MS * 3)
    expect(asked).toEqual([])
    expect(getAudioState()).toMatchObject({ failed: false, playing: true, refused: false })
  })

  it('a NotAllowedError of an older tap does not refuse the newer one that took', async () => {
    const { b } = await playingAt49()
    await act(async () => audioPlayer.pause())
    await b.run(300)
    let rej: (e: unknown) => void = () => {}
    b.s.playOnce = () =>
      new Promise<void>((_, r) => {
        rej = r
      })
    audioPlayer.resume()
    audioPlayer.resume() // a second tap: this one plays
    await b.run(300)
    rej(Object.assign(new Error('x'), { name: 'NotAllowedError' }))
    await b.run(300)
    expect(getAudioState()).toMatchObject({ playing: true, refused: false })
  })
})

describe('S3. the route is given back for a reload only on a page that can be seen', () => {
  const visibility = (v: 'visible' | 'hidden') => vi.spyOn(document, 'visibilityState', 'get').mockReturnValue(v)

  async function reloadRun(v: 'visible' | 'hidden') {
    const rec = recordRoute()
    const { b } = await playingAt49('ok', 'load')
    audioPlayer.pause()
    await b.run(300)
    b.s.mode = 'silent'
    visibility(v)
    rec.route.length = 0
    audioPlayer.resume()
    await b.run(STALL_MS * 8)
    return { b, rec }
  }

  it('visible: the route is given back and taken anew', async () => {
    const { b, rec } = await reloadRun('visible')
    expect(rec.route.join()).toContain('auto,playback')
    expect(b.s.moving).toBe(true)
  })

  it('hidden: no "auto" (a hidden page could not take it back), and the route is still held', async () => {
    const { b, rec } = await reloadRun('hidden')
    expect(rec.route).not.toContain('auto')
    expect(rec.route.at(-1)).toBe('playback')
    expect(b.s.moving).toBe(true)
  })
})

describe('S4. taps during a start that is pending', () => {
  it('20 Play taps 1.4 s apart still end in a line (each does not restart the tries)', async () => {
    const { b, a } = await playingAt49('ok', 'never')
    render(<Row a={a} id="m_1" />)
    await act(async () => audioPlayer.pause())
    await b.run(300)
    b.s.mode = 'silent'
    for (let i = 0; i < 20; i++) {
      if (screen.queryByRole('button', { name: 'Play' })) tap('Play')
      await b.run(1400)
    }
    expect(b.s.moving || lines().length > 0).toBe(true)
    expect(lines()).toContain('audio-refused')
  })

  it('a pending start counts as active; a stopped, paused or refused clip does not', async () => {
    const { b } = await playingAt49('ok', 'never')
    expect(audioPlayer.active()).toBe(true)
    audioPlayer.pause()
    expect(audioPlayer.active()).toBe(false)
    await b.run(300)
    b.s.mode = 'silent'
    audioPlayer.resume()
    expect(getAudioState().playing).toBe(false)
    expect(audioPlayer.active()).toBe(true) // asked for, not started yet
    await b.run(STALL_MS * 8)
    expect(audioPlayer.active()).toBe(false) // gave up
    audioPlayer.resume()
    expect(audioPlayer.active()).toBe(true)
    audioPlayer.stop()
    expect(audioPlayer.active()).toBe(false)
  })

  it('a video that starts cancels a pending start the same way it pauses a playing clip', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(null, { status: 200 })),
    )
    const { b } = await playingAt49('ok', 'never')
    await act(async () => audioPlayer.pause())
    await b.run(300)
    b.s.mode = 'silent'
    audioPlayer.resume()
    const client = { onFrame: () => () => {}, fetchMedia: () => {} } as unknown as TalosClient
    render(
      <ClientProvider client={client}>
        <VideoAttachment att={{ ...att(), kind: 'video', mime: 'video/mp4', name: 'clip.mp4' }} />
      </ClientProvider>,
    )
    await b.run(50)
    const video = document.querySelector('video') as HTMLVideoElement
    const plays = b.s.plays
    await act(async () => void fireEvent.play(video))
    await b.run(STALL_MS * 8)
    expect(audioPlayer.active()).toBe(false)
    expect(b.s.plays).toBe(plays) // the pending start did not go on with its tries
    expect(getAudioState().refused).toBe(false)
    vi.unstubAllGlobals()
  })

  it('read aloud does not start over a clip whose start is pending', async () => {
    const { b } = await playingAt49('ok', 'never')
    await act(async () => audioPlayer.pause())
    await b.run(300)
    b.s.mode = 'silent'
    audioPlayer.resume() // another clip is starting, its play() has not taken yet
    const r = speakClient()
    render(
      <ClientProvider client={r.client}>
        <SpeakButton m={r.message} />
      </ClientProvider>,
    )
    await listenTap()
    await b.run(100)
    expect(getAudioState().item?.key).toBe('m_1') // read aloud was not loaded over it
    expect(speakView(r.message.id).hint).toContain('Tap Listen')
  })
})

describe('S5. pause during the unsized fix stays paused', () => {
  it('pause({ handOver: true }) while the fix is under way: nothing plays when the fix lands', async () => {
    const b = browser()
    Object.defineProperty(b.a, 'duration', { configurable: true, get: () => Number.POSITIVE_INFINITY })
    audioPlayer.open(item(att(), 'm_1'), '/x')
    await b.run(50)
    b.a.dispatchEvent(new Event('loadedmetadata'))
    audioPlayer.pause({ handOver: true })
    await b.run(50)
    const plays = b.s.plays
    b.a.dispatchEvent(new Event('timeupdate')) // the fix lands
    await b.run(STALL_MS * 4)
    expect(b.s.plays).toBe(plays)
    expect(b.s.moving).toBe(false)
    expect(getAudioState().playing).toBe(false)
  })
})

describe('what the row and the lock screen say while a start is tried', () => {
  it('a refusal line from before goes away at the next tap, not only when the sound starts', async () => {
    const b = browser('silent', 'never')
    render(<Row a={att()} />)
    tap('Play')
    await b.run(STALL_MS * 8)
    expect(lines()).toEqual(['audio-refused'])
    tap('Play')
    await b.run(100)
    expect(lines()).not.toContain('audio-refused')
  })

  it('a refusal and a load failure do not show together: the error clears the refusal', async () => {
    const b = browser()
    render(<Row a={att()} />)
    b.s.playOnce = reject('NotAllowedError')
    tap('Play')
    await b.run(200)
    expect(lines()).toEqual(['audio-refused'])
    await act(async () => void b.a.dispatchEvent(new Event('error')))
    await b.run(100)
    expect(lines()).not.toContain('audio-refused')
    expect(lines()).toContain('media-fetching')
  })

  it('the route is given up when a refusal or a give-up stops the clip', async () => {
    const rec = recordRoute()
    const b = browser('silent', 'never')
    audioPlayer.open(item(att(), 'm_1'), '/x')
    await b.run(STALL_MS * 8)
    expect(getAudioState().refused).toBe(true)
    expect(rec.route.at(-1)).toBe('paused')
    __resetAudioForTests()
    await settle()
    const c = browser()
    rec.route.length = 0
    c.s.playOnce = reject('NotAllowedError')
    audioPlayer.open(item(att(), 'm_1'), '/x')
    await c.run(200)
    expect(getAudioState().refused).toBe(true)
    expect(rec.route.at(-1)).toBe('paused')
  })

  it('the lock-screen clock stops while a clip waits for data and while a start is tried, and runs again when it moves', async () => {
    const rec = recordRoute()
    const b = browser()
    audioPlayer.open(item(att(), 'm_1'), '/x')
    await b.run(300)
    expect(rec.rates.at(-1)).toBeGreaterThan(0)
    b.s.rs = 2
    b.s.moving = false
    await b.run(STALL_MS * 2)
    expect(rec.rates.at(-1)).toBe(0)
    b.s.rs = 4
    b.s.moving = true
    await b.run(STALL_MS)
    expect(rec.rates.at(-1)).toBeGreaterThan(0)
    // a stuck start, in the ladder
    __resetAudioForTests()
    await settle() // the old element's last events come and go
    const c = browser('no-playing', 'never')
    audioPlayer.open(item(att(), 'm_2'), '/y')
    await c.run(STALL_MS + 300)
    expect(c.s.plays).toBeGreaterThanOrEqual(2)
    expect(rec.rates.at(-1)).toBe(0)
  })
})

describe('the end of a clip', () => {
  it('pause, then ended: the clip is over, nothing is played again, and nothing is wanted', async () => {
    const { b } = await playingAt49()
    b.s.t = 119.4
    await b.run(STALL_MS * 3)
    expect(getAudioState()).toMatchObject({ item: null, playing: false })
    expect(audioPlayer.active()).toBe(false)
    const plays = b.s.plays
    await b.run(STALL_MS * 10)
    expect(b.s.plays).toBe(plays)
  })
})

describe('what ends the intent (each one, so none is left out)', () => {
  it('a real pause event, stop, opening without play, a load error and a give-up each leave nothing wanted', async () => {
    const { b } = await playingAt49()
    await b.interrupt()
    expect(audioPlayer.active()).toBe(false)
    audioPlayer.resume()
    await b.run(300)
    expect(audioPlayer.active()).toBe(true)
    audioPlayer.open(item(att(), 'm_2'), '/other', [], { play: false })
    expect(audioPlayer.active()).toBe(false)
    audioPlayer.resume()
    await b.run(300)
    await act(async () => void b.a.dispatchEvent(new Event('error')))
    expect(audioPlayer.active()).toBe(false)
  })

  it('after a real interruption, a seek does not arm a restart: nothing plays by itself', async () => {
    const { b } = await playingAt49()
    await b.interrupt()
    const plays = b.s.plays
    audioPlayer.seek(30)
    await b.run(STALL_MS * 4)
    expect(b.s.plays).toBe(plays)
  })

  it('an element that starts by itself (the system, not a tap) is followed: a stale pause then keeps it playing', async () => {
    const b = browser()
    audioPlayer.open(item(att(), 'm_1'), '/x', [], { play: false })
    await b.run(100)
    await act(async () => void b.a.play()) // not through the player
    await b.run(300)
    expect(getAudioState().playing).toBe(true)
    await b.stale()
    expect(getAudioState().playing).toBe(true)
  })
})

describe('waiting is not stuck, and a start that did not take is', () => {
  it('a seek that is under way is waited for: no restart, a loading line', async () => {
    const b = browser('no-playing', 'never')
    audioPlayer.open(item(att(), 'm_1'), '/x')
    await b.run(50)
    b.s.seeking = true // the browser is still seeking
    const [plays, pauses] = [b.s.plays, b.s.pauses]
    await b.run(STALL_MS * 3)
    expect([b.s.plays, b.s.pauses]).toEqual([plays, pauses])
  })

  it('a jump that has not landed yet (no metadata) is waited for, with the line', async () => {
    localStorage.setItem('talos.audio.pos', JSON.stringify([['md_pos', 30, Date.now()]]))
    __resetAudioForTests()
    const b = browser('no-playing', 'never')
    b.s.holdMeta = true
    const row = render(<Row a={{ ...att(), media_id: 'md_pos' }} />)
    tap('Play')
    b.s.rs = 4
    await b.run(50)
    const [plays, pauses] = [b.s.plays, b.s.pauses]
    await b.run(STALL_MS * 3)
    expect([b.s.plays, b.s.pauses]).toEqual([plays, pauses])
    expect(lines()).toContain('audio-buffering')
    row.unmount()
  })

  it('a play() that did not take with readyState under 3 is a stuck start, not a wait', async () => {
    const b = browser('silent', 'never')
    audioPlayer.open(item(att(), 'm_1'), '/x')
    await b.run(50)
    b.s.rs = 2 // the metadata is in, the data is not, and play() did nothing
    await b.run(STALL_MS * 8)
    expect(getAudioState()).toMatchObject({ playing: false, refused: true })
  })

  it('a source change while a start is pending plays again from the new source', async () => {
    const { b } = await playingAt49('ok', 'never')
    await act(async () => audioPlayer.pause())
    await b.run(300)
    b.s.mode = 'silent'
    audioPlayer.resume()
    const plays = b.s.plays
    audioPlayer.rowSrcChanged('m_1', '/media/new?c=2&r=1')
    expect(b.s.plays).toBeGreaterThan(plays)
  })

  it('a seek during a start that does not take does not hide it: it still ends in the line', async () => {
    const b = browser('no-playing', 'never')
    audioPlayer.open(item(att(), 'm_1'), '/x')
    await b.run(STALL_MS - 300)
    audioPlayer.seek(80)
    await b.run(STALL_MS * 10)
    expect(getAudioState()).toMatchObject({ playing: false, refused: true })
  })

  it('the speed stays through the reload (the element falls back to 1x on a load)', async () => {
    const { b } = await playingAt49('ok', 'load')
    audioPlayer.setSpeed(1.25)
    audioPlayer.pause()
    await b.run(300)
    b.s.mode = 'silent'
    b.s.rates.length = 0
    audioPlayer.resume()
    await b.run(STALL_MS * 8)
    expect(b.s.moving).toBe(true)
    expect(b.s.rates.at(-1)).toBe(1.25) // what play() saw straight after the load
  })

  it('a give-up and a reload keep the saved spot', async () => {
    const { b } = await playingAt49('ok', 'never')
    audioPlayer.pause()
    await b.run(300)
    b.s.mode = 'silent'
    audioPlayer.resume()
    await b.run(STALL_MS * 8)
    expect(getAudioState().cur).toBeGreaterThanOrEqual(49)
  })
})

describe('more of what must not go unseen', () => {
  it('a fix that lands on a clip that says "play" but does not move still ends in a line (the watch looks again from the landing)', async () => {
    localStorage.setItem('talos.audio.pos', JSON.stringify([['md_fix', 40, Date.now()]]))
    __resetAudioForTests()
    const b = browser('no-playing', 'never')
    let landed = false
    Object.defineProperty(b.a, 'duration', { configurable: true, get: () => (landed ? 120 : Number.POSITIVE_INFINITY) })
    Object.defineProperty(b.a, 'currentTime', {
      configurable: true,
      get: () => b.s.t,
      set: (v: number) => {
        b.s.t = v > 1e6 ? 120 : v
        if (v > 1e6)
          setTimeout(() => {
            landed = true
            b.a.dispatchEvent(new Event('timeupdate'))
          }, 1)
      },
    })
    audioPlayer.open({ ...item(att(), 'm_1'), mediaId: 'md_fix' }, '/x')
    await b.run(STALL_MS * 12)
    expect(getAudioState()).toMatchObject({ playing: false, refused: true })
  })

  it('a clip wedged after a stale pause, with the first try swallowed, goes on to the last try instead of being called paused', async () => {
    const { b } = await playingAt49('ok', 'load')
    b.wedge()
    await b.stale()
    b.s.mode = 'silent' // the pause and play does nothing; the element is paused after it, and the store still says playing
    await b.run(STALL_MS * 8)
    expect(b.s.moving).toBe(true)
    expect(b.s.loads).toBeGreaterThan(1)
  })

  it('a position that changes under a paused element is not playing (a silent start still ends in the line)', async () => {
    const b = browser('silent', 'never')
    audioPlayer.open(item(att(), 'm_1'), '/x')
    await b.run(STALL_MS - 500)
    b.s.t += 5 // the engine moved the position, nothing plays
    await b.run(STALL_MS * 10)
    expect(getAudioState()).toMatchObject({ playing: false, refused: true })
  })

  it('a refused play() leaves nothing wanted and nothing is tried afterwards', async () => {
    const b = browser()
    b.s.playOnce = reject('NotAllowedError')
    audioPlayer.open(item(att(), 'm_1'), '/x')
    await b.run(200)
    expect(audioPlayer.active()).toBe(false)
    const plays = b.s.plays
    await b.run(STALL_MS * 8)
    expect(b.s.plays).toBe(plays)
  })

  it('a refusal that comes after stop(), or after another clip was opened, belongs to nobody', async () => {
    const b = browser()
    let rej: (e: unknown) => void = () => {}
    b.s.playOnce = () =>
      new Promise<void>((_, r) => {
        rej = r
      })
    audioPlayer.open(item(att(), 'm_1'), '/x')
    await b.run(100)
    audioPlayer.stop()
    rej(Object.assign(new Error('x'), { name: 'NotAllowedError' }))
    await b.run(100)
    expect(getAudioState().refused).toBe(false)
    await settle()
    b.s.playOnce = () =>
      new Promise<void>((_, r) => {
        rej = r
      })
    audioPlayer.open(item(att(), 'm_2'), '/y')
    await b.run(100)
    audioPlayer.open(item(att(), 'm_3'), '/z', [], { play: false })
    rej(Object.assign(new Error('x'), { name: 'NotAllowedError' }))
    await b.run(100)
    expect(getAudioState()).toMatchObject({ refused: false, item: { key: 'm_3' } })
  })

  it('a Play tap on a clip that plays by the store but sits still (lock screen) gets its own fresh tries', async () => {
    const platform = recordPlatform()
    const b = browser('no-playing', 'never')
    audioPlayer.open(item(att(), 'm_1'), '/x')
    await b.run(STALL_MS + 300) // the first try is behind it
    expect(getAudioState().playing).toBe(true)
    platform.handlers().play?.() // a fresh tap: its tries start over, so the give-up is later than it would have been
    await b.run(STALL_MS * 2.5)
    expect(getAudioState().refused).toBe(false)
    await b.run(STALL_MS * 6)
    expect(getAudioState()).toMatchObject({ playing: false, refused: true })
  })

  it('Play on a failed clip asks its row again (the row may not have been mounted at the first error)', async () => {
    const platform = recordPlatform()
    const b = browser()
    const a = att()
    let n = 0
    audioPlayer.registerRow('m_1', () => ({ src: src(a), onError: () => void n++ }))
    audioPlayer.open(item(a, 'm_1'), src(a))
    await b.run(100)
    await act(async () => void b.a.dispatchEvent(new Event('error')))
    expect(n).toBe(1)
    platform.handlers().play?.()
    expect(n).toBe(2)
  })

  it('pausing a start that is being helped along clears the loading line at once', async () => {
    const b = browser('silent', 'never')
    render(<Row a={att()} />)
    tap('Play')
    await b.run(STALL_MS + 300)
    expect(lines()).toContain('audio-buffering')
    act(() => audioPlayer.pause()) // the element is paused already: no pause event will come
    expect(lines()).not.toContain('audio-buffering')
  })

  it('the reload is traced (its own code, so the limiter does not drop it behind the restart)', async () => {
    const { b } = await playingAt49('ok', 'load')
    audioPlayer.pause()
    await b.run(300)
    b.s.mode = 'silent'
    audioPlayer.resume()
    await b.run(STALL_MS * 8)
    expect(traced()).toEqual(expect.arrayContaining(['restart', 'reload']))
  })

  it('read aloud: an error after the Mac sent the file back is real: it says so', async () => {
    const b = browser()
    const r = speakClient()
    render(
      <ClientProvider client={r.client}>
        <SpeakButton m={r.message} />
      </ClientProvider>,
    )
    await listenTap()
    await b.run(100)
    await act(async () => void b.a.dispatchEvent(new Event('error')))
    await r.emit('media.ready', { media_id: 'md_speak' })
    await b.run(300)
    expect(getAudioState().playing).toBe(true)
    await act(async () => void b.a.dispatchEvent(new Event('error'))) // the new file will not play either
    await b.run(100)
    expect(speakView(r.message.id).status).toBe('failed')
  })
})

// ---- recheck: a suspended page, the Files sheet, a source change --------------------------------------------------------------
const HOURS_3 = 3 * 3600_000
describe('B4. a start still pending when the page was suspended is not played by itself afterwards', () => {
  /** A Play whose play() does nothing, then the page sleeps, then the element works again: no tap since. */
  async function suspendedStart(gap: number, between = 500) {
    const { b } = await playingAt49()
    await act(async () => audioPlayer.pause())
    await b.run(300)
    b.s.mode = 'silent'
    audioPlayer.resume()
    await b.run(between)
    vi.setSystemTime(Date.now() + gap)
    b.s.mode = 'ok'
    return b
  }
  const endsInTheLine = (b: ReturnType<typeof browser>) => {
    expect(b.s.moving).toBe(false)
    expect(b.s.paused).toBe(true)
    expect(getAudioState()).toMatchObject({ playing: false, refused: true })
    expect(audioPlayer.active()).toBe(false)
  }

  it('C1: three hours asleep, no tap: no sound, and the line', async () => {
    const b = await suspendedStart(HOURS_3)
    await b.run(STALL_MS * 8)
    endsInTheLine(b)
  })

  it('C3: asleep after one try (a call), no tap: no sound, and the line', async () => {
    const b = await suspendedStart(300_000, STALL_MS + 200)
    await b.run(STALL_MS * 8)
    endsInTheLine(b)
  })

  it('C2: asleep while the jump to the saved spot is still pending (no metadata yet): no sound, and the line', async () => {
    const { b, a } = await playingAt49()
    await act(async () => audioPlayer.pause())
    await b.run(300)
    audioPlayer.stop()
    await b.run(50)
    b.s.mode = 'silent'
    b.s.holdMeta = true
    audioPlayer.open(item(a, 'm_1'), src(a))
    await b.run(STALL_MS * 2)
    vi.setSystemTime(Date.now() + HOURS_3)
    b.s.mode = 'ok'
    b.s.holdMeta = false
    b.s.rs = 4
    // on waking, the event comes before the overdue tick, and re-arms the watch: that must not make the suspension forgotten
    await act(async () => void b.a.dispatchEvent(new Event('loadedmetadata')))
    await b.run(STALL_MS * 8)
    endsInTheLine(b)
  })

  it('C2c: the swallowed play() comes alive after the late tick: the element is stopped again and the line stays', async () => {
    const b = await suspendedStart(HOURS_3)
    await b.run(STALL_MS * 8) // the late tick ends the start (pause() on a paused element aborts nothing)
    endsInTheLine(b)
    await b.revive()
    await b.run(STALL_MS * 4)
    endsInTheLine(b)
  })

  it('C2b: the swallowed play() comes alive on waking, before the late tick: the element is stopped again, nothing sounds', async () => {
    const b = await suspendedStart(HOURS_3)
    await b.revive() // its 'play' and 'playing' come first, as a woken page's events do
    await b.run(STALL_MS * 8)
    endsInTheLine(b)
  })

  it("the owner's own tap after the suspension is a fresh start: it gets its own tries, it is not ended as overdue", async () => {
    const { b } = await playingAt49('ok', 'load')
    await act(async () => audioPlayer.pause())
    await b.run(300)
    b.s.mode = 'silent'
    audioPlayer.resume()
    await b.run(500)
    vi.setSystemTime(Date.now() + HOURS_3)
    audioPlayer.resume() // the owner taps on waking, before any timer has run; the element still does nothing
    await b.run(STALL_MS * 8) // its own tries (the last one reloads, which cures this element)
    expect(b.s.moving).toBe(true)
    expect(getAudioState()).toMatchObject({ playing: true, refused: false })
  })

  it('the tick that sees the system pause leaves nothing wanted and asks the shell for nothing, before the pause event', async () => {
    const rec = recordRoute()
    const { b } = await playingAt49()
    audioPlayer.seek(30) // arms the watch
    b.s.paused = true
    b.s.moving = false
    await b.run(STALL_MS + 50) // the pause event has not come
    expect(audioPlayer.active()).toBe(false)
    expect(rec.route.at(-1)).toBe('playback') // a pause the system caused: iOS has the route, no 'paused' is sent for it
  })
})

describe('the Files sheet and a source change', () => {
  it('a load failure with no row registered for the clip (the Files sheet) shows the line, and a row that mounts later clears it', async () => {
    const b = browser()
    const client = setup()
    const file: SentFileT = {
      message_id: newId('m'),
      thread_id: 'general',
      author: 'agent',
      created_at: new Date().toISOString(),
      index: 0,
      file: {
        media_id: newId('md'),
        kind: 'audio',
        role: 'attachment',
        mime: 'audio/mp4',
        name: 'report.m4a',
        size: 3,
        sha256: 'a'.repeat(64),
      },
      removed: false,
    }
    client.files.sent = (async () => ({ files: [file], nextCursor: null, days: 90 })) as never
    render(
      <ClientProvider client={client}>
        <MemoryRouter>
          <SentFiles layout="list" />
        </MemoryRouter>
      </ClientProvider>,
    )
    await b.run(100)
    await act(async () => void fireEvent.click(screen.getByRole('button', { name: /Play/ })))
    await b.run(100)
    await act(async () => void b.a.dispatchEvent(new Event('error')))
    await b.run(100)
    expect(screen.getByTestId('sent-file').textContent).toContain(REFUSED_LINE)
    // a row for the clip mounts (the rehydrate starts there): the line is not kept
    audioPlayer.registerRow(`${file.message_id}:${file.file.media_id}`, () => ({ src: '/x', onError: () => {} }))
    await b.run(100)
    expect(getAudioState().refused).toBe(false)
  })

  it('a source change while playing, with a play() that does nothing, ends in the line (it is not read as a system pause)', async () => {
    const { b, a } = await playingAt49()
    render(<Row a={a} id="m_1" />)
    b.s.mode = 'silent'
    await act(async () => audioPlayer.rowSrcChanged('m_1', `${src(a)}&r=1`))
    await b.run(STALL_MS * 10)
    expect(getAudioState()).toMatchObject({ playing: false, refused: true })
    expect(lines()).toContain('audio-refused')
  })
})

// ---- the last leftovers of the suspension review ----------------------------------------------------------------------------
describe('B5. what a woken page finds is not a tap: the other ways a start can come alive late', () => {
  const asleep = () => vi.setSystemTime(Date.now() + HOURS_3)
  const stopped = (b: ReturnType<typeof browser>) => {
    expect(b.s.moving).toBe(false)
    expect(b.s.paused).toBe(true)
    expect(audioPlayer.active()).toBe(false)
    expect(getAudioState()).toMatchObject({ playing: false, refused: true })
  }

  it('the unsized-WebM fix lands after the sleep: the clip it paused is not played again by itself', async () => {
    const b = browser()
    Object.defineProperty(b.a, 'duration', { configurable: true, get: () => Number.POSITIVE_INFINITY })
    audioPlayer.open(item(att(), 'm_1'), '/x')
    await b.run(50)
    b.s.moving = false
    b.a.dispatchEvent(new Event('loadedmetadata')) // the fix: paused, a jump to the end that has not landed
    await b.run(200)
    const plays = b.s.plays
    asleep()
    await act(async () => void b.a.dispatchEvent(new Event('timeupdate'))) // the jump lands, before the overdue tick
    await b.run(STALL_MS * 8)
    expect(b.s.plays).toBe(plays)
    stopped(b)
  })

  it('a source change after the sleep, with a start pending, does not start it again', async () => {
    const { b, a } = await playingAt49()
    await act(async () => audioPlayer.pause())
    await b.run(300)
    b.s.mode = 'silent'
    audioPlayer.resume()
    await b.run(500)
    asleep()
    b.s.mode = 'ok'
    await act(async () => audioPlayer.rowSrcChanged('m_1', `${src(a)}&r=1`))
    await b.run(STALL_MS * 8)
    stopped(b)
  })

  it('a clip that was loading (playing by the store, no data) when the page slept ends in the line, not in a silent Play', async () => {
    const b = browser()
    render(<Row a={att()} id="m_1" />)
    tap('Play')
    await b.run(200)
    b.s.rs = 1
    b.s.moving = false
    await b.run(3000)
    expect(lines()).toEqual(['audio-buffering'])
    asleep()
    await b.run(3000)
    expect(lines()).toEqual(['audio-refused'])
    stopped(b)
  })

  it('a Files-sheet clip (no row): the error event, then the NotSupportedError of its play(), keep the line', async () => {
    const b = browser()
    let reject: (e: unknown) => void = () => {}
    b.s.playOnce = () =>
      new Promise<void>((_, r) => {
        reject = r
      })
    audioPlayer.open({ key: 'm_f:md_f', mediaId: 'md_f', title: 'f.mp3' }, '/media/md_f?c=2')
    await b.run(100)
    await act(async () => {
      b.a.dispatchEvent(new Event('error')) // the element's own event first
      reject(Object.assign(new Error('x'), { name: 'NotSupportedError' })) // then the promise
    })
    await b.run(STALL_MS * 3)
    expect(getAudioState()).toMatchObject({ failed: true, refused: true })
  })
})
