// @vitest-environment jsdom
// PR #8 review: failing unit tests (player). Place in apps/web/test/ and run `pnpm vitest run test/review-pr8`.
import { newId } from '@talos-app/protocol'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AudioPlayer } from '../src/features/threads/Attachments.tsx'
import { __resetDockForTests, dockElement } from '../src/features/threads/audioDock.ts'
import { ClientProvider } from '../src/lib/client.ts'
import { createFakeClient } from '../src/lib/fakeClient.ts'

const att = {
  media_id: newId('md'),
  kind: 'voice_note' as const,
  role: 'attachment' as const,
  mime: 'audio/webm',
  name: 'v.webm',
  size: 3,
  sha256: 'a'.repeat(64),
  duration_ms: 8000,
}

afterEach(() => {
  cleanup()
  __resetDockForTests()
  vi.restoreAllMocks()
})

// Playback lives in the app-level dock (D37), not in the row: the row is a view of it, so the test starts the clip and then
// drives the dock's element, as the browser would.
function renderPlayer() {
  vi.spyOn(HTMLMediaElement.prototype, 'play').mockImplementation(function (this: HTMLMediaElement) {
    this.dispatchEvent(new Event('play'))
    return Promise.resolve()
  })
  vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => {})
  vi.spyOn(HTMLMediaElement.prototype, 'load').mockImplementation(() => {})
  const client = createFakeClient()
  const r = render(
    <ClientProvider client={client}>
      <AudioPlayer att={att} messageId="m_1" variant="voice_note" />
    </ClientProvider>,
  )
  act(() => {
    fireEvent.click(screen.getByRole('button', { name: 'Play' }))
  })
  return { ...r, audio: dockElement() }
}

describe('PR8 voice-note player', () => {
  // F-VN1 (HIGH): no scrubbing. The waveform is aria-hidden decoration; there is no way to seek (spec 10.5 #7).
  it('has a seek control on the waveform', () => {
    renderPlayer()
    expect(screen.getByRole('slider', { name: /seek|position|playback/i })).toBeTruthy()
  })

  // F-VN3 (MEDIUM): Chrome's MediaRecorder writes WebM with no duration, so audio.duration is Infinity and the
  // waveform never fills. The player must fall back to the attachment's duration_ms.
  it('fills the waveform from duration_ms when audio.duration is Infinity (Chrome MediaRecorder WebM)', () => {
    const { audio, container } = renderPlayer()
    Object.defineProperty(audio, 'duration', { configurable: true, get: () => Number.POSITIVE_INFINITY })
    Object.defineProperty(audio, 'currentTime', { configurable: true, get: () => 4 })
    act(() => {
      fireEvent.timeUpdate(audio)
    })
    expect(container.querySelectorAll('.bg-accent-text').length).toBeGreaterThan(5) // filled (played) bars
  })
})
