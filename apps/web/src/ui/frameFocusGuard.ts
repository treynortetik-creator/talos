// A sandboxed page (HTML preview or MCP app view) must not take keyboard focus away from a field the owner is typing in.
// On Chromium a frame may call focus() on its own input with no tap, so a page that does it on a timer receives every key
// meant for the composer. The guard watches for exactly that edge: a frame becomes the focused element while an editable
// host field had it a moment ago, and it hands focus back to that field unless the owner plausibly moved it on purpose:
//   - the last host key was Tab and focus has not landed in another host field since (keyboard navigation into the frame);
//   - mouse: the pointer moved into that frame after the owner's last host input (a click into the frame; a pointerover with
//     no movement, such as a cover lifting off a parked pointer, is not an entry), or it has rested
//     over the frame with no host input for RESTING_IDLE_MS. A pointer that merely rests over a frame while the owner
//     types in the box does not count;
//   - touch screens, where the host sees nothing of a tap inside a frame: no host input in the last GUARD_WINDOW_MS.
// The mouse and touch exemptions hold only while the browser also reports a recent gesture (navigator.userActivation), which
// a click or tap inside the frame gives and a timer does not.
// None of those exemptions applies to a frame that was handed back in the last REPEAT_WINDOW_MS: it has shown what it does.
// A key can still slip through in the instant before each hand-back, so a frame handed back REPEAT_COUNT times within
// REPEAT_WINDOW_MS is held: hidden, still loaded, with a notice and a button to show it again (SandboxedFrame).
// A frame that takes focus while the window is in the background is handed back on return (it cannot be a click).
// docs/SECURITY.md says what this does not cover.
import { frameFocusGuardNeeded } from './engine.ts'

export const GUARD_WINDOW_MS = 1500
export const RESTING_IDLE_MS = 5000
export const REPEAT_COUNT = 3
export const REPEAT_WINDOW_MS = 10_000
const TAB_WINDOW_MS = 600

export type FocusGuardEnv = {
  win: Window
  doc: Document
  /** Monotonic ms. */
  now: () => number
  /** True when this device cannot hover (a phone or tablet): the host cannot see where a finger went inside a frame. */
  touchOnly: () => boolean
  /** True while the browser says the page has a recent user gesture (a click or key in this page or a frame in it, about 5 s). */
  userActive: () => boolean
}

// Typing that sends no key (dictation, an on-screen keyboard's suggestions, an IME) shows up as input and composition events.
const HOST_INPUT = [
  'keydown',
  'pointerdown',
  'mousedown',
  'touchstart',
  'beforeinput',
  'input',
  'compositionstart',
  'compositionupdate',
  'compositionend',
] as const

const isEditable = (el: Element | null): el is HTMLElement =>
  el instanceof HTMLElement &&
  el.isConnected &&
  (el.isContentEditable ||
    el instanceof HTMLTextAreaElement ||
    (el instanceof HTMLInputElement && !/^(button|checkbox|radio|submit|reset|range|color|file|image)$/.test(el.type)))

