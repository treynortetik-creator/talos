// @vitest-environment jsdom
// "A resume in the middle of a clip gets an unasked pause at the same spot" (the owner's iPhone). Theory: the player asked the
// native shell for the audio route and called play() at once; a clip that is already buffered sounds at once and the route call
// lands on top of it. So in the iPhone app a start now takes the route, waits for the native answer (or ROUTE_WAIT_MS), and only
// then calls play(). A browser has no native answer: it still calls play() inside the tap. The platform here is a recorder whose
// `audioSession.set` answers only when the test says so; the element is a small honest fake (paused flips inside play() and
// pause(), their events arrive a moment later). Real player, real row.
import { type AttachmentRefT, newId } from '@talos-app/protocol'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { recordAudioTrace } from '../../src/features/problems/audioTrace.ts'
import { AudioPlayer } from '../../src/features/threads/Attachments.tsx'
import {
  __resetAudioForTests,
  audioElement,
  audioPlayer,
  getAudioState,
  ROUTE_WAIT_MS,
  STALL_MS,
} from '../../src/features/threads/audioPlayer.ts'
import { ClientProvider, type TalosClient } from '../../src/lib/client.ts'
import { createFakeClient } from '../../src/lib/fakeClient.ts'
import { type AudioSessionType, type MediaHandlers, setPlatform, webPlatform } from '../../src/lib/platform.ts'

vi.mock('../../src/features/problems/audioTrace.ts', async (orig) => ({
  ...(await orig<typeof import('../../src/features/problems/audioTrace.ts')>()),
  recordAudioTrace: vi.fn(),
}))
type Order = { r?: number; a?: number | 'cap'; p?: number }
/** The trace inputs of one code, as the player passed them to the recorder. */
const traces = (code: string) =>
  vi
    .mocked(recordAudioTrace)
    .mock.calls.map((c) => c[0] as { code: string; detail?: string; order?: Order })
    .filter((t) => t.code === code)

// The cap is 250 ms. The tests use the literal so that a changed constant shows up as one failing test, not as every test moving.
const CAP = 250
// The player's SUSPENDED_MS is 10 s: a page that slept longer than that has no tap behind what it does next.
const SUSPENDED_MS = 10_000

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

/** 'manual': the native call answers when the test says (an iPhone). 'auto': it answers at once. 'web': it returns nothing. */
type Kind = 'manual' | 'auto' | 'web'
function phone(log: string[], kind: Kind) {
  let handlers: MediaHandlers = {}
  const pending: Array<{ type: AudioSessionType; resolve: () => void; reject: (e: unknown) => void }> = []
  setPlatform({
    ...webPlatform,
    audioSession: {
      set: (type: AudioSessionType) => {
        log.push(`route:${type}`)
        if (kind === 'web') return undefined
        if (kind === 'auto') return Promise.resolve()
        return new Promise<void>((resolve, reject) => pending.push({ type, resolve, reject }))
      },
    },
    mediaSession: {
      set: (_m, h) => {
        handlers = h
      },
      clear: () => {},
      controls: () => true,
    },
  })
  const flush = () => act(async () => void (await vi.advanceTimersByTimeAsync(0)))
  return {
    handlers: () => handlers,
    /** Route calls the native side has not answered yet. */
    open: () => pending.length,
    answer: async (i = 0) => {
      pending.splice(i, 1)[0]?.resolve()
      await flush()
    },
    answerAll: async () => {
      for (const p of pending.splice(0)) p.resolve()
      await flush()
    },
    fail: async (i = 0) => {
      pending.splice(i, 1)[0]?.reject(new Error('native said no'))
      await flush()
    },
  }
}

/** A browser's audio element: `silent` makes play() leave it paused, as WebKit sometimes does. */
function element(log: string[]) {
  const a = audioElement()
  const s = { paused: true, moving: false, t: 0, plays: 0, silent: false }
  const later = (fn: () => void) => void setTimeout(fn, 1)
  const fire = (name: string) => later(() => void a.dispatchEvent(new Event(name)))
  Object.defineProperty(a, 'paused', { configurable: true, get: () => s.paused })
  Object.defineProperty(a, 'duration', { configurable: true, get: () => 120 })
  Object.defineProperty(a, 'readyState', { configurable: true, get: () => 4 })
  Object.defineProperty(a, 'currentTime', {
    configurable: true,
    get: () => s.t,
    set: (v: number) => {
      s.t = v
    },
  })
  a.play = () => {
    s.plays++
    log.push('play')
    if (!s.paused) return Promise.resolve()
    if (s.silent) return new Promise<void>(() => {})
    s.paused = false
    fire('play')
    later(() => {
      if (s.paused) return
      s.moving = true
      a.dispatchEvent(new Event('playing'))
    })
    return Promise.resolve()
  }
  a.pause = () => {
    log.push('el.pause')
    if (s.paused) return
    s.paused = true
    s.moving = false
    fire('pause')
  }
  a.load = () => {
    s.paused = true
    s.moving = false
  }
  const run = (ms: number) =>
    act(async () => {
      for (let left = ms; left > 0; left -= 100) {
        await vi.advanceTimersByTimeAsync(Math.min(100, left))
        if (s.moving && !s.paused) {
          s.t += 0.1
          a.dispatchEvent(new Event('timeupdate'))
        }
      }
    })
  return {
    a,
    s,
    run,
    /** The system paused it for real (a call): the flag and the event agree. */
    interrupt: () => {
      s.paused = true
      s.moving = false
      return act(() => void a.dispatchEvent(new Event('pause')))
    },
    /** The flag flipped and the event has not come (the watch has to notice). */
    silentInterrupt: () => {
      s.paused = true
      s.moving = false
    },
    /** The clip reaches its end: a browser pauses it, then says `ended`. */
    end: () =>
      act(() => {
        s.paused = true
        s.moving = false
        a.dispatchEvent(new Event('pause'))
        a.dispatchEvent(new Event('ended'))
      }),
  }
}

