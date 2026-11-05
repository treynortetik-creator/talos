// @vitest-environment jsdom
// D37: audio belongs to the app, not to the message row. These drive the real store, the real rows and the real pill; jsdom
// loads no media, so the element's own events (loadedmetadata, timeupdate, ended, error) are fired by hand and play/pause
// are stubs that fire the events a browser would.
import { type AttachmentRefT, type MessageT, newId } from '@talos-app/protocol'
import { act, cleanup, fireEvent, render, renderHook, screen } from '@testing-library/react'
import { MemoryRouter, useLocation } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { clearLocalData } from '../../src/features/auth/session.ts'
import { startRecorder } from '../../src/features/composer/recorder.ts'
import { AudioPlayer, useVoiceOrder, VoiceOrderContext } from '../../src/features/threads/Attachments.tsx'
import {
  __resetDockForTests,
  audioDock,
  dockElement,
  getDockState,
  MAX_SAVED,
  POSITIONS_KEY,
  SAVE_EVERY_MS,
  savedPosition,
} from '../../src/features/threads/audioDock.ts'
import { NowPlaying } from '../../src/features/threads/NowPlaying.tsx'
import { CallController } from '../../src/features/voice/callController.ts'
import { ClientProvider, type TalosClient } from '../../src/lib/client.ts'
import { createFakeClient } from '../../src/lib/fakeClient.ts'
import { type AudioSessionType, type MediaHandlers, setPlatform, webPlatform } from '../../src/lib/platform.ts'
import { fakeDeps } from '../voice/fakes.ts'

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
  threadId: 'general',
  durationMs: a.duration_ms ?? 0,
})
const src = (a: AttachmentRefT) => `/media/${a.media_id}?c=2`

/** What the platform was told, in order. */
function recordPlatform() {
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
    },
  })
  return { log, handlers: () => handlers, title: () => title }
}

let playCalls = 0
let pauseCalls = 0
beforeEach(() => {
  localStorage.clear()
  __resetDockForTests()
  playCalls = 0
  pauseCalls = 0
  vi.spyOn(HTMLMediaElement.prototype, 'play').mockImplementation(function (this: HTMLMediaElement) {
    playCalls++
    this.dispatchEvent(new Event('play'))
    return Promise.resolve()
  })
  vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(function (this: HTMLMediaElement) {
    pauseCalls++
    this.dispatchEvent(new Event('pause'))
  })
  vi.spyOn(HTMLMediaElement.prototype, 'load').mockImplementation(() => {})
})
afterEach(() => {
  cleanup()
  vi.useRealTimers()
  __resetDockForTests() // while play/pause/load are still stubs
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  setPlatform(webPlatform)
  localStorage.clear()
})

/** The element reports a clip of `duration` seconds, `at` seconds in. */
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

function Row({
  a,
  id,
  client,
  threadId = 'general',
}: {
  a: AttachmentRefT
  id: string
  client: TalosClient
  threadId?: string
}) {
  return (
    <ClientProvider client={client}>
      <AudioPlayer att={a} messageId={id} variant="voice_note" threadId={threadId} />
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
          threadId="general"
          transcript={msgs[0]?.transcript}
        />
      </ClientProvider>
    </VoiceOrderContext.Provider>
  )
}

function Where() {
  return <span data-testid="where">{useLocation().pathname}</span>
}

describe('the dock outlives the row', () => {
  it('playing keeps going after the message row unmounts (leaving the thread)', () => {
    const a = att()
    const { client } = stubClient()
    const r = render(<Row a={a} id="m_1" client={client} />)
    fireEvent.click(screen.getByRole('button', { name: 'Play' }))
    expect(getDockState()).toMatchObject({ playing: true, item: { key: 'm_1' } })
    const el = dockElement()
    r.unmount()
    expect(getDockState().playing).toBe(true)
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
    expect(probe).not.toBe(dockElement())
    expect(probe.hidden).toBe(true)
  })

  it('pause in the row pauses the dock and keeps the clip loaded; speed goes to the dock element', () => {
    const a = att()
    const { client } = stubClient()
    render(<Row a={a} id="m_1" client={client} />)
    fireEvent.click(screen.getByRole('button', { name: 'Play' }))
    fireEvent.click(screen.getByRole('button', { name: 'Pause' }))
    expect(getDockState()).toMatchObject({ playing: false, item: { key: 'm_1' } })
    fireEvent.click(screen.getByRole('button', { name: /Playback speed/ }))
    expect([dockElement().playbackRate, dockElement().preservesPitch]).toEqual([1.25, true])
    expect(localStorage.getItem('talos.audio.speed')).toBe('1.25')
  })
})

