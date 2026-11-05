// Edge swipes for phones: a swipe that STARTS in a thin strip at the left or right edge of the screen opens the thread
// menu (left) or the session panel (right). Edge swipes only, so it never fights the other horizontal gestures:
//  - a code block or table that can still scroll in the swipe's direction keeps the touch (see `scrollsInDirection`);
//  - a second finger (pinch) cancels, and a page that is pinch-zoomed has no real edge, so nothing starts;
//  - any modal layer (the image viewer, sheets, menus, fullscreen app views) and anything marked `data-no-edge-swipe`
//    (the driving screen, inbox rows with their own swipe) ignores the edge, so their own gestures are untouched;
//  - the swipe opens when the finger LIFTS, not when it crosses the distance, so a system `touchcancel` that arrives
//    after the commit distance still leaves nothing open.
// System gestures are UNVERIFIED: no real device has been tried. EDGE_PX is the same strip iOS uses for its back gesture.
//  - Capacitor shell: neither the app nor Capacitor 8.5.3 turns that gesture on (WKWebView's default is off; the Swift
//    side is pinned by apps/mobile/test), so nothing competes.
//  - Safari and Home Screen apps with history: iOS probably takes the strip and goes back; whether it sends `touchcancel`
//    early enough to stop us is not known.
//  - Android gesture navigation claims both edges, so a right swipe may leave the thread instead of opening the panel.
// The header buttons are the primary path on every surface; the swipes are a shortcut. A device pass (Safari, a Home
// Screen install with history, Android gesture navigation) is still owed.
// Touch events are passive and never call preventDefault: scrolling is never blocked.

export const EDGE_PX = 20
export const COMMIT_PX = 56
export const SLOP_PX = 10
/** Sideways travel must dominate: up to 0.6 px of vertical drift per px inward. */
export const MAX_DRIFT = 0.6

export type Edge = 'left' | 'right'
export type Verdict = 'pending' | 'commit' | 'abort'

/** Which edge strip a touch at `x` starts in, or null. */
export function edgeOf(x: number, width: number): Edge | null {
  if (!Number.isFinite(x) || !Number.isFinite(width) || width <= 0) return null
  if (x >= 0 && x <= EDGE_PX) return 'left'
  if (x <= width && x >= width - EDGE_PX) return 'right'
  return null
}

/** What a touch that began at the edge and has moved (dx, dy) means so far. */
export function decide(edge: Edge, dx: number, dy: number): Verdict {
  const inward = edge === 'left' ? dx : -dx
  const drift = Math.abs(dy)
  if (inward < -SLOP_PX) return 'abort' // went toward the edge: not an opening swipe
  if (drift > SLOP_PX && drift > inward) return 'abort' // vertical scroll
  if (inward >= COMMIT_PX) return drift <= inward * MAX_DRIFT ? 'commit' : 'abort'
  return 'pending'
}

/** Is `el` or an ancestor a horizontal scroller that can still move in the direction this swipe would drag it? */
export function scrollsInDirection(el: Element | null, edge: Edge): boolean {
  for (let n: Element | null = el; n && n !== document.documentElement; n = n.parentElement) {
    if (!(n instanceof HTMLElement)) continue
    const ox = getComputedStyle(n).overflowX
    if (ox !== 'auto' && ox !== 'scroll') continue
    if (n.scrollWidth <= n.clientWidth + 1) continue
    // a finger moving right (left-edge swipe) scrolls content back toward scrollLeft 0; moving left scrolls forward.
    if (edge === 'left' ? n.scrollLeft > 0 : n.scrollLeft + n.clientWidth < n.scrollWidth - 1) return true
  }
  return false
}

/** A modal layer is on screen: Radix dialogs (data-state), and hand-built overlays that only say aria-modal. */
export const DIALOG_OPEN =
  '[role="dialog"][data-state="open"],[role="alertdialog"][data-state="open"],[role="dialog"][aria-modal="true"],[role="alertdialog"],[aria-modal="true"]'

type Opts = {
  /** Called once per gesture when it commits. */
  onOpen: (edge: Edge) => void
  /** Checked at touch start: phone layout only, signed in, and so on. */
  enabled: () => boolean
  target?: Window
}

/** Wires the listeners; returns the teardown. */
export function attachEdgeSwipe({ onOpen, enabled, target = window }: Opts): () => void {
  let edge: Edge | null = null
  let armed = false // the finger has gone far enough; opens on lift
  let x0 = 0
  let y0 = 0
  const end = () => {
    edge = null
    armed = false
  }
  const lift = () => {
    const which = armed ? edge : null
    end()
    if (which) onOpen(which)
  }
  const start = (e: TouchEvent) => {
    end()
    if (e.touches.length !== 1 || !enabled()) return
    const t = e.touches[0]
    if (!t) return
    const vv = target.visualViewport
    if (vv && vv.scale > 1.01) return
    const el = e.target instanceof Element ? e.target : null
    if (el?.closest('[data-no-edge-swipe]')) return
    if (target.document.querySelector(DIALOG_OPEN)) return
    const found = edgeOf(t.clientX, target.innerWidth)
    if (!found || scrollsInDirection(el, found)) return
    edge = found
    x0 = t.clientX
    y0 = t.clientY
  }
  const move = (e: TouchEvent) => {
    if (!edge) return
    if (e.touches.length !== 1) return end()
    const t = e.touches[0]
    if (!t) return end()
    const v = decide(edge, t.clientX - x0, t.clientY - y0)
    if (v === 'abort') return end()
    armed = v === 'commit' // pulled back under the distance: not armed any more
  }
  const opts = { passive: true } as const
  target.addEventListener('touchstart', start, opts)
  target.addEventListener('touchmove', move, opts)
  target.addEventListener('touchend', lift, opts)
  target.addEventListener('touchcancel', end, opts)
  return () => {
    target.removeEventListener('touchstart', start)
    target.removeEventListener('touchmove', move)
    target.removeEventListener('touchend', lift)
    target.removeEventListener('touchcancel', end)
  }
}