function Row({ a, id = 'm_1' }: { a: AttachmentRefT; id?: string }) {
  const client = { ...createFakeClient(), fetchMedia: () => {} } as unknown as TalosClient
  return (
    <ClientProvider client={client}>
      <AudioPlayer att={a} messageId={id} variant="voice_note" />
    </ClientProvider>
  )
}
const label = () => (screen.queryByRole('button', { name: 'Pause' }) ? 'Pause' : 'Play')
const tap = (name: 'Play' | 'Pause') => fireEvent.click(screen.getByRole('button', { name }))
const lines = () =>
  ['audio-refused', 'media-fetching', 'media-failed', 'audio-buffering'].filter((t) => screen.queryByTestId(t))
const advance = (ms: number) => act(async () => void (await vi.advanceTimersByTimeAsync(ms)))
const visibility = (v: 'visible' | 'hidden') => vi.spyOn(document, 'visibilityState', 'get').mockReturnValue(v)

/** A clip that sounded, was paused at 49 s, and sits there: the next Play is "a resume in the middle of a clip". */
async function pausedMidClip(kind: Kind) {
  const log: string[] = []
  const ph = phone(log, kind)
  const el = element(log)
  const a = att()
  const it = item(a, 'm_1')
  audioPlayer.open(it, src(a))
  await ph.answerAll()
  await el.run(300)
  el.s.t = 49
  await el.run(100)
  audioPlayer.pause()
  await ph.answerAll()
  await el.run(100)
  expect(el.s.paused).toBe(true)
  log.length = 0
  el.s.plays = 0
  return { log, ph, el, a, it }
}
const routeCalls = (log: string[], type: string) => log.filter((l) => l === `route:${type}`).length

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(new Date('2026-11-22T10:00:00Z'))
  vi.mocked(recordAudioTrace).mockClear()
  localStorage.clear()
  __resetAudioForTests()
})
afterEach(() => {
  cleanup()
  __resetAudioForTests()
  vi.useRealTimers()
  vi.restoreAllMocks()
  setPlatform(webPlatform)
  localStorage.clear()
})

describe('the wait itself', () => {
  it('is 250 ms', () => {
    expect(ROUTE_WAIT_MS).toBe(CAP)
  })

  it('iPhone: Play after a pause asks for the route first, and play() comes only after the native answer', async () => {
    const { log, ph, el } = await pausedMidClip('manual')
    audioPlayer.resume()
    expect(routeCalls(log, 'playback')).toBe(1)
    expect(el.s.plays).toBe(0) // not in the tap
    await advance(CAP - 100) // time passes, no answer
    expect(el.s.plays).toBe(0)
    await ph.answer()
    expect(el.s.plays).toBe(1)
    expect(log).toEqual(['route:playback', 'play'])
    await el.run(300)
    expect(getAudioState().playing).toBe(true)
    expect(el.s.t).toBeGreaterThan(49)
  })

  it('iPhone: no answer at all, play() comes at the cap and not a moment before', async () => {
    const { ph, el } = await pausedMidClip('manual')
    audioPlayer.resume()
    await advance(CAP - 1)
    expect(el.s.plays).toBe(0)
    await advance(1)
    expect(el.s.plays).toBe(1)
    await ph.answerAll() // the answer after the cap changes nothing
    await advance(CAP * 4)
    expect(el.s.plays).toBe(1)
  })

  it('iPhone: a rejected route call still lets play() through, once', async () => {
    const { ph, el } = await pausedMidClip('manual')
    audioPlayer.resume()
    await ph.fail()
    expect(el.s.plays).toBe(1)
    await advance(CAP * 4)
    expect(el.s.plays).toBe(1)
  })

  it('iPhone: the answer and the cap both come, play() is called once', async () => {
    const { ph, el } = await pausedMidClip('manual')
    audioPlayer.resume()
    await advance(CAP - 10)
    await ph.answer()
    await advance(CAP * 2)
    expect(el.s.plays).toBe(1)
  })

  it('a start is wanted from the tap, so a tap is never silent, even while it waits', async () => {
    const { el } = await pausedMidClip('manual')
    expect(audioPlayer.active()).toBe(false)
    audioPlayer.resume()
    expect(audioPlayer.active()).toBe(true)
    expect(el.s.plays).toBe(0)
  })

  it('a browser or Android (no promise back): play() is called inside the tap, exactly as before', async () => {
    const { log, el } = await pausedMidClip('web')
    audioPlayer.resume()
    expect(el.s.plays).toBe(1) // no await between the tap and this line
    expect(log).toEqual(['route:playback', 'play'])
  })

  it('a first start of a fresh clip in a browser plays inside the tap too', () => {
    const log: string[] = []
    phone(log, 'web')
    const el = element(log)
    const a = att()
    audioPlayer.open(item(a), src(a))
    expect(el.s.plays).toBe(1)
  })

  it('the route call comes before the element is touched, as the order of the log says', async () => {
    const { log, ph } = await pausedMidClip('manual')
    audioPlayer.resume()
    await ph.answer()
    expect(log.indexOf('route:playback')).toBeLessThan(log.indexOf('play'))
  })
})

