// WP-V3: the voice-reply FIFO behind /drive (docs/V2-FEATURES.md V4.1): one audio element, saved speed, holds.
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  createVoiceQueue,
  LOAD_TIMEOUT_MS,
  SPEECH_WAIT_MAX_MS,
  STALL_TIMEOUT_MS,
} from '../../src/features/drive/queue.ts'

class FakeAudio extends EventTarget {
  src = ''
  currentTime = 0
  duration = Number.NaN
  paused = true
  playbackRate = 1
  defaultPlaybackRate = 1
  rejectNext = false
  failNext = false
  failAlways = false
  /** play() never settles for a src containing "hang" (a download that never answers). */
  load() {}
  removeAttribute(name: string) {
    if (name === 'src') this.src = ''
  }
  plays: string[] = []
  play(): Promise<void> {
    if (this.src.includes('hang')) {
      this.paused = false
      this.dispatchEvent(new Event('play'))
      return new Promise(() => {})
    }
    if ((this.failNext || (this.failAlways && this.src.includes('bad'))) && !this.src.startsWith('data:')) {
      this.failNext = false
      return Promise.reject(new DOMException('bad', 'NotSupportedError'))
    }
    if (this.rejectNext) {
      this.rejectNext = false
      return Promise.reject(new DOMException('blocked', 'NotAllowedError'))
    }
    this.paused = false
    this.plays.push(this.src)
    this.dispatchEvent(new Event('play'))
    return Promise.resolve()
  }
  pause(): void {
    this.paused = true
    this.dispatchEvent(new Event('pause'))
  }
  end(): void {
    this.paused = true
    this.dispatchEvent(new Event('ended'))
  }
}

const item = (id: string) => ({ id, url: `/media/${id}`, durationMs: 3000 })
const mk = (speed = 1) => {
  const audio = new FakeAudio()
  const q = createVoiceQueue({ audio: audio as unknown as HTMLAudioElement, speed: () => speed })
  return { audio, q }
}
const tick = () => new Promise((r) => setTimeout(r, 0))

