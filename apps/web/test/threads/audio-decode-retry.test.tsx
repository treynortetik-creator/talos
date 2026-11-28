// @vitest-environment jsdom
// An iPhone decode error (MediaError code 3) can hit a clip whose bytes are fine (the source decodes cleanly elsewhere): the
// player loads the same source once more at the spot it reached and carries on if the owner was listening. A second code 3
// shows the usual failure line. It never loops. jsdom loads no media: play/pause/load are stubs and the error is staged by hand.
import { type AttachmentRefT, newId } from '@talos-app/protocol'
import { act } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { recordAudioTrace } from '../../src/features/problems/audioTrace.ts'
import {
  __resetAudioForTests,
  audioElement,
  audioPlayer,
  getAudioState,
} from '../../src/features/threads/audioPlayer.ts'
import { type AudioSessionType, setPlatform, webPlatform } from '../../src/lib/platform.ts'

vi.mock('../../src/features/problems/audioTrace.ts', async (orig) => ({
  ...(await orig<typeof import('../../src/features/problems/audioTrace.ts')>()),
  recordAudioTrace: vi.fn(),
}))

const att = (): AttachmentRefT => ({
  media_id: newId('md'),
  kind: 'audio',
  role: 'attachment',
  mime: 'audio/mpeg',
  name: 'take.mp3',
  size: 3,
  sha256: 'a'.repeat(64),
})
const clip = (a: AttachmentRefT, key = newId('m')) => ({ key, mediaId: a.media_id, title: a.name, durationMs: 0 })
const srcOf = (a: AttachmentRefT) => `/media/${a.media_id}?c=2`

let plays = 0
const going = new WeakSet<HTMLMediaElement>()
let loads = 0
let loadedSrcs: string[] = []
beforeEach(() => {
  localStorage.clear()
  __resetAudioForTests()
  plays = 0
  loads = 0
  loadedSrcs = []
  vi.spyOn(HTMLMediaElement.prototype, 'paused', 'get').mockImplementation(function (this: HTMLMediaElement) {
    return !going.has(this)
  })
  vi.spyOn(HTMLMediaElement.prototype, 'play').mockImplementation(function (this: HTMLMediaElement) {
    plays++
    going.add(this)
    this.dispatchEvent(new Event('play'))
    return Promise.resolve()
  })
  vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(function (this: HTMLMediaElement) {
    going.delete(this)
    this.dispatchEvent(new Event('pause'))
  })
  vi.spyOn(HTMLMediaElement.prototype, 'load').mockImplementation(function (this: HTMLMediaElement) {
    loads++
    loadedSrcs.push(this.getAttribute('src') ?? '')
  })
})
afterEach(() => {
  vi.useRealTimers()
  __resetAudioForTests()
  vi.restoreAllMocks()
  setPlatform(webPlatform)
  localStorage.clear()
})

/** The element reports a 200 s clip, `at` seconds in; `fail(code)` raises the element's own error event with that MediaError code. */
function fakeMedia(at: number) {
  const a = audioElement()
  const clock = { t: at, code: 0 }
  Object.defineProperty(a, 'duration', { configurable: true, get: () => 200 })
  Object.defineProperty(a, 'readyState', { configurable: true, get: () => 4 })
  Object.defineProperty(a, 'currentTime', {
    configurable: true,
    get: () => clock.t,
    set: (v: number) => {
      clock.t = v
    },
  })
  Object.defineProperty(a, 'error', { configurable: true, get: () => (clock.code ? { code: clock.code } : null) })
  return {
    a,
    meta: () => act(() => void a.dispatchEvent(new Event('loadedmetadata'))),
    fail: (code: number) => {
      clock.code = code
      act(() => void a.dispatchEvent(new Event('error')))
    },
    pos: () => clock.t,
  }
}

async function startPlaying(a: AttachmentRefT, at = 12) {
  const m = fakeMedia(0)
  await act(async () => audioPlayer.open(clip(a), srcOf(a), [], { play: true }))
  m.meta()
  m.a.currentTime = at // the clip has played up to here
  return m
}