describe('what cancels a start that is waiting: play() is then never called for it', () => {
  it('a pause tapped during the wait wins, and the native side is told paused', async () => {
    const { log, ph, el } = await pausedMidClip('manual')
    audioPlayer.resume()
    await advance(100)
    audioPlayer.pause()
    await ph.answerAll()
    await advance(CAP * 4)
    expect(el.s.plays).toBe(0)
    expect(getAudioState().playing).toBe(false)
    expect(audioPlayer.active()).toBe(false)
    expect(log).toEqual(['route:playback', 'el.pause', 'route:paused'])
  })

  it('stop() during the wait', async () => {
    const { ph, el } = await pausedMidClip('manual')
    audioPlayer.resume()
    audioPlayer.stop()
    await ph.answerAll()
    await advance(CAP * 4)
    expect(el.s.plays).toBe(0)
  })

  it('sign-out during the wait', async () => {
    const { ph, el } = await pausedMidClip('manual')
    audioPlayer.resume()
    audioPlayer.resetForSignOut()
    await ph.answerAll()
    await advance(CAP * 4)
    expect(el.s.plays).toBe(0)
  })

  it('a hand-over to Drive during the wait gives the route back and plays nothing', async () => {
    const { log, ph, el } = await pausedMidClip('manual')
    audioPlayer.resume()
    audioPlayer.pause({ handOver: true })
    await ph.answerAll()
    await advance(CAP * 4)
    expect(el.s.plays).toBe(0)
    expect(log.at(-1)).toBe('route:auto')
  })

  it('the end of the clip during the wait', async () => {
    const { ph, el } = await pausedMidClip('manual')
    audioPlayer.resume()
    await el.end()
    await ph.answerAll()
    await advance(CAP * 4)
    expect(el.s.plays).toBe(0)
    expect(getAudioState().item).toBeNull()
  })

  it('opening another clip during the wait: only the new clip is started, once', async () => {
    const { ph, el } = await pausedMidClip('manual')
    audioPlayer.resume()
    const b = att()
    audioPlayer.open(item(b), src(b))
    expect(ph.open()).toBe(2)
    await ph.answerAll()
    await advance(CAP * 4)
    expect(el.s.plays).toBe(1)
  })

  it('a source change during the wait: one play(), for the new source', async () => {
    const { ph, el, a, it } = await pausedMidClip('manual')
    audioPlayer.resume()
    audioPlayer.rowSrcChanged(it.key, `${src(a)}&x=1`)
    await ph.answerAll()
    await advance(CAP * 4)
    expect(el.s.plays).toBe(1)
  })

  it('a newer start (pause, then Play again): the older wait does not also play', async () => {
    const { ph, el } = await pausedMidClip('manual')
    audioPlayer.resume()
    audioPlayer.pause()
    audioPlayer.resume()
    await ph.answerAll()
    await advance(CAP * 4)
    expect(el.s.plays).toBe(1)
  })

  it('a pause event that was meant for the earlier pause does not drop the Play tapped just after it', async () => {
    const { log, ph, el } = await pausedMidClip('manual')
    audioPlayer.resume()
    await ph.answerAll()
    await el.run(300) // sounding
    log.length = 0
    el.s.plays = 0
    audioPlayer.pause() // its pause event arrives a moment from now
    audioPlayer.resume() // the owner taps Play again at once
    await el.run(CAP * 4)
    await ph.answerAll()
    await el.run(300)
    expect(el.s.plays).toBe(1)
    expect(getAudioState().playing).toBe(true)
    expect(el.s.moving).toBe(true)
  })
})

describe('a wait that the page slept through does not play by itself (no new tap)', () => {
  /** The page is suspended for `ms` (a locked phone): the clock moves, no timer and no promise runs meanwhile. */
  const sleep = (ms: number) => vi.setSystemTime(Date.now() + ms)

  it('the native answer comes after the page woke: no play(), the row says it could not start', async () => {
    const { log, ph, el } = await pausedMidClip('manual')
    render(<Row a={att()} id="m_other" />) // a row of its own is not needed for the line: the player says it
    audioPlayer.resume()
    sleep(SUSPENDED_MS + 1000)
    await ph.answer()
    expect(el.s.plays).toBe(0)
    expect(getAudioState()).toMatchObject({ playing: false, refused: true })
    expect(audioPlayer.active()).toBe(false)
    await advance(CAP * 4)
    expect(el.s.plays).toBe(0)
    expect(log.filter((l) => l.startsWith('route:'))).toEqual(['route:playback']) // nothing else was asked of the shell
  })

  it('the cap timer fires after the page woke: the same', async () => {
    const { el } = await pausedMidClip('manual')
    audioPlayer.resume()
    sleep(SUSPENDED_MS + 1000)
    await advance(CAP)
    expect(el.s.plays).toBe(0)
    expect(getAudioState()).toMatchObject({ playing: false, refused: true })
    await el.run(STALL_MS * 3)
    expect(el.s.plays).toBe(0)
  })

  it('the row shows the refused line, and Play there tries again with its own wait', async () => {
    const log: string[] = []
    const ph = phone(log, 'manual')
    const el = element(log)
    render(<Row a={att()} />)
    tap('Play')
    sleep(SUSPENDED_MS + 1000)
    await ph.answerAll()
    expect(el.s.plays).toBe(0)
    expect(lines()).toEqual(['audio-refused'])
    tap('Play')
    await ph.answerAll()
    await el.run(300)
    expect(el.s.plays).toBe(1)
    expect(label()).toBe('Pause')
    expect(lines()).toEqual([])
  })

  it('a tap after the page woke does not join the dead wait: it takes the route and waits afresh', async () => {
    const { log, ph, el } = await pausedMidClip('manual')
    audioPlayer.resume()
    sleep(SUSPENDED_MS + 1000)
    audioPlayer.resume()
    expect(routeCalls(log, 'playback')).toBe(2)
    await ph.answerAll()
    await el.run(300)
    expect(el.s.plays).toBe(1)
    expect(getAudioState()).toMatchObject({ playing: true, refused: false })
  })

  it('a short sleep inside the limit still plays', async () => {
    const { ph, el } = await pausedMidClip('manual')
    audioPlayer.resume()
    sleep(SUSPENDED_MS - 1000)
    await ph.answer()
    expect(el.s.plays).toBe(1)
  })
})

describe('taps during the wait join it', () => {
  it('three Play taps: one route call, one play()', async () => {
    const { log, ph, el } = await pausedMidClip('manual')
    audioPlayer.resume()
    audioPlayer.resume()
    audioPlayer.resume()
    expect(routeCalls(log, 'playback')).toBe(1)
    await ph.answerAll()
    await advance(CAP * 4)
    expect(el.s.plays).toBe(1)
  })

  it('a join does not push the cap later', async () => {
    const { el } = await pausedMidClip('manual')
    audioPlayer.resume()
    await advance(CAP - 100)
    audioPlayer.resume()
    await advance(100)
    expect(el.s.plays).toBe(1)
  })
})

