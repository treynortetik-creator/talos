// @vitest-environment jsdom
// The owner's phone as the instrument: a failed or stalled audio start leaves one compact entry in Problems, made of codes and
// numbers, and never a file name, URL, message text or thread name. Real player, real Problems controller; only the network
// post, the clock and jsdom's missing media are stubbed.
import { newId, newUlid, PROBLEM_LIMITS, type ProblemT } from '@talos-app/protocol'
import { act } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createStore } from 'zustand/vanilla'
import {
  __resetAudioTraceForTests,
  AudioTraceLimiter,
  buildAudioTrace,
  platformOf,
  STALL_TRACE_MS,
  screenKind,
  sizeBucket,
  TRACE_PER_MINUTE,
  withAudioTrace,
} from '../../src/features/problems/audioTrace.ts'
import { problemFromError } from '../../src/features/problems/capture.ts'
import { installProblems, problems, uninstallProblems } from '../../src/features/problems/controller.ts'
import { ProblemQueue } from '../../src/features/problems/queue.ts'
import { __resetAudioForTests, audioElement, audioPlayer, STALL_MS } from '../../src/features/threads/audioPlayer.ts'
import type { TalosClient } from '../../src/lib/client.ts'
import { createMemoryStorage } from '../../src/lib/storage.ts'

const SECRET_NAME = 'quarterly-board-numbers.mp3'
const SECRET_URL_BIT = 'md_SECRETMEDIAID0000000000'
const IOS_UA =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 TalosIOS/1.0+1'

let posted: ProblemT[] = []
let clockMs = 0
let playImpl: () => Promise<void>
let plays = 0

beforeEach(() => {
  vi.useFakeTimers()
  clockMs = 1_700_000_000_000
  vi.setSystemTime(clockMs)
  posted = []
  plays = 0
  playImpl = () => Promise.resolve()
  localStorage.clear()
  __resetAudioForTests()
  __resetAudioTraceForTests(() => Date.now())
  history.pushState({}, '', '/t/th_SECRETTHREADID')
  vi.spyOn(HTMLMediaElement.prototype, 'play').mockImplementation(function (this: HTMLMediaElement) {
    plays++
    this.dispatchEvent(new Event('play'))
    return playImpl()
  })
  vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(function (this: HTMLMediaElement) {
    this.dispatchEvent(new Event('pause'))
  })
  vi.spyOn(HTMLMediaElement.prototype, 'load').mockImplementation(() => {})
  vi.stubGlobal('navigator', { ...globalThis.navigator, userAgent: IOS_UA })
  installProblems({
    storage: createMemoryStorage(),
    client: {
      store: createStore(() => ({ connection: 'offline' })),
      uploadMedia: async () => ({}),
    } as unknown as TalosClient,
    post: async (p) => {
      posted.push(p)
      return { ok: true }
    },
    target: new EventTarget() as never,
  })
})
afterEach(() => {
  uninstallProblems()
  __resetAudioForTests()
  vi.useRealTimers()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

const item = () => ({
  key: newId('m'),
  mediaId: SECRET_URL_BIT,
  title: SECRET_NAME,
  mime: 'audio/mp4',
  size: 3 * 1024 * 1024,
})
const open = () => audioPlayer.open(item(), `/media/${SECRET_URL_BIT}?c=2`)
const settle = async () => {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(5)
  })
}
const traces = () => posted.filter((p) => p.name.startsWith('Audio trace'))

/** Nothing a person wrote or named, and no address, in the whole entry. */
function expectNoContent(p: ProblemT) {
  const all = JSON.stringify(p)
  for (const bad of [SECRET_NAME, 'quarterly', SECRET_URL_BIT, 'th_SECRETTHREADID', '/media/', 'http', '?c=2'])
    expect(all, `entry must not contain ${bad}`).not.toContain(bad)
  expect(p.kind).toBe('auto')
  expect(p.frames).toEqual([])
  expect(p.message.length).toBeLessThan(300)
}

