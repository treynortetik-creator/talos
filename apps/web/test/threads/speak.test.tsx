// @vitest-environment jsdom
// Read aloud in the app (the Listen button on an agent message): it is mounted in the real message row, it asks the Mac with
// ids only, it never talks over a call, a recording or another clip, it says so when the browser refuses sound, a late file does
// not start playing after the owner was told it failed, and sign-out stops it. The audio element is a stub (no sound anywhere);
// the fake client is the in-memory one with a scripted Mac behind `speak`.
import { type AttachmentRefT, type MessageT, newId } from '@talos-app/protocol'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { clearLocalData } from '../../src/features/auth/session.ts'
import { __resetDockForTests, audioDock, dockElement, getDockState } from '../../src/features/threads/audioDock.ts'
import { MessageView } from '../../src/features/threads/MessageView.tsx'
import {
  NOW_PLAYING_TITLE,
  READY_HINT,
  REFUSED_HINT,
  resetSpeak,
  speakKey,
  speakView,
} from '../../src/features/threads/speak.ts'
import { getCallController } from '../../src/features/voice/controller.ts'
import { ClientProvider, type TalosClient, TalosClientError } from '../../src/lib/client.ts'
import { createFakeClient } from '../../src/lib/fakeClient.ts'
import { setPlatform, webPlatform } from '../../src/lib/platform.ts'
import { createMemoryStorage } from '../../src/lib/storage.ts'
import type { SpeakAnswer } from '../../src/lib/v2Client.ts'

const SECRET = 'sk-live-TOP-SECRET'
const FENCE = '```'

const agentMsg = (over: Partial<MessageT> = {}): MessageT =>
  ({
    id: newId('m'),
    thread_id: 'general',
    author: 'agent',
    kind: 'text',
    text: 'The report is finished and saved in your notes.',
    format: 'markdown',
    created_at: '2026-10-28T15:00:00.000Z',
    ...over,
  }) as MessageT

const ref = (): AttachmentRefT =>
  ({
    media_id: newId('md'),
    kind: 'audio',
    role: 'voice_reply',
    mime: 'audio/mp4',
    name: 'read-aloud.m4a',
    size: 3,
    sha256: 'a'.repeat(64),
  }) as AttachmentRefT

type Script = SpeakAnswer | Error | (() => SpeakAnswer | Promise<SpeakAnswer>)
/** A client whose Mac answers the scripted answers in order (the last repeats). */
function rig(script: Script[]) {
  const base = createFakeClient()
  const calls: Array<{ messageId: string; threadId: string; fresh: boolean }> = []
  const listeners = new Map<string, Set<(f: Record<string, unknown>) => void>>()
  const fetched: string[] = []
  let i = 0
  const client = {
    ...base,
    fetchMedia: (id: string) => void fetched.push(id),
    onFrame: (type: string, l: (f: Record<string, unknown>) => void) => {
      const set = listeners.get(type) ?? new Set()
      set.add(l)
      listeners.set(type, set)
      return () => void set.delete(l)
    },
    speak: {
      async request(a: { messageId: string; threadId: string; fresh: boolean }) {
        calls.push(a)
        const step = script[Math.min(i++, script.length - 1)] as Script
        if (step instanceof Error) throw step
        return typeof step === 'function' ? step() : step
      },
    },
  } as unknown as TalosClient
  return {
    client,
    base,
    calls,
    fetched,
    emit: (type: string, f: Record<string, unknown>) =>
      act(() => {
        for (const l of [...(listeners.get(type) ?? [])]) l(f)
      }),
    listenerCount: (type: string) => listeners.get(type)?.size ?? 0,
  }
}

function mount(client: TalosClient, m: MessageT) {
  return render(
    <ClientProvider client={client}>
      <MemoryRouter>
        <MessageView message={m} cards={[]} inbox={[]} onOpenImage={() => {}} onOpenItem={() => {}} />
      </MemoryRouter>
    </ClientProvider>,
  )
}

let plays = 0
let playImpl: () => Promise<void>
beforeEach(() => {
  vi.useFakeTimers()
  localStorage.clear()
  __resetDockForTests()
  resetSpeak()
  plays = 0
  playImpl = () => Promise.resolve()
  vi.spyOn(HTMLMediaElement.prototype, 'play').mockImplementation(function (this: HTMLMediaElement) {
    plays++
    this.dispatchEvent(new Event('play'))
    return playImpl()
  })
  vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(function (this: HTMLMediaElement) {
    this.dispatchEvent(new Event('pause'))
  })
  vi.spyOn(HTMLMediaElement.prototype, 'load').mockImplementation(() => {})
})
afterEach(() => {
  cleanup()
  resetSpeak()
  getCallController().store.setState({ phase: 'idle' })
  __resetDockForTests()
  vi.useRealTimers()
  vi.restoreAllMocks()
  setPlatform(webPlatform)
  localStorage.clear()
})

