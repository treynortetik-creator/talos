// "Update ready": a newer build is out (lib/appUpdate.ts). Once a reload would load it, it reloads by itself, once per new
// version, with nothing to lose: at a cold start, when the page comes back to the front, or on the minute timer after the
// owner has been still for a while (never mid-recording, mid-typing, in a dialog, on a call or in Settings); otherwise one
// line with Reload, shown only once a reload would load the new build.
import { useEffect, useRef } from 'react'
import { useLocation } from 'react-router'
import {
  askWorkerForUpdate,
  COLD_START_MS,
  checkServerVersion,
  claimAutoReload,
  IDLE_BEFORE_TIMER_RELOAD_MS,
  idleFor,
  LOADED_AT,
  noteActivity,
  noteServerVersion,
  reloadTried,
  reloadWouldHelp,
  safeToReload,
  useAppUpdate,
  VERSION_CHECK_EVERY_MS,
  watchServiceWorker,
} from '../../lib/appUpdate.ts'
import { Button } from '../../ui/index.ts'
import { useSession } from '../auth/session.ts'
import { useComposerStore } from '../composer/composerStore.ts'
import { useIsOnCall } from '../voice/controller.ts'

const has = (r: Record<string, unknown>) =>
  Object.values(r).some((v) => (Array.isArray(v) ? v.length > 0 : v !== undefined))
const defaultReload = () => window.location.reload()
/** What counts as the owner using the page (a timer reload waits until none for a while). */
const ACTIVITY = [
  'pointerdown',
  'pointermove',
  'pointerup',
  'keydown',
  'scroll',
  'touchstart',
  'touchmove',
  'wheel',
] as const

export function UpdateReady({
  reload = defaultReload,
  running,
}: {
  reload?: () => void
  /** Tests only: this bundle's version (the build's own otherwise). */
  running?: string
}) {
  const { ready, handedOver, target, cold } = useAppUpdate()
  const server = useSession((s) => s.me?.version)
  const onCall = useIsOnCall()
  const busy = useComposerStore(
    (s) => has(s.chips) || has(s.sendFailure) || has(s.replyTo) || has(s.dropped) || has(s.prefill),
  )
  const path = useLocation().pathname
  const live = useRef({ onCall, busy, path, reload, running })
  live.current = { onCall, busy, path, reload, running }
  useEffect(() => noteServerVersion(server), [server])
  useEffect(() => watchServiceWorker(), [])
  // a page kept open looks for a newer build each time it comes to the front, and every minute while it stays there:
  // a newer worker where there is one, and the relay's version always (the iPhone app has no worker, and /api/me is read
  // at sign-in only)
  useEffect(() => {
    // `timer`: the page stayed in front; a reload then also waits for the owner to have been still for a while
    const ask = (timer: boolean) => {
      if (document.visibilityState !== 'visible') return
      askWorkerForUpdate()
      // once the read lands: a newer build reloads at a safe moment, here too, not only on the next return to the front
      // (an app kept in front would otherwise wait for a tap)
      void checkServerVersion(live.current.running ? { running: live.current.running } : {}).then(() => {
        const st = useAppUpdate.getState()
        const l = live.current
        if (timer && idleFor() < IDLE_BEFORE_TIMER_RELOAD_MS) return
        if (st.ready && reloadWouldHelp() && safeToReload(l) && claimAutoReload(st.target)) l.reload()
      })
    }
    const onVisible = () => ask(false)
    const onTick = () => ask(true)
    const active = () => noteActivity()
    document.addEventListener('visibilitychange', onVisible)
    for (const e of ACTIVITY) window.addEventListener(e, active, { passive: true, capture: true })
    const every = setInterval(onTick, VERSION_CHECK_EVERY_MS)
    return () => {
      document.removeEventListener('visibilitychange', onVisible)
      for (const e of ACTIVITY) window.removeEventListener(e, active, { capture: true })
      clearInterval(every)
    }
  }, [])
  // biome-ignore lint/correctness/useExhaustiveDependencies: handedOver re-arms the attempt once the new worker is in
  useEffect(() => {
    if (!ready) return
    const tryNow = () => {
      const l = live.current
      if (reloadWouldHelp() && safeToReload(l) && claimAutoReload(target)) l.reload()
    }
    // the cold start, or a hand-over that came late for an update first seen during it (a slow install after a reboot)
    if (Date.now() - LOADED_AT < COLD_START_MS || (cold && handedOver)) tryNow()
    const onVisible = () => {
      if (document.visibilityState === 'visible') tryNow()
    }
    document.addEventListener('visibilitychange', onVisible)
    return () => document.removeEventListener('visibilitychange', onVisible)
  }, [ready, handedOver, target, cold])
  // before the new worker takes over, a Reload is answered from the old worker's precache and brings back the same build
  // (the loop the owner hit 2026-11-15); and a reload already made toward this version came back here
  if (!ready || !reloadWouldHelp() || reloadTried(target)) return null
  return (
    <div
      role="status"
      data-testid="update-ready"
      className="fixed inset-x-3 top-[calc(env(safe-area-inset-top)+0.5rem)] z-50 mx-auto flex max-w-md items-center justify-between gap-3 rounded-xl border border-line bg-surface px-3 py-2 text-sm shadow-lg"
    >
      <span>A new version of Talos is ready.</span>
      <Button
        onClick={() => {
          claimAutoReload(target)
          live.current.reload()
        }}
        data-testid="update-reload"
        className="min-h-11"
      >
        Reload
      </Button>
    </div>
  )
}
