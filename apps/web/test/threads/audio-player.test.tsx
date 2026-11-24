// @vitest-environment jsdom
// D37: audio belongs to the app, not to the message row. These drive the real store and the real rows; jsdom
// loads no media, so the element's own events (loadedmetadata, timeupdate, ended, error) are fired by hand and play/pause
// are stubs that fire the events a browser would.
import { type AttachmentRefT, type MessageT, newId } from '@talos-app/protocol'
import { act, cleanup, fireEvent, render, renderHook, screen } from '@testing-library/react'
import { MemoryRouter, useNavigate } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { clearLocalData } from '../../src/features/auth/session.ts'
import { AudioPlayer, useVoiceOrder, VoiceOrderContext } from '../../src/features/threads/Attachments.tsx'
import { AudioOnLeave } from '../../src/features/threads/AudioOnLeave.tsx'
import {
  __resetAudioForTests,
  audioElement,
  audioPlayer,
  getAudioState,
  MAX_SAVED,
  POSITIONS_KEY,
  SAVE_EVERY_MS,
  STALL_MS,
  savedPosition,
} from '../../src/features/threads/audioPlayer.ts'
import { ClientProvider, type TalosClient } from '../../src/lib/client.ts'
import { createFakeClient } from '../../src/lib/fakeClient.ts'
import { type AudioSessionType, type MediaHandlers, setPlatform, webPlatform } from '../../src/lib/platform.ts'

const att = (over: Partial<AttachmentRefT> = {}): AttachmentRefT => ({
  media_id: newId('md'),
  kind: 'voice_note',
  role: 'attachment',
  mime: 'audio/webm',
  name: 'v.webm',
  size: 3,
  sha256: 'a'.repeat(64),
  duration_ms: 120_000,
  ...over,
})
const item = (a: AttachmentRefT, key = newId('m')) => ({
  key,
  mediaId: a.media_id,
  title: a.name,
  durationMs: a.duration_ms ?? 0,
})
const src = (a: AttachmentRefT) => `/media/${a.media_id}?c=2`

/** What the platform was told, in order. */
function recordPlatform(controls = false) {
  const log: string[] = []
  let handlers: MediaHandlers = {}
  let title = ''
  setPlatform({
    ...webPlatform,
    audioSession: { set: (t: AudioSessionType) => void log.push(`audio:${t}`) },
    mediaSession: {
      set: (m, h) => {
        title = m.title
        handlers = h
        log.push(`media:set:${Object.keys(h).sort().join(',')}`)
      },
      clear: () => void log.push('media:clear'),
      controls: () => controls,
    },
  })
  return { log, handlers: () => handlers, title: () => title }
}

let playCalls = 0
let pauseCalls = 0
beforeEach(() => {
  localStorage.clear()
  __resetAudioForTests()
  playCalls = 0
  pauseCalls = 0
  // `paused` is honest: false from play() to pause(). A stub that left it true would hide a system pause that came before its event.
  const going = new WeakSet<HTMLMediaElement>()
  vi.spyOn(HTMLMediaElement.prototype, 'paused', 'get').mockImplementation(function (this: HTMLMediaElement) {
    return !going.has(this)
  })
  vi.spyOn(HTMLMediaElement.prototype, 'play').mockImplementation(function (this: HTMLMediaElement) {
    playCalls++
    going.add(this)
    this.dispatchEvent(new Event('play'))
    return Promise.resolve()
  })
  vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(function (this: HTMLMediaElement) {
    pauseCalls++
    going.delete(this)
    this.dispatchEvent(new Event('pause'))
  })
  vi.spyOn(HTMLMediaElement.prototype, 'load').mockImplementation(() => {})
})
afterEach(() => {
  cleanup()
  vi.useRealTimers()
  __resetAudioForTests() // while play/pause/load are still stubs
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  setPlatform(webPlatform)
  localStorage.clear()
})

/** The element reports a clip of `duration` seconds, `at` seconds in. */
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
    end: () => act(() => void a.dispatchEvent(new Event('ended'))),
    error: () => act(() => void a.dispatchEvent(new Event('error'))),
    pos: () => clock.t,
  }
}

function stubClient() {
  const asked: string[] = []
  const client = { ...createFakeClient(), fetchMedia: (id: string) => void asked.push(id) } as unknown as TalosClient
  return { client, asked }
}

function Row({ a, id, client }: { a: AttachmentRefT; id: string; client: TalosClient }) {
  return (
    <ClientProvider client={client}>
      <AudioPlayer att={a} messageId={id} variant="voice_note" />
    </ClientProvider>
  )
}

function Thread({ msgs, client }: { msgs: MessageT[]; client: TalosClient }) {
  const order = useVoiceOrder(msgs)
  return (
    <VoiceOrderContext.Provider value={order}>
      <ClientProvider client={client}>
        <AudioPlayer
          att={msgs[0]?.attachments[0] as AttachmentRefT}
          messageId="m_0"
          variant="voice_note"
          transcript={msgs[0]?.transcript}
        />
      </ClientProvider>
    </VoiceOrderContext.Provider>
  )
}

