import { ThreadId } from '@talos-app/protocol'
import { lazy, type ReactNode, Suspense, useCallback, useEffect, useRef, useState } from 'react'
import { BrowserRouter, Navigate, Route, Routes, useLocation, useNavigate, useParams } from 'react-router'
import type { StoreApi } from 'zustand/vanilla'
import { EnrollPage } from './features/auth/EnrollPage.tsx'
import { LoginPage } from './features/auth/LoginPage.tsx'
import { proveDeviceInPlace } from './features/auth/passkeys.ts'
import { StorageRecovery } from './features/auth/StorageRecovery.tsx'
import { clearAfterSessionEnd, pendingWipe, useSession } from './features/auth/session.ts'
import { startOwnerClient } from './features/auth/startClient.ts'
import { spendArm } from './features/cards/arm.tsx'
import { HelpLoading } from './features/help/HelpLoading.tsx'
import { HELP_PATH } from './features/help/path.ts'
import { RouteTracker } from './features/problems/routes.ts'
import { refreshNativeOnOpen, startNativeResume } from './features/pwa/nativePush.ts'
import { resubscribeOnOpen } from './features/pwa/push.ts'
import { registerServiceWorker } from './features/pwa/register.ts'
import {
  DriveScreen,
  HealthScreen,
  HomeScreen,
  IntegrationsScreen,
  MemoryScreen,
  SearchScreen,
  ShareScreen,
} from './features/registry.ts'
import { NewScheduleScreen, ScheduleDetailScreen, SchedulesScreen } from './features/schedules/index.tsx'
import { useSessionController } from './features/session/store.ts'
import { SettingsScreen } from './features/settings/SettingsScreen.tsx'
import { ThemeSync } from './features/settings/ThemeSync.tsx'
import { TerminalScreen } from './features/terminal/TerminalScreen.tsx'
import { useThreadSessionsController } from './features/thread-sessions/store.ts'
import { NowPlaying } from './features/threads/NowPlaying.tsx'
import { ThreadList } from './features/threads/ThreadList.tsx'
import { ThreadScreen, ThreadView } from './features/threads/ThreadScreen.tsx'
import { ClientProvider, type TalosClient, useTalos, useTalosClient } from './lib/client.ts'
import { type ConnectionMeta, createMetaStore, MetaProvider } from './lib/connectionMeta.ts'
import { createHttp } from './lib/http.ts'
import type { SocketClient } from './lib/socketClient.ts'
import type { Storage } from './lib/storage.ts'
import { StorageProvider, useStorage } from './lib/storageContext.tsx'
import { keepsUnsent } from './lib/unsent.ts'
import { Shell } from './Shell.tsx'
import { AppErrorBoundary } from './ui/ErrorBoundary.tsx'
import { Button } from './ui/index.ts'
import { Mascot } from './ui/Mascot.tsx'
import { Meander } from './ui/Meander.tsx'

const HelpScreen = lazy(() => import('./features/help/HelpScreen.tsx').then((m) => ({ default: m.HelpScreen })))
const FAKE = import.meta.env.VITE_FAKE === '1'
/** How long a stale 'online' (no new `ready` since the screen opened) is trusted before a missing card is called gone. */
const GONE_GRACE_MS = 4000
const isSocket = (c: TalosClient): c is SocketClient => 'ensureDevice' in c

/**
 * `onTrouble` adds a quiet link that is there from the first frame, not after a delay: storage that never answers has no
 * moment at which a timer could honestly call it hung, so the owner decides.
 */
function Splash({ onTrouble }: { onTrouble?: () => void }) {
  return (
    <main className="grid min-h-dvh place-items-center bg-bg">
      <div className="flex flex-col items-center gap-6">
        <Mascot state="working" size={120} name="Talos" />
        {onTrouble && (
          <Button variant="ghost" onClick={onTrouble}>
            Taking too long?
          </Button>
        )}
      </div>
    </main>
  )
}

