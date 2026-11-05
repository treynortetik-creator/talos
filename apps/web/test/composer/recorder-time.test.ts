// @vitest-environment jsdom
// The recorder keeps time from stamps, so a recorder that ended by itself still reports how long it ran.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { isStrayTap, startRecorder } from '../../src/features/composer/recorder.ts'

type Listener = () => void
class FakeMediaRecorder {
  static isTypeSupported = () => true
  state: 'inactive' | 'recording' | 'paused' = 'inactive'
  ondataavailable: ((e: { data: Blob }) => void) | null = null
  onstop: (() => void) | null = null
  onerror: (() => void) | null = null
  private stops: Listener[] = []
  constructor(readonly stream: unknown) {
    made.push(this)
  }
  addEventListener(type: string, fn: Listener) {
    if (type === 'stop') this.stops.push(fn)
  }
  start() {
    this.state = 'recording'
  }
  pause() {
    this.state = 'paused'
  }
  resume() {
    this.state = 'recording'
  }
  requestData() {}
  /** What the browser does on its own, or when stop() is called. */
  end() {
    this.state = 'inactive'
    this.ondataavailable?.({ data: new Blob(['abc']) })
    for (const f of this.stops) f()
    this.onstop?.()
  }
  stop() {
    this.end()
  }
}
const made: FakeMediaRecorder[] = []
let now = 1000

beforeEach(() => {
  made.length = 0
  now = 1000
  vi.spyOn(performance, 'now').mockImplementation(() => now)
  vi.stubGlobal('MediaRecorder', FakeMediaRecorder)
  Object.defineProperty(navigator, 'mediaDevices', {
    value: { getUserMedia: vi.fn(async () => ({ getTracks: () => [] })) },
    configurable: true,
  })
})
afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('recorder time', () => {
  it('counts a recording that stopped by itself at its real length, and says it stopped by itself', async () => {
    const h = await startRecorder(undefined, { analyse: false })
    now += 90_000
    made[0]?.end() // the browser cut it
    now += 30_000 // time passes before anyone looks
    expect(h.elapsedMs()).toBe(90_000)
    expect(h.endedByItself()).toBe(true)
    const r = await h.stop()
    expect(r.durationMs).toBe(90_000)
    expect(r.endedByItself).toBe(true)
    expect(isStrayTap(r)).toBe(false)
  })

  it('a tap on stop is not "ended by itself", and pauses are not counted', async () => {
    const h = await startRecorder(undefined, { analyse: false })
    now += 2000
    h.pause()
    now += 50_000
    h.resume()
    now += 3000
    const r = await h.stop()
    expect(r.durationMs).toBe(5000)
    expect(r.endedByItself).toBe(false)
    expect(h.endedByItself()).toBe(false)
  })
})

describe('the stray tap rule', () => {
  const rec = (durationMs: number, size: number) => ({ durationMs, blob: new Blob([new Uint8Array(size)]) })
  it('is a short touch or an empty blob, and nothing else', () => {
    expect(isStrayTap(rec(100, 500))).toBe(true)
    expect(isStrayTap(rec(399, 500))).toBe(true)
    expect(isStrayTap(rec(400, 500))).toBe(false)
    expect(isStrayTap(rec(60_000, 0))).toBe(true)
    expect(isStrayTap(rec(60_000, 1))).toBe(false)
  })
})