describe('a decode error (MediaError code 3) on a playing clip', () => {
  it('loads the same source once more at the spot it reached, and plays on', async () => {
    vi.useFakeTimers()
    const a = att()
    const m = await startPlaying(a, 12)
    const loadsBefore = loads
    const playsBefore = plays
    m.fail(3)
    expect(loads).toBe(loadsBefore + 1) // one more load
    expect(loadedSrcs.at(-1)).toBe(srcOf(a)) // of the same source, never another one
    expect(getAudioState().failed).toBe(false)
    m.meta() // the browser has the metadata again: the jump back to where it stopped
    expect(m.pos()).toBe(12)
    await act(async () => void vi.advanceTimersByTimeAsync(50))
    expect(plays).toBeGreaterThan(playsBefore) // the owner was listening: it resumes
    expect(getAudioState().playing).toBe(true)
  })

  it('a second code 3 shows the failure line and does not load again', async () => {
    vi.useFakeTimers()
    const a = att()
    const m = await startPlaying(a, 12)
    m.fail(3)
    m.meta()
    await act(async () => void vi.advanceTimersByTimeAsync(50))
    const loadsAfterRetry = loads
    m.fail(3)
    expect(getAudioState().failed).toBe(true)
    expect(getAudioState().playing).toBe(false)
    expect(loads).toBe(loadsAfterRetry)
  })

  it('never loops: a run of code 3 errors costs one reload in all', async () => {
    vi.useFakeTimers()
    const a = att()
    const m = await startPlaying(a, 12)
    const loadsBefore = loads
    for (let i = 0; i < 6; i++) m.fail(3)
    await act(async () => void vi.advanceTimersByTimeAsync(5000))
    expect(loads - loadsBefore).toBe(1)
  })

  it('a clip that was paused is reloaded at its spot but not started', async () => {
    vi.useFakeTimers()
    const a = att()
    const m = await startPlaying(a, 12)
    await act(async () => audioPlayer.pause())
    const playsBefore = plays
    const loadsBefore = loads
    m.fail(3)
    expect(loads).toBe(loadsBefore + 1)
    await act(async () => void vi.advanceTimersByTimeAsync(2000))
    expect(plays).toBe(playsBefore)
    expect(getAudioState().playing).toBe(false)
  })

  it("the retry is the clip's own: another clip loaded after a failure gets its own", async () => {
    vi.useFakeTimers()
    const first = att()
    const m = await startPlaying(first, 12)
    m.fail(3)
    m.fail(3) // spent, and failed
    expect(getAudioState().failed).toBe(true)
    const second = att()
    await act(async () => audioPlayer.open(clip(second), srcOf(second), [], { play: true }))
    const loadsBefore = loads
    m.fail(3)
    expect(loads).toBe(loadsBefore + 1)
    expect(getAudioState().failed).toBe(false)
  })

  it('the reload is recorded in the audio trace with the media error code', async () => {
    vi.useFakeTimers()
    const a = att()
    const m = await startPlaying(a, 12)
    m.fail(3)
    const calls = vi.mocked(recordAudioTrace).mock.calls.map((c) => c[0])
    expect(calls.some((c) => c.code === 'media-error' && c.mediaError === 3)).toBe(true)
    expect(calls.some((c) => c.code === 'reload' && c.detail === 'decode')).toBe(true)
  })
})

describe('other errors keep their old path', () => {
  it.each([1, 2, 4])('MediaError code %i fails at once with no reload', async (code) => {
    vi.useFakeTimers()
    const a = att()
    const m = await startPlaying(a, 12)
    const loadsBefore = loads
    m.fail(code)
    expect(getAudioState().failed).toBe(true)
    expect(loads).toBe(loadsBefore)
  })

  it('an error event with no MediaError attached fails at once, as before', async () => {
    vi.useFakeTimers()
    const a = att()
    const m = await startPlaying(a, 12)
    const loadsBefore = loads
    m.fail(0)
    expect(getAudioState().failed).toBe(true)
    expect(loads).toBe(loadsBefore)
  })
})

describe('the reload follows what the owner wants right now', () => {
  it('a code 3 that lands after Pause and before the pause event plays nothing', async () => {
    vi.useFakeTimers()
    const a = att()
    const m = await startPlaying(a, 12)
    // Pause: the element is paused at once, its `pause` event comes later (as in a browser).
    let deliverPause = () => {}
    vi.mocked(HTMLMediaElement.prototype.pause).mockImplementation(function (this: HTMLMediaElement) {
      going.delete(this)
      deliverPause = () => void this.dispatchEvent(new Event('pause'))
    })
    await act(async () => audioPlayer.pause())
    const playsBefore = plays
    m.fail(3)
    await act(async () => void vi.advanceTimersByTimeAsync(2000))
    expect(plays).toBe(playsBefore)
    act(() => deliverPause())
    await act(async () => void vi.advanceTimersByTimeAsync(2000))
    expect(plays).toBe(playsBefore)
    expect(getAudioState().playing).toBe(false)
  })

  it('a play() refused after the reload (NotAllowedError) shows the refused line, loads once, and the clip has not failed', async () => {
    vi.useFakeTimers()
    const a = att()
    const m = await startPlaying(a, 12)
    const loadsBefore = loads
    vi.mocked(HTMLMediaElement.prototype.play).mockImplementation(() =>
      Promise.reject(Object.assign(new Error('x'), { name: 'NotAllowedError' })),
    )
    m.fail(3)
    await act(async () => void vi.advanceTimersByTimeAsync(5000))
    expect(loads).toBe(loadsBefore + 1)
    expect(getAudioState().refused).toBe(true)
    expect(getAudioState().failed).toBe(false)
    expect(getAudioState().playing).toBe(false)
  })

  describe('the audio route', () => {
    function routeLog() {
      const log: string[] = []
      setPlatform({ ...webPlatform, audioSession: { set: (t: AudioSessionType) => void log.push(t) } })
      vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible')
      return log
    }

    it('a playing clip gives the route back for the reload and takes it again', async () => {
      vi.useFakeTimers()
      const log = routeLog()
      const m = await startPlaying(att(), 12)
      log.length = 0
      m.fail(3)
      await act(async () => void vi.advanceTimersByTimeAsync(50))
      expect(log).toEqual(['auto', 'playback'])
    })

    it('a paused clip keeps its route: no hand-back, no new take', async () => {
      vi.useFakeTimers()
      const log = routeLog()
      const m = await startPlaying(att(), 12)
      await act(async () => audioPlayer.pause())
      log.length = 0
      m.fail(3)
      await act(async () => void vi.advanceTimersByTimeAsync(2000))
      expect(log).toEqual([])
    })
  })
})