describe('voice queue', () => {
  it('plays replies first-in first-out, one at a time', async () => {
    const { audio, q } = mk()
    await q.unlock()
    q.enqueue(item('a'))
    q.enqueue(item('b'))
    await tick()
    expect(audio.src).toBe('/media/a')
    expect(q.store.getState().pending.map((i) => i.id)).toEqual(['b'])
    audio.end()
    await tick()
    expect(audio.src).toBe('/media/b')
    audio.end()
    await tick()
    expect(q.store.getState().current).toBeNull()
    expect(q.store.getState().playing).toBe(false)
  })

  it('the unlock plays a short silent clip on the same element', async () => {
    const { audio, q } = mk()
    await q.unlock()
    expect(audio.plays[0]).toMatch(/^data:audio\/wav;base64,/)
    expect(q.store.getState().armed).toBe(true)
  })

  it('waits for a tap when audio was never unlocked, then plays on toggle', async () => {
    const { audio, q } = mk()
    q.enqueue(item('a'))
    await tick()
    expect(audio.plays).toEqual([])
    expect(q.store.getState().current?.id).toBe('a')
    expect(q.store.getState().playing).toBe(false)
    q.toggle()
    await tick()
    expect(audio.src).toBe('/media/a')
    expect(q.store.getState().playing).toBe(true)
  })

  it('ignores a reply it has already queued', async () => {
    const { audio, q } = mk()
    await q.unlock()
    q.enqueue(item('a'))
    q.enqueue(item('a'))
    audio.end()
    await tick()
    expect(q.store.getState().current).toBeNull()
  })

  it('a hold (recording) pauses playback and release resumes it; a reply that arrives meanwhile waits', async () => {
    const { audio, q } = mk()
    await q.unlock()
    q.enqueue(item('a'))
    await tick()
    q.hold('record')
    expect(audio.paused).toBe(true)
    q.enqueue(item('b'))
    await tick()
    expect(q.store.getState().playing).toBe(false)
    q.release('record')
    await tick()
    expect(audio.src).toBe('/media/a')
    expect(audio.paused).toBe(false)
  })

  it('applies the saved speed to every reply', async () => {
    const { audio, q } = mk(1.5)
    await q.unlock()
    q.enqueue(item('a'))
    await tick()
    expect(audio.playbackRate).toBe(1.5)
    expect(audio.defaultPlaybackRate).toBe(1.5)
  })

  it('skip moves to the next reply; back rewinds ten seconds without going below zero', async () => {
    const { audio, q } = mk()
    await q.unlock()
    q.enqueue(item('a'))
    q.enqueue(item('b'))
    await tick()
    audio.currentTime = 4
    q.back(10)
    expect(audio.currentTime).toBe(0)
    q.skip()
    await tick()
    expect(audio.src).toBe('/media/b')
  })

  it('a refused play() keeps the reply and asks for a tap', async () => {
    const { audio, q } = mk()
    await q.unlock()
    audio.rejectNext = true
    q.enqueue(item('a'))
    await tick()
    const s = q.store.getState()
    expect(s.blocked).toBe(true)
    expect(s.current?.id).toBe('a')
    expect(s.playing).toBe(false)
    q.toggle()
    await tick()
    expect(q.store.getState().playing).toBe(true)
  })

  it('clear drops everything and stops the element', async () => {
    const { audio, q } = mk()
    await q.unlock()
    q.enqueue(item('a'))
    q.enqueue(item('b'))
    await tick()
    q.clear()
    expect(audio.paused).toBe(true)
    expect(q.store.getState().current).toBeNull()
    expect(q.store.getState().pending).toEqual([])
  })

  it('a clip that cannot play is skipped, reported once, and the next reply plays', async () => {
    const audio = new FakeAudio()
    const failed: string[] = []
    const q = createVoiceQueue({
      audio: audio as unknown as HTMLAudioElement,
      speed: () => 1,
      onFail: (i) => failed.push(i.id),
    })
    await q.unlock()
    audio.failAlways = true
    q.enqueue(item('bad'))
    q.enqueue(item('good'))
    await new Promise((r) => setTimeout(r, 400))
    expect(failed).toEqual(['bad'])
    expect(audio.src).toBe('/media/good')
    expect(q.store.getState().playing).toBe(true)
  })

  it('a clip that fails once is retried quietly and plays', async () => {
    const { audio, q } = mk()
    await q.unlock()
    audio.failNext = true
    q.enqueue(item('blip'))
    await new Promise((r) => setTimeout(r, 400))
    expect(q.store.getState().playing).toBe(true)
    expect(q.store.getState().current?.id).toBe('blip')
  })

  it('an element error event skips the clip too', async () => {
    const audio = new FakeAudio()
    const failed: string[] = []
    const q = createVoiceQueue({
      audio: audio as unknown as HTMLAudioElement,
      speed: () => 1,
      onFail: (i) => failed.push(i.id),
    })
    await q.unlock()
    q.enqueue(item('a'))
    q.enqueue(item('b'))
    await tick()
    audio.dispatchEvent(new Event('error'))
    await new Promise((r) => setTimeout(r, 400))
    audio.dispatchEvent(new Event('error'))
    await tick()
    expect(failed).toEqual(['a'])
    expect(audio.src).toBe('/media/b')
  })

  it('play and pause are separate and idempotent; a new reply ends a pause', async () => {
    const { audio, q } = mk()
    await q.unlock()
    q.enqueue(item('a'))
    await tick()
    q.play()
    expect(q.store.getState().playing).toBe(true)
    q.pause()
    q.pause()
    expect(audio.paused).toBe(true)
    expect(q.store.getState().paused).toBe(true)
    q.enqueue(item('b'))
    await tick()
    expect(audio.paused).toBe(false)
    expect(q.store.getState().paused).toBe(false)
  })

  it('clear forgets a manual pause', async () => {
    const { audio, q } = mk()
    await q.unlock()
    q.enqueue(item('a'))
    await tick()
    q.pause()
    q.clear()
    q.enqueue(item('b'))
    await tick()
    expect(audio.paused).toBe(false)
  })

  it('onStart fires once per clip when it really starts', async () => {
    const audio = new FakeAudio()
    const started: string[] = []
    const q = createVoiceQueue({
      audio: audio as unknown as HTMLAudioElement,
      speed: () => 1,
      onStart: (i) => started.push(i.id),
    })
    await q.unlock()
    q.enqueue({ ...item('a'), replyTo: 't1' })
    await tick()
    q.pause()
    q.play()
    await tick()
    expect(started).toEqual(['a'])
  })
  describe('bounded waits (re-check RC1/RC2)', () => {
    afterEach(() => {
      vi.useRealTimers()
    })

    it('a clip whose download hangs is given up after LOAD_TIMEOUT_MS and the next reply plays', async () => {
      const audio = new FakeAudio()
      const failed: Array<{ id: string; started: boolean }> = []
      const q = createVoiceQueue({
        audio: audio as unknown as HTMLAudioElement,
        speed: () => 1,
        onFail: (i, info) => failed.push({ id: i.id, started: info.started }),
      })
      await q.unlock()
      vi.useFakeTimers()
      q.enqueue(item('hang1'))
      q.enqueue(item('good'))
      expect(q.store.getState().loading).toBe(true)
      await vi.advanceTimersByTimeAsync(LOAD_TIMEOUT_MS - 100)
      expect(failed).toEqual([])
      await vi.advanceTimersByTimeAsync(200)
      expect(failed).toEqual([{ id: 'hang1', started: false }])
      expect(audio.src).toBe('/media/good')
      expect(q.store.getState().playing).toBe(true)
      expect(q.store.getState().loading).toBe(false)
    })

    it('a clip that stalls mid-way is given up after STALL_TIMEOUT_MS without progress', async () => {
      const audio = new FakeAudio()
      const failed: Array<{ id: string; started: boolean }> = []
      const q = createVoiceQueue({
        audio: audio as unknown as HTMLAudioElement,
        speed: () => 1,
        onFail: (i, info) => failed.push({ id: i.id, started: info.started }),
      })
      await q.unlock()
      vi.useFakeTimers()
      q.enqueue(item('a'))
      await vi.advanceTimersByTimeAsync(0)
      audio.currentTime = 1.2
      audio.dispatchEvent(new Event('waiting'))
      await vi.advanceTimersByTimeAsync(STALL_TIMEOUT_MS + 10)
      expect(failed).toEqual([{ id: 'a', started: true }])
      expect(q.store.getState().current).toBeNull()
    })

    it('a stall that recovers is not given up', async () => {
      const audio = new FakeAudio()
      const failed: string[] = []
      const q = createVoiceQueue({
        audio: audio as unknown as HTMLAudioElement,
        speed: () => 1,
        onFail: (i) => failed.push(i.id),
      })
      await q.unlock()
      vi.useFakeTimers()
      q.enqueue(item('a'))
      await vi.advanceTimersByTimeAsync(0)
      audio.dispatchEvent(new Event('waiting'))
      await vi.advanceTimersByTimeAsync(2_000)
      audio.dispatchEvent(new Event('playing'))
      await vi.advanceTimersByTimeAsync(STALL_TIMEOUT_MS)
      expect(failed).toEqual([])
      expect(q.store.getState().current?.id).toBe('a')
    })

    it('a new clip waits for the phone voice to finish, then plays', async () => {
      const audio = new FakeAudio()
      let speaking = true
      const q = createVoiceQueue({
        audio: audio as unknown as HTMLAudioElement,
        speed: () => 1,
        speaking: () => speaking,
      })
      speaking = false
      await q.unlock()
      speaking = true
      vi.useFakeTimers()
      q.enqueue(item('a'))
      await vi.advanceTimersByTimeAsync(3_000)
      expect(audio.plays).not.toContain('/media/a')
      expect(q.store.getState().waitingSpeech).toBe(true)
      speaking = false
      await vi.advanceTimersByTimeAsync(300)
      expect(audio.plays).toContain('/media/a')
      expect(q.store.getState().waitingSpeech).toBe(false)
    })

    it('a phone voice that never stops keeps a clip waiting at most SPEECH_WAIT_MAX_MS, then is cut off', async () => {
      const audio = new FakeAudio()
      let cancels = 0
      let speaking = false
      const q = createVoiceQueue({
        audio: audio as unknown as HTMLAudioElement,
        speed: () => 1,
        speaking: () => speaking,
        cancelSpeech: () => {
          cancels++
          speaking = false
        },
      })
      await q.unlock()
      speaking = true
      vi.useFakeTimers()
      q.enqueue(item('a'))
      await vi.advanceTimersByTimeAsync(SPEECH_WAIT_MAX_MS - 500)
      expect(audio.plays).not.toContain('/media/a')
      await vi.advanceTimersByTimeAsync(1_000)
      expect(cancels).toBe(1)
      expect(audio.plays).toContain('/media/a')
    })

    it('one load failure reported twice (play() rejection + error event) still gets its one quiet retry', async () => {
      const audio = new FakeAudio()
      const failed: string[] = []
      const q = createVoiceQueue({
        audio: audio as unknown as HTMLAudioElement,
        speed: () => 1,
        onFail: (i) => failed.push(i.id),
      })
      await q.unlock()
      audio.failNext = true
      q.enqueue(item('blip'))
      audio.dispatchEvent(new Event('error'))
      await new Promise((r) => setTimeout(r, 400))
      expect(failed).toEqual([])
      expect(q.store.getState().current?.id).toBe('blip')
      expect(q.store.getState().playing).toBe(true)
    })
  })
})
