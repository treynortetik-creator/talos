// Memory test harness: the real MemoryScreen on the fake client, with the real socket MemoryClient adapter answering from
// the frames the bridge's memory service captured over a synthetic notes folder. `?route=` picks the first route,
// `?offline` starts with the Mac offline. Built only in fake mode (vite.config.ts), served by `vite preview`.
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { MemoryRouter, Route, Routes, useLocation } from 'react-router'
import { MemoryScreen } from '../../../src/features/memory/index.tsx'
import { ClientProvider } from '../../../src/lib/client.ts'
import { createFakeClient, type FakeClient } from '../../../src/lib/fakeClient.ts'
import { createSocketMemory } from '../../../src/lib/socketMemory.ts'
import { createIdbStorage } from '../../../src/lib/storage.ts'
import { StorageProvider } from '../../../src/lib/storageContext.tsx'
import '../../../src/theme/app.css'
import c1 from '../../../../../packages/testkit/fixtures/captured/memory/01-roots-and-top.json'
import c2 from '../../../../../packages/testkit/fixtures/captured/memory/02-note-links-frontmatter.json'
import c3 from '../../../../../packages/testkit/fixtures/captured/memory/03-search.json'
import c4 from '../../../../../packages/testkit/fixtures/captured/memory/04-listing-pages.json'
import c5 from '../../../../../packages/testkit/fixtures/captured/memory/05-big-note-chunks.json'
import c6 from '../../../../../packages/testkit/fixtures/captured/memory/06-refusals.json'
import { macFrom, type Step } from '../replay.ts'

declare global {
  interface Window {
    __talos: FakeClient
    __asked: Array<Record<string, unknown>>
  }
}

const params = new URLSearchParams(location.search)
const client = createFakeClient({ macOffline: params.has('offline') })
const steps = ([c1, c2, c3, c4, c5, c6] as unknown as Array<{ frames: Step[] }>).flatMap((c) => c.frames)
const mac = macFrom(steps)
;(client as { memory: unknown }).memory = createSocketMemory({ ask: mac.ask as never })
window.__talos = client
window.__asked = mac.asked

function Where() {
  const l = useLocation()
  return (
    <p data-testid="location" className="sr-only">
      {l.pathname + l.search}
    </p>
  )
}

const root = document.getElementById('root')
if (root)
  createRoot(root).render(
    <StrictMode>
      <StorageProvider storage={createIdbStorage()}>
        <ClientProvider client={client}>
          <MemoryRouter initialEntries={[params.get('route') ?? '/memory']}>
            <main style={{ height: '100dvh' }}>
              <Routes>
                <Route path="memory/*" element={<MemoryScreen />} />
                <Route path="t/:thread" element={<p>Thread</p>} />
                <Route path="*" element={<p>Elsewhere</p>} />
              </Routes>
            </main>
            <Where />
          </MemoryRouter>
        </ClientProvider>
      </StorageProvider>
    </StrictMode>,
  )