describe('every kind of start waits, and each ends by the native answer alone', () => {
  it('the lock-screen Play, page in view: waits for the answer', async () => {
    const { log, ph, el } = await pausedMidClip('manual')
    ph.handlers().play?.()
    expect(routeCalls(log, 'playback')).toBe(1)
    expect(el.s.plays).toBe(0)
    await ph.answer()
    expect(el.s.plays).toBe(1)
  })

  it('the lock-screen Play, page hidden: the native answer alone starts it, with no timer moving', async () => {
    const { ph, el } = await pausedMidClip('manual')
    visibility('hidden')
    ph.handlers().play?.()
    expect(el.s.plays).toBe(0)
    const before = Date.now()
    await ph.answer() // flushes microtasks only: the fake clock does not move
    expect(Date.now()).toBe(before)
    expect(el.s.plays).toBe(1)
  })

  it('the lock-screen Play, page hidden, no answer, timers held back: it still ends, once', async () => {
    const { ph, el } = await pausedMidClip('manual')
    visibility('hidden')
    ph.handlers().play?.()
    await el.run(STALL_MS * 3)
    expect(el.s.plays).toBe(1)
    await ph.answerAll()
    await el.run(STALL_MS * 3)
    expect(el.s.plays).toBe(1)
  })

  it('the cap never fires (a throttled page) and no answer comes: the watch lets the start through once', async () => {
    const { ph, el } = await pausedMidClip('manual')
    visibility('hidden')
    const real = globalThis.setTimeout
    vi.spyOn(globalThis, 'setTimeout').mockImplementation(((fn: () => void, ms?: number, ...rest: unknown[]) =>
      ms === CAP ? (0 as never) : real(fn, ms, ...rest)) as never)
    ph.handlers().play?.()
    await el.run(STALL_MS - 100)
    expect(el.s.plays).toBe(0)
    await el.run(STALL_MS)
    expect(el.s.plays).toBe(1)
    await el.run(STALL_MS * 3)
    expect(el.s.plays).toBe(1)
    expect(el.s.moving).toBe(true)
  })

  it("the queue's next clip on 'ended': the route is taken, play() waits for the answer, once", async () => {
    const log: string[] = []
    const ph = phone(log, 'manual')
    const el = element(log)
    const first = att()
    const second = att()
    audioPlayer.open(item(first, 'm_1'), src(first), [item(second, 'm_2')])
    await ph.answerAll()
    await el.run(300)
    log.length = 0
    el.s.plays = 0
    await el.end()
    expect(getAudioState().item?.key).toBe('m_2')
    expect(routeCalls(log, 'playback')).toBe(1)
    expect(el.s.plays).toBe(0)
    await ph.answerAll()
    await advance(CAP * 4)
    expect(el.s.plays).toBe(1)
  })

  it("the watch's restart waits too, and the watch counts from play(), not from the tap", async () => {
    const log: string[] = []
    const ph = phone(log, 'manual')
    const el = element(log)
    el.s.silent = true // play() leaves it paused: a start that does not take
    const a = att()
    audioPlayer.open(item(a), src(a))
    const tapAt = Date.now()
    await advance(CAP) // no answer: the cap lets play() through
    const playAt = Date.now()
    expect(playAt - tapAt).toBe(CAP)
    expect(el.s.plays).toBe(1)
    await advance(STALL_MS - 100)
    expect(traces('restart')).toHaveLength(0) // 1.5 s after the tap is not yet 1.5 s after play()
    await advance(100)
    expect(traces('restart')).toHaveLength(1)
    expect(Date.now() - playAt).toBe(STALL_MS)
    // the restart took the route again and waits for it
    expect(routeCalls(log, 'playback')).toBe(2)
    expect(el.s.plays).toBe(1)
    await advance(CAP - 1)
    expect(el.s.plays).toBe(1)
    await advance(1)
    expect(el.s.plays).toBe(2)
    await ph.answerAll()
    expect(el.s.plays).toBe(2)
  })

  it("the watch's last try (the source loaded again) waits for the route as well", async () => {
    const log: string[] = []
    phone(log, 'manual')
    const el = element(log)
    el.s.silent = true
    const a = att()
    audioPlayer.open(item(a), src(a))
    await advance(CAP) // the cap: play() 1
    await advance(STALL_MS) // the first rung: a restart, which takes the route again
    await advance(CAP) // play() 2
    await advance(STALL_MS) // the second rung: the source loaded again
    expect(traces('reload')).toHaveLength(1)
    expect(el.s.plays).toBe(2)
    await advance(CAP - 1)
    expect(el.s.plays).toBe(2)
    await advance(1)
    expect(el.s.plays).toBe(3)
  })
})

describe('the row does not flicker while it waits', () => {
  it('Play, then Pause: nothing else shows in between', async () => {
    const log: string[] = []
    const ph = phone(log, 'manual')
    const el = element(log)
    render(<Row a={att()} />)
    const seen: string[] = []
    const look = () => seen.push(`${label()}${lines().join()}`)
    look()
    tap('Play')
    for (let i = 0; i < 5; i++) {
      await advance(40)
      look()
    }
    await ph.answerAll()
    await el.run(300)
    look()
    const collapsed = seen.filter((s, i) => s !== seen[i - 1])
    expect(collapsed).toEqual(['Play', 'Pause'])
  })

  it('a pause tapped during the wait: the row never says Pause', async () => {
    const log: string[] = []
    const ph = phone(log, 'manual')
    const el = element(log)
    render(<Row a={att()} />)
    const seen: string[] = []
    tap('Play')
    await advance(50)
    seen.push(label())
    audioPlayer.pause()
    await advance(10)
    seen.push(label())
    await ph.answerAll()
    await el.run(CAP * 2)
    seen.push(label())
    expect(seen).toEqual(['Play', 'Play', 'Play'])
    expect(lines()).toEqual([])
  })
})

