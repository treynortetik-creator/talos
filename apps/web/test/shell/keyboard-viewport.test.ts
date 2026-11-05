// The on-screen keyboard rules (src/lib/keyboardViewport.ts): native resize, layout-derived flag, lift, reveal.
import { describe, expect, it, vi } from 'vitest'
import {
  editingInside,
  installKeyboardLayout,
  keyboardOpenFromLayout,
  liftHeight,
  MIN_KEYBOARD_PX,
  makeBaselines,
  revealFocused,
} from '../../src/lib/keyboardViewport.ts'

describe('keyboardOpenFromLayout', () => {
  it('is open once the root lost more than a keyboard of height', () => {
    expect(keyboardOpenFromLayout(852, 852)).toBe(false)
    expect(keyboardOpenFromLayout(852, 852 - MIN_KEYBOARD_PX)).toBe(false) // browser chrome
    expect(keyboardOpenFromLayout(852, 852 - MIN_KEYBOARD_PX - 1)).toBe(true)
    expect(keyboardOpenFromLayout(852, 516)).toBe(true)
  })
  it('is closed for NaN and for a root taller than the baseline', () => {
    expect(keyboardOpenFromLayout(852, Number.NaN)).toBe(false)
    expect(keyboardOpenFromLayout(852, 900)).toBe(false)
  })
})

describe('baselines', () => {
  it('keeps the tallest height seen per width', () => {
    const b = makeBaselines()
    expect(b.read(393, 852)).toBe(852)
    expect(b.read(393, 516)).toBe(852) // keyboard up: the baseline does not follow it down
    expect(b.read(393, 860)).toBe(860) // grew (toolbar gone)
  })
  it('rotate and back: each width has its own baseline, so the keyboard stays open after rotating back', () => {
    const b = makeBaselines()
    b.read(393, 852)
    b.read(852, 393) // landscape, no keyboard
    expect(keyboardOpenFromLayout(b.read(852, 193), 193)).toBe(true) // landscape keyboard
    expect(keyboardOpenFromLayout(b.read(393, 516), 516)).toBe(true) // portrait again, keyboard up
    expect(keyboardOpenFromLayout(b.read(393, 852), 852)).toBe(false)
  })
  it('a baseline taken from the current (short) height would never see the keyboard: first sight at a width is its height', () => {
    expect(keyboardOpenFromLayout(makeBaselines().read(393, 516), 516)).toBe(false)
  })
})

describe('liftHeight', () => {
  it('is the baseline minus the keyboard, never negative', () => {
    expect(liftHeight(852, 336)).toBe(516)
    expect(liftHeight(300, 336)).toBe(0)
  })
})

// A root with a settable clientHeight and a window that records listeners; rAF runs on demand.
function rig(height = 852, width = 393, touch = true) {
  const root = document.createElement('html')
  let h = height
  Object.defineProperty(root, 'clientHeight', { get: () => h })
  const target = new EventTarget() as EventTarget & { innerWidth: number }
  target.innerWidth = width
  const queue: Array<() => void> = []
  const raf = (cb: () => void) => queue.push(cb)
  const frames = (n = 2) => {
    for (let i = 0; i < n; i++) for (const cb of queue.splice(0)) cb()
  }
  const off = installKeyboardLayout(root, target as unknown as Window, document, raf, () => touch)
  const show = (px: number) => {
    const e = new Event('keyboardWillShow') as Event & { keyboardHeight: number }
    e.keyboardHeight = px
    target.dispatchEvent(e)
  }
  const resizeTo = (nh: number, nw = target.innerWidth) => {
    h = nh
    target.innerWidth = nw
    target.dispatchEvent(new Event('resize'))
  }
  return { root, target, show, hide: () => target.dispatchEvent(new Event('keyboardWillHide')), resizeTo, frames, off }
}