describe('each trigger records one readable entry', () => {
  it('a rejected play(): the error name, the element state, the file type and size bucket, platform, native or web', async () => {
    playImpl = () => Promise.reject(Object.assign(new Error('x'), { name: 'NotAllowedError' }))
    open()
    await settle()
    expect(traces()).toHaveLength(1)
    const p = traces()[0] as ProblemT
    expect(p.name).toBe('Audio trace: play-rejected')
    expect(p.message).toMatch(
      /ev=play-rejected detail=NotAllowedError merr=- rs=\d ns=\d paused=\d t=\d+ rate=1 restarts=0 screen=thread mime=audio\/mp4 size=1m-10m plat=ios17\.5\/webkit605 shell=web/,
    )
    expectNoContent(p)
  })

  it('the stall self-heal: one entry for the restart, one for the give-up, with the restart count', async () => {
    open()
    const a = audioElement()
    Object.defineProperty(a, 'paused', { configurable: true, get: () => false })
    Object.defineProperty(a, 'readyState', { configurable: true, get: () => 4 })
    Object.defineProperty(a, 'currentTime', { configurable: true, get: () => 0 })
    for (let i = 0; i < 3; i++) {
      act(() => void a.dispatchEvent(new Event('playing')))
      await act(async () => {
        await vi.advanceTimersByTimeAsync(STALL_MS + 10)
      })
    }
    await settle()
    const names = traces().map((p) => p.name)
    expect(names).toContain('Audio trace: restart')
    expect(names).toContain('Audio trace: give-up')
    const gaveUp = traces().find((p) => p.name.endsWith('give-up')) as ProblemT
    expect(gaveUp.message).toContain('restarts=2')
    for (const p of traces()) expectNoContent(p)
  })

  it("the element's own error: the MediaError code", async () => {
    open()
    Object.defineProperty(audioElement(), 'error', { configurable: true, get: () => ({ code: 4 }) })
    act(() => void audioElement().dispatchEvent(new Event('error')))
    await settle()
    const p = traces()[0] as ProblemT
    expect(p.name).toBe('Audio trace: media-error')
    expect(p.message).toContain('merr=4')
    expectNoContent(p)
  })

  it('a `waiting` that lasts past the limit, and not one that ends sooner', async () => {
    open()
    const a = audioElement()
    Object.defineProperty(a, 'paused', { configurable: true, get: () => false })
    Object.defineProperty(a, 'readyState', { configurable: true, get: () => 2 })
    act(() => void a.dispatchEvent(new Event('waiting')))
    await act(async () => {
      await vi.advanceTimersByTimeAsync(STALL_TRACE_MS - 100)
    })
    act(() => void a.dispatchEvent(new Event('playing'))) // it came back in time
    await act(async () => {
      await vi.advanceTimersByTimeAsync(STALL_TRACE_MS)
    })
    expect(traces()).toHaveLength(0)
    act(() => void a.dispatchEvent(new Event('stalled')))
    await act(async () => {
      await vi.advanceTimersByTimeAsync(STALL_TRACE_MS + 10)
    })
    await settle()
    const p = traces()[0] as ProblemT
    expect(p.message).toContain('ev=stalled-long detail=stalled merr=- rs=2')
    expectNoContent(p)
  })

  it('a pause nobody asked for while playing (a call, Siri, another app) is an interruption; our own pause is not', async () => {
    open()
    act(() => audioPlayer.pause())
    await settle()
    expect(traces()).toHaveLength(0)
    act(() => audioPlayer.resume())
    act(() => void audioElement().dispatchEvent(new Event('pause'))) // the system, not us
    await settle()
    const p = traces()[0] as ProblemT
    expect(p.name).toBe('Audio trace: interrupted')
    expectNoContent(p)
  })

  it('the audio session says interrupted (WebKit): one entry', async () => {
    const session = Object.assign(new EventTarget(), { state: 'active' })
    vi.stubGlobal('navigator', { userAgent: IOS_UA, audioSession: session })
    __resetAudioForTests()
    open()
    session.state = 'interrupted'
    session.dispatchEvent(new Event('statechange'))
    await settle()
    expect(traces().map((p) => p.name)).toEqual(['Audio trace: session-interrupted'])
  })
})

