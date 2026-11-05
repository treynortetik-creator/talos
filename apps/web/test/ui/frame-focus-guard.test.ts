// @vitest-environment jsdom
// The decision rules of the focus guard, with a fake clock and the focus move simulated (jsdom has no cross-frame focus;
// the real thing is test/relay/frame-guards.spec.ts in Chromium). Each case drives a steal and reads where focus ends up.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  createFrameFocusGuard,
  GUARD_WINDOW_MS,
  REPEAT_COUNT,
  REPEAT_WINDOW_MS,
  RESTING_IDLE_MS,
} from '../../src/ui/frameFocusGuard.ts'

let t = 0
let touchOnly = false
let userActive = true
let guard: ReturnType<typeof createFrameFocusGuard>
let field: HTMLTextAreaElement
let frame: HTMLIFrameElement

/** The frame takes focus: the page's activeElement becomes the iframe, then the window blurs. */
function steal(into: HTMLIFrameElement = frame) {
  Object.defineProperty(document, 'activeElement', { value: into, configurable: true })
  window.dispatchEvent(new Event('blur'))
  vi.runOnlyPendingTimers()
}
const focusField = () => {
  Object.defineProperty(document, 'activeElement', { value: field, configurable: true })
  field.dispatchEvent(new FocusEvent('focusin', { bubbles: true }))
}
/** jsdom has no PointerEvent: a plain event with the fields the guard reads. Each call is a real move unless a spot is given. */
let nextX = 10
const over = (el: Element, x = nextX++ * 10, y = 50) =>
  el.dispatchEvent(
    Object.assign(new Event('pointerover', { bubbles: true }), { pointerType: 'mouse', clientX: x, clientY: y }),
  )
const move = (el: Element, x: number, y: number) =>
  el.dispatchEvent(
    Object.assign(new Event('pointermove', { bubbles: true }), { pointerType: 'mouse', clientX: x, clientY: y }),
  )
const el_touch = (x: number, y: number) =>
  document.body.dispatchEvent(
    Object.assign(new Event('pointermove', { bubbles: true }), { pointerType: 'touch', clientX: x, clientY: y }),
  )
const key = (k: string) => window.dispatchEvent(new KeyboardEvent('keydown', { key: k }))
/** Focus leaves the box for nothing (keyboard dismissed): the page's activeElement is the body, then timers run. */
const blurToBody = () => {
  Object.defineProperty(document, 'activeElement', { value: document.body, configurable: true })
  field.dispatchEvent(new FocusEvent('focusout', { bubbles: true }))
  vi.runOnlyPendingTimers()
}
let hasFocus = true

beforeEach(() => {
  vi.useFakeTimers()
  t = 10_000
  touchOnly = false
  userActive = true
  nextX = 10
  document.body.innerHTML = '<textarea id="f"></textarea><iframe id="a"></iframe><iframe id="b"></iframe>'
  field = document.getElementById('f') as HTMLTextAreaElement
  frame = document.getElementById('a') as HTMLIFrameElement
  hasFocus = true
  vi.spyOn(document, 'hasFocus').mockImplementation(() => hasFocus)
  guard = createFrameFocusGuard({
    win: window,
    doc: document,
    now: () => t,
    touchOnly: () => touchOnly,
    userActive: () => userActive,
  })
  vi.spyOn(field, 'focus')
  focusField()
})
afterEach(() => {
  guard.dispose()
  vi.useRealTimers()
  vi.restoreAllMocks()
  delete (document as unknown as Record<string, unknown>).activeElement
})

