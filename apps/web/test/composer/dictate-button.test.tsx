// @vitest-environment jsdom
// One-touch dictation in the composer: tap, talk, tap; the words land in the box and the owner sends them himself.
import { act, cleanup, fireEvent, render, renderHook, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useSession } from '../../src/features/auth/session.ts'
import { Composer } from '../../src/features/composer/Composer.tsx'
import { useComposerStore } from '../../src/features/composer/composerStore.ts'
import { useDictation } from '../../src/features/composer/useDictation.ts'
import { ClientProvider } from '../../src/lib/client.ts'
import { createMetaStore } from '../../src/lib/connectionMeta.ts'
import { createMemoryStorage } from '../../src/lib/storage.ts'
import { StorageProvider } from '../../src/lib/storageContext.tsx'
import { setup } from '../cards/helpers.tsx'

const recorder = vi.hoisted(() => ({
  elapsed: 3000,
  stop: undefined as unknown as ReturnType<typeof vi.fn>,
  started: 0,
  cancelled: 0,
  audio: undefined as unknown as Blob,
  ended: false,
  startError: null as Error | null,
}))

vi.mock('../../src/features/composer/recorder.ts', async (orig) => ({
  ...(await orig<typeof import('../../src/features/composer/recorder.ts')>()),
  pickMime: () => 'audio/webm',
  startRecorder: () => {
    recorder.started++
    if (recorder.startError) return Promise.reject(recorder.startError)
    return Promise.resolve({
      cancel() {
        recorder.cancelled++
      },
      pause() {},
      resume() {},
      snapshot: async () => recorder.audio,
      elapsedMs: () => recorder.elapsed,
      endedByItself: () => recorder.ended,
      stop: recorder.stop,
    })
  },
}))

const me = (dictate?: { available: boolean }) => ({
  device_pinned: true,
  has_passkey: true,
  rp_id: 'relay.example.com',
  version: '1',
  bridge_online: true,
  ...(dictate ? { dictate } : {}),
})

const ok = (text: string) => new Response(JSON.stringify({ text }), { status: 200 })
const refused = (status: number, error: string, extra: Record<string, unknown> = {}) =>
  new Response(JSON.stringify({ error, ...extra }), { status })

let fetchMock: ReturnType<typeof vi.fn>
beforeEach(() => {
  Element.prototype.scrollIntoView = () => {}
  recorder.elapsed = 3000
  recorder.started = 0
  recorder.cancelled = 0
  recorder.ended = false
  recorder.startError = null
  recorder.audio = new Blob(['recorded-bytes'], { type: 'audio/webm' })
  recorder.stop = vi.fn(async () => ({
    blob: recorder.audio,
    mime: 'audio/webm',
    durationMs: recorder.elapsed,
    waveform: '',
    endedByItself: recorder.ended,
  }))
  fetchMock = vi.fn()
  vi.stubGlobal('fetch', fetchMock)
  Object.defineProperty(navigator, 'mediaDevices', { value: { getUserMedia: vi.fn() }, configurable: true })
  useSession.setState({ status: 'authed', me: me({ available: true }) as never })
})
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  useComposerStore.setState({ chips: {} })
})

function mount(over: Record<string, unknown> = {}, threadId = 't1') {
  const client = Object.assign(setup({}), over) as ReturnType<typeof setup>
  const ui = (id: string) => (
    <StorageProvider storage={createMemoryStorage()}>
      <ClientProvider client={client}>
        <Composer threadId={id} placeholder="Message" />
      </ClientProvider>
    </StorageProvider>
  )
  const r = render(ui(threadId))
  return { client, rerender: (id: string) => r.rerender(ui(id)) }
}
const box = () => screen.getByRole('textbox', { name: 'Message' }) as HTMLTextAreaElement
const tapDictate = () => fireEvent.click(screen.getByTestId('dictate'))
const tapStop = () => fireEvent.click(screen.getByRole('button', { name: 'Stop dictating' }))