describe('the player outlives the row', () => {
  it('playing keeps going after the message row unmounts (leaving the thread)', () => {
    const a = att()
    const { client } = stubClient()
    const r = render(<Row a={a} id="m_1" client={client} />)
    fireEvent.click(screen.getByRole('button', { name: 'Play' }))
    expect(getAudioState()).toMatchObject({ playing: true, item: { key: 'm_1' } })
    const el = audioElement()
    r.unmount()
    expect(getAudioState().playing).toBe(true)
    expect(pauseCalls).toBe(0)
    expect(el.isConnected).toBe(true)
    expect(el.getAttribute('src')).toBe(src(a))
    // a new mount of the same row is a view of the same player
    render(<Row a={a} id="m_1" client={client} />)
    expect(screen.getByRole('button', { name: 'Pause' })).toBeTruthy()
  })

  it('the row has no player of its own: its only <audio> is a hidden probe and never plays', () => {
    const a = att()
    const { client } = stubClient()
    const r = render(<Row a={a} id="m_1" client={client} />)
    fireEvent.click(screen.getByRole('button', { name: 'Play' }))
    expect(playCalls).toBe(1)
    const probe = r.container.querySelector('audio') as HTMLAudioElement
    expect(probe).not.toBe(audioElement())
    expect(probe.hidden).toBe(true)
  })

  it('pause in the row pauses the dock and keeps the clip loaded; speed goes to the dock element', () => {
    const a = att()
    const { client } = stubClient()
    render(<Row a={a} id="m_1" client={client} />)
    fireEvent.click(screen.getByRole('button', { name: 'Play' }))
    fireEvent.click(screen.getByRole('button', { name: 'Pause' }))
    expect(getAudioState()).toMatchObject({ playing: false, item: { key: 'm_1' } })
    fireEvent.click(screen.getByRole('button', { name: /Playback speed/ }))
    expect([audioElement().playbackRate, audioElement().preservesPitch]).toEqual([1.25, true])
    expect(localStorage.getItem('talos.audio.speed')).toBe('1.25')
  })
})

describe('saved position', () => {
  it('saves about every 5 s while playing, not on every tick', () => {
    vi.useFakeTimers()
    const a = att()
    audioPlayer.open(item(a), src(a))
    const m = media(120)
    m.meta()
    m.at(2)
    expect(localStorage.getItem(POSITIONS_KEY)).toBeNull()
    vi.advanceTimersByTime(SAVE_EVERY_MS)
    m.at(7)
    expect(savedPosition(a.media_id)).toBe(7)
    expect(JSON.parse(localStorage.getItem(POSITIONS_KEY) as string)[0][0]).toBe(a.media_id)
    vi.advanceTimersByTime(1000)
    m.at(8)
    expect(savedPosition(a.media_id)).toBe(7) // not saved again yet
  })

  it('pausing saves the spot at once', () => {
    const a = att()
    audioPlayer.open(item(a), src(a))
    const m = media(120)
    m.meta()
    m.at(31)
    audioPlayer.pause()
    expect(savedPosition(a.media_id)).toBe(31)
  })

  it('keeps the newest 50 and drops the oldest', () => {
    vi.useFakeTimers()
    const ids: string[] = []
    for (let i = 0; i < MAX_SAVED + 5; i++) {
      const a = att()
      ids.push(a.media_id)
      vi.advanceTimersByTime(10)
      audioPlayer.open(item(a), src(a))
      const m = media(120)
      m.meta()
      m.at(10 + i)
      audioPlayer.pause()
    }
    expect(JSON.parse(localStorage.getItem(POSITIONS_KEY) as string)).toHaveLength(MAX_SAVED)
    expect(savedPosition(ids[0] as string)).toBe(0)
    expect(savedPosition(ids.at(-1) as string)).toBeGreaterThan(0)
  })

  it('a reload resumes from the saved spot once the metadata is in', () => {
    const a = att()
    localStorage.setItem(POSITIONS_KEY, JSON.stringify([[a.media_id, 30, Date.now()]]))
    // "reload": the module state is rebuilt from storage
    __resetAudioForTests()
    audioPlayer.open(item(a), src(a))
    const m = media(120)
    m.meta()
    expect(m.pos()).toBe(30)
    expect(getAudioState().cur).toBe(30)
  })

  it('a clip left within 5 s of the end starts over, and finishing a clip forgets its spot', () => {
    const a = att()
    localStorage.setItem(POSITIONS_KEY, JSON.stringify([[a.media_id, 117, Date.now()]]))
    __resetAudioForTests()
    audioPlayer.open(item(a), src(a))
    const m = media(120)
    m.meta()
    expect(m.pos()).toBe(0)
    m.at(40)
    audioPlayer.pause()
    expect(savedPosition(a.media_id)).toBe(40)
    m.end()
    expect(savedPosition(a.media_id)).toBe(0)
  })

  it('a row of a clip that is not loaded shows its saved spot', () => {
    const a = att()
    localStorage.setItem(POSITIONS_KEY, JSON.stringify([[a.media_id, 60, Date.now()]]))
    __resetAudioForTests()
    const { client } = stubClient()
    render(<Row a={a} id="m_1" client={client} />)
    expect(screen.getByRole('slider', { name: 'Seek' }).getAttribute('aria-valuenow')).toBe('60')
  })

  it('blocked storage: playback and the in-memory spot still work', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('blocked')
    })
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('blocked')
    })
    const a = att()
    expect(() => audioPlayer.open(item(a), src(a))).not.toThrow()
    const m = media(120)
    m.meta()
    m.at(20)
    expect(() => audioPlayer.pause()).not.toThrow()
    expect(savedPosition(a.media_id)).toBe(20)
  })
})

