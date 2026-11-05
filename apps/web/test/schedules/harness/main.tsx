// Schedules test harness: the real Shell (sidebar, bottom bar) and the real Schedules routes on the fake client, inside a
// MemoryRouter. `?route=/schedules` picks the first route, `?offline` starts with the Mac offline, `?variant=` loads one
// of test/schedules/variants.ts. Built only in fake mode (vite.config.ts), served by `vite preview` like the cards harness.
import {
  AgentConfig,
  type AgentConfigT,
  THREAD_SESSIONS_FEATURE,
  type ThreadT,
  type WorkerStatusItemT,
} from '@talos-app/protocol'
import { StrictMode, Suspense } from 'react'
import { createRoot } from 'react-dom/client'
import { MemoryRouter, Route, Routes, useLocation } from 'react-router'
import { CardView } from '../../../src/features/cards/CardView.tsx'
import { HomeScreen } from '../../../src/features/registry.ts'
import {
  HeartbeatSetupScreen,
  NewScheduleScreen,
  ScheduleDetailScreen,
  SchedulesScreen,
} from '../../../src/features/schedules/index.tsx'
import { ThreadScreen } from '../../../src/features/threads/ThreadScreen.tsx'
import { ClientProvider, TalosClientError, useTalos } from '../../../src/lib/client.ts'
import { createFakeClient, type FakeClient } from '../../../src/lib/fakeClient.ts'
import { passingTestResult } from '../../../src/lib/fakeSchedules.ts'
import { createIdbStorage } from '../../../src/lib/storage.ts'
import { StorageProvider } from '../../../src/lib/storageContext.tsx'
import { Shell } from '../../../src/Shell.tsx'
import '../../../src/theme/app.css'
import { cards as capturedCards, snapshots as capturedSnapshots } from '../captured.ts'
import { REPORTS, VARIANTS, type VariantName } from '../variants.ts'

declare global {
  interface Window {
    __talos: FakeClient
    /** Swap what the "Mac" holds, then re-list (as a refresh would). */
    __variant(name: VariantName): Promise<void>
    /** What the Mac does when jobs move: swap the data and send a `schedule.status` naming every job. */
    __push(name: VariantName): void
    /** Load the Nth snapshot the real bridge sent in a captured scenario, then re-list. */
    __captured(scenario: string, index: number): Promise<void>
    /** How the fake Mac answers `heartbeat.test`; `release` lets a `hang` finish. */
    __hb: {
      mode: 'pass' | 'hang' | 'fail' | 'partial' | 'other_config' | 'no_answer' | 'junk'
      release: (() => void) | null
    }
    /**
     * Thread sessions on this Mac: threads with their own session (and the state of each worker), plus a shared one and an
     * archived one. Sends the `workers.status` the Mac would. Pass `supported: false` for a Mac that cannot host them.
     */
    __sessions(spec: { workers: Record<string, WorkerStatusItemT['state']>; supported?: boolean }): void
    /** Add the Nth card the real bridge minted in a scenario to the store (as card.create would). */
    __captureCard(scenario: string, index: number): string
  }
}

const params = new URLSearchParams(location.search)
const storage = createIdbStorage()
const client = createFakeClient({ macOffline: params.has('offline') })
const first = params.get('variant') as VariantName | null
if (first) client.schedules.setData(VARIANTS[first](), undefined, REPORTS[first] ?? {})
// the owner is in the scheduler's zone unless a spec says otherwise (the fake config is UTC)
client.store.setState((s) => (s.config ? { ...s, config: { ...s.config, timezone: 'America/New_York' } } : s))
window.__talos = client
window.__variant = async (name) => {
  client.schedules.setData(VARIANTS[name](), undefined, REPORTS[name] ?? {})
  await client.schedules.listSchedules()
}

window.__sessions = (spec) => {
  const t = (id: string, name: string, extra: Partial<ThreadT> = {}): ThreadT => ({
    id,
    name,
    kind: 'fixed',
    order: 5,
    notify: 'all',
    voice_context: 'recent',
    archived: false,
    created_at: '2026-10-28T00:00:00.000Z',
    ...extra,
  })
  const cur = client.store.getState().config as AgentConfigT
  const dedicated = Object.keys(spec.workers)
  const next = AgentConfig.parse({
    ...cur,
    threads: [
      ...cur.threads.filter((x) => !['trip', 'garden', 'shared_one', 'archived_one'].includes(x.id)),
      t('trip', 'Trip', { session: 'dedicated' }),
      t('garden', 'Garden', { session: dedicated.includes('garden') ? 'dedicated' : 'shared' }),
      t('shared_one', 'Rota'),
      t('archived_one', 'Old plans', { archived: true }),
    ],
    dedicated: { enabled: true },
  })
  const presence = client.store.getState().presence
  client.store.setState({
    config: next,
    threads: next.threads,
    presence: { ...presence, features: [...new Set([...(presence.features ?? []), THREAD_SESSIONS_FEATURE])] },
  })
  client.emit('workers.status', {
    status: {
      supported: spec.supported !== false,
      supervisor_online: spec.supported !== false,
      threads: Object.entries(spec.workers).map(([thread_id, state]) => ({ thread_id, state })),
      governor: { state: 'ok' },
      at: '2026-10-05T11:30:00.000Z',
    },
  })
}

window.__hb = { mode: 'pass', release: null }
client.schedules.setHeartbeatTest(async (config, opts) => {
  const at = new Date(Date.now()).toISOString()
  const ok = passingTestResult(config, opts.windowH, at) as { sources: Array<Record<string, unknown>> } & Record<
    string,
    unknown
  >
  const mode = window.__hb.mode
  if (mode === 'hang')
    await new Promise<void>((r) => {
      window.__hb.release = r
    })
  if (mode === 'no_answer') throw new TalosClientError('internal', 'no_answer')
  if (mode === 'junk') return { nothing: 'useful' }
  if (mode === 'other_config') return { ...ok, config_hash: `sha256:${'0'.repeat(64)}` }
  if (mode === 'fail')
    return {
      ...ok,
      sources: ok.sources.map((x, i) => (i === 0 ? { ...x, ok: false, error: 'gh is not signed in \u202e' } : x)),
    }
  if (mode === 'partial')
    return { ...ok, sources: ok.sources.map((x, i) => (i === 0 ? { ...x, read: 4, unreadable: 2 } : x)) }
  return ok
})

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
  const threads = useTalos((st) => st.threads)
  return (
    <div className="mx-auto flex max-w-2xl flex-col gap-3 p-4">
      <h1 className="font-display text-xl">Cards</h1>
      {list.map((c) => (
        <CardView key={c.id} card={c} threadName={threads.find((t) => t.id === c.thread_id)?.name ?? c.thread_id} />
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
                <Route path="schedules/heartbeat/new" element={<HeartbeatSetupScreen />} />
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