describe('a pause the system caused makes no native call', () => {
  async function playing() {
    const log: string[] = []
    const ph = phone(log, 'manual')
    const el = element(log)
    const a = att()
    audioPlayer.open(item(a, 'm_1'), src(a))
    await ph.answerAll()
    await el.run(2000)
    log.length = 0
    return { log, ph, el }
  }

  it("a call takes the audio: the 'pause' event sends nothing, and the clip is stopped for the row", async () => {
    const { log, el } = await playing()
    await el.interrupt()
    await el.run(100)
    expect(log).toEqual([])
    expect(getAudioState().playing).toBe(false)
  })

  it("the next Play after it sends 'playback' again", async () => {
    const { log, ph, el } = await playing()
    await el.interrupt()
    audioPlayer.resume()
    await ph.answerAll()
    expect(log).toEqual(['route:playback', 'play'])
  })

  it("stop() and a hand-over after it still release the route ('auto')", async () => {
    const one = await playing()
    await one.el.interrupt()
    audioPlayer.stop()
    expect(one.log).toContain('route:auto')
    cleanup()
    __resetAudioForTests()
    const two = await playing()
    await two.el.interrupt()
    audioPlayer.pause({ handOver: true })
    expect(two.log).toContain('route:auto')
  })

  it("the watch noticing a pause whose event never came sends nothing either ('tick')", async () => {
    const { log, el } = await playing()
    audioPlayer.seek(30) // arms the watch from here
    el.silentInterrupt()
    await el.run(STALL_MS * 2)
    expect(traces('interrupted').map((t) => t.detail)).toContain('tick')
    expect(log.filter((l) => l.startsWith('route:'))).toEqual([])
    expect(getAudioState().playing).toBe(false)
  })

  it('the clip ending is the element pausing itself: no paused call, only the release when nothing follows', async () => {
    const { log, ph, el } = await playing()
    await el.end()
    await ph.answerAll()
    expect(log.filter((l) => l.startsWith('route:'))).toEqual(['route:auto'])
  })

  it("the owner's own pause sends 'paused', and only after the element was paused", async () => {
    const { log, el } = await playing()
    audioPlayer.pause()
    await el.run(100)
    expect(log).toEqual(['el.pause', 'route:paused'])
  })

  it("the lock screen's pause is the owner's: 'paused' as well", async () => {
    const { log, ph, el } = await playing()
    ph.handlers().pause?.()
    await el.run(100)
    expect(log).toEqual(['el.pause', 'route:paused'])
  })

  it('a stale pause (the element still plays) sends nothing', async () => {
    const { log, el } = await playing()
    act(() => void el.a.dispatchEvent(new Event('pause')))
    await el.run(100)
    expect(log).toEqual([])
  })

  it("a give-up is ours: 'paused' is sent for it", async () => {
    const log: string[] = []
    phone(log, 'auto')
    const el = element(log)
    el.s.silent = true
    const a = att()
    audioPlayer.open(item(a), src(a))
    await advance(STALL_MS * 4)
    expect(traces('give-up')).toHaveLength(1)
    expect(log).toContain('route:paused')
  })
})

describe('the traces tell the order', () => {
  /** Plays at once on an iPhone whose native call answers `answerAfter` ms after the tap (null: never), then lets `later` ms pass. */
  async function startedThen(answerAfter: number | null, later: number) {
    const log: string[] = []
    const ph = phone(log, 'manual')
    const el = element(log)
    const a = att()
    audioPlayer.open(item(a), src(a))
    if (answerAfter !== null) {
      await advance(answerAfter)
      await ph.answerAll()
    } else await advance(CAP)
    await el.run(later)
    return { el, ph }
  }

  it('answered 60 ms after the tap: route, answer and play() ages, in a stale pause row', async () => {
    const { el } = await startedThen(60, 700)
    act(() => void el.a.dispatchEvent(new Event('pause')))
    const t = traces('interrupted').at(-1)
    expect(t?.detail).toBe('stale')
    expect(t?.order?.a).toBe(t?.order?.p) // answered and played in the same instant
    expect((t?.order?.r ?? 0) - (t?.order?.p ?? 0)).toBe(60)
    expect(t?.order?.p).toBe(700)
  })

  it('no answer, the cap let play() through: the answer reads cap', async () => {
    const { el } = await startedThen(null, 600)
    act(() => void el.a.dispatchEvent(new Event('pause')))
    const t = traces('interrupted').at(-1)
    expect(t?.order?.a).toBe('cap')
    expect((t?.order?.r ?? 0) - (t?.order?.p ?? 0)).toBe(CAP)
  })

  it('a browser (no native answer): the answer reads none, route and play() are the same age', async () => {
    const log: string[] = []
    phone(log, 'web')
    const el = element(log)
    const a = att()
    audioPlayer.open(item(a), src(a))
    await el.run(300)
    await el.interrupt()
    const t = traces('interrupted').at(-1)
    expect(t?.order).toBeDefined()
    expect(t?.order?.a).toBeUndefined()
    expect(t?.order?.r).toBe(t?.order?.p)
  })

  it('restart and give-up carry it, measured from the last play()', async () => {
    const log: string[] = []
    phone(log, 'auto')
    const el = element(log)
    el.s.silent = true
    const a = att()
    audioPlayer.open(item(a), src(a))
    await advance(STALL_MS * 4)
    const r = traces('restart')[0]
    const g = traces('give-up')[0]
    expect(r?.order).toEqual({ r: STALL_MS, a: STALL_MS, p: STALL_MS })
    expect(g?.order).toEqual({ r: STALL_MS, a: STALL_MS, p: STALL_MS })
  })

  it('a system pause the watch finds (tick) carries it', async () => {
    const log: string[] = []
    const ph = phone(log, 'manual')
    const el = element(log)
    const a = att()
    audioPlayer.open(item(a), src(a))
    await ph.answerAll()
    await el.run(2000)
    audioPlayer.seek(30) // arms the watch from here
    el.silentInterrupt()
    await el.run(STALL_MS * 2)
    const t = traces('interrupted').find((x) => x.detail === 'tick')
    expect(t?.order?.p).toBeGreaterThan(0)
  })

  it('other codes do not carry it', async () => {
    const log: string[] = []
    phone(log, 'auto')
    const el = element(log)
    el.a.play = () => Promise.reject(Object.assign(new Error('x'), { name: 'NotAllowedError' }))
    const a = att()
    audioPlayer.open(item(a), src(a))
    await advance(50)
    expect(traces('play-rejected')).toHaveLength(1)
    expect(traces('play-rejected')[0]).not.toHaveProperty('order')
  })
})

