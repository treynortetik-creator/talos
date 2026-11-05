// WP7 test harness: mounts the WP7 screens on the fake client inside a MemoryRouter. Served only by the Vite dev
// server (it lives under test/, which `vite build` never touches). `?route=/x` picks the first route, `?offline` starts
// with the Mac offline, `?seed=full` adds the card/inbox fixtures in seed.ts.
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { Link, MemoryRouter, Route, Routes, useLocation, useParams } from 'react-router'
import { AgentSettingsSection } from '../../../src/features/agent-config/AgentSettingsSection.tsx'
import { CardView } from '../../../src/features/cards/CardView.tsx'
import { HomeScreen } from '../../../src/features/home/HomeScreen.tsx'
import { InboxScreen } from '../../../src/features/inbox/InboxScreen.tsx'
import { IntegrationsScreen, IntegrationWizard } from '../../../src/features/integrations/index.tsx'
import { ClientProvider, TalosClientError, useTalos } from '../../../src/lib/client.ts'
import { createFakeClient, type FakeClient } from '../../../src/lib/fakeClient.ts'
import './harness.css'
import { seedFull, seedPermission } from './seed.ts'

declare global {
  interface Window {
    __talos: FakeClient
    TalosClientError: typeof TalosClientError
    __order: string[]
  }
}

const params = new URLSearchParams(location.search)
const client = createFakeClient({ macOffline: params.has('offline') })
if (params.get('seed') === 'full') seedFull(client)
if (params.get('seed') === 'permission') seedPermission(client)
window.__talos = client
window.TalosClientError = TalosClientError // lets a spec make the client fail the way the real one does
window.__order = []

function Cards() {
  const cards = useTalos((s) => s.cards)
  const threads = useTalos((s) => s.threads)
  return (
    <div className="mx-auto flex max-w-2xl flex-col gap-3 p-4">
      <h1 className="font-display text-xl">Cards</h1>
      {cards.map((c) => (
        <CardView key={c.id} card={c} threadName={threads.find((t) => t.id === c.thread_id)?.name ?? c.thread_id} />
      ))}
    </div>
  )
}

/** A thread with a long timeline: `/card/:id` must scroll to the card and highlight it. */
function DeepLinkThread() {
  const { id } = useParams()
  const cards = useTalos((s) => s.cards)
  return (
    <div className="mx-auto flex max-w-2xl flex-col gap-3 p-4">
      <h1 className="font-display text-xl">General</h1>
      {Array.from({ length: 30 }, (_, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: static filler
        <p key={i} className="h-16 text-text-2">
          Earlier message {i}
        </p>
      ))}
      {cards.map((c) => (
        <CardView key={c.id} card={c} threadName="General" highlighted={c.id === id} />
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

function Page({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <>
      <h1 className="sr-only">{title}</h1>
      {children}
    </>
  )
}

function Shell() {
  const readOnly = !useTalos((s) => s.presence.bridge_online)
  return (
    <>
      <nav aria-label="Harness" className="flex gap-3 border-b border-line p-2 text-sm">
        <Link to="/">Home</Link>
        <Link to="/t/inbox">Inbox</Link>
        <Link to="/cards">Cards</Link>
        <Link to="/settings/integrations">Integrations</Link>
        <Link to="/settings/agent">Agent</Link>
      </nav>
      <main>
        <Routes>
          <Route
            path="/"
            element={
              <Page title="Needs you">
                <HomeScreen />
              </Page>
            }
          />
          <Route
            path="/t/inbox"
            element={
              <Page title="Inbox">
                <InboxScreen />
              </Page>
            }
          />
          <Route path="/cards" element={<Cards />} />
          <Route path="/card/:id" element={<DeepLinkThread />} />
          <Route
            path="/settings/integrations"
            element={
              <Page title="Integrations">
                <IntegrationsScreen readOnly={readOnly} />
              </Page>
            }
          />
          <Route
            path="/settings/agent"
            element={
              <Page title="Agent settings">
                <AgentSettingsSection readOnly={readOnly} />
              </Page>
            }
          />
          <Route path="/wizard/:id?" element={<WizardRoute />} />
          <Route
            path="*"
            element={
              <Page title="Thread">
                <p className="p-4">Thread view (WP6)</p>
              </Page>
            }
          />
        </Routes>
      </main>
      <Where />
    </>
  )
}

function WizardRoute() {
  const { id } = useParams()
  return <IntegrationWizard {...(id ? { integrationId: id } : {})} onDone={() => {}} />
}

const root = document.getElementById('root')
if (root)
  createRoot(root).render(
    <StrictMode>
      <ClientProvider client={client}>
        <MemoryRouter initialEntries={[params.get('route') ?? '/']}>
          <Shell />
        </MemoryRouter>
      </ClientProvider>
    </StrictMode>,
  )
