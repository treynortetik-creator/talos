// On-screen keyboard layout. In the iPhone shell the stock @capacitor/keyboard plugin runs in `native` resize mode
// (apps/mobile/capacitor.config.ts): the web view itself shrinks to what the keyboard leaves, so `100dvh` is already the
// visible height and nothing here pans or pins. This file adds three small things on top:
//  1. `data-kb` on <html> while the keyboard is up, read from LAYOUT (the root's height against the tallest seen at this
//     width). Keyboard events are not trusted for this: they arrive out of order (didHide before willHide, bursts).
//  2. A lift for the first frames: the native resize lags the keyboard's slide, so on `keyboardWillShow` the root is given
//     the final height at once (`--kb-lift-h`, a pixel height) and the composer rises with the keyboard. It is cleared two
//     frames after the resize lands. If a resize never arrives the composer still sits above the keyboard.
//  3. A reveal of the focused field, because the scroller now ends at the keyboard.
// Where the layout never changes (Home Screen app, Safari, old shells) `data-kb` never fires and nothing here applies.
// Never call the plugin from the page (not its resize mode, not its accessory bar): only its window events are read.
import { useEffect } from 'react'
import { coarsePointer } from './native.ts'

/** Below this much lost height the change is browser chrome (URL bar), not a keyboard. */
export const MIN_KEYBOARD_PX = 120

export const EDITABLE = 'input, textarea, select, [contenteditable=""], [contenteditable="true"]'

/** The tallest root height seen at each viewport width: rotating away and back keeps the right baseline. */
export function makeBaselines(): { read(width: number, clientHeight: number): number } {
  const tallest = new Map<number, number>()
  return {
    read(width, clientHeight) {
      const h = Math.max(tallest.get(width) ?? 0, clientHeight)
      tallest.set(width, h)
      return h
    },
  }
}

/** True when the root has lost more than a keyboard's worth of height against the baseline. */
export function keyboardOpenFromLayout(baseline: number, clientHeight: number): boolean {
  return baseline - clientHeight > MIN_KEYBOARD_PX
}

/** The root height to lift to, from the baseline (never from the current height: a repeat event must not lift twice). */
export function liftHeight(baseline: number, keyboardHeight: number): number {
  return Math.max(0, baseline - keyboardHeight)
}

/** The nearest ancestor that really scrolls (an app scroller with something to scroll), or null. */
function scrollerOf(el: HTMLElement): HTMLElement | null {
  for (let p = el.parentElement; p && p !== el.ownerDocument.body; p = p.parentElement) {
    const y = getComputedStyle(p).overflowY
    // Only one that really overflows: Shell's <main> is overflow-auto too, and has nothing to scroll.
    if ((y === 'auto' || y === 'scroll' || y === 'overlay') && p.scrollHeight > p.clientHeight + 1) return p
  }
  return null
}

/**
 * Reveal for fields inside an app scroller (Settings, forms): the scroller ends at the keyboard, so the focused field is
 * scrolled into view inside it. A field with no scroller above it (the composer) is left alone: scrolling the PAGE at the
 * moment the native resize lands made WebKit show the document shifted up by the keyboard's height for one frame
 * (measured on the simulator: scrollTop 320 for a frame, the box off screen).
 */
export function revealFocused(doc: Document = document): void {
  const a = doc.activeElement
  if (!(a instanceof HTMLElement) || !a.matches(EDITABLE)) return
  const s = scrollerOf(a)
  if (!s) return
  // Scroll the scroller itself, never scrollIntoView: that also moves the page, and WebKit showed it shifted for a frame.
  const f = a.getBoundingClientRect()
  const r = s.getBoundingClientRect()
  const margin = Number.parseFloat(getComputedStyle(a).scrollMarginBottom) || 0
  if (f.bottom + margin > r.bottom) s.scrollTop += f.bottom + margin - r.bottom
  if (f.top < r.top) s.scrollTop -= r.top - f.top
}

/**
 * True only when focus is on an editable field INSIDE `el` (not `el` itself): the owner is typing there, so nothing
 * may scroll it away. A focused scroller (tabIndex 0, focused after a Jump) is not editing.
 */
export function editingInside(el: HTMLElement, doc: Document = document): boolean {
  const a = doc.activeElement
  return a instanceof HTMLElement && a !== el && el.contains(a) && a.matches(EDITABLE)
}

type Win = Pick<Window, 'addEventListener' | 'removeEventListener' | 'innerWidth'>
type Raf = (cb: () => void) => unknown

/** Wires the layout flag, the lift and the reveal. Returns the cleanup. `win`, `doc` and `raf` are injectable for tests. */
export function installKeyboardLayout(
  root: HTMLElement,
  win: Win = window,
  doc: Document = document,
  raf: Raf = (cb) => requestAnimationFrame(cb),
  // A mouse window that the owner shrinks is not a keyboard: without this, resizing the Mac app hid the header.
  touch: () => boolean = coarsePointer,
): () => void {
  const baselines = makeBaselines()
  const baseline = () => baselines.read(win.innerWidth, root.clientHeight)
  const clearLift = () => {
    root.classList.remove('kb-lift')
    root.style.removeProperty('--kb-lift-h')
  }
  let gen = 0
  const onShow = (e: Event) => {
    const kb = (e as Event & { keyboardHeight?: number }).keyboardHeight
    if (!(typeof kb === 'number' && kb > 0) || root.dataset.kb) return
    root.style.setProperty('--kb-lift-h', `${liftHeight(baseline(), kb)}px`)
    root.classList.add('kb-lift')
  }
  const onHide = () => {
    gen++
    clearLift()
  }
  const onResize = () => {
    const mine = ++gen
    raf(() =>
      raf(() => {
        if (mine !== gen) return
        const open = touch() && keyboardOpenFromLayout(baseline(), root.clientHeight)
        if (open) {
          root.dataset.kb = 'open'
          clearLift()
          revealFocused(doc)
        } else {
          delete root.dataset.kb
        }
      }),
    )
  }
  const onFocusIn = () => {
    if (root.dataset.kb) raf(() => revealFocused(doc))
  }
  baseline()
  win.addEventListener('keyboardWillShow', onShow)
  win.addEventListener('keyboardWillHide', onHide)
  win.addEventListener('resize', onResize)
  doc.addEventListener('focusin', onFocusIn)
  return () => {
    win.removeEventListener('keyboardWillShow', onShow)
    win.removeEventListener('keyboardWillHide', onHide)
    win.removeEventListener('resize', onResize)
    doc.removeEventListener('focusin', onFocusIn)
    gen++
    clearLift()
    delete root.dataset.kb
  }
}

/** Installed once by the shell. */
export function useKeyboardLayout(): void {
  useEffect(() => installKeyboardLayout(document.documentElement), [])
}