describe('after the order review: a restart that waits for the route', () => {
  /** A Play that took, then the position never moves: the watch restarts it, and the restart waits for the route. */
  async function inRestartWait() {
    const log: string[] = []
    const ph = phone(log, 'manual')
    const el = element(log)
    const a = att()
    render(<Row a={a} id="m_1" />)
    tap('Play')
    await ph.answerAll()
    await advance(50) // 'play' and 'playing' come, the position stays put
    expect(getAudioState().playing).toBe(true)
    await advance(STALL_MS) // the tick: pause, route call, wait
    expect(traces('restart')).toHaveLength(1)
    await advance(50) // the pause event of the restart lands and is not a stop
    return { log, ph, el, a }
  }

  it("the owner's Pause during the restart's wait puts the row on Play at once, and it stays there", async () => {
    const { ph } = await inRestartWait()
    expect(label()).toBe('Pause')
    tap('Pause')
    await ph.answerAll()
    await advance(STALL_MS * 4)
    expect(label()).toBe('Play')
    expect(getAudioState().playing).toBe(false)
    expect(audioPlayer.active()).toBe(false)
  })

  it("the owner's Pause on an element the system already paused (its event lost) puts the row on Play too", async () => {
    const log: string[] = []
    const ph = phone(log, 'manual')
    const el = element(log)
    render(<Row a={att()} id="m_1" />)
    tap('Play')
    await ph.answerAll()
    await el.run(2000)
    expect(label()).toBe('Pause')
    el.silentInterrupt() // paused, and no pause event ever comes
    tap('Pause')
    await el.run(200)
    expect(label()).toBe('Play')
    expect(getAudioState().playing).toBe(false)
  })

  it('a hand-over to Drive in that wait, then Drive giving the session back, asks the shell for nothing', async () => {
    const { log, ph } = await inRestartWait()
    audioPlayer.pause({ handOver: true })
    await ph.answerAll()
    await advance(STALL_MS * 2)
    log.length = 0
    audioPlayer.reclaimSession()
    expect(log).toEqual([])
    expect(getAudioState().playing).toBe(false)
  })
})

describe('after the order review: an earlier pause event is not the owner stopping the new Play', () => {
  it("Play, Pause, Play at once: the events of the first Play and Pause land in the last Play's wait, and it stands", async () => {
    const { ph, el } = await pausedMidClip('manual')
    audioPlayer.resume()
    await ph.answer() // play() is called, its 'play' event is a moment away
    expect(el.s.plays).toBe(1)
    audioPlayer.pause()
    audioPlayer.resume()
    await advance(20) // 'play', then 'pause', land during the wait
    expect(audioPlayer.active()).toBe(true)
    await ph.answerAll()
    await el.run(3000)
    expect(el.s.plays).toBe(2)
    expect(el.s.moving).toBe(true)
    expect(getAudioState().playing).toBe(true)
  })

  it("a system pause event that was on its way when the owner pressed the lock screen's Play does not cancel that Play", async () => {
    const { ph, el } = await pausedMidClip('manual')
    audioPlayer.resume()
    await ph.answerAll()
    await el.run(500)
    el.silentInterrupt() // the flag flipped, the event is still to come
    ph.handlers().play?.() // the owner presses Play
    act(() => void el.a.dispatchEvent(new Event('pause'))) // the old event lands in the wait
    await ph.answerAll()
    await el.run(3000)
    expect(el.s.moving).toBe(true)
    expect(getAudioState().playing).toBe(true)
  })

  it('but a pause the element really takes during a wait that began on a playing element is a stop', async () => {
    const { ph, el } = await pausedMidClip('manual')
    audioPlayer.resume()
    await ph.answerAll()
    await el.run(500)
    audioPlayer.resume() // Play on a clip the store says is playing: a new wait, the element plays
    const n = el.s.plays
    await el.interrupt() // a call
    await ph.answerAll()
    await el.run(3000)
    expect(el.s.plays).toBe(n)
    expect(getAudioState().playing).toBe(false)
  })
})

describe('after the order review: tapping Play again and again does not postpone the line', () => {
  /** Mashes Play every `period` ms on a clip that never takes (a silent play()), until the line shows: how long that was. */
  async function mash(period: number, answerAfter: number | null) {
    const log: string[] = []
    if (answerAfter === null) phone(log, 'manual')
    else
      setPlatform({
        ...webPlatform,
        audioSession: { set: () => new Promise<void>((r) => void setTimeout(r, answerAfter)) },
        mediaSession: { set: () => {}, clear: () => {}, controls: () => true },
      })
    element(log).s.silent = true
    const a = att()
    audioPlayer.open(item(a, 'm_1'), src(a))
    const t0 = Date.now()
    while (Date.now() - t0 < 60_000) {
      await advance(period)
      if (getAudioState().refused) return Date.now() - t0
      audioPlayer.resume()
    }
    return -1
  }
  // three tries (a restart, a reload, the last look), each a wait and a watch tick long, and one more tap period
  const within = (period: number) => 3 * (STALL_MS + CAP) + period

  for (const period of [200, 260, 300, 400, 750, 1500, 1600])
    it(`taps every ${period} ms, the shell never answers: the line is there in bounded time`, async () => {
      const ended = await mash(period, null)
      expect(ended).toBeGreaterThan(0)
      expect(ended).toBeLessThanOrEqual(within(period))
    })

  for (const answerAfter of [40, 150])
    for (const period of [300, 500, 750, 1500])
      it(`taps every ${period} ms, the shell answers after ${answerAfter} ms: the same`, async () => {
        const ended = await mash(period, answerAfter)
        expect(ended).toBeGreaterThan(0)
        expect(ended).toBeLessThanOrEqual(within(period))
      })

  it("a joining tap's play() does not move the watch's clock: the first rung comes 1.5 s after the first play()", async () => {
    const log: string[] = []
    phone(log, 'manual')
    const el = element(log)
    el.s.silent = true
    const a = att()
    audioPlayer.open(item(a), src(a))
    await advance(CAP) // play() 1; the watch counts from here
    await advance(750)
    audioPlayer.resume() // joins the try in progress: a wait of its own, and play() 2 at the cap
    await advance(CAP)
    expect(el.s.plays).toBe(2)
    await advance(STALL_MS - 750 - CAP + 50) // 1.5 s after play() 1
    expect(traces('restart')).toHaveLength(1)
  })
})