describe('the queue follows him out of the thread', () => {
  it('the next notes play after the row is gone, and the last one ends the dock', () => {
    const rec = recordPlatform()
    const [x, y, z] = [att(), att(), att()] as [AttachmentRefT, AttachmentRefT, AttachmentRefT]
    audioPlayer.open(item(x, 'm_x'), src(x), [item(y, 'm_y'), item(z, 'm_z')])
    const m = media(120)
    m.meta()
    // nothing is mounted: no row, no Timeline
    m.end()
    expect(getAudioState().item?.key).toBe('m_y')
    expect(audioElement().getAttribute('src')).toBe(src(y))
    expect(playCalls).toBe(2)
    expect(rec.title()).toBe('v.webm')
    m.end()
    expect(getAudioState().item?.key).toBe('m_z')
    m.end()
    expect(getAudioState().item).toBeNull()
    expect(rec.log.at(-2)).toBe('media:clear')
    expect(rec.log.at(-1)).toBe('audio:auto')
  })

  it('the row captures the queue from the thread when it starts playing', () => {
    const msgs = [0, 1, 2].map((i) => {
      const a = att({ duration_ms: 90_000 })
      return {
        id: `m_${i}`,
        thread_id: 'general',
        author: 'agent',
        kind: 'voice_note',
        attachments: [a],
        transcript: { status: 'done', text: `note ${i}` },
        created_at: new Date().toISOString(),
        via: 'app',
        format: 'plain',
      } as unknown as MessageT
    })
    const { client } = stubClient()
    const r = render(<Thread msgs={msgs} client={client} />)
    fireEvent.click(screen.getByRole('button', { name: 'Play' }))
    r.unmount() // leaves the thread
    const m = media(90)
    m.meta()
    m.end()
    expect(getAudioState().item).toMatchObject({ key: 'm_1', title: 'note 1' })
    m.end()
    expect(getAudioState().item?.key).toBe('m_2')
  })

  it('useVoiceOrder keeps ids, players and adds the items the dock needs', () => {
    const a = att()
    const m = {
      id: 'm_1',
      thread_id: 't1',
      kind: 'voice_note',
      attachments: [a],
      created_at: '',
      author: 'agent',
    } as unknown as MessageT
    const { result } = renderHook(() => useVoiceOrder([m]))
    expect(result.current.ids).toEqual(['m_1'])
    expect(result.current.players).toBeInstanceOf(Map)
    expect(result.current.items?.get('m_1')).toMatchObject({ mediaId: a.media_id, title: 'Voice note' })
  })
})

describe('lock screen and audio route', () => {
  it('play sets the media session and the playback route; stop clears both', () => {
    const rec = recordPlatform()
    const a = att()
    audioPlayer.open(item(a), src(a))
    expect(rec.log).toEqual(['audio:playback', 'media:set:pause,play,seekbackward,seekforward,seekto'])
    const m = media(120, 50)
    m.meta()
    rec.handlers().seekforward?.()
    expect(m.pos()).toBe(60)
    rec.handlers().seekbackward?.()
    expect(m.pos()).toBe(50)
    rec.handlers().pause?.()
    expect(getAudioState().playing).toBe(false)
    rec.handlers().play?.()
    expect(getAudioState().playing).toBe(true)
    audioPlayer.stop()
    expect(rec.log.slice(-2)).toEqual(['media:clear', 'audio:auto'])
    expect(getAudioState().item).toBeNull()
  })

  it('Drive opening pauses the dock, and Drive leaving does not wipe a clip still loaded', async () => {
    const rec = recordPlatform()
    setPlatform({
      ...(await import('../../src/lib/platform.ts')).getPlatform(),
      wakeLock: { acquire: async () => () => {} },
    })
    const a = att()
    const it = item(a)
    audioPlayer.open(it, src(a))
    expect(getAudioState().playing).toBe(true)
    const { DriveScreen } = await import('../../src/features/drive/index.tsx')
    const { setup } = await import('../cards/helpers.tsx')
    const client = setup()
    client.store.setState((s) => ({
      ...s,
      config: s.config && {
        ...s.config,
        voice_notes: { ...s.config.voice_notes, driving_until: new Date(Date.now() + 3_600_000).toISOString() },
      },
    }))
    const r = render(
      <MemoryRouter>
        <ClientProvider client={client}>
          <DriveScreen />
        </ClientProvider>
      </MemoryRouter>,
    )
    expect(getAudioState()).toMatchObject({ playing: false, item: { key: it.key } })
    expect(pauseCalls).toBeGreaterThan(0)
    await act(async () => r.unmount())
    // the last thing the platform heard is the dock's session, not a clear
    expect(rec.log.at(-1)).toMatch(/^media:set:/)
    expect(rec.title()).toBe('v.webm')
    expect(rec.log.lastIndexOf('media:clear')).toBeLessThan(rec.log.length - 1)
    expect(getAudioState().item).not.toBeNull()
  })
})