describe('dictate button availability', () => {
  it('is hidden when the relay says dictation is off', () => {
    useSession.setState({ me: me({ available: false }) as never })
    mount()
    expect(screen.queryByTestId('dictate')).toBeNull()
  })

  it('is hidden on a relay that does not report dictation', () => {
    useSession.setState({ me: me() as never })
    mount()
    expect(screen.queryByTestId('dictate')).toBeNull()
  })

  it('is hidden where the recorder cannot work', () => {
    Object.defineProperty(navigator, 'mediaDevices', { value: undefined, configurable: true })
    mount()
    expect(screen.queryByTestId('dictate')).toBeNull()
  })

  it('is shown when both are true, next to the voice note mic', () => {
    mount()
    expect(screen.getByTestId('dictate')).toBeTruthy()
    expect(screen.getByTestId('mic')).toBeTruthy()
  })

  it('stays beside Send once something is typed', () => {
    mount()
    fireEvent.change(box(), { target: { value: 'typed' } })
    expect(screen.getByTestId('dictate')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Send' })).toBeTruthy()
  })
})

describe('dictating', () => {
  it('records, shows elapsed time and a stop, then puts the words in an empty box without sending', async () => {
    fetchMock.mockResolvedValue(ok('hello there'))
    const sendMessage = vi.fn()
    mount({ sendMessage })
    tapDictate()
    await screen.findByTestId('dictate-recording')
    expect(screen.getByRole('button', { name: 'Stop dictating' })).toBeTruthy()
    tapStop()
    await waitFor(() => expect(box().value).toBe('hello there'))
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toBe('/api/dictate')
    expect(init.method).toBe('POST')
    expect((init.headers as Record<string, string>)['X-Talos-CSRF']).toBe('1')
    expect(init.body).toBe(recorder.audio)
    expect(sendMessage).not.toHaveBeenCalled()
    expect(screen.getByTestId('dictate-done')).toBeTruthy()
  })

  it('keeps what was typed: words go at the end when the box was not focused', async () => {
    fetchMock.mockResolvedValue(ok('and then more'))
    const sendMessage = vi.fn()
    mount({ sendMessage })
    fireEvent.change(box(), { target: { value: 'Already typed.' } })
    tapDictate()
    await screen.findByTestId('dictate-recording')
    tapStop()
    await waitFor(() => expect(box().value).toBe('Already typed. and then more'))
    expect(sendMessage).not.toHaveBeenCalled()
  })

  it('puts focus back in the box on a desktop pointer when words arrive', async () => {
    fetchMock.mockResolvedValue(ok('hello there'))
    mount()
    tapDictate()
    await screen.findByTestId('dictate-recording')
    tapStop()
    await waitFor(() => expect(box().value).toBe('hello there'))
    expect(document.activeElement).toBe(box())
  })

  it('leaves focus alone on a touch device in a browser, so the keyboard does not pop up', async () => {
    const real = window.matchMedia
    window.matchMedia = ((q: string) => ({ matches: q === '(pointer: coarse)' })) as unknown as typeof window.matchMedia
    try {
      fetchMock.mockResolvedValue(ok('hello there'))
      mount()
      tapDictate()
      await screen.findByTestId('dictate-recording')
      tapStop()
      await waitFor(() => expect(box().value).toBe('hello there'))
      expect(document.activeElement).not.toBe(box())
    } finally {
      window.matchMedia = real
    }
  })

  it('always adds at the end, whatever the caret or selection was at the tap', async () => {
    fetchMock.mockResolvedValue(ok('in the middle'))
    mount()
    fireEvent.change(box(), { target: { value: 'start end' } })
    box().focus()
    box().setSelectionRange(5, 5)
    tapDictate()
    await screen.findByTestId('dictate-recording')
    tapStop()
    await waitFor(() => expect(box().value).toBe('start end in the middle'))
  })

  it('words never overwrite: a selection taken at the tap does not delete what was typed after', async () => {
    fetchMock.mockResolvedValue(ok('and the tail'))
    mount()
    fireEvent.change(box(), { target: { value: 'first draft' } })
    box().focus()
    box().setSelectionRange(0, 11) // everything selected when the button was tapped
    tapDictate()
    await screen.findByTestId('dictate-recording')
    fireEvent.change(box(), { target: { value: 'typed while talking' } })
    tapStop()
    await waitFor(() => expect(box().value).toBe('typed while talking and the tail'))
  })

  it('does not double the gap when the box already ends in a space or newline', async () => {
    fetchMock.mockResolvedValue(ok('next'))
    mount()
    fireEvent.change(box(), { target: { value: 'line one\n' } })
    tapDictate()
    await screen.findByTestId('dictate-recording')
    tapStop()
    await waitFor(() => expect(box().value).toBe('line one\nnext'))
  })

  it('warns before the ten minute cap', async () => {
    recorder.elapsed = 9 * 60_000 + 10_000
    mount()
    tapDictate()
    await waitFor(() => expect(screen.getByText(/Under a minute left/)).toBeTruthy())
  })

  it('stops by itself at the cap and still transcribes', async () => {
    fetchMock.mockResolvedValue(ok('long one'))
    recorder.elapsed = 10 * 60_000
    mount()
    tapDictate()
    await waitFor(() => expect(box().value).toBe('long one'))
    expect(recorder.stop).toHaveBeenCalledTimes(1)
  })

  it('a stray tap that records almost nothing sends nothing', async () => {
    recorder.elapsed = 100
    mount()
    tapDictate()
    await screen.findByTestId('dictate-recording')
    tapStop()
    await waitFor(() => expect(screen.queryByTestId('dictate-recording')).toBeNull())
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('Cancel while recording drops the audio and sends nothing', async () => {
    mount()
    tapDictate()
    await screen.findByTestId('dictate-recording')
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    await waitFor(() => expect(recorder.cancelled).toBe(1))
    expect(fetchMock).not.toHaveBeenCalled()
  })
})

describe('a failed transcription keeps the recording', () => {
  it('offers Try again, which sends the same recording again and inserts the words', async () => {
    fetchMock.mockResolvedValueOnce(refused(502, 'upstream_unreachable')).mockResolvedValueOnce(ok('second time'))
    mount()
    fireEvent.change(box(), { target: { value: 'keep me' } })
    tapDictate()
    await screen.findByTestId('dictate-recording')
    tapStop()
    await screen.findByTestId('dictate-failed')
    expect(screen.getByText(/couldn't reach the transcription service/i)).toBeTruthy()
    expect(box().value).toBe('keep me')
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }))
    await waitFor(() => expect(box().value).toBe('keep me second time'))
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect((fetchMock.mock.calls[1] as [string, RequestInit])[1].body).toBe(recorder.audio)
    expect(recorder.stop).toHaveBeenCalledTimes(1) // recorded once, sent twice
  })

  it('offers Send as voice note, which uploads the same audio as a voice note', async () => {
    fetchMock.mockResolvedValue(refused(504, 'upstream_timeout'))
    const att = {
      media_id: 'md_01JZ0000000000000000000000',
      mime: 'audio/webm',
      name: 'v.webm',
      size: 3,
      sha256: 'a'.repeat(64),
    }
    const uploadMedia = vi.fn().mockResolvedValue(att)
    const sendVoiceNote = vi.fn().mockResolvedValue(undefined)
    const { client } = mount({ uploadMedia, sendVoiceNote })
    client.store.setState((s) => ({ ...s, connection: 'online' }))
    tapDictate()
    await screen.findByTestId('dictate-recording')
    tapStop()
    await screen.findByTestId('dictate-failed')
    fireEvent.click(screen.getByRole('button', { name: 'Send as voice note' }))
    await waitFor(() => expect(sendVoiceNote).toHaveBeenCalledTimes(1))
    expect(uploadMedia.mock.calls[0]?.[0]).toBe(recorder.audio)
    expect(box().value).toBe('')
    expect(screen.queryByTestId('dictate-failed')).toBeNull()
  })

  it('says plainly when offline, and keeps the recording', async () => {
    fetchMock.mockRejectedValue(new TypeError('Failed to fetch'))
    vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false)
    mount()
    tapDictate()
    await screen.findByTestId('dictate-recording')
    tapStop()
    await screen.findByText(/You're offline/)
    expect(screen.getByRole('button', { name: 'Try again' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Send as voice note' })).toBeTruthy()
  })

  it('says why for the daily cap and the hourly limit, and never auto-sends', async () => {
    const sendMessage = vi.fn()
    mount({ sendMessage })
    fetchMock.mockResolvedValueOnce(refused(429, 'daily_cap'))
    tapDictate()
    await screen.findByTestId('dictate-recording')
    tapStop()
    await screen.findByText(/too long for what's left of today's dictation limit/i)
    expect(screen.queryByText(/used up/i)).toBeNull()
    expect(sendMessage).not.toHaveBeenCalled()
  })

  it('when nothing is left today it says the limit is used up and suggests a voice note', async () => {
    const sendMessage = vi.fn()
    mount({ sendMessage })
    fetchMock.mockResolvedValueOnce(refused(429, 'daily_cap', { used_up: true }))
    tapDictate()
    await screen.findByTestId('dictate-recording')
    tapStop()
    await screen.findByText(/used up/i)
    expect(screen.getByText(/limit is used up\. Send it as a voice note/i)).toBeTruthy()
    expect(screen.queryByText(/shorter one/i)).toBeNull()
  })

  it('when some allowance is left it builds its own text from left_bytes, never relay prose', async () => {
    mount()
    fetchMock.mockResolvedValueOnce(
      refused(429, 'daily_cap', { used_up: false, left_bytes: 424 * 1024, message: 'RELAY PROSE' }),
    )
    tapDictate()
    await screen.findByTestId('dictate-recording')
    tapStop()
    await screen.findByText(/about 424 KB/i)
    expect(screen.queryByText(/RELAY PROSE/)).toBeNull()
    expect(screen.getByText(/shorter one/i)).toBeTruthy()
  })

  it('left_bytes in megabytes reads as MB', async () => {
    mount()
    fetchMock.mockResolvedValueOnce(refused(429, 'daily_cap', { used_up: false, left_bytes: 3.5 * 1024 * 1024 }))
    tapDictate()
    await screen.findByTestId('dictate-recording')
    tapStop()
    await screen.findByText(/about 3\.5 MB/i)
  })

  it('an answer with no words is a failure, not an empty insert', async () => {
    fetchMock.mockResolvedValue(ok('   '))
    mount()
    tapDictate()
    await screen.findByTestId('dictate-recording')
    tapStop()
    await screen.findByText(/No words came through/)
    expect(box().value).toBe('')
  })
})

describe('leaving and signing out', () => {
  it('leaving the thread drops a kept recording and its answer', async () => {
    let release: (r: Response) => void = () => {}
    fetchMock.mockReturnValue(new Promise<Response>((r) => (release = r)))
    const { rerender } = mount()
    tapDictate()
    await screen.findByTestId('dictate-recording')
    tapStop()
    await screen.findByTestId('dictate-working')
    rerender('t2')
    await waitFor(() => expect(screen.queryByTestId('dictate-working')).toBeNull())
    await act(async () => release(ok('late words')))
    expect(box().value).toBe('')
  })

  it('a session that ends drops the recording: no retry is offered', async () => {
    fetchMock.mockResolvedValue(refused(502, 'upstream_refused'))
    mount()
    tapDictate()
    await screen.findByTestId('dictate-recording')
    tapStop()
    await screen.findByTestId('dictate-failed')
    act(() => useSession.setState({ status: 'anon', me: null }))
    expect(screen.queryByTestId('dictate-failed')).toBeNull()
    expect(screen.queryByRole('button', { name: 'Try again' })).toBeNull()
  })

  it('a 401 from the relay drops the recording and offers no retry', async () => {
    fetchMock.mockResolvedValue(new Response('{}', { status: 401 }))
    mount()
    tapDictate()
    await screen.findByTestId('dictate-recording')
    tapStop()
    await screen.findByText(/signed out/i)
    expect(screen.queryByRole('button', { name: 'Try again' })).toBeNull()
  })
})

describe('the other buttons while dictating', () => {
  it('the voice note mic and the call button are off while recording, working and holding a recording', async () => {
    let release: (r: Response) => void = () => {}
    fetchMock.mockReturnValueOnce(new Promise<Response>((r) => (release = r)))
    mount()
    const call = async () => (await screen.findByRole('button', { name: 'Start a live call' })) as HTMLButtonElement
    expect((await call()).disabled).toBe(false)
    expect((screen.getByTestId('mic') as HTMLButtonElement).disabled).toBe(false)
    tapDictate()
    await screen.findByTestId('dictate-recording')
    expect((await call()).disabled).toBe(true)
    expect((screen.getByTestId('mic') as HTMLButtonElement).disabled).toBe(true)
    tapStop()
    await screen.findByTestId('dictate-working')
    expect((await call()).disabled).toBe(true)
    expect((screen.getByTestId('mic') as HTMLButtonElement).disabled).toBe(true)
    await act(async () => release(refused(502, 'upstream_refused')))
    await screen.findByTestId('dictate-failed') // a kept recording
    expect((await call()).disabled).toBe(true)
    expect((screen.getByTestId('mic') as HTMLButtonElement).disabled).toBe(true)
    fireEvent.click(screen.getByRole('button', { name: 'Discard' }))
    await waitFor(async () => expect((await call()).disabled).toBe(false))
    expect((screen.getByTestId('mic') as HTMLButtonElement).disabled).toBe(false)
  })

  it('the dictate icon is neither the voice note mic nor the call waveform', async () => {
    mount()
    const path = (el: Element) => el.querySelector('path')?.getAttribute('d')
    const dictate = path(screen.getByTestId('dictate'))
    const mic = path(screen.getByTestId('mic'))
    const call = path(await screen.findByRole('button', { name: 'Start a live call' }))
    expect(dictate).toBeTruthy()
    expect(new Set([dictate, mic, call]).size).toBe(3)
  })
})

describe('a kept recording is never replaced', () => {
  it('Dictate is off while a failed recording is kept; tapping it starts nothing and Try again still has the audio', async () => {
    fetchMock.mockResolvedValueOnce(refused(502, 'upstream_unreachable')).mockResolvedValueOnce(ok('saved words'))
    mount()
    tapDictate()
    await screen.findByTestId('dictate-recording')
    tapStop()
    await screen.findByTestId('dictate-failed')
    const button = screen.getByTestId('dictate') as HTMLButtonElement
    expect(button.disabled).toBe(true)
    fireEvent.click(button)
    expect(recorder.started).toBe(1)
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }))
    await waitFor(() => expect(box().value).toBe('saved words'))
    expect((screen.getByTestId('dictate') as HTMLButtonElement).disabled).toBe(false)
  })

  it('start() itself refuses while a recording is kept, whatever calls it', async () => {
    fetchMock.mockResolvedValue(refused(502, 'upstream_unreachable'))
    const { result } = renderHook(() =>
      useDictation({ threadId: 't', onWords: vi.fn(), onSignedOut: vi.fn(), sendAsVoiceNote: vi.fn() }),
    )
    act(() => result.current.start())
    await waitFor(() => expect(result.current.phase.kind).toBe('recording'))
    await act(() => result.current.stop())
    await waitFor(() => expect(result.current.phase).toMatchObject({ kind: 'failed', kept: true }))
    act(() => result.current.start())
    expect(recorder.started).toBe(1)
    expect(result.current.phase).toMatchObject({ kind: 'failed', kept: true })
  })

  it('Discard drops the recording and turns Dictate back on', async () => {
    fetchMock.mockResolvedValue(refused(502, 'upstream_unreachable'))
    mount()
    tapDictate()
    await screen.findByTestId('dictate-recording')
    tapStop()
    await screen.findByTestId('dictate-failed')
    fireEvent.click(screen.getByRole('button', { name: 'Discard' }))
    await waitFor(() => expect(screen.queryByTestId('dictate-failed')).toBeNull())
    expect((screen.getByTestId('dictate') as HTMLButtonElement).disabled).toBe(false)
  })
})

describe('recorder trouble', () => {
  it('a recorder that fails says nothing was saved, and offers no Try again or voice note', async () => {
    recorder.stop = vi.fn(async () => {
      throw new Error('recorder failed')
    })
    mount()
    tapDictate()
    await screen.findByTestId('dictate-recording')
    tapStop()
    const note = await screen.findByTestId('dictate-denied')
    expect(note.textContent).toMatch(/nothing was saved/i)
    expect(note.textContent).not.toMatch(/kept/i)
    expect(screen.queryByRole('button', { name: 'Try again' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Send as voice note' })).toBeNull()
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('a long recording is not a stray tap, even when the recorder stopped by itself, and the owner is told', async () => {
    fetchMock.mockResolvedValue(ok('what it caught'))
    recorder.elapsed = 90_000
    recorder.ended = true // the browser cut it; the first tick sees that
    mount()
    tapDictate()
    await waitFor(() => expect(box().value).toBe('what it caught'))
    expect(screen.getByTestId('dictate-done').textContent).toMatch(/stopped by itself/i)
  })

  it('a long recording with nothing in it is reported, not dropped quietly', async () => {
    recorder.audio = new Blob([], { type: 'audio/webm' })
    mount()
    tapDictate()
    await screen.findByTestId('dictate-recording')
    tapStop()
    const note = await screen.findByTestId('dictate-denied')
    expect(note.textContent).toMatch(/nothing was recorded/i)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('a denied microphone note has a dismiss', async () => {
    recorder.startError = new DOMException('no', 'NotAllowedError')
    mount()
    tapDictate()
    const note = await screen.findByTestId('dictate-denied')
    expect(note.textContent).toMatch(/Microphone is off/)
    fireEvent.click(screen.getByRole('button', { name: 'OK' }))
    expect(screen.queryByTestId('dictate-denied')).toBeNull()
  })
})

describe('the Added to your message line', () => {
  it('goes away when the box is sent', async () => {
    fetchMock.mockResolvedValue(ok('hello there'))
    const sendMessage = vi.fn().mockResolvedValue(undefined)
    mount({ sendMessage })
    tapDictate()
    await screen.findByTestId('dictate-recording')
    tapStop()
    await screen.findByTestId('dictate-done')
    fireEvent.click(screen.getByRole('button', { name: 'Send' }))
    await waitFor(() => expect(box().value).toBe(''))
    expect(screen.queryByTestId('dictate-done')).toBeNull()
  })

  it('goes away when the box is emptied by hand, and stays while the words are there', async () => {
    fetchMock.mockResolvedValue(ok('hello there'))
    mount()
    tapDictate()
    await screen.findByTestId('dictate-recording')
    tapStop()
    await screen.findByTestId('dictate-done')
    fireEvent.change(box(), { target: { value: 'hello there and more' } })
    expect(screen.queryByTestId('dictate-done')).toBeTruthy()
    fireEvent.change(box(), { target: { value: '' } })
    await waitFor(() => expect(screen.queryByTestId('dictate-done')).toBeNull())
  })
})

describe('a 401', () => {
  it('tells the app the session ended, with the relay reason, and keeps nothing', async () => {
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ error: 'unauthorized', reason: 'revoked' }), { status: 401 }),
    )
    const meta = createMetaStore()
    mount({ meta, queueVoiceNote: vi.fn() })
    tapDictate()
    await screen.findByTestId('dictate-recording')
    tapStop()
    await screen.findByText(/signed out/i)
    expect(meta.getState().authFailed).toBe(true)
    expect(meta.getState().authReason).toBe('revoked')
    expect(screen.queryByRole('button', { name: 'Try again' })).toBeNull()
    expect((screen.getByTestId('dictate') as HTMLButtonElement).disabled).toBe(false)
  })
})