/** Cold start with no network and nothing cached: say so, with a way to try again (never an endless splash). */
function OfflineStart({ onRetry }: { onRetry: () => void }) {
  return (
    <main className="grid min-h-dvh place-items-center bg-bg p-6">
      <div className="flex max-w-[360px] flex-col items-center gap-4 text-center">
        <Mascot state="worried" size={120} name="Talos" decorative />
        <h1 className="m-0 font-display text-2xl font-semibold">You're offline</h1>
        <Meander className="w-32" />
        <p className="m-0 text-text-2">Talos can't reach your server yet. Your messages are safe on this device.</p>
        <Button onClick={onRetry}>Retry</Button>
      </div>
    </main>
  )
}

/**
 * Session gate: loads /api/me, starts the socket, and sends the owner to /login or /enroll when needed. A `soft` gate does
 * the same work (so a signed-in reader gets a live connection) but never sends anyone away or holds the page back: signed
 * out, offline or still loading, the children render anyway. Talos Help is the one page that needs that.
 */
function Gate({ children, soft = false }: { children: ReactNode; soft?: boolean }) {
  const client = useTalosClient()
  const nav = useNavigate()
  const loc = useLocation()
  const status = useSession((s) => s.status)
  const me = useSession((s) => s.me)
  const [hasKey, setHasKey] = useState<boolean | null>(FAKE ? true : null)
  const [startFailed, setStartFailed] = useState<false | 'storage' | 'wipe'>(false)
  const [startAttempt, setStartAttempt] = useState(0)
  const [openingHelp, setOpeningHelp] = useState(false)
  const authFailed = useMetaAuthFailed(client)
  const storage = useStorage()
  const sessionOffline = useSession((s) => s.offline)
  const nativeRefreshedFor = useRef<TalosClient | null>(null)
  const retry = useCallback(
    () =>
      void useSession.getState().refresh(storage, (opts) => {
        if (isSocket(client)) client.close(opts)
      }),
    [storage, client],
  )
  // `useNavigate` returns a new function on every location change. Reading it through a ref keeps a route change from
  // re-running /api/me (a new `me` object) and, through that, the whole sign-in effect below.
  const navRef = useRef(nav)
  navRef.current = nav

  useEffect(() => {
    if (!FAKE) retry()
    void registerServiceWorker((url) => navRef.current(url))
  }, [retry])

  // Offline start (cached identity or the Retry screen): re-read /api/me when the network or the tab comes back.
  useEffect(() => {
    if (FAKE || !sessionOffline) return
    const again = () => {
      if (!document.hidden) retry()
    }
    window.addEventListener('online', again)
    document.addEventListener('visibilitychange', again)
    return () => {
      window.removeEventListener('online', again)
      document.removeEventListener('visibilitychange', again)
    }
  }, [sessionOffline, retry])

  // biome-ignore lint/correctness/useExhaustiveDependencies: startAttempt only exists to run this again after "Try again"
  useEffect(() => {
    if (FAKE || status !== 'authed' || !isSocket(client)) return
    let offResume: (() => void) | null = null
    let gone = false
    void (async () => {
      const result = await startOwnerClient({ client, storage, pinned: me?.device_pinned ?? false, isGone: () => gone })
      if (result === 'gone') return
      if (result === 'storage' || result === 'wipe') {
        // Storage refused to open or a wipe cannot finish: never an endless splash. The owner sees why and has a way out.
        setStartFailed(result)
        return
      }
      setStartFailed(false)
      setHasKey(result === 'started')
      if (result !== 'started') return
      void resubscribeOnOpen()
      // Once per page load: `me` changes identity on any re-read, and each pass posts a signed token registration
      // that counts against `push_apns`.
      if (nativeRefreshedFor.current !== client) {
        nativeRefreshedFor.current = client
        void refreshNativeOnOpen({ client })
        // Also once per page load: an open browser proves its device key in place (it never signs in again to do it).
        if (me?.device_pinned) void proveDeviceInPlace(storage)
      }
      offResume = startNativeResume({ client })
    })()
    return () => {
      gone = true
      offResume?.()
    }
  }, [client, status, me, storage, startAttempt])

  // Signed out by any path (401 on refresh, setAnon): the client must not outlive the session.
  useEffect(() => {
    if (status === 'anon' && isSocket(client)) client.close()
  }, [status, client])

  useEffect(() => {
    if (!authFailed) return
    useSession.getState().setAnon()
    // Why it ended is read before close(), which resets the flag. Only a session that ran out of time keeps the unsent
    // messages and voice notes (they go out after the owner signs back in). Revoked, signed out everywhere, or a relay
    // that did not say why: everything goes, queue included.
    const reason = isSocket(client) ? client.meta.getState().authReason : null
    // The session is gone: stop the client so it cannot write another snapshot, then the chats cached on this device
    // go with it (audit D21).
    if (isSocket(client)) client.close({ keepQueue: keepsUnsent(reason) })
    void clearAfterSessionEnd(storage, reason).catch(() => {})
  }, [authFailed, storage, client])

  if (FAKE || soft) return <>{children}</>
  if (status === 'loading') return <Splash />
  if (status === 'error') return <OfflineStart onRetry={retry} />
  if (status === 'anon') return <Navigate to="/login" state={{ from: loc.pathname + loc.search }} replace />
  if (startFailed || (hasKey === null && openingHelp)) {
    return (
      <StorageRecovery
        kind={startFailed || 'opening'}
        wipeMode={pendingWipe()}
        onRetry={() => {
          setOpeningHelp(false)
          setStartFailed(false)
          setStartAttempt((n) => n + 1)
        }}
      />
    )
  }
  if (hasKey === null) return <Splash onTrouble={() => setOpeningHelp(true)} />
  if (!hasKey) return <Navigate to="/enroll" replace />
  return <>{children}</>
}