describe('a load error', () => {
  it('reaches the mounted row (the rehydrate asks the Mac) and the new URL reloads the dock at the same spot', () => {
    const a = att()
    const c = stubClient()
    const frames: Array<(f: { media_id: string }) => void> = []
    const client = {
      ...c.client,
      onFrame: (_t: string, l: (f: { media_id: string }) => void) => {
        frames.push(l)
        return () => void frames.splice(frames.indexOf(l), 1)
      },
    } as unknown as TalosClient
    render(<Row a={a} id="m_1" client={client} />)
    fireEvent.click(screen.getByRole('button', { name: 'Play' }))
    const m = media(120)
    m.meta()
    m.at(42)
    m.error()
    expect(c.asked).toEqual([a.media_id])
    expect(screen.getByTestId('media-fetching')).toBeTruthy()
    expect(getAudioState().failed).toBe(true)
    const before = audioElement().getAttribute('src')
    act(() => {
      for (const l of frames.slice()) l({ media_id: a.media_id })
    })
    expect(audioElement().getAttribute('src')).not.toBe(before)
    expect(audioElement().getAttribute('src')).toMatch(/\?c=2&r=1$/)
    expect(getAudioState().failed).toBe(false)
    expect(playCalls).toBe(2) // it was playing, so it plays again
    m.meta()
    expect(m.pos()).toBe(42)
  })

  it('a failed load with no row mounted is remembered; a row that mounts starts the rehydrate', () => {
    const a = att()
    const { client, asked } = stubClient()
    audioPlayer.open(item(a, 'm_1'), src(a))
    media(120).error()
    expect(getAudioState().failed).toBe(true)
    expect(asked).toEqual([])
    render(<Row a={a} id="m_1" client={client} />)
    expect(asked).toEqual([a.media_id])
  })
})

describe('what the owner can see and what stays right on iOS', () => {
  it('the row says so when the browser refuses to start the clip, and the next tap clears it', async () => {
    const a = att()
    const { client } = stubClient()
    render(<Row a={a} id="m_1" client={client} />)
    vi.mocked(HTMLMediaElement.prototype.play).mockImplementationOnce(() =>
      Promise.reject(Object.assign(new Error('not allowed'), { name: 'NotAllowedError' })),
    )
    fireEvent.click(screen.getByRole('button', { name: 'Play' }))
    expect((await screen.findByTestId('audio-refused')).textContent).toContain("Couldn't start playing")
    expect(getAudioState()).toMatchObject({ playing: false, refused: true })
    expect(screen.getByRole('button', { name: 'Play' })).toBeTruthy() // the button is honest too
    fireEvent.click(screen.getByRole('button', { name: 'Play' }))
    expect(screen.queryByTestId('audio-refused')).toBeNull()
    expect(getAudioState()).toMatchObject({ playing: true, refused: false })
  })

  it('a play() that was aborted by a newer load or a pause is not shown as a refusal', async () => {
    const a = att()
    const { client } = stubClient()
    render(<Row a={a} id="m_1" client={client} />)
    vi.mocked(HTMLMediaElement.prototype.play).mockImplementationOnce(() =>
      Promise.reject(Object.assign(new Error('aborted'), { name: 'AbortError' })),
    )
    fireEvent.click(screen.getByRole('button', { name: 'Play' }))
    await act(async () => {})
    expect(getAudioState().refused).toBe(false)
    expect(screen.queryByTestId('audio-refused')).toBeNull()
  })

  it('the speed is put back when WebKit starts a paused clip at 1x', () => {
    const a = att()
    const { client } = stubClient()
    render(<Row a={a} id="m_1" client={client} />)
    fireEvent.click(screen.getByRole('button', { name: /Playback speed/ })) // 1.25
    fireEvent.click(screen.getByRole('button', { name: 'Play' }))
    audioElement().playbackRate = 1 // what the engine did behind our back
    act(() => void audioElement().dispatchEvent(new Event('playing')))
    expect(audioElement().playbackRate).toBe(1.25)
    fireEvent.click(screen.getByRole('button', { name: 'Pause' }))
    audioElement().playbackRate = 1
    fireEvent.click(screen.getByRole('button', { name: 'Play' }))
    expect(audioElement().playbackRate).toBe(1.25)
  })

  it('the probe lets go of the file once it has the length, so a long thread holds no media elements', () => {
    const a = att()
    const { client } = stubClient()
    const r = render(<Row a={a} id="m_1" client={client} />)
    const probe = r.container.querySelector('audio[data-probe]') as HTMLAudioElement
    expect(probe).toBeTruthy()
    Object.defineProperty(probe, 'duration', { configurable: true, get: () => 42 })
    fireEvent.loadedMetadata(probe)
    expect(r.container.querySelector('audio[data-probe]')).toBeNull()
    expect(probe.hasAttribute('src')).toBe(false) // released, not just detached
  })

  it('a probe that errors starts the rehydrate once, and a new URL probes again', () => {
    const a = att()
    const { client, asked } = stubClient()
    const r = render(<Row a={a} id="m_1" client={client} />)
    const probe = r.container.querySelector('audio[data-probe]') as HTMLAudioElement
    fireEvent.error(probe)
    expect(asked).toEqual([a.media_id])
    expect(r.container.querySelector('audio[data-probe]')).toBeNull()
  })
})