export function createFrameFocusGuard(env: FocusGuardEnv) {
  const { win, doc } = env
  let hostInputAt = Number.NEGATIVE_INFINITY
  let tabAt = Number.NEGATIVE_INFINITY
  let lastPointer: string = 'mouse'
  let hovered: Element | null = null
  let hoverAt = Number.NEGATIVE_INFINITY
  let frameActiveWhenAway = false
  // The owner may already be typing when the first frame arrives, and no focusin will announce a box that has focus.
  let field: HTMLElement | null = isEditable(doc.activeElement) ? doc.activeElement : null
  // The owner is in that box right now, so "the last host input" is now, not never: a touch screen would otherwise read the
  // first steal as a tap after a long pause.
  if (field) hostInputAt = env.now()
  // Where the pointer last was, as far as the host saw. Unknown until it has been seen once.
  let lastX = Number.NaN
  let lastY = Number.NaN
  const handBacks = new WeakMap<Element, number[]>()
  const watchers = new Map<Element, () => void>()

  const onInput = (e: Event) => {
    hostInputAt = env.now()
    if (e.type === 'keydown' && (e as KeyboardEvent).key === 'Tab') tabAt = hostInputAt
    if ('pointerType' in e && typeof (e as PointerEvent).pointerType === 'string')
      lastPointer = (e as PointerEvent).pointerType
    if (e.type === 'touchstart') lastPointer = 'touch'
  }
  const onFocusIn = (e: Event) => {
    const t = e.target as Element | null
    if (t instanceof HTMLIFrameElement) {
      // Read after the move has settled: a window that is not focused cannot have been clicked.
      setTimeout(() => check(doc.hasFocus?.() === false), 0)
      return
    }
    // Focus landed in a host element: a Tab just before it did not go into a frame.
    tabAt = Number.NEGATIVE_INFINITY
    const previous = field
    field = isEditable(t) ? t : null
    // A different box got focus (the owner, or a script of the host): that is the owner's last input as far as we can tell.
    // Without this a box focused after install leaves "last input" at never, which reads as a long pause and exempts the
    // next steal. The same box announced again (the browser does it when the window or tab comes back) is not a new input:
    // stamping it would make a real click into a frame, right after returning, look like it followed typing.
    if (field && field !== previous) hostInputAt = env.now()
  }
  // The box lost focus. If it went to nothing (the keyboard was dismissed, a tap on bare page) it is no longer "the field
  // the owner is typing in"; if it went to a frame, that is the very edge `check` looks at, so keep it.
  const onFocusOut = (e: Event) => {
    const t = e.target as HTMLElement | null
    if (!t || t !== field) return
    setTimeout(() => {
      if (field === t && !(doc.activeElement instanceof HTMLIFrameElement) && doc.activeElement !== t) field = null
    }, 0)
  }
  const onOver = (e: Event) => {
    const pe = e as PointerEvent
    if (pe.pointerType && pe.pointerType !== 'touch') {
      lastPointer = pe.pointerType
      const next = pe.target instanceof HTMLIFrameElement ? pe.target : null
      // A pointerover with no movement (a cover lifting off a pointer that is parked) is not the pointer arriving.
      // An unknown last position counts as not moved. So does a pointer that was over another frame: the host sees nothing
      // of moves inside a frame, so the position it holds is where the pointer entered, not where it is (a view that grows
      // under a pointer that moved around inside the old frame would otherwise read as an arrival).
      const moved =
        hovered === null &&
        !Number.isNaN(lastX) &&
        !Number.isNaN(lastY) &&
        (pe.clientX !== lastX || pe.clientY !== lastY)
      if (next && next !== hovered && moved) hoverAt = env.now()
      hovered = next
      lastX = pe.clientX
      lastY = pe.clientY
    }
  }
  // Moves the host sees while the pointer is over its own page keep the last position exact (no pointerover fires inside
  // one element), so a later pointerover at the same spot is known to be no movement.
  const onMove = (e: Event) => {
    const pe = e as PointerEvent
    if (pe.pointerType && pe.pointerType !== 'touch') {
      lastX = pe.clientX
      lastY = pe.clientY
    }
  }
  const onLeaveWindow = () => {
    hovered = null
  }
  const onWindowBlur = () => {
    frameActiveWhenAway = doc.activeElement instanceof HTMLIFrameElement
    // Not inside the blur event: the engine finishes moving focus into the frame after it, and a focus() made during the
    // event is overwritten (the field looks focused to the page while the keys still go to the frame).
    // Leaving the window with a page focused is not a steal: only act when the window still has focus (it moved into a frame).
    setTimeout(() => {
      if (doc.hasFocus?.() !== false) check()
    }, 0)
  }
  // Back from another app or tab: a frame that took focus while we were away is not a click.
  const onWindowFocus = () => {
    const was = frameActiveWhenAway
    frameActiveWhenAway = false
    if (!was) setTimeout(() => check(true), 0)
  }

  const recentHandBacks = (frame: Element, now: number) =>
    (handBacks.get(frame) ?? []).filter((t) => now - t < REPEAT_WINDOW_MS)

  /** `away`: the frame took focus while the window was in the background, so no pointer or tap explains it. */
  const check = (away = false) => {
    const active = doc.activeElement
    if (!(active instanceof HTMLIFrameElement)) return
    const target = field
    if (!target || !isEditable(target)) return
    const now = env.now()
    const recent = recentHandBacks(active, now)
    const onNotice = recent.length > 0
    if (!onNotice && now - tabAt < TAB_WINDOW_MS) return
    if (!away && !onNotice) {
      const sinceInput = now - hostInputAt
      const touch = lastPointer === 'touch' || env.touchOnly()
      // Every exemption below needs the browser to report a gesture just now: a tap or click inside the frame counts for this
      // page too (about 5 s), a script on a timer does not.
      if (touch) {
        if (sinceInput >= GUARD_WINDOW_MS && env.userActive()) return
      } else if (hovered === active) {
        if (hoverAt >= hostInputAt && env.userActive()) return
        if (sinceInput >= RESTING_IDLE_MS && env.userActive()) return
      }
    }
    target.focus({ preventScroll: true })
    recent.push(now)
    handBacks.set(active, recent)
    if (recent.length >= REPEAT_COUNT) {
      handBacks.delete(active)
      watchers.get(active)?.()
    }
  }

  for (const t of HOST_INPUT) win.addEventListener(t, onInput, { capture: true, passive: true })
  doc.addEventListener('focusin', onFocusIn, true)
  doc.addEventListener('focusout', onFocusOut, true)
  doc.addEventListener('pointerover', onOver, true)
  doc.addEventListener('pointermove', onMove, true)
  doc.documentElement.addEventListener('mouseleave', onLeaveWindow)
  win.addEventListener('blur', onWindowBlur)
  win.addEventListener('focus', onWindowFocus)
  return {
    check: () => check(),
    /** `onHold` runs when this frame keeps taking focus back; the caller hides it. Returns the undo. */
    watch(frame: Element, onHold: () => void) {
      watchers.set(frame, onHold)
      return () => {
        if (watchers.get(frame) === onHold) watchers.delete(frame)
      }
    },
    dispose() {
      for (const t of HOST_INPUT) win.removeEventListener(t, onInput, { capture: true })
      doc.removeEventListener('focusin', onFocusIn, true)
      doc.removeEventListener('focusout', onFocusOut, true)
      doc.removeEventListener('pointerover', onOver, true)
      doc.removeEventListener('pointermove', onMove, true)
      doc.documentElement.removeEventListener('mouseleave', onLeaveWindow)
      win.removeEventListener('blur', onWindowBlur)
      win.removeEventListener('focus', onWindowFocus)
    },
  }
}

// One guard for the whole page, however many frames are mounted.
let installed = 0
let current: ReturnType<typeof createFrameFocusGuard> | null = null

/**
 * Called by every mounted SandboxedFrame with its iframe; `onHold` runs when the page keeps taking focus from a field.
 * Returns the undo. The first call installs the guard, the last undo removes it.
 */
export function installFrameFocusGuard(frame?: Element | null, onHold?: () => void): () => void {
  if (typeof window === 'undefined' || !frameFocusGuardNeeded()) return () => {}
  if (installed++ === 0) {
    current = createFrameFocusGuard({
      win: window,
      doc: document,
      now: () => performance.now(),
      touchOnly: () => !(window.matchMedia?.('(any-hover: hover)').matches ?? true),
      // A browser without the API cannot tell, so it keeps the older behaviour (the resting pointer is believed).
      userActive: () => navigator.userActivation?.isActive ?? true,
    })
  }
  const unwatch = frame && onHold ? current?.watch(frame, onHold) : undefined
  let done = false
  return () => {
    if (done) return
    done = true
    unwatch?.()
    if (--installed === 0) {
      current?.dispose()
      current = null
    }
  }
}