describe('what the entry holds', () => {
  const env = {
    versions: { app: '1.0' },
    device: 'iphone_app' as const,
    routes: ['home', 'thread'],
    now: () => 1_700_000_000_000,
  }
  it('screen kind keeps only thread, card or other', () => {
    expect(screenKind('/t/th_abc')).toBe('thread')
    expect(screenKind('/card/c_abc')).toBe('card')
    expect(screenKind('/settings/devices')).toBe('other')
    expect(screenKind(undefined)).toBe('other')
  })
  it('size buckets and platform versions', () => {
    expect([10, 200_000, 2_000_000, 50_000_000, undefined].map(sizeBucket)).toEqual([
      'lt100k',
      '100k-1m',
      '1m-10m',
      'gt10m',
      'unknown',
    ])
    expect(platformOf(IOS_UA)).toBe('ios17.5 webkit605')
    expect(
      platformOf('Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 Chrome/126.0.0.0 Mobile Safari/537.36'),
    ).toBe('android14 chrome126')
    expect(
      platformOf('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Version/17.5 Safari/605.1.15'),
    ).toBe('mac webkit605')
  })
  it('a hostile detail or MIME cannot carry content into the entry', () => {
    const p = buildAudioTrace(
      {
        code: 'play-rejected',
        detail: 'see https://evil.example/x?token=abc and my_notes.txt',
        mime: 'text/x; name=secret.txt',
      },
      env,
      IOS_UA,
      true,
    )
    expect(p.message).toContain('detail=other')
    expect(p.message).toContain('mime=other')
    expect(p.message).toContain('shell=native')
    expect(p.message).not.toContain('evil')
    expect(p.message).not.toContain('secret')
  })
})

