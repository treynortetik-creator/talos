// The one place an untrusted page becomes an iframe, and the full-viewport overlay around it. Users: HTML previews
// (`/media/:id/page`, features/threads/Attachments.tsx) and MCP app views (`/media/:id/app`, features/apps).
//
// The attributes are fixed here and cannot be passed in: `sandbox="allow-scripts"` (an opaque origin: no cookies, no
// storage, no parent access, no forms, popups, modals, downloads or top navigation), `referrerpolicy="no-referrer"`
// and no `allow` (no camera, microphone, geolocation, clipboard, payment, fullscreen). Never add `allow-same-origin`:
// test/apps/sandbox-lint.test.ts fails on it anywhere in apps/web/src.

import { PAGE_SANDBOX_ATTR } from '@talos-app/protocol'
import {
  type KeyboardEvent as ReactKeyboardEvent,
  type RefObject,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from 'react'
import { coarsePointer } from '../lib/native.ts'

/** Any touch screen (an iPad with a trackpad reports a fine pointer, yet a finger still swipes its fullscreen away). */
const touchScreen = () =>
  coarsePointer() ||
  (typeof navigator !== 'undefined' && navigator.maxTouchPoints > 0) ||
  (typeof matchMedia === 'function' && matchMedia('(any-pointer: coarse)').matches)

import { cn } from './cn.ts'
import { installFrameFocusGuard } from './frameFocusGuard.ts'
import { IconClose, IconLink } from './icons.tsx'

// the one value, shared with the relay's page policy (@talos-app/protocol csp.ts): script only, never allow-same-origin
export const SANDBOX_ATTR = PAGE_SANDBOX_ATTR

export type SandboxedFrameProps = {
  title: string
  src: string
  className?: string
  loading?: 'lazy' | 'eager'
  onLoad?: () => void
  ref?: RefObject<HTMLIFrameElement | null>
}

export function SandboxedFrame({ title, src, className, loading, onLoad, ref }: SandboxedFrameProps) {
  const own = useRef<HTMLIFrameElement | null>(null)
  const [held, setHeld] = useState(false)
  const setRef = useCallback(
    (n: HTMLIFrameElement | null) => {
      own.current = n
      if (ref) ref.current = n
    },
    [ref],
  )
  // Every frame is covered by the focus guard (ui/frameFocusGuard.ts) except on WebKit, which needs none: a page that takes
  // focus from a field the owner is in is handed it back, and the first few keys can still slip through (docs/SECURITY.md
  // lists what is not covered). A frame that keeps doing it is hidden, not unloaded, so an app keeps its state; the owner can
  // show it again.
  // Installed before paint, so the guard knows the box the owner is in before a fast page can take focus.
  useLayoutEffect(() => installFrameFocusGuard(own.current, () => setHeld(true)), [])
  return (
    <>
      <iframe
        ref={setRef}
        title={title}
        src={src}
        sandbox={SANDBOX_ATTR}
        referrerPolicy="no-referrer"
        loading={loading}
        onLoad={onLoad}
        className={className}
        style={held ? { display: 'none' } : undefined}
      />
      {held && (
        <div
          role="alert"
          data-testid="frame-held"
          // z-10: above the app card's own "Loading" and "didn't start" covers, which sit over the frame's box.
          // overflow-auto: an app view can be as short as 64 px, so the box scrolls instead of cutting the button off.
          // The centring lives on the inner box: the frame's own className says `block`, which would replace a `grid` here.
          className={cn('relative z-10 overflow-auto', className)}
        >
          {/* Auto margins centre it when there is room and fall to zero when there is not, so the top is never cut off. */}
          <div className="flex min-h-full flex-col items-center gap-2 p-4 text-center text-sm text-text-2">
            <p className="mt-auto">
              This page kept taking the keyboard from the box you were typing in, so it was hidden.
            </p>
            <button
              type="button"
              onClick={() => setHeld(false)}
              className="mb-auto min-h-11 shrink-0 rounded-pill border border-line px-4 text-text hover:bg-surface-2"
            >
              Show page
            </button>
          </div>
        </div>
      )}
    </>
  )
}

/** Fixed, full viewport, above the shell, inside the safe areas. Shared by the preview overlay and app fullscreen. */
export const OVERLAY_BOX_CLASS =
  'fixed inset-0 z-50 flex flex-col bg-surface pb-[env(safe-area-inset-bottom)] pl-[env(safe-area-inset-left)] pr-[env(safe-area-inset-right)] pt-[env(safe-area-inset-top)]'

/**
 * What an overlay does while it is open: focuses the close control, locks page scroll, asks the browser for real element
 * fullscreen on the box with a mouse (never on a touch screen, where WebKit's swipe-down would close it; the fixed box is
 * always the layout), closes when
 * fullscreen is left by any route, and returns `onKeyDown` (Escape closes, Tab stays inside the bar's controls).
 * Element fullscreen on the box never reloads the frame inside it.
 */
export function useFrameOverlay({
  active,
  onClose,
  boxRef,
  barRef,
  closeRef,
}: {
  active: boolean
  onClose: () => void
  boxRef: RefObject<HTMLElement | null>
  barRef: RefObject<HTMLElement | null>
  closeRef: RefObject<HTMLElement | null>
}) {
  const close = useRef(onClose)
  close.current = onClose
  useEffect(() => {
    if (!active) return
    closeRef.current?.focus()
    const prev = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    const el = boxRef.current
    let entered = false
    const onFs = () => {
      if (document.fullscreenElement === el) entered = true
      else if (entered) close.current()
    }
    document.addEventListener('fullscreenchange', onFs)
    // Desktop browsers only grant this with transient activation; without it the fixed box is the whole effect.
    // Never on a touch screen: iOS WebKit's element fullscreen shows "Swipe down to exit" and leaves on a swipe down,
    // which closed a long page on every scroll (the owner, 2026-11-14). There the fixed box, with Close at its top
    // right, is the whole effect, and no gesture closes it.
    const activated = navigator.userActivation ? navigator.userActivation.isActive : true
    if (activated && !touchScreen() && el && typeof el.requestFullscreen === 'function')
      el.requestFullscreen().catch(() => {})
    return () => {
      document.removeEventListener('fullscreenchange', onFs)
      document.body.style.overflow = prev
      if (document.fullscreenElement) void document.exitFullscreen().catch(() => {})
    }
  }, [active, boxRef, closeRef])
  return useCallback(
    (e: ReactKeyboardEvent) => {
      if (!active) return
      if (e.key === 'Escape') {
        e.stopPropagation()
        close.current()
      } else if (e.key === 'Tab') {
        const sel = 'a[href], button:not([disabled]), [tabindex="0"]'
        const items = Array.from(barRef.current?.querySelectorAll<HTMLElement>(sel) ?? [])
        const first = items[0]
        const last = items[items.length - 1]
        if (!first || !last) return
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault()
          last.focus()
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault()
          first.focus()
        }
      }
    },
    [active, barRef],
  )
}

