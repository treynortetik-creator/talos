// The app shell: sidebar + center + optional detail panel on tablet/desktop, content + bottom bar on phones.
import { type CSSProperties, type ReactNode, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Outlet, useLocation, useMatch, useNavigate } from 'react-router'
import { PHONE_QUERY, PhoneChrome } from './features/phone/PhoneChrome.tsx'
import { usePhonePanel } from './features/phone/phoneStore.ts'
import { useSessionDockOpen } from './features/session/dockPref.ts'
import { SessionDock } from './features/session/SessionDock.tsx'
import { SessionTrigger, useSessionSupported } from './features/session/SessionTrigger.tsx'
import { useMediaQuery } from './features/settings/useMedia.ts'
import { DetailPanelContext } from './features/threads/DetailPanel.tsx'
import { BottomBar, Sidebar, useNeedsYouCount } from './features/threads/Nav.tsx'
import { toggleSidebar, useSidebarCollapsed } from './features/threads/sidebarPref.ts'
import { ThreadBanner } from './features/threads/ThreadBanner.tsx'
import { useAgentName, useVisibleThreads } from './features/threads/useThreads.ts'
import { useApprovalOpen } from './lib/approvalOpen.ts'
import { useKeyboardLayout } from './lib/keyboardViewport.ts'
import { setNativeViewing } from './lib/nativePush.ts'
import { useGlobalKeys } from './lib/useKeyboard.ts'
import { cn } from './ui/cn.ts'
import { IconClose } from './ui/icons.tsx'
import { Sheet, SheetClose, SheetContent, SheetTitle } from './ui/index.ts'
import { ToastProvider, ToastViewport } from './ui/toast.tsx'

export function Shell() {
  const nav = useNavigate()
  const loc = useLocation()
  const threads = useVisibleThreads()
  const needs = useNeedsYouCount()
  const agent = useAgentName()
  const desktop = useMediaQuery('(min-width: 1024px)')
  const phone = useMediaQuery(PHONE_QUERY)
  // the thread on screen (ThreadView publishes it): the Session chip and panel follow it, on /t/:id and /card/:id alike
  const sessionThread = usePhonePanel((s) => s.thread)
  const sessionSupported = useSessionSupported()
  const dockOpen = useSessionDockOpen()
  const approving = useApprovalOpen() // the approval sheet owns the screen: no toast viewport over it
  const folded = useSidebarCollapsed()
  const onThread = useMatch('/t/:thread')
  const onCard = useMatch('/card/:id')
  const onTerminal = useMatch('/terminal') !== null
  const inThread = onThread !== null || onCard !== null
  const [detail, setDetail] = useState<{ node: ReactNode; title?: string } | null>(null)

  const api = useMemo(
    () => ({
      open: (node: ReactNode, title?: string) => setDetail({ node, ...(title ? { title } : {}) }),
      close: () => setDetail(null),
    }),
    [],
  )

  useEffect(() => {
    document.title = needs > 0 ? `(${needs}) ${agent}` : agent
  }, [needs, agent])
  const viewing = onThread?.params.thread ?? null
  useEffect(() => {
    setNativeViewing(viewing)
    return () => setNativeViewing(null)
  }, [viewing])
  // biome-ignore lint/correctness/useExhaustiveDependencies: the panel closes on navigation
  useEffect(() => setDetail(null), [loc.pathname])

  // The sheet's own Escape handler removes it before this window listener runs, so look at the key in the capture phase,
  // which runs first, and remember whether a dialog was open when it went down.
  const dialogWasOpenAtEscape = useRef(false)
  useEffect(() => {
    const seen = (e: KeyboardEvent) => {
      if (e.key === 'Escape')
        dialogWasOpenAtEscape.current = Boolean(
          document.querySelector('[role="dialog"][data-state="open"], [role="alertdialog"][data-state="open"]'),
        )
    }
    window.addEventListener('keydown', seen, true)
    return () => window.removeEventListener('keydown', seen, true)
  }, [])

  const handlers = useMemo(
    () => ({
      onThread: (i: number) => {
        const t = threads[i]
        if (t) nav(`/t/${t.id}`)
      },
      onSearch: () => nav('/search'),
      // The sidebar only exists from 768 px up; on a phone the chord does nothing.
      // A sheet or dialog that is open owns the keyboard: folding would unmount the editor inside it and lose the text.
      onSidebar: () => {
        if (!window.matchMedia?.('(min-width: 768px)').matches) return
        if (document.querySelector('[role="dialog"][data-state="open"], [role="alertdialog"][data-state="open"]'))
          return
        toggleSidebar()
      },
      // Escape belongs to an open sheet or dialog first: it closes that, not the panel behind it (a Heartbeat test sheet over
      // a job's detail would otherwise take the detail away with it).
      onEscape: () => {
        if (dialogWasOpenAtEscape.current) return
        setDetail(null)
      },
    }),
    [threads, nav],
  )
  useGlobalKeys(handlers)
  useKeyboardLayout()
  const close = useCallback(() => setDetail(null), [])

  return (
    <ToastProvider swipeDirection="up" label="New replies">
      <DetailPanelContext.Provider value={api}>
        <div
          className="app-root relative flex h-dvh overflow-clip bg-bg text-text"
          style={{ '--sidebar-w': folded ? '4.25rem' : '15rem' } as CSSProperties}
        >
          <Sidebar />
          <PhoneChrome />
          <div className="@container relative flex min-w-0 flex-1 flex-col">
            {/* the usage chip sits in this column's top-right corner: the window's corner while the panel is closed. It steps aside
                while a details panel is open (the dock is not drawn then, so the chip would toggle something nobody can see). */}
            {sessionThread && !phone && !detail && <SessionTrigger threadId={sessionThread} />}
            <main
              className={cn(
                'mx-auto min-h-0 w-full flex-1 overflow-y-auto overscroll-contain',
                // the terminal wants the whole width; every other screen reads best in a column
                onTerminal ? 'max-w-none' : 'max-w-[760px] lg:max-w-[760px]',
              )}
              id="main"
            >
              <Suspense fallback={<div className="p-6 text-text-2">Loading…</div>}>
                <Outlet />
              </Suspense>
            </main>
            {!inThread && <BottomBar />}
          </div>
          {/* the Session panel docks on the right of a thread on a desktop; it is not a modal, the chat stays usable */}
          {sessionThread && desktop && dockOpen && sessionSupported && !detail && (
            <SessionDock threadId={sessionThread} />
          )}
          {detail && desktop && (
            <aside
              aria-label={detail.title ?? 'Details'}
              className="hidden w-[420px] shrink-0 overflow-y-auto border-l border-line bg-surface p-4 lg:block"
            >
              <div className="mb-2 flex items-center justify-between">
                <h2 className="m-0 text-base font-medium">{detail.title ?? 'Details'}</h2>
                <button
                  type="button"
                  aria-label="Close details"
                  onClick={close}
                  className="grid size-11 place-items-center rounded-pill hover:bg-surface-2"
                >
                  <IconClose />
                </button>
              </div>
              {detail.node}
            </aside>
          )}
          <Sheet open={detail !== null && !desktop} onOpenChange={(o) => !o && close()}>
            <SheetContent aria-describedby={undefined}>
              <SheetTitle className="sr-only">{detail?.title ?? 'Details'}</SheetTitle>
              {detail?.node}
              <SheetClose className="mt-3 min-h-11 text-sm text-text-2 underline">Close</SheetClose>
            </SheetContent>
          </Sheet>
        </div>
        <ThreadBanner />
        {approving ? null : <ToastViewport />}
      </DetailPanelContext.Provider>
    </ToastProvider>
  )
}