describe('saved position', () => {
  it('saves about every 5 s while playing, not on every tick', () => {
    vi.useFakeTimers()
    const a = att()
    audioDock.open(item(a), src(a))
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
    audioDock.open(item(a), src(a))
    const m = media(120)
    m.meta()
    m.at(31)
    audioDock.pause()
    expect(savedPosition(a.media_id)).toBe(31)
  })

  it('keeps the newest 50 and drops the oldest', () => {
    vi.useFakeTimers()
    const ids: string[] = []
    for (let i = 0; i < MAX_SAVED + 5; i++) {
      const a = att()
      ids.push(a.media_id)
      vi.advanceTimersByTime(10)
      audioDock.open(item(a), src(a))
      const m = media(120)
      m.meta()
      m.at(10 + i)
      audioDock.pause()
    }
    expect(JSON.parse(localStorage.getItem(POSITIONS_KEY) as string)).toHaveLength(MAX_SAVED)
    expect(savedPosition(ids[0] as string)).toBe(0)
    expect(savedPosition(ids.at(-1) as string)).toBeGreaterThan(0)
  })

  it('a reload resumes from the saved spot once the metadata is in', () => {
    const a = att()
    localStorage.setItem(POSITIONS_KEY, JSON.stringify([[a.media_id, 30, Date.now()]]))
    // "reload": the module state is rebuilt from storage
    __resetDockForTests()
    audioDock.open(item(a), src(a))
    const m = media(120)
    m.meta()
    expect(m.pos()).toBe(30)
    expect(getDockState().cur).toBe(30)
  })

  it('a clip left within 5 s of the end starts over, and finishing a clip forgets its spot', () => {
    const a = att()
    localStorage.setItem(POSITIONS_KEY, JSON.stringify([[a.media_id, 117, Date.now()]]))
    __resetDockForTests()
    audioDock.open(item(a), src(a))
    const m = media(120)
    m.meta()
    expect(m.pos()).toBe(0)
    m.at(40)
    audioDock.pause()
    expect(savedPosition(a.media_id)).toBe(40)
    m.end()
    expect(savedPosition(a.media_id)).toBe(0)
  })

  it('a row of a clip that is not loaded shows its saved spot', () => {
    const a = att()
    localStorage.setItem(POSITIONS_KEY, JSON.stringify([[a.media_id, 60, Date.now()]]))
    __resetDockForTests()
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
    expect(() => audioDock.open(item(a), src(a))).not.toThrow()
    const m = media(120)
    m.meta()
    m.at(20)
    expect(() => audioDock.pause()).not.toThrow()
    expect(savedPosition(a.media_id)).toBe(20)
  })
})

describe('the queue follows him out of the thread', () => {
  it('the next notes play after the row is gone, and the last one ends the dock', () => {
    const rec = recordPlatform()
    const [x, y, z] = [att(), att(), att()] as [AttachmentRefT, AttachmentRefT, AttachmentRefT]
    audioDock.open(item(x, 'm_x'), src(x), [item(y, 'm_y'), item(z, 'm_z')])
    const m = media(120)
    m.meta()
    // nothing is mounted: no row, no Timeline
    m.end()
    expect(getDockState().item?.key).toBe('m_y')
    expect(dockElement().getAttribute('src')).toBe(src(y))
    expect(playCalls).toBe(2)
    expect(rec.title()).toBe('v.webm')
    m.end()
    expect(getDockState().item?.key).toBe('m_z')
    m.end()
    expect(getDockState().item).toBeNull()
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
    expect(getDockState().item).toMatchObject({ key: 'm_1', title: 'note 1', threadId: 'general' })
    m.end()
    expect(getDockState().item?.key).toBe('m_2')
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
    expect(result.current.items?.get('m_1')).toMatchObject({ mediaId: a.media_id, threadId: 't1', title: 'Voice note' })
  })
})