describe('the order of the route call and play(), in ms since each', () => {
  const env = {
    versions: { app: '1.0' },
    device: 'iphone_app' as const,
    routes: ['home'],
    now: () => 1_700_000_000_000,
  }
  const msg = (order: unknown, code: 'interrupted' | 'give-up' | 'restart' = 'interrupted') =>
    buildAudioTrace({ code, detail: 'stale', order } as never, env, IOS_UA, true).message

  it('is r-<route call>/a-<answer>/p-<play()>, after the restart count', () => {
    const m = msg({ r: 812, a: 640, p: 640 })
    expect(m).toContain('restarts=0 order=r-812/a-640/p-640 screen=')
  })
  it('says cap when the cap let play() through, and none for what did not happen', () => {
    expect(msg({ r: 812, a: 'cap', p: 562 })).toContain('order=r-812/a-cap/p-562')
    expect(msg({ r: 5, p: 5 })).toContain('order=r-5/a-none/p-5')
    expect(msg({ r: 5 })).toContain('order=r-5/a-none/p-none')
    expect(msg({})).toContain('order=r-none/a-none/p-none')
  })
  it('is left out when the player passes none (the other codes), so old lines read as before', () => {
    const m = buildAudioTrace({ code: 'play-rejected' }, env, IOS_UA, true).message
    expect(m).not.toContain('order=')
  })
  it('rounds, clamps, and turns anything that is not a number into none: it can carry nothing else', () => {
    expect(msg({ r: 811.6, a: 0.4, p: 3 })).toContain('order=r-812/a-0/p-3')
    expect(msg({ r: -5, a: 99_999_999, p: 1 })).toContain('order=r-0/a-999999/p-1')
    const hostile = msg({
      r: Number.NaN,
      a: 'https://evil.example/x?token=abc',
      p: Number.POSITIVE_INFINITY,
      extra: 'my_notes.txt',
    })
    expect(hostile).toContain('order=r-none/a-none/p-none')
    expect(msg({ r: '12', a: [5], p: { x: 1 } })).toContain('order=r-none/a-none/p-none') // only numbers count
    expect(hostile).not.toContain('evil')
    expect(hostile).not.toContain('notes')
  })
  it('the scrubber leaves it whole, and the largest line stays under the message cap', () => {
    for (const code of ['interrupted', 'give-up', 'restart'] as const) {
      const p = buildAudioTrace(
        {
          code,
          detail: 'a'.repeat(39),
          mediaError: 4,
          readyState: 4,
          networkState: 3,
          paused: false,
          currentTime: 1e9,
          playbackRate: 1.25,
          restarts: 2,
          mime: 'audio/x-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
          size: 5e9,
          pathname: '/t/th_x',
          order: { r: 99_999_999, a: 99_999_999, p: 99_999_999 },
        },
        env,
        'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148',
        true,
      )
      expect(p.message).toContain('order=r-999999/a-999999/p-999999')
      expect(p.truncated).toBe(false)
      expect(p.message.length).toBeLessThan(PROBLEM_LIMITS.messageChars)
    }
  })
  it('the player records it for a pause nobody asked for, a restart and a give-up; not for a rejected play()', async () => {
    open()
    await settle()
    act(() => void audioElement().dispatchEvent(new Event('pause'))) // the system, not us
    await settle()
    expect(traces().map((p) => p.name)).toEqual(['Audio trace: interrupted'])
    expect((traces()[0] as ProblemT).message).toMatch(/restarts=0 order=r-\d+\/a-none\/p-\d+ screen=/)
    await act(async () => {
      await vi.advanceTimersByTimeAsync(61_000)
    })
    posted = []
    open()
    const a = audioElement()
    Object.defineProperty(a, 'paused', { configurable: true, get: () => false })
    Object.defineProperty(a, 'readyState', { configurable: true, get: () => 4 })
    Object.defineProperty(a, 'currentTime', { configurable: true, get: () => 0 })
    for (let i = 0; i < 3; i++) {
      act(() => void a.dispatchEvent(new Event('playing')))
      await act(async () => {
        await vi.advanceTimersByTimeAsync(STALL_MS + 10)
      })
    }
    await settle()
    for (const name of ['Audio trace: restart', 'Audio trace: give-up'])
      expect((traces().find((p) => p.name === name) as ProblemT).message, name).toMatch(/order=r-\d+\/a-none\/p-\d+ /)
  })
})

describe('Report a problem carries the recent trace', () => {
  it('the owner note gets the last lines after it, inside the cap; with no trace it is untouched', async () => {
    expect(withAudioTrace('my note')).toBe('my note')
    playImpl = () => Promise.reject(Object.assign(new Error('x'), { name: 'NotAllowedError' }))
    open()
    await settle()
    const out = withAudioTrace('x'.repeat(5000))
    expect(out.length).toBeLessThanOrEqual(2000)
    expect(out).toContain('ev=play-rejected detail=NotAllowedError')
    expect(out).not.toContain(SECRET_NAME)
  })
})

