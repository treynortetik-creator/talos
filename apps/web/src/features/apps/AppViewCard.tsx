// One MCP app view in the timeline (M2.1, M2.6). The chrome (owner's label, server and tool, "Third-party app", status,
// Expand, overflow) is drawn by Talos OUTSIDE the frame; the frame itself is a sandboxed opaque-origin iframe that can
// only talk to us through postMessage (host.ts). Fullscreen is a CSS state of the same container, so the frame never
// reloads when it grows. Real cards never render inside a frame.
import type { AppViewT, FrameOf } from '@talos-app/protocol'
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { useTalos, useTalosClient } from '../../lib/client.ts'
import { clockTime } from '../../lib/format.ts'
import { getPlatform } from '../../lib/platform.ts'
import { cn } from '../../ui/cn.ts'
import { IconClose, IconExpand, IconMore } from '../../ui/icons.tsx'
import { OVERLAY_BOX_CLASS, SandboxedFrame, useFrameOverlay } from '../../ui/SandboxedFrame.tsx'
import { mediaAppUrl } from '../threads/media.ts'
import { useAgentName } from '../threads/useThreads.ts'
import { AppInfoSheet, type InfoKind } from './AppInfoSheet.tsx'
import { createGestureTracker } from './gesture.ts'
import { HostChip } from './HostChip.tsx'
import { AppHost, buildInitializeResult, type ChipAnswer, type DisplayMode, type HostEnv } from './host.ts'
import { currentTheme, hostVariables, watchTheme } from './host-styles.ts'
import { DEFAULT_HEIGHT, MIN_HEIGHT, maxInlineHeight, RESIZE_DEBOUNCE_MS, START_WATCHDOG_MS } from './limits.ts'
import { acquireSlot, releaseSlot, useHasSlot } from './liveSlots.ts'
import { OpenLinkSheet } from './OpenLinkSheet.tsx'
import { fetchResultMedia } from './result.ts'

const APP_VERSION = import.meta.env.VITE_APP_VERSION ?? '0.0.0'

const UPDATE_TEXT = {
  superseded: 'Replaced by a newer view',
  closed: 'Closed: too many requests',
  revoked: 'Removed from your approved apps',
} as const

function isPhone() {
  return typeof window !== 'undefined' && window.innerWidth < 768 && (navigator.maxTouchPoints ?? 0) > 0
}

const nextFrame = () =>
  new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())))

