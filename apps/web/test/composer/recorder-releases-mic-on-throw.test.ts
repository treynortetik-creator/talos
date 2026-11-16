// @vitest-environment jsdom
// Once the browser has handed over the microphone, a failure while the recorder is being set up must let it go again:
// the caller gets an error, not a handle, so nothing else could ever stop the tracks.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { startRecorder } from '../../src/features/composer/recorder.ts'

const fail = { construct: false, start: false }
class FakeMediaRecorder {
  static isTypeSupported = () => true
  state = 'inactive'
  ondataavailable: unknown = null
  constructor() {
    if (fail.construct) throw new DOMException('no recorder for this stream', 'NotSupportedError')
  }
  addEventListener() {}
  start() {
    if (fail.start) throw new DOMException('the track ended', 'InvalidStateError')
    this.state = 'recording'
  }
  stop() {
    this.state = 'inactive'
  }
}

let stopped = 0
const closed = { n: 0 }
class FakeAudioContext {
  createAnalyser() {
    return { fftSize: 0, getByteTimeDomainData() {} }
  }
  createMediaStreamSource() {
    return { connect() {} }
  }
  async close() {
    closed.n++
  }
}

beforeEach(() => {
  stopped = 0
  closed.n = 0
  fail.construct = false
  fail.start = false
  vi.stubGlobal('MediaRecorder', FakeMediaRecorder)
  vi.stubGlobal('AudioContext', FakeAudioContext)
  Object.defineProperty(navigator, 'mediaDevices', {
    value: {
      getUserMedia: vi.fn(async () => ({
        getTracks: () => [{ stop: () => void stopped++ }, { stop: () => void stopped++ }],
      })),
    },
    configurable: true,
  })
})
afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('a recorder that fails while starting', () => {
  it('stops the microphone tracks when the recorder cannot be made', async () => {
    fail.construct = true
    await expect(startRecorder()).rejects.toThrow('no recorder for this stream')
    expect(stopped).toBe(2)
  })

  it('stops the tracks and closes the meter when the recorder refuses to start', async () => {
    fail.start = true
    await expect(startRecorder()).rejects.toThrow('the track ended')
    expect(stopped).toBe(2)
    expect(closed.n).toBe(1)
  })

  it('keeps the microphone while a recording that started is running, and lets it go on cancel', async () => {
    const h = await startRecorder()
    expect(stopped).toBe(0)
    h.cancel()
    expect(stopped).toBe(2)
  })
})
