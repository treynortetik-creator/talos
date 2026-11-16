// `/card/:id` is where a "Needs you" notification lands, and it draws the card's whole thread (App.tsx CardScreen renders
// ThreadView). The session chip, the phone panels and the reply banner all treat that as "this thread is on screen". Shell
// does not: it takes the thread on screen from the `/t/:thread` match only. So on `/card/:id`
//  - the iPhone shell is told no thread is being viewed (`TalosPush.setViewing({thread: null})`), and a reply in the very
//    thread the owner is reading arrives as a system notification;
//  - the keyboard and the palette get no current thread: "Search this thread" (Ctrl/Cmd+F) does nothing and is not listed.
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { usePalette } from '../../src/features/palette/store.ts'
import { ThreadScreen, ThreadView } from '../../src/features/threads/ThreadScreen.tsx'
import { ClientProvider } from '../../src/lib/client.ts'
import { createMemoryStorage } from '../../src/lib/storage.ts'
import { StorageProvider } from '../../src/lib/storageContext.tsx'
import { Shell } from '../../src/Shell.tsx'
import { LocationProbe, makeCard, setup } from '../cards/helpers.tsx'

const CARD_ID = 'c_00000000000000000000000001'
const scope = globalThis as unknown as Record<string, unknown>
const viewing: Array<string | null> = []

beforeEach(() => {
  viewing.length = 0
  Element.prototype.scrollIntoView = vi.fn() // jsdom has none
  // the iPhone shell with its push plugin
  scope.Capacitor = {
    isNativePlatform: () => true,
    getPlatform: () => 'ios',
    Plugins: { TalosPush: { setViewing: async (a: { thread: string | null }) => void viewing.push(a.thread) } },
  }
})
afterEach(() => {
  cleanup()
  delete scope.Capacitor
  usePalette.getState().close()
})

function open(route: string) {
  const client = setup({ cards: [makeCard({ id: CARD_ID, thread_id: 'general' })] })
  return render(
    <StorageProvider storage={createMemoryStorage()}>
      <ClientProvider client={client}>
        <MemoryRouter initialEntries={[route]}>
          <Routes>
            <Route element={<Shell />}>
              <Route path="t/:thread" element={<ThreadScreen />} />
              {/* what App.tsx's CardScreen renders once the card is in the store */}
              <Route path="card/:id" element={<ThreadView threadId="general" highlightCard={CARD_ID} />} />
              <Route path="search" element={<div />} />
            </Route>
          </Routes>
          <LocationProbe />
        </MemoryRouter>
      </ClientProvider>
    </StorageProvider>,
  )
}

describe('the thread shown on /card/:id counts as the thread on screen', () => {
  it('the iPhone shell is told which thread is being viewed on /t/:thread (the control)', async () => {
    open('/t/general')
    await screen.findByTestId('thread-screen')
    expect(viewing.at(-1)).toBe('general')
  })

  it('the iPhone shell is told which thread is being viewed on /card/:id', async () => {
    open(`/card/${CARD_ID}`)
    await screen.findByTestId('thread-screen')
    await waitFor(() => expect(viewing.length).toBeGreaterThan(0))
    expect(viewing.at(-1)).toBe('general')
  })

  // one of the two is this platform's chord (Ctrl off a Mac, Cmd on one)
  const pressFind = () => {
    window.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyF', key: 'f', ctrlKey: true, cancelable: true }))
    window.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyF', key: 'f', metaKey: true, cancelable: true }))
  }

  it('Ctrl+F searches the thread shown on /t/:thread (the control)', async () => {
    open('/t/general')
    await screen.findByTestId('thread-screen')
    pressFind()
    await waitFor(() => expect(screen.getByTestId('location').textContent).toBe('/search'), { timeout: 1500 })
  })

  it('Ctrl+F searches the thread shown on /card/:id', async () => {
    open(`/card/${CARD_ID}`)
    await screen.findByTestId('thread-screen')
    pressFind()
    await waitFor(() => expect(screen.getByTestId('location').textContent).toBe('/search'), { timeout: 1500 })
  })
})