export function AppViewCard({ view }: { view: AppViewT }) {
  const client = useTalosClient()
  const agent = useAgentName()
  const update = useTalos((s) => s.appStates[view.view_id])
  const hasSlot = useHasSlot(view.view_id)
  const [mode, setMode] = useState<DisplayMode>('inline')
  const [height, setHeight] = useState(DEFAULT_HEIGHT)
  const [mounted, setMounted] = useState(false)
  const [bump, setBump] = useState(0)
  const [, setTick] = useState(0)
  const [startFailed, setStartFailed] = useState(false)
  const [localClosed, setLocalClosed] = useState<'navigated' | 'teardown' | null>(null)
  const [info, setInfo] = useState<InfoKind | null>(null)
  const [menu, setMenu] = useState(false)
  const [link, setLink] = useState<string | null>(null)
  const [chip, setChip] = useState<{ kind: 'message' | 'fullscreen'; text?: string } | null>(null)
  const [now, setNow] = useState(() => Date.now())
  const [box, setBox] = useState<HTMLElement | null>(null)

  const boxRef = useRef<HTMLElement | null>(null)
  const barRef = useRef<HTMLDivElement>(null)
  const toggleRef = useRef<HTMLButtonElement>(null)
  const frameRef = useRef<HTMLIFrameElement>(null)
  const hostRef = useRef<AppHost | null>(null)
  const modeRef = useRef<DisplayMode>('inline')
  const linkDecide = useRef<((open: boolean) => void) | null>(null)
  const chipDecide = useRef<((answer: ChipAnswer) => void) | null>(null)
  const decideChip = useCallback((answer: ChipAnswer) => {
    const d = chipDecide.current
    chipDecide.current = null
    setChip(null)
    d?.(answer)
  }, [])
  const wantRef = useRef(false)

  const closedByUpdate = update !== undefined
  const want = hasSlot && !closedByUpdate && !localClosed

  // ---- the slot: the newest views are live, the rest are posters ----
  useLayoutEffect(() => {
    if (closedByUpdate || localClosed) return
    acquireSlot(view.view_id)
    return () => releaseSlot(view.view_id)
  }, [view.view_id, closedByUpdate, localClosed])

  // The frame mounts when a slot is held, and stays until the view has been told to tear down.
  useEffect(() => {
    wantRef.current = want
    if (want && !mounted) setMounted(true)
    if (!want && mounted) {
      const host = hostRef.current
      void (host ? host.teardown('retired') : Promise.resolve()).then(() => {
        if (!wantRef.current) setMounted(false)
      })
    }
  }, [want, mounted])

  // ---- the host: one per mounted frame ----
  // biome-ignore lint/correctness/useExhaustiveDependencies: `bump` re-creates the host for the retried frame
  useLayoutEffect(() => {
    if (!mounted) return
    setStartFailed(false)
    const el = () => boxRef.current
    // The owner's gesture counts for this view only when it was made inside this frame, and pays for one request.
    const gestures = createGestureTracker({
      win: window,
      doc: document,
      frame: () => frameRef.current,
      now: () => performance.now(),
      active: () => navigator.userActivation?.isActive === true,
      refocus: () => boxRef.current?.focus({ preventScroll: true }),
    })
    const env: HostEnv = {
      view,
      getWindow: () => frameRef.current?.contentWindow ?? null,
      sendRequest: async (frame) => {
        if (!client.sendAppRequest) throw new Error('This Talos cannot send app requests yet.')
        await client.sendAppRequest(frame)
      },
      claimGesture: () => gestures.claim(),
      confirmOpenLink: (url) =>
        new Promise<boolean>((resolve) => {
          linkDecide.current = resolve
          setLink(url)
        }),
      confirmMessage: (text) =>
        new Promise<ChipAnswer>((resolve) => {
          chipDecide.current = resolve
          setChip({ kind: 'message', text })
        }),
      confirmFullscreen: () =>
        new Promise<ChipAnswer>((resolve) => {
          chipDecide.current = resolve
          setChip({ kind: 'fullscreen' })
        }),
      openExternal: (url) => void getPlatform().openExternal(url),
      getDisplayMode: () => modeRef.current,
      setDisplayMode: async (m) => {
        modeRef.current = m
        setMode(m)
        await nextFrame()
      },
      dimensions: (m) => dims(m, el(), barRef.current),
      safeAreaInsets: () => safeInsets(),
      initializeResult: () =>
        buildInitializeResult({
          csp: view.csp,
          theme: currentTheme(),
          variables: hostVariables(),
          width: frameRef.current?.clientWidth || el()?.clientWidth || window.innerWidth,
          maxHeight: maxInlineHeight(window.innerHeight),
          locale: navigator.language,
          phone: isPhone(),
          touch: (navigator.maxTouchPoints ?? 0) > 0,
          hover: typeof matchMedia === 'function' && matchMedia('(hover: hover)').matches,
          appVersion: APP_VERSION,
        }),
      setHeight: (px) => setHeight(px),
      maxHeight: () => maxInlineHeight(window.innerHeight),
      fetchResult: (media) => fetchResultMedia(client, media),
      now: () => performance.now(),
      wallNow: () => Date.now(),
      raf: (cb) => void requestAnimationFrame(cb),
      onChange: () => {
        setTick((t) => t + 1)
        const h = hostRef.current
        if (h?.phase === 'closed' && (h.closedReason === 'navigated' || h.closedReason === 'teardown')) {
          setLocalClosed(h.closedReason)
          linkDecide.current?.(false)
          decideChip('no')
        }
      },
    }
    const host = new AppHost(env)
    hostRef.current = host
    modeRef.current = 'inline'
    setMode('inline')
    const onMessage = (e: MessageEvent) => host.handleMessage(e.source, e.data)
    window.addEventListener('message', onMessage)
    const offResponse = client.onFrame('app.response', (f: FrameOf<'app.response'>) => host.handleResponse(f))
    const onHide = () => host.teardownNow()
    window.addEventListener('pagehide', onHide)
    const offTheme = watchTheme(() =>
      host.sendContext({ theme: currentTheme(), styles: { variables: hostVariables() } }),
    )
    let resize: ReturnType<typeof setTimeout> | undefined
    const onResize = () => {
      clearTimeout(resize)
      resize = setTimeout(
        () => host.sendContext({ containerDimensions: dims(modeRef.current, el(), barRef.current) }),
        RESIZE_DEBOUNCE_MS,
      )
    }
    window.addEventListener('resize', onResize)
    // Folding the sidebar moves the card's width without any window resize: watch the box itself. The first callback
    // only reports the starting width; a later one with a different width tells the view.
    let seenWidth: number | null = null
    const ro =
      typeof ResizeObserver === 'undefined'
        ? null
        : new ResizeObserver((entries) => {
            const w = Math.round(entries[entries.length - 1]?.contentRect.width ?? 0)
            const first = seenWidth === null
            if (w === seenWidth) return
            seenWidth = w
            if (!first) onResize()
          })
    const watched = el()
    if (watched) ro?.observe(watched)
    return () => {
      ro?.disconnect()
      gestures.dispose()
      window.removeEventListener('message', onMessage)
      window.removeEventListener('pagehide', onHide)
      window.removeEventListener('resize', onResize)
      clearTimeout(resize)
      offResponse()
      offTheme()
      linkDecide.current?.(false)
      decideChip('no')
      host.dispose('disposed')
      if (hostRef.current === host) hostRef.current = null
    }
  }, [mounted, bump, view, client, decideChip])

  // A view that never finishes `ui/initialize` is shown as failed (loading -> failed, with a retry).
  const loadedAt = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  useEffect(() => () => clearTimeout(loadedAt.current), [])
  const onLoad = () => {
    hostRef.current?.onFrameLoad()
    clearTimeout(loadedAt.current)
    loadedAt.current = setTimeout(() => {
      if (hostRef.current && !hostRef.current.initialized && hostRef.current.phase !== 'closed') setStartFailed(true)
    }, START_WATCHDOG_MS)
  }

  // The 24 h banner.
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 30_000)
    return () => clearInterval(t)
  }, [])

  const exitFullscreen = useCallback(() => {
    modeRef.current = 'inline'
    setMode('inline')
    void nextFrame().then(() =>
      hostRef.current?.sendContext({
        displayMode: 'inline',
        containerDimensions: dims('inline', boxRef.current, barRef.current),
      }),
    )
  }, [])
  const enterFullscreen = () => {
    modeRef.current = 'fullscreen'
    setMode('fullscreen')
    void nextFrame().then(() =>
      hostRef.current?.sendContext({
        displayMode: 'fullscreen',
        containerDimensions: dims('fullscreen', boxRef.current, barRef.current),
        safeAreaInsets: safeInsets(),
      }),
    )
  }
  // A view that goes away while fullscreen (its own teardown, a navigation stop, an update) must never leave the owner
  // inside a full-viewport box: the mode resets with the frame, whatever closed it.
  const gone = !mounted || localClosed !== null || closedByUpdate
  useEffect(() => {
    if (gone && modeRef.current === 'fullscreen') {
      modeRef.current = 'inline'
      setMode('inline')
    }
  }, [gone])
  const fullscreen = mode === 'fullscreen' && !gone
  const onKeyDown = useFrameOverlay({
    active: fullscreen,
    onClose: exitFullscreen,
    boxRef,
    barRef,
    closeRef: toggleRef,
  })

  const host = hostRef.current
  const status = host?.status ?? 'idle'
  const closedText = closedByUpdate
    ? UPDATE_TEXT[update.state]
    : localClosed === 'navigated'
      ? 'This app tried to leave its frame and was stopped.'
      : localClosed === 'teardown'
        ? 'This app closed itself.'
        : null
  const expired = Date.parse(view.calls_until) < now
  const src = useMemo(() => mediaAppUrl(view.page.media_id) + (bump ? `?r=${bump}` : ''), [view.page.media_id, bump])
  const showFrame = mounted
  const loading = showFrame && !startFailed && !(host?.phase === 'ready')
  const label = view.label

  const decideLink = (open: boolean) => {
    const d = linkDecide.current
    linkDecide.current = null
    setLink(null)
    d?.(open)
  }

  return (
    <div
      data-testid="app-view"
      data-view-id={view.view_id}
      data-state={
        closedText ? 'closed' : showFrame ? (loading ? 'loading' : startFailed ? 'failed' : 'ready') : 'poster'
      }
      data-mode={mode}
      style={fullscreen ? { minHeight: DEFAULT_HEIGHT } : undefined}
    >
      {/* biome-ignore lint/a11y/useAriaPropsSupportedByRole: aria-modal is set only together with role=dialog (fullscreen) */}
      <section
        ref={(n) => {
          boxRef.current = n
          setBox((cur) => (cur === n ? cur : n))
        }}
        role={fullscreen ? 'dialog' : 'group'}
        aria-modal={fullscreen ? true : undefined}
        aria-label={`${label}, third-party app`}
        // keys typed in the question sheet are the sheet's: Escape means No there, not "leave fullscreen", and its own
        // focus trap keeps Tab (React sends events from a portal up to the card)
        onKeyDown={(e) => {
          if (chip === null) onKeyDown(e)
        }}
        tabIndex={-1}
        className={cn(
          fullscreen
            ? OVERLAY_BOX_CLASS
            : 'relative flex flex-col overflow-hidden rounded-card border border-line bg-surface',
        )}
      >
        <div ref={barRef} className="flex flex-col gap-0.5 border-b border-line bg-surface-2 py-1 pl-3 pr-1">
          <div className="flex items-center gap-1">
            <span className="min-w-0 flex-1 truncate text-sm font-semibold" data-testid="app-label">
              {label}
            </span>
            {(showFrame || fullscreen) && (
              <button
                ref={toggleRef}
                type="button"
                aria-label={fullscreen ? `Close ${label} full screen` : `Expand ${label} to full screen`}
                onClick={fullscreen ? exitFullscreen : enterFullscreen}
                className="flex min-h-11 shrink-0 items-center gap-1.5 rounded-pill px-2 font-mono text-xs text-text-2 hover:text-text"
              >
                {fullscreen ? <IconClose width={16} height={16} /> : <IconExpand width={16} height={16} />}
                <span>{fullscreen ? 'Close' : 'Expand'}</span>
              </button>
            )}
            <div className="relative">
              <button
                type="button"
                aria-label="More"
                aria-haspopup="menu"
                aria-expanded={menu}
                onClick={() => setMenu((o) => !o)}
                className="grid min-h-11 min-w-11 place-items-center rounded-pill text-text-2 hover:text-text"
              >
                <IconMore width={18} height={18} />
              </button>
              {menu && (
                <div
                  role="menu"
                  className="absolute right-0 top-full z-10 flex w-40 flex-col rounded-card border border-line bg-surface p-1 shadow-lg"
                >
                  {(['log', 'details'] as const).map((k) => (
                    <button
                      key={k}
                      type="button"
                      role="menuitem"
                      onClick={() => {
                        setMenu(false)
                        setInfo(k)
                      }}
                      className="min-h-11 rounded-button px-3 text-left text-sm hover:bg-surface-2"
                    >
                      {k === 'log' ? 'App log' : 'Details'}
                    </button>
                  ))}
                </div>
              )}
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 pb-1 pr-2 text-xs text-text-2">
            <span className="min-w-0 font-mono [overflow-wrap:anywhere]" data-testid="app-source">
              {view.server} · {view.tool}
            </span>
            <span className="rounded-pill border border-line px-2" data-testid="app-badge">
              Third-party app
            </span>
            {status !== 'idle' && (
              <span role="status" data-testid="app-status">
                {status === 'approval' ? 'Waiting for your approval' : `Waiting for ${agent}…`}
              </span>
            )}
          </div>
        </div>

        {showFrame ? (
          <div
            className={cn(
              'relative min-w-0 bg-surface',
              fullscreen && 'min-h-0 flex-1',
              view.prefers_border === false && 'border-0',
            )}
            style={fullscreen ? undefined : { height: Math.max(MIN_HEIGHT, height) }}
          >
            <SandboxedFrame
              key={bump}
              ref={frameRef}
              title={`${label} (app)`}
              src={src}
              onLoad={onLoad}
              className="block h-full w-full bg-surface"
            />
            {loading && (
              <div
                data-testid="app-loading"
                className="absolute inset-0 grid place-items-center bg-surface text-sm text-text-2"
              >
                <span className="animate-pulse">Loading {label}…</span>
              </div>
            )}
            {startFailed && (
              <div
                role="alert"
                data-testid="app-failed"
                className="absolute inset-0 flex flex-col items-center justify-center gap-2 bg-surface p-4 text-center text-sm"
              >
                <p className="m-0">This app didn't start.</p>
                <button
                  type="button"
                  onClick={() => {
                    // Older than the relay buffer: ask the Mac for the page again before the reload.
                    if ('fetchMedia' in client)
                      (client as unknown as { fetchMedia(id: string): void }).fetchMedia(view.page.media_id)
                    setBump((b) => b + 1)
                  }}
                  className="min-h-11 rounded-pill border border-line px-4"
                >
                  Try again
                </button>
              </div>
            )}
          </div>
        ) : (
          <div className="flex flex-col items-start gap-2 p-3 text-sm" data-testid="app-poster">
            <p className="m-0 text-text-2">{closedText ?? `${label} is not loaded.`}</p>
            <p className="m-0 font-mono text-xs text-text-2">Shown {clockTime(view.shown_at)}</p>
            {!closedText && (
              <button
                type="button"
                onClick={() => acquireSlot(view.view_id)}
                className="min-h-11 rounded-pill border border-line px-4"
              >
                Load app
              </button>
            )}
          </div>
        )}
        {expired && showFrame && (
          <p role="status" data-testid="app-expired" className="m-0 border-t border-line px-3 py-2 text-sm text-text-2">
            Buttons that need {agent} stopped working after 24 hours.
          </p>
        )}
        {chip !== null && (
          <HostChip
            kind={chip.kind}
            text={chip.text}
            label={label}
            container={box}
            onDecide={decideChip}
            // the sheet's buttons are gone: keyboard focus goes back to the card, not to the page behind it
            onClosed={() => boxRef.current?.focus({ preventScroll: true })}
          />
        )}
        <OpenLinkSheet url={link} label={label} container={box} onDecide={decideLink} />
        <AppInfoSheet
          kind={info}
          view={view}
          log={host?.log ?? []}
          dropped={host?.logDropped ?? 0}
          container={box}
          onClose={() => setInfo(null)}
        />
      </section>
    </div>
  )
}

function dims(mode: DisplayMode, box: HTMLElement | null, bar: HTMLElement | null) {
  if (mode === 'fullscreen') {
    const bh = bar?.getBoundingClientRect().height ?? 0
    return {
      width: Math.round(box?.clientWidth || window.innerWidth),
      height: Math.max(0, Math.round((box?.clientHeight || window.innerHeight) - bh)),
    }
  }
  return { width: Math.round(box?.clientWidth || window.innerWidth), maxHeight: maxInlineHeight(window.innerHeight) }
}

function safeInsets() {
  const probe = document.createElement('div')
  probe.style.cssText =
    'position:fixed;visibility:hidden;pointer-events:none;padding:env(safe-area-inset-top) env(safe-area-inset-right) env(safe-area-inset-bottom) env(safe-area-inset-left)'
  document.body.appendChild(probe)
  const cs = getComputedStyle(probe)
  const n = (v: string) => Number.parseFloat(v) || 0
  const out = { top: n(cs.paddingTop), right: n(cs.paddingRight), bottom: n(cs.paddingBottom), left: n(cs.paddingLeft) }
  probe.remove()
  return out
}
