// The usage chip toggles the docked Session panel. While a details panel is open on the right the dock is not drawn, so a
// chip that still said "open" would be toggling something nobody can see: it steps aside until the details are closed.
import { act, cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, Route, Routes } from 'react-router'
import { afterEach, describe, expect, it } from 'vitest'
import { usePhonePanel } from '../../src/features/phone/phoneStore.ts'
import { setSessionDockOpen } from '../../src/features/session/dockPref.ts'
import { useDetailPanel } from '../../src/features/threads/DetailPanel.tsx'
import { ClientProvider } from '../../src/lib/client.ts'
import { createMemoryStorage } from '../../src/lib/storage.ts'
import { StorageProvider } from '../../src/lib/storageContext.tsx'
import { Shell } from '../../src/Shell.tsx'
import { setup } from '../cards/helpers.tsx'

afterEach(() => {
  cleanup()
  setSessionDockOpen(false)
  usePhonePanel.setState({ open: null, path: '', thread: null })
})

function OpenDetails() {
  const detail = useDetailPanel()
  return (
    <>
      <button type="button" onClick={() => detail.open(<p>job details</p>, 'Job')}>
        open details
      </button>
      <button type="button" onClick={() => detail.close()}>
        close details
      </button>
    </>
  )
}

describe('the Session chip next to a details panel', () => {
  it('is out of the way while details are open, and back (and honest about the panel) after', async () => {
    window.matchMedia = ((q: string) => ({
      matches: q.includes('min-width: 1024px') || q.includes('min-width: 768px'),
      media: q,
      addEventListener() {},
      removeEventListener() {},
    })) as unknown as typeof window.matchMedia
    usePhonePanel.setState({ thread: 'general' })
    const client = setup()
    render(
      <StorageProvider storage={createMemoryStorage()}>
        <ClientProvider client={client}>
          <MemoryRouter initialEntries={['/t/general']}>
            <Routes>
              <Route element={<Shell />}>
                <Route path="t/:thread" element={<OpenDetails />} />
              </Route>
            </Routes>
          </MemoryRouter>
        </ClientProvider>
      </StorageProvider>,
    )
    const chip = await screen.findByTestId('session-trigger')
    await userEvent.click(chip)
    expect(screen.getByTestId('session-trigger').getAttribute('aria-expanded')).toBe('true')
    expect(screen.getByTestId('session-dock')).toBeTruthy()
    await userEvent.click(screen.getByRole('button', { name: 'open details' }))
    expect(screen.queryByTestId('session-dock')).toBeNull()
    expect(screen.queryByTestId('session-trigger')).toBeNull()
    await act(async () => {})
    await userEvent.click(screen.getByRole('button', { name: 'close details' }))
    expect(screen.getByTestId('session-trigger').getAttribute('aria-expanded')).toBe('true')
    expect(screen.getByTestId('session-dock')).toBeTruthy()
  })
})
