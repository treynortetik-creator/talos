// "Update ready": a newer build is out (lib/appUpdate.ts). Once a reload would load it, it reloads by itself, once per new
// version, with nothing to lose: at a cold start, when the page comes back to the front, or on the minute timer after the
// owner has been still for a while (never mid-recording, mid-typing, mid-send, in a dialog, on a call or in Settings); otherwise one
// line with Reload, shown only once a reload would load the new build.
import { useEffect, useRef, useState } from 'react'
import { useLocation } from 'react-router'
import { useStore } from 'zustand'
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
import { reloadHolds } from '../../lib/reloadHold.ts'
import { Button } from '../../ui/index.ts'
import { useSession } from '../auth/session.ts'
import { useComposerStore } from '../composer/composerStore.ts'

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

/** The safe check, with what is in flight read now (the render's copy of it can be a beat behind a tap). */
const okNow = (l: { busy: boolean; path: string }) =>
  safeToReload({ ...l, busy: l.busy || reloadHolds.getState().holds > 0 })

export function UpdateReady({
  reload = defaultReload,
  running,
}: {
  reload?: () => void
  /** Tests only: this bundle's version (the build's own otherwise). */
  running?: string
}) {
  const { ready, handedOver, target, cold } = useAppUpdate()
  const holds = useStore(reloadHolds, (s) => s.holds)
  const server = useSession((s) => s.me?.version)
  const held = useComposerStore(
    (s) => has(s.chips) || has(s.sendFailure) || has(s.replyTo) || has(s.dropped) || has(s.prefill),
  )
  // Work in flight (lib/reloadHold.ts): a send or Run being signed or written to this socket and not yet acked, a card answer
  // waiting. A reload now would drop what the page knows about it (the Run's "Sent" line). Rows that only sit in the device's
  // queue (held for an unpinned device, failed for good, waiting for a socket) are kept by the device store and hold nothing.
  const pending = holds > 0
  const busy = held || pending
  // Anything in flight at all gives up the cold-start fast path for good: the reload that was waiting would otherwise fire
  // the moment the ack lands, which is when a Run's line says "Sent", and wipe it a round trip later. It then goes only
  // through the idle paths (the minute timer after the owner has been still, or the next return to the front).
  const flew = useRef(false)
  if (pending) flew.current = true
  useEffect(() => {
    if (reloadHolds.getState().holds > 0) flew.current = true
    return reloadHolds.subscribe((st) => {
      if (st.holds > 0) flew.current = true
    })
  }, [])
  // a tap on Reload while something is in flight waits for it, then reloads
  const [tapped, setTapped] = useState(false)
  const path = useLocation().pathname
  const live = useRef({ busy, path, reload, running })
  live.current = { busy, path, reload, running }
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
        if (st.ready && reloadWouldHelp() && okNow(l) && claimAutoReload(st.target)) l.reload()
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
  const seen = useRef({ ready: false, handedOver: false })
  // biome-ignore lint/correctness/useExhaustiveDependencies: handedOver re-arms the attempt once the new worker is in
  useEffect(() => {
    if (!ready) return
    const tryNow = () => {
      const l = live.current
      if (reloadWouldHelp() && okNow(l) && claimAutoReload(target)) l.reload()
    }
    // The cold start, or the moment a hand-over (or the update itself) came late for an update first seen during it (a slow
    // install after a reboot): never again later in the page's life, and never once anything has been in flight.
    const moment = (handedOver && !seen.current.handedOver) || (ready && !seen.current.ready)
    seen.current = { ready, handedOver }
    if (!flew.current && (Date.now() - LOADED_AT < COLD_START_MS || (cold && handedOver && moment))) tryNow()
    const onVisible = () => {
      if (document.visibilityState === 'visible') tryNow()
    }
    document.addEventListener('visibilitychange', onVisible)
    return () => document.removeEventListener('visibilitychange', onVisible)
  }, [ready, handedOver, target, cold])
  // before the new worker takes over, a Reload is answered from the old worker's precache and brings back the same build
  // (the loop the owner hit 2026-11-15); and a reload already made toward this version came back here
  useEffect(() => {
    if (tapped && !pending) {
      claimAutoReload(target)
      live.current.reload()
    }
  }, [tapped, pending, target])
  if (!ready || !reloadWouldHelp() || reloadTried(target)) return null
  return (
    <div
      role="status"
      data-testid="update-ready"
      className="fixed inset-x-3 top-[calc(env(safe-area-inset-top)+0.5rem)] z-50 mx-auto flex max-w-md items-center justify-between gap-3 rounded-xl border border-line bg-surface px-3 py-2 text-sm shadow-lg"
    >
      <span>A new version of Talos is ready.</span>
      {tapped && pending ? (
        <span data-testid="update-waiting">Updating after your message is sent</span>
      ) : (
        <Button
          onClick={() => {
            if (reloadHolds.getState().holds > 0) return setTapped(true)
            claimAutoReload(target)
            live.current.reload()
          }}
          data-testid="update-reload"
          className="min-h-11"
        >
          Reload
        </Button>
      )}
    </div>
  )
}