describe('a start that does not move (WebKit sits at the start, "playing", for good)', () => {
  /** The element reports `playing`, with the readiness, position and paused flag given; the position can be moved by the test. */
  function stuck(over: { readyState?: number } = {}) {
    const a = audioElement()
    const clock = { t: 0 }
    Object.defineProperty(a, 'paused', { configurable: true, get: () => false })
    Object.defineProperty(a, 'seeking', { configurable: true, get: () => false })
    Object.defineProperty(a, 'readyState', { configurable: true, get: () => over.readyState ?? 4 })
    Object.defineProperty(a, 'currentTime', { configurable: true, get: () => clock.t, set: () => {} })
    return { clock, playing: () => act(() => void a.dispatchEvent(new Event('playing'))) }
  }
  const start = () => {
    vi.useFakeTimers()
    const a = att()
    audioPlayer.open(item(a), src(a))
    return a
  }

  it('restarts it once the start has sat still for a moment, and the clip stays "playing" throughout', () => {
    start()
    const m = stuck()
    m.playing()
    expect([playCalls, pauseCalls]).toEqual([1, 0])
    vi.advanceTimersByTime(STALL_MS - 1)
    expect([playCalls, pauseCalls]).toEqual([1, 0]) // not before the moment is up
    vi.advanceTimersByTime(2)
    expect([playCalls, pauseCalls]).toEqual([2, 1]) // a fresh pause and play
    expect(getAudioState().playing).toBe(true) // its own pause is not a stop
  })

  it('leaves a clip that is moving, or still buffering, or paused by the owner alone', () => {
    start()
    const m = stuck()
    m.playing()
    m.clock.t = 1.5 // it moved
    vi.advanceTimersByTime(STALL_MS * 3)
    expect([playCalls, pauseCalls]).toEqual([1, 0])

    const b = stuck({ readyState: 2 }) // waiting for data is slow, not stuck
    b.playing()
    vi.advanceTimersByTime(STALL_MS * 3)
    expect([playCalls, pauseCalls]).toEqual([1, 0])

    const c = stuck()
    c.playing()
    audioPlayer.pause() // the owner stops it before the moment is up
    const pauses = pauseCalls
    vi.advanceTimersByTime(STALL_MS * 3)
    expect(pauseCalls).toBe(pauses)
    expect(playCalls).toBe(1)
    expect(getAudioState().playing).toBe(false)
  })

  it('tries twice, then gives up: the clip stops, the row says so, and a new tap gets its own tries', () => {
    start()
    const m = stuck()
    for (let i = 0; i < 3; i++) {
      m.playing()
      vi.advanceTimersByTime(STALL_MS + 10)
    }
    expect(playCalls).toBe(1 + 2) // two restarts
    expect(pauseCalls).toBe(3) // two restarts and the last stop
    expect(getAudioState()).toMatchObject({ playing: false, refused: true }) // the screen matches the element
    // Play again: a fresh pair of tries, not an instant give-up
    act(() => audioPlayer.resume())
    m.playing()
    vi.advanceTimersByTime(STALL_MS + 10)
    expect(getAudioState().playing).toBe(true)
  })

  it('only the one pause the restart caused is ignored: the next pause event, even right after, is a real stop', () => {
    start()
    const m = stuck()
    m.playing()
    vi.advanceTimersByTime(STALL_MS + 10) // restarted: its own pause event was swallowed, the play event followed
    expect(getAudioState().playing).toBe(true)
    Object.defineProperty(audioElement(), 'paused', { configurable: true, get: () => true }) // the system paused it for real: the element agrees
    act(() => void audioElement().dispatchEvent(new Event('pause'))) // e.g. the lock screen, a second later or a moment later
    expect(getAudioState().playing).toBe(false)
  })

  it('a pause from the owner right after a restart still stops the clip', () => {
    start()
    const m = stuck()
    m.playing()
    vi.advanceTimersByTime(STALL_MS + 10) // restarted
    expect(getAudioState().playing).toBe(true)
    audioPlayer.pause()
    expect(getAudioState().playing).toBe(false)
  })
})