describe('after the order review: the unsized WebM fix in the wait', () => {
  it('metadata that says Infinity lands while the start waits for the route: play() waits for the fix, then plays once', async () => {
    const log: string[] = []
    const ph = phone(log, 'manual')
    const el = element(log)
    let dur = Number.POSITIVE_INFINITY
    Object.defineProperty(el.a, 'duration', { configurable: true, get: () => dur })
    const a = att()
    audioPlayer.open(item(a, 'm_1'), src(a))
    await advance(20)
    act(() => void el.a.dispatchEvent(new Event('loadedmetadata'))) // the fix: a jump to the end, paused
    await ph.answer()
    await advance(CAP * 2)
    expect(el.s.plays).toBe(0) // a clip that plays through the jump to its end would end
    dur = 120
    act(() => void el.a.dispatchEvent(new Event('timeupdate'))) // the jump landed
    await ph.answerAll()
    await el.run(1000)
    expect(el.s.plays).toBe(1)
    expect(getAudioState()).toMatchObject({ playing: true, refused: false })
    expect(getAudioState().item).not.toBeNull()
  })
})

describe('after the order review: the sleep check', () => {
  const sleep = (ms: number) => vi.setSystemTime(Date.now() + ms)

  it("a tap 9.9 s into a wait renews it: the answer 150 ms later is the owner's, not a sleeper's", async () => {
    const { ph, el } = await pausedMidClip('manual')
    audioPlayer.resume()
    sleep(SUSPENDED_MS - 100)
    audioPlayer.resume() // joins
    sleep(150)
    await ph.answerAll()
    await el.run(1000)
    expect(el.s.plays).toBe(1)
    expect(getAudioState()).toMatchObject({ playing: true, refused: false })
  })

  it('a clip that is moving is never stopped by a late answer: the clock jump is not a sleep it took', async () => {
    const { ph, el } = await pausedMidClip('manual')
    audioPlayer.resume()
    await ph.answerAll()
    await el.run(3000)
    audioPlayer.resume() // Play on a clip that is playing: a wait, the element goes on
    await el.run(200) // moving, and the cap has not come yet
    sleep(SUSPENDED_MS + 1000)
    await ph.answerAll()
    await el.run(500)
    expect(el.s.paused).toBe(false)
    expect(el.s.moving).toBe(true)
    expect(getAudioState()).toMatchObject({ playing: true, refused: false })
  })

  it('what the owner tapped last gets its onRefused, also when it joined a wait', async () => {
    const log: string[] = []
    phone(log, 'manual')
    const el = element(log)
    el.a.play = () => Promise.reject(Object.assign(new Error('x'), { name: 'NotAllowedError' }))
    const a = att()
    const it = item(a, 'm_1')
    const refused = vi.fn()
    audioPlayer.open(it, src(a), [], { play: true })
    audioPlayer.open(it, src(a), [], { play: true, onRefused: refused }) // the same clip: joins the wait
    await advance(CAP + 50)
    expect(refused).toHaveBeenCalledTimes(1)
  })
})

describe('after the order review: what the trace says about a start that went on without an answer', () => {
  const staleEvent = (el: ReturnType<typeof element>) => act(() => void el.a.dispatchEvent(new Event('pause')))

  it('the watch let it through (no cap, no answer): the answer reads cap', async () => {
    const { ph, el } = await pausedMidClip('manual')
    visibility('hidden')
    const real = globalThis.setTimeout
    vi.spyOn(globalThis, 'setTimeout').mockImplementation(((fn: () => void, ms?: number, ...rest: unknown[]) =>
      ms === CAP ? (0 as never) : real(fn, ms, ...rest)) as never)
    ph.handlers().play?.()
    await el.run(STALL_MS * 2)
    expect(el.s.plays).toBe(1)
    staleEvent(el)
    expect(traces('interrupted').at(-1)?.order?.a).toBe('cap')
  })

  it("an older start's late answer is not the new start's answer", async () => {
    const log: string[] = []
    const ph = phone(log, 'manual')
    const el = element(log)
    const a = att()
    const b = att()
    audioPlayer.open(item(a), src(a))
    audioPlayer.open(item(b), src(b))
    await advance(CAP) // the second start goes on without an answer
    expect(el.s.plays).toBe(1)
    await ph.answer(0) // the first start's route call is answered at last
    await el.run(200)
    staleEvent(el)
    expect(traces('interrupted').at(-1)?.order?.a).toBe('cap')
  })

  it('a start that has not called play() yet reads none for play(), whatever an earlier start did', async () => {
    const { ph, el } = await pausedMidClip('manual')
    audioPlayer.resume()
    vi.setSystemTime(Date.now() + SUSPENDED_MS + 1000) // the sleep ends the wait before play()
    await ph.answer()
    expect(el.s.plays).toBe(0)
    const t = traces('interrupted').at(-1)
    expect(t?.detail).toBe('tick')
    expect(t?.order?.r).toBeGreaterThan(0)
    expect(t?.order?.p).toBeUndefined()
  })
})

