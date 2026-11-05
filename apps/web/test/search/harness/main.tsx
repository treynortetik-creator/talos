// Search test harness: the real Shell, SearchScreen and ContextView on the fake client, with `client.search` replaying the
// frames the real bridge captured (test/search/replay.ts). `?route=/search` picks the first route; `?offline` starts with
// the Mac offline. Built only in fake mode (vite.config.ts), served by `vite preview` like the other harnesses.
import { StrictMode, Suspense } from 'react'
import { createRoot } from 'react-dom/client'
import { MemoryRouter, Route, Routes, useLocation } from 'react-router'
import { SearchScreen } from '../../../src/features/search/index.tsx'
import { ThreadScreen } from '../../../src/features/threads/ThreadScreen.tsx'
import { ClientProvider } from '../../../src/lib/client.ts'
import { createFakeClient, type FakeClient } from '../../../src/lib/fakeClient.ts'
import { createIdbStorage } from '../../../src/lib/storage.ts'
import { StorageProvider } from '../../../src/lib/storageContext.tsx'
import { Shell } from '../../../src/Shell.tsx'
import '../../../src/theme/app.css'
import { type Replay, replayClient } from '../replay.ts'

declare global {
  interface Window {
    __talos: FakeClient
    __replay: Replay
  }
}

const params = new URLSearchParams(location.search)
const replay = replayClient()
replay.offline = params.has('offline')
replay.prefer = params.get('capture')
const client = Object.assign(createFakeClient({ macOffline: params.has('offline') }), { search: replay })
window.__talos = client as unknown as FakeClient
window.__replay = replay

function Where() {
  const l = useLocation()
  return (
    <p data-testid="location" className="sr-only">
      {l.pathname}
      {l.search}
    </p>
  )
}

const root = document.getElementById('root')
if (root)
  createRoot(root).render(
    <StrictMode>
      <StorageProvider storage={createIdbStorage()}>
        <ClientProvider client={client}>
          <MemoryRouter initialEntries={[params.get('route') ?? '/search']}>
            <Routes>
              <Route element={<Shell />}>
                <Route
                  path="search"
                  element={
                    <Suspense fallback={null}>
                      <SearchScreen />
                    </Suspense>
                  }
                />
                <Route path="t/:thread" element={<ThreadScreen />} />
                <Route path="*" element={<p className="p-4">Elsewhere</p>} />
              </Route>
            </Routes>
            <Where />
          </MemoryRouter>
        </ClientProvider>
      </StorageProvider>
    </StrictMode>,
  )