function Nav({ to }: { to: string }) {
  const nav = useNavigate()
  return (
    <button type="button" onClick={() => nav(to)}>
      go {to}
    </button>
  )
}

function Many() {
  const nav = useNavigate()
  return (
    <>
      {['/card/c_01JBF3V7Q8K2M4N6P8R0S97001', '/open/r_abc', '/threads'].map((to) => (
        <button type="button" key={to} onClick={() => nav(to)}>
          go {to}
        </button>
      ))}
    </>
  )
}

describe('leaving the screen', () => {
  // Two branches, decided by whether system controls (lock screen, Control Center, media keys) can reach the clip.
  const mountAt = (path: string, to: string) =>
    render(
      <MemoryRouter initialEntries={[path]}>
        <AudioOnLeave />
        <Nav to={to} />
      </MemoryRouter>,
    )

  it('WITHOUT system controls, going to another screen or another thread stops the clip and gives the route back', () => {
    for (const [from, to] of [
      ['/t/general', '/'],
      ['/t/general', '/t/other'],
      ['/threads', '/files'],
    ] as const) {
      __resetAudioForTests()
      const rec = recordPlatform()
      const a = att()
      audioPlayer.open(item(a), src(a))
      expect(getAudioState().playing).toBe(true)
      const r = mountAt(from, to)
      fireEvent.click(screen.getByRole('button', { name: `go ${to}` }))
      expect(getAudioState(), `${from} to ${to}`).toMatchObject({ item: null, playing: false })
      expect(rec.log).toContain('audio:auto')
      r.unmount()
    }
  })

  it('WITH system controls, leaving the thread keeps the clip playing and the lock screen live; he stops it there', () => {
    for (const [from, to] of [
      ['/t/general', '/'],
      ['/t/general', '/t/other'],
      ['/threads', '/files'],
    ] as const) {
      __resetAudioForTests()
      const rec = recordPlatform(true)
      const a = att()
      audioPlayer.open(item(a), src(a))
      const r = mountAt(from, to)
      fireEvent.click(screen.getByRole('button', { name: `go ${to}` }))
      expect(getAudioState(), `${from} to ${to}`).toMatchObject({ playing: true, item: { key: expect.any(String) } })
      expect(rec.log).not.toContain('audio:auto')
      expect(rec.log).not.toContain('media:clear')
      // the lock screen's Pause (the handler the platform was given) stops it
      act(() => rec.handlers().pause?.())
      expect(getAudioState().playing).toBe(false)
      r.unmount()
    }
  })

  it('the real /card/:id and /open/:ref routes do not count as leaving; leaving from there still stops the clip', () => {
    const a = att()
    audioPlayer.open(item(a), src(a))
    render(
      <MemoryRouter initialEntries={['/t/general']}>
        <AudioOnLeave />
        <Many />
      </MemoryRouter>,
    )
    fireEvent.click(screen.getByRole('button', { name: 'go /card/c_01JBF3V7Q8K2M4N6P8R0S97001' }))
    expect(getAudioState().playing).toBe(true)
    fireEvent.click(screen.getByRole('button', { name: 'go /open/r_abc' }))
    expect(getAudioState().playing).toBe(true)
    fireEvent.click(screen.getByRole('button', { name: 'go /threads' }))
    expect(getAudioState()).toMatchObject({ item: null, playing: false })
  })

  it('moving inside the same thread (a sub-page, a query string) leaves it playing', () => {
    const a = att()
    audioPlayer.open(item(a), src(a))
    mountAt('/t/general', '/t/general/files?x=1')
    fireEvent.click(screen.getByRole('button', { name: 'go /t/general/files?x=1' }))
    expect(getAudioState()).toMatchObject({ playing: true, item: { key: expect.any(String) } })
  })
})

describe('sign-out and unread', () => {
  it('clearLocalData stops playback, clears the session and drops the saved positions', async () => {
    const rec = recordPlatform()
    const a = att()
    audioPlayer.open(item(a), src(a))
    const m = media(120)
    m.meta()
    m.at(33)
    audioPlayer.pause()
    audioPlayer.resume()
    expect(localStorage.getItem(POSITIONS_KEY)).not.toBeNull()
    await clearLocalData({ clear: async () => {} } as never)
    expect(getAudioState().item).toBeNull()
    expect(getAudioState().playing).toBe(false)
    expect(localStorage.getItem(POSITIONS_KEY)).toBeNull()
    expect(savedPosition(a.media_id)).toBe(0)
    expect(rec.log.slice(-2)).toEqual(['media:clear', 'audio:auto'])
    expect(audioElement().hasAttribute('src')).toBe(false)
  })

  it('playing and finishing a clip never marks anything read or changes the unread counts', () => {
    const { client } = stubClient()
    const c = client as unknown as ReturnType<typeof createFakeClient>
    c.store.setState((s) => ({ ...s, unread: { general: 3 } }))
    const mark = vi.spyOn(c, 'markThreadRead')
    const a = att()
    render(<Row a={a} id="m_1" client={client} />)
    fireEvent.click(screen.getByRole('button', { name: 'Play' }))
    const m = media(120)
    m.meta()
    m.at(30)
    m.end()
    expect(mark).not.toHaveBeenCalled()
    expect(c.store.getState().unread).toEqual({ general: 3 })
  })
})