describe('lock screen and audio route', () => {
  it('play sets the media session and the playback route; stop clears both', () => {
    const rec = recordPlatform()
    const a = att()
    audioDock.open(item(a), src(a))
    expect(rec.log).toEqual(['audio:playback', 'media:set:pause,play,seekbackward,seekforward,seekto'])
    const m = media(120, 50)
    m.meta()
    rec.handlers().seekforward?.()
    expect(m.pos()).toBe(60)
    rec.handlers().seekbackward?.()
    expect(m.pos()).toBe(50)
    rec.handlers().pause?.()
    expect(getDockState().playing).toBe(false)
    rec.handlers().play?.()
    expect(getDockState().playing).toBe(true)
    audioDock.stop()
    expect(rec.log.slice(-2)).toEqual(['media:clear', 'audio:auto'])
    expect(getDockState().item).toBeNull()
  })

  it('Drive opening pauses the dock, and Drive leaving does not wipe a clip still loaded', async () => {
    const rec = recordPlatform()
    setPlatform({
      ...(await import('../../src/lib/platform.ts')).getPlatform(),
      wakeLock: { acquire: async () => () => {} },
    })
    const a = att()
    const it = item(a)
    audioDock.open(it, src(a))
    expect(getDockState().playing).toBe(true)
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
    expect(getDockState()).toMatchObject({ playing: false, item: { key: it.key } })
    expect(pauseCalls).toBeGreaterThan(0)
    await act(async () => r.unmount())
    // the last thing the platform heard is the dock's session, not a clear
    expect(rec.log.at(-1)).toMatch(/^media:set:/)
    expect(rec.title()).toBe('v.webm')
    expect(rec.log.lastIndexOf('media:clear')).toBeLessThan(rec.log.length - 1)
    expect(getDockState().item).not.toBeNull()
  })

  it('a call starting pauses the dock', async () => {
    const a = att()
    audioDock.open(item(a), src(a))
    const f = fakeDeps({ fetchResponses: [new Response('{}', { status: 503 })] })
    await new CallController(f.deps).start(createFakeClient(), 'general')
    expect(getDockState().playing).toBe(false)
    expect(pauseCalls).toBeGreaterThan(0)
  })

  it('starting a voice note recording pauses the dock', async () => {
    const a = att()
    audioDock.open(item(a), src(a))
    vi.stubGlobal('MediaRecorder', { isTypeSupported: () => true })
    vi.stubGlobal('navigator', {
      ...navigator,
      mediaDevices: { getUserMedia: () => Promise.reject(new Error('denied')) },
    })
    await expect(startRecorder()).rejects.toThrow('denied')
    expect(getDockState().playing).toBe(false)
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
    expect(getDockState().failed).toBe(true)
    const before = dockElement().getAttribute('src')
    act(() => {
      for (const l of frames.slice()) l({ media_id: a.media_id })
    })
    expect(dockElement().getAttribute('src')).not.toBe(before)
    expect(dockElement().getAttribute('src')).toMatch(/\?c=2&r=1$/)
    expect(getDockState().failed).toBe(false)
    expect(playCalls).toBe(2) // it was playing, so it plays again
    m.meta()
    expect(m.pos()).toBe(42)
  })

  it('with no row mounted the pill says it failed; coming back to the thread starts the rehydrate', () => {
    const a = att()
    const { client, asked } = stubClient()
    audioDock.open(item(a, 'm_1'), src(a))
    media(120).error()
    render(
      <MemoryRouter>
        <NowPlaying />
      </MemoryRouter>,
    )
    expect(screen.getByTestId('now-playing-failed').textContent).toContain("Couldn't play")
    expect(asked).toEqual([])
    render(<Row a={a} id="m_1" client={client} />)
    expect(asked).toEqual([a.media_id])
  })
})

describe('the pill', () => {
  it('shows only while something is loaded, toggles play, and a tap on the title returns to the thread', () => {
    render(
      <MemoryRouter initialEntries={['/']}>
        <NowPlaying />
        <Where />
      </MemoryRouter>,
    )
    expect(screen.queryByTestId('now-playing')).toBeNull()
    const a = att({ name: 'report.mp3' })
    act(() => audioDock.open({ ...item(a, 'm_1'), threadId: 'th_9' }, src(a)))
    const pill = screen.getByTestId('now-playing')
    expect(pill.style.top).toContain('3.25rem') // header 2.75rem + a 0.5rem gap
    expect(pill.style.top).toContain('safe-area-inset-top')
    expect(pill.textContent).toContain('report.mp3')
    fireEvent.click(screen.getByRole('button', { name: 'Pause' }))
    expect(getDockState().playing).toBe(false)
    fireEvent.click(screen.getByRole('button', { name: 'Play' }))
    expect(getDockState().playing).toBe(true)
    fireEvent.click(screen.getByTestId('now-playing-open'))
    expect(screen.getByTestId('where').textContent).toBe('/t/th_9')
    fireEvent.click(screen.getByRole('button', { name: 'Stop playback' }))
    expect(screen.queryByTestId('now-playing')).toBeNull()
  })
})