function useMetaAuthFailed(client: TalosClient): boolean {
  const [failed, setFailed] = useState(false)
  useEffect(() => {
    if (!isSocket(client)) return
    const check = (m: ConnectionMeta) => setFailed(m.authFailed)
    check(client.meta.getState())
    return client.meta.subscribe(check)
  }, [client])
  return failed
}

// Keyed by id: a warm tap from one card to another reuses this route, and the "has a ready landed" check below must start
// again for the new card.
function CardRoute() {
  const { id = '' } = useParams()
  return <CardScreen key={id} id={id} />
}

function CardScreen({ id }: { id: string }) {
  const card = useTalos((s) => s.cards.find((c) => c.id === id))
  const connection = useTalos((s) => s.connection)
  const readySeq = useTalos((s) => s.readySeq)
  // A cached snapshot never decides that a card is gone: a push usually fires while the app is closed, so the card is
  // normally not on the phone yet. Only a `ready` that landed after this screen opened can say so. After a warm resume the
  // connection may still read a stale 'online' until the socket notices, so with no new `ready` the verdict waits a moment.
  const readyAtMount = useRef(readySeq)
  const [waited, setWaited] = useState(false)
  const online = connection === 'online'
  useEffect(() => {
    if (card || !online) return
    const t = setTimeout(() => setWaited(true), GONE_GRACE_MS)
    return () => clearTimeout(t)
  }, [card, online])
  const gone = !card && online && (readySeq === undefined || readySeq !== readyAtMount.current || waited)
  useEffect(() => {
    if (gone) spendArm(id) // decided elsewhere: the Approve tap has nothing to start
  }, [gone, id])
  if (!card) return gone ? <Navigate to="/" replace /> : <div className="p-6 text-text-2">Loading…</div>
  return <ThreadView threadId={card.thread_id} highlightCard={id} />
}

/** `/open/<ref>`: where an iPhone notification for a named thread lands. Apple only ever saw the opaque reference; the
 *  signed-in app asks the relay what it means, then goes there. Anything that does not resolve goes to the start page. */
