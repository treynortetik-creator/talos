// "Did the owner just act INSIDE this view?" (M2.3 user_gesture). `navigator.userActivation.isActive` is page-wide: a tap
// on Talos chrome or the composer makes it true for 5 s, and a view that fires on a timer would inherit it. So activation
// counts as the view's only when all of these hold, and then it pays for ONE request:
//   - the page's own input (pointer, touch, mouse, key) has not happened since the focus moved into the frame. A tap in a
//     cross-origin frame never reaches our listeners, so any capture-phase hit here was the host's, not the view's;
//   - the window lost focus after that, with our frame already the active element at that very moment (judged
//     synchronously in the blur, never on a timer), and the frame still holds focus now;
//   - the browser says activation is live;
//   - no earlier request has used this focus. Using it hands focus back to the card, so the next tap in the view is a new
//     focus edge and a new gesture; a second request from the same tap is not gestured.
export type GestureEnv = {
  win: Window
  doc: Document
  frame: () => Element | null
  /** Monotonic ms. */
  now: () => number
  /** Where focus goes after a gesture is spent. */
  refocus: () => void
  /** `navigator.userActivation?.isActive`. */
  active: () => boolean
}

const HOST_INPUT = ['pointerdown', 'mousedown', 'touchstart', 'keydown', 'click'] as const

export function createGestureTracker(env: GestureEnv) {
  let hostInputAt = Number.NEGATIVE_INFINITY
  let blurAt = Number.NEGATIVE_INFINITY
  let used = false
  const onHost = () => {
    hostInputAt = env.now()
  }
  const onBlur = () => {
    // The page lost focus. It counts as the owner acting in the view only if our frame holds focus right now (both
    // WebKit and Chromium already show it as activeElement during the blur). Judged synchronously, so a view that
    // focuses itself later, with no new blur, cannot claim a tap that went to someone else.
    if (env.doc.activeElement !== null && env.doc.activeElement === env.frame()) {
      blurAt = env.now()
      used = false
    }
  }
  for (const t of HOST_INPUT) env.win.addEventListener(t, onHost, { capture: true, passive: true })
  env.win.addEventListener('blur', onBlur)
  return {
    /** True at most once per focus edge. */
    claim(): boolean {
      const ok =
        !used &&
        env.active() &&
        env.doc.activeElement !== null &&
        env.doc.activeElement === env.frame() &&
        blurAt > hostInputAt
      if (!ok) return false
      used = true
      env.refocus()
      return true
    },
    dispose() {
      for (const t of HOST_INPUT) env.win.removeEventListener(t, onHost, { capture: true })
      env.win.removeEventListener('blur', onBlur)
    },
  }
}