describe('installKeyboardLayout', () => {
  it('a mouse window shrunk by a keyboard-sized amount is not a keyboard', () => {
    const r = rig(852, 393, false)
    r.resizeTo(500)
    r.frames()
    expect(r.root.dataset.kb).toBeUndefined()
    r.off()
  })

  it('lifts the root to the final height on keyboardWillShow, before any resize', () => {
    const r = rig()
    r.show(336)
    expect(r.root.classList.contains('kb-lift')).toBe(true)
    expect(r.root.style.getPropertyValue('--kb-lift-h')).toBe('516px')
    expect(r.root.dataset.kb).toBeUndefined()
  })
  it('a repeat keyboardWillShow does not lift twice', () => {
    const r = rig()
    r.show(336)
    r.show(336)
    expect(r.root.style.getPropertyValue('--kb-lift-h')).toBe('516px')
    r.resizeTo(516) // the native resize has landed; a late repeat must still read the baseline, not 516 - 336
    r.show(336)
    expect(r.root.style.getPropertyValue('--kb-lift-h')).toBe('516px')
  })
  it('sets data-kb two frames after the resize and clears the lift then', () => {
    const r = rig()
    r.show(336)
    r.resizeTo(516)
    r.frames(1)
    expect(r.root.dataset.kb).toBeUndefined()
    expect(r.root.classList.contains('kb-lift')).toBe(true)
    r.frames(1)
    expect(r.root.dataset.kb).toBe('open')
    expect(r.root.classList.contains('kb-lift')).toBe(false)
    expect(r.root.style.getPropertyValue('--kb-lift-h')).toBe('')
  })
  it('no flag when clientHeight holds (Home Screen app, old shell): the lift is cleared by hide and nothing sticks', () => {
    const r = rig()
    r.show(336)
    r.resizeTo(852) // a resize event with no change in height
    r.frames()
    expect(r.root.dataset.kb).toBeUndefined()
    r.hide()
    expect(r.root.classList.contains('kb-lift')).toBe(false)
  })
  it('keyboardWillHide drops the lift; the flag follows the layout when the resize arrives', () => {
    const r = rig()
    r.show(336)
    r.resizeTo(516)
    r.frames()
    expect(r.root.dataset.kb).toBe('open')
    r.hide()
    expect(r.root.dataset.kb).toBe('open') // events are not trusted: layout decides
    r.resizeTo(852)
    r.frames()
    expect(r.root.dataset.kb).toBeUndefined()
  })
  it('events out of order (didHide before show, bursts) leave the flag following layout', () => {
    const r = rig()
    r.hide()
    r.show(336)
    r.hide()
    r.show(336)
    r.resizeTo(516)
    r.frames()
    expect(r.root.dataset.kb).toBe('open')
  })
  it('rotate with the keyboard up and back stays open', () => {
    const r = rig(852, 393)
    r.resizeTo(393, 852) // landscape, keyboard down
    r.frames()
    r.resizeTo(193, 852) // keyboard up in landscape
    r.frames()
    expect(r.root.dataset.kb).toBe('open')
    r.resizeTo(852, 393) // back to portrait, keyboard closed
    r.frames()
    expect(r.root.dataset.kb).toBeUndefined()
    r.resizeTo(516, 393) // keyboard up in portrait
    r.frames()
    expect(r.root.dataset.kb).toBe('open')
  })
  it('a keyboardWillShow while the flag is on does not lift (an emoji keyboard swap)', () => {
    const r = rig()
    r.resizeTo(516)
    r.frames()
    r.show(400)
    expect(r.root.classList.contains('kb-lift')).toBe(false)
  })
  it('ignores a keyboardWillShow with no height', () => {
    const r = rig()
    r.show(0)
    expect(r.root.classList.contains('kb-lift')).toBe(false)
  })
  it('cleanup removes listeners, the flag and the lift', () => {
    const r = rig()
    r.show(336)
    r.resizeTo(516)
    r.frames()
    r.off()
    expect(r.root.dataset.kb).toBeUndefined()
    r.show(336)
    expect(r.root.classList.contains('kb-lift')).toBe(false)
  })
})

