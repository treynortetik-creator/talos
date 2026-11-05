// Error isolation: one malformed frame or a failed lazy chunk must never blank the whole app.
//   <AppErrorBoundary>   top level: "Something broke" with a Reload button (also catches a post-deploy chunk 404).
//   <RowErrorBoundary>   per timeline row: a quiet "Couldn't show this message" line, the rest of the thread stays.
import { Component, type ErrorInfo, type ReactNode, useState } from 'react'
import { reportCaught } from '../features/problems/controller.ts'
import { ReportProblem } from '../features/problems/ReportProblem.tsx'
import { isChunkError } from './chunkError.ts'
import { Mascot } from './Mascot.tsx'
import { Meander } from './Meander.tsx'

type Props = { children?: ReactNode }
type State = { error: Error | null }

/** Holds the time of the last automatic reload for a stale chunk. A second failure within RELOAD_WINDOW_MS falls back to
 *  the manual screen (no loop); a later deploy in the same long-lived tab gets its own reload. */
export const CHUNK_RELOAD_FLAG = 'talos.chunkReloaded'
/** Indirection so a test can see the reload without navigating. */
const RELOAD_WINDOW_MS = 60_000
export const pageReload = { reload: () => location.reload() }

/**
 * True once this page has started to leave (a link, `location.assign`, a test's `goto`, a close). The browser cancels the
 * page's in-flight lazy-chunk requests as it goes, and WebKit reports the cancelled import as "Importing a module script
 * failed", which looks exactly like a chunk a deploy replaced. Reloading then would beat the navigation the owner asked for
 * (and use up the one automatic reload). `beforeunload` comes before the cancel; the Navigation API covers browsers that
 * start a navigation without it. A same-document change (the router's own replaceState) is not leaving. `pageshow` clears
 * it for a page restored from the back-forward cache. A leave that never
 * completes keeps it set, and a real stale chunk then shows the manual Reload screen.
 */
export const leaving = { now: false }
if (typeof window !== 'undefined') {
  const leave = () => {
    leaving.now = true
  }
  window.addEventListener('beforeunload', leave)
  window.addEventListener('pagehide', leave)
  window.addEventListener('pageshow', () => {
    leaving.now = false
  })
  const navigation = (window as unknown as { navigation?: EventTarget }).navigation
  navigation?.addEventListener('navigate', (e) => {
    const n = e as Event & { destination?: { sameDocument?: boolean }; downloadRequest?: string | null }
    // A download keeps the page where it is.
    if (!n.destination?.sameDocument && n.downloadRequest == null) leave()
  })
}

export { isChunkError }

/** A deploy replaced the chunk this tab asked for: reload once to pick up the new build. Returns true if it reloaded.
 *  If sessionStorage is unavailable the guard cannot hold, so it does not reload (a loop is worse than a button). */
export function reloadOnceForChunk(): boolean {
  if (leaving.now) return false // cancelled by our own navigation, not replaced by a deploy; do not spend the flag
  try {
    const last = Number(sessionStorage.getItem(CHUNK_RELOAD_FLAG))
    const now = Date.now()
    if (last && now - last < RELOAD_WINDOW_MS) return false
    sessionStorage.setItem(CHUNK_RELOAD_FLAG, String(now))
  } catch {
    return false
  }
  pageReload.reload()
  return true
}

export class AppErrorBoundary extends Component<Props, State> {
  override state: State = { error: null }
  static getDerivedStateFromError(error: Error): State {
    return { error }
  }
  override componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('[talos] render error', error, info.componentStack)
    reportCaught(error)
    if (isChunkError(error)) reloadOnceForChunk()
  }
  override render() {
    if (!this.state.error) return this.props.children
    const chunk = isChunkError(this.state.error)
    return (
      <main className="grid min-h-dvh place-items-center bg-bg p-6" role="alert">
        <div className="flex max-w-[360px] flex-col items-center gap-4 text-center">
          <Mascot state={chunk ? 'pleased' : 'worried'} size={120} decorative />
          <h1 className="m-0 font-display text-2xl font-semibold">
            {chunk ? 'New version available' : 'Something broke'}
          </h1>
          <Meander className="w-32" />
          <p className="m-0 text-text-2">
            {chunk ? 'Reload to get the latest version.' : 'Your messages are safe. Reload to try again.'}
          </p>
          <button
            type="button"
            onClick={() => pageReload.reload()}
            className="min-h-11 rounded-button bg-accent px-6 text-sm font-semibold text-on-accent focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus"
          >
            Reload
          </button>
          {!chunk && <CrashReport error={this.state.error} />}
        </div>
      </main>
    )
  }
}

/**
 * "Report a problem" on the crash screen. It needs the app's providers, which the crash may have taken down with it, so
 * it sits in a boundary of its own: if it cannot render, the crash screen still shows Reload.
 */
class ReportGuard extends Component<{ children?: ReactNode }, { failed: boolean }> {
  override state = { failed: false }
  static getDerivedStateFromError() {
    return { failed: true }
  }
  override render() {
    return this.state.failed ? null : this.props.children
  }
}

function CrashReport({ error }: { error: Error }) {
  const [shown] = useState(error)
  return (
    <ReportGuard>
      <ReportProblem error={shown} compact />
    </ReportGuard>
  )
}

export class RowErrorBoundary extends Component<Props, State> {
  override state: State = { error: null }
  static getDerivedStateFromError(error: Error): State {
    return { error }
  }
  override componentDidCatch(error: Error) {
    console.error('[talos] message render error', error)
    reportCaught(error)
    // A lazy card/app chunk can 404 after a deploy; the row alone cannot recover, so reload once like the top level.
    if (isChunkError(error)) reloadOnceForChunk()
  }
  override render() {
    if (!this.state.error) return this.props.children
    return (
      <div role="status" data-testid="msg-broken" className="px-4 py-2 text-center text-sm text-text-2">
        Couldn't show this message.
      </div>
    )
  }
}