const listen = () => screen.getByTestId('speak')
const tap = async () => {
  await act(async () => {
    fireEvent.click(listen())
  })
}
const tick = (ms: number) => act(async () => void (await vi.advanceTimersByTimeAsync(ms)))

describe('the button is in the real message row', () => {
  it('an agent message with text has Listen; the owner’s own message and a text-less row do not', () => {
    const { client } = rig([{ state: 'working' }])
    mount(client, agentMsg())
    expect(listen().getAttribute('aria-label')).toBe('Listen to this message')
    cleanup()
    mount(client, agentMsg({ author: 'owner' }))
    expect(screen.queryByTestId('speak')).toBeNull()
    cleanup()
    mount(client, agentMsg({ text: undefined }))
    expect(screen.queryByTestId('speak')).toBeNull()
  })

  it('the button can be reached by keyboard and is at least 44px tall', () => {
    const { client } = rig([{ state: 'working' }])
    mount(client, agentMsg())
    listen().focus()
    expect(document.activeElement).toBe(listen())
    expect(listen().className).toContain('min-h-11')
    expect(listen().tagName).toBe('BUTTON')
  })
})

describe('a tap', () => {
  it('asks with ids only (never the text), then polls with fresh=false, then plays on ready', async () => {
    const m = agentMsg({ text: `${FENCE}\nexport TOKEN=${SECRET}\n${FENCE}\nAll done, the deploy passed.` })
    const r = rig([
      { state: 'working', waitS: 30 },
      { state: 'ready', media: ref(), chars: 25, totalChars: 25, truncated: false },
    ])
    mount(r.client, m)
    await tap()
    expect(listen().getAttribute('data-state')).toBe('loading')
    expect(r.calls).toEqual([{ messageId: m.id, threadId: 'general', fresh: true }])
    expect(JSON.stringify(r.calls)).not.toContain(SECRET)
    expect(plays).toBe(0) // nothing plays before the audio exists
    await tick(1600)
    expect(r.calls.map((c) => c.fresh)).toEqual([true, false])
    expect(plays).toBe(1)
    const dock = getDockState()
    expect(dock.item?.key).toBe(speakKey(m.id))
    // the lock screen and pill never carry message text
    expect(dock.item?.title).toBe(NOW_PLAYING_TITLE)
    expect(JSON.stringify(dock.item)).not.toContain(SECRET)
    expect(JSON.stringify(dock.item)).not.toContain('deploy')
  })

  it('a failure from the Mac, a refusal and an unknown answer all show words, never silence', async () => {
    const m = agentMsg()
    const failed = rig([{ state: 'failed', reason: 'no_tts', message: 'Your Mac has no voice set up yet.' }])
    mount(failed.client, m)
    await tap()
    expect(screen.getByRole('alert').textContent).toContain('no voice set up')
    expect(listen().getAttribute('aria-label')).toBe('Try again to this message')
    cleanup()
    resetSpeak()
    const offline = rig([new TalosClientError('mac_offline', 'x')])
    mount(offline.client, m)
    await tap()
    expect(screen.getByRole('alert').textContent).toMatch(/offline or didn't answer/)
    cleanup()
    resetSpeak()
    // the Mac's own words for a reason this app does not know
    const odd = rig([{ state: 'failed', reason: 'from_the_future', message: 'Quota used up.' }])
    mount(odd.client, m)
    await tap()
    expect(screen.getByRole('alert').textContent).toBe('Quota used up.')
  })

  it('a Mac that does not list speak/1 is told apart from one that is offline, and nothing is sent', async () => {
    const r = rig([{ state: 'working' }])
    r.base.store.setState((s) => ({ presence: { ...s.presence, features: ['search/1'] } }))
    mount(r.client, agentMsg())
    await tap()
    expect(screen.getByRole('alert').textContent).toMatch(/too old/)
    expect(r.calls).toEqual([])
  })

  it('Cancel stops the asking', async () => {
    const r = rig([{ state: 'working', waitS: 100 }])
    const m = agentMsg()
    mount(r.client, m)
    await tap()
    await tick(3200)
    const n = r.calls.length
    expect(n).toBeGreaterThan(1)
    await tap() // the same button now reads Cancel
    await tick(10_000)
    expect(r.calls).toHaveLength(n)
    expect(speakView(m.id).status).toBe('idle')
  })
})

describe('the speaker may have changed hands while the Mac worked', () => {
  const readyAfterWork = (r: ReturnType<typeof rig>) => r.calls.length > 0
  const script = (): Script[] => [
    { state: 'working', waitS: 100 },
    { state: 'ready', media: ref() },
  ]

  it('a call that started after the tap: the audio is not loaded or played, and the row says it is ready', async () => {
    const r = rig(script())
    mount(r.client, agentMsg())
    await tap()
    expect(readyAfterWork(r)).toBe(true)
    act(() => getCallController().store.setState({ phase: 'live' as never }))
    await tick(1600)
    expect(plays).toBe(0)
    expect(getDockState().item).toBeNull()
    expect(screen.getByTestId('speak-status').textContent).toBe(READY_HINT)
    // a second tap once the call is over is instant on the Mac and plays
    act(() => getCallController().store.setState({ phase: 'idle' }))
    r.client.speak!.request = async () => ({ state: 'ready', media: ref() })
    await tap()
    expect(plays).toBe(1)
  })

  it('a recording or Drive that took the speaker (they ask the dock to pause): nothing plays', async () => {
    const r = rig(script())
    mount(r.client, agentMsg())
    await tap()
    audioDock.pause() // what recorder.ts, callController.ts and drive/index.tsx each do as they start
    await tick(1600)
    expect(plays).toBe(0)
    expect(getDockState().item).toBeNull()
    expect(screen.getByTestId('speak-status').textContent).toBe(READY_HINT)
  })

  it('another clip is playing: it is not replaced', async () => {
    const r = rig(script())
    mount(r.client, agentMsg())
    await tap()
    const other = {
      key: newId('m'),
      mediaId: newId('md'),
      title: 'Voice note',
      threadId: 'general',
      durationMs: 60_000,
    }
    audioDock.open(other, '/media/other?c=2', [], { play: true })
    expect(getDockState().playing).toBe(true)
    plays = 0
    await tick(1600)
    expect(plays).toBe(0)
    expect(getDockState().item?.key).toBe(other.key)
    expect(screen.getByTestId('speak-status').textContent).toBe(READY_HINT)
  })
})

describe('the browser refuses sound (Safari, Home Screen app)', () => {
  it('NotAllowedError: the row says so and offers Resume; it is not a silent Resume', async () => {
    playImpl = () => Promise.reject(Object.assign(new Error('blocked'), { name: 'NotAllowedError' }))
    const r = rig([{ state: 'ready', media: ref() }])
    mount(r.client, agentMsg())
    await tap()
    await tick(0)
    expect(screen.getByTestId('speak-status').textContent).toBe(REFUSED_HINT)
    expect(listen().getAttribute('aria-label')).toBe('Resume')
    // the Resume tap is a gesture: it plays, and the hint goes away
    playImpl = () => Promise.resolve()
    await tap()
    expect(getDockState().playing).toBe(true)
    expect(screen.queryByTestId('speak-status')).toBeNull()
  })

  it('AbortError (a newer load replaced this one) is not an error to show', async () => {
    playImpl = () => Promise.reject(Object.assign(new Error('replaced'), { name: 'AbortError' }))
    const r = rig([{ state: 'ready', media: ref() }])
    mount(r.client, agentMsg())
    await tap()
    await tick(0)
    expect(screen.queryByTestId('speak-status')).toBeNull()
  })
})

describe('a file the relay no longer has', () => {
  it('a media.ready that arrives after the owner was told it failed does not start playing', async () => {
    const media = ref()
    const r = rig([{ state: 'ready', media }])
    const m = agentMsg()
    mount(r.client, m)
    await tap()
    expect(plays).toBe(1)
    dockElement().dispatchEvent(new Event('error')) // the relay does not have the file: the app asks the Mac for it
    expect(r.fetched).toEqual([media.media_id])
    await tick(21_000) // the Mac is slower than the app is willing to wait
    expect(screen.getByRole('alert').textContent).toContain("couldn't be loaded")
    expect(r.listenerCount('media.ready')).toBe(0)
    plays = 0
    r.emit('media.ready', { media_id: media.media_id })
    expect(plays).toBe(0)
  })

  it('a media.ready in time reloads the clip', async () => {
    const media = ref()
    const r = rig([{ state: 'ready', media }])
    mount(r.client, agentMsg())
    await tap()
    dockElement().dispatchEvent(new Event('error'))
    plays = 0
    r.emit('media.ready', { media_id: media.media_id })
    expect(getDockState().src).toContain('r=1')
    expect(plays).toBe(1)
  })
})

describe('sign-out reaches a tap that is still waiting', () => {
  it('clearLocalData stops the asking, forgets notes, and a late ready plays nothing', async () => {
    let release: (a: SpeakAnswer) => void = () => {}
    const r = rig([{ state: 'working', waitS: 100 }, () => new Promise<SpeakAnswer>((res) => (release = res))])
    const m = agentMsg()
    mount(r.client, m)
    await tap()
    await tick(1600) // the second ask is now in flight
    expect(r.calls).toHaveLength(2)
    await act(async () => {
      await clearLocalData(createMemoryStorage())
    })
    expect(speakView(m.id)).toEqual({ status: 'idle' })
    await act(async () => release({ state: 'ready', media: ref() }))
    await tick(5000)
    expect(plays).toBe(0)
    expect(getDockState().item).toBeNull()
    expect(r.calls).toHaveLength(2) // no further asks
  })
})
