// @vitest-environment jsdom
// The real wiring of installFrameFocusGuard (not the injected environment the other spec uses): what it reads from
// navigator.userActivation, and that the last undo removes the guard.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../src/ui/engine.ts', () => ({ frameFocusGuardNeeded: () => true }))

import { installFrameFocusGuard } from '../../src/ui/frameFocusGuard.ts'

let field: HTMLTextAreaElement
let frame: HTMLIFrameElement
let undo: () => void

const setActivation = (v: unknown) =>
  Object.defineProperty(navigator, 'userActivation', { value: v, configurable: true })
const over = (el: Element, x: number, y: number) =>
  el.dispatchEvent(
    Object.assign(new Event('pointerover', { bubbles: true }), { pointerType: 'mouse', clientX: x, clientY: y }),
  )
const active = (el: Element) => Object.defineProperty(document, 'activeElement', { value: el, configurable: true })

beforeEach(() => {
  vi.useFakeTimers()
  document.body.innerHTML = '<textarea id="f"></textarea><iframe id="a"></iframe>'
  field = document.getElementById('f') as HTMLTextAreaElement
  frame = document.getElementById('a') as HTMLIFrameElement
  vi.spyOn(document, 'hasFocus').mockImplementation(() => true)
  active(field)
  vi.spyOn(field, 'focus')
  undo = installFrameFocusGuard(frame, () => {})
})
afterEach(() => {
  undo()
  vi.useRealTimers()
  vi.restoreAllMocks()
  delete (document as unknown as Record<string, unknown>).activeElement
  delete (navigator as unknown as Record<string, unknown>).userActivation
})

/** The pointer arrives over the frame a moment after the owner's last input, then the frame takes focus. */
function arriveAndSteal() {
  over(field, 400, 400)
  over(frame, 520, 500)
  vi.advanceTimersByTime(20)
  active(frame)
  window.dispatchEvent(new Event('blur'))
  vi.runOnlyPendingTimers()
}

describe('installFrameFocusGuard wiring', () => {
  it('a browser without navigator.userActivation keeps the older behaviour: an arriving pointer is believed', () => {
    setActivation(undefined)
    arriveAndSteal()
    expect(field.focus).not.toHaveBeenCalled()
  })

  it('a browser that reports no recent gesture hands the steal back', () => {
    setActivation({ isActive: false })
    arriveAndSteal()
    expect(field.focus).toHaveBeenCalledTimes(1)
  })

  it('a browser that reports a recent gesture lets the click through', () => {
    setActivation({ isActive: true })
    arriveAndSteal()
    expect(field.focus).not.toHaveBeenCalled()
  })

  it('after the last undo the guard is gone', () => {
    setActivation({ isActive: false })
    undo()
    arriveAndSteal()
    expect(field.focus).not.toHaveBeenCalled()
    undo = installFrameFocusGuard(frame, () => {}) // so afterEach has something to undo
  })
})
