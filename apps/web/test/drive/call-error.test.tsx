// A failed "Talk live" on /drive. The drive screen mounts no composer, so the thread screen's call error line does not
// exist there: the screen has to show the call's error itself. Real DriveScreen, real CallController, refusing relay.
import { act, cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DriveScreen } from '../../src/features/drive/index.tsx'
import { CallController } from '../../src/features/voice/callController.ts'
import { setCallController } from '../../src/features/voice/index.tsx'
import { ClientProvider } from '../../src/lib/client.ts'
import { setPlatform, webPlatform } from '../../src/lib/platform.ts'
import { setup } from '../cards/helpers.tsx'
import { expectNothingLeftOpen, fakeDeps } from '../voice/fakes.ts'

beforeEach(() => {
  localStorage.clear()
  setPlatform({ ...webPlatform, audioSession: { set: () => {} }, wakeLock: { acquire: async () => () => {} } })
})
afterEach(() => {
  cleanup()
  setCallController(null)
  setPlatform(webPlatform)
  vi.useRealTimers()
  localStorage.clear()
})

function mount() {
  const f = fakeDeps({ fetchResponses: [new Response('{}', { status: 503 })] })
  const c = new CallController(f.deps)
  setCallController(c)
  const client = setup()
  client.store.setState((s) => ({
    ...s,
    config: s.config && {
      ...s.config,
      voice_notes: { ...s.config.voice_notes, driving_until: new Date(Date.now() + 3_600_000).toISOString() },
    },
  }))
  render(
    <MemoryRouter>
      <ClientProvider client={client}>
        <DriveScreen />
      </ClientProvider>
    </MemoryRouter>,
  )
  return { c, f }
}

describe('Talk live fails on /drive', () => {
  it('shows why in the screen, and takes it away when the call error fades', async () => {
    const { c, f } = mount()
    await userEvent.click(await screen.findByRole('button', { name: 'Talk live' }))
    const line = await screen.findByTestId('drive-error')
    expect(line.getAttribute('role')).toBe('alert')
    expect(line.textContent).toContain("Live voice isn't set up on this relay.")
    expectNothingLeftOpen(f)
    await act(async () => c.dismissError())
    expect(screen.queryByTestId('drive-error')).toBeNull()
  })

  it('shows no error line before any call has failed', async () => {
    mount()
    expect(screen.queryByTestId('drive-error')).toBeNull()
  })
})
