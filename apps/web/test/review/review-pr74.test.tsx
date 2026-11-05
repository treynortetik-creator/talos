// Independent review of #74 (iOS WP-I4 TalosAudio). The native policy only gives the audio route back on `idle`, which the
// web adapter (#72) sends for `audioSession.set('auto')`. These tests drive the REAL /drive screen and record what reaches
// the platform's audioSession: once driving ends, the last call must release the session.
import { act, cleanup, render } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { afterEach, describe, expect, it } from 'vitest'
import { DriveScreen } from '../../src/features/drive/index.tsx'
import { ClientProvider } from '../../src/lib/client.ts'
import { type AudioSessionType, setPlatform, webPlatform } from '../../src/lib/platform.ts'
import { setup } from '../cards/helpers.tsx'

afterEach(() => {
  cleanup()
  setPlatform(webPlatform)
})

function recordSessions() {
  const calls: AudioSessionType[] = []
  setPlatform({
    ...webPlatform,
    audioSession: { set: (t) => void calls.push(t) },
    wakeLock: { acquire: async () => () => {} },
  })
  return calls
}

function driving(until: string | null) {
  const client = setup()
  client.store.setState((s) => ({
    ...s,
    config: s.config && { ...s.config, voice_notes: { ...s.config.voice_notes, driving_until: until } },
  }))
  return client
}

const inAnHour = () => new Date(Date.now() + 3_600_000).toISOString()

describe('review #74: the audio session is released when driving ends', () => {
  it('REVIEW-FAIL: leaving /drive sends audioSession "auto" (TalosAudio idle) after the "playback" it sent on entry', async () => {
    const calls = recordSessions()
    const client = driving(inAnHour())
    const view = render(
      <MemoryRouter>
        <ClientProvider client={client}>
          <DriveScreen />
        </ClientProvider>
      </MemoryRouter>,
    )
    expect(calls).toContain('playback') // control: the screen did take the route
    await act(async () => view.unmount())
    expect(calls.at(-1)).toBe('auto')
  })

  it('REVIEW-FAIL: driving turned off while /drive stays open sends audioSession "auto"', async () => {
    const calls = recordSessions()
    const client = driving(inAnHour())
    render(
      <MemoryRouter>
        <ClientProvider client={client}>
          <DriveScreen />
        </ClientProvider>
      </MemoryRouter>,
    )
    expect(calls).toContain('playback')
    await act(async () => {
      client.store.setState((s) => ({
        ...s,
        config: s.config && { ...s.config, voice_notes: { ...s.config.voice_notes, driving_until: null } },
      }))
    })
    expect(calls.at(-1)).toBe('auto')
  })
})