// ---- review of PR #124 ---------------------------------------------------------------------------------------------------
const audioLog = (log: string[]) => log.filter((l) => l.startsWith('audio:'))

async function mountDrive() {
  setPlatform({
    ...(await import('../../src/lib/platform.ts')).getPlatform(),
    wakeLock: { acquire: async () => () => {} },
  })
  const { DriveScreen } = await import('../../src/features/drive/index.tsx')
  const { setup } = await import('../cards/helpers.tsx')
  const client = setup()
  client.store.setState((s) => ({
    ...s,
    config: s.config && {
      ...s.config,
      voice_notes: { ...s.config.voice_notes, driving_until: new Date(Date.now() + 3_600_000).toISOString() },
    },
  }))
  return render(
    <MemoryRouter>
      <ClientProvider client={client}>
        <DriveScreen />
      </ClientProvider>
    </MemoryRouter>,
  )
}

describe('the audio route belongs to a clip that is playing', () => {
  it('a paused pill holds the route quietly (so the lock screen stays Talos), a clip opened without playing holds nothing, stop() gives it back', () => {
    const platform = recordPlatform()
    const a = att()
    audioPlayer.open(item(a), src(a))
    audioPlayer.pause()
    expect(audioLog(platform.log).at(-1)).toBe('audio:paused')
    expect(platform.log.at(-1)).not.toBe('media:clear') // the lock-screen controls stay
    const b = att()
    platform.log.length = 0
    audioPlayer.open(item(b), src(b), [], { play: false, at: 30 })
    expect(audioLog(platform.log)).toEqual([])
    expect(platform.log.some((l) => l.startsWith('media:set'))).toBe(true)
    audioPlayer.stop()
    expect(audioLog(platform.log).at(-1)).toBe('audio:auto')
  })

  it('Drive leaving with a paused clip does not take the route back', async () => {
    const platform = recordPlatform()
    const a = att()
    audioPlayer.open(item(a), src(a))
    const r = await mountDrive()
    await act(async () => r.unmount())
    expect(audioLog(platform.log).at(-1)).toBe('audio:auto')
  })
})

describe('Drive speed reaches the dock', () => {
  it('changing the speed in Drive changes the dock speed, its element and what the rows show', async () => {
    const r = await mountDrive()
    expect(getAudioState().speed).toBe(1)
    fireEvent.click(screen.getByRole('button', { name: /Playback speed/ }))
    expect(getAudioState().speed).toBe(1.25)
    expect(audioElement().playbackRate).toBe(1.25)
    r.unmount()
  })
})

describe('rows and the playing clip', () => {
  it('agent audio has no duration_ms: the row learns the length from its probe and can be scrubbed', () => {
    const a = att({ kind: 'audio', duration_ms: undefined, name: 'report.mp3' })
    const { client } = stubClient()
    const r = render(<Row a={a} id="m_1:x" client={client} />)
    const slider = () => screen.getByRole('slider', { name: 'Seek' })
    expect(slider().getAttribute('aria-valuemax')).toBe('0')
    const probe = r.container.querySelector('audio') as HTMLAudioElement
    Object.defineProperty(probe, 'duration', { configurable: true, get: () => 720 })
    act(() => void probe.dispatchEvent(new Event('loadedmetadata')))
    expect(slider().getAttribute('aria-valuemax')).toBe('720')
    expect(r.container.textContent).toContain('12:00')
  })

  it('an Infinity-duration probe (recorder WebM) is ignored, not shown as a length', () => {
    const a = att({ duration_ms: undefined })
    const { client } = stubClient()
    const r = render(<Row a={a} id="m_1" client={client} />)
    const probe = r.container.querySelector('audio') as HTMLAudioElement
    Object.defineProperty(probe, 'duration', { configurable: true, get: () => Number.POSITIVE_INFINITY })
    act(() => void probe.dispatchEvent(new Event('loadedmetadata')))
    expect(screen.getByRole('slider', { name: 'Seek' }).getAttribute('aria-valuemax')).toBe('0')
  })

  it("scrubbing another row's waveform moves that row's spot and leaves the playing clip alone", () => {
    const playing = att()
    const other = att()
    const { client } = stubClient()
    render(
      <>
        <Row a={playing} id="m_1" client={client} />
        <Row a={other} id="m_2" client={client} />
      </>,
    )
    fireEvent.click(screen.getAllByRole('button', { name: 'Play' })[0] as HTMLElement)
    expect(getAudioState()).toMatchObject({ playing: true, item: { key: 'm_1' } })
    const sliders = screen.getAllByRole('slider', { name: 'Seek' })
    const s2 = sliders[1] as HTMLElement
    s2.getBoundingClientRect = () => ({ left: 0, width: 100, top: 0, right: 100, bottom: 44, height: 44 }) as DOMRect
    fireEvent.pointerDown(s2, { clientX: 50, pointerId: 1 })
    fireEvent.keyDown(s2, { key: 'ArrowRight' })
    expect(getAudioState()).toMatchObject({ playing: true, item: { key: 'm_1' } })
    expect(audioElement().getAttribute('src')).toBe(src(playing))
    expect(savedPosition(other.media_id)).toBeGreaterThan(1)
    expect(savedPosition(playing.media_id)).toBe(0)
  })

  it('returning to the thread does not reload a clip playing from a rehydrated URL', () => {
    const a = att()
    const { client } = stubClient()
    const rehydrated = `${src(a)}&r=1`
    audioPlayer.open(item(a, 'm_1'), rehydrated)
    const loads = vi.mocked(HTMLMediaElement.prototype.load)
    loads.mockClear()
    const r = render(<Row a={a} id="m_1" client={client} />)
    expect(audioElement().getAttribute('src')).toBe(rehydrated)
    expect(loads).not.toHaveBeenCalled()
    r.unmount()
    render(<Row a={a} id="m_1" client={client} />)
    expect(audioElement().getAttribute('src')).toBe(rehydrated)
    expect(loads).not.toHaveBeenCalled()
  })
})