function PushRefRoute() {
  const { ref = '' } = useParams()
  const nav = useNavigate()
  useEffect(() => {
    let live = true
    void createHttp()
      .get<{ thread_id?: string }>(`/api/push/ref/${encodeURIComponent(ref)}`)
      .then((r) => ThreadId.safeParse(r.thread_id))
      .then((t) => live && nav(t.success ? `/t/${t.data}` : '/', { replace: true }))
      .catch(() => live && nav('/', { replace: true }))
    return () => {
      live = false
    }
  }, [ref, nav])
  return <div className="p-6 text-text-2">Opening…</div>
}

/** CC-C3: subscribes the session store at the root so `ready` and the state frames are never missed. */
function SessionBoot() {
  useSessionController()
  useThreadSessionsController() // from the root too: `ready.workers_status` arrives once, before any screen opens
  return null
}

export function App({ client, storage }: { client: TalosClient; storage: Storage }) {
  const metaStore: StoreApi<ConnectionMeta> = isSocket(client) ? client.meta : fallbackMeta
  return (
    <StorageProvider storage={storage}>
      <ClientProvider client={client}>
        <ThemeSync />
        <SessionBoot />
        <MetaProvider store={metaStore}>
          <AppErrorBoundary>
            <BrowserRouter>
              <RouteTracker />
              <Routes>
                <Route path="/enroll" element={FAKE ? <Navigate to="/" replace /> : <EnrollPage />} />
                <Route path="/login" element={FAKE ? <Navigate to="/" replace /> : <LoginPage />} />
                {/* A soft gate on purpose: someone signed out or locked out can still read Help. */}
                <Route
                  path={HELP_PATH}
                  element={
                    <Gate soft>
                      <Suspense fallback={<HelpLoading />}>
                        <HelpScreen />
                      </Suspense>
                    </Gate>
                  }
                />
                <Route
                  element={
                    <Gate>
                      <Shell />
                      <NowPlaying />
                    </Gate>
                  }
                >
                  <Route
                    index
                    element={
                      <Suspense fallback={null}>
                        <HomeScreen />
                      </Suspense>
                    }
                  />
                  <Route path="threads" element={<ThreadList />} />
                  <Route path="t/:thread" element={<ThreadScreen />} />
                  <Route path="card/:id" element={<CardRoute />} />
                  <Route path="open/:ref" element={<PushRefRoute />} />
                  <Route path="schedules" element={<SchedulesScreen />} />
                  <Route path="schedules/new" element={<NewScheduleScreen />} />
                  <Route path="schedules/:id" element={<ScheduleDetailScreen />} />
                  <Route path="settings" element={<SettingsScreen />} />
                  <Route
                    path="settings/integrations"
                    element={
                      <SettingsScreen>
                        <Suspense fallback={null}>
                          <IntegrationsScreen />
                        </Suspense>
                      </SettingsScreen>
                    }
                  />
                  <Route path="settings/:section" element={<SettingsScreen />} />
                  <Route
                    path="search"
                    element={
                      <Suspense fallback={null}>
                        <SearchScreen />
                      </Suspense>
                    }
                  />
                  <Route
                    path="memory"
                    element={
                      <Suspense fallback={null}>
                        <MemoryScreen />
                      </Suspense>
                    }
                  />
                  <Route
                    path="memory/*"
                    element={
                      <Suspense fallback={null}>
                        <MemoryScreen />
                      </Suspense>
                    }
                  />
                  <Route path="terminal" element={<TerminalScreen />} />
                  <Route
                    path="drive"
                    element={
                      <Suspense fallback={null}>
                        <DriveScreen />
                      </Suspense>
                    }
                  />
                  <Route
                    path="share"
                    element={
                      <Suspense fallback={null}>
                        <ShareScreen />
                      </Suspense>
                    }
                  />
                  <Route
                    path="settings/health"
                    element={
                      <SettingsScreen>
                        <Suspense fallback={null}>
                          <HealthScreen />
                        </Suspense>
                      </SettingsScreen>
                    }
                  />
                  <Route path="*" element={<Navigate to="/" replace />} />
                </Route>
              </Routes>
            </BrowserRouter>
          </AppErrorBoundary>
        </MetaProvider>
      </ClientProvider>
    </StorageProvider>
  )
}

const fallbackMeta = createMetaStore()