describe('after the fix check: the WebM fix is not a tap, and a start in the wait that the element made', () => {
  it('a clip that never moves and whose fix lands on every load still ends in the line (restart and reload each land a fix)', async () => {
    for (const kind of ['manual', 'auto', 'web'] as const) {
      __resetAudioForTests()
      const log: string[] = []
      phone(log, kind)
      const el = element(log)
      let dur = Number.POSITIVE_INFINITY
      Object.defineProperty(el.a, 'duration', { configurable: true, get: () => dur })
      const load = el.a.load
      el.a.load = () => {
        load.call(el.a)
        dur = Number.POSITIVE_INFINITY
        el.s.t = 0
        setTimeout(() => void el.a.dispatchEvent(new Event('loadedmetadata')), 5)
        setTimeout(() => {
          dur = 120
          el.a.dispatchEvent(new Event('timeupdate'))
        }, 40)
      }
      audioPlayer.open(item(att(), 'm_1'), '/x')
      const t0 = Date.now()
      let ended = -1
      while (Date.now() - t0 < 60_000) {
        await advance(100)
        if (getAudioState().refused) {
          ended = Date.now() - t0
          break
        }
      }
      expect(ended, kind).toBeGreaterThan(0)
      expect(ended, kind).toBeLessThanOrEqual(4 * (STALL_MS + CAP + 100))
    }
  })

  it('the element starts by itself in the wait, and a real pause (a call) then lands in the same wait: that Play is over', async () => {
    const { ph, el } = await pausedMidClip('manual')
    audioPlayer.resume()
    el.s.paused = false
    el.s.moving = true
    act(() => void el.a.dispatchEvent(new Event('play')))
    act(() => void el.a.dispatchEvent(new Event('playing')))
    await el.run(100)
    await el.interrupt()
    const n = el.s.plays
    await ph.answerAll()
    await el.run(2000)
    expect(el.s.plays).toBe(n)
    expect(getAudioState().playing).toBe(false)
    expect(audioPlayer.active()).toBe(false)
  })
})

describe('after the fix check: what the surviving mutants need', () => {
  const dropCap = () => {
    const real = globalThis.setTimeout
    vi.spyOn(globalThis, 'setTimeout').mockImplementation(((fn: () => void, ms?: number, ...rest: unknown[]) =>
      ms === CAP ? (0 as never) : real(fn, ms, ...rest)) as never)
  }

  it("the watch's tick that ends a wait by the sleep check leaves nothing wanted, and judges nothing after it", async () => {
    const { ph, el } = await pausedMidClip('manual')
    el.s.silent = true
    dropCap()
    audioPlayer.resume()
    await ph.answerAll() // wait 1 ends by the answer: play() 1, the watch counts from here
    expect(el.s.plays).toBe(1)
    await advance(100)
    audioPlayer.resume() // joins the try in progress: a wait of its own (the cap is held back), it does not own the watch
    await advance(700)
    audioPlayer.seek(50) // re-arms the watch, later than the wait began
    vi.setSystemTime(Date.now() + 8000)
    await advance(STALL_MS + 50) // the tick: the watch is not overdue, the wait (older) is
    expect(el.s.plays).toBe(1)
    expect(audioPlayer.active()).toBe(false)
    expect(getAudioState()).toMatchObject({ playing: false, refused: true })
    expect(traces('restart')).toHaveLength(0)
    await el.run(STALL_MS * 3)
    expect(el.s.plays).toBe(1)
  })

  it('a late answer after a sleep stops an element that is not paused but has not moved since the wait began', async () => {
    const { ph, el } = await pausedMidClip('manual')
    audioPlayer.resume()
    await ph.answerAll()
    await el.run(300)
    el.s.moving = false // frozen, though not paused
    audioPlayer.resume() // a wait
    await advance(100)
    const n = el.s.plays
    vi.setSystemTime(Date.now() + SUSPENDED_MS + 1000)
    await ph.answerAll()
    expect(el.s.paused).toBe(true)
    expect(el.s.plays).toBe(n)
    expect(getAudioState().playing).toBe(false)
    expect(audioPlayer.active()).toBe(false)
  })

  it('opening another clip without playing it clears the sleep flag: an element that starts by itself is then followed', async () => {
    const { ph, el } = await pausedMidClip('manual')
    audioPlayer.resume()
    vi.setSystemTime(Date.now() + SUSPENDED_MS + 1000)
    await ph.answerAll()
    expect(getAudioState().refused).toBe(true)
    const b = att()
    audioPlayer.open(item(b, 'm_2'), src(b), [], { play: false })
    el.s.paused = false
    el.s.moving = true
    act(() => void el.a.dispatchEvent(new Event('play')))
    act(() => void el.a.dispatchEvent(new Event('playing')))
    await el.run(300)
    expect(getAudioState().playing).toBe(true)
    expect(el.s.paused).toBe(false)
  })

  it('stop() clears the sleep flag: a play event after it, with nothing loaded, does not put up the refused line', async () => {
    const { ph, el } = await pausedMidClip('manual')
    audioPlayer.resume()
    vi.setSystemTime(Date.now() + SUSPENDED_MS + 1000)
    await ph.answerAll()
    expect(getAudioState().refused).toBe(true)
    audioPlayer.stop()
    await advance(20)
    el.s.paused = false
    act(() => void el.a.dispatchEvent(new Event('play')))
    await advance(20)
    expect(getAudioState().refused).toBe(false)
  })

  it('Pause on a clip that is loading (playing by the store, not paused) leaves playing to the pause event', async () => {
    const log: string[] = []
    const ph = phone(log, 'manual')
    const el = element(log)
    audioPlayer.open(item(att(), 'm_1'), '/x')
    await ph.answerAll()
    await el.run(300)
    Object.defineProperty(el.a, 'readyState', { configurable: true, get: () => 2 }) // no data: loading
    el.s.moving = false
    audioPlayer.seek(30) // arms the watch
    await el.run(STALL_MS + 100)
    expect(getAudioState()).toMatchObject({ playing: true, buffering: true })
    audioPlayer.pause()
    expect(getAudioState()).toMatchObject({ playing: true, buffering: false }) // the element's pause event says the rest
    await el.run(100)
    expect(getAudioState().playing).toBe(false)
  })
})