describe('saved position at the top', () => {
  it('rewinding to the start and pausing forgets the old spot', () => {
    const a = att()
    localStorage.setItem(POSITIONS_KEY, JSON.stringify([[a.media_id, 60, Date.now()]]))
    __resetAudioForTests()
    audioPlayer.open(item(a), src(a))
    const m = media(120, 0)
    m.meta()
    m.at(60)
    audioPlayer.pause()
    expect(savedPosition(a.media_id)).toBe(60)
    audioPlayer.resume()
    audioPlayer.seek(0)
    m.at(0.14)
    audioPlayer.pause()
    expect(savedPosition(a.media_id)).toBe(0)
    expect(JSON.parse(localStorage.getItem(POSITIONS_KEY) ?? '[]')).toEqual([])
  })
})

describe('an unsized WebM played from a streaming muxer', () => {
  function unsized(at: number) {
    const a = audioElement()
    const clock = { t: at, dur: Number.POSITIVE_INFINITY }
    Object.defineProperty(a, 'duration', { configurable: true, get: () => clock.dur })
    Object.defineProperty(a, 'readyState', { configurable: true, get: () => 4 })
    Object.defineProperty(a, 'currentTime', {
      configurable: true,
      get: () => clock.t,
      set: (v: number) => {
        clock.t = v === 1e101 ? (Number.isFinite(clock.dur) ? clock.dur : 180) : v
      },
    })
    return { a, clock }
  }

  it('the duration fix runs paused: the seek to the end is not the clip ending, the spot survives, play continues', () => {
    const clip = att()
    localStorage.setItem(POSITIONS_KEY, JSON.stringify([[clip.media_id, 60, Date.now()]]))
    __resetAudioForTests()
    const queued = att()
    audioPlayer.open(item(clip, 'm_1'), src(clip), [item(queued, 'm_2')])
    const { a, clock } = unsized(0)
    expect(getAudioState().playing).toBe(true)
    playCalls = 0
    act(() => void a.dispatchEvent(new Event('loadedmetadata'))) // Infinity: the fix starts
    expect(pauseCalls).toBeGreaterThan(0)
    // the browser reports the end the fix seeks to: an `ended` here must not end the clip or skip to the next note
    clock.dur = 180
    act(() => void a.dispatchEvent(new Event('ended')))
    expect(getAudioState().item?.key).toBe('m_1')
    expect(savedPosition(clip.media_id)).toBe(60)
    act(() => void a.dispatchEvent(new Event('timeupdate'))) // the fix lands: back to the saved spot, and playing again
    expect(clock.t).toBe(60)
    expect(playCalls).toBe(1)
    expect(getAudioState()).toMatchObject({ playing: true, item: { key: 'm_1' } })
    expect(savedPosition(clip.media_id)).toBe(60)
  })

  it('a clip that was paused stays paused through the fix', () => {
    const clip = att()
    audioPlayer.open(item(clip, 'm_1'), src(clip), [], { play: false })
    const { a, clock } = unsized(0)
    act(() => void a.dispatchEvent(new Event('loadedmetadata')))
    clock.dur = 180
    act(() => void a.dispatchEvent(new Event('timeupdate')))
    expect(playCalls).toBe(0)
    expect(getAudioState().playing).toBe(false)
  })
})