/**
 * A preview page, full viewport (a second frame: previews have no state to keep). `link` is the "Open in new tab" target;
 * only previews pass one, app views never do.
 */
export function FrameOverlay({
  title,
  onClose,
  link,
  children,
}: {
  title: string
  onClose: () => void
  link?: string
  children: React.ReactNode
}) {
  const box = useRef<HTMLDivElement>(null)
  const bar = useRef<HTMLDivElement>(null)
  const closeBtn = useRef<HTMLButtonElement>(null)
  const onKeyDown = useFrameOverlay({ active: true, onClose, boxRef: box, barRef: bar, closeRef: closeBtn })
  return (
    <div
      ref={box}
      role="dialog"
      aria-modal="true"
      aria-label={title}
      onKeyDown={onKeyDown}
      className={OVERLAY_BOX_CLASS}
    >
      <div
        ref={bar}
        className="flex items-center gap-2 border-b border-line bg-surface-2 px-3 py-1 font-mono text-xs text-text-2"
      >
        <span className="min-w-0 flex-1 truncate">{title}</span>
        {link && (
          // Top-level safe: the relay serves the page with `sandbox allow-scripts`, so it stays an opaque origin.
          <a
            href={link}
            target="_blank"
            rel="noopener noreferrer"
            className="flex min-h-11 items-center gap-1.5 px-2 underline"
          >
            <IconLink width={16} height={16} />
            Open in new tab
          </a>
        )}
        <button
          ref={closeBtn}
          type="button"
          aria-label="Close"
          title="Close"
          onClick={onClose}
          className="grid size-11 shrink-0 place-items-center rounded-pill text-text hover:bg-surface"
        >
          <IconClose width={22} height={22} />
        </button>
      </div>
      {children}
    </div>
  )
}