describe('traces never push real reports out', () => {
  const env = {
    versions: { app: '1.0' },
    device: 'iphone_app' as const,
    routes: ['home'],
    now: () => 1_700_000_000_000,
  }
  it('10 traces and 1 real error queued offline: the error survives and at most 3 traces wait, the newest ones', async () => {
    const queue = new ProblemQueue(createMemoryStorage())
    const real = problemFromError(new TypeError('boom'), { origin: 'http://x', ...env })
    await queue.add(real, 1)
    for (let i = 0; i < 10; i++)
      await queue.add(
        buildAudioTrace(
          { code: 'play-rejected', detail: `N${i}`.replace(/\d/g, 'x') },
          { ...env, now: () => 1_000 + i },
          IOS_UA,
          false,
        ),
        10 + i,
      )
    const rows = await queue.rows()
    expect(rows.map((r) => r.problem.id)).toContain(real.id)
    expect(rows.filter((r) => r.problem.name.startsWith('Audio trace'))).toHaveLength(3)
    expect(rows).toHaveLength(4)
    expect(queue.dropped).toBe(7)
  })

  it('a full queue loses traces before errors', async () => {
    const queue = new ProblemQueue(createMemoryStorage())
    const first = problemFromError(new TypeError('first'), { origin: 'http://x', ...env })
    await queue.add(first, 1)
    for (let i = 0; i < 3; i++) await queue.add(buildAudioTrace({ code: 'restart' }, env, IOS_UA, false), 5 + i)
    for (let i = 0; i < 49; i++) {
      const p = { ...problemFromError(new TypeError(`e${i}`), { origin: 'http://x', ...env }), id: newUlid() }
      await queue.add(p, 100 + i)
    }
    const rows = await queue.rows()
    expect(rows.map((r) => r.problem.id)).toContain(first.id) // the oldest real error was not the one dropped
    expect(rows.filter((r) => r.problem.kind === 'auto' && !r.problem.name.startsWith('Audio trace'))).toHaveLength(50)
  })

  it('traces count against the same per-session cap as other automatic reports', async () => {
    const ctl = problems()
    if (!ctl) throw new Error('no controller')
    ctl.throttle.sent = PROBLEM_LIMITS.perSession - 1
    playImpl = () => Promise.reject(Object.assign(new Error('x'), { name: 'NotAllowedError' }))
    open()
    await settle()
    expect(traces()).toHaveLength(1) // the last slot
    expect(ctl.throttle.sent).toBe(PROBLEM_LIMITS.perSession)
    await act(async () => {
      await vi.advanceTimersByTimeAsync(61_000)
    })
    open()
    await settle()
    expect(traces()).toHaveLength(1) // the cap is shared: no more
    expect(ctl.throttle.held).toBeGreaterThan(0)
  })
})

describe('rate limit', () => {
  it('the same event once a minute; five a minute in all; held ones are counted', async () => {
    // the same code again within a minute: dropped; after a minute: recorded
    playImpl = () => Promise.reject(Object.assign(new Error('x'), { name: 'NotAllowedError' }))
    for (let i = 0; i < 4; i++) {
      open()
      await settle()
    }
    expect(traces()).toHaveLength(1)
    await act(async () => {
      await vi.advanceTimersByTimeAsync(61_000)
    })
    open()
    await settle()
    expect(traces()).toHaveLength(2)
  })

  it('limiter: at most TRACE_PER_MINUTE across codes, then room again after the minute', () => {
    let t = 0
    const l = new AudioTraceLimiter(() => t)
    const codes = ['a', 'b', 'c', 'd', 'e', 'f', 'g']
    const allowed = codes.filter((c) => l.allow(c))
    expect(allowed).toHaveLength(TRACE_PER_MINUTE)
    expect(l.held).toBe(codes.length - TRACE_PER_MINUTE)
    t = 61_000
    expect(l.allow('f')).toBe(true)
  })

  it('a clock that went backwards does not mute the trace', () => {
    let t = 1_000_000
    const l = new AudioTraceLimiter(() => t)
    expect(l.allow('a')).toBe(true)
    t = 10 // jumped back
    expect(l.allow('a')).toBe(true)
  })

  it('does nothing, quietly, when no Problems controller is installed', async () => {
    uninstallProblems()
    playImpl = () => Promise.reject(Object.assign(new Error('x'), { name: 'NotAllowedError' }))
    expect(() => open()).not.toThrow()
    await settle()
    expect(posted).toHaveLength(0)
  })
})