describe('sign-out and unread', () => {
  it('clearLocalData stops playback, clears the session and drops the saved positions', async () => {
    const rec = recordPlatform()
    const a = att()
    audioDock.open(item(a), src(a))
    const m = media(120)
    m.meta()
    m.at(33)
    audioDock.pause()
    audioDock.resume()
    expect(localStorage.getItem(POSITIONS_KEY)).not.toBeNull()
    await clearLocalData({ clear: async () => {} } as never)
    expect(getDockState().item).toBeNull()
    expect(getDockState().playing).toBe(false)
    expect(localStorage.getItem(POSITIONS_KEY)).toBeNull()
    expect(savedPosition(a.media_id)).toBe(0)
    expect(rec.log.slice(-2)).toEqual(['media:clear', 'audio:auto'])
    expect(dockElement().hasAttribute('src')).toBe(false)
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
  it('a recording that starts releases the route, so the microphone is not under the dock playback session', async () => {
    const platform = recordPlatform()
    const a = att()
    audioDock.open(item(a), src(a))
    expect(audioLog(platform.log).at(-1)).toBe('audio:playback')
    vi.stubGlobal('MediaRecorder', { isTypeSupported: () => true })
    vi.stubGlobal('navigator', {
      ...navigator,
      mediaDevices: {
        getUserMedia: () => {
          // the route must already be given back at the moment capture is requested
          expect(audioLog(platform.log).at(-1)).toBe('audio:auto')
          return Promise.reject(new Error('denied'))
        },
      },
    })
    await expect(startRecorder()).rejects.toThrow('denied')
    expect(audioLog(platform.log).at(-1)).toBe('audio:auto')
    // the pill is still there, and play takes the route back
    expect(getDockState().item).not.toBeNull()
    audioDock.resume()
    expect(audioLog(platform.log).at(-1)).toBe('audio:playback')
  })

  it('a call that starts releases the route', async () => {
    const platform = recordPlatform()
    const a = att()
    audioDock.open(item(a), src(a))
    const f = fakeDeps({ fetchResponses: [new Response('{}', { status: 503 })] })
    await new CallController(f.deps).start(createFakeClient(), 'general')
    expect(audioLog(platform.log).at(-1)).toBe('audio:auto')
  })

  it('a paused pill holds the route quietly (so the lock screen stays Talos), a clip opened without playing holds nothing, stop() gives it back', () => {
    const platform = recordPlatform()
    const a = att()
    audioDock.open(item(a), src(a))
    audioDock.pause()
    expect(audioLog(platform.log).at(-1)).toBe('audio:paused')
    expect(platform.log.at(-1)).not.toBe('media:clear') // the lock-screen controls stay
    const b = att()
    platform.log.length = 0
    audioDock.open(item(b), src(b), [], { play: false, at: 30 })
    expect(audioLog(platform.log)).toEqual([])
    expect(platform.log.some((l) => l.startsWith('media:set'))).toBe(true)
    audioDock.stop()
    expect(audioLog(platform.log).at(-1)).toBe('audio:auto')
  })

  it('a recording that starts while the clip is already paused still gets the route back', async () => {
    const platform = recordPlatform()
    const a = att()
    audioDock.open(item(a), src(a))
    audioDock.pause()
    expect(audioLog(platform.log).at(-1)).toBe('audio:paused')
    vi.stubGlobal('MediaRecorder', { isTypeSupported: () => true })
    vi.stubGlobal('navigator', {
      ...navigator,
      mediaDevices: { getUserMedia: () => Promise.reject(new Error('denied')) },
    })
    await expect(startRecorder()).rejects.toThrow('denied')
    expect(audioLog(platform.log).at(-1)).toBe('audio:auto')
  })

  it('Drive leaving with a paused clip does not take the route back', async () => {
    const platform = recordPlatform()
    const a = att()
    audioDock.open(item(a), src(a))
    const r = await mountDrive()
    await act(async () => r.unmount())
    expect(audioLog(platform.log).at(-1)).toBe('audio:auto')
  })

  it('a reply arriving during a Drive talk (reclaim while paused) does not flip the session to playback', async () => {
    const platform = recordPlatform()
    const a = att()
    audioDock.open(item(a), src(a))
    audioDock.pause()
    platform.log.length = 0
    platform.log.push('audio:play-and-record') // Drive's talk
    audioDock.reclaimSession()
    expect(audioLog(platform.log).at(-1)).toBe('audio:play-and-record')
  })
})

describe('Drive speed reaches the dock', () => {
  it('changing the speed in Drive changes the dock speed, its element and what the rows show', async () => {
    const r = await mountDrive()
    expect(getDockState().speed).toBe(1)
    fireEvent.click(screen.getByRole('button', { name: /Playback speed/ }))
    expect(getDockState().speed).toBe(1.25)
    expect(dockElement().playbackRate).toBe(1.25)
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
    expect(getDockState()).toMatchObject({ playing: true, item: { key: 'm_1' } })
    const sliders = screen.getAllByRole('slider', { name: 'Seek' })
    const s2 = sliders[1] as HTMLElement
    s2.getBoundingClientRect = () => ({ left: 0, width: 100, top: 0, right: 100, bottom: 44, height: 44 }) as DOMRect
    fireEvent.pointerDown(s2, { clientX: 50, pointerId: 1 })
    fireEvent.keyDown(s2, { key: 'ArrowRight' })
    expect(getDockState()).toMatchObject({ playing: true, item: { key: 'm_1' } })
    expect(dockElement().getAttribute('src')).toBe(src(playing))
    expect(savedPosition(other.media_id)).toBeGreaterThan(1)
    expect(savedPosition(playing.media_id)).toBe(0)
  })

  it('returning to the thread does not reload a clip playing from a rehydrated URL', () => {
    const a = att()
    const { client } = stubClient()
    const rehydrated = `${src(a)}&r=1`
    audioDock.open(item(a, 'm_1'), rehydrated)
    const loads = vi.mocked(HTMLMediaElement.prototype.load)
    loads.mockClear()
    const r = render(<Row a={a} id="m_1" client={client} />)
    expect(dockElement().getAttribute('src')).toBe(rehydrated)
    expect(loads).not.toHaveBeenCalled()
    r.unmount()
    render(<Row a={a} id="m_1" client={client} />)
    expect(dockElement().getAttribute('src')).toBe(rehydrated)
    expect(loads).not.toHaveBeenCalled()
  })
})

describe('saved position at the top', () => {
  it('rewinding to the start and pausing forgets the old spot', () => {
    const a = att()
    localStorage.setItem(POSITIONS_KEY, JSON.stringify([[a.media_id, 60, Date.now()]]))
    __resetDockForTests()
    audioDock.open(item(a), src(a))
    const m = media(120, 0)
    m.meta()
    m.at(60)
    audioDock.pause()
    expect(savedPosition(a.media_id)).toBe(60)
    audioDock.resume()
    audioDock.seek(0)
    m.at(0.14)
    audioDock.pause()
    expect(savedPosition(a.media_id)).toBe(0)
    expect(JSON.parse(localStorage.getItem(POSITIONS_KEY) ?? '[]')).toEqual([])
  })
})

describe('an unsized WebM played from a streaming muxer', () => {
  function unsized(at: number) {
    const a = dockElement()
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
    __resetDockForTests()
    const queued = att()
    audioDock.open(item(clip, 'm_1'), src(clip), [item(queued, 'm_2')])
    const { a, clock } = unsized(0)
    expect(getDockState().playing).toBe(true)
    playCalls = 0
    act(() => void a.dispatchEvent(new Event('loadedmetadata'))) // Infinity: the fix starts
    expect(pauseCalls).toBeGreaterThan(0)
    // the browser reports the end the fix seeks to: an `ended` here must not end the clip or skip to the next note
    clock.dur = 180
    act(() => void a.dispatchEvent(new Event('ended')))
    expect(getDockState().item?.key).toBe('m_1')
    expect(savedPosition(clip.media_id)).toBe(60)
    act(() => void a.dispatchEvent(new Event('timeupdate'))) // the fix lands: back to the saved spot, and playing again
    expect(clock.t).toBe(60)
    expect(playCalls).toBe(1)
    expect(getDockState()).toMatchObject({ playing: true, item: { key: 'm_1' } })
    expect(savedPosition(clip.media_id)).toBe(60)
  })

  it('a clip that was paused stays paused through the fix', () => {
    const clip = att()
    audioDock.open(item(clip, 'm_1'), src(clip), [], { play: false })
    const { a, clock } = unsized(0)
    act(() => void a.dispatchEvent(new Event('loadedmetadata')))
    clock.dur = 180
    act(() => void a.dispatchEvent(new Event('timeupdate')))
    expect(playCalls).toBe(0)
    expect(getDockState().playing).toBe(false)
  })
})