describe('revealFocused', () => {
  // A scroller (500 px tall at y 0..500, 900 px of content) holding a field at the given rect.
  const rig = (tag: string, top: number, height: number, attrs: Record<string, string> = {}, margin = '0px') => {
    const wrap = document.createElement('div')
    wrap.style.overflowY = 'auto'
    Object.defineProperty(wrap, 'scrollHeight', { value: 900, configurable: true })
    Object.defineProperty(wrap, 'clientHeight', { value: 500, configurable: true })
    wrap.getBoundingClientRect = () => ({ top: 0, bottom: 500, height: 500 }) as DOMRect
    const el = document.createElement(tag)
    for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v)
    el.style.scrollMarginBottom = margin
    el.getBoundingClientRect = () => ({ top, bottom: top + height, height }) as DOMRect
    wrap.append(el)
    document.body.append(wrap)
    el.focus()
    return { wrap, el }
  }
  it('scrolls the scroller (not the page) so a field below the fold ends above the bottom edge', () => {
    for (const [tag, attrs] of [
      ['input', {}],
      ['textarea', {}],
      ['select', {}],
      ['div', { contenteditable: 'true', tabindex: '0' }],
    ] as const) {
      const { wrap, el } = rig(tag, 600, 44, attrs)
      el.scrollIntoView = vi.fn()
      revealFocused()
      expect(wrap.scrollTop, tag).toBe(144) // 644 - 500
      expect(el.scrollIntoView, tag).not.toHaveBeenCalled()
      wrap.remove()
    }
  })
  it('keeps the scroll-margin clear of whatever sits on the scroller edge (a sticky Save bar)', () => {
    const { wrap } = rig('input', 440, 44, {}, '80px')
    revealFocused()
    expect(wrap.scrollTop).toBe(64) // 484 + 80 - 500
    wrap.remove()
  })
  it('brings a field above the top edge back down', () => {
    const { wrap } = rig('input', -30, 44)
    wrap.scrollTop = 200
    revealFocused()
    expect(wrap.scrollTop).toBe(170)
    wrap.remove()
  })
  it('leaves a visible field alone', () => {
    const { wrap } = rig('input', 100, 44)
    revealFocused()
    expect(wrap.scrollTop).toBe(0)
    wrap.remove()
  })
  it('leaves a focused button, link or nothing alone', () => {
    const { wrap, el } = rig('button', 600, 44)
    revealFocused()
    expect(wrap.scrollTop).toBe(0)
    expect(el.isConnected).toBe(true)
    wrap.remove()
    expect(() => revealFocused()).not.toThrow()
  })
  it('leaves a field alone when its overflow-auto parent has nothing to scroll (Shell main)', () => {
    const { wrap } = rig('textarea', 600, 44)
    Object.defineProperty(wrap, 'scrollHeight', { value: 500, configurable: true })
    revealFocused()
    expect(wrap.scrollTop).toBe(0)
    wrap.remove()
  })
  it('leaves a field with no scroller above it alone (the composer): scrolling the page flashed the layout', () => {
    const el = document.createElement('textarea')
    document.body.append(el)
    el.scrollIntoView = vi.fn()
    el.focus()
    revealFocused()
    expect(el.scrollIntoView).not.toHaveBeenCalled()
    el.remove()
  })
})

describe('editingInside', () => {
  const scroller = () => {
    const el = document.createElement('div')
    el.tabIndex = 0
    document.body.append(el)
    return el
  }
  it('is true only for an editable field inside the scroller', () => {
    const s = scroller()
    const input = document.createElement('input')
    s.append(input)
    input.focus()
    expect(editingInside(s)).toBe(true)
    s.remove()
  })
  it('is false when the scroller itself has focus (R3-02)', () => {
    const s = scroller()
    s.focus()
    expect(document.activeElement).toBe(s)
    expect(editingInside(s)).toBe(false)
    s.remove()
  })
  it('is false for a button inside, and for a field outside', () => {
    const s = scroller()
    const b = document.createElement('button')
    s.append(b)
    b.focus()
    expect(editingInside(s)).toBe(false)
    const out = document.createElement('input')
    document.body.append(out)
    out.focus()
    expect(editingInside(s)).toBe(false)
    s.remove()
    out.remove()
  })
})
