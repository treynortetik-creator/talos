// Schedules test harness: the real Shell (sidebar, bottom bar) and the real Schedules routes on the fake client, inside a
// MemoryRouter. `?route=/schedules` picks the first route, `?offline` starts with the Mac offline, `?variant=` loads one
// of test/schedules/variants.ts. Built only in fake mode (vite.config.ts), served by `vite preview` like the cards harness.
import { StrictMode, Suspense } from 'react'
import { createRoot } from 'react-dom/client'
import { MemoryRouter, Route, Routes, useLocation } from 'react-router'
import { CardView } from '../../../src/features/cards/CardView.tsx'
import { HomeScreen } from '../../../src/features/registry.ts'
import { NewScheduleScreen, ScheduleDetailScreen, SchedulesScreen } from '../../../src/features/schedules/index.tsx'
import { ThreadScreen } from '../../../src/features/threads/ThreadScreen.tsx'
import { ClientProvider, useTalos } from '../../../src/lib/client.ts'
import { createFakeClient, type FakeClient } from '../../../src/lib/fakeClient.ts'
import { createIdbStorage } from '../../../src/lib/storage.ts'
import { StorageProvider } from '../../../src/lib/storageContext.tsx'
import { Shell } from '../../../src/Shell.tsx'
import '../../../src/theme/app.css'
import { cards as capturedCards, snapshots as capturedSnapshots } from '../captured.ts'
import { VARIANTS, type VariantName } from '../variants.ts'

declare global {
  interface Window {
    __talos: FakeClient
    /** Swap what the "Mac" holds, then re-list (as a refresh would). */
    __variant(name: VariantName): Promise<void>
    /** What the Mac does when jobs move: swap the data and send a `schedule.status` naming every job. */
    __push(name: VariantName): void
    /** Load the Nth snapshot the real bridge sent in a captured scenario, then re-list. */
    __captured(scenario: string, index: number): Promise<void>
    /** Add the Nth card the real bridge minted in a scenario to the store (as card.create would). */
    __captureCard(scenario: string, index: number): string
  }
}

const params = new URLSearchParams(location.search)
const storage = createIdbStorage()
const client = createFakeClient({ macOffline: params.has('offline') })
const first = params.get('variant') as VariantName | null
if (first) client.schedules.setData(VARIANTS[first]())
// the owner is in the scheduler's zone unless a spec says otherwise (the fake config is UTC)
client.store.setState((s) => (s.config ? { ...s, config: { ...s.config, timezone: 'America/New_York' } } : s))
window.__talos = client
window.__variant = async (name) => {
  client.schedules.setData(VARIANTS[name]())
  await client.schedules.listSchedules()
}

window.__push = (name) => {
  const next = VARIANTS[name]()
  client.schedules.setData(next)
  client.emit('schedule.status', {
    health: next.health,
    changed: next.schedules.map((x) => ({ id: x.id, etag: x.etag, state_rev: x.state_rev })),
    removed: [],
    alert: null,
  })
}

window.__captured = async (scenario, index) => {
  const snap = capturedSnapshots(scenario)[index]
  if (!snap) throw new Error(`no snapshot ${index} in ${scenario}`)
  client.schedules.setData(snap)
  await client.schedules.listSchedules()
}
window.__captureCard = (scenario, index) => {
  const card = capturedCards(scenario)[index]
  if (!card) throw new Error(`no card ${index} in ${scenario}`)
  client.store.setState((st) => ({ ...st, cards: [...st.cards.filter((c) => c.id !== card.id), card] }))
  return card.id
}

function CardsPage() {
  const list = useTalos((st) => st.cards)
  return (
    <div className="mx-auto flex max-w-2xl flex-col gap-3 p-4">
      <h1 className="font-display text-xl">Cards</h1>
      {list.map((c) => (
        <CardView key={c.id} card={c} threadName="General" />
      ))}
    </div>
  )
}

function Where() {
  const l = useLocation()
  return (
    <p data-testid="location" className="sr-only">
      {l.pathname}
    </p>
  )
}

const root = document.getElementById('root')
if (root)
  createRoot(root).render(
    <StrictMode>
      <StorageProvider storage={storage}>
        <ClientProvider client={client}>
          <MemoryRouter initialEntries={[params.get('route') ?? '/schedules']}>
            <Routes>
              <Route element={<Shell />}>
                <Route
                  index
                  element={
                    <Suspense fallback={null}>
                      <HomeScreen />
                    </Suspense>
                  }
                />
                <Route path="t/:thread" element={<ThreadScreen />} />
                <Route path="schedules" element={<SchedulesScreen />} />
                <Route path="schedules/new" element={<NewScheduleScreen />} />
                <Route path="schedules/:id" element={<ScheduleDetailScreen />} />
                <Route path="cards" element={<CardsPage />} />
                <Route path="settings" element={<p className="p-4">Settings</p>} />
                <Route path="*" element={<p className="p-4">Elsewhere</p>} />
              </Route>
            </Routes>
            <Where />
          </MemoryRouter>
        </ClientProvider>
      </StorageProvider>
    </StrictMode>,
  )
