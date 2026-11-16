// The Delete confirm for kept voice notes on /drive must not outlive the list it was asked about.
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { DriveScreen } from '../../src/features/drive/index.tsx'
import { getDrive } from '../../src/features/drive/instance.ts'
import { ClientProvider } from '../../src/lib/client.ts'
import { setPlatform, webPlatform } from '../../src/lib/platform.ts'
import { setup } from '../cards/helpers.tsx'

beforeEach(() => {
  localStorage.clear()
  setPlatform({ ...webPlatform, audioSession: { set: () => {} }, wakeLock: { acquire: async () => () => {} } })
})
afterEach(() => {
  cleanup()
  setPlatform(webPlatform)
  localStorage.clear()
})

describe('Delete confirm on kept voice notes (drive)', () => {
  it('is closed again when the list empties another way, so the next kept note is not one tap from deleted', async () => {
    const client = setup()
    client.store.setState((s) => ({
      ...s,
      config: s.config && {
        ...s.config,
        voice_notes: { ...s.config.voice_notes, driving_until: new Date(Date.now() + 3_600_000).toISOString() },
      },
    }))
    const { controller } = getDrive(client)
    render(
      <MemoryRouter>
        <ClientProvider client={client}>
          <DriveScreen />
        </ClientProvider>
      </MemoryRouter>,
    )
    act(() => controller.store.setState({ kept: 1 }))
    fireEvent.click(await screen.findByTestId('drive-delete'))
    expect(screen.getByTestId('drive-delete-confirm')).toBeTruthy()
    act(() => controller.store.setState({ kept: 0 })) // a Retry saved it
    act(() => controller.store.setState({ kept: 1 })) // a new note is kept
    expect(screen.queryByTestId('drive-delete-confirm')).toBeNull()
    expect(screen.getByTestId('drive-retry')).toBeTruthy()
  })
})