describe('frame focus guard', () => {
  it('hands focus back when a frame takes it from the composer right after the owner typed (mouse)', () => {
    key('s')
    steal()
    expect(field.focus).toHaveBeenCalledTimes(1)
  })

  it('does not fight a click into the frame: the pointer is over it', () => {
    over(field, 300, 300)
    over(frame, 400, 300) // the mouse entering the frame, seen by the host
    steal()
    expect(field.focus).not.toHaveBeenCalled()
  })

  it('fights again once the pointer has left the frame for the host', () => {
    over(frame)
    over(field)
    steal()
    expect(field.focus).toHaveBeenCalledTimes(1)
  })

  it('does not fight Tab into the frame', () => {
    key('Tab')
    steal()
    expect(field.focus).not.toHaveBeenCalled()
  })

  it('touch: fights inside the window after host input, lets a later tap in', () => {
    touchOnly = true
    key('a')
    t += GUARD_WINDOW_MS - 1
    steal()
    expect(field.focus).toHaveBeenCalledTimes(1)
    t += 10
    key('b')
    t += REPEAT_WINDOW_MS + GUARD_WINDOW_MS // long enough that the first hand-back no longer counts against the frame
    steal()
    expect(field.focus).toHaveBeenCalledTimes(1)
  })

  it('does nothing when the owner was not in an editable field', () => {
    const btn = document.createElement('button')
    document.body.append(btn)
    Object.defineProperty(document, 'activeElement', { value: btn, configurable: true })
    btn.dispatchEvent(new FocusEvent('focusin', { bubbles: true }))
    steal()
    expect(field.focus).not.toHaveBeenCalled()
  })

  it('holds a frame that keeps taking focus: REPEAT_COUNT hand-backs inside the window, then once', () => {
    const held = vi.fn()
    guard.watch(frame, held)
    for (let i = 0; i < REPEAT_COUNT; i++) {
      key('x')
      steal()
      t += 30
    }
    expect(held).toHaveBeenCalledTimes(1)
  })

  it('does not hold a frame whose hand-backs are spread out, or another frame', () => {
    const held = vi.fn()
    guard.watch(frame, held)
    for (let i = 0; i < REPEAT_COUNT; i++) {
      key('x')
      steal()
      t += REPEAT_WINDOW_MS
    }
    expect(held).not.toHaveBeenCalled()
    const other = document.getElementById('b') as HTMLIFrameElement
    for (let i = 0; i < REPEAT_COUNT; i++) {
      key('x')
      steal(other)
      t += 30
    }
    expect(held).not.toHaveBeenCalled()
  })

  it('the undo from watch() stops the hold callback, and dispose() removes the listeners', () => {
    const held = vi.fn()
    guard.watch(frame, held)()
    for (let i = 0; i < REPEAT_COUNT; i++) {
      key('x')
      steal()
      t += 30
    }
    expect(held).not.toHaveBeenCalled()
    guard.dispose()
    field.focus = vi.fn()
    key('x')
    steal()
    expect(field.focus).not.toHaveBeenCalled()
  })

  // Finding: a pointer resting over a frame turned the guard off with no click.
  it('mouse: a pointer that rested over the frame while the owner typed does not exempt a steal', () => {
    over(frame)
    t += 50
    key('h') // typing after the pointer arrived
    t += 30
    steal()
    expect(field.focus).toHaveBeenCalledTimes(1)
  })

  it('mouse: a resting pointer is believed again only after RESTING_IDLE_MS without host input', () => {
    over(frame)
    t += 50
    key('h')
    t += RESTING_IDLE_MS - 1
    steal()
    expect(field.focus).toHaveBeenCalledTimes(1)
    t += REPEAT_WINDOW_MS + RESTING_IDLE_MS // the frame has long since stopped being "on notice"
    steal()
    expect(field.focus).toHaveBeenCalledTimes(1) // a click into a frame the pointer rested over now goes through
  })

  // Finding: a frame that was already handed back kept a free pass on a pause.
  it('touch: a frame handed back a moment ago gets no pass for pausing past the window', () => {
    touchOnly = true
    key('a')
    t += 100
    steal()
    expect(field.focus).toHaveBeenCalledTimes(1)
    t += GUARD_WINDOW_MS + 500 // the owner pauses mid-sentence
    steal()
    expect(field.focus).toHaveBeenCalledTimes(2)
  })

  // Finding: a page stealing once per second was never held.
  it('holds a frame that steals slower than the old two-second window (once a second)', () => {
    const held = vi.fn()
    guard.watch(frame, held)
    for (let i = 0; i < REPEAT_COUNT; i++) {
      key('x')
      steal()
      t += 1000
    }
    expect(held).toHaveBeenCalledTimes(1)
  })

  // Finding: Tab gave any steal a free 600 ms.
  it('Tab to another field does not give the page a free pass', () => {
    const next = document.createElement('input')
    document.body.append(next)
    vi.spyOn(next, 'focus')
    key('Tab')
    Object.defineProperty(document, 'activeElement', { value: next, configurable: true })
    next.dispatchEvent(new FocusEvent('focusin', { bubbles: true }))
    t += 100
    steal()
    expect(next.focus).toHaveBeenCalledTimes(1) // handed back to the field Tab landed in
    expect(field.focus).not.toHaveBeenCalled()
  })

  // Finding: the guard only looked at a top-window blur.
  it('a frame that takes focus (focusin on the iframe) is checked even with no window blur', () => {
    key('s')
    Object.defineProperty(document, 'activeElement', { value: frame, configurable: true })
    frame.dispatchEvent(new FocusEvent('focusin', { bubbles: true }))
    vi.runOnlyPendingTimers()
    expect(field.focus).toHaveBeenCalledTimes(1)
  })

  it('a steal while the window is in the background is handed back, even with the pointer over the frame', () => {
    over(frame)
    hasFocus = false
    Object.defineProperty(document, 'activeElement', { value: frame, configurable: true })
    frame.dispatchEvent(new FocusEvent('focusin', { bubbles: true }))
    vi.runOnlyPendingTimers()
    expect(field.focus).toHaveBeenCalledTimes(1)
  })

  it('on return to the window, a frame that was not focused when it left is handed back; one that was is left alone', () => {
    over(frame)
    hasFocus = false
    window.dispatchEvent(new Event('blur')) // leaving: the composer still has focus
    vi.runOnlyPendingTimers()
    Object.defineProperty(document, 'activeElement', { value: frame, configurable: true }) // stolen while away
    hasFocus = true
    window.dispatchEvent(new Event('focus'))
    vi.runOnlyPendingTimers()
    expect(field.focus).toHaveBeenCalledTimes(1)

    // The owner was in the page when they left: coming back must not drag them out of it.
    Object.defineProperty(document, 'activeElement', { value: frame, configurable: true })
    hasFocus = false
    window.dispatchEvent(new Event('blur'))
    vi.runOnlyPendingTimers()
    hasFocus = true
    window.dispatchEvent(new Event('focus'))
    vi.runOnlyPendingTimers()
    expect(field.focus).toHaveBeenCalledTimes(1)
  })

  // Finding: `field` outlived the box losing focus.
  it('a box that lost focus to nothing (keyboard dismissed) is forgotten: a tap into a page is not pulled back', () => {
    touchOnly = true
    blurToBody()
    window.dispatchEvent(new Event('touchstart'))
    t += 100
    steal()
    expect(field.focus).not.toHaveBeenCalled()
  })

  it('a box that lost focus to the frame is still remembered (that is the steal)', () => {
    touchOnly = true
    key('a')
    Object.defineProperty(document, 'activeElement', { value: frame, configurable: true })
    field.dispatchEvent(new FocusEvent('focusout', { bubbles: true }))
    vi.runOnlyPendingTimers()
    steal()
    expect(field.focus).toHaveBeenCalledTimes(1)
  })

  // Review blocker: the guard installs when the first frame mounts; the owner may already be typing.
  it('knows a box that already had focus when the guard was created (no focusin after install)', () => {
    guard.dispose()
    Object.defineProperty(document, 'activeElement', { value: field, configurable: true })
    guard = createFrameFocusGuard({
      win: window,
      doc: document,
      now: () => t,
      touchOnly: () => touchOnly,
      userActive: () => userActive,
    })
    key('a')
    t += 100
    steal()
    expect(field.focus).toHaveBeenCalledTimes(1)
  })

  it('created with no editable focused: a frame taking focus is left alone', () => {
    guard.dispose()
    Object.defineProperty(document, 'activeElement', { value: document.body, configurable: true })
    guard = createFrameFocusGuard({
      win: window,
      doc: document,
      now: () => t,
      touchOnly: () => touchOnly,
      userActive: () => userActive,
    })
    key('a')
    t += 100
    steal()
    expect(field.focus).not.toHaveBeenCalled()
  })

  // Review: SECURITY.md says a frame handed back in the last 10 s gets no exemptions; Tab was still exempting it.
  it('Tab does not exempt a frame that was handed back a moment ago', () => {
    key('a')
    t += 100
    steal()
    expect(field.focus).toHaveBeenCalledTimes(1)
    focusField()
    key('Tab')
    t += 100
    steal()
    expect(field.focus).toHaveBeenCalledTimes(2)
  })

  // Review blocker (Android): the seeded box left "last host input" at never, so a touch steal looked like a tap after a pause.
  it('touch: a box that had focus at install counts as host input then, so a steal with no key since is handed back', () => {
    guard.dispose()
    touchOnly = true
    Object.defineProperty(document, 'activeElement', { value: field, configurable: true })
    guard = createFrameFocusGuard({
      win: window,
      doc: document,
      now: () => t,
      touchOnly: () => touchOnly,
      userActive: () => userActive,
    })
    t += 30 // no key at all between install and the first steal
    steal()
    expect(field.focus).toHaveBeenCalledTimes(1)
    t += REPEAT_WINDOW_MS + GUARD_WINDOW_MS // a tap long after: the owner is not typing, so it goes through
    steal()
    expect(field.focus).toHaveBeenCalledTimes(1)
  })

  // Review blocker (desktop): a view's cover lifting under a parked pointer fires pointerover with no movement.
  it('mouse: a pointerover on the frame at the spot the pointer already was is not an entry', () => {
    over(field, 500, 500)
    key('h')
    t += 50
    over(frame, 500, 500) // cover lifted, pointer did not move
    t += 30
    steal()
    expect(field.focus).toHaveBeenCalledTimes(1)
  })

  it('mouse: a pointer that moved within the page since the last pointerover and then sees the same spot is not an entry', () => {
    over(field, 400, 400)
    move(field, 500, 500) // no pointerover fires inside one element
    key('h')
    t += 50
    over(frame, 500, 500)
    t += 30
    steal()
    expect(field.focus).toHaveBeenCalledTimes(1)
  })

  it('mouse: with no earlier position known, a first pointerover is not counted as a move', () => {
    key('h')
    t += 50
    over(frame, 500, 500)
    t += 30
    steal()
    expect(field.focus).toHaveBeenCalledTimes(1)
  })

  it('mouse: a real move into the frame after the owner typed is an entry, so the click goes through', () => {
    over(field, 400, 400)
    key('h')
    t += 50
    over(frame, 520, 500)
    t += 30
    steal()
    expect(field.focus).not.toHaveBeenCalled()
  })

  it('mouse: touch pointers do not move the remembered position', () => {
    over(field, 400, 400)
    el_touch(500, 500)
    key('h')
    t += 50
    over(frame, 500, 500)
    t += 30
    steal()
    expect(field.focus).not.toHaveBeenCalled()
  })

  // Review (medium): the stamp for "the pointer arrived" was also taken when the pointer LEFT a frame for the page.
  it('mouse: leaving a frame for the page after the last key does not make a later no-move pointerover an entry', () => {
    over(frame, 400, 400)
    key('h')
    t += 50
    over(field, 500, 500) // the pointer leaves the frame for the page, after the last key
    t += 50
    over(frame, 500, 500) // a view starts under it: same spot, no movement
    t += 30
    steal()
    expect(field.focus).toHaveBeenCalledTimes(1)
  })

  it('mouse: a real move into a frame still counts after the pointer has been over the page', () => {
    over(frame, 400, 400)
    key('h')
    t += 50
    over(field, 500, 500)
    t += 50
    over(frame, 520, 500)
    t += 30
    steal()
    expect(field.focus).not.toHaveBeenCalled()
  })

  // Review (medium): a pointer at rest over a frame made a script's focus() pass after 5 s with no host input.
  it('mouse: a resting pointer is believed after RESTING_IDLE_MS only when the browser reports a recent gesture', () => {
    over(frame)
    t += 50
    key('h')
    t += RESTING_IDLE_MS + 100
    userActive = false // a timer in the page, no click
    steal()
    expect(field.focus).toHaveBeenCalledTimes(1)
    t += REPEAT_WINDOW_MS + RESTING_IDLE_MS
    userActive = true // a click inside the frame
    steal()
    expect(field.focus).toHaveBeenCalledTimes(1)
  })

  // Review (low): dictation and IME text arrive as input and composition events with no keydown.
  it.each(['beforeinput', 'input', 'compositionstart', 'compositionupdate', 'compositionend'])(
    'touch: a %s event counts as the owner typing',
    (type) => {
      touchOnly = true
      window.dispatchEvent(new Event(type))
      t += 100
      steal()
      expect(field.focus).toHaveBeenCalledTimes(1)
    },
  )

  // Confirm review (medium 1): a page timer called focus() on a touch screen after a pause, or under an arriving mouse.
  it('touch: a steal after a pause is handed back when the browser saw no gesture (a page timer)', () => {
    touchOnly = true
    key('a')
    t += GUARD_WINDOW_MS + 4500
    userActive = false
    steal()
    expect(field.focus).toHaveBeenCalledTimes(1)
    t += REPEAT_WINDOW_MS
    userActive = true // a real tap
    steal()
    expect(field.focus).toHaveBeenCalledTimes(1)
  })

  it('mouse: a pointer arriving over a frame does not exempt a steal when the browser saw no gesture', () => {
    over(field, 400, 400)
    key('h')
    t += 6000
    over(frame, 520, 500) // a mouse crossing the view long after the last key
    userActive = false
    steal()
    expect(field.focus).toHaveBeenCalledTimes(1)
    t += REPEAT_WINDOW_MS
    userActive = true // a click
    steal()
    expect(field.focus).toHaveBeenCalledTimes(1)
  })

  // Confirm review (medium 2): typing itself gives activation, so activation alone cannot close this one.
  it('mouse: a view that starts under a pointer that moved around inside another frame is not an arrival', () => {
    const view = document.getElementById('b') as HTMLIFrameElement
    over(field, 50, 50)
    over(frame, 100, 100) // enters frame A: a real arrival
    t += 50
    // the pointer moves inside A to (300, 120): the host sees nothing
    key('h') // owner types; activation is live
    t += 50
    over(view, 300, 120) // view V grows under the stopped pointer: reported position differs from the one the host holds
    t += 30
    steal(view)
    expect(field.focus).toHaveBeenCalledTimes(1)
  })

  // Confirm review (low 4): the box was focused by script after the guard was created.
  it('touch: a box focused after install counts as input at that moment, so a steal right after is handed back', () => {
    guard.dispose()
    touchOnly = true
    Object.defineProperty(document, 'activeElement', { value: document.body, configurable: true })
    guard = createFrameFocusGuard({
      win: window,
      doc: document,
      now: () => t,
      touchOnly: () => touchOnly,
      userActive: () => userActive,
    })
    t += 60_000
    focusField() // focus arrives with no key, tap or pointer
    t += 10
    steal()
    expect(field.focus).toHaveBeenCalledTimes(1)
  })

  it('mouse: a box focused after install is later than an earlier pointer arrival, so that arrival no longer exempts', () => {
    guard.dispose()
    Object.defineProperty(document, 'activeElement', { value: document.body, configurable: true })
    guard = createFrameFocusGuard({
      win: window,
      doc: document,
      now: () => t,
      touchOnly: () => touchOnly,
      userActive: () => userActive,
    })
    over(field, 400, 400)
    over(frame, 520, 500)
    t += 100
    focusField()
    t += 10
    steal()
    expect(field.focus).toHaveBeenCalledTimes(1)
  })

  // Window or tab return: the browser announces the box that already had focus. That is not input.
  it('touch: the same box announced again on window return is not input, so a real tap into a frame after a pause passes', () => {
    touchOnly = true
    t += 20_000 // the owner stopped long ago
    focusField() // same box, focusin again
    t += 10
    steal()
    expect(field.focus).not.toHaveBeenCalled()
  })

  it('mouse: a click on a frame under a parked pointer, just after the same box was announced again, passes', () => {
    over(field, 400, 400)
    over(frame, 520, 500)
    t += RESTING_IDLE_MS + 100
    focusField() // same box, focusin again
    t += 10
    steal()
    expect(field.focus).not.toHaveBeenCalled()
  })
})
